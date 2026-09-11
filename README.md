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
