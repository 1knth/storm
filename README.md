# Storm

Storm is an Electron application for working with a vault of notes.

- [Contributing conventions](CONTRIBUTING.md): where code belongs, ownership rules, and checks to run.
- [Architecture map](ARCHITECTURE.md): current process boundaries, data flows, and refactor notes.

## Development

Use the pinned pnpm version from `package.json`. Run `pnpm start` to launch the app, `pnpm test` for the Bun test suite, `pnpm typecheck` for TypeScript, and `pnpm lint` for Oxlint and formatting checks. Bun is required for tests.

## Vault sidebar

Pin vaults from their actions menu; pinned vaults keep any remembered group and show a pin icon beside their name. Use **Unpin vault** to restore them to that group. Pinned vaults remain at the top; below them, root vaults and group headers can be interleaved and reordered by dragging. Drop onto the center of a group header to assign a vault (including a pinned vault, which is unpinned and grouped in one operation); drop near its upper/lower edge to place at the root before/after the group. Drop on a root vault row's upper/lower half to place before/after it. These are sidebar organization actions only: they do not move files.

## Local Storm CLI

The offline command guide is built into `--help` (including per-command help). The installed app package includes a self-contained CLI folder at `Storm.app/Contents/Resources/cli/` on macOS: `storm` is a POSIX launcher, `storm.mjs` is the bundled client, and `runtime/bun` is the verified bundled Bun runtime. It requires neither a global Bun installation nor a source checkout; this is a folder bundle, not a single-file executable. Add the folder to `PATH` yourself, or invoke its launcher by full path. `bun run build:cli` creates this bundle in ignored `build/cli/`. Packaging supports only the current build host platform/architecture and does not download a cross-target runtime.

```sh
storm --help                 # if you added the packaged CLI to PATH
bun scripts/storm.ts --help  # development fallback
storm connect --help
```

A project-local Pi-compatible agent skill is at [`.pi/skills/storm/SKILL.md`](.pi/skills/storm/SKILL.md); Pi discovers it as a project skill when this repository is open. The standalone CLI discovers endpoint metadata created by the running app in the macOS user-data locations `~/Library/Application Support/storm` or `~/Library/Application Support/Storm` (and the legacy `~/.storm` location). If multiple profiles are present, select one explicitly with `--endpoint PATH` or `--profile NAME`; `STORM_ENDPOINT` can override default discovery. The development CLI entrypoint runs directly with Bun. On macOS:

```sh
storm connect /absolute/path/to/note.md --json
storm status --json
storm stream SESSION --stdin < draft.md
```

`finish` and `cancel` accept the same endpoint option. The endpoint only exists while Storm is running. Storm does not install a global symlink or modify shell configuration; invoke the packaged binary by full path or add its containing directory to `PATH` yourself.
