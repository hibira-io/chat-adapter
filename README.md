# @hibira-io/chat-adapter

The [Hibira Live Chat](https://chat.hibira.io) adapter for [Chat SDK](https://chat-sdk.dev). Run the bot you already have on Slack, Teams or Discord on your website's chat too, and hand a conversation to your team when the bot can't help.

- **One bot for every visitor.** Visitors who write from the website widget, LINE or email all come in as Chat SDK direct messages, and your replies go back the same way.
- **Handoff built in.** `adapter.handoff(thread)` puts the chat in your team's inbox, and `onEvent` tells you when an agent takes it, so the bot can step back.
- **Plain-text replies.** Live Chat shows plain text. The adapter turns Markdown, cards and tables into readable text and splits long answers into several messages.
- **Verified webhooks.** Every delivery is checked against its `Hibira-Signature` before your handlers run.

The REST API and webhooks are on the Live Chat **Team and Business** plans.

```sh
npm install chat @hibira-io/chat-adapter @chat-adapter/state-redis
```

## Set up Live Chat

1. In [chat.hibira.io](https://chat.hibira.io), open **Settings › API & webhooks**.
2. Create an API key with the **Read and write** scope. Copy it into `HIBIRA_LIVECHAT_API_KEY`.
3. Add a webhook endpoint with your bot's URL, for example `https://your-app.com/api/webhooks/hibira`, and pick at least the **message.created** event. Copy its signing secret into `HIBIRA_LIVECHAT_WEBHOOK_SECRET`.
4. Optional: invite an agent for the bot, such as "Support bot", and put its ID (from `GET /v1/agents`) in `HIBIRA_LIVECHAT_AGENT_ID`. Replies then show that name. Without it, the bot replies as the agent who created the key.
5. If the workspace's own AI assistant answers chats (**Settings › AI**), turn it off, so that the visitor doesn't get two answers.

| Variable | Required | What |
| --- | --- | --- |
| `HIBIRA_LIVECHAT_API_KEY` | yes | Workspace API key, `lck_...`, with the write scope |
| `HIBIRA_LIVECHAT_WEBHOOK_SECRET` | yes | The webhook endpoint's signing secret, `lcwh_...` |
| `HIBIRA_LIVECHAT_AGENT_ID` | no | The agent the bot answers as |
| `HIBIRA_LIVECHAT_API_URL` | no | Defaults to `https://chat.hibira.io/v1` |

## Quick start (Next.js)

```ts
// lib/bot.ts
import { Chat } from "chat";
import { createRedisState } from "@chat-adapter/state-redis";
import { createHibiraAdapter } from "@hibira-io/chat-adapter";

export const bot = new Chat({
  userName: "support-bot",
  adapters: { hibira: createHibiraAdapter() },
  state: createRedisState(),
});

bot.onDirectMessage(async (thread, message) => {
  if (/human|agent|person/i.test(message.text)) {
    await thread.post("Let me get someone from the team for you.");
    await bot.getAdapter("hibira").handoff(thread.id);
    return;
  }
  await thread.post({ markdown: `Thanks, ${message.author.userName}! Looking into **${message.text}**…` });
});
```

```ts
// app/api/webhooks/hibira/route.ts
import { after } from "next/server";
import { bot } from "@/lib/bot";

export async function POST(request: Request) {
  return bot.webhooks.hibira(request, { waitUntil: (task) => after(() => task) });
}
```

Each Live Chat conversation is one thread with the ID `hibira:<conversation id>`. It is a direct message, so `onDirectMessage` gets it (or `onNewMention`, if you have no `onDirectMessage` handler).

### Answer with AI

`thread.post()` takes an AI SDK text stream. Live Chat shows a message once it is complete, so the adapter shows the visitor that the bot is typing while the answer is written, then sends it as one message.

```ts
import { streamText } from "ai";

bot.onDirectMessage(async (thread, message) => {
  const result = streamText({
    model: "openai/gpt-5-mini",
    system: "You answer customers of Acme Outdoor in plain text.",
    prompt: message.text,
  });
  await thread.post(result.textStream);
});
```

### Step back when a person takes over

```ts
const hibira = createHibiraAdapter({
  onEvent: async (event) => {
    const c = event.data.conversation;
    if (event.type === "conversation.assigned" && c?.assignee_id && c.assignee_id !== hibira.botUserId) {
      await bot.getState().set(`human:${c.id}`, true);
    }
  },
});
```

Check that flag in your handler before you answer. Keep `onEvent` quick: Live Chat waits up to 15 seconds for the webhook answer.

## Options

```ts
createHibiraAdapter({
  apiKey: () => getSecret("livechat-key"), // a string, or a function called on every request
  webhookSecret: process.env.HIBIRA_LIVECHAT_WEBHOOK_SECRET,
  agentId: "ag_...",
  dispatchAgentMessages: false,
  onEvent: (event) => {},
  signatureToleranceSeconds: 300,
  userName: "hibira-bot",
});
```

| Option | Default | What |
| --- | --- | --- |
| `apiKey` | `HIBIRA_LIVECHAT_API_KEY` | API key, or a function that returns it. Functions are called on every request, so rotated keys work. |
| `webhookSecret` | `HIBIRA_LIVECHAT_WEBHOOK_SECRET` | Signing secret, or a function that returns it |
| `agentId` | `HIBIRA_LIVECHAT_AGENT_ID` | The agent the bot answers as |
| `apiUrl` | `https://chat.hibira.io/v1` | REST API base URL |
| `dispatchAgentMessages` | `false` | Also send your human agents' messages to your handlers. Set `agentId` with it, so that the bot always recognises its own replies. |
| `onEvent` | none | Called with every verified webhook event, such as `conversation.assigned`, `conversation.closed` or `conversation.rated` |
| `signatureToleranceSeconds` | `300` | How old a signature may be |
| `fetch` | global `fetch` | For tests and proxies |

## Live Chat actions

`bot.getAdapter("hibira")` returns the adapter, which has these methods besides Chat SDK's:

| Method | What |
| --- | --- |
| `handoff(threadId, { agentId?, teamId? })` | Assigns the chat to an agent, or puts it unassigned in a team's queue (or the whole inbox) |
| `closeConversation(threadId)` | Closes the chat |
| `updateConversation(threadId, { status?, assigneeId?, teamId? })` | Any of the above |
| `postNote(threadId, text)` | A note only your agents see |
| `getConversation(threadId)` | The conversation (visitor name, email, page, verified `user_id`, channel...) and its latest 100 messages |

## Features

| Feature | Supported |
| --- | --- |
| Post message | Yes, as the bot's agent |
| Streaming | Collected, then sent as one message, with a typing indicator |
| Typing indicator | Yes |
| Direct messages | Yes, every conversation |
| Fetch messages, single message, thread info | Yes (latest 100 messages) |
| Cards, tables | Sent as plain text |
| Edit and delete messages, reactions, file uploads | No |
| Buttons, modals, slash commands | No |

Messages from the visitor reach your handlers. Internal notes, the bot's own replies, the workspace AI's answers and system messages don't. Human agents' messages don't either, unless you set `dispatchAgentMessages`.

## Links

- [Live Chat REST API and webhooks](https://chat.hibira.io/docs)
- [Chat SDK docs](https://chat-sdk.dev/docs)
- [Hibira](https://hibira.io)

## 中文摘要

`@hibira-io/chat-adapter` 是 Hibira Live Chat 的 Chat SDK（Vercel）適配器：同一個 bot 除了 Slack、Teams、Discord，也能回答網站聊天、LINE 與 Email 的訪客。

- 在 chat.hibira.io「設定 › API 與 Webhook」建立讀寫 API 金鑰（`HIBIRA_LIVECHAT_API_KEY`），並新增指向 bot 網址、至少勾選 `message.created` 的 Webhook 端點（簽章密鑰放 `HIBIRA_LIVECHAT_WEBHOOK_SECRET`）。需要 Team 或 Business 方案。
- 每個對話是一個 Chat SDK 私訊討論串（`hibira:<對話 ID>`），只有訪客訊息會送進你的 handler；內部備註、bot 自己的回覆、工作區 AI 與系統訊息都不會。
- Live Chat 顯示純文字：Markdown、卡片與表格會轉成易讀文字，超過 4,000 字自動拆成多則；AI 串流會先顯示「正在輸入」，寫完再一次送出。
- `handoff()` 把對話交給真人或團隊佇列，`onEvent` 可得知客服接手，`postNote()` 寫內部備註，`closeConversation()` 結束對話。
- 若工作區開著內建 AI 助理，請先關掉，以免訪客收到兩個回答。

## License

MIT
