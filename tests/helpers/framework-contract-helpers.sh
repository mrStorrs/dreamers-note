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

assert_absent() {
  local path="$1"
  [ ! -e "$ROOT/$path" ] || fail "unexpected path: $path"
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

managed_skills() {
  node -e 'const m = require(process.argv[1]); console.log(m.skills.join(" "))' "$ROOT/config/managed-skills.json"
}

make_temp_framework() {
  local dir="$1"
  mkdir -p "$dir"/{config,docs,.codex/skills,.github/instructions,taxonomy,templates,scripts,src,tests/fixtures}
  cp "$ROOT/.gitignore" "$dir/.gitignore"
  cp "$ROOT/AGENTS.md" "$dir/AGENTS.md"
  cp "$ROOT/README.md" "$dir/README.md"
  cp "$ROOT/bootstrap.sh" "$dir/bootstrap.sh"
  cp "$ROOT/bootstrap.ps1" "$dir/bootstrap.ps1"
  cp "$ROOT/install.sh" "$dir/install.sh"
  cp "$ROOT/package.json" "$dir/package.json"
  cp "$ROOT/package-lock.json" "$dir/package-lock.json"
  cp "$ROOT/tsconfig.json" "$dir/tsconfig.json"
  cp "$ROOT/config/conventions.json" "$dir/config/conventions.json"
  cp "$ROOT/config/framework-validation.json" "$dir/config/framework-validation.json"
  cp "$ROOT/config/managed-skills.json" "$dir/config/managed-skills.json"
  cp "$ROOT/config/runtime.json" "$dir/config/runtime.json"
  cp "$ROOT/config/vault-bootstrap-validation.json" "$dir/config/vault-bootstrap-validation.json"
  cp "$ROOT/config/vault.example.json" "$dir/config/vault.example.json"
  cp "$ROOT/docs/conventions.md" "$dir/docs/conventions.md"
  cp "$ROOT/docs/git-review-workflow.md" "$dir/docs/git-review-workflow.md"
  cp "$ROOT/docs/note-workflow-policy.md" "$dir/docs/note-workflow-policy.md"
  cp "$ROOT/.github/copilot-instructions.md" "$dir/.github/copilot-instructions.md"
  cp "$ROOT/.github/instructions/dreamers-note.instructions.md" "$dir/.github/instructions/dreamers-note.instructions.md"
  cp -R "$ROOT/.codex/skills/." "$dir/.codex/skills/"
  cp -R "$ROOT/src/." "$dir/src/"
  cp "$ROOT/taxonomy/approved-tags.md" "$dir/taxonomy/approved-tags.md"
  cp "$ROOT"/templates/*.md "$dir/templates/"
  cp "$ROOT/scripts/install.mjs" "$dir/scripts/install.mjs"
  cp "$ROOT/scripts/validate-framework.mjs" "$dir/scripts/validate-framework.mjs"
  cp "$ROOT/scripts/validate-framework.sh" "$dir/scripts/validate-framework.sh"
  cp "$ROOT/scripts/validate-vault-bootstrap.mjs" "$dir/scripts/validate-vault-bootstrap.mjs"
  cp "$ROOT/scripts/validate-vault-bootstrap.sh" "$dir/scripts/validate-vault-bootstrap.sh"
  if [ -f "$ROOT/dist/cli.js" ]; then
    mkdir -p "$dir/dist"
    cp "$ROOT/dist/cli.js" "$dir/dist/cli.js"
  fi
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
