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
  grep -Fq -- "$2" "$ROOT/$1" || fail "$1 missing required text: $2"
}

require_skill_frontmatter() {
  local file="$1"
  local name="$2"
  require_text "$file" "---"
  head -n 1 "$ROOT/$file" | grep -Fxq -- "---" || fail "$file missing opening YAML frontmatter"
  require_text "$file" "name: \"$name\""
  require_text "$file" "description: \""
}

for dir in config docs agents .codex/skills global-skills templates taxonomy scripts tests/fixtures; do
  require_dir "$dir"
done

for file in \
  README.md \
  install.sh \
  config/vault.json \
  docs/conventions.md \
  docs/git-review-workflow.md \
  agents/librarian.md \
  agents/triage.md \
  agents/tag-steward.md \
  .codex/skills/daily-capture/SKILL.md \
  .codex/skills/daily-triage/SKILL.md \
  .codex/skills/vault-normalization/SKILL.md \
  .codex/skills/tag-steward/SKILL.md \
  global-skills/dreamers-note-capture/SKILL.md \
  templates/chat-proposal.md \
  templates/tag-proposal.md \
  scripts/propose-daily-triage.py \
  scripts/propose-vault-normalization.py \
  scripts/build-vault-inventory.py \
  scripts/apply-vault-remap.py \
  scripts/vault_remap_common.py \
  taxonomy/approved-tags.md; do
  require_file "$file"
done

require_dir indexes

require_text config/vault.json "\"vault_path\": \"<local-home>/obsidian/cyborg\""
require_text README.md "Skills and helper scripts read this config by default."
require_text docs/conventions.md "lowercase kebab-case"
require_text docs/conventions.md "agent's role, allowed actions or tools, handoffs, and forbidden actions"
require_text docs/conventions.md "phase-gated run"
require_text docs/conventions.md "feat/short-kebab-description"
require_text docs/conventions.md "02-knowledge/<main>/<sub>/<note-name>.md"
require_text taxonomy/approved-tags.md "AI may apply only tags listed here"
require_text README.md "global launcher"
require_text README.md '<root>/<main>/<sub>/<note>.md'
require_text install.sh "configured vault's"
require_text install.sh "VAULT_PATH"
require_text README.md 'installed into the configured vault under `.codex/skills/`'
require_text install.sh "global-skills"
require_text install.sh ".dreamers-note-managed-skills"
require_text install.sh "removed stale managed skill"
require_text install.sh "installed project skill"
require_text scripts/propose-daily-triage.py "daily-triage dry-run proposal"
require_text scripts/propose-daily-triage.py "Defaults to config/vault.json"
require_text scripts/propose-vault-normalization.py "dry-run"
require_text scripts/build-vault-inventory.py "Build committed JSONL state"
require_text scripts/build-vault-inventory.py "Defaults to config/vault.json"
require_text scripts/apply-vault-remap.py "Apply reviewed AI vault remap decisions"
require_text scripts/apply-vault-remap.py "Defaults to config/vault.json"
require_text scripts/apply-vault-remap.py "knowledge notes must use 02-knowledge/<main>/<sub>/<note>.md"

for skill in daily-capture daily-triage vault-normalization tag-steward; do
  file=".codex/skills/$skill/SKILL.md"
  require_skill_frontmatter "$file" "$skill"
  for heading in "## Purpose" "## Inputs" "## Allowed Paths" "## Forbidden Actions" "## Phases" "## Agent Calls" "## Output Format" "## Review Expectations"; do
    require_text "$file" "$heading"
  done
done

require_skill_frontmatter global-skills/dreamers-note-capture/SKILL.md dreamers-note-capture
require_text global-skills/dreamers-note-capture/SKILL.md "This is a global launcher. The project-owned skill is the source of truth."
require_text global-skills/dreamers-note-capture/SKILL.md "<local-home>/obsidian/cyborg/.codex/skills/"

require_text .codex/skills/vault-normalization/SKILL.md "scripts/propose-vault-normalization.py"
require_text .codex/skills/vault-normalization/SKILL.md "scripts/build-vault-inventory.py"
require_text .codex/skills/vault-normalization/SKILL.md "scripts/apply-vault-remap.py"
require_text .codex/skills/vault-normalization/SKILL.md "dry-run"
require_text .codex/skills/vault-normalization/SKILL.md "must_read_file: true"
require_text .codex/skills/vault-normalization/SKILL.md "indexes/ai-review-decisions.jsonl"
require_text .codex/skills/vault-normalization/SKILL.md "indexes/remap-queue.jsonl"
require_text .codex/skills/vault-normalization/SKILL.md "indexes/tag-proposals.jsonl"
require_text .codex/skills/vault-normalization/SKILL.md "Call agent: librarian for ambiguous destination, split, merge, or link decisions"
require_text .codex/skills/vault-normalization/SKILL.md "Call agent: tag-steward"
require_text .codex/skills/vault-normalization/SKILL.md '<root>/<main>/<sub>/<note-name>.md'
require_text .codex/skills/vault-normalization/SKILL.md '"reviewed_scope":["placement","tags","links","content"]'
require_text .codex/skills/daily-triage/SKILL.md "scripts/propose-daily-triage.py"
require_text .codex/skills/daily-triage/SKILL.md 're-run the helper with `--archive`'
require_text .codex/skills/daily-triage/SKILL.md "visible in Git diff"
require_text .codex/skills/daily-triage/SKILL.md '<root>/<main>/<sub>/<note-name>.md'

for agent in librarian triage tag-steward; do
  file="agents/$agent.md"
  for heading in "## Role" "## Allowed Actions" "## Handoffs" "## Forbidden Actions"; do
    require_text "$file" "$heading"
  done
done

if grep -R -E 'status/|kind/' "$ROOT/taxonomy" "$ROOT/.codex/skills" "$ROOT/agents" >/dev/null; then
  fail "lifecycle tags found in framework taxonomy, skills, or agents"
fi

if grep -R -F '<local-home>/obsidian/cyborg' "$ROOT/.codex/skills" >/dev/null; then
  fail "hardcoded vault path found in project skills; use config/vault.json"
fi

printf 'framework validation passed\n'
