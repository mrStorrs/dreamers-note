#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers/framework-contract-helpers.sh"

temp_codex_home="$(mktemp -d)"
temp_copilot_home="$(mktemp -d)"
temp_install_vault="$(mktemp -d)"
mkdir -p "$temp_codex_home/skills/dreamers-note-add" "$temp_codex_home/skills/dreamers-note-triage" "$temp_codex_home/skills/unrelated-skill"
mkdir -p "$temp_copilot_home/skills/old-copilot-skill" "$temp_copilot_home/skills/unrelated-copilot-skill"
printf 'daily-capture\nold-copilot-skill\n' >"$temp_copilot_home/skills/.dreamers-note-managed-skills"
cat >"$temp_copilot_home/mcp-config.json" <<'JSON'
{
  "mcpServers": {
    "other-server": {
      "type": "stdio",
      "command": "other",
      "args": []
    },
    "dreamers-note": {
      "type": "stdio",
      "command": "old-node",
      "args": ["old"],
      "tools": ["proposal_apply"]
    }
  }
}
JSON
VAULT_PATH="$temp_install_vault" CODEX_HOME="$temp_codex_home" COPILOT_HOME="$temp_copilot_home" "$ROOT/install.sh" --dry-run --copilot-mcp
VAULT_PATH="$temp_install_vault" CODEX_HOME="$temp_codex_home" COPILOT_HOME="$temp_copilot_home" "$ROOT/install.sh" --copilot-mcp
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
grep -Fxq "daily-capture" "$temp_copilot_home/skills/.dreamers-note-managed-skills" || fail "installer did not write Copilot managed skill manifest"
grep -Fxq "daily-triage" "$temp_copilot_home/skills/.dreamers-note-managed-skills" || fail "installer did not manage Copilot daily-triage"
grep -Fxq "note-add" "$temp_copilot_home/skills/.dreamers-note-managed-skills" || fail "installer did not manage Copilot note-add"
grep -Fxq "note-import" "$temp_copilot_home/skills/.dreamers-note-managed-skills" || fail "installer did not manage Copilot note-import"
grep -Fxq "tag-steward" "$temp_copilot_home/skills/.dreamers-note-managed-skills" || fail "installer did not manage Copilot tag-steward"
grep -Fxq "vault-normalization" "$temp_copilot_home/skills/.dreamers-note-managed-skills" || fail "installer did not manage Copilot vault-normalization"
[ -f "$temp_copilot_home/skills/daily-capture/SKILL.md" ] || fail "installer did not copy Copilot daily-capture"
[ -f "$temp_copilot_home/skills/daily-triage/SKILL.md" ] || fail "installer did not copy Copilot daily-triage"
[ -f "$temp_copilot_home/skills/note-add/SKILL.md" ] || fail "installer did not copy Copilot note-add"
[ -f "$temp_copilot_home/skills/note-import/SKILL.md" ] || fail "installer did not copy Copilot note-import"
[ -f "$temp_copilot_home/skills/tag-steward/SKILL.md" ] || fail "installer did not copy Copilot tag-steward"
[ -f "$temp_copilot_home/skills/vault-normalization/SKILL.md" ] || fail "installer did not copy Copilot vault-normalization"
[ ! -e "$temp_copilot_home/skills/old-copilot-skill" ] || fail "installer did not remove stale Copilot skill"
[ -e "$temp_copilot_home/skills/unrelated-copilot-skill" ] || fail "installer removed unrelated Copilot skill"
python3 - "$temp_copilot_home/mcp-config.json" <<'PY'
import json
import sys

data = json.loads(open(sys.argv[1], encoding="utf-8").read())
servers = data["mcpServers"]
assert "other-server" in servers
dreamers = servers["dreamers-note"]
assert dreamers["type"] == "stdio"
assert dreamers["command"] == "node"
assert "mcp" in dreamers["args"]
assert "--root" in dreamers["args"]
tools = dreamers["tools"]
assert "workflow_ready" in tools
assert "context_pack" in tools
assert "proposal_create_note" in tools
assert "proposal_authorize" not in tools
assert "proposal_apply" not in tools
PY

temp_conflict_home="$(mktemp -d)"
mkdir -p "$temp_conflict_home/skills/note-add"
printf 'personal skill\n' >"$temp_conflict_home/skills/note-add/SKILL.md"
assert_command_fails "VAULT_PATH='$temp_install_vault' CODEX_HOME='$(mktemp -d)' COPILOT_HOME='$temp_conflict_home' '$ROOT/install.sh'"
grep -Fq "personal skill" "$temp_conflict_home/skills/note-add/SKILL.md" || fail "installer overwrote unmanaged Copilot skill after conflict"

temp_bad_mcp_home="$(mktemp -d)"
temp_bad_mcp_vault="$(mktemp -d)"
temp_bad_mcp_codex="$(mktemp -d)"
printf '{\n' >"$temp_bad_mcp_home/mcp-config.json"
assert_command_fails "VAULT_PATH='$temp_bad_mcp_vault' CODEX_HOME='$temp_bad_mcp_codex' COPILOT_HOME='$temp_bad_mcp_home' '$ROOT/install.sh' --copilot-mcp"
[ ! -e "$temp_bad_mcp_vault/.codex/skills" ] || fail "bad MCP JSON mutated project skill target"
[ ! -e "$temp_bad_mcp_codex/skills" ] || fail "bad MCP JSON mutated Codex skill target"
[ ! -e "$temp_bad_mcp_home/skills" ] || fail "bad MCP JSON mutated Copilot skill target"

temp_bad_mcp_home="$(mktemp -d)"
temp_bad_mcp_vault="$(mktemp -d)"
temp_bad_mcp_codex="$(mktemp -d)"
printf '{"mcpServers":[]}\n' >"$temp_bad_mcp_home/mcp-config.json"
assert_command_fails "VAULT_PATH='$temp_bad_mcp_vault' CODEX_HOME='$temp_bad_mcp_codex' COPILOT_HOME='$temp_bad_mcp_home' '$ROOT/install.sh' --copilot-mcp"
[ ! -e "$temp_bad_mcp_vault/.codex/skills" ] || fail "bad MCP mcpServers mutated project skill target"
[ ! -e "$temp_bad_mcp_codex/skills" ] || fail "bad MCP mcpServers mutated Codex skill target"
[ ! -e "$temp_bad_mcp_home/skills" ] || fail "bad MCP mcpServers mutated Copilot skill target"

grep -Fxq "dreamers-note-capture" "$temp_codex_home/skills/.dreamers-note-managed-skills" || fail "installer did not write managed skill manifest"
grep -Fxq "dreamers-note" "$temp_codex_home/skills/.dreamers-note-managed-skills" || fail "installer did not write dreamers-note skill manifest"
grep -Fxq "dreamers-note-import" "$temp_codex_home/skills/.dreamers-note-managed-skills" || fail "installer did not write import skill manifest"
mkdir -p "$temp_codex_home/skills/dreamers-note-old"
printf 'dreamers-note\ndreamers-note-capture\ndreamers-note-import\ndreamers-note-old\n' >"$temp_codex_home/skills/.dreamers-note-managed-skills"
VAULT_PATH="$temp_install_vault" CODEX_HOME="$temp_codex_home" COPILOT_HOME="$temp_copilot_home" "$ROOT/install.sh"
[ ! -e "$temp_codex_home/skills/dreamers-note-old" ] || fail "installer did not remove stale manifest skill"

temp_root="$(mktemp -d)"
make_temp_framework "$temp_root"
temp_project_vault="$(mktemp -d)"
mkdir -p "$temp_project_vault/.codex/skills/old-project-skill"
printf 'daily-capture\nold-project-skill\n' >"$temp_project_vault/.codex/skills/.dreamers-note-managed-skills"
VAULT_PATH="$temp_project_vault" CODEX_HOME="$(mktemp -d)" COPILOT_HOME="$(mktemp -d)" "$temp_root/install.sh"
[ ! -e "$temp_project_vault/.codex/skills/old-project-skill" ] || fail "installer did not remove stale project skill"
grep -Fxq "note-import" "$temp_project_vault/.codex/skills/.dreamers-note-managed-skills" || fail "installer did not rewrite note-import project skill manifest"
grep -Fxq "note-add" "$temp_project_vault/.codex/skills/.dreamers-note-managed-skills" || fail "installer did not rewrite note-add project skill manifest"
grep -Fxq "vault-normalization" "$temp_project_vault/.codex/skills/.dreamers-note-managed-skills" || fail "installer did not rewrite project skill manifest"
