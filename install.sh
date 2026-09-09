#!/usr/bin/env bash
set -euo pipefail

readonly release_manifest_url="https://get.peanut-harness.dev/cpm/releases.json"
readonly target_project="${CPM_PROJECT:-}"

if ! command -v curl >/dev/null 2>&1; then
  printf '%s\n' 'CPM bootstrap requires curl.' >&2
  exit 1
fi

printf '%s\n' 'CPM bootstrap is not released yet.' >&2
printf '%s\n' "Release manifest: ${release_manifest_url}" >&2
if [[ -n "${target_project}" ]]; then
  printf '%s\n' "Requested project: ${target_project}" >&2
fi
printf '%s\n' 'No project changes were made.' >&2
exit 1
