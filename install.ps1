$ErrorActionPreference = "Stop"

$manifestSource = if ($env:CPM_RELEASE_MANIFEST_PATH) { $env:CPM_RELEASE_MANIFEST_PATH } else { "https://get.peanut-harness.dev/cpm/releases.json" }
$bootstrapSource = if ($env:CPM_BOOTSTRAP_PATH) { $env:CPM_BOOTSTRAP_PATH } else { "https://get.peanut-harness.dev/cpm/bootstrap.mjs" }
$channel = if ($env:CPM_CHANNEL) { $env:CPM_CHANNEL } else { "stable" }

$bootstrapPath = $bootstrapSource
$temporaryBootstrap = $null

try {
  if ($bootstrapSource -like "https://*") {
    $temporaryBootstrap = [System.IO.Path]::GetTempFileName() + ".mjs"
    Invoke-WebRequest -Uri $bootstrapSource -OutFile $temporaryBootstrap -MaximumRedirection 0
    $bootstrapPath = $temporaryBootstrap
  }
  $releaseJson = node $bootstrapPath $manifestSource $channel 2>$null
  Write-Error "CPM release is available but automatic CLI installation is not enabled yet."
  Write-Error "Selected release: $releaseJson"
} catch {
  Write-Error "CPM bootstrap is not released yet."
  Write-Error "Release manifest: https://get.peanut-harness.dev/cpm/releases.json"
}

if ($env:CPM_PROJECT) {
  Write-Error "Requested project: $env:CPM_PROJECT"
}
Write-Error "No project changes were made."
if ($temporaryBootstrap -and (Test-Path -LiteralPath $temporaryBootstrap)) {
  Remove-Item -LiteralPath $temporaryBootstrap -Force -ErrorAction SilentlyContinue
}
exit 1
