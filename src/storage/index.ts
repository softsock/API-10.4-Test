import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

// keep telegram identities lossless while accepting the api's numeric identifiers
export type TelegramId = string | number;

// distinguish private topics without treating an absent thread as a different identity
export interface ConversationIdentity {
  userId: TelegramId;
  chatId: TelegramId;
  threadId?: number;
}

// retain only session references because omp owns the actual transcript format
export interface Conversation {
  id: string;
  telegram_user_id: string;
  chat_id: string;
  thread_id: number;
  omp_session_id: string | null;
  omp_session_path: string | null;
  created_at: number;
  updated_at: number;
}

// reserve finalizing before telegram delivery to prevent ambiguous delivery retries
export type GenerationStatus = "running" | "finalizing" | "completed" | "cancelled" | "failed" | "interrupted";

// associate cancellation and delivery with exactly one conversation and draft
export interface Generation {
  id: string;
  conversation_id: string;
  draft_id: number;
  update_id: number | null;
  status: GenerationStatus;
  started_at: number;
  finished_at: number | null;
  error_code: string | null;
}

// interrupted and failed updates require an explicit new user request rather than automatic replay
export type UpdateStatus = "pending" | "processing" | "completed" | "failed" | "interrupted";

// preserve accepted webhook payloads until asynchronous processing can claim them
export interface StoredUpdate {
  update_id: number;
  payload: unknown;
  status: UpdateStatus;
  processed_at: number;
  error_code: string | null;
}

// bind widget controls to their owning conversation instead of trusting client state
export interface WidgetMessage {
  chat_id: string;
  message_id: number;
  conversation_id: string;
  revision: number;
  updated_at: number;
}

// validate identifiers before coercion can collapse distinct or imprecise identities
function telegramId(value: TelegramId): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Invalid Telegram identifier");
  const text = String(value);
  if (!/^-?[1-9]\d*$/.test(text)) throw new Error("Invalid Telegram identifier");
  return BigInt(text).toString();
}

// reject invalid api integers before they can enter persistence constraints
function safeInteger(value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error("Invalid integer");
  return value;
}

// keep all durable invariants in sqlite so independent asynchronous callers cannot bypass them
const migration = `
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL DEFAULT 0 CHECK(thread_id >= 0),
  omp_session_id TEXT UNIQUE,
  omp_session_path TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(telegram_user_id, chat_id, thread_id),
  CHECK((omp_session_id IS NULL) = (omp_session_path IS NULL))
) STRICT;
CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY CHECK(update_id >= 0),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  status TEXT NOT NULL CHECK(status IN ('pending','processing','completed','failed','interrupted')),
  processed_at INTEGER NOT NULL,
  error_code TEXT
) STRICT;
CREATE TABLE generations (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  draft_id INTEGER NOT NULL UNIQUE CHECK(draft_id > 0),
  update_id INTEGER UNIQUE REFERENCES processed_updates(update_id),
  status TEXT NOT NULL CHECK(status IN ('running','finalizing','completed','cancelled','failed','interrupted')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_code TEXT
) STRICT;
CREATE UNIQUE INDEX one_active_generation ON generations(conversation_id)
  WHERE status IN ('running','finalizing');
CREATE INDEX pending_updates ON processed_updates(status, update_id);
CREATE TABLE widget_messages (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL CHECK(message_id > 0),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(chat_id, message_id)
) STRICT;
PRAGMA user_version = 1;
`;

// centralize the single-instance durable state without taking ownership of omp session files
export class Storage {
  private readonly db: Database;

  // make new and existing databases ready before any webhook can be accepted
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      this.db.transaction(() => {
        const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
        if (version > 1) throw new Error(`Unsupported database schema version ${version}`);
        if (version === 0) this.db.exec(migration);
      }).immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  // atomically normalize absent topics and prevent concurrent creation of duplicate identities
  getOrCreateConversation(identity: ConversationIdentity): Conversation {
    const user = telegramId(identity.userId);
    const chat = telegramId(identity.chatId);
    const thread = safeInteger(identity.threadId ?? 0, 0);
    const now = Date.now();
    this.db.query(`INSERT INTO conversations
      (id, telegram_user_id, chat_id, thread_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(telegram_user_id, chat_id, thread_id) DO NOTHING`)
      .run(crypto.randomUUID(), user, chat, thread, now, now);
    return this.db.query("SELECT * FROM conversations WHERE telegram_user_id = ? AND chat_id = ? AND thread_id = ?")
      .get(user, chat, thread) as Conversation;
  }

  // support authorization and session reopening without creating an unrelated conversation
  getConversation(id: string): Conversation | null {
    return this.db.query("SELECT * FROM conversations WHERE id = ?").get(id) as Conversation | null;
  }

  // attach a materialized omp session only if the caller still owns the expected reference
  setSessionReference(conversationId: string, sessionId: string, path: string, expectedSessionId: string | null = null): boolean {
    if (!sessionId || !isAbsolute(path)) throw new Error("Session reference requires an id and absolute path");
    return this.db.query(`UPDATE conversations SET omp_session_id = ?, omp_session_path = ?, updated_at = ?
      WHERE id = ? AND omp_session_id IS ?`).run(sessionId, path, Date.now(), conversationId, expectedSessionId).changes === 1;
  }

  // refuse resets during generation and leave old files intact for coordinated retention or recovery
  resetSessionReference(conversationId: string): boolean {
    return this.db.query(`UPDATE conversations SET omp_session_id = NULL, omp_session_path = NULL, updated_at = ?
      WHERE id = ? AND NOT EXISTS (SELECT 1 FROM generations WHERE conversation_id = ? AND status IN ('running','finalizing'))`)
      .run(Date.now(), conversationId, conversationId).changes === 1;
  }

  // reserve a conversation before model work and reject already consumed webhook updates
  startGeneration(conversationId: string, draftId: number, updateId: number | null = null): Generation {
    safeInteger(draftId, 1);
    if (updateId !== null) safeInteger(updateId, 0);
    const id = crypto.randomUUID();
    const inserted = this.db.query(`INSERT INTO generations (id, conversation_id, draft_id, update_id, status, started_at)
      SELECT ?, ?, ?, ?, 'running', ? WHERE ? IS NULL OR EXISTS
      (SELECT 1 FROM processed_updates WHERE update_id = ? AND status = 'processing')`)
      .run(id, conversationId, draftId, updateId, Date.now(), updateId, updateId).changes;
    if (inserted !== 1) throw new Error("Generation requires a claimed update");
    return this.getGeneration(id)!;
  }

  // resolve late events against durable state instead of whichever turn is currently active
  getGeneration(id: string): Generation | null {
    return this.db.query("SELECT * FROM generations WHERE id = ?").get(id) as Generation | null;
  }

  // bind native telegram stop events to the exact draft and owner conversation
  getGenerationByDraft(draftId: number): Generation | null {
    return this.db.query("SELECT * FROM generations WHERE draft_id = ?").get(draftId) as Generation | null;
  }

  // let controls identify the single generation protected by the active-generation index
  getActiveGeneration(conversationId: string): Generation | null {
    return this.db.query("SELECT * FROM generations WHERE conversation_id = ? AND status IN ('running','finalizing')")
      .get(conversationId) as Generation | null;
  }

  // let widgets retain the last terminal status after active work has ended
  getLatestGeneration(conversationId: string): Generation | null {
    return this.db.query("SELECT * FROM generations WHERE conversation_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(conversationId) as Generation | null;
  }

  // let cancellation win only before final delivery has been reserved
  cancelGeneration(id: string, conversationId: string): boolean {
    return this.db.query(`UPDATE generations SET status = 'cancelled', finished_at = ?
      WHERE id = ? AND conversation_id = ? AND status = 'running'`).run(Date.now(), id, conversationId).changes === 1;
  }

  // grant exactly one caller permission to attempt persistent telegram delivery
  beginFinalization(id: string): boolean {
    return this.db.query("UPDATE generations SET status = 'finalizing' WHERE id = ? AND status = 'running'").run(id).changes === 1;
  }

  // prevent late completion or errors from overwriting a cancellation or interrupted turn
  finishGeneration(id: string, status: "completed" | "failed", errorCode: string | null = null): boolean {
    const expected = status === "completed" ? "status = 'finalizing'" : "status IN ('running','finalizing')";
    return this.db.query(`UPDATE generations SET status = ?, finished_at = ?, error_code = ? WHERE id = ? AND ${expected}`)
      .run(status, Date.now(), errorCode, id).changes === 1;
  }

  // durably acknowledge webhook delivery once while retaining the original accepted payload
  acceptUpdate(updateId: number, payload: unknown): boolean {
    safeInteger(updateId, 0);
    const json = JSON.stringify(payload);
    if (json === undefined) throw new Error("Update payload must be JSON serializable");
    return this.db.query(`INSERT INTO processed_updates(update_id, payload, status, processed_at)
      VALUES (?, ?, 'pending', ?) ON CONFLICT(update_id) DO NOTHING`).run(updateId, json, Date.now()).changes === 1;
  }

  // expose only unclaimed updates so failed or ambiguous side effects are never replayed automatically
  getPendingUpdates(limit = 100): StoredUpdate[] {
    safeInteger(limit, 1);
    const rows = this.db.query(`SELECT * FROM processed_updates WHERE status = 'pending' ORDER BY CASE WHEN
      json_type(payload, '$.widget_query') IS NOT NULL OR json_type(payload, '$.callback_query') IS NOT NULL OR
      json_type(payload, '$.stopped_message_generation') IS NOT NULL OR
      json_extract(payload, '$.message.text') LIKE '/stop%' THEN 0 ELSE 1 END, update_id LIMIT ?`)
      .all(limit) as Array<Omit<StoredUpdate, "payload"> & { payload: string }>;
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown }));
  }

  // let webhook admission apply backpressure without counting already claimed or terminal work
  countPendingUpdates(): number {
    return (this.db.query("SELECT count(*) AS count FROM processed_updates WHERE status = 'pending'")
      .get() as { count: number }).count;
  }

  // allow one asynchronous worker to own each accepted update
  claimUpdate(updateId: number): boolean {
    return this.db.query("UPDATE processed_updates SET status = 'processing', processed_at = ? WHERE update_id = ? AND status = 'pending'")
      .run(Date.now(), updateId).changes === 1;
  }

  // preserve terminal update states so retries cannot trigger external side effects twice
  finishUpdate(updateId: number, status: "completed" | "failed", errorCode: string | null = null): boolean {
    return this.db.query(`UPDATE processed_updates SET payload = '{}', status = ?, processed_at = ?, error_code = ?
      WHERE update_id = ? AND status = 'processing'`).run(status, Date.now(), errorCode, updateId).changes === 1;
  }

  // make durable webhook processing outcomes available for diagnostics without exposing them to chat users
  getUpdate(updateId: number): StoredUpdate | null {
    const row = this.db.query("SELECT * FROM processed_updates WHERE update_id = ?").get(updateId) as
      (Omit<StoredUpdate, "payload"> & { payload: string }) | null;
    return row ? { ...row, payload: JSON.parse(row.payload) as unknown } : null;
  }

  // fence ambiguous work after a restart while leaving untouched inbox items eligible for processing
  recoverInterrupted(): { generations: number; updates: number } {
    return this.db.transaction(() => {
      const now = Date.now();
      const generations = this.db.query(`UPDATE generations SET status = 'interrupted', finished_at = ?, error_code = 'process_restart'
        WHERE status IN ('running','finalizing')`).run(now).changes;
      const updates = this.db.query(`UPDATE processed_updates SET payload = '{}', status = 'interrupted', processed_at = ?, error_code = 'process_restart'
        WHERE status = 'processing'`).run(now).changes;
      this.db.query("UPDATE processed_updates SET payload = '{}' WHERE status IN ('completed','failed','interrupted') AND payload != '{}'").run();
      return { generations, updates };
    }).immediate();
  }

  // refuse to reassign an existing message to another conversation even when caller state is stale
  saveWidget(chatId: TelegramId, messageId: number, conversationId: string): WidgetMessage {
    const chat = telegramId(chatId);
    safeInteger(messageId, 1);
    const conversation = this.getConversation(conversationId);
    if (!conversation || conversation.chat_id !== chat) throw new Error("Widget chat does not match conversation");
    this.db.query(`INSERT INTO widget_messages(chat_id, message_id, conversation_id, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(chat_id, message_id) DO NOTHING`).run(chat, messageId, conversationId, Date.now());
    const widget = this.getWidget(chat, messageId)!;
    if (widget.conversation_id !== conversationId) throw new Error("Widget already belongs to another conversation");
    return widget;
  }

  // resolve widget ownership from trusted metadata rather than a user-supplied widget payload
  getWidget(chatId: TelegramId, messageId: number): WidgetMessage | null {
    return this.db.query("SELECT * FROM widget_messages WHERE chat_id = ? AND message_id = ?")
      .get(telegramId(chatId), messageId) as WidgetMessage | null;
  }

  // refresh every widget bound to a conversation when its generation state changes
  getWidgets(conversationId: string): WidgetMessage[] {
    return this.db.query("SELECT * FROM widget_messages WHERE conversation_id = ? ORDER BY chat_id, message_id")
      .all(conversationId) as WidgetMessage[];
  }

  // remove only a definitively missing widget so recreation cannot accumulate stale refresh targets
  deleteWidget(chatId: TelegramId, messageId: number): void {
    this.db.query("DELETE FROM widget_messages WHERE chat_id = ? AND message_id = ?").run(telegramId(chatId), messageId);
  }

  // reject stale widget mutations so concurrent controls cannot overwrite a newer state
  advanceWidgetRevision(chatId: TelegramId, messageId: number, expectedRevision: number): boolean {
    return this.db.query(`UPDATE widget_messages SET revision = revision + 1, updated_at = ?
      WHERE chat_id = ? AND message_id = ? AND revision = ?`)
      .run(Date.now(), telegramId(chatId), messageId, expectedRevision).changes === 1;
  }

  // drain sqlite state only after callers have stopped all workers and omp session writers
  close(): void {
    this.db.close();
  }
}
