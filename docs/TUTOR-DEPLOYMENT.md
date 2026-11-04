# Deploying the Storm Tutor integration

Keep the app, CLI, maintained Pi extension, and Tutor prompt together. Storm's app
version is not a protocol compatibility check: different builds can have the same
app version. The current quiz integration contract is **2** and requires the
`learning`, `support-update`, and `answer-confidence` features, plus study schema
version **1** for the dedicated Tutor launcher.

## Build and launch

From the maintained checkout:

```sh
pnpm package
# Launch the newly packaged Storm.app, or install it in /Applications and launch it.
pnpm tutor:doctor
pnpm tutor
```

`pnpm tutor` requires Bun and Pi on PATH. It loads the checkout's
`extensions/storm-quiz.ts` and `skills/storm/TUTOR.md` directly and checks the
running app through read-only `quiz capabilities` and `study capabilities`
requests before starting Pi or creating its session directory. A CLI that can
read study sources but lacks learning/support updates fails preflight with an
actionable error. Neither check attaches, modifies, or takes over a quiz.

CLI selection is, in order:

1. Explicit `STORM_TUTOR_CLI`.
2. Explicit `STORM_QUIZ_CLI`.
3. An executable local `out/Storm-darwin-ARCH/Storm.app/Contents/Resources/cli/storm`.
4. `/Applications/Storm.app/Contents/Resources/cli/storm`.

`STORM_QUIZ_CLI_ARGS` stays a JSON string array and is preserved for both
capability checks and the extension. Commands are invoked directly, without shell
expansion. `STORM_ENDPOINT` is preserved. For example, to use the maintained source
CLI against a selected app/profile endpoint:

```sh
STORM_QUIZ_CLI=bun \
STORM_QUIZ_CLI_ARGS='["/absolute/path/to/storm/scripts/storm.ts"]' \
STORM_ENDPOINT='/absolute/path/to/agent-endpoint.json' \
pnpm tutor:doctor
```

Use the same environment for `pnpm tutor`. An explicit CLI override that fails is
reported; it does not silently fall back to another app. If several Storm profiles
are open, select the intended endpoint explicitly. The launcher forwards Pi
arguments, for example `pnpm tutor --resume SESSION`. Sessions default to
`~/.pi/agent/tutor/sessions`; `STORM_TUTOR_SESSION_DIR` overrides this location.
`PI_CODING_AGENT_DIR` selects a different Pi agent directory when configured.

## Install the maintained extension for ordinary Pi sessions

```sh
pnpm tutor:install
# Or explicitly select a non-default Pi agent directory:
pnpm tutor:install --pi-agent-dir /absolute/path/to/pi/agent
```

The installer writes only `extensions/storm-quiz.ts` and
`storm-tutor-install.json` inside the selected agent directory. The wrapper imports
this checkout's extension and deployment helper by absolute path. It does not copy
dependencies into `storm-integration`, change Pi settings, contact Storm, start Pi,
or affect an active quiz. Keep the checkout available; rerun the installer if it
moves. Existing stale `storm-integration` directories are left untouched for
rollback but are no longer imported by this wrapper.

A different existing wrapper is saved as
`extensions/storm-quiz.ts.backup-HASH`; the exact backup path is printed in the
installer's JSON output. Repeating the install is idempotent. Source changes refresh
the manifest hashes without making redundant wrapper backups. Environment CLI
and argument overrides continue to win. Custom code inside an old wrapper is
preserved in the backup; it is not evaluated or migrated into Pi settings.

The global wrapper loads the Storm extension in ordinary Pi sessions. It does not
replace their system prompt. Use `pnpm tutor` to load the maintained Tutor system
prompt as well. Avoid explicitly loading the same extension a second time in an
ordinary Pi session where global extension discovery already loads the wrapper.

## Diagnostics, restart, and rollback

`pnpm tutor:doctor` reports the integration version, required features, chosen CLI,
current extension/runtime/shared-file and Tutor prompt SHA-256 hashes, the recorded
installation manifest, wrapper-hash match, changes since installation, and the
running app's advertised capabilities. It omits CLI arguments, which may contain
private values. It also reports source/install information when the CLI or app is
unavailable and exits unsuccessfully when the capability check fails. The launcher
prints its source hashes, and the installed wrapper exposes its factory-load hashes
in `STORM_TUTOR_DIAGNOSTICS` inside Pi for extension diagnostics.

**Restart Pi after installation or any extension, imported helper, or Tutor prompt
change.** Files on disk and an install manifest cannot prove what an existing Pi
process has loaded. Rebuilding or restarting Storm alone does not reload Pi's
extension or system prompt. Quit/relaunch Pi at a suitable session boundary; resume
a chosen Pi session explicitly if needed. A restart does not authorize a second
listener or takeover of a connected quiz. Follow the existing attachment lifecycle
and explicitly reattach only when the quiz permits it.

To restore the old wrapper, use the exact backup path from the installation output:

```sh
cp '/absolute/path/to/storm-quiz.ts.backup-HASH' '/absolute/path/to/extensions/storm-quiz.ts'
```

Then restart Pi. The manifest may show a wrapper mismatch until you reinstall;
it is diagnostic metadata. If there was no previous wrapper, remove only the new
`extensions/storm-quiz.ts` and `storm-tutor-install.json` to undo the installation,
then restart Pi. No settings rollback is needed.

Deployment regressions run with a temporary fake Pi directory, fake CLI, and fake
Pi executable, without touching live configuration or sessions:

```sh
bun test scripts/tutorDeployment.test.ts
```
