import { isAbsolute, resolve } from "node:path";

// keep deployment configuration explicit and reject unsafe public defaults
export interface Config {
  token: string; webhookSecret: string; webhookUrl: string; adminId?: number;
  accessMode: "owner" | "public"; guestAccess: "disabled" | "owner" | "public";
  agentDir: string; sessionsDir: string; databasePath: string; cwd: string;
  modelProvider?: string; modelId?: string; port: number; logLevel: "error" | "info";
  maxConcurrent: number; maxPromptChars: number; turnTimeoutMs: number;
}

// fail early rather than silently starting with incomplete credentials or ephemeral storage
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  // keep missing-secret diagnostics actionable without ever echoing their values
  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Required environment variable: ${key}`);
    return value;
  };
  const token = required("TELEGRAM_BOT_TOKEN");
  const webhookSecret = required("TELEGRAM_WEBHOOK_SECRET");
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)) throw new Error("TELEGRAM_WEBHOOK_SECRET must contain 32–256 URL-safe characters");
  const webhookUrl = required("TELEGRAM_WEBHOOK_URL");
  const url = new URL(webhookUrl);
  if (url.protocol !== "https:" || url.pathname !== "/telegram/webhook" || url.username || url.password || url.search || url.hash) {
    throw new Error("TELEGRAM_WEBHOOK_URL must be an HTTPS /telegram/webhook URL without credentials or query");
  }
  const configuredAdmin = env.ADMIN_USER_ID?.trim();
  const adminId = configuredAdmin ? Number(configuredAdmin) : undefined;
  if (adminId !== undefined && (!Number.isSafeInteger(adminId) || adminId <= 0)) throw new Error("ADMIN_USER_ID must be a positive Telegram user ID when set");
  const accessMode = env.BOT_ACCESS_MODE ?? "owner";
  const guestAccess = env.GUEST_ACCESS_MODE ?? "disabled";
  if (accessMode !== "owner" && accessMode !== "public") throw new Error("BOT_ACCESS_MODE must be owner or public");
  if (!["disabled", "owner", "public"].includes(guestAccess)) throw new Error("GUEST_ACCESS_MODE must be disabled, owner, or public");
  const agentDir = env.OMP_AGENT_DIR ?? "/data/omp/agent";
  const sessionsDir = env.OMP_SESSIONS_DIR ?? "/data/omp/sessions";
  const databasePath = env.DATABASE_PATH ?? "/data/app.sqlite";
  for (const path of [agentDir, sessionsDir, databasePath]) {
    if (!isAbsolute(path) || !resolve(path).startsWith("/data/")) throw new Error("Persistent paths must be absolute and below /data");
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  if (!!env.OMP_MODEL_PROVIDER !== !!env.OMP_MODEL_ID) throw new Error("Configure both OMP_MODEL_PROVIDER and OMP_MODEL_ID, or neither for GPT-6 discovery");
  const logLevel = env.LOG_LEVEL ?? "info";
  if (logLevel !== "error" && logLevel !== "info") throw new Error("LOG_LEVEL must be error or info");
  return { token, webhookSecret, webhookUrl, adminId, accessMode, guestAccess: guestAccess as Config["guestAccess"],
    agentDir, sessionsDir, databasePath, cwd: "/app/agent-workdir", modelProvider: env.OMP_MODEL_PROVIDER,
    modelId: env.OMP_MODEL_ID, port, logLevel, maxConcurrent: 2, maxPromptChars: 12000, turnTimeoutMs: 120000 };
}
