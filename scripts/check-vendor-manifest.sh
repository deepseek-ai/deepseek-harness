#!/usr/bin/env bash
# Vendoring discipline, mechanized: any staged change under a vendored package's
# src/ or bin.js must come with a change to the README that logs that package's
# local modifications, in the same commit. vendor/im/* packages are logged in
# vendor/im/README.md; every other vendor/* package in vendor/README.md.
set -euo pipefail

staged=$(git diff --cached --name-only)

# Usage: guard <source pattern> <README path>
guard() {
  local changed manifest
  changed=$(echo "$staged" | grep -E "$1" || true)
  manifest=$(echo "$staged" | grep -x "$2" || true)
  if [[ -n "$changed" && -z "$manifest" ]]; then
    echo "vendor manifest guard: vendored SOURCE changed without updating $2:"
    echo "$changed" | sed 's/^/  /'
    echo "Log the modification in $2 (\"Local modifications\") and stage it."
    return 1
  fi
}

status=0
guard '^vendor/im/[^/]+/(src/|bin\.js)' 'vendor/im/README.md' || status=1
guard '^vendor/[^/]+/(src/|bin\.js)' 'vendor/README.md' || status=1
exit "$status"
