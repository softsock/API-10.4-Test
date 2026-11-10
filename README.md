# Telegram OMP Agent

A single-instance TypeScript Telegram bot using Oh My Pi (OMP) for isolated,
file-backed personal conversations. The deployment target is Railway with one
persistent `/data` volume. **Source and mocked tests are not evidence of a deployed
bot.** No production URL or live Telegram/GPT-6 verification is claimed; follow
[the acceptance procedure](docs/verification.md) before opening access.

**Current handoff:** code and pull request only, as requested. Railway provisioning
and live integration are deferred; [verification results](docs/verification.md)
separate SDK/transport tests from the unexecuted live acceptance checks.

## Pinned stack

| Component | Version |
| --- | --- |
| Bun | 1.4.4 |
| `@oh-my-pi/pi-coding-agent` / `@oh-my-pi/pi-ai` | 18.18.6 |
| grammY | 1.46.0 |
| TypeScript (strict) | 7.0.2 |
| Telegram Bot API | 10.4 |

`bun.lock` pins the transitive graph. grammY handles standard messages and callbacks;
`src/telegram/api.ts` and `src/telegram/types.ts` define the direct typed adapter
for newer methods and update payloads rather than assuming library support.
See [OMP research](docs/omp-research.md) for verified SDK signatures and discovery
restrictions and [persistence](docs/persistence.md) for database invariants.

## Prerequisites and credentials

1. Create a bot with [@BotFather](https://t.me/BotFather), retain its token privately,
   and obtain your own numeric Telegram user ID from a trusted source.
2. Enable **Guest Mode** in BotFather for this bot before testing guest invocations.
   BotFather configuration and eligible external-chat restrictions are independent
   of the application's `GUEST_ACCESS_MODE`. Leave the latter `disabled` initially;
   use `owner` for initial tests. A rejected invocation does not prove Guest Mode works.
3. Supply separate model-provider credentials to the bot runtime. Hoplite's coding
   agent authentication is not a deployment credential and must never be copied.
   The OpenAI API-key provider uses `OPENAI_API_KEY`; confirm that account actually
   has GPT-6 access. An API key alone does not prove model availability.
4. Supply Railway access and explicitly approve any paid service, persistent
   volume, or backup feature **before creating it**. This repository does not
   provision resources or contain a Railway token.

OMP uses `AuthStorage` and `ModelRegistry` to discover authenticated models. With
both `OMP_MODEL_PROVIDER` and `OMP_MODEL_ID` unset, GPT-6 is discovered from the
runtime's real registry. To select explicitly, set **both** to a real GPT-6
provider/model pair reported by that registry. Do not guess an identifier, set a
marketing name as an ID, or substitute a different model. Unavailable or
unauthenticated GPT-6 must fail startup with a configuration error; obtain access
and restart rather than editing the bot to silently fall back. Check `/model`
after deployment to see the actual selected pair.

Run `bun scripts/models.ts` in the configured runtime to inspect bot-owned model
and authentication diagnostics before starting the service. The production image
includes this script. Never use developer/Hoplite auth files to make discovery
appear successful. On every application start, the bot sends one small GPT-6
readiness prompt through OMP to verify real provider authentication. **This request
is billable**, including on restarts and failed/repeated deployments. `/ready`
remains unavailable until that probe, Telegram bot initialization, command setup,
and webhook registration/URL verification succeed. Catalog discovery alone does
not establish successful model authentication.

## Development

```sh
sh .hoplite/setup.sh
export PATH="$PWD/.tools/bun-linux-x64:$PATH" # Linux x86_64; aarch64 uses bun-linux-aarch64
bun run typecheck
bun test
cp .env.example .env
```

Fill `.env` locally, never commit it. `bun run start` loads it through Bun. Runtime
storage paths must be absolute paths below `/data`, so local execution also needs
a writable `/data` and the stable `/app/agent-workdir`; prefer the Docker workflow
rather than changing production paths to an ephemeral directory. For direct
execution, have the machine administrator create those directories and grant the
application user access. `ADMIN_USER_ID` is a positive integer and the webhook
secret is 32–256 URL-safe characters. `TELEGRAM_WEBHOOK_URL` must be the exact
public HTTPS `/telegram/webhook` URL without a query string.

```sh
docker build -t telegram-omp-agent .
docker volume create telegram-omp-data
docker run --rm --name telegram-omp-agent --user 0:0 \
  --env-file .env -p 3000:3000 \
  --mount source=telegram-omp-data,target=/data telegram-omp-agent
```

The entrypoint repairs volume ownership when started as root and then **executes
the application as the non-root `bun` user**. The image's default user is `bun`;
without the root startup override, the volume must already be writable by UID/GID
1000. A local port mapping does not create an HTTPS Telegram webhook endpoint.
Do not point an actively deployed bot at a development endpoint or run two
runtimes for the same volume. Do not use long polling alongside webhooks.

## Railway deployment from GitHub

Railway CLI 5.71.0 was checked with
`.tools/bun-linux-x64/bun x @railway/cli@latest --version`; CLI availability
is not authentication or deployment proof. `RAILWAY_TOKEN` was absent at the
credential presence check, so no deployment was performed.

After explicit approval for resources:

1. Push this repository and its lockfile to the connected GitHub repository.
   In Railway create one application service from that repository. Select the
   intended branch; the root `Dockerfile` and `railway.json` provide the build and
   startup configuration. Do not add a second service or database add-on.
2. Attach a persistent volume to **that service**, mounted at `/data`. Keep exactly
   one replica, one region, and one writer. Disable sleeping/serverless behavior:
   durable webhook work runs asynchronously inside the application process.
3. In service networking generate a public HTTPS domain. Set
   `TELEGRAM_WEBHOOK_URL=https://YOUR_DOMAIN/telegram/webhook` before starting the
   configured service. Do not supply a URL path other than `/telegram/webhook`.
4. Add `.env.example` variables in Railway Variables, with actual secrets supplied
   directly there: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and the selected
   provider's authentication (for OpenAI, `OPENAI_API_KEY`). Set `ADMIN_USER_ID`,
   `BOT_ACCESS_MODE=owner`, and `GUEST_ACCESS_MODE=disabled`. Retain the `/data`
   defaults. Leave model selectors unset for authenticated GPT-6 discovery or set
   the exact verified pair. Never paste credentials into GitHub, a PR, build args,
   logs, shell command text, or support screenshots.
5. Set `RAILWAY_RUN_UID=0` because Railway mounts volumes as root. This permits only
   startup ownership repair; the entrypoint drops to `bun` before running the bot.
   The build-time `/data` ownership does not override mounted-volume permissions.
   Do not override the Docker entrypoint. Leave the start command at the image
   default. Railway supplies `PORT`; the server listens on `0.0.0.0`.
6. Deploy. The `/ready` healthcheck must return HTTP 200 only after the billed GPT-6
   authentication probe and Telegram/webhook initialization;
   `/health` is process liveness. Missing provider access, unwritable storage, or
   missing configuration must be fixed rather than bypassing readiness. No OMP
   initialization or migration belongs in a pre-deploy command: Railway does not
   mount volumes during builds or pre-deploy execution.
7. Verify the registered webhook with Telegram `getWebhookInfo` using your secret
   token privately. Confirm its URL, allowed updates, absence of `last_error_message`,
   and normal pending update count. Startup verifies the URL through
   `getWebhookInfo`; it registers `setWebhook` with `secret_token` and these updates: `message`, `guest_message`, `callback_query`,
   `widget_query`, `stopped_message_generation`. Never register via a browser URL
   that puts the bot token in browsing history. Do not clear pending updates just
   to make deployment look healthy.
8. Verify a POST without `X-Telegram-Bot-Api-Secret-Token` is rejected; do not expose
   the secret in test output. Execute every live check in
   [the acceptance procedure](docs/verification.md), including redeployment and
   conversation resumption, before considering production complete.

Railway [volume documentation](https://docs.railway.com/volumes) confirms mounts
exist only at runtime and describes the root permission requirement.
[Healthchecks](https://docs.railway.com/deployments/healthchecks) gate deployment,
not continuous monitoring. A volume-backed redeploy has a short downtime even
with readiness configured; do not claim zero-downtime or horizontal scaling.
Set a sufficient Railway shutdown grace period for OMP cancellation and persistence
flush; verify it during the restart acceptance check before public use.

## Commands and interaction boundaries

| Command | Purpose |
| --- | --- |
| `/start`, `/help` | Introduction and available commands |
| `/new` | Detach the active transcript and start fresh; retained files are not erased |
| `/stop` | Cancel this conversation's active turn |
| `/status` | Safe current session and generation status |
| `/model` | Actual selected provider/model pair |
| `/widget` | Open or recreate the private Agent Control widget |
| `/reset` | Detach the active transcript after a one-minute confirmation; retained files are not erased |

`/new`, confirmed `/reset`, and the widget's New Session action retain previous
transcript files; they are not data-erasure controls. Stop active generation
before using them. Retention and backup deletion require a separate authorized
operator procedure.

Private identity includes user ID, chat ID, and topic/thread ID. Native streaming
and Agent Control widgets are private-chat features; guest responses do not use
them. Drafts are temporary and need final message delivery. Completed output uses
Telegram Rich Messages, with plain-text fallback where necessary. Arbitrary browser
HTML is not Rich Message content. Widget HTML is self-contained and may not access
the network. Guest context is isolated, short-lived, and does not imply access to
complete external chat history. Callback ephemeral replies are not durable storage.
Actual client/server availability of Bot API 10.4 features must be verified live;
unsupported capability errors are not evidence of a successful fallback feature.

Keep owner-only access until verifying cost controls. The current configuration
caps global concurrent generations at two, prompt length at 12,000 characters,
and turn duration at 120 seconds. Per-user limits and per-conversation busy
responses do not create a provider spending cap; configure provider account
budgets separately. Never enable shell, filesystem, browser, Git, extension, or
MCP discovery for this conversational bot just because packages are installed.

## Persistence, backup, and operations

```text
/data/app.sqlite         SQLite metadata, inbox and deduplication
/data/omp/agent/         Explicit OMP configuration/auth storage
/data/omp/sessions/      Native file-backed OMP conversations and artifacts
/data/backups/           Private coordinated archives, when created
```

Read [persistence and recovery](docs/persistence.md) before backup or restoration.
Back up SQLite **and** OMP data from the same stopped-writer snapshot. Stop the
service gracefully; do not copy only a live `app.sqlite` or only session JSONL.
Archive the full data tree except `/data/backups` itself, preserve WAL/SHM files
when present, record a checksum, and keep an encrypted off-volume copy in an
approved destination. A backup on the same volume is not disaster recovery.
A Railway platform backup is optional and requires separate approval if billable.

Restore only while all writers are stopped: preserve the failed tree, restore one
coherent snapshot at the same absolute paths, restore UID/GID 1000 ownership,
start one instance, and test resumption with the original user/chat/topic before
reopening access. Never merge separate database/session snapshots. Backups can
contain personal conversations and credentials; keep them outside source control.

Interrupted generations are not resumed automatically. Deduplicated updates are
not replayed after an ambiguous delivery: Telegram sends and SQLite commits cannot
be atomic. Definitive 429 rejections may retry with backoff; transport timeouts do
not justify blindly resending a final response. A crash can leave a partial
multipart answer. Ask the user to send an explicit new request instead.

## References and validation

- [OMP repository](https://github.com/can1357/oh-my-pi),
  [SDK](https://github.com/can1357/oh-my-pi/blob/bb8d763482c351264b3093e9bb81d27edd3ed1e9/docs/sdk.md),
  [examples](https://github.com/can1357/oh-my-pi/tree/bb8d763482c351264b3093e9bb81d27edd3ed1e9/packages/coding-agent/examples/sdk),
  [session persistence](https://github.com/can1357/oh-my-pi/blob/bb8d763482c351264b3093e9bb81d27edd3ed1e9/docs/session.md)
- [Telegram API](https://core.telegram.org/bots/api),
  [10.4 changelog](https://core.telegram.org/bots/api-changelog#november-9-2026),
  [widgets](https://core.telegram.org/bots/widgets),
  [features](https://core.telegram.org/bots/features)
- [Live acceptance checklist and evidence requirements](docs/verification.md)

CI runs frozen installation, strict typechecking, Bun tests, and a Docker image
build. None of these proves model authentication, Telegram rendering, or Railway
persistence; those require the real acceptance checks.
