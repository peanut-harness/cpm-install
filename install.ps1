$ErrorActionPreference = "Stop"

$manifestSource = if ($env:CPM_RELEASE_MANIFEST_PATH) { $env:CPM_RELEASE_MANIFEST_PATH } else { "https://get.peanut-harness.dev/cpm/releases.json" }
$bootstrapSource = if ($env:CPM_BOOTSTRAP_PATH) { $env:CPM_BOOTSTRAP_PATH } else { "https://get.peanut-harness.dev/cpm/bootstrap.mjs" }
$channel = if ($env:CPM_CHANNEL) { $env:CPM_CHANNEL } else { "stable" }

$bootstrapPath = $bootstrapSource
$temporaryBootstrap = $null
$temporaryBootstrapDirectory = $null

try {
  if ($bootstrapSource -like "https://*") {
    $temporaryBootstrapDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("peanut-cpm-bootstrap-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $temporaryBootstrapDirectory | Out-Null
    $temporaryBootstrap = Join-Path $temporaryBootstrapDirectory "bootstrap.mjs"
    Invoke-WebRequest -Uri $bootstrapSource -OutFile $temporaryBootstrap -MaximumRedirection 0
    Invoke-WebRequest -Uri "https://get.peanut-harness.dev/cpm/release-manifest.mjs" -OutFile (Join-Path $temporaryBootstrapDirectory "release-manifest.mjs") -MaximumRedirection 0
    Invoke-WebRequest -Uri "https://get.peanut-harness.dev/cpm/runtime-manifest.mjs" -OutFile (Join-Path $temporaryBootstrapDirectory "runtime-manifest.mjs") -MaximumRedirection 0
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
if ($temporaryBootstrapDirectory -and (Test-Path -LiteralPath $temporaryBootstrapDirectory)) {
  Remove-Item -LiteralPath $temporaryBootstrapDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
exit 1
