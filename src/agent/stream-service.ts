import { randomInt } from "node:crypto";
import type { Conversation, Generation, Storage } from "../storage/index.ts";
import { SessionReferenceError } from "./session-service.ts";
import type { TelegramApi } from "../telegram/api.ts";

// keep streaming independent of provider transport while retaining real cancellation and disposal
export interface TurnSession {
  prompt(text: string, onDelta: (text: string) => void): Promise<unknown>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

// reserve lifecycle state before opening omp so stop can win during slow session restoration
interface ActiveTurn {
  generation: Generation; conversation: Conversation; session?: TurnSession;
  text: string; cancelled: boolean; streaming: boolean; startedAt: number;
  timer?: ReturnType<typeof setInterval>; deadline?: ReturnType<typeof setTimeout>;
  draftController: AbortController; draftPending?: Promise<void>; lastDraft: string; done?: Promise<void>;
}

// provide widget status without inventing token usage or exposing private model configuration
export interface TurnStatus {
  status: "Idle" | "Thinking" | "Streaming" | "Completed" | "Stopped" | "Error";
  elapsedSeconds: number; operation: string;
}

// coordinate cancellation, throttled drafts and at-most-once final delivery for personal conversations
export class StreamService {
  private readonly active = new Map<string, ActiveTurn>();
  private closing = false;
  // reuse durable state transitions rather than trusting token or completion event ordering
  constructor(
    private readonly store: Storage,
    private readonly api: Pick<TelegramApi, "sendMessageDraft">,
    private readonly open: (conversation: Conversation) => Promise<TurnSession>,
    private readonly deliver: (conversation: Conversation, text: string) => Promise<void>,
    private readonly maxConcurrent = 2,
    private readonly timeoutMs = 120000,
    private readonly throttleMs = 1000,
    private readonly changed: (conversationId: string) => void = () => {},
  ) {}

  // refuse admission synchronously so concurrent messages cannot race before the first await
  start(conversation: Conversation, prompt: string, updateId: number | null = null): Promise<void> | null {
    if (this.closing || this.active.has(conversation.id) || this.store.getActiveGeneration(conversation.id) || this.active.size >= this.maxConcurrent) return null;
    let draftId: number;
    do { draftId = randomInt(1, 2147483647); } while (this.store.getGenerationByDraft(draftId));
    const turn: ActiveTurn = { generation: this.store.startGeneration(conversation.id, draftId, updateId), conversation,
      text: "", cancelled: false, streaming: false, startedAt: Date.now(), draftController: new AbortController(), lastDraft: "" };
    this.active.set(conversation.id, turn);
    this.changed(conversation.id);
    turn.done = this.run(turn, prompt);
    return turn.done;
  }

  // bound draft request concurrency and never let a temporary telegram outage abort the model
  private draft(turn: ActiveTurn, initial = false): void {
    if (turn.cancelled || turn.draftPending || (!initial && turn.text === turn.lastDraft)) return;
    let text = turn.text.slice(-4000);
    if (/^[\uDC00-\uDFFF]/.test(text)) text = text.slice(1);
    turn.lastDraft = turn.text;
    turn.draftPending = Promise.resolve().then(() => this.api.sendMessageDraft({ chat_id: Number(turn.conversation.chat_id),
      message_thread_id: turn.conversation.thread_id || undefined, draft_id: turn.generation.draft_id,
      text, can_stop: true, keep_on_stop: true }, turn.draftController.signal)).then(() => {}, () => {}).finally(() => { turn.draftPending = undefined; });
  }

  // drain all session writers before releasing the conversation to its next prompt
  private async run(turn: ActiveTurn, prompt: string): Promise<void> {
    try {
      this.draft(turn, true);
      turn.timer = setInterval(() => this.draft(turn), this.throttleMs);
      turn.deadline = setTimeout(() => { void this.stop(turn.conversation.id); }, this.timeoutMs);
      turn.session = await this.open(turn.conversation);
      if (turn.cancelled) { await turn.session.abort(); return; }
      await turn.session.prompt(prompt, delta => {
        if (turn.cancelled || this.store.getGeneration(turn.generation.id)?.status !== "running") return;
        if (!turn.streaming) { turn.streaming = true; this.changed(turn.conversation.id); }
        turn.text += delta;
        if (turn.text.length > 64000) {
          turn.text = turn.text.slice(0, 64000);
          void this.stop(turn.conversation.id);
        }
      });
      if (turn.timer) clearInterval(turn.timer);
      if (turn.deadline) clearTimeout(turn.deadline);
      turn.draftController.abort();
      await turn.draftPending;
      if (turn.cancelled || !this.store.beginFinalization(turn.generation.id)) return;
      await this.deliver(turn.conversation, turn.text || "The model returned no text.");
      this.store.finishGeneration(turn.generation.id, "completed");
    } catch (error) {
      const beforeFailure = this.store.getGeneration(turn.generation.id)?.status;
      const failed = this.store.finishGeneration(turn.generation.id, "failed", "generation_or_delivery_failed");
      if (failed) {
        console.error(JSON.stringify({ event: "generation_failed", generationId: turn.generation.id }));
        if (beforeFailure === "running") {
          const message = error instanceof SessionReferenceError
            ? "This conversation's saved session is missing, corrupted, incompatible, or incorrectly mapped. Restore a coordinated backup or use /reset to explicitly start over. History was not replaced."
            : "Generation failed before final delivery. Check /status and the configured model authentication, then send a new message to retry.";
          await this.deliver(turn.conversation, message).catch(() => {});
        }
      }
    } finally {
      if (turn.timer) clearInterval(turn.timer);
      if (turn.deadline) clearTimeout(turn.deadline);
      turn.draftController.abort();
      await turn.draftPending;
      try { await turn.session?.dispose(); }
      catch { console.error(JSON.stringify({ event: "session_dispose_failed", generationId: turn.generation.id })); }
      this.active.delete(turn.conversation.id);
      this.changed(turn.conversation.id);
    }
  }

  // atomically cancel only the selected conversation while ignoring all later provider events
  async stop(conversationId: string): Promise<boolean> {
    const turn = this.active.get(conversationId);
    if (!turn || !this.store.cancelGeneration(turn.generation.id, conversationId)) return false;
    turn.cancelled = true;
    turn.draftController.abort();
    this.changed(conversationId);
    if (turn.timer) clearInterval(turn.timer);
    if (turn.deadline) clearTimeout(turn.deadline);
    try { await turn.session?.abort(); }
    catch { console.error(JSON.stringify({ event: "abort_failed", generationId: turn.generation.id })); }
    return true;
  }

  // reject stale draft stop updates and cross-chat coordinates before invoking omp cancellation
  async stopDraft(chatId: number, threadId: number | undefined, draftId: number): Promise<boolean> {
    const generation = this.store.getGenerationByDraft(draftId);
    const conversation = generation && this.store.getConversation(generation.conversation_id);
    if (!conversation || conversation.chat_id !== String(chatId) || conversation.thread_id !== (threadId ?? 0)) return false;
    const active = this.active.get(conversation.id);
    if (active?.generation.id !== generation?.id) return false;
    return this.stop(conversation.id);
  }

  // expose only observed lifecycle information to authorized controls
  status(conversationId: string): TurnStatus {
    const turn = this.active.get(conversationId);
    if (!turn) {
      const latest = this.store.getLatestGeneration(conversationId);
      const status = !latest ? "Idle" : latest.status === "completed" ? "Completed" : latest.status === "cancelled" ? "Stopped" : "Error";
      return { status, elapsedSeconds: latest ? Math.floor(((latest.finished_at ?? Date.now()) - latest.started_at) / 1000) : 0,
        operation: status === "Error" ? "Previous turn failed or was interrupted; send a new message" : "Ready for a message" };
    }
    return { status: turn.cancelled ? "Stopped" : turn.streaming ? "Streaming" : "Thinking",
      elapsedSeconds: Math.floor((Date.now() - turn.startedAt) / 1000), operation: turn.cancelled ? "Cancelling" : "Generating response" };
  }

  // keep draining cancelled sessions fenced against reset until their last writer is disposed
  isActive(conversationId: string): boolean { return this.active.has(conversationId); }

  // account for private turns when applying the shared private and guest concurrency ceiling
  activeCount(): number { return this.active.size; }

  // prevent new work before cancelling and draining every session writer for shutdown
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.active.keys()].map(id => this.stop(id)));
    await Promise.all([...this.active.values()].map(turn => turn.done));
  }
}
