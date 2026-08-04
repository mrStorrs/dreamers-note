[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$VaultPath,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
  throw "bootstrap failed: $Message"
}

function Invoke-RequiredCommand([string]$FilePath, [string[]]$Arguments) {
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

if (-not [IO.Path]::IsPathRooted($VaultPath)) {
  Fail "vault path must be absolute"
}
if (-not (Test-Path -LiteralPath $VaultPath -PathType Container)) {
  Fail "vault path must be an existing directory"
}

$vaultItem = Get-Item -LiteralPath $VaultPath -Force
if (($vaultItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  Fail "vault path must not be a symbolic link or junction"
}

$root = Split-Path -Parent $PSCommandPath
$vaultPathResolved = $vaultItem.FullName
$configPath = Join-Path $root "config\vault.local.json"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Fail "npm is required (Node 18 or newer)"
}

if ($DryRun) {
  Write-Output "would create or validate: $configPath"
  Write-Output "would run: npm ci"
  Write-Output "would run: npm run build"
  Write-Output "would run: node scripts/install.mjs"
  return
}

if (Test-Path -LiteralPath $configPath -PathType Leaf) {
  try {
    $existing = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  } catch {
    Fail "local vault config is not valid JSON: $configPath"
  }
  if ($existing.vault_path -ne $vaultPathResolved) {
    Fail "local config already targets a different vault: $configPath"
  }
} else {
  $config = [PSCustomObject]@{ vault_path = $vaultPathResolved } | ConvertTo-Json
  [IO.File]::WriteAllText($configPath, "$config`n", [Text.UTF8Encoding]::new($false))
}

Push-Location $root
try {
  Invoke-RequiredCommand "npm" @("ci")
  Invoke-RequiredCommand "npm" @("run", "build")

  if (-not $env:HOME -and $env:USERPROFILE) {
    $env:HOME = $env:USERPROFILE
  }
  Invoke-RequiredCommand "node" @("scripts/install.mjs")
} finally {
  Pop-Location
}

Write-Output "Bootstrap complete. Start Copilot CLI from this directory with: copilot --experimental"
