import { afterEach, describe, expect, it } from "vitest";
import { createHibiraAdapter, HibiraAdapter, HibiraFormatConverter, splitMessage, verifySignature } from "../src";
import { signPayload } from "../src/signature";
import { conversation, fakeApi, KEY, message, SECRET } from "./helpers";

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe("createHibiraAdapter", () => {
  it("takes explicit settings", () => {
    const a = createHibiraAdapter({ apiKey: KEY, webhookSecret: SECRET, agentId: "ag_bot" });
    expect(a).toBeInstanceOf(HibiraAdapter);
    expect(a.name).toBe("hibira");
    expect(a.userName).toBe("hibira-bot");
    expect(a.botUserId).toBe("ag_bot");
  });

  it("falls back to environment variables", () => {
    process.env.HIBIRA_LIVECHAT_API_KEY = KEY;
    process.env.HIBIRA_LIVECHAT_WEBHOOK_SECRET = SECRET;
    process.env.HIBIRA_LIVECHAT_AGENT_ID = "ag_env";
    expect(createHibiraAdapter().botUserId).toBe("ag_env");
  });

  it("needs an API key and a webhook secret", () => {
    delete process.env.HIBIRA_LIVECHAT_API_KEY;
    delete process.env.HIBIRA_LIVECHAT_WEBHOOK_SECRET;
    expect(() => createHibiraAdapter({ webhookSecret: SECRET })).toThrow(/API key/);
    expect(() => createHibiraAdapter({ apiKey: KEY })).toThrow(/webhook signing secret/);
  });

  it("needs agentId to dispatch agents' messages", () => {
    delete process.env.HIBIRA_LIVECHAT_AGENT_ID;
    expect(() => createHibiraAdapter({ apiKey: KEY, webhookSecret: SECRET, dispatchAgentMessages: true })).toThrow(/agentId/);
    expect(createHibiraAdapter({ apiKey: KEY, webhookSecret: SECRET, dispatchAgentMessages: true, agentId: "ag_bot" }).botUserId).toBe("ag_bot");
  });

  it("accepts credential functions and resolves them on every call", async () => {
    let n = 0;
    const api = fakeApi();
    const a = createHibiraAdapter({ apiKey: () => `${KEY}${++n}`, webhookSecret: SECRET, fetch: api.fetch });
    await a.postMessage("hibira:c_abc", "one");
    await a.postMessage("hibira:c_abc", "two");
    expect(api.calls.map((c) => c.auth)).toEqual([`Bearer ${KEY}1`, `Bearer ${KEY}2`]);
  });
});

describe("thread IDs", () => {
  const a = createHibiraAdapter({ apiKey: KEY, webhookSecret: SECRET });

  it("round-trips", () => {
    const id = a.encodeThreadId({ conversationId: "c_abc" });
    expect(id).toBe("hibira:c_abc");
    expect(a.decodeThreadId(id)).toEqual({ conversationId: "c_abc" });
    expect(a.decodeThreadId(a.encodeThreadId({ conversationId: "a:b/c" }))).toEqual({ conversationId: "a:b/c" });
  });

  it("uses the conversation as the channel, and every thread is a DM", () => {
    expect(a.channelIdFromThreadId("hibira:c_abc")).toBe("hibira:c_abc");
    expect(a.isDM("hibira:c_abc")).toBe(true);
  });

  it("rejects other thread IDs", () => {
    expect(() => a.decodeThreadId("slack:C1:123")).toThrow();
    expect(() => a.decodeThreadId("hibira:")).toThrow();
    expect(() => a.decodeThreadId("hibira:a:b")).toThrow();
    expect(() => a.encodeThreadId({ conversationId: "" })).toThrow();
  });
});

describe("verifySignature", () => {
  const body = '{"id":"evt_1"}';
  const now = 1_800_000_000;

  it("accepts a fresh, correct signature", () => {
    expect(verifySignature(body, signPayload(body, SECRET, now), SECRET, 300, now + 10)).toBe(true);
  });

  it("rejects a wrong secret, a changed body, an old timestamp or a bad header", () => {
    expect(verifySignature(body, signPayload(body, "other", now), SECRET, 300, now)).toBe(false);
    expect(verifySignature(`${body} `, signPayload(body, SECRET, now), SECRET, 300, now)).toBe(false);
    expect(verifySignature(body, signPayload(body, SECRET, now), SECRET, 300, now + 301)).toBe(false);
    expect(verifySignature(body, null, SECRET)).toBe(false);
    expect(verifySignature(body, "t=abc,v1=zz", SECRET)).toBe(false);
    expect(verifySignature(body, `t=${now}`, SECRET, 300, now)).toBe(false);
  });
});

describe("format", () => {
  const f = new HibiraFormatConverter();

  it("flattens Markdown to plain text", () => {
    const out = f.fromMarkdown(
      "# Order\n\nYour **order** shipped. Track it [here](https://t.example/1).\n\n- one\n- two\n\n`code`",
    );
    expect(out).toBe("Order\n\nYour order shipped. Track it here (https://t.example/1).\n\n• one\n• two\n\ncode");
  });

  it("keeps bare links and plain strings as they are", () => {
    expect(f.fromMarkdown("See https://hibira.io")).toBe("See https://hibira.io");
    expect(f.renderPostable("**raw** stays")).toBe("**raw** stays");
  });

  it("reads incoming text", () => {
    expect(f.parseIncoming("Hello *there*").text).toBe("Hello there");
  });
});

describe("splitMessage", () => {
  it("keeps short text whole", () => {
    expect(splitMessage("  hi  ")).toEqual(["hi"]);
    expect(splitMessage("   ")).toEqual([]);
  });

  it("splits long text at paragraph breaks", () => {
    const para = "a".repeat(3000);
    expect(splitMessage(`${para}\n\n${para}`)).toEqual([para, para]);
  });

  it("splits text with no breaks at the limit", () => {
    const parts = splitMessage("x".repeat(9000));
    expect(parts.map((p) => p.length)).toEqual([4000, 4000, 1000]);
  });
});

describe("parseMessage", () => {
  const a = createHibiraAdapter({ apiKey: KEY, webhookSecret: SECRET, agentId: "ag_bot" });

  it("maps a visitor message", () => {
    const m = a.parseMessage({ conversation: conversation(), message: message() });
    expect(m.id).toBe("m_1");
    expect(m.threadId).toBe("hibira:c_abc");
    expect(m.text).toBe("Where is my order?");
    expect(m.author).toMatchObject({ userId: "v_1", userName: "Mika", email: "mika@example.com", isBot: false, isMe: false });
    expect(m.metadata.dateSent.toISOString()).toBe("2026-11-12T00:00:01.000Z");
  });

  it("marks the bot's own replies, AI answers and system notes", () => {
    const own = a.parseMessage({ conversation: conversation(), message: message({ from: "agent", sender_id: "ag_bot" }) });
    expect(own.author.isMe).toBe(true);
    const ai = a.parseMessage({ conversation: conversation(), message: message({ from: "ai", sender_id: "ai" }) });
    expect(ai.author.isBot).toBe(true);
    const sys = a.parseMessage({ conversation: conversation(), message: message({ from: "system", sender_id: "" }) });
    expect(sys.author).toMatchObject({ isBot: true, isSystem: true });
  });
});
