#!/usr/bin/env bash
set -euo pipefail

ROOT="${FRAMEWORK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

fail() {
  printf 'framework validation failed: %s\n' "$1" >&2
  exit 1
}

require_file() {
  [ -f "$ROOT/$1" ] || fail "missing file $1"
}

require_dir() {
  [ -d "$ROOT/$1" ] || fail "missing directory $1"
}

require_text() {
  grep -Fq "$2" "$ROOT/$1" || fail "$1 missing required text: $2"
}

for dir in config docs agents skills templates taxonomy scripts tests/fixtures; do
  require_dir "$dir"
done

for file in \
  README.md \
  config/vault.json \
  docs/conventions.md \
  docs/git-review-workflow.md \
  agents/librarian.md \
  agents/triage.md \
  agents/tag-steward.md \
  skills/daily-capture/SKILL.md \
  skills/daily-triage/SKILL.md \
  skills/vault-normalization/SKILL.md \
  skills/tag-steward/SKILL.md \
  templates/chat-proposal.md \
  templates/tag-proposal.md \
  scripts/propose-vault-normalization.py \
  taxonomy/approved-tags.md; do
  require_file "$file"
done

require_text config/vault.json "\"vault_path\": \"<local-home>/obsidian/cyborg\""
require_text docs/conventions.md "lowercase kebab-case"
require_text docs/conventions.md "agent's role, allowed actions or tools, handoffs, and forbidden actions"
require_text docs/conventions.md "phase-gated run"
require_text docs/conventions.md "feat/short-kebab-description"
require_text taxonomy/approved-tags.md "AI may apply only tags listed here"
require_text scripts/propose-vault-normalization.py "dry-run"

for skill in daily-capture daily-triage vault-normalization tag-steward; do
  file="skills/$skill/SKILL.md"
  for heading in "## Purpose" "## Inputs" "## Allowed Paths" "## Forbidden Actions" "## Phases" "## Agent Calls" "## Output Format" "## Review Expectations"; do
    require_text "$file" "$heading"
  done
done

require_text skills/vault-normalization/SKILL.md "scripts/propose-vault-normalization.py"
require_text skills/vault-normalization/SKILL.md "dry-run"
require_text skills/vault-normalization/SKILL.md "proposal of record"
require_text skills/vault-normalization/SKILL.md "Call agent: librarian only for ambiguous rename or move decisions"

for agent in librarian triage tag-steward; do
  file="agents/$agent.md"
  for heading in "## Role" "## Allowed Actions" "## Handoffs" "## Forbidden Actions"; do
    require_text "$file" "$heading"
  done
done

if grep -R -E 'status/|kind/' "$ROOT/taxonomy" "$ROOT/skills" "$ROOT/agents" >/dev/null; then
  fail "lifecycle tags found in framework taxonomy, skills, or agents"
fi

printf 'framework validation passed\n'
