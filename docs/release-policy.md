# CPM CLI release policy

A CPM CLI release moves through four separately checked steps. Git commits and
a green CI run are not a release; only a remotely read-back, signed manifest
entry is.

## 1. Candidate build (no secrets)

`node scripts/release-cli.mjs build --out <dir>` requires a clean tracked tree
and writes, without overwriting existing files:

- `peanut-cpm-cli-<version>.tgz`: the deterministic runtime archive;
- `peanut-cpm-cli-<version>.sbom.json`: a CycloneDX 1.5 SBOM with the archive
  digest, every runtime file digest and the source commit;
- `peanut-cpm-cli-<version>.candidate.json`: the evidence consumed by signing.

The build fails when a runtime module imports anything other than `node:`
built-ins or files inside the archive, so the license inventory has no
third-party entries. All outputs are scanned for private-key and credential
patterns.

## 2. Controlled signing

`sign --candidate <file> --channel <beta|internal> --url <https-url>` signs the
`cpm-release-v1` payload. `--dry-run` prints the canonical payload and needs no
key. Real signing reads the PEM only from `CPM_RELEASE_SIGNING_KEY` or
`--key-file`, never prints it, and refuses a key whose public half is not a
pinned anchor in `trust-anchors.mjs`. Test anchors apply only with
`CPM_TEST_MODE=1`.

In GitHub Actions, `.github/workflows/release-cli.yml` runs only by manual
dispatch on `main`. The build job has no secrets. The sign job runs in the
`cpm-release-signing` environment, which must be configured with required
reviewers and a `main`-only deployment branch rule; the key is stored only as
that environment's `CPM_RELEASE_SIGNING_KEY` secret. Forks and pull requests
never receive it. The signed output is scanned before it is uploaded as an
artifact.

## 3. Immutable upload and read-back

The archive is uploaded to an immutable HTTPS location that serves the bytes
directly (no redirects, user info or fragments). A version directory is never
rewritten. `readback --candidate <file> --url <https-url>` downloads the
archive and must match the candidate size and SHA-256 before the entry is used.

## 4. Manifest update

`merge --manifest <releases.json> --signed <signed-release.json>` adds the
entry after full verification. Re-merging identical bytes is a no-op;
changing the channel, URL, digest or signature of a published `id@version`
fails with `cpm_release_version_overwrite`, and a manifest never mixes signing
keys. Stable entries are added only after the evidence gates in the Lite
OpenSpec change `publish-signed-public-cpm-release` pass; until then the
public `releases.json` stays empty.
