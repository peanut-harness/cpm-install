#!/usr/bin/env bash
set -euo pipefail

readonly release_manifest_url="https://get.peanut-harness.dev/cpm/releases.json"
readonly release_bootstrap_url="https://get.peanut-harness.dev/cpm/bootstrap.mjs"
readonly target_project="${CPM_PROJECT:-}"
readonly manifest_source="${CPM_RELEASE_MANIFEST_PATH:-${release_manifest_url}}"
readonly bootstrap_source="${CPM_BOOTSTRAP_PATH:-${release_bootstrap_url}}"

if ! command -v curl >/dev/null 2>&1; then
  printf '%s\n' 'CPM bootstrap requires curl.' >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'CPM bootstrap requires Node.js.' >&2
  exit 1
fi

bootstrap_path=""
bootstrap_cleanup() {
  if [[ -n "${bootstrap_path}" && -f "${bootstrap_path}" ]]; then
    rm -f -- "${bootstrap_path}"
  fi
}
trap bootstrap_cleanup EXIT

if [[ "${bootstrap_source}" == https://* ]]; then
  bootstrap_path="$(mktemp "${TMPDIR:-/tmp}/peanut-cpm-bootstrap.XXXXXX.mjs")"
  if ! curl --fail --silent --show-error --location --proto '=https' -- "$bootstrap_source" > "$bootstrap_path"; then
    printf '%s\n' 'CPM bootstrap script could not be downloaded.' >&2
    exit 1
  fi
else
  bootstrap_path="$bootstrap_source"
fi

if release_json="$(node "$bootstrap_path" "$manifest_source" "${CPM_CHANNEL:-stable}" 2>/dev/null)"; then
  printf '%s\n' 'CPM release is available but automatic CLI installation is not enabled yet.' >&2
  printf '%s\n' "Selected release: ${release_json}" >&2
else
  printf '%s\n' 'CPM bootstrap is not released yet.' >&2
  printf '%s\n' "Release manifest: ${release_manifest_url}" >&2
fi

if [[ -n "${target_project}" ]]; then
  printf '%s\n' "Requested project: ${target_project}" >&2
fi
printf '%s\n' 'No project changes were made.' >&2
exit 1
