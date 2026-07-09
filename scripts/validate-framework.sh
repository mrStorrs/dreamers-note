#!/usr/bin/env bash
set -euo pipefail

ROOT="${FRAMEWORK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
exec node "$ROOT/scripts/validate-framework.mjs" "$@"
