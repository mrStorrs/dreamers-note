#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers/framework-contract-helpers.sh"

assert_file bootstrap.ps1
assert_contains bootstrap.ps1 "[CmdletBinding()]"
assert_contains bootstrap.ps1 '[IO.Path]::IsPathRooted($VaultPath)'
assert_contains bootstrap.ps1 "ReparsePoint"
assert_contains bootstrap.ps1 'Invoke-RequiredCommand "npm" @("ci")'
assert_contains bootstrap.ps1 'Invoke-RequiredCommand "npm" @("run", "build")'
assert_contains bootstrap.ps1 'Invoke-RequiredCommand "node" @("scripts/install.mjs")'
assert_contains bootstrap.ps1 "Restart Codex or Copilot"
assert_contains bootstrap.ps1 "note-*"
assert_not_contains bootstrap.ps1 "--copilot-mcp"
