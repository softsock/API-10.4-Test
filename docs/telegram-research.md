# Telegram 10.4 implementation notes

Sources inspected on 2026-11-10, including the complete source HTML behind the
relevant API tables and the widget profile:

- [Bot API](https://core.telegram.org/bots/api), especially `InputRichMessage`,
  `sendMessageDraft`, `sendRichMessageDraft`, `sendWidget`, `WidgetQuery`,
  `answerWidgetQuery`, `editMessageWidgetData`, `answerGuestQuery`,
  `EphemeralMessageParameters`, and `MessageGenerationStopped`.
- [November 9, 2026 / Bot API 10.4 changelog](https://core.telegram.org/bots/api-changelog#november-9-2026).
- [Widget runtime, supported profile, limits, bridge, and counting the size](https://core.telegram.org/bots/widgets).
- [Bot features](https://core.telegram.org/bots/features).

## Installed library compatibility

The repository pins grammY **1.46.0**, which installs `@grammyjs/types` **5.0.0**.
The installed declarations include guest updates, native stop updates, rich
messages, and stoppable drafts. They do **not** include `widget_query`,
`sendWidget`, `answerWidgetQuery`, or `editMessageWidgetData`. This is partial,
not complete, Bot API 10.4 support. Keep normal update dispatch in grammY and
handle the new widget update through the typed compatibility adapter. Do not
expect an unknown update field to reach a grammY widget filter.

`src/telegram/api.ts` sends direct HTTPS JSON requests to the official Bot API.
Its types intentionally expose only the application-used, documented subsets;
for example, rich content supports mutually exclusive `markdown` or `html`
fields, and guest output uses the supported article variant of
`InlineQueryResult`. No fictional generic widget or rich block schema is used.

## Draft and cancellation semantics

- `sendMessageDraft` targets a **private** chat, accepts `message_thread_id`, and
  requires a nonzero integer `draft_id`. Empty `text` shows the thinking state.
- Draft text supports 0–4096 characters after entity parsing. The adapter uses
  a conservative 4096 UTF-16-unit source limit and no Markdown parse mode.
  Callers should use `splitPlainText()` or equivalent UTF-16-safe truncation,
  not a 4000-code-point slice that may contain 8000 UTF-16 units of emoji.
- `can_stop` requests native Stop. `keep_on_stop` does not persist a reply.
  Both plain and rich drafts are temporary 30-second previews; final delivery
  requires `sendMessage` or `sendRichMessage` respectively.
- `stopped_message_generation` contains `chat`, optional `message_thread_id`,
  and `draft_id`. It does **not** contain `from`. Resolve the exact generation
  through persisted chat/thread/draft ownership, not an assumed user field.
- Draft timing, late-event suppression, OMP abort, and persistence remain the
  generation coordinator's responsibility, not this transport's.
- Both `sendMessageDraft(parameters, signal?)` and
  `sendRichMessageDraft(parameters, signal?)` accept an optional generation-owned
  `AbortSignal`. Abort it when the turn stops or finalizes so in-flight draft
  requests and sleeping 429 retries cannot send stale text afterward. Clearing
  the coordinator's interval alone does not cancel a retry already in progress.

## Rich message behavior

Official Rich Markdown supports ordinary paragraphs, headings, bold/italic,
inline code, language-marked fenced code blocks, lists, quotations, tables,
links, and dividers. It is **not** the legacy `MarkdownV2` parse mode.
`InputRichMessage` requires exactly one of `markdown`, `html`, or `blocks`.
The production renderer chooses `rich_message.markdown`; it never forwards
arbitrary browser HTML as a Rich Message.

Official limits include 32768 text characters, 500 blocks, 16 nesting levels,
50 attachments, and 20 table columns. The renderer uses conservative source
limits (16000 UTF-16 units, 400 lines, no deeply indented blocks) and disables
automatic entity detection. Unsafe media embeds, browser HTML, unsupported
protocol links, unclosed code fences, and oversized answers use a lossless
plain-text fallback. Oversized content is split at paragraph/line boundaries
where possible without cutting surrogate pairs. Because fallback has **no
parse mode**, it cannot leave broken Markdown/code formatting active across
messages; very large replies intentionally lose rich presentation rather than
risk malformed markup or dropped content.

A definite Telegram 400 rich/format/parse rejection may fall back to plain
text. Transport failures, invalid response bodies, and HTTP 5xx failures are
never automatically resent or replaced: Telegram may already have accepted
the message. Only explicit Telegram 429 rejections with `retry_after` are
retried, with bounded attempts, backoff, and a 30-second total operation budget. This favors nonduplication over
at-least-once delivery after an ambiguous network failure.

## Agent Control widget contract

`src/widgets/agent-control.ts` exports:

- `AGENT_CONTROL_HTML`: immutable, self-contained HTML with inline CSS/JS,
  Telegram theme variables, no external resources or network calls.
- `AgentControlState`: `revision`, `agent`, `status`, actual `model`,
  `operation`, optional millisecond `startedAt`/`finishedAt`, optional actual
  `inputTokens`/`outputTokens`, and a safe optional `error` summary. Status is
  `idle | thinking | streaming | completed | stopped | error`.
- `encodeAgentControlState(state)`: validates and encodes only allowed fields
  within the 1024-byte UTF-8 limit. Never include credentials, system prompts,
  private configuration, or unsanitized error details.
- `createAgentControlWidget(chat, state, messageThreadId?)`: rejects nonprivate
  chats and produces the `sendWidget` payload with `allow_queries: true`,
  `is_shared: false`, and **message-specific `chat_data`**. No `public_data`.
- `authorizeWidgetQuery(query, binding)`: validates the query against the
  stored `{ chatId, messageId, telegramUserId }`; rejects inline/shared/group
  widgets, mismatched owners/messages, non-data types, and unknown actions.
  Parent access policy and rate limits must also authorize the user.

The widget invokes `TelegramWidget.request('stop' | 'new' | 'status')`
synchronously from a click handler. Each request is 3–6 ASCII bytes, safely
within 1–64 bytes. The backend should:

1. Load the stored widget binding, apply user access/rate policy, and authorize.
2. Apply the action only to that binding's conversation. Do not permit `new`
   during active generation or trust disabled frontend controls for security.
3. Increment and persist the message's revision for every state edit, then use
   `editMessageWidgetData({ chat_id, message_id, chat_data: encodedState })`.
4. Answer promptly with
   `answerWidgetQuery({ widget_query_id, data: encodedState })`, or an encoded
   `{ error: "safe summary" }` within 1024 bytes. Always answer rejected queries
   too, without disclosing private state.

**Answer within 15 seconds.** Do not block the acknowledgement on model work.
The adapter bounds the answer request/retries to 12 seconds from invocation,
leaving only a small handler budget; invoke it promptly after receiving the
update. Native requests resolve as **`{ result: string | null }`**, not as the
JSON state object itself. The HTML parses `result` and accepts either a direct
state or `{ state }`/`{ error }`. Answers do not change persistent widget state.
The separate `chatDataChanged` event reconciles message state. Revision checks
ignore delayed older edits after a newer answer. No shared-state polling is
needed or used.

The HTML enforces pending/disabled controls, displays protocol failures, freezes
elapsed time at `finishedAt`, and never invents token usage. Privileged actions
are disabled in forwards, previews, and nonprivate contexts. Native CSS palette
variables follow light/dark Telegram themes automatically. Layout uses the
supported flex/attribute-selector profile with no scrolling, external fonts,
React, CDN, or browser APIs. HTML limits are 32768 uncompressed UTF-8 bytes and
4096 bytes at zlib level 9; both are checked before sends. The repository tests
also verify the compressed size with substantial safety margin. For an exact
server-equivalent count, Python `zlib.compress(html_bytes, 9)` is authoritative
near the boundary; Node/Bun zlib may differ slightly.

## Guest and ephemeral contracts

`guest_message` is a regular `Message` carrying `guest_query_id`.
`answerGuestQuery({ guest_query_id, result })` takes **one** `InlineQueryResult`,
not `results[]`, and returns `SentGuestMessage { inline_message_id }`, not a
regular `Message` or boolean. The adapter exposes a concise plain article
result. BotFather Guest Mode, eligible chat invocation, isolation, user rate
limits, available reply context, and invocation deadlines remain dispatcher
responsibilities. Do not assume full external-chat history or use private-only
widgets/streaming in guest replies.

For callback replies, send `ephemeral_message_parameters: { callback_query_id }`
without `receiver_user_id`; Telegram then scopes visibility to the clicking
user and ignores `chat_id`. `sendEphemeralReply()` omits chat/receiver entirely
and starts `answerCallbackQuery` immediately in parallel with the bounded private send, even on send failure. Never fall
back to a public group reply. Delivery is not guaranteed, especially offline,
and ephemeral callback replies do not work in channel direct-message chats.
Use an explicitly authorized private-chat fallback only where supported.

## Verification boundary

`tests/telegram-surface.test.ts` exercises mocked transport, wire shapes,
429/backoff and no ambiguous retries, rich fallback/Unicode, byte/compression
limits, widget ownership, callback scoping, and widget script reconciliation
using a small VM/DOM harness. These tests do **not** prove native Telegram
rendering, real GPT-6-generated content, BotFather configuration, Guest Mode
availability, or successful live widget/ephemeral delivery. The parent must
verify the integrated widget in Telegram on light/dark themes and narrow/wide
clients, plus all credentialed end-to-end acceptance steps. Browser screenshots
alone cannot establish QuickJS/native Telegram compatibility.
