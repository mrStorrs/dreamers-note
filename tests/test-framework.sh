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

assert_contains README.md "<local-home>/obsidian/cyborg"
assert_contains README.md "skills live in dreamers-note"
assert_contains README.md "chat-first"
assert_contains README.md "git diff"
assert_contains README.md "approved topical tags"
assert_contains README.md "skills as phase-gated runs"
assert_contains README.md "agents as narrow role contracts"

assert_contains docs/conventions.md "lowercase kebab-case"
assert_contains docs/conventions.md "date prefixes only where chronology matters"
assert_contains docs/conventions.md "topical tags"
assert_contains docs/conventions.md "notes.md"
assert_contains docs/conventions.md "misc.md"
assert_contains docs/conventions.md 'daily notes: `yyyy-mm-dd.md`'
assert_contains docs/conventions.md 'inbox captures: `yyyy-mm-dd-hhmm-short-title.md`'
assert_contains docs/conventions.md 'meetings: `yyyy-mm-dd-meeting-topic.md`'
assert_contains docs/conventions.md 'sources: `author-year-short-title.md`'
assert_contains docs/conventions.md 'projects: `project-short-name.md`'
assert_contains docs/conventions.md 'concepts: `clear-noun-phrase.md`'
assert_contains docs/conventions.md 'people: `first-last.md` or `organization-name.md`'
assert_contains docs/conventions.md 'templates: `template-purpose.md`'
assert_contains docs/conventions.md 'AI-generated branch changes: branch names use `feat/short-kebab-description`'
assert_contains docs/conventions.md "agent's role, allowed actions or tools, handoffs, and forbidden actions"
assert_contains docs/conventions.md "phase-gated run"
assert_contains docs/conventions.md "which agent is called in the correct context"
assert_not_contains docs/conventions.md "status/raw"
assert_not_contains docs/conventions.md "kind/inbox"

assert_contains config/vault.json "\"vault_path\": \"<local-home>/obsidian/cyborg\""
assert_not_contains config/vault.json "framework_path"
assert_not_contains config/vault.json "proposal_mode"
assert_not_contains config/vault.json "skills_location"

for field in type status aliases created updated sensitivity processing_status agent_route review_required; do
  assert_contains docs/conventions.md "$field"
  assert_not_contains tests/fixtures/sample-note.md "$field:"
done

make_temp_framework() {
  local dir="$1"
  mkdir -p "$dir"/{config,docs,agents,skills/daily-capture,skills/daily-triage,skills/vault-normalization,skills/tag-steward,templates,taxonomy,scripts,tests/fixtures}
  cp "$ROOT/README.md" "$dir/README.md"
  cp "$ROOT/config/vault.json" "$dir/config/vault.json"
  cp "$ROOT/docs/conventions.md" "$dir/docs/conventions.md"
  cp "$ROOT/docs/git-review-workflow.md" "$dir/docs/git-review-workflow.md"
  cp "$ROOT"/agents/*.md "$dir/agents/"
  cp "$ROOT"/templates/*.md "$dir/templates/"
  cp "$ROOT/taxonomy/approved-tags.md" "$dir/taxonomy/approved-tags.md"
  cp "$ROOT/skills/daily-capture/SKILL.md" "$dir/skills/daily-capture/SKILL.md"
  cp "$ROOT/skills/daily-triage/SKILL.md" "$dir/skills/daily-triage/SKILL.md"
  cp "$ROOT/skills/vault-normalization/SKILL.md" "$dir/skills/vault-normalization/SKILL.md"
  cp "$ROOT/skills/tag-steward/SKILL.md" "$dir/skills/tag-steward/SKILL.md"
}

make_temp_vault() {
  local dir="$1"
  mkdir -p "$dir/Archive" "$dir/Areas" "$dir/Broad Topics" "$dir/Projects" "$dir/Resources" "$dir/Templates"
  printf 'existing note\n' >"$dir/Archive/existing-note.md"
  git -C "$dir" init -q
  git -C "$dir" add Archive/existing-note.md
  git -C "$dir" -c user.name='dreamers-test' -c user.email='dreamers-test@example.invalid' commit -qm 'baseline'

  mkdir -p "$dir/07-templates" "$dir/08-system/taxonomy"
  cp "$ROOT/taxonomy/approved-tags.md" "$dir/08-system/taxonomy/approved-tags.md"
  printf '# {{date}}\n\n## capture\n\n\n## follow-up\n' >"$dir/07-templates/daily-note.md"
  printf '# project-name\n\n## outcome\n\n\n## notes\n\n\n## links\n' >"$dir/07-templates/project-note.md"
  printf '# source-title\n\n## reference\n\n\n## notes\n\n\n## links\n' >"$dir/07-templates/source-note.md"
  git -C "$dir" add 07-templates/daily-note.md 07-templates/project-note.md 07-templates/source-note.md 08-system/taxonomy/approved-tags.md
}

for agent in librarian triage tag-steward; do
  file="agents/$agent.md"
  assert_contains "$file" "## Role"
  assert_contains "$file" "## Allowed Actions"
  assert_contains "$file" "## Handoffs"
  assert_contains "$file" "## Forbidden Actions"
done

bash "$ROOT/scripts/validate-framework.sh"

for skill in daily-capture daily-triage vault-normalization tag-steward; do
  assert_contains "skills/$skill/SKILL.md" "## Phases"
  assert_contains "skills/$skill/SKILL.md" "## Agent Calls"
done

assert_contains skills/daily-triage/SKILL.md "Call agent: triage"
assert_contains skills/daily-triage/SKILL.md "Call agent: tag-steward"
assert_contains skills/daily-triage/SKILL.md "Call agent: librarian"
assert_contains skills/daily-triage/SKILL.md "Archive each processed daily note"
assert_contains skills/daily-triage/SKILL.md "durable destination"
assert_contains skills/vault-normalization/SKILL.md "Call agent: librarian"
assert_contains skills/vault-normalization/SKILL.md "scripts/propose-vault-normalization.py"
assert_contains skills/vault-normalization/SKILL.md "dry-run"
assert_contains skills/vault-normalization/SKILL.md "proposal of record"
assert_contains skills/vault-normalization/SKILL.md "Call agent: librarian only for ambiguous rename or move decisions"
assert_contains skills/tag-steward/SKILL.md "Call agent: tag-steward"

assert_file scripts/validate-vault-bootstrap.sh
assert_file scripts/propose-vault-normalization.py
python3 "$ROOT/tests/test-vault-normalization.py"

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
printf '\n- extra-topic\n' >>"$temp_vault/08-system/taxonomy/approved-tags.md"
git -C "$temp_vault" add 08-system/taxonomy/approved-tags.md
assert_command_fails "VAULT_PATH='$temp_vault' bash '$ROOT/scripts/validate-vault-bootstrap.sh'"

for heading in "## Purpose" "## Inputs" "## Allowed Paths" "## Forbidden Actions" "## Phases" "## Agent Calls" "## Output Format" "## Review Expectations"; do
  temp_root="$(mktemp -d)"
  make_temp_framework "$temp_root"
  sed -i "\\|$heading|d" "$temp_root/skills/daily-capture/SKILL.md"
  assert_command_fails "FRAMEWORK_ROOT='$temp_root' bash '$ROOT/scripts/validate-framework.sh'"
done
