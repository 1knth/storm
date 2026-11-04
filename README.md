# Storm

Storm is a desktop Markdown app for working with local note vaults, rendered previews, and PDF documents. Its packaged app includes a local CLI for coordinated agent edits.

This documentation describes the shipped app and the current `main` branch. Storm is actively maintained: features, fixes, tests, and documentation evolve together. Source-development instructions are separate from installed-app usage; use your installed CLI's `--help` for its available commands and options.

- [CLI contract](docs/CLI-DESIGN.md): installed commands, safe edit workflows, and preview/status behavior.
- [Editor guide](src/components/Editor/README.md): editing, navigation, preview Find, and PDF viewing.
- [macOS packaging and folder access](docs/macos-packaging-and-folder-access.md): signature checks and vault permissions.
- [Contributing conventions](CONTRIBUTING.md): code ownership, checks, and release verification.
- [Architecture map](ARCHITECTURE.md): current process boundaries and data flows.

## Developing Storm

Use the pinned pnpm version from `package.json`. Run `pnpm start` to launch the app, `pnpm test` for the Bun test suite, `pnpm typecheck` for TypeScript, and `pnpm lint` for Oxlint and formatting checks. Bun is required for tests.

Type checks use strict mode for the app and CLI/build scripts. `pnpm audit` includes Electron and build dependencies. After `pnpm package`, run `pnpm test:packaged` on macOS to check the packaged app and bundled CLI in a temporary profile/vault, including exact UTF-8 save readback. These checks also run in the macOS checks workflow.

## Vault sidebar

Pin vaults from their actions menu; pinned vaults keep any remembered group and show a pin icon beside their name. Use **Unpin vault** to restore them to that group. Pinned vaults remain at the top; below them, root vaults and group headers can be interleaved and reordered by dragging. Drop onto the center of a group header to assign a vault (including a pinned vault, which is unpinned and grouped in one operation); drop near its upper/lower edge to place at the root before/after the group. Drop on a root vault row's upper/lower half to place before/after it. These are sidebar organization actions only: they do not move files.

## Local Storm CLI

The offline command guide is built into `--help` (including per-command help). The installed app package includes a self-contained CLI folder at `Storm.app/Contents/Resources/cli/` on macOS: `storm` is a POSIX launcher, `storm.mjs` is the bundled client, and `runtime/bun` is the verified bundled Bun runtime. It requires neither a global Bun installation nor a source checkout; this is a folder bundle, not a single-file executable. On the first launch of a packaged macOS app, Storm offers to create `/usr/local/bin/storm`; this does not change shell configuration. Storm never replaces an existing command, and macOS may request administrator authorization. You can retry from **Storm → Enable CLI…**. The prompt does not run in development; on other platforms use the bundled launcher by full path. If Storm is running from App Translocation, move it to `/Applications` before enabling the shortcut. `bun run build:cli` creates this bundle in ignored `build/cli/`. Packaging supports only the current build host platform/architecture and does not download a cross-target runtime.

```sh
storm --help                 # if you added the packaged CLI to PATH
bun scripts/storm.ts --help  # development fallback
storm connect --help
```

The tool-neutral agent skill is at [`skills/storm/SKILL.md`](skills/storm/SKILL.md). Point your agent at that file or load it through your tool's skill mechanism; it does not require Pi. Storm's optional Pi quiz integration is a separate extension at [`extensions/storm-quiz.ts`](extensions/storm-quiz.ts), not something made available to Pi merely by rebuilding Storm. The extension requires its current context ID on writes, restores bounded context on attach/status, and recovers temporary listener failures. Rebuild the CLI/app and reload the extension together when updating this contract. Run `pnpm tutor:install` to install an idempotent, backed-up wrapper pointing at this maintained checkout, or load it explicitly with `pi --extension /absolute/path/to/storm/extensions/storm-quiz.ts`. Configure `STORM_QUIZ_CLI` and optional `STORM_QUIZ_CLI_ARGS`. For the maintained Tutor system prompt, use `pnpm tutor`; it selects a local built or installed app CLI and checks explicit learning/support-update/answer-confidence capabilities before startup. `pnpm tutor:doctor` reports versions, source hashes, installation state, and app capabilities. Restart Pi after extension or prompt updates. See [Tutor deployment](docs/TUTOR-DEPLOYMENT.md) for commands and rollback. See Pi's [Extensions](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/extensions.md) documentation for loading trusted local extensions. The standalone CLI discovers endpoint metadata created by the running app in the macOS user-data locations `~/Library/Application Support/storm` or `~/Library/Application Support/Storm` (and the legacy `~/.storm` location). If multiple profiles are present, select one explicitly with `--endpoint PATH` or `--profile NAME`; `STORM_ENDPOINT` can override default discovery. The development CLI entrypoint runs directly with Bun. On macOS:

```sh
storm inspect "/absolute/path/to/note.md" --json  # read an existing note without opening it
storm connect "/absolute/path/to/note.md" --json  # open/create; review returned content
# Substitute session.sessionId from connect. Stream appends and EOF finishes automatically.
storm stream SESSION_ID --stdin < draft.md
storm status SESSION_ID --json
storm inspect "/absolute/path/to/note.md" --json  # verify the saved result
```

Use guarded `replace` for a complete draft or `patch` for unique exact-text changes; both require the current live `documentVersion`. See the [CLI contract](docs/CLI-DESIGN.md) for examples and cleanup rules. Submit complete drafts without artificial pacing: the app manages preview reveal independently. The status bar shows **Revealing…** while the finished session's active preview drains, then **Finished**. CLI completion does not wait for that animation.

`finish` and `cancel` accept the same endpoint option. The endpoint only exists while Storm is running. Storm does not modify shell configuration; if you decline setup, invoke the packaged binary by full path or add its containing directory to `PATH` yourself.
