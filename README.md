# Storm

Storm is an Electron application for working with a vault of notes.

- [Contributing conventions](CONTRIBUTING.md): where code belongs, ownership rules, and checks to run.
- [Architecture map](ARCHITECTURE.md): current process boundaries, data flows, and refactor notes.

## Development

Use the pinned pnpm version from `package.json`. Run `pnpm start` to launch the app, `pnpm test` for the Bun test suite, `pnpm typecheck` for TypeScript, and `pnpm lint` for Oxlint and formatting checks. Bun is required for tests.

## Vault sidebar

Pin vaults from their actions menu; pinned vaults keep any remembered group and show a pin icon beside their name. Use **Unpin vault** to restore them to that group. Drag onto the center of a group header to assign a vault; drop above/below the header to place it at the root. Drop on a vault row's upper/lower half to place before/after it; group headers can likewise be reordered. These are sidebar organization actions only: they do not move files.

## Local Storm CLI

The full offline command guide is built into `--help` (including per-command help):

```sh
bun scripts/storm.ts --help
bun scripts/storm.ts connect --help
```

A project-local Pi-compatible agent skill is at [`.pi/skills/storm/SKILL.md`](.pi/skills/storm/SKILL.md); Pi discovers it as a project skill when this repository is open. The development CLI entrypoint runs directly with Bun and uses the endpoint metadata created by the running app. On macOS, the default Electron user-data location is typically `~/Library/Application Support/storm`; pass the exact `storm-agent.json` path explicitly if your app data directory differs:

```sh
bun scripts/storm.ts --endpoint "$HOME/Library/Application Support/storm/storm-agent.json" connect /absolute/path/to/note.md --json
bun scripts/storm.ts --endpoint "$HOME/Library/Application Support/storm/storm-agent.json" status --json
bun scripts/storm.ts --endpoint "$HOME/Library/Application Support/storm/storm-agent.json" stream SESSION --stdin < draft.md
```

`finish` and `cancel` accept the same endpoint option. The endpoint only exists while Storm is running; this worktree does not yet ship a globally installed `storm` executable.
