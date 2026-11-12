# Changelog

## 0.1.0

First release.

- `createHibiraAdapter()`: Hibira Live Chat conversations (website widget, LINE, email) as Chat SDK direct-message threads, with verified webhooks.
- Replies through the REST API as a chosen agent, with Markdown, cards and tables turned into plain text and long answers split.
- Streams are collected behind a typing indicator and sent as one message.
- Live Chat actions: `handoff()`, `closeConversation()`, `updateConversation()`, `postNote()`, `getConversation()`; `onEvent` for every webhook event.
