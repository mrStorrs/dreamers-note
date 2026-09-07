#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "usage: ./bootstrap.sh [--dry-run] <absolute-vault-path>" >&2
  exit 2
}

dry_run=false
vault_path=""
for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run=true ;;
    -h|--help) usage ;;
    /*)
      [ -z "$vault_path" ] || usage
      vault_path="$argument"
      ;;
    *) usage ;;
  esac
done

[ -n "$vault_path" ] || usage
[ -d "$vault_path" ] && [ ! -L "$vault_path" ] || {
  echo "bootstrap failed: vault path must be an existing non-symlink directory" >&2
  exit 2
}
command -v npm >/dev/null || {
  echo "bootstrap failed: npm is required (Node 18 or newer)" >&2
  exit 2
}

config_path="$ROOT/config/vault.local.json"
if [ "$dry_run" = true ]; then
  echo "would create or validate: $config_path"
  echo "would run: npm ci"
  echo "would run: npm run build"
  echo "would run: VAULT_PATH=$vault_path ./install.sh"
  exit 0
fi

node -e '
const fs = require("fs");
const [vaultPath, configPath] = process.argv.slice(1);
if (fs.existsSync(configPath)) {
  const existing = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (existing.vault_path !== vaultPath) {
    throw new Error(`local config already targets a different vault: ${configPath}`);
  }
} else {
  fs.writeFileSync(configPath, `${JSON.stringify({ vault_path: vaultPath }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
' "$vault_path" "$config_path"

(cd "$ROOT" && npm ci && npm run build)
VAULT_PATH="$vault_path" "$ROOT/install.sh"
