#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "$ROOT/scripts/validate-framework.mjs"
node --test "$ROOT"/tests/*.test.mjs
bash -n "$ROOT/bootstrap.sh" "$ROOT/install.sh" "$ROOT/scripts/validate-framework.sh"
bash "$ROOT/tests/test-public-release.sh"
