#!/usr/bin/env bash

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_file() {
  local path="$1"
  [ -f "$ROOT/$path" ] || fail "missing file: $path"
}

assert_dir() {
  local path="$1"
  [ -d "$ROOT/$path" ] || fail "missing directory: $path"
}

assert_contains() {
  local path="$1"
  local text="$2"
  grep -Fq -- "$text" "$ROOT/$path" || fail "$path does not contain: $text"
}

assert_not_contains() {
  local path="$1"
  local text="$2"
  if grep -Fq -- "$text" "$ROOT/$path"; then
    fail "$path unexpectedly contains: $text"
  fi
}

assert_command_fails() {
  local command="$1"
  if bash -c "$command" >/tmp/dreamers-note-test.out 2>/tmp/dreamers-note-test.err; then
    fail "expected command to fail: $command"
  fi
}

make_temp_framework() {
  local dir="$1"
  mkdir -p "$dir"/{config,docs,agents,.codex/skills/daily-capture,.codex/skills/daily-triage,.codex/skills/note-add,.codex/skills/note-import,.codex/skills/vault-normalization,.codex/skills/tag-steward,.github/skills/daily-capture,.github/skills/daily-triage,.github/skills/note-add,.github/skills/note-import,.github/skills/vault-normalization,.github/skills/tag-steward,.github/instructions,global-skills/dreamers-note,global-skills/dreamers-note-capture,global-skills/dreamers-note-import,templates,taxonomy,scripts,src,tests/fixtures}
  cp "$ROOT/.gitignore" "$dir/.gitignore"
  cp "$ROOT/package.json" "$dir/package.json"
  cp "$ROOT/package-lock.json" "$dir/package-lock.json"
  cp "$ROOT/tsconfig.json" "$dir/tsconfig.json"
  cp "$ROOT/README.md" "$dir/README.md"
  cp "$ROOT/install.sh" "$dir/install.sh"
  cp "$ROOT/config/conventions.json" "$dir/config/conventions.json"
  cp "$ROOT/config/copilot-mcp-tools.json" "$dir/config/copilot-mcp-tools.json"
  cp "$ROOT/config/runtime.json" "$dir/config/runtime.json"
  cp "$ROOT/config/vault.json" "$dir/config/vault.json"
  cp "$ROOT/docs/conventions.md" "$dir/docs/conventions.md"
  cp "$ROOT/docs/git-review-workflow.md" "$dir/docs/git-review-workflow.md"
  cp "$ROOT"/agents/*.md "$dir/agents/"
  cp "$ROOT"/src/*.ts "$dir/src/"
  cp "$ROOT"/templates/*.md "$dir/templates/"
  cp "$ROOT/taxonomy/approved-tags.md" "$dir/taxonomy/approved-tags.md"
  cp "$ROOT/tests/package-foundation.test.mjs" "$dir/tests/package-foundation.test.mjs"
  cp "$ROOT/.codex/skills/daily-capture/SKILL.md" "$dir/.codex/skills/daily-capture/SKILL.md"
  cp "$ROOT/.codex/skills/daily-triage/SKILL.md" "$dir/.codex/skills/daily-triage/SKILL.md"
  cp "$ROOT/.codex/skills/note-add/SKILL.md" "$dir/.codex/skills/note-add/SKILL.md"
  cp "$ROOT/.codex/skills/note-import/SKILL.md" "$dir/.codex/skills/note-import/SKILL.md"
  cp "$ROOT/.codex/skills/vault-normalization/SKILL.md" "$dir/.codex/skills/vault-normalization/SKILL.md"
  cp "$ROOT/.codex/skills/tag-steward/SKILL.md" "$dir/.codex/skills/tag-steward/SKILL.md"
  cp "$ROOT/.github/copilot-instructions.md" "$dir/.github/copilot-instructions.md"
  cp "$ROOT"/.github/instructions/*.instructions.md "$dir/.github/instructions/"
  cp "$ROOT/.github/skills/daily-capture/SKILL.md" "$dir/.github/skills/daily-capture/SKILL.md"
  cp "$ROOT/.github/skills/daily-triage/SKILL.md" "$dir/.github/skills/daily-triage/SKILL.md"
  cp "$ROOT/.github/skills/note-add/SKILL.md" "$dir/.github/skills/note-add/SKILL.md"
  cp "$ROOT/.github/skills/note-import/SKILL.md" "$dir/.github/skills/note-import/SKILL.md"
  cp "$ROOT/.github/skills/vault-normalization/SKILL.md" "$dir/.github/skills/vault-normalization/SKILL.md"
  cp "$ROOT/.github/skills/tag-steward/SKILL.md" "$dir/.github/skills/tag-steward/SKILL.md"
  cp "$ROOT"/global-skills/dreamers-note-capture/SKILL.md "$dir/global-skills/dreamers-note-capture/SKILL.md"
  cp "$ROOT"/global-skills/dreamers-note/SKILL.md "$dir/global-skills/dreamers-note/SKILL.md"
  cp "$ROOT"/global-skills/dreamers-note-import/SKILL.md "$dir/global-skills/dreamers-note-import/SKILL.md"
}

make_temp_vault() {
  local dir="$1"
  mkdir -p "$dir/Archive" "$dir/Areas" "$dir/Broad Topics" "$dir/Projects" "$dir/Resources" "$dir/Templates"
  printf 'existing note\n' >"$dir/Archive/existing-note.md"
  git -C "$dir" init -q
  git -C "$dir" add Archive/existing-note.md
  git -C "$dir" -c user.name='dreamers-test' -c user.email='dreamers-test@example.invalid' commit -qm 'baseline'

  mkdir -p "$dir/06-templates" "$dir/07-system/taxonomy"
  cp "$ROOT/taxonomy/approved-tags.md" "$dir/07-system/taxonomy/approved-tags.md"
  cp "$ROOT/templates/template-daily-note.md" "$dir/06-templates/daily-note.md"
  cp "$ROOT/templates/template-daily-note.md" "$dir/06-templates/template-daily-note.md"
  printf '# project-name\n\n## outcome\n\n\n## notes\n\n\n## links\n' >"$dir/06-templates/project-note.md"
  printf '# source-title\n\n## reference\n\n\n## notes\n\n\n## links\n' >"$dir/06-templates/source-note.md"
  git -C "$dir" add 06-templates/daily-note.md 06-templates/template-daily-note.md 06-templates/project-note.md 06-templates/source-note.md 07-system/taxonomy/approved-tags.md
}
