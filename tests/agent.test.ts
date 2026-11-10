import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
} from "@oh-my-pi/pi-ai";
import { AuthStorage, ModelRegistry, parseSessionContent, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { Storage } from "../src/storage/index.ts";
import { assertModelAuthentication, conversationalSettings, resolveModel, selectGpt6Model, selectModelForAuthMode, type ModelRuntime } from "../src/agent/model-service";
import { AgentSessionService, SessionReferenceError, type SessionHandle, type SessionReference } from "../src/agent/session-service";

// provider fixtures exercise the real sdk without relying on external credentials or network requests
interface Fixture {
  directory: string;
  runtime: ModelRuntime;
  service: AgentSessionService;
  requests: Context[];
  aborted: () => number;
  restart: () => AgentSessionService;
}

const cleanups: Array<() => Promise<void>> = [];

// temporary credential stores and transcripts must not outlive their test cases
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// valid assistant fixtures make official streaming and persistence paths run without a real llm
function message(text: string): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "telegram-test-api",
    provider: "telegram-test", model: "fixture-only", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

// only transport is simulated while auth storage, registry, sessions, events and cancellation stay real
async function fixture(mode: "complete" | "wait" | "error" = "complete"): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "telegram-omp-test-"));
  const agentDir = join(directory, "agent");
  const cwd = join(directory, "work");
  await mkdir(agentDir);
  await mkdir(cwd);
  const authStorage = await AuthStorage.create(join(agentDir, "agent.db"));
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"), {
    ignoreLocalModelConfig: true, settings: conversationalSettings(), cacheDbPath: join(agentDir, "models.db"),
  });
  const requests: Context[] = [];
  let aborts = 0;
  modelRegistry.registerProvider("telegram-test", {
    api: "telegram-test-api", apiKey: "fixture-key-not-a-credential", baseUrl: "https://test.invalid",
    models: [{ id: "fixture-only", name: "GPT-6", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    // a controllable transport makes late events and abort propagation observable without mocking omp
    streamSimple: (_model, context, options) => {
      requests.push(structuredClone(context));
      const stream = createAssistantMessageEventStream();
      const partial = message("");
      queueMicrotask(() => {
        stream.push({ type: "start", partial });
        stream.push({ type: "text_start", contentIndex: 0, partial });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "Hello ", partial: message("Hello ") });
        if (mode === "wait") {
          options?.signal?.addEventListener("abort", () => {
            aborts++;
            stream.push({ type: "text_delta", contentIndex: 0, delta: "LATE TOKEN", partial: message("Hello LATE TOKEN") });
            stream.push({ type: "error", reason: "aborted", error: { ...message("Hello "), stopReason: "aborted" } });
          }, { once: true });
        } else if (mode === "error") {
          stream.push({ type: "error", reason: "error", error: { ...message(""), stopReason: "error", errorMessage: "fixture failure" } });
        } else {
          stream.push({ type: "text_delta", contentIndex: 0, delta: "world", partial: message("Hello world") });
          stream.push({ type: "text_end", contentIndex: 0, content: "Hello world", partial: message("Hello world") });
          stream.push({ type: "done", reason: "stop", message: message("Hello world") });
        }
      });
      return stream;
    },
  });
  authStorage.keys.setRuntime("telegram-test", "fixture-key-not-a-credential");
  const model = modelRegistry.find("telegram-test", "fixture-only")!;
  const runtime: ModelRuntime = { authMode: "api", model, modelRegistry, authStorage, dispose: () => authStorage.close() };
  const config = { ...runtime, agentDir, sessionDir: join(directory, "sessions"), cwd };
  cleanups.push(async () => { runtime.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { directory, runtime, service: new AgentSessionService(config), requests, aborted: () => aborts,
    restart: () => new AgentSessionService(config) };
}

// failed assertions must still dispose active sdk sessions before removing their transcript directories
function track(handle: SessionHandle): SessionHandle {
  cleanups.push(() => handle.dispose());
  return handle;
}

describe("authenticated GPT-6 model selection", () => {
  // catalog selection keeps the real provider and opaque model identifier intact
  test("discovers an authenticated exact GPT-6 entry through the real registry", async () => {
    const { runtime } = await fixture();
    expect(selectGpt6Model(runtime.modelRegistry.getAvailableForProviders(new Set(["telegram-test"])))).toBe(runtime.model);
    expect(selectGpt6Model(runtime.modelRegistry.getAvailableForProviders(new Set(["telegram-test"])), "telegram-test", "fixture-only").id).toBe("fixture-only");
  });

  // unavailable credentials must never cause an implicit model downgrade
  test("rejects missing GPT-6, non-GPT-6 selectors, partial selectors, and ambiguous providers", async () => {
    const { runtime } = await fixture();
    expect(() => selectGpt6Model([])).toThrow("No authenticated GPT-6");
    expect(() => selectGpt6Model([{ ...runtime.model, id: "gpt-6-mini", name: "GPT-6 Mini" }])).toThrow("No authenticated GPT-6");
    expect(() => selectGpt6Model([runtime.model], "telegram-test")).toThrow("Set both");
    expect(() => selectGpt6Model([runtime.model], "other", "fixture-only")).toThrow("unavailable or unauthenticated");
    expect(() => selectGpt6Model([runtime.model, { ...runtime.model, provider: "other" }])).toThrow("Multiple authenticated");
  });
});

describe("real OMP session lifecycle", () => {
  // a fresh file must exist before metadata advertises it even when no assistant has replied
  test("persists the reference before prompting and resumes an empty session", async () => {
    const { service, restart, requests } = await fixture();
    let reference: SessionReference | undefined;
    const first = track(await service.open({ id: "owner:private:topic", onReference: async (value) => {
      expect(await readFile(value.sessionPath, "utf8")).toContain("telegram-conversation");
      expect(requests).toHaveLength(0);
      reference = value;
    } }));
    expect(first.toolNames).toEqual([]);
    await first.dispose();
    const restored = track(await restart().open({ id: "owner:private:topic", ...reference }));
    expect(restored.sessionId).toBe(first.sessionId);
  });

  // a completed file-backed conversation must reach the next sdk runtime with its previous messages
  test("streams official deltas and restores the completed conversation context", async () => {
    const { service, restart, requests } = await fixture();
    const first = track(await service.open({ id: "alice:private:topic" }));
    const deltas: string[] = [];
    expect(await first.prompt("Remember my blue bicycle", (delta) => deltas.push(delta))).toBe("Hello world");
    expect(deltas).toEqual(["Hello ", "world"]);
    const reference = { sessionId: first.sessionId, sessionPath: first.sessionPath! };
    await first.dispose();
    const second = track(await restart().open({ id: "alice:private:topic", ...reference }));
    await second.prompt("What did I ask you to remember?", () => {});
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Remember my blue bicycle");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Hello world");
    expect(requests.every((request) => !request.tools?.length)).toBe(true);
  });

  // a new operating-system process must reopen the native transcript without any cached session state
  test("reopens a completed transcript in a separate Bun process", async () => {
    const { service } = await fixture();
    const handle = track(await service.open({ id: "process-restart" }));
    await handle.prompt("cross-process continuity fixture", () => {});
    await handle.dispose();
    const child = Bun.spawn([process.execPath, "-e", `
      import { SessionManager } from "@oh-my-pi/pi-coding-agent";
      const [path, id] = Bun.argv.slice(-2);
      const manager = await SessionManager.open(path, undefined, undefined, { throwIfMissing: true });
      if (manager.getSessionId() !== id || !JSON.stringify(manager.getEntries()).includes("cross-process continuity fixture")) {
        throw new Error("session continuity failed");
      }
      await manager.close();
      console.log("restored");
    `, handle.sessionPath!, handle.sessionId], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout.trim()).toBe("restored");
  });

  // identities and private registries must isolate users and topics even while both handles remain open
  test("supports concurrent isolated conversations but rejects duplicate admission", async () => {
    const { service, requests } = await fixture();
    const alice = track(await service.open({ id: "alice:private:topic1" }));
    await expect(service.open({ id: "alice:private:topic1" })).rejects.toThrow("busy");
    const bob = track(await service.open({ id: "bob:private:topic1" }));
    const topic = track(await service.open({ id: "alice:private:topic2" }));
    expect(new Set([alice.sessionId, bob.sessionId, topic.sessionId]).size).toBe(3);
    await Promise.all([alice.prompt("ALICE SECRET", () => {}), bob.prompt("BOB SECRET", () => {})]);
    const aliceRequest = requests.find((request) => JSON.stringify(request.messages).includes("ALICE SECRET"));
    const bobRequest = requests.find((request) => JSON.stringify(request.messages).includes("BOB SECRET"));
    expect(JSON.stringify(aliceRequest)).not.toContain("BOB SECRET");
    expect(JSON.stringify(bobRequest)).not.toContain("ALICE SECRET");
    expect(alice.toolNames).toEqual([]);
    expect(bob.toolNames).toEqual([]);
  });

  // all ambient discovery paths that could expose instructions or tools must be pinned off
  test("does not load ambient skills, context, prompts, commands, extensions or tools", async () => {
    const { service, directory, requests } = await fixture();
    await writeFile(join(directory, "work", "AGENTS.md"), "AMBIENT-CONTEXT-SECRET");
    await mkdir(join(directory, "agent", "extensions"));
    await writeFile(join(directory, "agent", "extensions", "unsafe.ts"), 'throw new Error("AMBIENT EXTENSION EXECUTED")');
    await mkdir(join(directory, "agent", "prompts"));
    await writeFile(join(directory, "agent", "prompts", "unsafe.md"), "AMBIENT-PROMPT-SECRET");
    const handle = track(await service.open({ id: "owner" }));
    await handle.prompt("/unsafe", () => {});
    expect(handle.toolNames).toEqual([]);
    expect(requests[0]?.tools ?? []).toEqual([]);
    expect(JSON.stringify(requests[0])).not.toContain("AMBIENT-");
    expect(JSON.stringify(requests[0]?.messages)).toContain("/unsafe");
  });

  // abort must cancel the provider signal and discard a maliciously late text delta
  test("propagates cancellation without affecting another session and ignores late tokens", async () => {
    const { service, aborted } = await fixture("wait");
    const first = track(await service.open({ id: "alice" }));
    const second = track(await service.open({ id: "bob" }));
    const firstText: string[] = [];
    const secondText: string[] = [];
    const firstDelta = Promise.withResolvers<void>();
    const secondDelta = Promise.withResolvers<void>();
    const firstPrompt = first.prompt("slow alice", (delta) => { firstText.push(delta); firstDelta.resolve(); });
    const secondPrompt = second.prompt("slow bob", (delta) => { secondText.push(delta); secondDelta.resolve(); });
    await Promise.all([firstDelta.promise, secondDelta.promise]);
    await first.abort();
    expect(aborted()).toBe(1);
    expect(firstText).toEqual(["Hello "]);
    expect(secondText).toEqual(["Hello "]);
    expect(await firstPrompt).toBe("Hello ");
    await second.abort();
    await secondPrompt;
    expect(aborted()).toBe(2);
    await expect(first.prompt("resume without reopening", () => {})).rejects.toThrow("already started");
    await first.dispose();
    const manager = await SessionManager.open(first.sessionPath!, undefined, undefined, { throwIfMissing: true });
    expect(manager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "aborted")).toBe(true);
    await manager.close();
  });

  // graceful shutdown must drain a live provider and release admission without losing its safe transcript
  test("disposes an active turn and permits restoration by a fresh service", async () => {
    const { service, restart, aborted } = await fixture("wait");
    const handle = track(await service.open({ id: "shutdown-owner" }));
    const started = Promise.withResolvers<void>();
    const result = handle.prompt("long request", () => started.resolve());
    await started.promise;
    await handle.dispose();
    await result;
    expect(aborted()).toBe(1);
    const restored = track(await restart().open({ id: "shutdown-owner", sessionId: handle.sessionId, sessionPath: handle.sessionPath! }));
    expect(restored.sessionId).toBe(handle.sessionId);
  });

  // provider failures must not be incorrectly reported as a successful final response
  test("surfaces provider errors instead of finalizing partial text as success", async () => {
    const { service } = await fixture("error");
    const handle = track(await service.open({ id: "owner" }));
    await expect(handle.prompt("fail", () => {})).rejects.toThrow("OMP provider failed");
  });

  // missing or mismatched references must not mint replacement sessions or attach another user's history
  test("fails closed on wrong owner, missing files, malformed files, incompatible versions and bad ids", async () => {
    const { service, restart } = await fixture();
    const handle = track(await service.open({ id: "alice" }));
    const reference = { sessionId: handle.sessionId, sessionPath: handle.sessionPath! };
    await handle.dispose();
    await expect(restart().open({ id: "bob", ...reference })).rejects.toBeInstanceOf(SessionReferenceError);
    await expect(restart().open({ id: "alice", sessionId: reference.sessionId })).rejects.toBeInstanceOf(SessionReferenceError);
    await expect(restart().open({ id: "alice", ...reference, sessionId: "wrong-id" })).rejects.toBeInstanceOf(SessionReferenceError);
    const original = await readFile(reference.sessionPath, "utf8");
    await writeFile(reference.sessionPath, original.replace('"conversationId":"alice"', '"conversationId":"bob"'));
    await expect(restart().open({ id: "alice", ...reference })).rejects.toBeInstanceOf(SessionReferenceError);
    await writeFile(reference.sessionPath, `${original}\n{"invalid"`);
    await expect(restart().open({ id: "alice", ...reference })).rejects.toBeInstanceOf(SessionReferenceError);
    await writeFile(reference.sessionPath, original.replace('"version":3', '"version":999'));
    await expect(restart().open({ id: "alice", ...reference })).rejects.toBeInstanceOf(SessionReferenceError);
    await rm(reference.sessionPath);
    await expect(restart().open({ id: "alice", ...reference })).rejects.toBeInstanceOf(SessionReferenceError);
  });

  // a reference callback failure must release admission while preventing any model work
  test("releases resources when metadata persistence fails", async () => {
    const { service, requests } = await fixture();
    await expect(service.open({ id: "alice", onReference: () => { throw new Error("database unavailable"); } })).rejects.toThrow("database unavailable");
    expect(requests).toHaveLength(0);
    track(await service.open({ id: "alice" }));
  });

  // guest content must never produce a file-backed transcript or a durable conversation reference
  test("keeps ephemeral guest turns out of persistent session files", async () => {
    const { service, directory } = await fixture();
    let saved = false;
    const handle = track(await service.open({ id: "guest", onReference: () => { saved = true; } }, true));
    await handle.prompt("guest participants' content", () => {});
    expect(handle.sessionPath).toBeUndefined();
    expect(saved).toBe(false);
    expect(await Bun.file(join(directory, "sessions")).exists()).toBe(false);
  });

  // ownership metadata remains visible to the official parser for backup and recovery tooling
  test("writes an explicit application ownership marker", async () => {
    const { service } = await fixture();
    const handle = track(await service.open({ id: "alice:chat:123" }));
    const parsed = parseSessionContent(await readFile(handle.sessionPath!, "utf8"));
    expect(parsed.invalidHeader).toBe(false);
    expect(parsed.malformedRecords).toBe(0);
    expect(parsed.entries.some((entry) => entry.type === "custom" && entry.customType === "telegram-conversation")).toBe(true);
  });
});

// application restart must restore the sqlite identity mapping and the native omp transcript together
test("restores conversation metadata and completed context across an application restart", async () => {
  const { directory, service, restart, requests } = await fixture();
  const path = join(directory, "application.sqlite");
  let store = new Storage(path);
  try {
    const conversation = store.getOrCreateConversation({ userId: 42, chatId: 42, threadId: 7 });
    const handle = track(await service.open({ id: conversation.id, onReference: reference => {
      expect(store.setSessionReference(conversation.id, reference.sessionId, reference.sessionPath)).toBe(true);
    } }));
    await handle.prompt("remember the silver bicycle", () => {});
    await handle.dispose(); store.close();
    store = new Storage(path); store.recoverInterrupted();
    const restored = store.getOrCreateConversation({ userId: 42, chatId: 42, threadId: 7 });
    expect(restored.id).toBe(conversation.id);
    const next = track(await restart().open({ id: restored.id, sessionId: restored.omp_session_id, sessionPath: restored.omp_session_path }));
    await next.prompt("what did I ask you to remember", () => {});
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("remember the silver bicycle");
    await next.dispose();
  } finally { store.close(); }
});

// subscription mode must select the real codex transport even when an api-key model is also authenticated
test("Codex selection never falls back to an API provider or an incompatible transport", async () => {
  const { runtime } = await fixture();
  const codex = { ...runtime.model, provider: "openai-codex", api: "openai-codex-responses" as const, id: "fixture-codex-id" };
  expect(selectModelForAuthMode([runtime.model, codex], "codex")).toBe(codex);
  expect(selectModelForAuthMode([runtime.model, codex], "api")).toBe(runtime.model);
  expect(selectModelForAuthMode([codex], "codex", "openai-codex", "fixture-codex-id")).toBe(codex);
  expect(() => selectModelForAuthMode([runtime.model], "codex")).toThrow("No authenticated GPT-6");
  expect(() => selectModelForAuthMode([{ ...codex, name: "GPT-6 Mini" }], "codex")).toThrow("No authenticated GPT-6");
  expect(() => selectModelForAuthMode([{ ...codex, api: "openai-responses" }], "codex")).toThrow("No authenticated GPT-6");
  expect(() => selectModelForAuthMode([codex], "api", "openai-codex", "fixture-codex-id")).toThrow("OMP_AUTH_MODE=codex");
  expect(() => selectModelForAuthMode([runtime.model], "codex", "telegram-test", "fixture-only")).toThrow("explicit OMP_AUTH_MODE=api");
});

// oauth grants must remain oauth after storage reload and api overrides must not masquerade as a subscription
test("Codex authentication requires stored OAuth and rejects static or overridden keys", async () => {
  const { runtime, directory } = await fixture();
  const path = join(directory, "codex-auth.db");
  let auth = await AuthStorage.create(path);
  try {
    expect(() => assertModelAuthentication(auth, "codex", "openai-codex")).toThrow("login:codex");
    await auth.credentials.set("openai-codex", { type: "api_key", key: "fixture-static-not-a-credential" });
    expect(() => assertModelAuthentication(auth, "codex", "openai-codex")).toThrow("no API fallback");
    await auth.credentials.set("openai-codex", { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600000 });
    expect(() => assertModelAuthentication(auth, "codex", "openai-codex")).not.toThrow();
    auth.close(); auth = await AuthStorage.create(path);
    await auth.credentials.reload();
    expect(() => assertModelAuthentication(auth, "codex", "openai-codex")).not.toThrow();
    expect(() => assertModelAuthentication(auth, "api", "openai-codex")).toThrow("subscription OAuth");
    auth.keys.setRuntime("openai-codex", "fixture-override");
    expect(() => assertModelAuthentication(auth, "codex", "openai-codex")).toThrow("no API fallback");
    auth.keys.removeRuntime("openai-codex");
    expect(() => assertModelAuthentication(auth, "codex", "telegram-test")).toThrow();
    expect(() => assertModelAuthentication(runtime.authStorage, "api", "telegram-test")).not.toThrow();
    await auth.credentials.set("oauth-only", { type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 3600000 });
    expect(() => assertModelAuthentication(auth, "api", "oauth-only")).toThrow("API-key provider");
  } finally { auth.close(); }
});

// a missing subscription must fail before discovery can consider any api-key credential as a substitute
test("default model resolution gives actionable Codex login instructions without authenticating another provider", async () => {
  const { directory } = await fixture();
  await expect(resolveModel({ agentDir: join(directory, "unconfigured-codex") })).rejects.toThrow("login:codex");
  await expect(resolveModel({ agentDir: join(directory, "wrong-route"), provider: "openai", modelId: "gpt-6" })).rejects.toThrow("OMP_AUTH_MODE=api");
});

// runtime credential changes must be checked again when an existing session is used for a prompt
test("session creation refuses an authentication route that no longer matches its configured mode", async () => {
  const { runtime, directory } = await fixture();
  const service = new AgentSessionService({ ...runtime, authMode: "codex", agentDir: join(directory, "agent"),
    sessionDir: join(directory, "sessions"), cwd: directory });
  await expect(service.open({ id: "wrong-billing-route" })).rejects.toThrow("Codex subscription OAuth");
});
