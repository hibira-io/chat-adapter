import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat, type Message, type Thread } from "chat";
import { describe, expect, it, vi } from "vitest";
import { createHibiraAdapter, type HibiraAdapterConfig, type HibiraWebhookEvent } from "../src";
import { conversation, event, fakeApi, flush, KEY, message, SECRET, webhookRequest } from "./helpers";

function setup(over: Partial<HibiraAdapterConfig> = {}, routes: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi(routes);
  const adapter = createHibiraAdapter({ apiKey: KEY, webhookSecret: SECRET, fetch: api.fetch, ...over });
  const chat = new Chat({
    userName: "support-bot",
    adapters: { hibira: adapter },
    state: createMemoryState(),
    logger: "silent",
  });
  const seen: { thread: Thread; message: Message }[] = [];
  chat.onDirectMessage(async (thread, msg) => {
    seen.push({ thread, message: msg });
    await thread.post({ markdown: `You said: **${msg.text}**` });
  });
  return { api, adapter, chat, seen };
}

describe("webhooks", () => {
  it("answers a visitor through the REST API", async () => {
    const { api, chat, seen } = setup({ agentId: "ag_bot" });
    const res = await chat.webhooks.hibira(webhookRequest(event()));
    expect(res.status).toBe(200);
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.message.text).toBe("Where is my order?");
    expect(seen[0]?.thread.id).toBe("hibira:c_abc");
    const post = api.calls.find((c) => c.path === "/conversations/c_abc/messages");
    expect(post).toMatchObject({
      method: "POST",
      auth: `Bearer ${KEY}`,
      body: { text: "You said: Where is my order?", agent_id: "ag_bot" },
    });
  });

  it("rejects unsigned and badly signed deliveries", async () => {
    const { chat, seen } = setup();
    expect((await chat.webhooks.hibira(webhookRequest(event(), { signature: null }))).status).toBe(401);
    expect((await chat.webhooks.hibira(webhookRequest(event(), { secret: "wrong" }))).status).toBe(401);
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect((await chat.webhooks.hibira(webhookRequest(event(), { now: old }))).status).toBe(401);
    await flush();
    expect(seen).toHaveLength(0);
  });

  it("does not answer its own replies, notes, agents, the AI or system messages", async () => {
    const { chat, seen } = setup({ agentId: "ag_bot" });
    const skip = [
      message({ id: "m_2", from: "agent", sender_id: "ag_bot" }),
      message({ id: "m_3", internal: true }),
      message({ id: "m_4", from: "agent", sender_id: "ag_human" }),
      message({ id: "m_5", from: "ai", sender_id: "ai" }),
      message({ id: "m_6", from: "system", sender_id: "" }),
    ];
    for (const m of skip) {
      const res = await chat.webhooks.hibira(webhookRequest(event({ id: `evt_${m.id}`, data: { conversation: conversation(), message: m } })));
      expect(res.status).toBe(200);
    }
    await flush();
    expect(seen).toHaveLength(0);
  });

  it("recognises an echo of a reply it just sent without an agentId", async () => {
    const { chat, seen, adapter } = setup();
    await adapter.postMessage("hibira:c_abc", "hello");
    expect(adapter.botUserId).toBe("ag_bot");
    const echo = message({ id: "m_bot_1", from: "agent", sender_id: "ag_bot" });
    await chat.webhooks.hibira(webhookRequest(event({ data: { conversation: conversation(), message: echo } })));
    await flush();
    expect(seen).toHaveLength(0);
  });

  it("dispatches human agents' messages when asked to", async () => {
    const { chat, seen } = setup({ agentId: "ag_bot", dispatchAgentMessages: true });
    const human = message({ id: "m_9", from: "agent", sender_id: "ag_human", name: "Aoi", text: "I'll take it" });
    await chat.webhooks.hibira(webhookRequest(event({ data: { conversation: conversation(), message: human } })));
    await flush();
    expect(seen[0]?.message.author).toMatchObject({ userId: "ag_human", userName: "Aoi", isBot: false, isMe: false });
  });

  it("passes every event to onEvent", async () => {
    const got: HibiraWebhookEvent[] = [];
    const { chat, seen } = setup({ onEvent: (e) => void got.push(e) });
    await chat.webhooks.hibira(webhookRequest(event({ type: "conversation.assigned", data: { conversation: conversation({ assignee_id: "ag_human" }) } })));
    await chat.webhooks.hibira(webhookRequest(event({ id: "evt_t", type: "webhook.test", data: {} })));
    await flush();
    expect(got.map((e) => e.type)).toEqual(["conversation.assigned", "webhook.test"]);
    expect(seen).toHaveLength(0);
  });

  it("answers 400 to a signed body that is not JSON", async () => {
    const { adapter } = setup();
    const { signPayload } = await import("../src/signature");
    const req = new Request("https://bot.example.com/h", {
      method: "POST",
      headers: { "hibira-signature": signPayload("nope", SECRET) },
      body: "nope",
    });
    expect((await adapter.handleWebhook(req)).status).toBe(400);
  });
});

describe("posting", () => {
  it("streams by collecting the answer, showing typing, then sending one message", async () => {
    const { api, adapter } = setup({ agentId: "ag_bot" });
    async function* chunks() {
      yield "Hello ";
      yield { type: "markdown_text" as const, text: "**there**" };
      yield { type: "plan_update" as const, title: "ignored" };
    }
    const sent = await adapter.stream("hibira:c_abc", chunks());
    expect(sent?.id).toBe("m_bot_1");
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /conversations/c_abc/typing",
      "POST /conversations/c_abc/messages",
    ]);
    expect(api.calls[0]?.body).toEqual({ typing: true, agent_id: "ag_bot" });
    expect(api.calls[1]?.body).toMatchObject({ text: "Hello there" });
  });

  it("splits replies longer than Live Chat allows", async () => {
    const { api, adapter } = setup();
    await adapter.postMessage("hibira:c_abc", `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`);
    expect(api.calls.filter((c) => c.path.endsWith("/messages"))).toHaveLength(2);
  });

  it("sends internal notes", async () => {
    const { api, adapter } = setup();
    await adapter.postNote("hibira:c_abc", "VIP customer");
    expect(api.calls[0]?.body).toEqual({ text: "VIP customer", internal: true });
  });

  it("ignores a typing failure", async () => {
    const { adapter } = setup({}, { "POST /conversations/c_abc/typing": () => ({ status: 500, json: { error: "boom" } }) });
    await expect(adapter.startTyping("hibira:c_abc")).resolves.toBeUndefined();
  });

  it("says plainly what it cannot do", async () => {
    const { adapter } = setup();
    await expect(adapter.editMessage()).rejects.toThrow(/cannot be edited/);
    await expect(adapter.deleteMessage()).rejects.toThrow();
    await expect(adapter.addReaction()).rejects.toThrow();
    await expect(adapter.removeReaction()).rejects.toThrow();
  });

  it("maps API errors", async () => {
    const { adapter } = setup({}, {
      "POST /conversations/c_402/messages": () => ({ status: 402, json: { error: "plan required", code: "plan_required" } }),
      "POST /conversations/c_403/messages": () => ({ status: 403, json: { error: "read-only key", code: "read_only_key" } }),
      "POST /conversations/c_429/messages": () => ({ status: 429, json: { error: "slow down", code: "rate_limited" } }),
      "POST /conversations/c_404/messages": () => ({ status: 404, json: { error: "not found", code: "not_found" } }),
    });
    await expect(adapter.postMessage("hibira:c_402", "x")).rejects.toThrow(/Team and Business/);
    await expect(adapter.postMessage("hibira:c_403", "x")).rejects.toMatchObject({ name: "PermissionError" });
    await expect(adapter.postMessage("hibira:c_429", "x")).rejects.toMatchObject({ name: "AdapterRateLimitError", retryAfter: 2 });
    await expect(adapter.postMessage("hibira:c_404", "x")).rejects.toMatchObject({ name: "ResourceNotFoundError" });
  });
});

describe("history and actions", () => {
  const view = {
    conversation: conversation(),
    messages: [
      message({ id: "m_1", text: "hi" }),
      message({ id: "m_n", internal: true, from: "agent", sender_id: "ag_human", text: "note" }),
      message({ id: "m_2", from: "agent", sender_id: "ag_bot", text: "hello" }),
      message({ id: "m_3", text: "order 42" }),
    ],
  };
  const routes = {
    "GET /conversations/c_abc": () => ({ json: view }),
    "POST /conversations/c_abc": (b: unknown) => ({ json: { ...conversation(), ...(b as object) } }),
  };

  it("fetches messages oldest first, without notes", async () => {
    const { adapter } = setup({ agentId: "ag_bot" }, routes);
    const r = await adapter.fetchMessages("hibira:c_abc");
    expect(r.messages.map((m) => m.id)).toEqual(["m_1", "m_2", "m_3"]);
    expect(r.messages[1]?.author.isMe).toBe(true);
    const last = await adapter.fetchMessages("hibira:c_abc", { limit: 2 });
    expect(last.messages.map((m) => m.id)).toEqual(["m_2", "m_3"]);
    expect((await adapter.fetchMessage("hibira:c_abc", "m_3"))?.text).toBe("order 42");
    expect(await adapter.fetchMessage("hibira:c_abc", "nope")).toBeNull();
  });

  it("fetches thread info", async () => {
    const { adapter } = setup({}, routes);
    expect(await adapter.fetchThread("hibira:c_abc")).toMatchObject({
      id: "hibira:c_abc",
      channelId: "hibira:c_abc",
      channelName: "Mika",
      isDM: true,
    });
  });

  it("hands off and closes", async () => {
    const { api, adapter } = setup({ agentId: "ag_bot" }, routes);
    await adapter.handoff("hibira:c_abc", { teamId: "tm_billing" });
    await adapter.handoff("hibira:c_abc", { agentId: "ag_human" });
    await adapter.closeConversation("hibira:c_abc");
    expect(api.calls.map((c) => c.body)).toEqual([
      { assignee_id: "", team_id: "tm_billing", agent_id: "ag_bot" },
      { assignee_id: "ag_human", agent_id: "ag_bot" },
      { status: "closed", agent_id: "ag_bot" },
    ]);
  });
});

describe("thread.post through Chat", () => {
  it("renders cards as text", async () => {
    const { api, adapter, chat } = setup();
    await chat.initialize?.();
    const { Card, CardText } = await import("chat");
    await adapter.postMessage("hibira:c_abc", { card: Card({ title: "Order 42", children: [CardText("Shipped today")] }) });
    expect((api.calls[0]?.body as { text: string }).text).toBe("Order 42\nShipped today");
    vi.restoreAllMocks();
  });
});
