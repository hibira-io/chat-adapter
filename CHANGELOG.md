# Changelog

## 0.1.1

- `createHibiraAdapter()` throws when `dispatchAgentMessages` is set without `agentId` (or `HIBIRA_LIVECHAT_AGENT_ID`). Without it, a freshly started adapter couldn't tell its own replies from your agents' messages and could answer itself.
- README: the typing indicator shows once the bot has written in the conversation; files in a reply are not sent.

## 0.1.0

First release.

- `createHibiraAdapter()`: Hibira Live Chat conversations (website widget, LINE, email) as Chat SDK direct-message threads, with verified webhooks.
- Replies through the REST API as a chosen agent, with Markdown, cards and tables turned into plain text and long answers split.
- Streams are collected behind a typing indicator and sent as one message.
- Live Chat actions: `handoff()`, `closeConversation()`, `updateConversation()`, `postNote()`, `getConversation()`; `onEvent` for every webhook event.
