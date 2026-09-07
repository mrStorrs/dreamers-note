#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers/framework-contract-helpers.sh"

expected='note-add note-import note-daily-triage note-review note-vault-refactor'
[ "$(managed_skills)" = "$expected" ] || fail "managed skill config does not contain the five canonical names"

actual="$(find "$ROOT/.codex/skills" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | paste -sd ' ' -)"
expected_directories='note-add note-daily-triage note-import note-review note-vault-refactor'
[ "$actual" = "$expected_directories" ] || fail "canonical skill source contains unexpected directories: $actual"

for skill in $expected; do
  file=".codex/skills/$skill/SKILL.md"
  assert_file "$file"
  head -n 1 "$ROOT/$file" | grep -Fxq -- "---" || fail "$skill missing YAML frontmatter"
  assert_contains "$file" "name: \"$skill\""
  assert_contains "$file" "description: \""
  assert_contains "$file" "note-workflow-policy.md"
  assert_contains "$file" "change create"
  assert_contains "$file" "change show"
  assert_not_contains "$file" "workflow_ready"
  assert_not_contains "$file" "proposal_authorize"
  assert_not_contains "$file" "proposal_apply"
done

assert_contains .codex/skills/note-add/SKILL.md "quick capture"
assert_contains .codex/skills/note-add/SKILL.md "Stop for explicit user approval"
assert_contains .codex/skills/note-add/SKILL.md "change apply --id <id> --revision <sha256>"

assert_contains .codex/skills/note-import/SKILL.md "Preserve the source file"
assert_contains .codex/skills/note-import/SKILL.md "Stop for explicit approval"
assert_contains .codex/skills/note-import/SKILL.md "external source remains unchanged"

assert_contains .codex/skills/note-daily-triage/SKILL.md "same atomic change"
assert_contains .codex/skills/note-daily-triage/SKILL.md "--archive-check"
assert_contains .codex/skills/note-daily-triage/SKILL.md "Stop for explicit user approval"

assert_contains .codex/skills/note-review/SKILL.md "Resolve exactly one vault-relative note"
assert_contains .codex/skills/note-review/SKILL.md "It is read-only"
assert_contains .codex/skills/note-review/SKILL.md "Never apply it as part of this skill"
assert_contains .codex/skills/note-review/SKILL.md "reviewer_attention"

assert_contains .codex/skills/note-vault-refactor/SKILL.md "explicit vault scope and branch"
assert_contains .codex/skills/note-vault-refactor/SKILL.md "Workers are read-only"
assert_contains .codex/skills/note-vault-refactor/SKILL.md "reviewer_attention"
assert_contains .codex/skills/note-vault-refactor/SKILL.md "not_applied"
assert_contains .codex/skills/note-vault-refactor/SKILL.md "change apply --id <id> --revision <sha256>"

for path in agents .github/skills global-skills .codex/skills/daily-capture .codex/skills/daily-triage .codex/skills/tag-steward .codex/skills/vault-normalization .codex/skills/vault-refactor; do
  assert_absent "$path"
done

for file in \
  .codex/skills/note-add/agents/openai.yaml \
  .codex/skills/note-daily-triage/agents/openai.yaml \
  .codex/skills/note-review/agents/openai.yaml \
  .codex/skills/note-vault-refactor/agents/openai.yaml; do
  assert_file "$file"
  assert_contains "$file" "display_name:"
  assert_contains "$file" "default_prompt:"
done

temp_root="$(mktemp -d)"
trap 'rm -rf "$temp_root"' EXIT
make_temp_framework "$temp_root"
printf '\nMCP legacy text\n' >>"$temp_root/.codex/skills/note-add/SKILL.md"
assert_command_fails "FRAMEWORK_ROOT='$temp_root' node '$ROOT/scripts/validate-framework.mjs'"
