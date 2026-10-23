const rootHelp = `Storm CLI — connect an agent to a live Markdown note in Storm.

Usage:
  bun scripts/storm.ts [--endpoint PATH | --profile NAME] <command> [arguments]

Commands:
  context [--json]                        Show registered vault roots and open-note context (read-only)
  inspect ABS_PATH --json                 Read a note without opening or creating it
  connect ABS_PATH --json [--name NAME]  Open/create a vault note and return its session and content
  stream SESSION --stdin                 Append UTF-8 stdin; EOF finishes the session
  replace SESSION --expected-version N --stdin [--dry-run] [--json] [--operation-id ID]
  patch SESSION --expected-version N --stdin [--dry-run] [--json] [--operation-id ID]
  status [SESSION] [--json]              Show session state (or all sessions)
  activity SESSION thinking|drafting|idle Report or clear the current work phase
  finish SESSION                         Stop writing normally
  cancel SESSION                         Cancel writing; accepted edits remain
  resolve-link --vault ID --source PATH --target TARGET [--json]

Quick context check (does not require or create a note session):
  bun scripts/storm.ts context
  bun scripts/storm.ts context --json

Quick workflow:
  bun scripts/storm.ts inspect "/absolute/vault/plan.md" --json
  bun scripts/storm.ts connect "/absolute/vault/plan.md" --json
  bun scripts/storm.ts stream SESSION_ID --stdin < draft.md
  bun scripts/storm.ts replace SESSION_ID --expected-version 4 --stdin < new.md
  bun scripts/storm.ts patch SESSION_ID --expected-version 4 --stdin < edits.json
  bun scripts/storm.ts status SESSION_ID --json
  bun scripts/storm.ts activity SESSION_ID thinking
  bun scripts/storm.ts activity SESSION_ID drafting
  bun scripts/storm.ts activity SESSION_ID idle

REQUIRED agent workflow guidance: report real phases as best-effort UI telemetry;
do not block valid work waiting for an activity update. Report thinking before actual
inspection/planning and drafting before composition when those phases occur. If an
activity delivery fails transiently, warn that it may not be visible and continue if
the session remains valid. Closed-session responses require reconnect/revalidation,
not blind continuation. Document write/save and protocol errors still require stopping
and reconciling. Writes clear activity and show Writing automatically. The protocol
field remains optional for compatibility and non-agent clients. Never guess phases,
use timers, or disclose private chain-of-thought; terminal states clear activity.

Choose the teaching depth, structure, examples, diagrams, and math that best clarify the
material and learner's goal. See docs/AGENT-AUTHORING.md. For an existing note, inspect
content and live version; use guarded patch for focused corrections or guarded replace
for a coherent rewrite. Both are atomic and version-checked. New prose and substantial
rewrites may reveal progressively; focused corrections may appear immediately. Never
pace or fragment content to control presentation. Assessment-reference workflows retain
their complete-draft, one coordinated append-only write requirement.

Storm preview supports in-vault wiki note links: [[note]], [[folder/note]], and
[[note|label]]. Link only to an existing target you have identified. Start with
context to see registered vault roots and currently open notes; openNotes is not a full
vault listing. Use inspect ABS_PATH --json to verify an existing note without opening
or creating it. Never use connect as an existence check: it can create a missing note.
Use list --vault ID to list note names and paths, and search QUERY --vault ID
to search names and contents. Search can traverse links from --source PATH to
--depth 0..5; --include-source includes the starting note. resolve-link --vault
ID --source PATH --target TARGET resolves one wikilink. Discovery is read-only and
bounded; JSON reports truncated when traversal hits its safety budget. Heading
fragments are unsupported.

The connect JSON response includes session.sessionId; use that as SESSION_ID. The CLI
requires a running Storm app and a registered vault. It creates only a missing .md file
whose parent already exists, and never replaces existing note contents. Stream appends
only. replace/patch perform guarded full or exact-text edits; --dry-run previews without
mutation. Obtain live documentVersion from connect/status/inspect and pass it as
--expected-version (not diskRevision). Apply waits for the app's saved response. Patch
stdin is a JSON array of {"find":"...","replace":"..."} edits. The official CLI
requires the running Storm app and never writes note files directly. Stdin EOF finishes
stream automatically; do not call finish again. Stream is append input, not a reveal API. Source acceptance/save is independent of preview animation; there is no chunk pacing or per-command reveal flag. Agent phase reporting is required guidance but best-effort telemetry, not a prerequisite to writing; delivery failure does not excuse ignoring write/save errors. The protocol remains optional for compatibility. Appends automatically show Writing and clear the phase.

Options:
  -h, --help          Show this guide or command-specific help (works offline)
  --endpoint PATH     Use explicit Storm endpoint metadata (overrides --profile)
  --profile NAME      Use ~/.storm/NAME/storm-agent.json

Without an endpoint override the CLI discovers metadata in the platform's app-data
location (on macOS: ~/Library/Application Support/storm or Application Support/Storm)
or the legacy ~/.storm location. If multiple profiles are found, choose one with
--endpoint PATH or --profile NAME. The packaged launcher includes its own Bun runtime;
source development requires a local Bun installation.

Errors: invalid commands/options/arguments print usage and exit 2. A missing endpoint,
closed app, vault/path rejection, or session/protocol error prints a concise error (JSON
protocol errors go to stderr) and exits nonzero. Endpoint metadata contains a private
authentication token: do not disclose it. Use --help with any command for details.`;

const commandHelp: Record<string, string> = {
  'resolve-link': `Usage: bun scripts/storm.ts [endpoint options] resolve-link --vault VAULT_ID --source NOTE_PATH --target WIKILINK_TARGET [--json]

Resolve one wikilink from an existing note through the registered vault. Read-only;
never opens or creates notes. Reports the matching relative path or missing/ambiguous.
`,
  context: `Usage: bun scripts/storm.ts [endpoint options] context [--json]

Read-only snapshot of registered vault IDs, names, and absolute roots, the active vault
and note (when available), and notes currently open in tabs. This does not require a
session and never creates or opens notes. Open notes are not a complete vault listing.

Use list/search to discover existing notes by name or contents; linked search follows
wikilinks from a specified source. Use resolve-link to check a specific target. These
commands are read-only; never use connect as an existence check because it can create
a missing note. Linked search reports unresolved targets and is bounded.

Without --json, prints a readable summary. With --json, prints the protocol response
including type: context and its context object.

Example:
  bun scripts/storm.ts context --json`,
  inspect: `Usage: bun scripts/storm.ts [endpoint options] inspect ABS_PATH --json

Read an existing .md note inside a registered Storm vault without opening a tab,
creating a file, or starting a session. JSON reports whether content came from the
live editor or disk. Live content includes documentVersion and saveState; disk content
has diskRevision only. This is a read-only operation.

Example:
  bun scripts/storm.ts inspect "/vault/plan.md" --json`,
  connect: `Usage: bun scripts/storm.ts [endpoint options] connect ABS_PATH --json [--name NAME]

Connect to one absolute .md path inside a registered Storm vault. Returns JSON with
session.sessionId, session state, and current note content (including unsaved editor
content). Creates an empty file only when the file is missing and its parent exists;
never overwrites an existing note. --name is an optional self-reported agent label.

Example:
  bun scripts/storm.ts connect "/vault/plan.md" --name "writer" --json`,
  replace: `Usage: bun scripts/storm.ts [endpoint options] replace SESSION --expected-version N --stdin [--dry-run] [--json]

Replace the live note from stdin. --dry-run previews; otherwise applies and waits for
saved confirmation. Source text saves independently of preview presentation; the current
preview can reveal identified pure insertions, but ambiguous/oversized rewrites may skip reveal. Use live documentVersion from connect/status (or open-note inspect),
not diskRevision. --operation-id enables bounded in-memory replay of an identical request.`,
  patch: `Usage: bun scripts/storm.ts [endpoint options] patch SESSION --expected-version N --stdin [--dry-run] [--json]

Stdin is a JSON array of exact-text edits: [{"find":"old","replace":"new"}].
--dry-run previews; otherwise applies and waits for saved confirmation. Corrections are
immediate; source saving is independent of preview presentation, which may skip reveal for ambiguous/oversized rewrites. Use live
documentVersion from connect/status (or open-note inspect), not diskRevision.
--operation-id enables bounded in-memory replay of an identical request.`,
  stream: `Usage: bun scripts/storm.ts [endpoint options] stream SESSION --stdin

Append UTF-8 Markdown from stdin in order. EOF automatically finishes the session.
Accepted text is not rolled back on cancellation or disconnect; a cancelled/error
session must not be resumed by sending more data. Stream is useful for live append workflows, not preview reveal control; do not pace chunks, bytes, or words to animate text. Activity updates are best-effort telemetry; reconnect/revalidate on closed-session responses, and stop to reconcile write/save errors.

Example:
  bun scripts/storm.ts stream SESSION_ID --stdin < draft.md`,
  activity: `Usage: bun scripts/storm.ts [endpoint options] activity SESSION thinking|drafting|idle

Report a truthful operational phase for the connected session. Use thinking while inspecting/planning and drafting while composing; use idle to clear the phase. Appending content automatically switches to Writing and clears reported activity. Activity is optional, is not inferred from connection or timers, and does not disclose private chain-of-thought.

For agents this is REQUIRED workflow guidance, but activity is best-effort telemetry,
not a prerequisite that blocks work. Report before real phase changes when practical;
transient delivery failure does not invalidate a write if the session remains valid.
Closed-session responses require reconnect/revalidation. Write/save errors still stop
and require reconciliation. Writing clears activity automatically. The protocol permits
omission for compatibility/non-agent clients, so Storm cannot enforce compliance.

Example:
  bun scripts/storm.ts activity SESSION_ID drafting`,
  status: `Usage: bun scripts/storm.ts [endpoint options] status [SESSION] [--json]

Report one session or all sessions. States distinguish connected/writing/finished/
cancelled/disconnected/failed. A successful append acknowledgement means accepted by
the live editor, not necessarily saved; inspect saveState and later status for persistence.

Example:
  bun scripts/storm.ts status SESSION_ID --json`,
  finish: `Usage: bun scripts/storm.ts [endpoint options] finish SESSION

Stop a session normally. No further appends are accepted. Previously accepted edits
remain; finish does not roll back content. Stream stdin EOF performs this automatically.`,
  cancel: `Usage: bun scripts/storm.ts [endpoint options] cancel SESSION

Cancel a session and reject further writes. Already accepted edits remain; cancellation
does not kill an external agent process or roll back its edits.`,
};

export function helpText(command?: string): string {
  return command ? (commandHelp[command] ?? rootHelp) : rootHelp;
}

export const knownCommands = Object.keys(commandHelp);
