import { extractFiles, ValidationError } from "@chat-adapter/shared";
import {
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  ConsoleLogger,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  type Logger,
  Message,
  NotImplementedError,
  type RawMessage,
  type StreamChunk,
  type StreamOptions,
  type ThreadInfo,
  type WebhookOptions,
} from "chat";
import { ADAPTER_NAME, DEFAULT_API_URL, HibiraApi, resolveCredential } from "./api";
import { HibiraFormatConverter } from "./format";
import { verifySignature } from "./signature";
import type {
  Credential,
  HibiraAdapterConfig,
  HibiraConversation,
  HibiraConversationUpdate,
  HibiraMessage,
  HibiraRawMessage,
  HibiraThreadId,
  HibiraWebhookEvent,
} from "./types";

/** Live Chat's longest message, in characters. Longer replies are sent as several messages. */
export const MAX_MESSAGE_LENGTH = 4000;

const TYPING_REFRESH_MS = 4000;
const SENT_IDS_KEPT = 500;

interface ConversationView {
  conversation: HibiraConversation;
  messages: HibiraMessage[];
}

type ResolvedConfig = Omit<HibiraAdapterConfig, "apiKey" | "webhookSecret"> & {
  apiKey: Credential;
  webhookSecret: Credential;
};

/**
 * Chat SDK adapter for Hibira Live Chat (https://chat.hibira.io). Each
 * Live Chat conversation is one Chat SDK thread, and a direct message:
 * visitors from the website widget, LINE and email all arrive the same way.
 */
export class HibiraAdapter implements Adapter<HibiraThreadId, HibiraRawMessage> {
  readonly name = ADAPTER_NAME;
  readonly userName: string;
  readonly lockScope = "thread" as const;

  private chat: ChatInstance | null = null;
  private logger: Logger;
  private readonly api: HibiraApi;
  private readonly converter = new HibiraFormatConverter();
  private readonly sentIds = new Set<string>();
  private learnedAgentId: string | undefined;

  constructor(private readonly config: ResolvedConfig) {
    this.userName = config.userName ?? "hibira-bot";
    this.logger = config.logger ?? new ConsoleLogger("info", ADAPTER_NAME);
    this.api = new HibiraApi(
      config.apiUrl ?? DEFAULT_API_URL,
      config.apiKey,
      config.fetch ?? globalThis.fetch.bind(globalThis),
    );
  }

  /** The agent the bot writes as: the configured one, else the one the API key replies as. */
  get botUserId(): string | undefined {
    return this.config.agentId ?? this.learnedAgentId;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = this.config.logger ?? chat.getLogger(ADAPTER_NAME);
  }

  // Thread IDs

  encodeThreadId({ conversationId }: HibiraThreadId): string {
    if (!conversationId) {
      throw new ValidationError(ADAPTER_NAME, "conversationId is required");
    }
    return `${ADAPTER_NAME}:${encodeURIComponent(conversationId)}`;
  }

  decodeThreadId(threadId: string): HibiraThreadId {
    const [prefix, id, ...rest] = threadId.split(":");
    if (prefix !== ADAPTER_NAME || !id || rest.length > 0) {
      throw new ValidationError(ADAPTER_NAME, `Invalid Hibira Live Chat thread ID: ${threadId}`);
    }
    return { conversationId: decodeURIComponent(id) };
  }

  /** A conversation is its own channel: one visitor talking to the business. */
  channelIdFromThreadId(threadId: string): string {
    this.decodeThreadId(threadId);
    return threadId;
  }

  isDM(threadId: string): boolean {
    return threadId.startsWith(`${ADAPTER_NAME}:`);
  }

  // Webhooks

  /**
   * Handles a Live Chat webhook delivery. Point a webhook endpoint
   * (Settings › API & webhooks) at the route that calls this, with at least
   * the `message.created` event.
   */
  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const body = await request.text();
    const secret = await resolveCredential(this.config.webhookSecret);
    if (
      !verifySignature(
        body,
        request.headers.get("hibira-signature"),
        secret,
        this.config.signatureToleranceSeconds ?? 300,
      )
    ) {
      this.logger.warn("Live Chat webhook signature is missing or invalid");
      return new Response("Invalid signature", { status: 401 });
    }
    let event: HibiraWebhookEvent;
    try {
      event = JSON.parse(body) as HibiraWebhookEvent;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (this.config.onEvent) {
      try {
        await this.config.onEvent(event);
      } catch (err) {
        this.logger.error("onEvent handler failed", err);
      }
    }
    const { conversation, message } = event.data ?? {};
    if (event.type === "message.created" && conversation && message && this.chat) {
      if (this.shouldDispatch(message)) {
        const raw: HibiraRawMessage = { conversation, message };
        const threadId = this.encodeThreadId({ conversationId: conversation.id });
        this.chat
          .processMessage(this, threadId, async () => this.parseMessage(raw), options)
          .catch((err: unknown) => this.logger.error("processing a Live Chat message failed", err));
      }
    }
    return new Response("OK", { status: 200 });
  }

  private shouldDispatch(m: HibiraMessage): boolean {
    if (m.internal || this.isOwnMessage(m)) {
      return false;
    }
    if (m.from === "visitor") {
      return true;
    }
    return m.from === "agent" && this.config.dispatchAgentMessages === true;
  }

  private isOwnMessage(m: HibiraMessage): boolean {
    if (this.sentIds.has(m.id)) {
      return true;
    }
    return m.from === "agent" && !!this.botUserId && m.sender_id === this.botUserId;
  }

  // Messages

  parseMessage(raw: HibiraRawMessage): Message<HibiraRawMessage> {
    const { conversation, message: m } = raw;
    const isVisitor = m.from === "visitor";
    const visitorName = conversation?.visitor?.name;
    const name = m.name || (isVisitor ? visitorName : undefined) || (isVisitor ? "Visitor" : m.from);
    const threadId = this.encodeThreadId({
      conversationId: conversation?.id ?? "",
    });
    return new Message<HibiraRawMessage>({
      id: m.id,
      threadId,
      ...this.converter.parseIncoming(m.text ?? ""),
      raw,
      author: {
        userId: m.sender_id || (isVisitor ? (conversation?.visitor_id ?? "") : m.from),
        userName: name,
        fullName: name,
        ...(isVisitor && conversation?.visitor?.email ? { email: conversation.visitor.email } : {}),
        isBot: m.from === "ai" || m.from === "system",
        isMe: this.isOwnMessage(m),
        ...(m.from === "system" ? { isSystem: true } : {}),
      },
      metadata: { dateSent: new Date(m.created_at), edited: false },
      attachments: [],
    });
  }

  async postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<HibiraRawMessage>> {
    if (extractFiles(message).length > 0) {
      this.logger.warn("Live Chat replies are text only; files were not sent");
    }
    return this.sendText(threadId, this.converter.renderPostable(message));
  }

  /** Sends a note only your agents see in the inbox (not the visitor). */
  async postNote(threadId: string, text: string): Promise<RawMessage<HibiraRawMessage>> {
    return this.sendText(threadId, text, true);
  }

  private async sendText(threadId: string, text: string, internal = false): Promise<RawMessage<HibiraRawMessage>> {
    const { conversationId } = this.decodeThreadId(threadId);
    const parts = splitMessage(text);
    if (parts.length === 0) {
      throw new ValidationError(ADAPTER_NAME, "cannot send an empty message");
    }
    let last: HibiraMessage | undefined;
    for (const part of parts) {
      last = await this.api.request<HibiraMessage>("POST", `/conversations/${encodeURIComponent(conversationId)}/messages`, {
        text: part,
        ...(internal ? { internal: true } : {}),
        ...(this.config.agentId ? { agent_id: this.config.agentId } : {}),
      });
      this.remember(last);
    }
    const sent = last as HibiraMessage;
    return { id: sent.id, threadId, raw: { message: sent } };
  }

  private remember(m: HibiraMessage): void {
    this.sentIds.add(m.id);
    if (this.sentIds.size > SENT_IDS_KEPT) {
      const oldest = this.sentIds.values().next().value;
      if (oldest !== undefined) this.sentIds.delete(oldest);
    }
    if (!this.config.agentId && m.sender_id) {
      this.learnedAgentId = m.sender_id;
    }
  }

  /**
   * Live Chat shows each message once it is complete, so a streamed answer
   * is collected while the visitor sees the agent typing, then sent as one
   * message.
   */
  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    _options?: StreamOptions,
  ): Promise<RawMessage<HibiraRawMessage> | null> {
    let text = "";
    await this.startTyping(threadId);
    const timer = setInterval(() => {
      this.startTyping(threadId).catch(() => undefined);
    }, TYPING_REFRESH_MS);
    try {
      for await (const chunk of textStream) {
        if (typeof chunk === "string") {
          text += chunk;
        } else if (chunk.type === "markdown_text") {
          text += chunk.text;
        }
      }
    } finally {
      clearInterval(timer);
    }
    if (!text.trim()) {
      await this.endTyping(threadId);
      return null;
    }
    return this.postMessage(threadId, { markdown: text });
  }

  async editMessage(): Promise<RawMessage<HibiraRawMessage>> {
    throw new NotImplementedError("Live Chat messages cannot be edited after they are sent", "editMessage");
  }

  async deleteMessage(): Promise<void> {
    throw new NotImplementedError("Live Chat messages cannot be deleted through the API", "deleteMessage");
  }

  async addReaction(): Promise<void> {
    throw new NotImplementedError("Live Chat has no message reactions", "addReaction");
  }

  async removeReaction(): Promise<void> {
    throw new NotImplementedError("Live Chat has no message reactions", "removeReaction");
  }

  /**
   * Shows the visitor that the bot's agent is typing. Live Chat shows it
   * only once that agent has written in the conversation; failures are
   * logged and ignored.
   */
  async startTyping(threadId: string): Promise<void> {
    await this.typing(threadId, true);
  }

  async endTyping(threadId: string): Promise<void> {
    await this.typing(threadId, false);
  }

  private async typing(threadId: string, typing: boolean): Promise<void> {
    const { conversationId } = this.decodeThreadId(threadId);
    try {
      await this.api.request("POST", `/conversations/${encodeURIComponent(conversationId)}/typing`, {
        typing,
        ...(this.config.agentId ? { agent_id: this.config.agentId } : {}),
      });
    } catch (err) {
      this.logger.debug("Live Chat typing indicator not sent", err);
    }
  }

  // History

  /** Reads the conversation and its latest messages (up to 100). */
  async getConversation(threadId: string): Promise<ConversationView> {
    const { conversationId } = this.decodeThreadId(threadId);
    return this.api.request<ConversationView>("GET", `/conversations/${encodeURIComponent(conversationId)}`);
  }

  async fetchMessages(threadId: string, options?: FetchOptions): Promise<FetchResult<HibiraRawMessage>> {
    const view = await this.getConversation(threadId);
    let list = view.messages.filter((m) => !m.internal);
    const limit = options?.limit;
    if (limit && limit > 0 && list.length > limit) {
      list = options?.direction === "forward" ? list.slice(0, limit) : list.slice(-limit);
    }
    return {
      messages: list.map((m) => this.parseMessage({ conversation: view.conversation, message: m })),
    };
  }

  async fetchMessage(threadId: string, messageId: string): Promise<Message<HibiraRawMessage> | null> {
    const view = await this.getConversation(threadId);
    const m = view.messages.find((x) => x.id === messageId);
    return m ? this.parseMessage({ conversation: view.conversation, message: m }) : null;
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { conversation } = await this.getConversation(threadId);
    return {
      id: threadId,
      channelId: threadId,
      channelName: conversation.visitor?.name || conversation.visitor?.email || "Visitor",
      channelVisibility: "private",
      isDM: true,
      metadata: { ...conversation },
    };
  }

  // Live Chat actions

  /** Assigns, transfers, closes or reopens the conversation, as the bot's agent. */
  async updateConversation(threadId: string, update: HibiraConversationUpdate): Promise<HibiraConversation> {
    const { conversationId } = this.decodeThreadId(threadId);
    return this.api.request<HibiraConversation>("POST", `/conversations/${encodeURIComponent(conversationId)}`, {
      ...(update.status !== undefined ? { status: update.status } : {}),
      ...(update.assigneeId !== undefined ? { assignee_id: update.assigneeId } : {}),
      ...(update.teamId !== undefined ? { team_id: update.teamId } : {}),
      ...(this.config.agentId ? { agent_id: this.config.agentId } : {}),
    });
  }

  /**
   * Hands the conversation to people: assigns it to an agent, or puts it
   * in a team's queue unassigned (with routing on, Live Chat then picks an
   * agent). With neither, it is unassigned so any agent can take it.
   */
  async handoff(threadId: string, to: { agentId?: string; teamId?: string } = {}): Promise<HibiraConversation> {
    return this.updateConversation(threadId, {
      assigneeId: to.agentId ?? "",
      ...(to.teamId !== undefined ? { teamId: to.teamId } : {}),
    });
  }

  async closeConversation(threadId: string): Promise<HibiraConversation> {
    return this.updateConversation(threadId, { status: "closed" });
  }

  renderFormatted(content: FormattedContent): string {
    return this.converter.fromAst(content);
  }
}

/** Splits text into pieces Live Chat accepts, at paragraph, line or word breaks where it can. */
export function splitMessage(text: string, max = MAX_MESSAGE_LENGTH): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while ([...rest].length > max) {
    const chars = [...rest];
    const head = chars.slice(0, max).join("");
    let cut = head.lastIndexOf("\n\n");
    if (cut < max / 2) cut = head.lastIndexOf("\n");
    if (cut < max / 2) cut = head.lastIndexOf(" ");
    if (cut < max / 2) cut = head.length;
    out.push(head.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}
