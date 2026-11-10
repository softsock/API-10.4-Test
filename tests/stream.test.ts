import { expect, test } from "bun:test";
import { Storage } from "../src/storage/index.ts";
import { StreamService, type TurnSession } from "../src/agent/stream-service.ts";

// keep cancellation tests deterministic without relying on provider network timing
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// emulate only the official text delta subscription contract and real cancellation ownership
function fakeSession() {
  const started = deferred<void>();
  const finish = deferred<void>();
  let delta: (text: string) => void = () => {};
  let aborted = 0;
  let disposed = 0;
  const session: TurnSession = {
    prompt: async (_text, onDelta) => { delta = onDelta; started.resolve(); await finish.promise; },
    abort: async () => { aborted++; finish.resolve(); },
    dispose: async () => { disposed++; },
  };
  return { session, started, finish, emit: (text: string) => delta(text), aborts: () => aborted, disposals: () => disposed };
}

test("stream accumulates deltas, throttles drafts and finalizes exactly once", async () => {
  const store = new Storage(":memory:");
  const conversation = store.getOrCreateConversation({ userId: 1, chatId: 1 });
  const fake = fakeSession();
  const drafts: { text?: string; draft_id: number; can_stop?: boolean }[] = [];
  const messages: string[] = [];
  const service = new StreamService(store, { sendMessageDraft: async draft => { drafts.push(draft); return true; } },
    async () => fake.session, async (_c, text) => { messages.push(text); }, 2, 10000, 20);
  const done = service.start(conversation, "hello")!;
  await fake.started.promise;
  expect(service.start(conversation, "overlap")).toBeNull();
  fake.emit("one"); fake.emit(" two"); fake.emit(" three");
  expect(drafts).toHaveLength(1);
  await Bun.sleep(45);
  expect(drafts).toHaveLength(2);
  expect(drafts[0].text).toBe("");
  expect(drafts[0].can_stop).toBe(true);
  expect(drafts[1].text).toBe("one two three");
  expect(new Set(drafts.map(draft => draft.draft_id)).size).toBe(1);
  fake.finish.resolve(); await done;
  expect(messages).toEqual(["one two three"]);
  expect(store.getGenerationByDraft(drafts[0].draft_id)?.status).toBe("completed");
  expect(fake.disposals()).toBe(1);
  store.close();
});

test("native stop binds exact chat, topic and draft and ignores late deltas", async () => {
  const store = new Storage(":memory:");
  const one = store.getOrCreateConversation({ userId: 1, chatId: 1, threadId: 7 });
  const two = store.getOrCreateConversation({ userId: 2, chatId: 2 });
  const first = fakeSession(); const second = fakeSession();
  const drafts: { draft_id: number; chat_id: number }[] = [];
  const messages: string[] = [];
  const service = new StreamService(store, { sendMessageDraft: async draft => { drafts.push(draft); return true; } },
    async c => c.id === one.id ? first.session : second.session, async (_c, text) => { messages.push(text); }, 2, 10000, 20);
  const doneOne = service.start(one, "one")!; const doneTwo = service.start(two, "two")!;
  await Promise.all([first.started.promise, second.started.promise]);
  const draftId = drafts.find(draft => draft.chat_id === 1)!.draft_id;
  expect(await service.stopDraft(2, 7, draftId)).toBe(false);
  expect(await service.stopDraft(1, undefined, draftId)).toBe(false);
  expect(await service.stopDraft(1, 7, draftId)).toBe(true);
  first.emit("late data"); await doneOne;
  expect(first.aborts()).toBe(1); expect(second.aborts()).toBe(0);
  expect(messages).toEqual([]);
  second.emit("safe"); second.finish.resolve(); await doneTwo;
  expect(messages).toEqual(["safe"]);
  expect(store.getGenerationByDraft(draftId)?.status).toBe("cancelled");
  store.close();
});

test("draft failure does not cancel model and shutdown disposes active sessions", async () => {
  const store = new Storage(":memory:");
  const c = store.getOrCreateConversation({ userId: 1, chatId: 1 });
  const fake = fakeSession();
  const service = new StreamService(store, { sendMessageDraft: async () => { throw new Error("offline"); } },
    async () => fake.session, async () => {}, 1, 10000, 20);
  const done = service.start(c, "test")!; await fake.started.promise;
  await Bun.sleep(1); expect(fake.aborts()).toBe(0);
  await service.shutdown(); await done;
  expect(fake.aborts()).toBe(1); expect(fake.disposals()).toBe(1);
  expect(service.start(c, "no")).toBeNull();
  store.close();
});

test("ambiguous final delivery failure is terminal and never retried", async () => {
  const store = new Storage(":memory:");
  const c = store.getOrCreateConversation({ userId: 1, chatId: 1 });
  const fake = fakeSession(); let sends = 0;
  const service = new StreamService(store, { sendMessageDraft: async () => true }, async () => fake.session,
    async () => { sends++; throw new Error("delivery unknown"); });
  const done = service.start(c, "test")!; await fake.started.promise;
  fake.emit("response"); fake.finish.resolve(); await done;
  expect(sends).toBe(1); expect(fake.disposals()).toBe(1);
  store.close();
});
