#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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
  grep -Fq "$text" "$ROOT/$path" || fail "$path does not contain: $text"
}

assert_not_contains() {
  local path="$1"
  local text="$2"
  if grep -Fq "$text" "$ROOT/$path"; then
    fail "$path unexpectedly contains: $text"
  fi
}

assert_command_fails() {
  local command="$1"
  if bash -c "$command" >/tmp/dreamers-note-test.out 2>/tmp/dreamers-note-test.err; then
    fail "expected command to fail: $command"
  fi
}

assert_command_exists() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name"
}

assert_node_dependencies_ready() {
  assert_command_exists npm
  [ -d "$ROOT/node_modules" ] || fail "missing node_modules; run npm install before tests/test-framework.sh"
}

assert_contains README.md "/home/cjstorrs/obsidian/cyborg"
assert_contains README.md "installed into the configured vault under"
assert_contains README.md "Skills and helper scripts read this config by default."
assert_contains README.md "chat-first"
assert_contains README.md "git diff"
assert_contains README.md "approved topical tags"
assert_contains README.md "skills as phase-gated runs"
assert_contains README.md "agents as narrow role contracts"
assert_contains README.md "Install Global Skill Launchers"
assert_contains README.md "./install.sh --dry-run"
assert_contains README.md '$dreamers-note'
assert_contains README.md "python3 scripts/propose-daily-triage.py"
assert_contains README.md 'every Markdown daily note under `00-inbox/daily-notes`'
assert_contains templates/template-daily-note.md "## notes"
assert_contains templates/template-daily-note.md "## research"

assert_contains docs/conventions.md "lowercase kebab-case"
assert_contains docs/conventions.md "date prefixes only where chronology matters"
assert_contains docs/conventions.md "topical tags"
assert_contains docs/conventions.md "notes.md"
assert_contains docs/conventions.md "misc.md"
assert_contains docs/conventions.md 'daily notes: `00-inbox/daily-notes/yyyy-mm-dd.md`'
assert_contains docs/conventions.md 'inbox captures: `yyyy-mm-dd-hhmm-short-title.md`'
assert_contains docs/conventions.md 'meetings: `yyyy-mm-dd-meeting-topic.md`'
assert_contains docs/conventions.md 'sources: `author-year-short-title.md`'
assert_contains docs/conventions.md 'projects: `01-projects/<main>/<sub>/<project-note>.md`'
assert_contains docs/conventions.md 'knowledge notes: `02-knowledge/<main>/<sub>/clear-noun-phrase.md`'
assert_contains docs/conventions.md 'people: `04-people/<main>/<sub>/first-last.md`'
assert_contains docs/conventions.md 'templates: `template-purpose.md`'
assert_contains docs/conventions.md 'AI-generated branch changes: branch names use `feat/short-kebab-description`'
assert_contains docs/conventions.md "agent's role, allowed actions or tools, handoffs, and forbidden actions"
assert_contains docs/conventions.md "phase-gated run"
assert_contains docs/conventions.md "which agent is called in the correct context"
assert_not_contains docs/conventions.md "status/raw"
assert_not_contains docs/conventions.md "kind/inbox"

assert_contains config/vault.json "\"vault_path\": \"/home/cjstorrs/obsidian/cyborg\""
assert_not_contains config/vault.json "framework_path"
assert_not_contains config/vault.json "proposal_mode"
assert_not_contains config/vault.json "skills_location"

for field in type status aliases created updated sensitivity processing_status agent_route review_required; do
  assert_contains docs/conventions.md "$field"
  assert_not_contains tests/fixtures/sample-note.md "$field:"
done

make_temp_framework() {
  local dir="$1"
  mkdir -p "$dir"/{config,docs,agents,.codex/skills/daily-capture,.codex/skills/daily-triage,.codex/skills/note-add,.codex/skills/note-import,.codex/skills/vault-normalization,.codex/skills/tag-steward,global-skills/dreamers-note,global-skills/dreamers-note-capture,global-skills/dreamers-note-import,templates,taxonomy,scripts,src,tests/fixtures}
  cp "$ROOT/.gitignore" "$dir/.gitignore"
  cp "$ROOT/package.json" "$dir/package.json"
  cp "$ROOT/package-lock.json" "$dir/package-lock.json"
  cp "$ROOT/tsconfig.json" "$dir/tsconfig.json"
  cp "$ROOT/README.md" "$dir/README.md"
  cp "$ROOT/install.sh" "$dir/install.sh"
  cp "$ROOT/config/conventions.json" "$dir/config/conventions.json"
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

for agent in librarian triage tag-steward; do
  file="agents/$agent.md"
  assert_contains "$file" "## Role"
  assert_contains "$file" "## Allowed Actions"
  assert_contains "$file" "## Handoffs"
  assert_contains "$file" "## Forbidden Actions"
done

bash "$ROOT/scripts/validate-framework.sh"

for skill in daily-capture daily-triage note-add note-import vault-normalization tag-steward; do
  head -n 1 "$ROOT/.codex/skills/$skill/SKILL.md" | grep -Fxq -- "---" || fail "$skill missing YAML frontmatter"
  assert_contains ".codex/skills/$skill/SKILL.md" "name: \"$skill\""
  assert_contains ".codex/skills/$skill/SKILL.md" "description: \""
  assert_contains ".codex/skills/$skill/SKILL.md" "## Phases"
  assert_contains ".codex/skills/$skill/SKILL.md" "## Agent Calls"
done

assert_file "global-skills/dreamers-note-capture/SKILL.md"
assert_file "global-skills/dreamers-note/SKILL.md"
assert_file "global-skills/dreamers-note-import/SKILL.md"
head -n 1 "$ROOT/global-skills/dreamers-note-capture/SKILL.md" | grep -Fxq -- "---" || fail "global launcher missing YAML frontmatter"
assert_contains "global-skills/dreamers-note-capture/SKILL.md" "This is a global launcher"
assert_contains "global-skills/dreamers-note-capture/SKILL.md" "/home/cjstorrs/obsidian/cyborg/.codex/skills/"
head -n 1 "$ROOT/global-skills/dreamers-note/SKILL.md" | grep -Fxq -- "---" || fail "global dreamers-note launcher missing YAML frontmatter"
assert_contains "global-skills/dreamers-note/SKILL.md" "This is a global launcher"
assert_contains "global-skills/dreamers-note/SKILL.md" "/home/cjstorrs/obsidian/cyborg/.codex/skills/"
head -n 1 "$ROOT/global-skills/dreamers-note-import/SKILL.md" | grep -Fxq -- "---" || fail "global import launcher missing YAML frontmatter"
assert_contains "global-skills/dreamers-note-import/SKILL.md" "This is a global launcher"
assert_contains "global-skills/dreamers-note-import/SKILL.md" "/home/cjstorrs/obsidian/cyborg/.codex/skills/"

temp_codex_home="$(mktemp -d)"
temp_install_vault="$(mktemp -d)"
mkdir -p "$temp_codex_home/skills/dreamers-note-add" "$temp_codex_home/skills/dreamers-note-triage" "$temp_codex_home/skills/unrelated-skill"
VAULT_PATH="$temp_install_vault" CODEX_HOME="$temp_codex_home" "$ROOT/install.sh" --dry-run
VAULT_PATH="$temp_install_vault" CODEX_HOME="$temp_codex_home" "$ROOT/install.sh"
grep -Fxq "daily-capture" "$temp_install_vault/.codex/skills/.dreamers-note-managed-skills" || fail "installer did not manage daily-capture"
grep -Fxq "daily-triage" "$temp_install_vault/.codex/skills/.dreamers-note-managed-skills" || fail "installer did not manage daily-triage"
grep -Fxq "note-add" "$temp_install_vault/.codex/skills/.dreamers-note-managed-skills" || fail "installer did not manage note-add"
grep -Fxq "note-import" "$temp_install_vault/.codex/skills/.dreamers-note-managed-skills" || fail "installer did not manage note-import"
grep -Fxq "tag-steward" "$temp_install_vault/.codex/skills/.dreamers-note-managed-skills" || fail "installer did not manage tag-steward"
grep -Fxq "vault-normalization" "$temp_install_vault/.codex/skills/.dreamers-note-managed-skills" || fail "installer did not manage vault-normalization"
[ -f "$temp_install_vault/.codex/skills/daily-capture/SKILL.md" ] || fail "installer did not copy daily-capture into vault"
[ -f "$temp_install_vault/.codex/skills/note-add/SKILL.md" ] || fail "installer did not copy note-add into vault"
[ -f "$temp_codex_home/skills/dreamers-note-capture/SKILL.md" ] || fail "installer did not create dreamers-note-capture"
[ -f "$temp_codex_home/skills/dreamers-note/SKILL.md" ] || fail "installer did not create dreamers-note"
[ ! -e "$temp_codex_home/skills/dreamers-note-add" ] || fail "installer did not remove stale dreamers-note-add launcher"
[ -f "$temp_codex_home/skills/dreamers-note-import/SKILL.md" ] || fail "installer did not create dreamers-note-import"
[ ! -e "$temp_codex_home/skills/dreamers-note-triage" ] || fail "installer created project-only triage launcher"
[ ! -e "$temp_codex_home/skills/dreamers-note-normalize" ] || fail "installer created project-only normalize launcher"
[ ! -e "$temp_codex_home/skills/dreamers-note-tags" ] || fail "installer created project-only tags launcher"
[ -e "$temp_codex_home/skills/unrelated-skill" ] || fail "installer removed unrelated skill"
grep -Fxq "dreamers-note-capture" "$temp_codex_home/skills/.dreamers-note-managed-skills" || fail "installer did not write managed skill manifest"
grep -Fxq "dreamers-note" "$temp_codex_home/skills/.dreamers-note-managed-skills" || fail "installer did not write dreamers-note skill manifest"
grep -Fxq "dreamers-note-import" "$temp_codex_home/skills/.dreamers-note-managed-skills" || fail "installer did not write import skill manifest"
mkdir -p "$temp_codex_home/skills/dreamers-note-old"
printf 'dreamers-note\ndreamers-note-capture\ndreamers-note-import\ndreamers-note-old\n' >"$temp_codex_home/skills/.dreamers-note-managed-skills"
VAULT_PATH="$temp_install_vault" CODEX_HOME="$temp_codex_home" "$ROOT/install.sh"
[ ! -e "$temp_codex_home/skills/dreamers-note-old" ] || fail "installer did not remove stale manifest skill"

temp_root="$(mktemp -d)"
make_temp_framework "$temp_root"
temp_project_vault="$(mktemp -d)"
mkdir -p "$temp_project_vault/.codex/skills/old-project-skill"
printf 'daily-capture\nold-project-skill\n' >"$temp_project_vault/.codex/skills/.dreamers-note-managed-skills"
VAULT_PATH="$temp_project_vault" CODEX_HOME="$(mktemp -d)" "$temp_root/install.sh"
[ ! -e "$temp_project_vault/.codex/skills/old-project-skill" ] || fail "installer did not remove stale project skill"
grep -Fxq "note-import" "$temp_project_vault/.codex/skills/.dreamers-note-managed-skills" || fail "installer did not rewrite note-import project skill manifest"
grep -Fxq "note-add" "$temp_project_vault/.codex/skills/.dreamers-note-managed-skills" || fail "installer did not rewrite note-add project skill manifest"
grep -Fxq "vault-normalization" "$temp_project_vault/.codex/skills/.dreamers-note-managed-skills" || fail "installer did not rewrite project skill manifest"

assert_contains .codex/skills/daily-triage/SKILL.md "Call agent: triage"
assert_contains .codex/skills/daily-triage/SKILL.md "Call agent: tag-steward"
assert_contains .codex/skills/daily-triage/SKILL.md "Call agent: librarian"
assert_contains .codex/skills/daily-triage/SKILL.md "Archive each processed daily note"
assert_contains .codex/skills/daily-triage/SKILL.md "Discover all Markdown daily notes"
assert_contains .codex/skills/daily-triage/SKILL.md "durable destination"
assert_contains .codex/skills/note-add/SKILL.md "Search for existing-note candidates before inventing a new path"
assert_contains .codex/skills/note-add/SKILL.md "Stop after the proposal and wait for user approval"
assert_contains .codex/skills/note-add/SKILL.md "Call agent: librarian"
assert_contains .codex/skills/note-add/SKILL.md "Call agent: tag-steward"
assert_contains .codex/skills/note-import/SKILL.md "~/Desktop/linux.md"
assert_contains .codex/skills/note-import/SKILL.md "Do not delete, move, or rewrite the original source file"
assert_contains .codex/skills/note-import/SKILL.md "Call agent: librarian"
assert_contains .codex/skills/note-import/SKILL.md "Call agent: tag-steward"
assert_contains .codex/skills/vault-normalization/SKILL.md "Call agent: librarian"
assert_contains .codex/skills/vault-normalization/SKILL.md "scripts/propose-vault-normalization.py"
assert_contains .codex/skills/vault-normalization/SKILL.md "dry-run"
assert_contains .codex/skills/vault-normalization/SKILL.md "must_read_file: true"
assert_contains .codex/skills/vault-normalization/SKILL.md "Call agent: librarian for ambiguous destination, split, merge, or link decisions"
assert_contains .codex/skills/vault-normalization/SKILL.md '"reviewed_scope":["placement","tags","links","content"]'
assert_contains .codex/skills/tag-steward/SKILL.md "Call agent: tag-steward"

assert_file scripts/validate-vault-bootstrap.sh
assert_file scripts/propose-daily-triage.py
assert_file scripts/propose-vault-normalization.py
assert_file scripts/build-vault-inventory.py
assert_file scripts/apply-vault-remap.py
assert_file scripts/vault_remap_common.py
assert_dir indexes
python3 "$ROOT/tests/test-daily-triage.py"
python3 "$ROOT/tests/test-vault-normalization.py"
python3 "$ROOT/tests/test-vault-remap.py"
assert_node_dependencies_ready
npm run typecheck
npm test

temp_vault="$(mktemp -d)"
make_temp_vault "$temp_vault"
VAULT_PATH="$temp_vault" bash "$ROOT/scripts/validate-vault-bootstrap.sh"

temp_vault="$(mktemp -d)"
make_temp_vault "$temp_vault"
mkdir -p "$temp_vault/.ai"
printf 'unexpected\n' >"$temp_vault/.ai/log.md"
git -C "$temp_vault" add .ai/log.md
assert_command_fails "VAULT_PATH='$temp_vault' bash '$ROOT/scripts/validate-vault-bootstrap.sh'"

temp_vault="$(mktemp -d)"
make_temp_vault "$temp_vault"
printf 'changed\n' >>"$temp_vault/Archive/existing-note.md"
git -C "$temp_vault" add Archive/existing-note.md
assert_command_fails "VAULT_PATH='$temp_vault' bash '$ROOT/scripts/validate-vault-bootstrap.sh'"

temp_vault="$(mktemp -d)"
make_temp_vault "$temp_vault"
printf '\n- extra-topic\n' >>"$temp_vault/07-system/taxonomy/approved-tags.md"
git -C "$temp_vault" add 07-system/taxonomy/approved-tags.md
assert_command_fails "VAULT_PATH='$temp_vault' bash '$ROOT/scripts/validate-vault-bootstrap.sh'"

for heading in "## Purpose" "## Inputs" "## Allowed Paths" "## Forbidden Actions" "## Phases" "## Agent Calls" "## Output Format" "## Review Expectations"; do
  temp_root="$(mktemp -d)"
  make_temp_framework "$temp_root"
  sed -i "\\|$heading|d" "$temp_root/.codex/skills/daily-capture/SKILL.md"
  assert_command_fails "FRAMEWORK_ROOT='$temp_root' bash '$ROOT/scripts/validate-framework.sh'"
done
