# Persistence and recovery

`src/storage/index.ts` exports `Storage`, using only `bun:sqlite`. Create one instance
for `/data/app.sqlite`; run `recoverInterrupted()` **once at process startup before
accepting work**, never while another runtime instance is active. Migrations run
transactionally using `PRAGMA user_version`; future versions and corrupt databases
fail closed. WAL, foreign keys, a busy timeout, and FULL synchronous commits are enabled.
Use one Railway replica and one volume. Session files remain OMP's responsibility.

## Integration contract

- `getOrCreateConversation({ userId, chatId, threadId? })` returns a stable row with
  snake_case fields. Missing thread IDs normalize to zero; identities include all
  three components. `getConversation(id)` retrieves without creation.
- `setSessionReference(conversationId, sessionId, absolutePath, expectedSessionId = null)`
  compares and swaps the existing reference. IDs and paths cannot belong to two
  conversations. Call only after the OMP file exists and its persistence flush has
  succeeded. If OMP changes its file/id, update both together using the previous ID.
- `resetSessionReference(conversationId)` refuses active work and detaches the old
  reference without deleting files. Callers must also coordinate cached session
  disposal and prevent overlapping new-session operations. Missing or incompatible
  files must cause an explicit error, not automatic reassignment of another file.
- `acceptUpdate(updateId, payload)` durably inserts JSON and returns false on a
  duplicate. Return HTTP success only after this commit. `getPendingUpdates(limit)`
  returns accepted but unclaimed updates in ID order; `claimUpdate(id)` atomically
  grants ownership. Only a successful claimant may perform external side effects.
  Call `finishUpdate(id, 'completed' | 'failed', errorCode?)` afterwards. Failed
  updates are terminal; a new user request is required to retry. No TTL pruning
  is performed, so old webhook IDs remain deduplicated. `countPendingUpdates()`
  counts only unclaimed pending rows for admission backpressure. The caller should
  check for an existing update ID and acknowledge duplicates before rejecting new
  updates at its configured pending limit (for example 1000). This method does not
  itself impose a limit; serialize check-and-accept in the single runtime.
- `startGeneration(conversationId, positiveUniqueDraftId, updateId?)` inserts a running
  generation; conflicts throw. Associate production generations with their claimed
  update ID. A given update can create at most one generation. There can only be
  one running/finalizing generation per conversation. Draft IDs are globally unique
  across restarts; callers should generate and retry a collision before starting OMP.
- `cancelGeneration(generationId, conversationId)` grants cancellation once while
  running. Only the successful caller should invoke OMP abort, stop timers, and
  discard late events. `getGenerationByDraft`, `getGeneration`, and
  `getActiveGeneration` resolve controls; authorization remains the handler's duty.
- `getLatestGeneration(conversationId)` returns the latest running or terminal
  generation, or null, with insertion order breaking equal start timestamps.
  Widgets can map completed to Completed, cancelled to Stopped, and failed or
  interrupted to Error. `getWidgets(conversationId)` lists all bound widget rows
  for generation-state refreshes; an unknown conversation returns an empty list.
- `beginFinalization(id)` grants one caller permission to send final Telegram output.
  Call **before** any final-message attempt. It fails after cancellation or restart.
  `finishGeneration(id, 'completed' | 'failed', errorCode?)` records the outcome;
  completed requires finalizing, and terminal states cannot be overwritten.
- `saveWidget(chatId, messageId, conversationId)` binds a message permanently;
  `getWidget` resolves ownership. `advanceWidgetRevision(chatId, messageId, expected)`
  compares and increments the revision. Handlers must verify the Telegram user's
  identity against the referenced conversation before performing any action.
- `close()` closes SQLite after workers and OMP sessions have stopped.

## Delivery ambiguity and restart policy

SQLite and the Telegram API cannot share a transaction. A crash after Telegram
accepts a message but before SQLite records completion makes delivery ambiguous.
The safe policy is **at-most-once final delivery attempts**, not guaranteed exactly
once delivery: startup marks running/finalizing generations and processing updates
interrupted and never automatically resends them. Pending updates were never
claimed and can safely be processed. Terminal, failed, and interrupted updates
cannot be claimed again. Explicit user retries are new update IDs.

A Telegram 429 that definitively rejected a request may be retried within the
same finalization owner using retry-after. Do not blindly retry network timeouts,
connection loss, or server errors with ambiguous acceptance. For multipart output,
a crash can leave only some parts delivered; do not replay earlier parts. This
tradeoff avoids duplicate final messages rather than claiming impossible atomic
Telegram/SQLite delivery.

## Inbox payload retention

`finishUpdate` atomically replaces payload JSON with `{}` on both completed and
failed updates. `recoverInterrupted` does the same for in-flight updates and also
scrubs older terminal rows left by previous application versions. Update IDs,
terminal statuses, timestamps, and error codes remain for deduplication and
operational diagnostics. Pending updates retain their payload until processed.
This applies to every update, including guest invocations, so guest participant
content is not retained in the logical terminal inbox. Error codes must be fixed
non-sensitive identifiers, never participant text or provider error dumps.

Logical removal is not secure physical erasure: previous bytes may remain in WAL
pages, free pages, volume snapshots, or older backups. Protect the volume and
backups, apply a retention policy, and do not claim immediate forensic erasure.

## Coordinated backup and restore

1. Enter maintenance mode: reject new webhook acceptance with a retryable HTTP
   response, stop inbox workers, and wait for in-flight handlers to exit.
2. Cancel active OMP turns and await cancellation. Flush each OMP SessionManager
   and dispose/close every session, surfacing persistence errors. OMP streaming
   partial text is not durable until a completed message is appended. Native file
   appends and flushes do not themselves promise fsync against power loss.
3. Close `Storage` and stop the service. With **all writers stopped**, copy the
   entire `/data` tree (including `app.sqlite`, any `-wal`/`-shm` files, `omp/agent`,
   `omp/sessions`, session artifacts, and content-addressed blobs) to a timestamped
   archive under `/data/backups` or an approved encrypted backup destination.
   Exclude the backups directory from its own archive. Never copy only JSONL files
   or only the main SQLite file while writers are running. Keep auth data private;
   backups may contain credentials and conversation content and must not enter git.
4. Restart the single service and run startup reconciliation. Record backup success
   only after the complete archive can be read and its checksum is recorded.
5. For restore, stop the service first, preserve the failed data separately, and
   restore SQLite and OMP files from the **same** backup. Preserve absolute paths
   and the stable project working directory. Start one instance, run recovery,
   validate referenced files, and test conversation resumption before reopening
   webhook processing. Do not merge independent snapshots or replay interrupted turns.

The storage tests verify metadata restart behavior, migration idempotence,
identity isolation, cross-connection uniqueness, update deduplication, widget
ownership, and cancellation/finalization races. Real OMP transcript restoration
and a production backup/restore rehearsal require integration verification.
