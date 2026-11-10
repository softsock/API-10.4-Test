import { mkdir, stat, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { readConfig } from "./config.ts";
import { resolveModel, type ModelRuntime } from "./agent/model-service.ts";
import { AgentSessionService } from "./agent/session-service.ts";
import { StreamService } from "./agent/stream-service.ts";
import { Storage } from "./storage/index.ts";
import { TelegramApi } from "./telegram/api.ts";
import { TelegramBot } from "./telegram/bot.ts";
import { sendRenderedResponse } from "./rendering/rich-message.ts";
import { createHandler } from "./server.ts";

// verify volume-backed paths before accepting updates that promise durable conversation history
async function validateStorage(paths: string[]): Promise<void> {
  if (process.env.RAILWAY_ENVIRONMENT_ID && process.env.RAILWAY_VOLUME_MOUNT_PATH !== "/data") {
    throw new Error("Railway requires a persistent volume mounted at /data");
  }
  for (const path of paths) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (!(await stat(path)).isDirectory()) throw new Error("Persistent storage path is not a directory");
    const probe = `${path}/.write-check-${crypto.randomUUID()}`;
    await writeFile(probe, "ok", { mode: 0o600, flag: "wx" });
    await unlink(probe);
  }
}

// keep the single process responsible for durable admission, model readiness and orderly resource shutdown
async function main(): Promise<void> {
  const config = readConfig();
  await validateStorage([dirname(config.databasePath), config.agentDir, config.sessionsDir, "/data/backups"]);
  const store = new Storage(config.databasePath);
  store.recoverInterrupted();
  const api = new TelegramApi(config.token);
  let ready = false;
  let stopping = false;
  let initialized = false;
  let shutdownPromise: Promise<void> | undefined;
  let startupProbe: { abort(): Promise<void> } | undefined;
  let runtime: ModelRuntime | undefined;
  let streams: StreamService | undefined;
  let telegram: TelegramBot | undefined;
  let worker: ReturnType<typeof setInterval> | undefined;
  const processing = new Set<Promise<void>>();
  let normalProcessing = 0;
  const server = Bun.serve({ hostname: "0.0.0.0", port: config.port, maxRequestBodySize: 262144,
    fetch: createHandler({ secret: config.webhookSecret, ready: () => ready && !stopping,
      accept: update => {
        if (!store.getUpdate(update.update_id) && store.countPendingUpdates() >= 1000) throw new Error("Inbox capacity reached");
        return store.acceptUpdate(update.update_id, update);
      } }) });

  // fence new work before draining every worker that may still write session files or sqlite
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true; ready = false;
    if (worker) clearInterval(worker);
    shutdownPromise = (async () => {
      try {
        await telegram?.shutdown();
        await streams?.shutdown();
        await Promise.allSettled([...processing]);
        runtime?.dispose();
        store.close();
      } finally { await server.stop(true); }
    })();
    return shutdownPromise;
  };
  // let initialization unwind before closing resources that it may still be constructing
  const requestShutdown = (): void => {
    stopping = true; ready = false;
    void startupProbe?.abort().catch(() => {});
    if (initialized) void shutdown();
  };
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);
  let stage = "model_discovery";
  try {
    runtime = await resolveModel({ agentDir: config.agentDir, provider: config.modelProvider, modelId: config.modelId });
    if (stopping) throw new Error("Shutdown requested");
    const sessions = new AgentSessionService({ ...runtime, agentDir: config.agentDir, sessionDir: config.sessionsDir, cwd: config.cwd });
    stage = "model_authentication_probe";
    const probe = await sessions.open({ id: `startup:${crypto.randomUUID()}` }, true);
    if (stopping) { await probe.dispose(); throw new Error("Shutdown requested"); }
    startupProbe = probe;
    const timeout = setTimeout(() => { void probe.abort().catch(() => {}); }, 30000);
    try {
      const response = await probe.prompt("Reply with the single word ready.", () => {});
      if (!response.trim()) throw new Error("Model readiness probe returned no text");
    } finally { clearTimeout(timeout); await probe.dispose(); startupProbe = undefined; }
    if (stopping) throw new Error("Shutdown requested");
    streams = new StreamService(store, api, async conversation => sessions.open({
      id: conversation.id, sessionId: conversation.omp_session_id, sessionPath: conversation.omp_session_path,
      onReference: reference => {
        if (!store.setSessionReference(conversation.id, reference.sessionId, reference.sessionPath, conversation.omp_session_id)) {
          throw new Error("Conversation session reference changed; refusing to attach this transcript");
        }
      },
    }), async (conversation, text) => {
      await sendRenderedResponse(api, { chat_id: conversation.chat_id, message_thread_id: conversation.thread_id || undefined }, text);
    }, config.maxConcurrent, config.turnTimeoutMs, 1000, id => telegram?.refreshWidgets(id));
    telegram = new TelegramBot(config, store, streams, sessions, api, `${runtime.model.provider}/${runtime.model.id}`);
    stage = "telegram_initialization";
    await telegram.bot.init();
    if (stopping) { await shutdown(); return; }
    await telegram.bot.api.setMyCommands([
      { command: "start", description: "Introduction and basic controls" }, { command: "help", description: "Available commands" },
      { command: "new", description: "Start a new conversation" }, { command: "stop", description: "Cancel generation" },
      { command: "status", description: "Current session status" }, { command: "model", description: "Actual provider and model" },
      { command: "widget", description: "Agent Control widget" }, { command: "reset", description: "Reset after confirmation" },
    ]);
    stage = "webhook_registration";
    await telegram.bot.api.setWebhook(config.webhookUrl, { secret_token: config.webhookSecret,
      allowed_updates: ["message", "guest_message", "callback_query", "stopped_message_generation", "widget_query"] as NonNullable<Parameters<typeof telegram.bot.api.setWebhook>[1]>["allowed_updates"],
      max_connections: 8, drop_pending_updates: false });
    const info = await telegram.bot.api.getWebhookInfo();
    if (info.url !== config.webhookUrl) throw new Error("Webhook URL verification failed");
    if (stopping) throw new Error("Shutdown requested");
    initialized = true; ready = true;
    worker = setInterval(() => {
      if (!ready || stopping || !telegram || processing.size >= 16) return;
      for (const item of store.getPendingUpdates(32)) {
        if (processing.size >= 16) break;
        const payload = item.payload as Record<string, unknown>;
        const control = !!(payload.widget_query || payload.callback_query || payload.stopped_message_generation ||
          (typeof (payload.message as { text?: string } | undefined)?.text === "string" && /^\/stop(?:@\w+)?(?:\s|$)/i.test((payload.message as { text: string }).text)));
        if (!control && normalProcessing >= 8) continue;
        if (!store.claimUpdate(item.update_id)) continue;
        if (!control) normalProcessing++;
        const task = telegram.bot.handleUpdate(item.payload as Parameters<typeof telegram.bot.handleUpdate>[0])
          .then(() => { store.finishUpdate(item.update_id, "completed"); }, () => {
            store.finishUpdate(item.update_id, "failed", "update_processing_failed");
            console.error(JSON.stringify({ event: "update_failed", updateId: item.update_id }));
          }).finally(() => { processing.delete(task); if (!control) normalProcessing--; });
        processing.add(task);
      }
    }, 50);
    console.info(JSON.stringify({ event: "ready", provider: runtime.model.provider, model: runtime.model.id }));
  } catch {
    console.error(JSON.stringify({ event: "startup_failed", stage,
      action: "Check bot-owned GPT-6 catalog/authentication with bun scripts/models.ts, Telegram credentials, HTTPS webhook URL, and /data volume; see README. No model fallback is enabled." }));
    await shutdown();
    process.exitCode = 1;
  }
}

await main();
