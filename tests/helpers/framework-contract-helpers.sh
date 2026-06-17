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

managed_project_skills() {
  node -e 'const m = require(process.argv[1]); console.log(m.projectSkills.join(" "))' "$ROOT/config/managed-skills.json"
}

managed_copilot_skills() {
  node -e 'const m = require(process.argv[1]); console.log(m.copilotSkills.join(" "))' "$ROOT/config/managed-skills.json"
}

global_launcher_skills() {
  node -e 'const m = require(process.argv[1]); console.log(Object.keys(m).sort().join(" "))' "$ROOT/config/global-skill-launchers.json"
}

make_temp_framework() {
  local dir="$1"
  local skill
  mkdir -p "$dir"/{config,docs,agents,.codex/skills,.github/skills,.github/instructions,global-skills,templates,taxonomy,scripts,src,tests/fixtures,indexes}
  cp "$ROOT/.gitignore" "$dir/.gitignore"
  cp "$ROOT/package.json" "$dir/package.json"
  cp "$ROOT/package-lock.json" "$dir/package-lock.json"
  cp "$ROOT/tsconfig.json" "$dir/tsconfig.json"
  cp "$ROOT/README.md" "$dir/README.md"
  cp "$ROOT/install.sh" "$dir/install.sh"
  cp "$ROOT/config/conventions.json" "$dir/config/conventions.json"
  cp "$ROOT/config/copilot-mcp-tools.json" "$dir/config/copilot-mcp-tools.json"
  cp "$ROOT/config/framework-validation.json" "$dir/config/framework-validation.json"
  cp "$ROOT/config/global-skill-launchers.json" "$dir/config/global-skill-launchers.json"
  cp "$ROOT/config/managed-skills.json" "$dir/config/managed-skills.json"
  cp "$ROOT/config/runtime.json" "$dir/config/runtime.json"
  cp "$ROOT/config/vault-bootstrap-validation.json" "$dir/config/vault-bootstrap-validation.json"
  cp "$ROOT/config/vault.json" "$dir/config/vault.json"
  cp "$ROOT/docs/conventions.md" "$dir/docs/conventions.md"
  cp "$ROOT/docs/git-review-workflow.md" "$dir/docs/git-review-workflow.md"
  cp "$ROOT"/agents/*.md "$dir/agents/"
  cp "$ROOT"/src/*.ts "$dir/src/"
  node "$ROOT/scripts/check-copilot-mcp-tools.mjs" >/dev/null
  mkdir -p "$dir/dist"
  cp "$ROOT/dist/mcp-tool-registry.js" "$dir/dist/mcp-tool-registry.js"
  cp "$ROOT"/templates/*.md "$dir/templates/"
  cp "$ROOT/scripts/install.mjs" "$dir/scripts/install.mjs"
  cp "$ROOT/scripts/validate-framework.mjs" "$dir/scripts/validate-framework.mjs"
  cp "$ROOT/scripts/validate-vault-bootstrap.mjs" "$dir/scripts/validate-vault-bootstrap.mjs"
  cp "$ROOT/scripts/check-copilot-mcp-tools.mjs" "$dir/scripts/check-copilot-mcp-tools.mjs"
  cp "$ROOT/scripts/check-global-skill-launchers.mjs" "$dir/scripts/check-global-skill-launchers.mjs"
  cp "$ROOT/taxonomy/approved-tags.md" "$dir/taxonomy/approved-tags.md"
  cp "$ROOT/tests/package-foundation.test.mjs" "$dir/tests/package-foundation.test.mjs"
  for skill in $(managed_project_skills); do
    mkdir -p "$dir/.codex/skills/$skill"
    cp "$ROOT/.codex/skills/$skill/SKILL.md" "$dir/.codex/skills/$skill/SKILL.md"
  done
  cp "$ROOT/.github/copilot-instructions.md" "$dir/.github/copilot-instructions.md"
  cp "$ROOT"/.github/instructions/*.instructions.md "$dir/.github/instructions/"
  for skill in $(managed_copilot_skills); do
    mkdir -p "$dir/.github/skills/$skill"
    cp "$ROOT/.github/skills/$skill/SKILL.md" "$dir/.github/skills/$skill/SKILL.md"
  done
  for skill in $(global_launcher_skills); do
    mkdir -p "$dir/global-skills/$skill"
    cp "$ROOT/global-skills/$skill/SKILL.md" "$dir/global-skills/$skill/SKILL.md"
  done
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
