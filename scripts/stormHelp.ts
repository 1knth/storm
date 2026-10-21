const rootHelp = `Storm CLI — connect an agent to a live Markdown note in Storm.

Usage:
  bun scripts/storm.ts [--endpoint PATH | --profile NAME] <command> [arguments]

Commands:
  inspect ABS_PATH --json                 Read a note without opening or creating it
  connect ABS_PATH --json [--name NAME]  Open/create a vault note and return its session and content
  stream SESSION --stdin                 Append UTF-8 stdin; EOF finishes the session
  replace SESSION --expected-version N --stdin [--dry-run] [--json] [--operation-id ID]
  patch SESSION --expected-version N --stdin [--dry-run] [--json] [--operation-id ID]
  status [SESSION] [--json]              Show session state (or all sessions)
  finish SESSION                         Stop writing normally
  cancel SESSION                         Cancel writing; accepted edits remain

Quick workflow:
  bun scripts/storm.ts inspect "/absolute/vault/plan.md" --json
  bun scripts/storm.ts connect "/absolute/vault/plan.md" --json
  bun scripts/storm.ts stream SESSION_ID --stdin < draft.md
  bun scripts/storm.ts replace SESSION_ID --expected-version 4 --stdin < new.md
  bun scripts/storm.ts patch SESSION_ID --expected-version 4 --stdin < edits.json
  bun scripts/storm.ts status SESSION_ID --json

The connect JSON response includes session.sessionId; use that as SESSION_ID. The CLI
requires a running Storm app and a registered vault. It creates only a missing .md file
whose parent already exists, and never replaces existing note contents. Stream appends
only. replace/patch perform guarded full or exact-text edits; --dry-run previews without
mutation. Obtain live documentVersion from connect/status/inspect and pass it as
--expected-version (not diskRevision). Apply waits for the app's saved response. Patch
stdin is a JSON array of {"find":"...","replace":"..."} edits. The official CLI
requires the running Storm app and never writes note files directly. Stdin EOF finishes
stream automatically; do not call finish again. Stream is append input, not a reveal API. Source acceptance/save is independent of preview animation; there is no chunk pacing or per-command reveal flag.

Options:
  -h, --help          Show this guide or command-specific help (works offline)
  --endpoint PATH     Use explicit Storm endpoint metadata (overrides --profile)
  --profile NAME      Use ~/.storm/NAME/storm-agent.json

Without either endpoint option the CLI uses ~/.storm/storm-agent.json. Typical macOS
app metadata is at ~/Library/Application Support/storm/storm-agent.json; pass it with
--endpoint if Storm is using that location. This development CLI is invoked with Bun;
there is not yet an installed storm executable.

Errors: invalid commands/options/arguments print usage and exit 2. A missing endpoint,
closed app, vault/path rejection, or session/protocol error prints a concise error (JSON
protocol errors go to stderr) and exits nonzero. Endpoint metadata contains a private
authentication token: do not disclose it. Use --help with any command for details.`;

const commandHelp: Record<string, string> = {
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
session must not be resumed by sending more data. Stream is useful for live append workflows, not preview reveal control; do not pace chunks, bytes, or words to animate text.

Example:
  bun scripts/storm.ts stream SESSION_ID --stdin < draft.md`,
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
