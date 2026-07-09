#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers/framework-contract-helpers.sh"

assert_file scripts/install.mjs
assert_contains install.sh "scripts/install.mjs"
assert_not_contains install.sh "PROJECT_MANAGED_SKILLS"
assert_not_contains install.sh "python3 - <<"

(cd "$ROOT" && npm run build --silent >/dev/null)

temp_codex_home="$(mktemp -d)"
temp_copilot_home="$(mktemp -d)"
temp_install_vault="$(mktemp -d)"
temp_bare_codex_home="$(mktemp -d)"
temp_bare_copilot_home="$(mktemp -d)"
temp_bare_vault="$(mktemp -d)"
temp_bare_output="$(mktemp)"
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
VAULT_PATH="$temp_bare_vault" CODEX_HOME="$temp_bare_codex_home" COPILOT_HOME="$temp_bare_copilot_home" "$ROOT/install.sh" --dry-run >"$temp_bare_output"
grep -Fq "would install project skill: note-add" "$temp_bare_output" || fail "bare dry-run did not report project skill work"
grep -Fq "would install: dreamers-note" "$temp_bare_output" || fail "bare dry-run did not report global launcher work"
[ ! -e "$temp_bare_vault/.codex/skills" ] || fail "bare dry-run mutated project skill target"
[ ! -e "$temp_bare_codex_home/skills" ] || fail "bare dry-run mutated Codex skill target"
[ ! -e "$temp_bare_copilot_home/skills" ] || fail "bare dry-run mutated Copilot skill target"
VAULT_PATH="$temp_install_vault" CODEX_HOME="$temp_codex_home" COPILOT_HOME="$temp_copilot_home" "$ROOT/install.sh" --dry-run --copilot-mcp
VAULT_PATH="$temp_install_vault" CODEX_HOME="$temp_codex_home" COPILOT_HOME="$temp_copilot_home" "$ROOT/install.sh" --copilot-mcp
for skill in $(managed_project_skills); do
  grep -Fxq "$skill" "$temp_install_vault/.codex/skills/.dreamers-note-managed-skills" || fail "installer did not manage $skill"
  [ -f "$temp_install_vault/.codex/skills/$skill/SKILL.md" ] || fail "installer did not copy $skill into vault"
done
for skill in $(global_launcher_skills); do
  [ -f "$temp_codex_home/skills/$skill/SKILL.md" ] || fail "installer did not create $skill"
done
grep -Fq "target_skill_path: $temp_install_vault/.codex/skills/note-add/SKILL.md" "$temp_codex_home/skills/dreamers-note/SKILL.md" || fail "global launcher did not use effective VAULT_PATH"
[ ! -e "$temp_codex_home/skills/dreamers-note-add" ] || fail "installer did not remove stale dreamers-note-add launcher"
[ ! -e "$temp_codex_home/skills/dreamers-note-triage" ] || fail "installer created project-only triage launcher"
[ ! -e "$temp_codex_home/skills/dreamers-note-normalize" ] || fail "installer created project-only normalize launcher"
[ ! -e "$temp_codex_home/skills/dreamers-note-tags" ] || fail "installer created project-only tags launcher"
[ -e "$temp_codex_home/skills/unrelated-skill" ] || fail "installer removed unrelated skill"
for skill in $(managed_copilot_skills); do
  grep -Fxq "$skill" "$temp_copilot_home/skills/.dreamers-note-managed-skills" || fail "installer did not manage Copilot $skill"
  [ -f "$temp_copilot_home/skills/$skill/SKILL.md" ] || fail "installer did not copy Copilot $skill"
done
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

assert_command_fails "HOME='' CODEX_HOME='' COPILOT_HOME='' VAULT_PATH='$temp_install_vault' '$ROOT/install.sh' --dry-run"
assert_command_fails "VAULT_PATH='relative-vault' CODEX_HOME='$temp_codex_home' COPILOT_HOME='$temp_copilot_home' '$ROOT/install.sh' --dry-run"
assert_command_fails "FRAMEWORK_ROOT='relative-root' node '$ROOT/scripts/validate-framework.mjs'"
assert_command_fails "VAULT_PATH='relative-vault' node '$ROOT/scripts/validate-vault-bootstrap.mjs'"
temp_forbidden_tools="$(mktemp)"
printf '["workflow_ready","proposal_apply"]\n' >"$temp_forbidden_tools"
assert_command_fails "VAULT_PATH='$temp_install_vault' CODEX_HOME='$(mktemp -d)' COPILOT_HOME='$(mktemp -d)' COPILOT_MCP_TOOLS_FILE='$temp_forbidden_tools' '$ROOT/install.sh' --dry-run --copilot-mcp"

for skill in $(global_launcher_skills); do
  grep -Fxq "$skill" "$temp_codex_home/skills/.dreamers-note-managed-skills" || fail "installer did not write $skill managed skill manifest"
done
mkdir -p "$temp_codex_home/skills/dreamers-note-old"
printf 'dreamers-note\ndreamers-note-capture\ndreamers-note-import\ndreamers-note-old\n' >"$temp_codex_home/skills/.dreamers-note-managed-skills"
VAULT_PATH="$temp_install_vault" CODEX_HOME="$temp_codex_home" COPILOT_HOME="$temp_copilot_home" "$ROOT/install.sh"
[ ! -e "$temp_codex_home/skills/dreamers-note-old" ] || fail "installer did not remove stale manifest skill"

temp_root="$(mktemp -d)"
make_temp_framework "$temp_root"
temp_project_vault="$(mktemp -d)"
temp_missing_registry_root="$(mktemp -d)"
make_temp_framework "$temp_missing_registry_root"
rm -f "$temp_missing_registry_root/dist/mcp-tool-registry.js"
assert_command_fails "VAULT_PATH='$(mktemp -d)' CODEX_HOME='$(mktemp -d)' COPILOT_HOME='$(mktemp -d)' '$temp_missing_registry_root/install.sh' --dry-run --copilot-mcp"
mkdir -p "$temp_root/.codex/skills/note-add/support"
printf 'support file\n' >"$temp_root/.codex/skills/note-add/support/example.md"
mkdir -p "$temp_project_vault/.codex/skills/old-project-skill"
mkdir -p "$temp_project_vault/.codex/skills/note-add"
printf 'stale support\n' >"$temp_project_vault/.codex/skills/note-add/stale.md"
printf 'daily-capture\nold-project-skill\n' >"$temp_project_vault/.codex/skills/.dreamers-note-managed-skills"
VAULT_PATH="$temp_project_vault" CODEX_HOME="$(mktemp -d)" COPILOT_HOME="$(mktemp -d)" "$temp_root/install.sh"
[ ! -e "$temp_project_vault/.codex/skills/old-project-skill" ] || fail "installer did not remove stale project skill"
[ -f "$temp_project_vault/.codex/skills/note-add/support/example.md" ] || fail "installer did not recursively copy project skill support files"
[ ! -e "$temp_project_vault/.codex/skills/note-add/stale.md" ] || fail "installer did not remove stale files inside a managed project skill"
grep -Fxq "note-import" "$temp_project_vault/.codex/skills/.dreamers-note-managed-skills" || fail "installer did not rewrite note-import project skill manifest"
grep -Fxq "note-add" "$temp_project_vault/.codex/skills/.dreamers-note-managed-skills" || fail "installer did not rewrite note-add project skill manifest"
grep -Fxq "vault-normalization" "$temp_project_vault/.codex/skills/.dreamers-note-managed-skills" || fail "installer did not rewrite project skill manifest"
