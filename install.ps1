$ErrorActionPreference = "Stop"

Write-Error "CPM bootstrap is not released yet."
Write-Error "Release manifest: https://get.peanut-harness.dev/cpm/releases.json"
if ($env:CPM_PROJECT) {
  Write-Error "Requested project: $env:CPM_PROJECT"
}
Write-Error "No project changes were made."
exit 1
