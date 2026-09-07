#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers/framework-contract-helpers.sh"

for skill in note-add note-import note-daily-triage note-review note-vault-refactor; do
  assert_contains README.md "\`$skill\`"
done
assert_contains README.md "The checked-in \`.codex/skills/\` tree is the only source"
assert_contains README.md "change create"
assert_contains README.md "change show"
assert_contains README.md "change apply"
assert_contains README.md "mcp-config.json"
assert_contains README.md "Schema version 7"
assert_not_contains README.md "Generated MCP tool inventory"
assert_not_contains README.md "--copilot-mcp"

assert_contains AGENTS.md "canonical \`note-*\` skill"
assert_contains AGENTS.md "change apply --id --revision"
assert_not_contains AGENTS.md "workflow_ready"

assert_contains docs/note-workflow-policy.md "This policy is shared"
assert_contains docs/note-workflow-policy.md "approved taxonomy"
assert_contains docs/note-workflow-policy.md "only writer"
assert_contains docs/conventions.md "lowercase kebab-case"
assert_contains docs/conventions.md "topical tags"
assert_contains docs/git-review-workflow.md "reviewable Git flow"

assert_contains .github/copilot-instructions.md "installed canonical \`note-*\` skills"
assert_contains .github/copilot-instructions.md "change create"
assert_not_contains .github/copilot-instructions.md "workflow_ready"
assert_not_contains .github/copilot-instructions.md "proposal_apply"
assert_contains .github/instructions/dreamers-note.instructions.md "canonical installed \`note-*\` skills"
assert_not_contains .github/instructions/dreamers-note.instructions.md "MCP"

assert_contains config/runtime.json ".dreamers-note-runtime"
assert_not_contains config/runtime.json "embedding"
assert_file templates/template-daily-note.md
