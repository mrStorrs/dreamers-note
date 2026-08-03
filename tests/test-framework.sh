#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run() {
  printf '==> %s\n' "$*"
  "$@"
}

run bash "$ROOT/scripts/validate-framework.sh"
run bash "$ROOT/tests/test-framework-doc-contracts.sh"
run bash "$ROOT/tests/test-framework-skill-contracts.sh"
run bash "$ROOT/tests/test-framework-installer-contracts.sh"
run bash "$ROOT/tests/test-vault-bootstrap-contracts.sh"
run bash "$ROOT/tests/test-public-release.sh"
run python3 "$ROOT/tests/test-script-fixtures.py"
run python3 "$ROOT/tests/test-daily-triage.py"
run python3 "$ROOT/tests/test-vault-normalization.py"
run python3 "$ROOT/tests/test-vault-remap.py"
run bash -n \
  "$ROOT/scripts/validate-framework.sh" \
  "$ROOT/scripts/validate-vault-bootstrap.sh" \
  "$ROOT/bootstrap.sh" \
  "$ROOT/tests/helpers/framework-contract-helpers.sh" \
  "$ROOT/tests/test-framework.sh" \
  "$ROOT/tests/test-framework-doc-contracts.sh" \
  "$ROOT/tests/test-framework-skill-contracts.sh" \
  "$ROOT/tests/test-framework-installer-contracts.sh" \
  "$ROOT/tests/test-vault-bootstrap-contracts.sh"
run npm run typecheck
run npm test
