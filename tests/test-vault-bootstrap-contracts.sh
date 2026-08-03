#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers/framework-contract-helpers.sh"

temp_vault="$(mktemp -d)"
make_temp_vault "$temp_vault"
VAULT_PATH="$temp_vault" bash "$ROOT/scripts/validate-vault-bootstrap.sh"

temp_root="$(mktemp -d)"
temp_vault="$(mktemp -d)"
make_temp_framework "$temp_root"
make_temp_vault "$temp_vault"
printf '{"vault_path":"%s"}\n' "$temp_vault" >"$temp_root/config/vault.local.json"
FRAMEWORK_ROOT="$temp_root" bash "$ROOT/scripts/validate-vault-bootstrap.sh"

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
printf '\n- extra-topic\n' >>"$temp_vault/07-system/taxonomy/approved-tags.md"
git -C "$temp_vault" add 07-system/taxonomy/approved-tags.md
assert_command_fails "VAULT_PATH='$temp_vault' bash '$ROOT/scripts/validate-vault-bootstrap.sh'"
