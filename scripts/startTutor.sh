#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
machine_arch=$(uname -m)
if [ "$machine_arch" = x86_64 ]; then machine_arch=x64; fi
tutor_cli=${STORM_TUTOR_CLI:-"$repo_dir/out/Storm-darwin-$machine_arch/Storm.app/Contents/Resources/cli/storm"}
if [ ! -x "$tutor_cli" ]; then
  echo "Build Storm with pnpm package, or set STORM_TUTOR_CLI to a compatible bundled CLI." >&2
  exit 1
fi
if ! "$tutor_cli" study capabilities >/dev/null; then
  echo "Start the rebuilt Storm app, or set STORM_ENDPOINT to a compatible running app. Tutor was not started." >&2
  exit 1
fi
tutor_sessions=${STORM_TUTOR_SESSION_DIR:-"$HOME/.pi/agent/tutor/sessions"}
mkdir -p "$tutor_sessions"
cd "$(dirname -- "$tutor_sessions")"
exec env STORM_QUIZ_CLI="$tutor_cli" STORM_QUIZ_CLI_ARGS='[]' pi \
  --no-extensions \
  --extension "$repo_dir/extensions/storm-quiz.ts" \
  --system-prompt "$repo_dir/skills/storm/TUTOR.md" \
  --session-dir "$tutor_sessions" \
  --name Tutor "$@"
