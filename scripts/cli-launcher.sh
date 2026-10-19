#!/bin/sh
set -eu

# Resolve symlink chains so PATH symlinks (including paths with spaces) work.
script=$0
while [ -L "$script" ]; do
  directory=$(CDPATH= cd -P -- "$(dirname -- "$script")" && pwd)
  link=$(/usr/bin/readlink "$script")
  case $link in
    /*) script=$link ;;
    *) script=$directory/$link ;;
  esac
done
directory=$(CDPATH= cd -P -- "$(dirname -- "$script")" && pwd)
STORM_INSTALLED_CLI=1
export STORM_INSTALLED_CLI
exec "$directory/runtime/bun" "$directory/storm.mjs" "$@"
