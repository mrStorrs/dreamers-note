[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$VaultPath,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node 18 or newer is required for the installer script."
}
$script = Join-Path $PSScriptRoot "scripts/install.mjs"
$arguments = @($script)
if ($VaultPath) { $arguments += $VaultPath }
if ($DryRun) { $arguments += "--dry-run" }
& node @arguments
exit $LASTEXITCODE
