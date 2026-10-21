# Storm CLI live-note contract

**Status:** implemented in the current feature worktree; not yet verified in the installed packaged executable or GUI acceptance. This is the implemented contract, not a promise of deferred features.

## Commands

```text
storm inspect ABS_PATH --json
storm connect ABS_PATH --json [--name NAME]
storm stream SESSION --stdin
storm replace SESSION --expected-version N --stdin [--dry-run] [--json] [--operation-id ID]
storm patch SESSION --expected-version N --stdin [--dry-run] [--json] [--operation-id ID]
storm status [SESSION] [--json]
storm finish SESSION
storm cancel SESSION
```

In this worktree use `bun scripts/storm.ts`; help is also available with `bun scripts/storm.ts [command] --help`. The official installed binary is not installed here. The app must be running and the path must be inside a registered vault. Endpoint metadata contains a private token: never expose it.

`inspect` is read-only, requires an existing `.md` file, and neither opens a tab nor creates a session/file. For an open editor note, it returns live `content`, `documentVersion`, `diskRevision`, and `saveState`; otherwise it returns disk `content` and `diskRevision`, with no live version. `connect` opens an existing note or creates an empty missing `.md` file only if its parent exists; it does not replace existing content. Its JSON contains `session.sessionId`, session `documentVersion` / `diskRevision`, and content. Use connect for writing and retain one writer session; finish or cancel it when done.

`stream` forwards UTF-8 stdin in order as append operations; EOF finishes automatically. It remains useful for append workflows and stdin backpressure, but is not a reveal API and must not be paced to control preview animation. Append acknowledgements indicate live-editor acceptance, not disk persistence. Check `saveState` / status. Accepted content is not rolled back by cancellation or disconnect; cancellation does not terminate an external agent.

## Native preview presentation (worktree implementation)

Source text acceptance and saving are immediate and independent of preview presentation. The preview may reveal identified pure insertions after acceptance; targeted corrections are immediate. The current bounded 250,000-cell diff conservatively skips reveal for ambiguous or oversized rewrites, so arbitrary edits are not guaranteed to animate. A saved result or finished session can precede a drained visual reveal; stream EOF does not force all content visible. This is presentation behavior, not a CLI/API contract: there is no per-command animation flag, and agents should not insert word/byte chunks or sleeps to pace it.

This feature is implemented in the current worktree but is not yet in the installed CLI/app package. Native source-level checks are not GUI proof; follow-up validation should compare one whole replacement with streamed chunks, test targeted corrections, preview remounts and reduced-motion behavior, and inspect saved source separately from reveal completion. Evidence currently available is partial; do not claim GUI acceptance.

`replace` consumes the full replacement content from stdin. `patch` consumes a JSON array such as:

```json
[{ "find": "old unique text", "replace": "new text" }]
```

Patch finds must be non-empty, present exactly once, and non-overlapping. Both commands require the current live `documentVersion` from connect or status (or open-note inspect), never `diskRevision`. `--dry-run` returns a preview without mutation. Without it, apply waits for a saved response, verifying the resulting content/version; a conflicting human edit during save is rejected rather than acknowledged as saved. If apply fails due to a concurrent edit/save issue, inspect current content and reconcile; do not blindly retry. A stable `--operation-id ID` permits replay of the same request; reusing it with different payload fails. Apply deduplication is bounded to 256 remembered operations in memory, not durable across app restarts.

Example:

```sh
bun scripts/storm.ts inspect "/absolute/vault/plan.md" --json
bun scripts/storm.ts connect "/absolute/vault/plan.md" --json
# Take session.sessionId and session.documentVersion from connect JSON.
bun scripts/storm.ts replace SESSION_ID --expected-version 4 --stdin --dry-run < draft.md
bun scripts/storm.ts replace SESSION_ID --expected-version 4 --stdin --operation-id draft-v1 < draft.md
bun scripts/storm.ts status SESSION_ID --json
```

No direct filesystem writes are used for note mutations; edits go through the coordinated live editor/save path. No parent directories are implicitly created. Stream and edit input provide no byte/chunk/pacing workaround or durable operation journal. Help should accurately describe these semantics. The official installed CLI help may lag the worktree until the app/CLI is rebuilt and installed.

## Scope and workflow boundaries

This CLI provides inspect, append, full replacement, and exact-text patching. Broader folder creation, restart-durable journals, automatic rebasing, and general concurrent-text merging are not implemented. GUI behavior (including locking/overlay/preview/tab lifecycle) remains subject to hands-on validation; source-level implementation is not GUI acceptance.

For reference-note preparation, inspect instructor sources and coverage before drafting; distinguish confirmed scope, exclusions, unknowns, learner notes, and supplemental material. Assemble one complete draft and use one coordinated writer. This is reference preparation, not teaching, completion, or mastery. Preserve existing notes and provenance.
