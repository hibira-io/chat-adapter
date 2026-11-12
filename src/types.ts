import type { Logger } from "chat";

/** A secret, or a function that returns it. Functions are called on every request, so rotating keys work. */
export type Credential = string | (() => string | Promise<string>);

/** Settings for {@link createHibiraAdapter}. */
export interface HibiraAdapterConfig {
  /**
   * A Live Chat workspace API key with the `write` (or `admin`) scope
   * (`lck_...`). Create one in Settings › API & webhooks. Defaults to
   * `HIBIRA_LIVECHAT_API_KEY`.
   */
  apiKey?: Credential;
  /**
   * The signing secret of the webhook endpoint that points at your bot
   * (`lcwh_...`). Defaults to `HIBIRA_LIVECHAT_WEBHOOK_SECRET`.
   */
  webhookSecret?: Credential;
  /**
   * The agent the bot answers as. Replies show this agent's name in the
   * widget and assign unassigned chats to them. Defaults to
   * `HIBIRA_LIVECHAT_AGENT_ID`, else the agent who created the API key.
   */
  agentId?: string;
  /** REST API base URL. Defaults to `HIBIRA_LIVECHAT_API_URL`, else `https://chat.hibira.io/v1`. */
  apiUrl?: string;
  /** The bot's display name inside Chat SDK. Defaults to `"hibira-bot"`. */
  userName?: string;
  /**
   * Also dispatch messages that your human agents write (not internal
   * notes) to your handlers, with `author.isBot: false`. The bot's own
   * replies are never dispatched. Default `false`: only visitors' messages
   * reach your handlers.
   */
  dispatchAgentMessages?: boolean;
  /**
   * Called for every verified webhook event, including the ones the
   * adapter does not turn into messages (`conversation.assigned`,
   * `conversation.closed`, `conversation.rated`...). Use it to stop
   * answering once a person takes over.
   */
  onEvent?: (event: HibiraWebhookEvent) => void | Promise<void>;
  /** How old a webhook signature may be, in seconds. Default 300. */
  signatureToleranceSeconds?: number;
  /** A `fetch` to use instead of the global one (tests, proxies). */
  fetch?: typeof fetch;
  logger?: Logger;
}

/** The decoded parts of a `hibira:<conversation id>` thread ID. */
export interface HibiraThreadId {
  conversationId: string;
}

/** A Live Chat visitor, as the REST API and webhooks show them. */
export interface HibiraVisitor {
  name?: string;
  email?: string;
  page?: string;
  referrer?: string;
  user_agent?: string;
  locale?: string;
  topic?: string;
  /** Your own user ID, set by verified visitors. */
  user_id?: string;
  verified?: boolean;
}

/** A Live Chat conversation. */
export interface HibiraConversation {
  id: string;
  workspace_id: string;
  visitor_id: string;
  visitor: HibiraVisitor;
  status: "open" | "closed";
  assignee_id?: string;
  team_id?: string;
  /** Messaging channel the visitor wrote from (`line`, `email`...); empty for the website widget. */
  channel?: string;
  last_message_at: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  [key: string]: unknown;
}

/** A Live Chat message. */
export interface HibiraMessage {
  id: string;
  seq: number;
  from: "visitor" | "agent" | "ai" | "system";
  sender_id: string;
  name?: string;
  text: string;
  internal: boolean;
  created_at: string;
}

/** The raw value behind every Chat SDK message from this adapter. */
export interface HibiraRawMessage {
  conversation?: HibiraConversation;
  message: HibiraMessage;
}

/** Event types a Live Chat webhook endpoint can send. */
export type HibiraEventType =
  | "conversation.created"
  | "message.created"
  | "conversation.assigned"
  | "conversation.team_changed"
  | "conversation.closed"
  | "conversation.reopened"
  | "conversation.rated"
  | "webhook.test";

/** One webhook delivery. */
export interface HibiraWebhookEvent {
  id: string;
  type: HibiraEventType | (string & {});
  created_at: string;
  workspace_id: string;
  data: {
    conversation?: HibiraConversation;
    message?: HibiraMessage;
    [key: string]: unknown;
  };
}

/** Changes for {@link HibiraAdapter.updateConversation}. Absent fields stay as they are. */
export interface HibiraConversationUpdate {
  status?: "open" | "closed";
  /** An agent ID, or `""` to unassign. */
  assigneeId?: string;
  /** A team ID, or `""` to take it out of its team. */
  teamId?: string;
}
