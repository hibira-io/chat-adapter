import { signPayload } from "../src/signature";
import type { HibiraConversation, HibiraMessage, HibiraWebhookEvent } from "../src/types";

export const SECRET = "lcwh_test_secret";
export const KEY = "lck_ws_1.secret";

export interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

/** A fake Live Chat REST API. */
export function fakeApi(routes: Record<string, (body: unknown) => { status?: number; json?: unknown }> = {}) {
  const calls: Call[] = [];
  let seq = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", path, auth: headers.get("authorization"), body });
    const route = routes[`${init?.method ?? "GET"} ${path}`];
    if (route) {
      const r = route(body);
      return new Response(r.json === undefined ? "" : JSON.stringify(r.json), {
        status: r.status ?? 200,
        headers: { "retry-after": "2" },
      });
    }
    if (init?.method === "POST" && path.endsWith("/messages")) {
      seq++;
      const b = body as { text: string; internal?: boolean };
      return Response.json(
        message({ id: `m_bot_${seq}`, seq, from: "agent", sender_id: "ag_bot", name: "Support bot", text: b.text, internal: !!b.internal }),
        { status: 201 },
      );
    }
    if (init?.method === "POST" && path.endsWith("/typing")) {
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "no such endpoint", code: "not_found" }, { status: 404 });
  };
  return { calls, fetch: fetchImpl };
}

export function conversation(over: Partial<HibiraConversation> = {}): HibiraConversation {
  return {
    id: "c_abc",
    workspace_id: "ws_1",
    visitor_id: "v_1",
    visitor: { name: "Mika", email: "mika@example.com" },
    status: "open",
    last_message_at: "2026-11-12T00:00:00Z",
    created_at: "2026-11-12T00:00:00Z",
    updated_at: "2026-11-12T00:00:00Z",
    ...over,
  };
}

export function message(over: Partial<HibiraMessage> = {}): HibiraMessage {
  return {
    id: "m_1",
    seq: 1,
    from: "visitor",
    sender_id: "v_1",
    name: "Mika",
    text: "Where is my order?",
    internal: false,
    created_at: "2026-11-12T00:00:01Z",
    ...over,
  };
}

export function event(over: Partial<HibiraWebhookEvent> = {}): HibiraWebhookEvent {
  return {
    id: "evt_1",
    type: "message.created",
    created_at: "2026-11-12T00:00:01Z",
    workspace_id: "ws_1",
    data: { conversation: conversation(), message: message() },
    ...over,
  };
}

export function webhookRequest(payload: unknown, opts: { secret?: string; signature?: string | null; now?: number } = {}): Request {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const sig = opts.signature === undefined ? signPayload(body, opts.secret ?? SECRET, opts.now) : opts.signature;
  if (sig !== null) headers["hibira-signature"] = sig;
  return new Request("https://bot.example.com/api/webhooks/hibira", { method: "POST", headers, body });
}

export async function flush(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
