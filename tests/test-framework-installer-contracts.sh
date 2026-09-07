#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers/framework-contract-helpers.sh"

expected='note-add note-import note-daily-triage note-review note-vault-refactor'

assert_manifest() {
  local skills_dir="$1"
  local actual
  actual="$(tr '\n' ' ' <"$skills_dir/.dreamers-note-managed-skills" | sed 's/[[:space:]]*$//')"
  [ "$actual" = "$expected" ] || fail "managed manifest is wrong in $skills_dir: $actual"
}

assert_canonical_copy() {
  local skills_dir="$1"
  local skill
  for skill in $expected; do
    [ -f "$skills_dir/$skill/SKILL.md" ] || fail "missing installed skill $skill in $skills_dir"
    diff -qr "$ROOT/.codex/skills/$skill" "$skills_dir/$skill" >/dev/null || fail "installed $skill differs from canonical source"
  done
  assert_manifest "$skills_dir"
  node -e '
    const fs = require("fs");
    const [file, root, cli] = process.argv.slice(1);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.framework_root !== root || value.cli_path !== cli) process.exit(1);
  ' "$skills_dir/.dreamers-note-install.json" "$ROOT" "$ROOT/dist/cli.js" || fail "framework locator is wrong in $skills_dir"
}

assert_dangling_preflight_failure() {
  local kind="$1"
  local case_root vault_home codex_home copilot_home link
  case_root="$(mktemp -d "$symlink_root/case.XXXXXX")"
  vault_home="$case_root/vault"
  codex_home="$case_root/codex"
  copilot_home="$case_root/copilot"
  mkdir -p "$vault_home" "$codex_home" "$copilot_home"
  case "$kind" in
    skills)
      mkdir -p "$vault_home/.codex"
      link="$vault_home/.codex/skills"
      ln -s "$case_root/missing-skills" "$link"
      ;;
    skill)
      mkdir -p "$copilot_home/skills"
      link="$copilot_home/skills/note-add"
      ln -s "$case_root/missing-skill" "$link"
      ;;
    manifest)
      mkdir -p "$codex_home/skills"
      link="$codex_home/skills/.dreamers-note-managed-skills"
      ln -s "$case_root/missing-manifest" "$link"
      ;;
    locator)
      mkdir -p "$copilot_home/skills"
      link="$copilot_home/skills/.dreamers-note-install.json"
      ln -s "$case_root/missing-locator" "$link"
      ;;
    config)
      link="$copilot_home/mcp-config.json"
      ln -s "$case_root/missing-config" "$link"
      ;;
  esac
  assert_command_fails "VAULT_PATH='$vault_home' CODEX_HOME='$codex_home' COPILOT_HOME='$copilot_home' '$ROOT/install.sh'"
  [ -L "$link" ] || fail "dangling $kind symlink was not retained for inspection"
  [ ! -e "$vault_home/.codex/skills/note-import" ] || fail "dangling $kind preflight changed the vault destination"
  [ ! -e "$codex_home/skills/note-import" ] || fail "dangling $kind preflight changed the Codex destination"
  [ ! -e "$copilot_home/skills/note-import" ] || fail "dangling $kind preflight changed the Copilot destination"
}

(cd "$ROOT" && npm run build --silent >/dev/null)

dry_vault="$(mktemp -d)"
dry_codex="$(mktemp -d)"
dry_copilot="$(mktemp -d)"
dry_output="$(mktemp)"
vault="$(mktemp -d)"
codex="$(mktemp -d)"
copilot="$(mktemp -d)"
plain_vault="$(mktemp -d)"
plain_codex="$(mktemp -d)"
plain_copilot="$(mktemp -d)"
collision_vault="$(mktemp -d)"
collision_codex="$(mktemp -d)"
collision_copilot="$(mktemp -d)"
invalid_vault="$(mktemp -d)"
invalid_codex="$(mktemp -d)"
invalid_copilot="$(mktemp -d)"
symlink_root="$(mktemp -d)"
trap 'rm -rf "$dry_vault" "$dry_codex" "$dry_copilot" "$dry_output" "$vault" "$codex" "$copilot" "$plain_vault" "$plain_codex" "$plain_copilot" "$collision_vault" "$collision_codex" "$collision_copilot" "$invalid_vault" "$invalid_codex" "$invalid_copilot" "$symlink_root"' EXIT

VAULT_PATH="$dry_vault" CODEX_HOME="$dry_codex" COPILOT_HOME="$dry_copilot" "$ROOT/install.sh" --dry-run >"$dry_output"
grep -Fq "would copy canonical skill to vault" "$dry_output" || fail "dry run did not report vault copies"
grep -Fq "would copy canonical skill to Codex" "$dry_output" || fail "dry run did not report Codex copies"
grep -Fq "would copy canonical skill to Copilot" "$dry_output" || fail "dry run did not report Copilot copies"
[ ! -e "$dry_vault/.codex" ] || fail "dry run changed vault destination"
[ ! -e "$dry_codex/skills" ] || fail "dry run changed Codex destination"
[ ! -e "$dry_copilot/skills" ] || fail "dry run changed Copilot destination"
[ ! -e "$dry_copilot/mcp-config.json" ] || fail "dry run created Copilot configuration"
printf '{"mcpServers":{"other-server":{"command":"other"},"dreamers-note":{"command":"old"}}}\n' >"$dry_copilot/mcp-config.json"
VAULT_PATH="$dry_vault" CODEX_HOME="$dry_codex" COPILOT_HOME="$dry_copilot" "$ROOT/install.sh" --dry-run >"$dry_output"
grep -Fq "would remove stale Copilot configuration entry" "$dry_output" || fail "dry run did not report Copilot cleanup"
node -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!value.mcpServers["dreamers-note"] || !value.mcpServers["other-server"]) process.exit(1);
' "$dry_copilot/mcp-config.json" || fail "dry run changed Copilot configuration"

for skills_dir in "$vault/.codex/skills" "$codex/skills" "$copilot/skills"; do
  mkdir -p "$skills_dir/daily-capture" "$skills_dir/old-managed" "$skills_dir/personal-skill"
  printf 'daily-capture\nold-managed\n' >"$skills_dir/.dreamers-note-managed-skills"
  printf 'personal skill\n' >"$skills_dir/personal-skill/SKILL.md"
done
printf '{"other":true,"mcpServers":{"other-server":{"command":"other"},"dreamers-note":{"command":"old"}}}\n' >"$copilot/mcp-config.json"

VAULT_PATH="$vault" CODEX_HOME="$codex" COPILOT_HOME="$copilot" "$ROOT/install.sh" >/dev/null
for skills_dir in "$vault/.codex/skills" "$codex/skills" "$copilot/skills"; do
  assert_canonical_copy "$skills_dir"
  [ ! -e "$skills_dir/daily-capture" ] || fail "installer did not remove stale managed daily-capture"
  [ ! -e "$skills_dir/old-managed" ] || fail "installer did not remove stale managed skill"
  [ -f "$skills_dir/personal-skill/SKILL.md" ] || fail "installer removed unrelated personal skill"
done
node -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.other !== true || !value.mcpServers["other-server"] || value.mcpServers["dreamers-note"]) process.exit(1);
' "$copilot/mcp-config.json" || fail "installer did not surgically remove only the stale Copilot entry"

VAULT_PATH="$plain_vault" CODEX_HOME="$plain_codex" COPILOT_HOME="$plain_copilot" "$ROOT/install.sh" >/dev/null
[ ! -e "$plain_copilot/mcp-config.json" ] || fail "installer created a missing Copilot configuration"
assert_canonical_copy "$plain_vault/.codex/skills"
assert_canonical_copy "$plain_codex/skills"
assert_canonical_copy "$plain_copilot/skills"

mkdir -p "$collision_copilot/skills/note-add"
printf 'personal skill\n' >"$collision_copilot/skills/note-add/SKILL.md"
assert_command_fails "VAULT_PATH='$collision_vault' CODEX_HOME='$collision_codex' COPILOT_HOME='$collision_copilot' '$ROOT/install.sh'"
[ -f "$collision_copilot/skills/note-add/SKILL.md" ] || fail "installer overwrote an unmanaged canonical collision"
[ ! -e "$collision_vault/.codex" ] || fail "collision failure changed another destination"
[ ! -e "$collision_codex/skills" ] || fail "collision failure changed Codex destination"

printf '{\n' >"$invalid_copilot/mcp-config.json"
assert_command_fails "VAULT_PATH='$invalid_vault' CODEX_HOME='$invalid_codex' COPILOT_HOME='$invalid_copilot' '$ROOT/install.sh'"
[ ! -e "$invalid_vault/.codex" ] || fail "invalid configuration changed vault destination"
[ ! -e "$invalid_codex/skills" ] || fail "invalid configuration changed Codex destination"
[ ! -e "$invalid_copilot/skills" ] || fail "invalid configuration changed Copilot destination"

for kind in skills skill manifest locator config; do
  assert_dangling_preflight_failure "$kind"
done

assert_command_fails "VAULT_PATH='$plain_vault' CODEX_HOME='$plain_codex' COPILOT_HOME='$plain_copilot' '$ROOT/install.sh' --copilot-mcp"
assert_command_fails "VAULT_PATH='$plain_vault' CODEX_HOME='$plain_codex' COPILOT_HOME='$plain_copilot' COPILOT_MCP_CONFIG='relative.json' '$ROOT/install.sh' --dry-run"

assert_file scripts/install.mjs
assert_contains install.sh "scripts/install.mjs"
assert_not_contains install.sh "PROJECT_MANAGED_SKILLS"
