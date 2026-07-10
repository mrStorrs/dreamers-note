#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers/framework-contract-helpers.sh"

for agent in librarian triage tag-steward; do
  file="agents/$agent.md"
  assert_contains "$file" "## Role"
  assert_contains "$file" "## Allowed Actions"
  assert_contains "$file" "## Handoffs"
  assert_contains "$file" "## Forbidden Actions"
done

assert_file "config/managed-skills.json"

for skill in $(managed_project_skills); do
  head -n 1 "$ROOT/.codex/skills/$skill/SKILL.md" | grep -Fxq -- "---" || fail "$skill missing YAML frontmatter"
  assert_contains ".codex/skills/$skill/SKILL.md" "name: \"$skill\""
  assert_contains ".codex/skills/$skill/SKILL.md" "description: \""
  assert_contains ".codex/skills/$skill/SKILL.md" "## Phases"
  assert_contains ".codex/skills/$skill/SKILL.md" "## Agent Calls"
done

assert_file "global-skills/dreamers-note-capture/SKILL.md"
assert_file "global-skills/dreamers-note/SKILL.md"
assert_file "global-skills/dreamers-note-import/SKILL.md"
assert_file "global-skills/dreamers-note-review/SKILL.md"
assert_file "global-skills/dreamers-note-refactor/SKILL.md"
assert_file "config/global-skill-launchers.json"
assert_file "scripts/check-global-skill-launchers.mjs"
node "$ROOT/scripts/check-global-skill-launchers.mjs"
temp_root="$(mktemp -d)"
make_temp_framework "$temp_root"
mkdir -p "$temp_root/global-skills/dreamers-note-old"
printf 'old launcher\n' >"$temp_root/global-skills/dreamers-note-old/SKILL.md"
assert_command_fails "node '$temp_root/scripts/check-global-skill-launchers.mjs'"
head -n 1 "$ROOT/global-skills/dreamers-note-capture/SKILL.md" | grep -Fxq -- "---" || fail "global launcher missing YAML frontmatter"
assert_contains "global-skills/dreamers-note-capture/SKILL.md" "target_skill_path:"
assert_contains "global-skills/dreamers-note-capture/SKILL.md" "workflow_id: capture"
assert_contains "global-skills/dreamers-note-capture/SKILL.md" "payload_mapping:"
assert_contains "global-skills/dreamers-note-capture/SKILL.md" "reporting_fields:"
assert_not_contains "global-skills/dreamers-note-capture/SKILL.md" "workflow_ready"
assert_not_contains "global-skills/dreamers-note-capture/SKILL.md" "context_pack"
head -n 1 "$ROOT/global-skills/dreamers-note/SKILL.md" | grep -Fxq -- "---" || fail "global dreamers-note launcher missing YAML frontmatter"
assert_contains "global-skills/dreamers-note/SKILL.md" "target_skill_path:"
assert_contains "global-skills/dreamers-note/SKILL.md" "workflow_id: add"
assert_contains "global-skills/dreamers-note/SKILL.md" "payload_mapping:"
assert_contains "global-skills/dreamers-note/SKILL.md" "reporting_fields:"
assert_not_contains "global-skills/dreamers-note/SKILL.md" "workflow_ready"
assert_not_contains "global-skills/dreamers-note/SKILL.md" "context_pack"
head -n 1 "$ROOT/global-skills/dreamers-note-import/SKILL.md" | grep -Fxq -- "---" || fail "global import launcher missing YAML frontmatter"
assert_contains "global-skills/dreamers-note-import/SKILL.md" "target_skill_path:"
assert_contains "global-skills/dreamers-note-import/SKILL.md" "workflow_id: import"
assert_contains "global-skills/dreamers-note-import/SKILL.md" "payload_mapping:"
assert_contains "global-skills/dreamers-note-import/SKILL.md" "reporting_fields:"
assert_not_contains "global-skills/dreamers-note-import/SKILL.md" "workflow_ready"
assert_not_contains "global-skills/dreamers-note-import/SKILL.md" "context_pack"

assert_contains .codex/skills/daily-triage/SKILL.md "Call agent: triage"
assert_contains .codex/skills/daily-triage/SKILL.md "Call agent: tag-steward"
assert_contains .codex/skills/daily-triage/SKILL.md "Call agent: librarian"
assert_contains .codex/skills/daily-triage/SKILL.md "Archive each processed daily note"
assert_contains .codex/skills/daily-triage/SKILL.md "Discover all Markdown daily notes"
assert_contains .codex/skills/daily-triage/SKILL.md "durable destination"
assert_contains .codex/skills/daily-triage/SKILL.md "workflow_ready"
assert_contains .codex/skills/daily-triage/SKILL.md "context_pack"
assert_contains .codex/skills/daily-triage/SKILL.md "workflow_policy"
assert_contains .codex/skills/daily-triage/SKILL.md "proposal_create_note"
assert_contains .codex/skills/daily-triage/SKILL.md "proposal_create"
assert_contains .codex/skills/daily-triage/SKILL.md "bundle ID"
assert_contains .codex/skills/daily-triage/SKILL.md "MCP server is unavailable"
assert_contains .codex/skills/daily-triage/SKILL.md "dreamers-note://workflow-policy/triage"
assert_contains .codex/skills/note-add/SKILL.md "Search for existing-note candidates before inventing a new path"
assert_contains .codex/skills/note-add/SKILL.md "Stop after the proposal and wait for user approval"
assert_contains .codex/skills/note-add/SKILL.md "Call agent: librarian"
assert_contains .codex/skills/note-add/SKILL.md "Call agent: tag-steward"
assert_contains .codex/skills/note-add/SKILL.md "workflow_ready"
assert_contains .codex/skills/note-add/SKILL.md "context_pack"
assert_contains .codex/skills/note-add/SKILL.md "workflow_policy"
assert_contains .codex/skills/note-add/SKILL.md "proposal_create_note"
assert_contains .codex/skills/note-add/SKILL.md "fallbackSuggestions"
assert_contains .codex/skills/note-add/SKILL.md "MCP server is unavailable"
assert_contains .codex/skills/note-add/SKILL.md "dreamers-note://workflow-policy/add"
assert_contains .codex/skills/note-add/SKILL.md "do not start the body with an H1 or H2"
assert_contains .codex/skills/note-import/SKILL.md "~/Desktop/linux.md"
assert_contains .codex/skills/note-import/SKILL.md "workflow_ready"
assert_contains .codex/skills/note-import/SKILL.md "context_pack"
assert_contains .codex/skills/note-import/SKILL.md "workflow_policy"
assert_contains .codex/skills/note-import/SKILL.md "proposal_create_note"
assert_contains .codex/skills/note-import/SKILL.md "proposal_read"
assert_contains .codex/skills/note-import/SKILL.md "fallbackSuggestions"
assert_contains .codex/skills/note-import/SKILL.md "Do not delete, move, or rewrite the original source file"
assert_contains .codex/skills/note-import/SKILL.md "separate proposal"
assert_contains .codex/skills/note-import/SKILL.md "Call agent: librarian"
assert_contains .codex/skills/note-import/SKILL.md "Call agent: tag-steward"
assert_contains .codex/skills/note-import/SKILL.md "MCP server is unavailable"
assert_contains .codex/skills/note-import/SKILL.md "dreamers-note://workflow-policy/import"
assert_contains .codex/skills/note-import/SKILL.md "do not start the body with an H1 or H2"
assert_contains .codex/skills/vault-normalization/SKILL.md "Call agent: librarian"
assert_contains .codex/skills/vault-normalization/SKILL.md "scripts/propose-vault-normalization.py"
assert_contains .codex/skills/vault-normalization/SKILL.md "dry-run"
assert_contains .codex/skills/vault-normalization/SKILL.md "must_read_file: true"
assert_contains .codex/skills/vault-normalization/SKILL.md "Call agent: librarian for ambiguous destination, split, merge, or link decisions"
assert_contains .codex/skills/vault-normalization/SKILL.md '"reviewed_scope":["placement","tags","links","content"]'
assert_contains .codex/skills/tag-steward/SKILL.md "Call agent: tag-steward"
assert_contains .codex/skills/daily-capture/SKILL.md "place-first"
assert_contains .codex/skills/daily-capture/SKILL.md "workflow_ready"
assert_contains .codex/skills/daily-capture/SKILL.md "workflow_policy"
assert_contains .codex/skills/daily-capture/SKILL.md "explicit daily-note append"
assert_contains .codex/skills/daily-capture/SKILL.md "placement debt"
assert_contains .codex/skills/daily-capture/SKILL.md "MCP server is unavailable"
assert_contains .codex/skills/daily-capture/SKILL.md "dreamers-note://workflow-policy/capture"
assert_contains .codex/skills/daily-capture/SKILL.md "do not start the body with an H1 or H2"
assert_contains .codex/skills/note-review/SKILL.md "Review exactly one vault note"
assert_contains .codex/skills/note-review/SKILL.md "Worker Report Contract"
assert_contains .codex/skills/note-review/SKILL.md "graph_context_pack"
assert_contains .codex/skills/note-review/SKILL.md "duplicate_candidates"
assert_contains .codex/skills/note-review/SKILL.md "reviewer_attention"
assert_contains .codex/skills/vault-refactor/SKILL.md "Spawn worker agents"
assert_contains .codex/skills/vault-refactor/SKILL.md "Do not stop for mid-run approval"
assert_contains .codex/skills/vault-refactor/SKILL.md "Reviewer Attention Summary"
assert_contains .codex/skills/vault-refactor/SKILL.md "dreamers-pr"
assert_contains .codex/skills/vault-refactor/SKILL.md "proposal_authorize"

assert_file scripts/validate-vault-bootstrap.sh
assert_file scripts/validate-framework.mjs
assert_file config/framework-validation.json
assert_contains scripts/validate-framework.sh "scripts/validate-framework.mjs"
assert_not_contains scripts/validate-framework.sh "require_text README.md"
assert_file scripts/propose-daily-triage.py
assert_file scripts/propose-vault-normalization.py
assert_file scripts/build-vault-inventory.py
assert_file scripts/apply-vault-remap.py
assert_file scripts/migrate-directory-indexes.py
assert_file scripts/vault_remap_common.py
assert_dir indexes

for skill in note-add daily-capture note-import daily-triage note-review vault-normalization vault-refactor; do
  assert_contains ".codex/skills/$skill/SKILL.md" "_<folder-name>.md"
  assert_contains ".codex/skills/$skill/SKILL.md" "## Notes"
  assert_contains ".github/skills/$skill/SKILL.md" "_<folder-name>.md"
  assert_contains ".github/skills/$skill/SKILL.md" "## Notes"
done

for heading in "## Purpose" "## Inputs" "## Allowed Paths" "## Forbidden Actions" "## Phases" "## Agent Calls" "## Output Format" "## Review Expectations"; do
  temp_root="$(mktemp -d)"
  make_temp_framework "$temp_root"
  sed -i "\\|$heading|d" "$temp_root/.codex/skills/daily-capture/SKILL.md"
  assert_command_fails "FRAMEWORK_ROOT='$temp_root' bash '$ROOT/scripts/validate-framework.sh'"
done

temp_root="$(mktemp -d)"
make_temp_framework "$temp_root"
printf '[]\n' >"$temp_root/config/copilot-mcp-tools.json"
assert_command_fails "FRAMEWORK_ROOT='$temp_root' bash '$ROOT/scripts/validate-framework.sh'"
