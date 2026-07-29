#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers/framework-contract-helpers.sh"

assert_contains README.md "<local-home>/obsidian/cyborg"
assert_contains README.md "installed into the configured vault under"
assert_contains README.md "Skills and helper scripts read this config by default."
assert_contains README.md "chat-first"
assert_contains README.md "git diff"
assert_contains README.md "approved topical tags"
assert_contains README.md "skills as phase-gated runs"
assert_contains README.md "agents as narrow role contracts"
assert_contains README.md "Install Global Skill Launchers"
assert_contains README.md "Copilot Support"
assert_contains README.md "AGENTS.md"
assert_contains README.md "workflow_policy"
assert_contains README.md "Generated MCP tool inventory"
assert_contains README.md "./install.sh --dry-run"
assert_contains README.md "--copilot-mcp"
assert_contains README.md "config/copilot-mcp-tools.json"
assert_contains README.md "VS Code Copilot agent mode"
assert_contains README.md "GitHub-hosted Copilot cloud agent"
assert_contains README.md '$dreamers-note'
assert_contains README.md "proposal_authorize"
assert_contains README.md "proposal_apply"
assert_contains README.md "Directory Homepages"
assert_contains README.md "_<folder-name>.md"
assert_contains README.md "## Notes"
assert_contains README.md "subject matter"
assert_contains README.md "never boilerplate explaining that the file is an index or homepage"
assert_contains README.md "proposal_create_directory_index_refresh"
assert_contains README.md "automatically includes"
assert_contains README.md "health_report"
assert_not_contains README.md "Quick capture is place-first by default"
assert_not_contains README.md "Daily triage now calls"
assert_not_contains README.md "python3 scripts/propose-daily-triage.py"
assert_not_contains README.md 'every Markdown daily note under `00-inbox/daily-notes`'
assert_not_contains config/framework-validation.json "templates/chat-proposal.md"
assert_not_contains config/framework-validation.json "templates/tag-proposal.md"
[ ! -e "$ROOT/templates/chat-proposal.md" ] || fail "legacy chat proposal template was reintroduced"
[ ! -e "$ROOT/templates/tag-proposal.md" ] || fail "legacy tag proposal template was reintroduced"
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
assert_contains docs/conventions.md "Directory homepages"
assert_contains docs/conventions.md "_<folder-name>.md"
assert_contains docs/conventions.md "## Notes"
assert_contains docs/conventions.md "subject matter"
assert_contains docs/conventions.md "never explains that the file is an index or homepage"
assert_contains docs/conventions.md "proposal_create_directory_index_refresh"
assert_contains docs/conventions.md "byte-changing"
assert_contains docs/conventions.md "health_report"
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

assert_contains .github/instructions/dreamers-note.instructions.md "_<folder-name>.md"
assert_contains .github/instructions/dreamers-note.instructions.md "## Notes"
assert_contains .github/instructions/dreamers-note.instructions.md "folder's subject matter"
