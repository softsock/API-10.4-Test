import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/storage";

// track temporary state so every test leaves sqlite handles and files closed
const resources: Array<{ directory: string; stores: Storage[] }> = [];

// make restart tests use actual files rather than sqlite's transient memory mode
function fixture(): { path: string; open: () => Storage } {
  const directory = mkdtempSync(join(tmpdir(), "telegram-storage-"));
  const stores: Storage[] = [];
  resources.push({ directory, stores });
  return {
    path: join(directory, "app.sqlite"),
    open: () => {
      const store = new Storage(join(directory, "app.sqlite"));
      stores.push(store);
      return store;
    },
  };
}

// close readers before deleting files so test cleanup never hides leaked database locks
afterEach(() => {
  for (const { directory, stores } of resources.splice(0)) {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// prove migrations remain idempotent and database constraints survive a second connection
test("fresh migration creates all entities and refuses future schema versions", () => {
  const f = fixture();
  const store = f.open();
  store.getOrCreateConversation({ userId: 1, chatId: 1 });
  const raw = new Database(f.path);
  expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
  expect(raw.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toHaveLength(4);
  expect(f.open().getOrCreateConversation({ userId: 1, chatId: 1 }).telegram_user_id).toBe("1");
  raw.exec("PRAGMA user_version = 2");
  raw.close();
  expect(() => f.open()).toThrow("Unsupported database schema version 2");
});

// prevent history from crossing user, chat, or topic boundaries
test("conversation identities isolate every identity component and normalize no topic", () => {
  const store = fixture().open();
  const a = store.getOrCreateConversation({ userId: 1, chatId: 1 });
  expect(store.getOrCreateConversation({ userId: "1", chatId: "1", threadId: 0 }).id).toBe(a.id);
  const ids = [a.id,
    store.getOrCreateConversation({ userId: 2, chatId: 1 }).id,
    store.getOrCreateConversation({ userId: 1, chatId: 2 }).id,
    store.getOrCreateConversation({ userId: 1, chatId: 1, threadId: 3 }).id];
  expect(new Set(ids).size).toBe(4);
  expect(() => store.getOrCreateConversation({ userId: Number.MAX_SAFE_INTEGER + 1, chatId: 1 })).toThrow();
  expect(() => store.getOrCreateConversation({ userId: 1, chatId: 1, threadId: -1 })).toThrow();
});

// preserve exact omp references across restart while refusing cross-conversation reuse
test("session references persist and update through compare-and-set", () => {
  const f = fixture();
  const store = f.open();
  const a = store.getOrCreateConversation({ userId: 1, chatId: 1 });
  const b = store.getOrCreateConversation({ userId: 2, chatId: 2 });
  expect(store.setSessionReference(a.id, "session-a", "/data/omp/sessions/a.jsonl")).toBe(true);
  expect(store.setSessionReference(a.id, "stale", "/data/omp/sessions/stale.jsonl")).toBe(false);
  expect(() => store.setSessionReference(b.id, "session-a", "/data/omp/sessions/a.jsonl")).toThrow();
  store.close();
  const reopened = f.open();
  expect(reopened.getConversation(a.id)?.omp_session_path).toBe("/data/omp/sessions/a.jsonl");
  expect(reopened.getConversation(b.id)?.omp_session_path).toBeNull();
  expect(reopened.setSessionReference(a.id, "replacement", "/data/omp/sessions/new.jsonl", "session-a")).toBe(true);
  expect(() => reopened.setSessionReference(a.id, "bad", "relative.jsonl", "replacement")).toThrow();
});

// enforce one active model operation per conversation at the database boundary
test("generation concurrency and draft uniqueness survive competing connections", () => {
  const f = fixture();
  const first = f.open();
  const second = f.open();
  const a = first.getOrCreateConversation({ userId: 1, chatId: 1 });
  const b = first.getOrCreateConversation({ userId: 2, chatId: 2 });
  const generation = first.startGeneration(a.id, 101);
  expect(() => second.startGeneration(a.id, 102)).toThrow();
  expect(() => second.startGeneration(b.id, 101)).toThrow();
  expect(() => first.startGeneration(b.id, 0)).toThrow();
  expect(second.startGeneration(b.id, 103).conversation_id).toBe(b.id);
  expect(first.getGenerationByDraft(101)?.id).toBe(generation.id);
  expect(first.resetSessionReference(a.id)).toBe(false);
});

// make a native stop incapable of cancelling another user's generation
test("cancellation wins once and late completion cannot deliver", () => {
  const store = fixture().open();
  const a = store.getOrCreateConversation({ userId: 1, chatId: 1 });
  const b = store.getOrCreateConversation({ userId: 2, chatId: 2 });
  const generation = store.startGeneration(a.id, 101);
  expect(store.cancelGeneration(generation.id, b.id)).toBe(false);
  expect(store.cancelGeneration(generation.id, a.id)).toBe(true);
  expect(store.cancelGeneration(generation.id, a.id)).toBe(false);
  expect(store.beginFinalization(generation.id)).toBe(false);
  expect(store.finishGeneration(generation.id, "completed")).toBe(false);
  expect(store.finishGeneration(generation.id, "failed")).toBe(false);
  expect(store.getGeneration(generation.id)?.status).toBe("cancelled");
  expect(store.resetSessionReference(a.id)).toBe(true);
});

// let only the caller that reserved finalization send persistent telegram messages
test("finalization wins its race with cancellation and is not repeatable", () => {
  const store = fixture().open();
  const a = store.getOrCreateConversation({ userId: 1, chatId: 1 });
  const generation = store.startGeneration(a.id, 101);
  expect(store.finishGeneration(generation.id, "completed")).toBe(false);
  expect(store.beginFinalization(generation.id)).toBe(true);
  expect(store.beginFinalization(generation.id)).toBe(false);
  expect(store.cancelGeneration(generation.id, a.id)).toBe(false);
  expect(store.finishGeneration(generation.id, "completed")).toBe(true);
  expect(store.finishGeneration(generation.id, "completed")).toBe(false);
  expect(store.getActiveGeneration(a.id)).toBeNull();
  expect(store.startGeneration(a.id, 102).status).toBe("running");
});

// atomically claiming webhook updates prevents duplicate work even before generation starts
test("durable inbox deduplicates payloads and claims with competing workers", () => {
  const f = fixture();
  const store = f.open();
  const second = f.open();
  expect(store.acceptUpdate(5, { text: "first" })).toBe(true);
  expect(second.acceptUpdate(5, { text: "replacement" })).toBe(false);
  expect(second.getPendingUpdates()[0]?.payload).toEqual({ text: "first" });
  expect(store.claimUpdate(5)).toBe(true);
  expect(second.claimUpdate(5)).toBe(false);
  expect(store.finishUpdate(5, "completed")).toBe(true);
  expect(store.finishUpdate(5, "failed")).toBe(false);
  expect(second.getPendingUpdates()).toEqual([]);
  expect(() => store.acceptUpdate(6, undefined)).toThrow();
});

// require a claimed update and permanently associate it with its first generation
test("failed updates and consumed generation updates cannot be retried", () => {
  const store = fixture().open();
  const a = store.getOrCreateConversation({ userId: 1, chatId: 1 });
  store.acceptUpdate(1, { text: "prompt" });
  expect(() => store.startGeneration(a.id, 101, 1)).toThrow("claimed update");
  store.claimUpdate(1);
  const generation = store.startGeneration(a.id, 101, 1);
  store.finishGeneration(generation.id, "failed", "provider_failure");
  expect(() => store.startGeneration(a.id, 102, 1)).toThrow();
  expect(store.finishUpdate(1, "failed", "provider_failure")).toBe(true);
  expect(store.claimUpdate(1)).toBe(false);
  expect(store.acceptUpdate(1, {})).toBe(false);
  expect(store.getUpdate(1)?.error_code).toBe("provider_failure");
});

// fence both running and delivery-ambiguous work after restart without losing untouched updates
test("restart interrupts in-flight work and never replays a possible final delivery", () => {
  const f = fixture();
  const store = f.open();
  const a = store.getOrCreateConversation({ userId: 1, chatId: 1 });
  const b = store.getOrCreateConversation({ userId: 2, chatId: 2 });
  store.acceptUpdate(1, { text: "running" });
  store.acceptUpdate(2, { text: "possibly delivered" });
  store.acceptUpdate(3, { text: "not started" });
  store.claimUpdate(1);
  store.claimUpdate(2);
  const running = store.startGeneration(a.id, 101, 1);
  const delivering = store.startGeneration(b.id, 102, 2);
  store.beginFinalization(delivering.id);
  store.close();
  const restarted = f.open();
  expect(restarted.recoverInterrupted()).toEqual({ generations: 2, updates: 2 });
  expect(restarted.recoverInterrupted()).toEqual({ generations: 0, updates: 0 });
  expect(restarted.getGeneration(running.id)?.status).toBe("interrupted");
  expect(restarted.getGeneration(delivering.id)?.error_code).toBe("process_restart");
  expect(restarted.beginFinalization(delivering.id)).toBe(false);
  expect(restarted.claimUpdate(2)).toBe(false);
  expect(restarted.acceptUpdate(2, {})).toBe(false);
  expect(restarted.getPendingUpdates().map((update) => update.update_id)).toEqual([3]);
  expect(restarted.claimUpdate(3)).toBe(true);
  expect(restarted.getActiveGeneration(a.id)).toBeNull();
});

// retain completed conversation references and deduplication markers through application restarts
test("completed conversations survive restart without being interrupted", () => {
  const f = fixture();
  const store = f.open();
  const a = store.getOrCreateConversation({ userId: 1, chatId: 1 });
  store.setSessionReference(a.id, "session-a", "/data/omp/sessions/a.jsonl");
  store.acceptUpdate(1, { text: "hello" });
  store.claimUpdate(1);
  const generation = store.startGeneration(a.id, 101, 1);
  store.beginFinalization(generation.id);
  store.finishGeneration(generation.id, "completed");
  store.finishUpdate(1, "completed");
  store.close();
  const restarted = f.open();
  expect(restarted.recoverInterrupted()).toEqual({ generations: 0, updates: 0 });
  expect(restarted.getOrCreateConversation({ userId: 1, chatId: 1 }).omp_session_id).toBe("session-a");
  expect(restarted.getGeneration(generation.id)?.status).toBe("completed");
  expect(restarted.acceptUpdate(1, {})).toBe(false);
});

// bind message controls to immutable conversation ownership and monotonically increasing revisions
test("widget references persist and reject stale revisions or ownership changes", () => {
  const f = fixture();
  const store = f.open();
  const a = store.getOrCreateConversation({ userId: 1, chatId: 1 });
  const b = store.getOrCreateConversation({ userId: 2, chatId: 1 });
  expect(store.saveWidget(1, 10, a.id).revision).toBe(0);
  expect(store.advanceWidgetRevision(1, 10, 0)).toBe(true);
  expect(store.advanceWidgetRevision(1, 10, 0)).toBe(false);
  expect(store.saveWidget(1, 10, a.id).revision).toBe(1);
  expect(() => store.saveWidget(1, 10, b.id)).toThrow("another conversation");
  expect(() => store.saveWidget(2, 20, a.id)).toThrow("does not match");
  store.close();
  expect(f.open().getWidget(1, 10)?.conversation_id).toBe(a.id);
});

// surface corrupt metadata explicitly instead of silently recreating unrelated session ownership
test("corrupted databases fail closed", () => {
  const f = fixture();
  writeFileSync(f.path, "not a sqlite database");
  expect(() => f.open()).toThrow();
});

// retain completed stopped and error states for widget refresh after generation has ended
test("latest generation and widget lists are isolated and deterministic for timestamp ties", () => {
  const f = fixture();
  const store = f.open();
  const a = store.getOrCreateConversation({ userId: 1, chatId: 1 });
  const b = store.getOrCreateConversation({ userId: 2, chatId: 2 });
  expect(store.getLatestGeneration(a.id)).toBeNull();
  expect(store.getWidgets(a.id)).toEqual([]);
  const first = store.startGeneration(a.id, 101);
  store.beginFinalization(first.id);
  store.finishGeneration(first.id, "completed");
  const second = store.startGeneration(a.id, 102);
  store.cancelGeneration(second.id, a.id);
  const third = store.startGeneration(a.id, 103);
  store.finishGeneration(third.id, "failed", "provider_error");
  const raw = new Database(f.path);
  raw.query("UPDATE generations SET started_at = 1 WHERE conversation_id = ?").run(a.id);
  raw.close();
  expect(store.getLatestGeneration(a.id)?.id).toBe(third.id);
  expect(store.getLatestGeneration(a.id)?.status).toBe("failed");
  expect(store.getLatestGeneration(b.id)).toBeNull();
  store.saveWidget(1, 20, a.id);
  store.saveWidget(1, 10, a.id);
  store.saveWidget(2, 30, b.id);
  expect(store.getWidgets(a.id).map((widget) => widget.message_id)).toEqual([10, 20]);
  store.close();
  expect(f.open().getLatestGeneration(a.id)?.id).toBe(third.id);
});

// make a bounded inbox admission decision without sacrificing duplicate acknowledgement
test("pending update count excludes processing and terminal rows", () => {
  const store = fixture().open();
  expect(store.countPendingUpdates()).toBe(0);
  store.acceptUpdate(1, { guest_message: { text: "private" } });
  store.acceptUpdate(2, {});
  expect(store.countPendingUpdates()).toBe(2);
  expect(store.acceptUpdate(1, {})).toBe(false);
  expect(store.countPendingUpdates()).toBe(2);
  store.claimUpdate(1);
  expect(store.countPendingUpdates()).toBe(1);
  store.finishUpdate(1, "completed");
  expect(store.countPendingUpdates()).toBe(1);
});

// prevent guest participant content from remaining in terminal inbox records after success or failure
test("terminal update payloads are purged while deduplication and outcome metadata remain", () => {
  const f = fixture();
  const store = f.open();
  store.acceptUpdate(1, { guest_message: { text: "successful guest" } });
  store.acceptUpdate(2, { guest_message: { text: "failed guest" } });
  store.acceptUpdate(3, { guest_message: { text: "interrupted guest" } });
  store.acceptUpdate(4, { guest_message: { text: "pending guest" } });
  store.claimUpdate(1);
  store.claimUpdate(2);
  store.claimUpdate(3);
  store.finishUpdate(1, "completed");
  store.finishUpdate(2, "failed", "timeout");
  expect(store.getUpdate(1)?.payload).toEqual({});
  expect(store.getUpdate(2)?.payload).toEqual({});
  expect(store.getUpdate(2)?.error_code).toBe("timeout");
  store.close();
  const restarted = f.open();
  restarted.recoverInterrupted();
  expect(restarted.getUpdate(3)?.payload).toEqual({});
  expect(restarted.getUpdate(3)?.status).toBe("interrupted");
  expect(restarted.getUpdate(4)?.payload).toEqual({ guest_message: { text: "pending guest" } });
  expect(restarted.acceptUpdate(1, { text: "redelivery" })).toBe(false);
  expect(restarted.getUpdate(1)?.payload).toEqual({});
  const raw = new Database(f.path);
  raw.query("UPDATE processed_updates SET payload = ? WHERE update_id = 1").run('{"legacy":"guest content"}');
  raw.close();
  restarted.recoverInterrupted();
  expect(restarted.getUpdate(1)?.payload).toEqual({});
});

test("deadline-sensitive controls are claimed ahead of normal message backlog", () => {
  const store = new Storage(":memory:");
  try {
    store.acceptUpdate(1, { update_id: 1, message: { text: "generate" } });
    store.acceptUpdate(2, { update_id: 2, widget_query: { id: "widget" } });
    store.acceptUpdate(3, { update_id: 3, message: { text: "/stop" } });
    expect(store.getPendingUpdates().map(item => item.update_id)).toEqual([2, 3, 1]);
  } finally { store.close(); }
});
