$ErrorActionPreference = "Stop"

$manifestSource = if ($env:CPM_RELEASE_MANIFEST_PATH) { $env:CPM_RELEASE_MANIFEST_PATH } else { "https://get.peanut-harness.dev/cpm/releases.json" }
$bootstrapSource = if ($env:CPM_BOOTSTRAP_PATH) { $env:CPM_BOOTSTRAP_PATH } else { "https://get.peanut-harness.dev/cpm/bootstrap.mjs" }
$channel = if ($env:CPM_CHANNEL) { $env:CPM_CHANNEL } else { "stable" }
$installRoot = if ($env:CPM_HOME) { $env:CPM_HOME } else { Join-Path $HOME ".peanut/cpm" }

$bootstrapPath = $bootstrapSource
$temporaryBootstrap = $null
$temporaryBootstrapDirectory = $null

try {
  if ($bootstrapSource -like "https://*") {
    $temporaryBootstrapDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("peanut-cpm-bootstrap-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $temporaryBootstrapDirectory | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $temporaryBootstrapDirectory "transaction") | Out-Null
    $temporaryBootstrap = Join-Path $temporaryBootstrapDirectory "bootstrap.mjs"
    Invoke-WebRequest -Uri $bootstrapSource -OutFile $temporaryBootstrap -MaximumRedirection 0
    Invoke-WebRequest -Uri "https://get.peanut-harness.dev/cpm/release-manifest.mjs" -OutFile (Join-Path $temporaryBootstrapDirectory "release-manifest.mjs") -MaximumRedirection 0
    Invoke-WebRequest -Uri "https://get.peanut-harness.dev/cpm/runtime-manifest.mjs" -OutFile (Join-Path $temporaryBootstrapDirectory "runtime-manifest.mjs") -MaximumRedirection 0
    Invoke-WebRequest -Uri "https://get.peanut-harness.dev/cpm/signing-protocol.mjs" -OutFile (Join-Path $temporaryBootstrapDirectory "signing-protocol.mjs") -MaximumRedirection 0
    Invoke-WebRequest -Uri "https://get.peanut-harness.dev/cpm/trust-anchors.mjs" -OutFile (Join-Path $temporaryBootstrapDirectory "trust-anchors.mjs") -MaximumRedirection 0
    Invoke-WebRequest -Uri "https://get.peanut-harness.dev/cpm/transaction/install-journal.mjs" -OutFile (Join-Path $temporaryBootstrapDirectory "transaction/install-journal.mjs") -MaximumRedirection 0
    Invoke-WebRequest -Uri "https://get.peanut-harness.dev/cpm/transaction/runtime-install-transaction.mjs" -OutFile (Join-Path $temporaryBootstrapDirectory "transaction/runtime-install-transaction.mjs") -MaximumRedirection 0
    $bootstrapPath = $temporaryBootstrap
  }
  $identityJson = & node $bootstrapPath install $manifestSource $channel $installRoot
  if ($LASTEXITCODE -ne 0) {
    throw "cpm_install_failed"
  }
  Write-Output $identityJson
  if ($env:CPM_PROJECT) {
    [Console]::Error.WriteLine("CPM CLI installed; no project command was run for $env:CPM_PROJECT.")
  }
} catch {
  Write-Error "CPM installation failed without changing the selected current version." -ErrorAction Continue
  exit 1
} finally {
  if ($temporaryBootstrapDirectory -and (Test-Path -LiteralPath $temporaryBootstrapDirectory)) {
    Remove-Item -LiteralPath $temporaryBootstrapDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}
