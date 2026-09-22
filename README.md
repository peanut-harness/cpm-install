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

Product keys are pinned in `cli/product-trust-anchors.mjs` and must differ
from the CPM release keys. The list is empty until the controlled product
signing keys are issued, so every non-empty catalog is refused. Catalog and
archive downloads refuse redirects, a published `id@version` may never change
its signed fields, and a Lite release descriptor must match the signed entry
field for field. Local tests may inject `CPM_TEST_PRODUCT_TRUSTED_PUBLIC_KEYS`
only with `CPM_TEST_MODE=1` and a local catalog path.

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
