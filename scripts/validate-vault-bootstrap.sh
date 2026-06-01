#!/usr/bin/env bash
set -euo pipefail

ROOT="${FRAMEWORK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
VAULT_PATH="${VAULT_PATH:-<local-home>/obsidian/cyborg}"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_file() {
  local path="$1"
  [ -f "$VAULT_PATH/$path" ] || fail "missing vault file: $path"
}

assert_contains() {
  local path="$1"
  local text="$2"
  grep -Fq "$text" "$VAULT_PATH/$path" || fail "$path does not contain: $text"
}

[ -d "$VAULT_PATH" ] || fail "vault path does not exist: $VAULT_PATH"
[ -f "$ROOT/taxonomy/approved-tags.md" ] || fail "missing framework approved tags"

assert_file "07-system/taxonomy/approved-tags.md"
assert_file "06-templates/daily-note.md"
assert_file "06-templates/template-daily-note.md"
assert_file "06-templates/project-note.md"
assert_file "06-templates/source-note.md"

cmp -s "$ROOT/taxonomy/approved-tags.md" "$VAULT_PATH/07-system/taxonomy/approved-tags.md" ||
  fail "vault approved tags differ from framework taxonomy"

if git -C "$VAULT_PATH" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  staged_changes="$(git -C "$VAULT_PATH" diff --cached --name-status --)"
  expected_changes="$(printf 'A\t06-templates/daily-note.md\nA\t06-templates/project-note.md\nA\t06-templates/source-note.md\nA\t06-templates/template-daily-note.md\nA\t07-system/taxonomy/approved-tags.md')"
  if [ -n "$staged_changes" ] && [ "$staged_changes" != "$expected_changes" ]; then
    fail "staged vault changes must be exactly the five bootstrap support files"
  fi

  unstaged_tracked_changes="$(git -C "$VAULT_PATH" diff --name-status --)"
  [ -z "$unstaged_tracked_changes" ] || fail "tracked vault files have unstaged changes"
fi

assert_contains "07-system/taxonomy/approved-tags.md" "# approved-tags"
assert_contains "07-system/taxonomy/approved-tags.md" "AI may apply only tags listed here."
assert_contains "07-system/taxonomy/approved-tags.md" "If a useful topical tag is missing, AI reports a new-tag proposal in chat."
assert_contains "06-templates/daily-note.md" "## notes"
assert_contains "06-templates/daily-note.md" "## research"
assert_contains "06-templates/template-daily-note.md" "## notes"
assert_contains "06-templates/template-daily-note.md" "## research"
assert_contains "06-templates/project-note.md" "# project-name"
assert_contains "06-templates/source-note.md" "# source-title"

for migrated in \
  "Archive" \
  "Areas" \
  "Broad Topics" \
  "Projects" \
  "Resources" \
  "Templates"; do
  [ -e "$VAULT_PATH/$migrated" ] || fail "existing vault path missing after bootstrap: $migrated"
done
