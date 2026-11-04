#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if ! command -v bun >/dev/null 2>&1; then
  echo 'Tutor requires Bun to load the maintained checkout. Install Bun and rerun pnpm tutor.' >&2
  exit 1
fi
exec bun "$repo_dir/scripts/runTutor.ts" "$@"
