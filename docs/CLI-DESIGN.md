# Storm CLI live-note contract

This document describes the CLI and preview behavior shipped with Storm. The CLI is part of the maintained desktop app, not a separate experimental workflow. Update this contract, command help, and the [agent skill](../skills/storm/SKILL.md) together when behavior changes. Development builds may contain changes beyond an installed release; use the help bundled with the executable you are running for its available commands and options.

## Running the CLI

Use `storm` after enabling the command in the app. On macOS, the installed launcher is also available directly:

```sh
/Applications/Storm.app/Contents/Resources/cli/storm --help
storm connect --help
```

The packaged CLI includes its own Bun runtime; it needs neither a global Bun installation nor a source checkout. For source development, use `bun scripts/storm.ts` with the development app. See the [README](../README.md#local-storm-cli) for setup and endpoint discovery.

The app must be running and the note must belong to a registered vault. Endpoint metadata contains a private authentication token: never expose it.

## Commands

```text
storm context [--json]
storm inspect ABS_PATH --json
storm connect ABS_PATH --json [--name NAME]
storm stream SESSION --stdin
storm replace SESSION --expected-version N --stdin [--dry-run] [--json] [--operation-id ID]
storm patch SESSION --expected-version N --stdin [--dry-run] [--json] [--operation-id ID]
storm status [SESSION] [--json]
storm finish SESSION
storm cancel SESSION
```

### Agent activity reporting

For agents using this live-note workflow, reporting real phase changes is **required**: after connect, report `thinking` before actual inspection/planning, and `drafting` before composing note content for Storm. Report each real transition; do not fabricate phases or require a phase that did not occur. Writes automatically clear activity and show Writing; `idle` is for clearing a phase while still connected. This is mandatory agent guidance, not runtime enforcement: activity remains optional in the protocol for compatibility and non-agent clients. See the [agent activity guide](AGENT-ACTIVITY.md).

### Context, inspect, and connect

`context` is a read-only snapshot that requires no note session. It reports registered vault IDs, names, and absolute roots, the active vault/note when available, and notes currently open in tabs. `openNotes` is not a full vault listing. Use the root paths and known note paths to guide inspection, then verify an existing target with `inspect ABS_PATH --json` before linking. `context` does not provide note listing, search, or link resolution.

`inspect` is read-only, requires an existing `.md` file, and neither opens a tab nor creates a session/file. For an open editor note, it returns live `content`, `documentVersion`, `diskRevision`, and `saveState`; otherwise it returns disk `content` and `diskRevision`, with no live version.

`connect` opens an existing note or creates an empty missing `.md` file only if its parent exists; it does not replace existing content. Its JSON contains `session.sessionId`, session `documentVersion` / `diskRevision`, and content. Review that content before writing. Use connect for writing, not as a read-only existence check.

Keep ownership of the session ID until cleanup. After successful replace/patch, explicitly finish the owned session; on workflow failure or abandonment, cancel it. Stream EOF finishes automatically. Finish/cancel stop future writes but do not roll back accepted edits. Never finish or cancel sessions created by another workflow. Process exit alone does not establish session closure or persistence.

### Append input

`stream` forwards UTF-8 stdin in order as append operations; EOF finishes automatically. It supports live append workflows and stdin backpressure. It is not a reveal API: do not pace words, bytes, or chunks to control preview animation.

Append acknowledgements indicate live-editor acceptance, not disk persistence. Check status and read back with `inspect` after completion. Accepted content is not rolled back by cancellation or disconnect; cancellation does not terminate an external agent. On error, inspect the evidence rather than automatically reconnecting or replaying content.

### Guarded edits

For an existing note, prefer `patch` for focused corrections; reserve `replace` for a genuinely necessary full-document rewrite. Both are atomic operations guarded by the live version: atomic means all-or-nothing for that request, not that its edit scope should be broad. Choose the smallest safe operation that preserves unrelated content. Use append/`stream` for genuinely new content, not as a correction workaround or as a way to make separately accepted deltas one atomic write. The assessment-reference workflow is a project-specific exception: complete source coverage and the whole review first, then use one coordinated append-only write as required by the study instructions. More-specific user/project requirements take precedence.

`replace` consumes the full replacement content from stdin. `patch` consumes a JSON array such as:

```json
[{ "find": "old unique text", "replace": "new text" }]
```

Patch finds must be non-empty, present exactly once, and non-overlapping. Both commands require the current live `documentVersion` from connect or status (or open-note inspect), never `diskRevision`. `--dry-run` returns a preview without mutation. Without it, apply waits for a saved response, verifying the resulting content/version; a conflicting human edit during save is rejected rather than acknowledged as saved. If apply fails due to a concurrent edit/save issue, inspect current content and reconcile; do not blindly retry.

A stable `--operation-id ID` permits replay of the identical request; reusing it with different payload fails. Apply deduplication is bounded to 256 remembered operations in memory, not durable across app restarts.

Example workflow for a prepared draft:

```sh
storm connect "/absolute/vault/plan.md" --json
# Review content. Substitute SESSION_ID and LIVE_VERSION from the connect response.
storm replace SESSION_ID --expected-version LIVE_VERSION --stdin --dry-run < draft.md
# If the live version changes, inspect and reconcile before applying.
storm replace SESSION_ID --expected-version LIVE_VERSION --stdin --operation-id draft-v1 < draft.md
# On successful apply, finish the session this workflow owns.
storm finish SESSION_ID
storm status SESSION_ID --json
storm inspect "/absolute/vault/plan.md" --json
```

If apply fails or the workflow is abandoned, cancel its session instead of treating it as successfully finished. For a read-only review of an existing note, use `inspect` without connecting.

## Native preview presentation

Source acceptance and saving are independent of preview presentation. A complete draft can be submitted in one operation: Storm schedules the eligible new text for reveal in the preview. Agents do not need chunking, sleeps, delayed EOF, or repeated appends to make this happen.

The preview reveals confidently identified pure insertions; corrections are immediate. The bounded 250,000-cell diff conservatively skips reveal for ambiguous or oversized rewrites, so arbitrary edits are not guaranteed to animate. Reduced-motion preferences disable the reveal animation.

A saved result or backend `finished` session can precede the last visual reveal. While the active, mounted preview still has pending reveal work, the agent status bar displays **Revealing…**, then **Finished** when the matching final preview drains. A hidden preview does not hold the status bar in Revealing, and cancelled/failed/disconnected states are not masked. Stream EOF does not force all content visible, and preview animation does not delay saving or CLI completion.

This is app presentation behavior, not a timing guarantee or a per-command animation flag. Regression checks must distinguish saved source from visual completion. The packaged macOS arm64 app and bundled CLI have been exercised with a single complete append followed by EOF, exact content readback, and the Revealing → Finished transition. That verification does not establish every edit pattern or platform; ongoing release checks are described in [Contributing](../CONTRIBUTING.md#release-verification-and-documentation).

Use appropriate supported Markdown to clarify teaching explanations, connections, worked examples, procedures, or comparisons; do not add decorative structures merely to use every feature. See the [agent authoring guide](AGENT-AUTHORING.md) for examples and edit-selection guidance, including safe use of supported wiki note links. `context` provides registered vault roots and currently open note paths, not a full file listing. The CLI does not provide note-list, search, or link-resolution commands; do not guess target paths or use `connect` to check whether a target exists, since it may create a missing note. Verify a known existing path with read-only `inspect ABS_PATH --json`.

## Scope and workflow boundaries

All note mutations use Storm's coordinated live editor/save path; the CLI never writes note files directly. The supported operations are inspection, append, full replacement, and exact-text patching. Parent-folder creation, restart-durable operation journals, automatic rebasing, and general concurrent-text merging are outside the current command set. These are supported-scope boundaries, not promised future features.

For assessment-reference preparation, inspect instructor sources and coverage before drafting; distinguish confirmed scope, exclusions, unknowns, learner notes, and supplemental material. Assemble the complete review and use one coordinated append-only Storm write as required by the project study workflow. Do not interpret the general preference for targeted corrections as permission to replace or split that review. This is reference preparation, not teaching, completion, or mastery. Preserve existing notes and provenance.
