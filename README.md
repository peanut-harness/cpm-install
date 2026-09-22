# CPM installation endpoint

Public, minimal installation endpoint for the Peanut Harness CPM command line tool.

This repository intentionally contains no private product binaries or credentials. Until a signed CPM release is published to the stable channel, both bootstrap scripts fail closed without changing a project.

`releases.json` uses schema version 2. Each release is selected by channel,
requires an HTTPS URL and SHA-256 digest, and carries an Ed25519 signature over
its immutable identity and download fields. An empty release list remains a
deliberate refusal state.

Non-empty release lists are verified against the public keys pinned in
`trust-anchors.mjs`. A key embedded only in the manifest is not trusted by
itself. The two pinned anchors support an explicit rotation window; production
trust cannot be replaced through an environment variable.

Expected endpoint after GitHub Pages and DNS are configured:

```bash
CPM_PROJECT="$PWD" /bin/bash -c "$(curl -fsSL https://get.peanut-harness.dev/cpm/install.sh)"
```

The shell and PowerShell launchers fetch the bootstrap modules over HTTPS rather
than assuming a repository checkout beside the launcher. `CPM_BOOTSTRAP_PATH`
and `CPM_RELEASE_MANIFEST_PATH` are test/deployment overrides; normal users
should leave both unset.

Local tests may set `CPM_TEST_MODE=1` together with
`CPM_TEST_TRUSTED_PUBLIC_KEYS` and a local manifest path. The override is
refused unless the explicit test gate is active and is never consulted for an
HTTPS manifest.

## Launcher behavior

Both launchers resolve the pinned manifest, install the verified CLI runtime
atomically under `CPM_HOME` (default `~/.peanut/cpm`), and print a structured
identity on stdout: `{"schemaVersion":1,"id":…,"version":…,"path":…}`.
Warnings go to stderr so stdout stays machine-readable. An empty or invalid
manifest still exits 1 with
`CPM installation failed without changing the selected current version.` and
leaves the requested project untouched; the launchers never run a project
command. The stable manifest stays empty until a signed release is published,
so public installs keep failing closed.

Local tests may additionally set `CPM_TEST_RELEASE_ARCHIVE_PATH` to install a
locally built runtime archive; it is honored only with `CPM_TEST_MODE=1` and a
local manifest. Tests run the launchers against temporary fixtures only.

## Lite product catalog

The installed CLI, not the bootstrap, authenticates Lite products:
`cpm product resolve <catalog> [channel] --json` reads a
`lite-product-catalog` (schema 1) whose entries are signed with the
`lite-product-v1` payload. Each entry binds the product id, version, channel,
source commit, Host/Core HTTPS URLs, archive SHA-256 values, directory-package
digests and the exact Creator profiles (`3.8.3`, `3.8.7`, ascending).

Product keys are pinned in `cli/product-trust-anchors.mjs` (current and next
for rotation) and must differ from the CPM release keys. Catalog and
archive downloads refuse redirects, a published `id@version` may never change
its signed fields, and a Lite release descriptor must match the signed entry
field for field. Local tests may inject `CPM_TEST_PRODUCT_TRUSTED_PUBLIC_KEYS`
only with `CPM_TEST_MODE=1` and a local catalog path.

## Lite project commands

`cpm lite <install|upgrade|repair> --project <path> --catalog <catalog> [--channel <channel>] --json`
installs Lite into a closed Creator 3.8 project. The command refuses while a
Creator process has the project open (or when that cannot be determined),
takes Lite's `peanut-plugins/.installed.lock`, and requires the project's
`creator.version` to be one of the signed product's Creator profiles.

Host and Core archives are downloaded without redirects, checked against the
signed SHA-256 values, read in memory, and verified against the signed Host
package digest and the Core manifest (per-file digests, exact payload set and
package digest) before anything in the project changes. The command then
places the Core in the immutable `peanut-plugins/plugins/<id>/<version>/`
directory, swaps `extensions/peanut-pod-lite-host`, and atomically rewrites
the schema v2 `peanut-plugins/installed.json`, preserving other plugins and
previous version records.

- `install` refuses when a different version is active; the same healthy
  version reports `unchanged`, a damaged one requires `repair`.
- `upgrade` moves to the highest catalog version and refuses downgrades.
- `repair` reinstalls the active version from the catalog.
- Failures before activation report `cpm_lite_install_unchanged:<cause>`.
  Failures after activation restore the previous Host, Core directory and index
  and report `cpm_lite_install_recovered:<cause>`; if that cannot be proven the
  command reports `cpm_lite_install_may_have_changed:<cause>` and keeps the
  journal under `peanut-plugins/.cpm-transactions/`.

Local tests may add `CPM_TEST_PRODUCT_ARCHIVE_DIR` to serve archives by file
name; it applies only with `CPM_TEST_MODE=1` and a local catalog.

## Local rehearsal without long-lived keys

`node scripts/local-rehearsal.mjs --lite-release <lite release dir> --work <empty dir> [--project <creator project>] [--action install|upgrade|repair] [--launcher bash|powershell]`
rehearses the whole chain on the current machine without any managed key: it
generates throwaway CPM and product Ed25519 keys in memory, signs a local
manifest and product catalog, installs the CLI through the real Bash (macOS,
Linux) or PowerShell (Windows) launcher into `<work>/cpm-home`, and runs
`cpm lite <action>` against the project. Private keys never touch disk, and the
injection only works through the `CPM_TEST_MODE=1` local-file gate, so public
HTTPS installs still require the pinned production anchors.

## Built-in development keys

`dev-signing.mjs` derives one CPM release key and one Lite product key from
public seeds, so everyone has the same development keys and they authenticate
nothing. They are trusted only when `CPM_DEV_KEYS=1` is set (a warning is
printed), are refused for the `stable` channel, and the CPM dev key is never
accepted for product catalogs. Sign development builds with
`node scripts/release-cli.mjs sign --dev-key ...` (CLI) or
`tsx tools/release-candidate.mts sign --dev-key --input ...` (Lite);
`release-cli.mjs merge` refuses dev-signed entries unless `--dev` is given for a
development manifest. `scripts/local-rehearsal.mjs --keys dev` runs the whole
chain with them.

## Releasing the CLI

Candidate build, controlled signing, immutable upload with read-back and
manifest updates are described in [docs/release-policy.md](docs/release-policy.md).

The following machine-readable error codes are the compatibility baseline for
the release and runtime validators:

- Release manifest: `cpm_release_manifest_invalid`,
  `cpm_release_trust_anchor_missing`, `cpm_release_trust_anchor_mismatch`,
  `cpm_release_public_key_missing`, `cpm_release_entry_invalid`,
  `cpm_release_signature_invalid`, `cpm_release_duplicate`,
  `cpm_release_unavailable`, `cpm_release_manifest_source_missing`,
  `cpm_release_manifest_request_refused:<status>`,
  `cpm_release_request_refused:<status>`, and
  `cpm_release_digest_mismatch`.
- Runtime installation: `cpm_install_input_invalid`,
  `cpm_runtime_archive_path_invalid`, `cpm_runtime_hidden_path_rejected`,
  `cpm_runtime_manifest_invalid`, `cpm_runtime_file_record_invalid`,
  `cpm_runtime_entry_missing`, `cpm_runtime_release_mismatch`,
  `cpm_runtime_integrity_mismatch`, `cpm_runtime_symbolic_link_rejected`,
  `cpm_runtime_special_file_rejected`, and
  `cpm_runtime_version_already_installed`.
- Product catalog: `cpm_product_catalog_invalid`,
  `cpm_product_catalog_source_missing`,
  `cpm_product_catalog_request_refused:<status>`,
  `cpm_product_public_key_missing`, `cpm_product_key_reuse`,
  `cpm_product_trust_anchor_missing`, `cpm_product_trust_anchor_mismatch`,
  `cpm_product_test_trust_anchor_refused`, `cpm_product_entry_invalid`,
  `cpm_product_signature_invalid`, `cpm_product_duplicate`,
  `cpm_product_version_overwrite`, `cpm_product_identity_mismatch`,
  `cpm_product_redirect_refused`, `cpm_product_request_refused:<status>`,
  `cpm_product_digest_mismatch`, and `cpm_product_unavailable`.
- Product archives: `cpm_product_archive_invalid`,
  `cpm_product_archive_hidden_payload`, `cpm_product_archive_empty`,
  `cpm_product_archive_truncated`, `cpm_product_archive_special_file_rejected`,
  `cpm_product_archive_path_invalid`, `cpm_product_archive_duplicate_path`,
  `cpm_product_archive_root_invalid`, `cpm_product_host_invalid`,
  `cpm_product_core_manifest_invalid`, `cpm_product_core_payload_mismatch`, and
  `cpm_product_package_digest_mismatch`.
- Lite project commands: `cpm_lite_action_invalid`, `cpm_lite_project_invalid`,
  `cpm_lite_creator_project_open`, `cpm_lite_creator_occupancy_unknown`,
  `cpm_lite_creator_version_unsupported`, `cpm_lite_installed_index_invalid`,
  `cpm_lite_project_locked`, `cpm_lite_not_installed`,
  `cpm_lite_already_installed`, `cpm_lite_downgrade_refused`,
  `cpm_lite_repair_required`, `cpm_lite_install_unchanged:<cause>`,
  `cpm_lite_install_recovered:<cause>`, and
  `cpm_lite_install_may_have_changed:<cause>`.
- Development keys: `cpm_release_dev_key_stable_refused`,
  `cpm_product_dev_key_stable_refused`, `cpm_release_dev_key_refused`, and
  `cpm_dev_key_purpose_invalid`.
- Release tooling: `cpm_release_source_dirty`, `cpm_release_url_invalid`,
  `cpm_release_signing_key_missing`, `cpm_release_signing_key_invalid`,
  `cpm_release_signing_key_not_anchored`, `cpm_release_manifest_key_mismatch`,
  `cpm_release_version_overwrite`, `cpm_release_readback_redirect_refused`,
  `cpm_release_readback_refused:<status>`, `cpm_release_readback_mismatch`,
  `cpm_release_secret_detected`, `cpm_release_third_party_dependency:<name>`,
  and `cpm_release_runtime_import_missing:<path>`.
