import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent";

// a narrow storage seam keeps tests offline without replacing the sdk persistence contract
export type CodexLoginAuth = Pick<AuthStorage, "close"> & {
  oauth: Pick<AuthStorage["oauth"], "login">;
  credentials: Pick<AuthStorage["credentials"], "reload">;
};

// terminal capabilities prevent device codes from reaching redirected output or application logs
export interface CodexLoginUI {
  inputIsTTY: boolean;
  outputIsTTY: boolean;
  write(text: string): void;
}

// explicit ownership and cancellation keep authentication separate from the running bot
export interface CodexLoginOptions {
  agentDir: string;
  ui: CodexLoginUI;
  signal?: AbortSignal;
  timeoutMs?: number;
  createAuth?: (path: string) => Promise<CodexLoginAuth>;
}

// private bot storage must never follow a developer credential directory or linked database
async function prepareCredentialPath(agentDir: string): Promise<string> {
  if (!agentDir.trim() || !isAbsolute(agentDir)) {
    throw new Error("OMP_AGENT_DIR must be an explicit absolute bot-owned directory.");
  }
  const directory = resolve(agentDir);
  const home = homedir();
  if (directory === "/" || directory === home || [".codex", ".omp", ".pi"].some(
    name => directory === join(home, name) || directory.startsWith(`${join(home, name)}/`),
  )) {
    throw new Error("Use a dedicated bot directory, not a personal agent credential directory.");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || await realpath(directory) !== directory ||
    (process.getuid && info.uid !== process.getuid())) {
    throw new Error("The bot credential directory must be owned by this user and must not use symlinks.");
  }
  await chmod(directory, 0o700);
  const path = join(directory, "agent.db");
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) {
      throw new Error("The bot credential database must be a private single-link file owned by this user.");
    }
    await file.chmod(0o600);
  } finally {
    await file.close();
  }
  return path;
}

// device oauth is the only accepted login flow and never requests operator secrets
export async function loginCodex(options: CodexLoginOptions): Promise<void> {
  const { ui } = options;
  if (!ui.inputIsTTY || !ui.outputIsTTY) {
    throw new Error("Codex login requires an interactive local terminal on stdin and stdout; do not redirect or log its output.");
  }
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid Codex login timeout.");
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : []),
  ]);
  signal.throwIfAborted();
  const path = await prepareCredentialPath(options.agentDir);
  signal.throwIfAborted();
  const auth = await (options.createAuth ?? AuthStorage.create)(path);
  try {
    await auth.credentials.reload();
    signal.throwIfAborted();
    const identity = await auth.oauth.login("openai-codex-device", {
      signal,
      // only the pinned device endpoint and short code belong on the operator terminal
      onAuth(info) {
        signal.throwIfAborted();
        if (info.url !== "https://auth.openai.com/codex/device" ||
          !/^Enter code: [A-Z0-9-]{4,32}$/i.test(info.instructions ?? "")) {
          throw new Error("Unexpected device authorization instructions.");
        }
        ui.write(`Open ${info.url} in your browser.\n${info.instructions}\n`);
      },
      // device login never needs passwords, pasted tokens, or masked terminal prompts
      async onPrompt() {
        throw new Error("Unexpected prompt rejected; complete Codex device login in your browser only.");
      },
      // sdk progress can contain a device code so only fixed nonsecret status is displayed
      onProgress() {
        signal.throwIfAborted();
        ui.write("Waiting for Codex subscription authorization…\n");
      },
    });
    signal.throwIfAborted();
    if (identity?.type !== "oauth") throw new Error("Codex subscription OAuth was not stored.");
    ui.write("Codex subscription OAuth saved in the bot credential database.\n");
  } catch {
    throw new Error(signal.aborted
      ? "Codex login cancelled or timed out; run the command again when ready."
      : "Codex subscription login failed; retry in a private local terminal. No passwords or tokens should be pasted here.");
  } finally {
    auth.close();
  }
}
