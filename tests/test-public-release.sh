#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

node "$ROOT/scripts/check-public-release.mjs"
assert_command_fails() {
  if "$@" >/dev/null 2>&1; then
    echo "expected command to fail: $*" >&2
    exit 1
  fi
}

fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
git -C "$fixture" init -q
git -C "$fixture" -c user.name=test -c user.email=test@users.noreply.github.com commit --allow-empty -qm baseline
mkdir -p "$fixture/indexes"
printf '{}\n' >"$fixture/indexes/private.jsonl"
git -C "$fixture" add indexes/private.jsonl
git -C "$fixture" -c user.name=test -c user.email=test@users.noreply.github.com commit -qm private-state
assert_command_fails node "$ROOT/scripts/check-public-release.mjs" "$fixture"

git -C "$fixture" rm -q indexes/private.jsonl
git -C "$fixture" -c user.name=test -c user.email=test@users.noreply.github.com commit -qm remove-private-state
assert_command_fails node "$ROOT/scripts/check-public-release.mjs" --history "$fixture"

safe_fixture="$(mktemp -d)"
trap 'rm -rf "$fixture" "$safe_fixture"' EXIT
git -C "$safe_fixture" init -q
printf 'public\n' >"$safe_fixture/README.md"
git -C "$safe_fixture" add README.md
git -C "$safe_fixture" -c user.name=test -c user.email=test@users.noreply.github.com commit -qm public
node "$ROOT/scripts/check-public-release.mjs" --history "$safe_fixture"
