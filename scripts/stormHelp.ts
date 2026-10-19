const rootHelp = `Storm CLI — connect an agent to a live Markdown note in Storm.

Usage:
  bun scripts/storm.ts [--endpoint PATH | --profile NAME] <command> [arguments]

Commands:
  connect ABS_PATH --json [--name NAME]  Open/create a vault note and return its session and content
  stream SESSION --stdin                 Append UTF-8 stdin; EOF finishes the session
  status [SESSION] [--json]              Show session state (or all sessions)
  finish SESSION                         Stop writing normally
  cancel SESSION                         Cancel writing; accepted edits remain

Quick workflow:
  bun scripts/storm.ts connect "/absolute/vault/plan.md" --json
  bun scripts/storm.ts stream SESSION_ID --stdin < draft.md
  bun scripts/storm.ts status SESSION_ID --json

The connect JSON response includes session.sessionId; use that as SESSION_ID. The CLI
requires a running Storm app and a registered vault. It creates only a missing .md file
whose parent already exists, and never replaces existing note contents. Stream appends
only: it does not replace the document. Stdin EOF finishes automatically; do not call
finish again. Status distinguishes accepted edits from saved edits via saveState/state.

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
  connect: `Usage: bun scripts/storm.ts [endpoint options] connect ABS_PATH --json [--name NAME]

Connect to one absolute .md path inside a registered Storm vault. Returns JSON with
session.sessionId, session state, and current note content (including unsaved editor
content). Creates an empty file only when the file is missing and its parent exists;
never overwrites an existing note. --name is an optional self-reported agent label.

Example:
  bun scripts/storm.ts connect "/vault/plan.md" --name "writer" --json`,
  stream: `Usage: bun scripts/storm.ts [endpoint options] stream SESSION --stdin

Append UTF-8 Markdown from stdin in order. EOF automatically finishes the session.
Accepted text is not rolled back on cancellation or disconnect; a cancelled/error
session must not be resumed by sending more data.

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
