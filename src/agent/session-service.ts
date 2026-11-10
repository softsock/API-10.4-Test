import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  CURRENT_SESSION_VERSION,
  parseSessionContent,
  SessionManager,
} from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { conversationalSettings, type ModelRuntime } from "./model-service";

// stored references bind each transcript to one application conversation rather than a shared cache
export interface SessionReference {
  sessionId: string;
  sessionPath: string;
}

// reference persistence must finish before any prompt can create billable or durable user content
export interface ConversationSession {
  id: string;
  sessionId?: string | null;
  sessionPath?: string | null;
  onReference?: (reference: SessionReference) => Promise<void> | void;
}

// explicit paths keep transcripts and the working directory stable across deployments
export interface AgentSessionConfig extends Pick<ModelRuntime, "model" | "authStorage" | "modelRegistry"> {
  agentDir: string;
  sessionDir: string;
  cwd: string;
}

// handles own one disposable sdk session and never expose filesystem or tool capabilities
export interface SessionHandle {
  sessionId: string;
  sessionPath: string | undefined;
  toolNames: readonly string[];
  prompt(text: string, onDelta: (delta: string) => void): Promise<string>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

// mapping failures require an explicit operator or user reset instead of silently losing history
export class SessionReferenceError extends Error {
  // a stable public error avoids leaking transcript content through restoration diagnostics
  constructor() {
    super("Conversation session is missing, corrupted, incompatible, or incorrectly mapped. Restore its backup or explicitly reset this conversation; history was not replaced.");
    this.name = "SessionReferenceError";
  }
}

// strict validation prevents the sdk's permissive loader from silently repairing a wrong transcript
async function validateReference(reference: SessionReference, ownerId: string, directory: string, cwd: string): Promise<void> {
  try {
    const actualPath = await realpath(reference.sessionPath);
    if (dirname(actualPath) !== await realpath(directory)) throw new SessionReferenceError();
    const parsed = parseSessionContent(await readFile(actualPath, "utf8"));
    const header = parsed.entries[0];
    if (parsed.invalidHeader || parsed.malformedRecords || !header || header.type !== "session" ||
        header.id !== reference.sessionId || header.version !== CURRENT_SESSION_VERSION || resolve(header.cwd) !== cwd) {
      throw new SessionReferenceError();
    }
    const bindings = parsed.entries.filter((entry) => entry.type === "custom" && entry.customType === "telegram-conversation");
    if (bindings.length !== 1 || bindings[0]?.type !== "custom" ||
        typeof bindings[0].data !== "object" || bindings[0].data === null ||
        !("conversationId" in bindings[0].data) || bindings[0].data.conversationId !== ownerId) {
      throw new SessionReferenceError();
    }
  } catch {
    throw new SessionReferenceError();
  }
}

// per-conversation admission and private registries isolate concurrent users without retaining idle sessions
export class AgentSessionService {
  readonly #config: AgentSessionConfig;
  readonly #active = new Set<string>();

  // one configured authenticated model is shared without sharing any conversation runtime
  constructor(config: AgentSessionConfig) {
    this.#config = config;
  }

  // private sessions are file backed while guest turns deliberately have no persistent transcript
  async open(conversation: ConversationSession, ephemeral = false): Promise<SessionHandle> {
    if (this.#active.has(conversation.id)) throw new Error("This conversation is busy; wait for its active generation or stop it first.");
    this.#active.add(conversation.id);
    let manager: SessionManager | undefined;
    let session: AgentSession | undefined;
    try {
      const config = this.#config;
      await mkdir(config.cwd, { recursive: true });
      const cwd = await realpath(config.cwd);
      if (ephemeral) {
        manager = SessionManager.inMemory(cwd);
      } else {
        if (Boolean(conversation.sessionId) !== Boolean(conversation.sessionPath)) throw new SessionReferenceError();
        const owner = createHash("sha256").update(conversation.id).digest("hex");
        const directory = join(resolve(config.sessionDir), owner);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (conversation.sessionId && conversation.sessionPath) {
          await validateReference({ sessionId: conversation.sessionId, sessionPath: conversation.sessionPath }, conversation.id, directory, cwd);
          manager = await SessionManager.open(conversation.sessionPath, directory, undefined, { initialCwd: cwd, throwIfMissing: true, suppressBreadcrumb: true });
          if (manager.getSessionId() !== conversation.sessionId) throw new SessionReferenceError();
        } else {
          manager = SessionManager.create(cwd, directory);
          manager.appendCustomEntry("telegram-conversation", { conversationId: conversation.id });
          await manager.ensureOnDisk();
          await manager.flush();
        }
      }
      const created = await createAgentSession({
        cwd,
        agentDir: config.agentDir,
        authStorage: config.authStorage,
        modelRegistry: config.modelRegistry,
        model: config.model,
        sessionManager: manager,
        settings: conversationalSettings(),
        agentRegistry: new AgentRegistry(),
        bindProcessState: false,
        toolNames: [],
        restrictToolNames: true,
        customTools: [],
        preloadedCustomToolPaths: [],
        extensions: [],
        additionalExtensionPaths: [],
        preloadedExtensionPaths: [],
        disableExtensionDiscovery: true,
        enableMCP: false,
        enableLsp: false,
        enableIrc: false,
        skipPythonPreflight: true,
        skills: [],
        rules: [],
        contextFiles: [],
        noContextFiles: true,
        promptTemplates: [],
        slashCommands: [],
        autoTitle: false,
        cacheWarming: false,
        suppressAutoPrewalk: true,
        disableModelFallback: true,
        // model routing must remain pinned even if the sdk acquires new fallback behavior
        assertDispatchModel: (model) => {
          if (model.provider !== config.model.provider || model.id !== config.model.id) {
            throw new Error("OMP attempted to dispatch an unconfigured model; request refused.");
          }
        },
        disableServerSideFallback: true,
        allowSessionModelFallback: false,
        interactivePrompts: false,
        hasUI: false,
      });
      session = created.session;
      if (session.getActiveToolNames().length !== 0) throw new Error("OMP unexpectedly enabled tools; refusing this session.");
      if (!ephemeral) {
        await manager.flush();
        await conversation.onReference?.({ sessionId: manager.getSessionId(), sessionPath: manager.getSessionFile()! });
      }
      return new OmpSessionHandle(session, manager, () => this.#active.delete(conversation.id));
    } catch (error) {
      try {
        if (session) await session.dispose();
        else await manager?.close();
      } finally {
        this.#active.delete(conversation.id);
      }
      throw error;
    }
  }
}

// cancellation is latched before awaiting the sdk so late tokens can never escape a stopped handle
class OmpSessionHandle implements SessionHandle {
  readonly sessionId: string;
  readonly sessionPath: string | undefined;
  readonly toolNames: readonly string[];
  readonly #session: AgentSession;
  readonly #manager: SessionManager;
  readonly #release: () => void;
  #cancelled = false;
  #started = false;
  #disposed = false;
  #disposePromise?: Promise<void>;

  // each handle owns its sdk resources until terminal disposal releases conversation admission
  constructor(session: AgentSession, manager: SessionManager, release: () => void) {
    this.#session = session;
    this.#manager = manager;
    this.#release = release;
    this.sessionId = manager.getSessionId();
    this.sessionPath = manager.getSessionFile();
    this.toolNames = Object.freeze(session.getActiveToolNames());
  }

  // only official text deltas are forwarded and the transcript is flushed before completion
  async prompt(text: string, onDelta: (delta: string) => void): Promise<string> {
    if (this.#disposed || this.#cancelled || this.#started) throw new Error("This OMP turn is already started, stopped, or disposed.");
    this.#started = true;
    let result = "";
    let failed = false;
    const unsubscribe = this.#session.subscribe((event) => {
      if (this.#cancelled || this.#disposed) return;
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        result += event.assistantMessageEvent.delta;
        onDelta(event.assistantMessageEvent.delta);
      }
      if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") failed = true;
    });
    try {
      await this.#session.prompt(text, { expandPromptTemplates: false, runCommands: false });
      if (failed && !this.#cancelled) throw new Error("OMP provider failed to complete the response.");
      return result;
    } finally {
      unsubscribe();
      await this.#manager.flush();
    }
  }

  // aborting one handle cannot reach another conversation's registry or pending tokens
  async abort(): Promise<void> {
    if (this.#disposed || this.#cancelled) return;
    this.#cancelled = true;
    await this.#session.abort();
    await this.#manager.flush();
  }

  // idempotent teardown releases the conversation even when persistence reports a failure
  dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  // terminal disposal blocks late delivery before shutting down sdk resources
  async #dispose(): Promise<void> {
    this.#disposed = true;
    this.#cancelled = true;
    try {
      await this.#session.abort();
    } finally {
      try {
        await this.#session.dispose();
      } finally {
        this.#release();
      }
    }
  }
}
