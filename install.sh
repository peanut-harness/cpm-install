#!/usr/bin/env bash
set -euo pipefail

readonly release_manifest_url="https://get.peanut-harness.dev/cpm/releases.json"
readonly release_bootstrap_url="https://get.peanut-harness.dev/cpm/bootstrap.mjs"
readonly target_project="${CPM_PROJECT:-}"
readonly manifest_source="${CPM_RELEASE_MANIFEST_PATH:-${release_manifest_url}}"
readonly bootstrap_source="${CPM_BOOTSTRAP_PATH:-${release_bootstrap_url}}"
readonly manifest_validator_url="https://get.peanut-harness.dev/cpm/release-manifest.mjs"
readonly runtime_manifest_url="https://get.peanut-harness.dev/cpm/runtime-manifest.mjs"
readonly signing_protocol_url="https://get.peanut-harness.dev/cpm/signing-protocol.mjs"
readonly trust_anchors_url="https://get.peanut-harness.dev/cpm/trust-anchors.mjs"
readonly install_journal_url="https://get.peanut-harness.dev/cpm/transaction/install-journal.mjs"
readonly runtime_transaction_url="https://get.peanut-harness.dev/cpm/transaction/runtime-install-transaction.mjs"
readonly install_root="${CPM_HOME:-${HOME}/.peanut/cpm}"

if ! command -v curl >/dev/null 2>&1; then
  printf '%s\n' 'CPM bootstrap requires curl.' >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'CPM bootstrap requires Node.js.' >&2
  exit 1
fi

bootstrap_path=""
bootstrap_directory=""
bootstrap_cleanup() {
  if [[ -n "${bootstrap_directory}" && -d "${bootstrap_directory}" ]]; then
    rm -rf -- "${bootstrap_directory}"
  fi
}
trap bootstrap_cleanup EXIT

if [[ "${bootstrap_source}" == https://* ]]; then
  bootstrap_directory="$(mktemp -d "${TMPDIR:-/tmp}/peanut-cpm-bootstrap.XXXXXX")"
  mkdir -p "${bootstrap_directory}/transaction"
  bootstrap_path="${bootstrap_directory}/bootstrap.mjs"
  if ! curl --fail --silent --show-error --location --proto '=https' -- "$bootstrap_source" > "$bootstrap_path" \
    || ! curl --fail --silent --show-error --location --proto '=https' -- "$manifest_validator_url" > "${bootstrap_directory}/release-manifest.mjs" \
    || ! curl --fail --silent --show-error --location --proto '=https' -- "$runtime_manifest_url" > "${bootstrap_directory}/runtime-manifest.mjs" \
    || ! curl --fail --silent --show-error --location --proto '=https' -- "$signing_protocol_url" > "${bootstrap_directory}/signing-protocol.mjs" \
    || ! curl --fail --silent --show-error --location --proto '=https' -- "$trust_anchors_url" > "${bootstrap_directory}/trust-anchors.mjs" \
    || ! curl --fail --silent --show-error --location --proto '=https' -- "$install_journal_url" > "${bootstrap_directory}/transaction/install-journal.mjs" \
    || ! curl --fail --silent --show-error --location --proto '=https' -- "$runtime_transaction_url" > "${bootstrap_directory}/transaction/runtime-install-transaction.mjs"; then
    printf '%s\n' 'CPM bootstrap script could not be downloaded.' >&2
    exit 1
  fi
else
  bootstrap_path="$bootstrap_source"
fi

if ! identity_json="$(node "$bootstrap_path" install "$manifest_source" "${CPM_CHANNEL:-stable}" "$install_root")"; then
  printf '%s\n' 'CPM installation failed without changing the selected current version.' >&2
  exit 1
fi

printf '%s\n' "$identity_json"
if [[ -n "${target_project}" ]]; then
  printf '%s\n' "CPM CLI installed; no project command was run for ${target_project}." >&2
fi
