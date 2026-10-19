# StormCLI live Markdown agent — implementation contract

**Status:** implementation in progress. The initial local CLI and live-document integration are implemented on `feature/stormcli-foundation`; this is a partial build, not a completed or GUI-accepted MVP. Shared protocol types are in [`src/shared/agentProtocol.ts`](../src/shared/agentProtocol.ts). This first slice is append-only; it does not promise arbitrary range edits, full-document replacement, concurrent human typing in the target editor, or stale-version rebasing.

## User-visible contract

- CLI targets one absolute `.md` file inside a registered vault. Connect reads its current content (including unsaved editor content) and returns it. If the file does not exist, Storm creates an empty file through its coordinated vault write path; a missing parent directory is an error. Never overwrite an existing file at connect.
- Appends reach the open CodeMirror document and Markdown/Mermaid preview live, in batches, without GUI typing. Writes continue while the user switches tabs/vaults; the session remains bound to the original canonical vault/path.
- While agent writes are active, lock actual CodeMirror text input and show a visually transparent blocking overlay on that editor. Preview checkboxes stay interactive; other notes remain editable. Stop is visible, connected, and writing only. Status is **Connected** while active, not Idle. The status bar remains visible after Stop, completion, or disconnection until the user hides it with that note’s toolbar toggle.
- One Storm-owned save path coordinates editor and agent updates and protects against optimistic disk-revision conflicts. Live acceptance and disk persistence are distinct states. Do not add renderer or CLI direct writes.
- A note tab bound to a connected or writing agent session cannot be closed until that session is stopped, finished, disconnected, or failed. This applies only to that vault/path; other tabs remain closable. Stop still permits closing after cancellation, and accepted changes are retained and undoable. Storm can report cancellation to the CLI; it cannot claim to kill an arbitrary external process.
- Operation sequence IDs are idempotent. Bound queue and operation size; apply backpressure/reject clearly instead of unbounded buffering. Disconnect is safe: accepted work remains, pending work is settled explicitly.

## MVP commands

```text
storm connect /absolute/path/to/note.md --json
storm stream SESSION --stdin
storm status [SESSION] --json
storm finish SESSION
storm cancel SESSION
```

`connect` returns session ID, current document contents, document version, disk revision and state; it errors if Storm cannot serve the note safely. `stream` consumes UTF-8 append chunks in order and finishes writing at stdin EOF (unless cancelled/disconnected); each chunk has a stable sequence/operation ID and receives an acknowledgement. `status` reports connected/writing/finished/cancelled/disconnected/failed distinctly. `finish` stops writes normally; `cancel` closes write capability and notifies the CLI. Accepted text is not rolled back. No global install/build or dependency addition in this foundation; initial development invocation should reuse the repository's existing Bun/Node tooling.

## State and integration boundaries

Keep separate: CLI client connection/liveness, writing operation, document session, in-memory document version, and persisted disk revision. Session identity is bound to the canonical vault/path, not active tab. Sequence/version numbers increase monotonically per session. Duplicate operation IDs return their original result without reapplying; gaps/out-of-order IDs, unknown sessions, oversized writes, full queues, stopped sessions and disk conflicts have explicit errors. Queue limit is 64 pending operations/session; append limit 256 KiB; JSON frame limit 1 MiB. These initial bounds are explicit and can be tuned with tests, never silently bypassed.

Shared request/response unions are the narrow boundary; the local endpoint is private per-user IPC, not TCP. Main process authenticates local Storm, validates protocol/frame, canonical absolute path, `.md` extension, registered vault membership, symlink/path containment, file existence/creation and conflicts before effects. Never expose arbitrary filesystem access. Exact endpoint mechanics are an implementation choice for main-process owner (prefer OS-protected Unix-domain socket on macOS/Linux and an equivalent per-user named pipe on Windows, if supported); no unauthenticated listener.

Main process brokers CLI messages to the renderer's document controller through a narrow preload bridge. The renderer/editor remains authority for live CodeMirror text and undo history. Its controller resolves the note by canonical identity even when inactive, applies append transactions as remote-origin changes without feedback loops, and sends snapshots/change acknowledgements back to broker. Main/vault save service is the only disk writer; it reconciles accepted editor changes with the existing optimistic revision/write-barrier behavior. Do not invent CRDT/OT, general concurrent text merge, cloud/offline/MCP/headless modes, or a second save path in this MVP.

### Shared API contract

- `connect(absolutePath)` → `{sessionId, absolutePath, content, documentVersion, diskRevision, state}`; read current editor buffer when open, otherwise read through vault service. Create only the missing file, not parent directories.
- `append(sessionId, operationId, sequence, text)` → `{documentVersion, saveState}` only after the editor transaction is accepted. Sequence/ID are per session; duplicate returns prior acknowledgement. Queue-full and validation failures do not mutate document.
- `finish(sessionId)` / `cancel(sessionId)` → final status; cancel rejects future writes and settles queued writes, retains accepted edits.
- `status(sessionId?)` → status snapshots; disconnect settles in-flight work and preserves accepted edits.
- Renderer document controller must provide stable-document lookup, current snapshot/revision, apply-append transaction, external-write lock state and close/cancel notification; do not put filesystem access in renderer.

## Parallel implementation ownership (after foundation)

1. **Main broker + CLI worker:** own new CLI entrypoint/package command and `src/main/agentBroker.ts` plus IPC/transport registration and `src/preload.ts` bridge declarations only. Implement protocol validation, private transport, path/vault validation, bounded/idempotent session/queue state, command parsing/output. Coordinate exact interfaces with editor and vault workers; no editor component or vault-service edits.
2. **Renderer/editor worker:** own new `src/components/Editor/AgentDocumentController.ts` (+ tests), targeted `Editor.tsx` integration, and per-note agent status/locking UI. Implement live buffer snapshot/appends, editor input lock + transparent blocker, checkbox interaction, preview updates, undoable remote transactions, background-tab lifetime and guarded close behavior. No transport, CLI, vault disk writes.
3. **Vault persistence/tests worker:** own `src/vault/agentNoteService.ts` (+ tests) and narrowly scoped vault save/revision tests. Reuse vault resolver, write barrier and coordinated persistence; create file only when parent exists, reject conflicts; report disk revision/save state. No UI, CLI transport or parallel writer.

The shared protocol file and this design are foundation-owned; downstream workers import it and coordinate changes rather than redefining types. Main broker must not claim an append accepted until renderer has applied it; save pending/failure remains distinct from live acceptance. Integration tests should be added after interfaces land, with one owner assigned to avoid overlapping files.

## Verification/acceptance

Initial implementation verification: `bun test`, `pnpm typecheck`, and `pnpm lint` pass in the worktree. Runtime-verified with the development CLI: connect creates a fresh note under a registered vault, streams Markdown/tasks/Mermaid content and saves on stdin EOF, and controlled chunks append correctly; missing parent directories reject. These checks do not establish GUI behavior. Checkbox interaction, lock/overlay behavior, tab-background Stop/state updates, and close cancellation/flush remain pending hands-on GUI verification.

Before calling the MVP complete, also exercise app running/stopped, existing and missing note/parent, open unsaved note, tab switch, Mermaid preview, checkbox click, Stop/cancel/close, reconnect/duplicate, queue saturation, disconnection, external disk modification and save failure. Verify accepted content survives and rejected writes do not mutate it.
