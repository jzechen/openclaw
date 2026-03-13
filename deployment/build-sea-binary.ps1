param(
  [switch]$StripRuntime,
  [switch]$KeepTemp,
  [switch]$Lite,
  [string]$RuntimeDir,
  [string]$NodeBin,
  [string]$Output,
  [string]$WorkDir
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path

$ArgsList = @("deployment/build-sea-binary.mjs")
if ($StripRuntime) {
  $ArgsList += "--strip-runtime"
}
if ($KeepTemp) {
  $ArgsList += "--keep-temp"
}
if ($Lite) {
  $ArgsList += "--lite"
}
if (-not [string]::IsNullOrWhiteSpace($RuntimeDir)) {
  $ArgsList += @("--runtime-dir", $RuntimeDir)
}
if (-not [string]::IsNullOrWhiteSpace($NodeBin)) {
  $ArgsList += @("--node-bin", $NodeBin)
}
if (-not [string]::IsNullOrWhiteSpace($Output)) {
  $ArgsList += @("--output", $Output)
}
if (-not [string]::IsNullOrWhiteSpace($WorkDir)) {
  $ArgsList += @("--work-dir", $WorkDir)
}

Push-Location $RepoRoot
try {
  & node @ArgsList
  if ($LASTEXITCODE -ne 0) {
    throw "SEA build failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}
