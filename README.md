# CPM installation endpoint

Public, minimal installation endpoint for the Peanut Harness CPM command line tool.

This repository intentionally contains no private product binaries or credentials. Until a signed CPM release is published, both bootstrap scripts fail closed without changing a project.

`releases.json` uses schema version 2. Each release is selected by channel,
requires an HTTPS URL and SHA-256 digest, and carries an Ed25519 signature over
its immutable identity and download fields. An empty release list remains a
deliberate refusal state.

Before enabling a non-empty release list, the deployment must provide the
out-of-band `CPM_TRUSTED_PUBLIC_KEY` trust anchor. A key embedded only in the
manifest is not trusted by itself.

Expected endpoint after GitHub Pages and DNS are configured:

```bash
CPM_PROJECT="$PWD" /bin/bash -c "$(curl -fsSL https://get.peanut-harness.dev/cpm/install.sh)"
```

The shell and PowerShell launchers fetch the bootstrap modules over HTTPS rather
than assuming a repository checkout beside the launcher. `CPM_BOOTSTRAP_PATH`
and `CPM_RELEASE_MANIFEST_PATH` are test/deployment overrides; normal users
should leave both unset.

## Fail-closed compatibility baseline

Until automatic CLI installation is enabled, both launchers exit with status 1
and print `No project changes were made.` Tests run them against only temporary
fixtures and verify that the requested project is unchanged.

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
