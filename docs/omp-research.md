# OMP integration: pinned SDK contract

## Inspected sources and version

The application pins `@oh-my-pi/pi-coding-agent` **18.18.6**. Inspection used
upstream commit [`bb8d763482c351264b3093e9bb81d27edd3ed1e9`](https://github.com/can1357/oh-my-pi/tree/bb8d763482c351264b3093e9bb81d27edd3ed1e9)
and the installed npm package. Their `src/sdk.ts` files have identical SHA-256
`35aacef7adcb9cb5e4dc74bc28b92fe7af60eec75f2676e454c59cf7af0f8fcc`.
Local automated checks use Bun **1.4.4**.

References inspected:

- [SDK guide](https://github.com/can1357/oh-my-pi/blob/bb8d763482c351264b3093e9bb81d27edd3ed1e9/docs/sdk.md)
- [Session storage guide](https://github.com/can1357/oh-my-pi/blob/bb8d763482c351264b3093e9bb81d27edd3ed1e9/docs/session.md)
- [Minimal streaming example](https://github.com/can1357/oh-my-pi/blob/bb8d763482c351264b3093e9bb81d27edd3ed1e9/packages/coding-agent/examples/sdk/01-minimal.ts)
- [Authentication example](https://github.com/can1357/oh-my-pi/blob/bb8d763482c351264b3093e9bb81d27edd3ed1e9/packages/coding-agent/examples/sdk/09-api-keys-and-oauth.ts)
- [File-backed session example](https://github.com/can1357/oh-my-pi/blob/bb8d763482c351264b3093e9bb81d27edd3ed1e9/packages/coding-agent/examples/sdk/11-sessions.ts)
- Installed `src/sdk.ts`, `src/config/model-registry.ts`,
  `src/config/settings.ts`, `src/session/session-manager.ts`,
  `src/session/session-loader.ts`, `src/registry/agent-registry.ts`, and
  `src/session/agent-session.ts`

## Authentication and exact model selection

`resolveModel({ agentDir, authMode?, provider?, modelId? })` opens a dedicated
`AuthStorage` at `<agentDir>/agent.db`, creates `new ModelRegistry(...)`, and
awaits `refresh("online-if-uncached")`. `getAvailable()` and
`hasConcreteAuth(provider)` identify authenticated catalog entries.
`getApiKey(selectedModel)` then checks that the selected credential actually
resolves; the credential is never returned to Telegram or written to logs.

The provider/id pair is accepted only if that exact available catalog entry
identifies itself as GPT-6 by exact display name or exact final model-id
component. Without a configured pair, selection requires exactly one such
entry. Zero entries, ambiguous entries, partial configuration, and other
models fail explicitly. Neither spelling a guessed id nor configuring an
unrelated model is an accepted workaround. Both client-side and server-side
fallback are disabled. An SDK dispatch assertion independently enforces the
selected provider/id on every model request.

### Subscription route and retained API alternative

`OMP_AUTH_MODE` defaults to `codex`. The installed registry exposes the real
`openai-codex` provider with `openai-codex-responses` transport. The installed
`AuthStorage.oauth.login("openai-codex-device", controller)` alias stores its grant
under **`openai-codex`**. The device implementation is verified in
`@oh-my-pi/pi-ai/src/registry/oauth/openai-codex.ts` and the alias routing in
`src/auth/oauth.ts`. It requires only device-browser authorization; no operator
password or OAuth token is collected by this application. `bun run login:codex`
is a separate TTY-only operator command, not a bot/HTTP endpoint.

The helper creates/uses a dedicated private bot directory, rejects personal-agent
paths, displays the pinned official device URL/short-lived code only to the local
TTY, rejects unexpected prompts, and closes AuthStorage on success, failure or
cancellation. It does not read `~/.codex`, ambient OMP auth, or Hoplite credentials.
The command must not run in deployment logs or be redirected into the chat.

**Important SDK behavior:** `AuthStorage.create(path)` opens the credential store
but does not populate the in-memory credential pool. Explicitly await
`authStorage.credentials.reload()` before checking persisted OAuth/auth sources.
This is required for restart restoration, not optional discovery.

Model resolution filters by the chosen route before selecting GPT-6. Subscription
mode requires stored OAuth with `keys.source(provider).kind === "oauth"` and no
mixed static credentials for Codex; runtime/config API overrides are refused.
The same assertion runs when each session opens and before every inference
dispatch. OAuth refresh uses OMP's verified authentication pipeline through
`ModelRegistry.getApiKey(model)`; the method name does not imply API-key billing:
it resolves the OAuth bearer for the Codex transport. Session fallback remains
disabled and dispatch asserts the actual provider/model. Expired or revoked
subscription access cannot switch the model/provider or enable API billing.

`OMP_AUTH_MODE=api` deliberately retains the API-key implementation, excluding
Codex transport and OAuth-only providers. For OpenAI API credentials the SDK uses
`OPENAI_API_KEY`; this variable is not required for subscription login. Existing
API deployments must set `OMP_AUTH_MODE=api` explicitly after upgrading because
the default is now subscription-only. No unrelated dependencies were upgraded.

Official [OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth)
(redirect target of `https://developers.openai.com/codex/auth`, inspected
2026-11-10) distinguishes ChatGPT subscription access from separately billed API
access. Headless device login may require enabling device-code authorization in
personal security settings or workspace permissions. A valid grant still does not
prove GPT-6 entitlement; only the real authenticated runtime catalog and inference
can do that. The startup probe consumes subscription quota or API billing according
to the explicit mode.

The authentication example currently mentions `ModelRegistry.create()`, but
that method is absent from the pinned implementation. This application uses
the verified constructor and asynchronous `refresh()` rather than copying
the stale example. Local `models.yml` loading is deliberately disabled to
avoid ambient provider routing and command-backed configuration overrides.

Credential resolution is not a successful inference/authentication test
against the remote provider. A real GPT-6 response in the deployed runtime
remains a required live acceptance gate.

## Session service contract

Construct `AgentSessionService` with `model`, `authStorage`, `modelRegistry`,
`authMode`, `agentDir`, `sessionDir`, and stable `cwd`. The first three values come from
`resolveModel()`. Use one service instance in the single application process.

`open({ id, sessionId?, sessionPath?, onReference? }, ephemeral = false)`
returns a handle exposing:

- `sessionId`, optional `sessionPath`, and read-only `toolNames`
- `prompt(text, onDelta): Promise<string>` for one turn
- `abort(): Promise<void>`
- idempotent `dispose(): Promise<void>`

The caller owns the stable application conversation id, Telegram identity
mapping, generation metadata, deadlines, and delivery. Await
`onReference({ sessionId, sessionPath })` to commit the mapping before the
handle is made available for prompting. Always dispose the handle in a
`finally` block. The service rejects a second open for an already-admitted
conversation; separate conversation ids can generate concurrently. Dispose
the shared model runtime only after all handles have been disposed.

Every handle passes a private `new AgentRegistry()` and
`bindProcessState: false`. This follows the documented concurrent top-level
session rule: the default global registry has a shared `Main` identity and
must not be reused for unrelated users.

## Persistence and fail-closed restoration

Persistent sessions use `SessionManager.create(cwd, ownerDirectory)` and
`SessionManager.open(path, ownerDirectory, ..., { throwIfMissing: true })`.
Owner directories are SHA-256 hashes of the stable application conversation
id beneath the configured session root. A custom OMP metadata entry binds
the file to that same conversation id without injecting it into model
context.

OMP normally defers creating a session file until an assistant message
exists. `flush()` alone does **not** materialize a newly allocated session.
The application calls `ensureOnDisk()` and then `flush()` before publishing
a new reference, so a restart immediately after creation remains resumable.

Before opening a reference, the service verifies its resolved directory,
official parser corruption flags, leading header, exact session id, current
format version, working directory, and application ownership marker. Missing,
truncated, mismatched, and incompatible files produce `SessionReferenceError`;
the service never uses `continueRecent()` or silently creates a replacement.
Only the pinned current session format is accepted. Older-format migration
must be an explicit offline operation with a backup, not an automatic
production repair. A damaged session requires backup restoration or the
user's explicit reset.

`prompt()` flushes the file after success, cancellation, or failure. SDK
`dispose()` drains and closes owned persistence resources. SQLite metadata
and OMP files cannot participate in one database transaction: the ordering
ensures an advertised new reference already exists, but a failed metadata
commit can leave an unreferenced file. Preserve those files for operator
inspection; never guess which conversation should adopt them.

Guest handles alone use `SessionManager.inMemory(cwd)` and do not publish a
reference or create a persistent conversation transcript. They must have an
interaction-specific application id rather than a private conversation id.

## Streaming, cancellation, and capabilities

Streaming follows the official minimal example:
`message_update` with `assistantMessageEvent.type === "text_delta"`.
Only these text deltas reach the Telegram layer. `message_end` with provider
`stopReason: "error"` fails the turn instead of reporting partial output as a
successful answer.

The cancellation latch is set synchronously before awaiting
`session.abort()`. Further deltas and completion/error events are ignored by
the stopped handle; cancellation reaches the provider's abort signal.
`dispose()` also blocks late delivery and cancels an active turn. A stopped
handle cannot be reused; open a new handle to continue the persisted
conversation. Telegram draft ids and atomic generation-state transitions
remain responsibilities of the streaming/storage layers.

The SDK session is explicitly configured with:

- `toolNames: []`, `restrictToolNames: true`, no custom tool paths or tools
- `disableExtensionDiscovery: true`, no extensions or extension paths
- `enableMCP: false`, `enableLsp: false`, `enableIrc: false`
- empty skills, rules, context files, prompt templates, and slash commands;
  `noContextFiles: true`
- isolated settings, memory backend off, auto-learning off, advisors off,
  prewalk off, workspace tree off, provider cache warming off, retries off,
  and compaction off
- no automatic titles, no command/template expansion on user prompts

The active tool list is checked after creation and on a test transport's
actual provider request. Installed shell, browser, git, filesystem, MCP, and
extension tools are therefore not exposed to the model. The host SDK still
reads/writes its own session and credential files; tool restrictions are not
an OS sandbox.

Upstream 18.18.6 still probes repository metadata and `WATCHDOG` configuration
candidates internally; it exposes no corresponding discovery override.
Advisors are disabled, so those candidates cannot initiate advisory model
work. Keep the deployment's stable working directory and agent directory
clean and application-owned. This limitation must be rechecked on any SDK
upgrade. Compaction is disabled to avoid auxiliary inference and hidden
model routing; very long conversations can eventually reach the provider
context limit and require `/new` or an explicit product-level compaction
policy.

## Verification boundary

`tests/agent.test.ts` uses the **real pinned SDK**, SQLite credential storage,
file-backed SessionManager, isolated registries, official event stream, and
cancellation. Only the provider transport/model catalog fixture is
simulated; its GPT-6 label is not a claim of real model availability.

The tests cover authenticated catalog selection, unavailable/ambiguous
selection, pre-prompt file materialization, completed-session restoration,
separate-process native transcript reopening, concurrent user/topic isolation, busy admission, ambient configuration
restriction, provider cancellation and late events, active-turn disposal,
provider errors, corrupted/missing/mismapped session rejection, metadata
callback failure, and ephemeral guest storage.

There are no deployed provider credentials in this development task. Real
GPT-6 inference, valid remote authentication, Railway redeployment, Telegram
streaming, and all Telegram UI behavior must be verified separately by the
coordinating application/deployment task. Local mocked transport tests do
not prove those live requirements.
