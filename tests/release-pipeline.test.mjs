import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CpmReleaseManifest } from '../release-manifest.mjs';
import { assertNoSecrets, buildCandidate, mergeManifest, signRelease, verifyReadback } from '../scripts/release-cli.mjs';

const sourceCommit = 'a'.repeat(40);
const baseUrl = 'https://releases.peanut-harness.dev/cpm/1.0.0';

function testKey() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const value = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const anchor = { keyId: 'pipeline-test', value };
    return {
        pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        anchor,
        env: { CPM_TEST_MODE: '1', CPM_TEST_TRUSTED_PUBLIC_KEYS: JSON.stringify([anchor]) },
        parseOptions: { allowTestTrustAnchors: true, testTrustAnchors: [anchor] },
    };
}

async function withCandidate(run) {
    const root = await mkdtemp(join(tmpdir(), 'cpm-release-pipeline-'));
    try {
        await run(await buildCandidate(root, { sourceCommit }), root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test('builds a deterministic candidate with SBOM, license and dependency evidence but no secrets', async () => {
    await withCandidate(async (candidate, root) => {
        assert.deepEqual((await readdir(root)).sort(), [candidate.archive.name, `${candidate.id}-${candidate.version}.candidate.json`, candidate.sbom.name].sort());
        const archive = await readFile(join(root, candidate.archive.name));
        assert.equal(createHash('sha256').update(archive).digest('hex'), candidate.archive.sha256);
        const sbom = JSON.parse(await readFile(join(root, candidate.sbom.name), 'utf8'));
        assert.equal(sbom.bomFormat, 'CycloneDX');
        assert.equal(sbom.metadata.component.hashes[0].content, candidate.archive.sha256);
        assert.deepEqual(sbom.components.map((component) => component.name), candidate.runtimeFiles.map((file) => file.path));
        assert.deepEqual(sbom.properties.find((property) => property.name === 'peanut:thirdPartyDependencies'), { name: 'peanut:thirdPartyDependencies', value: '0' });
        const again = await mkdtemp(join(tmpdir(), 'cpm-release-pipeline-again-'));
        try {
            assert.deepEqual(await buildCandidate(again, { sourceCommit }), candidate);
        } finally {
            await rm(again, { recursive: true, force: true });
        }
        const texts = await Promise.all((await readdir(root)).filter((name) => name.endsWith('.json')).map((name) => readFile(join(root, name), 'utf8')));
        assertNoSecrets(texts);
    });
});

test('dry-run needs no key while real signing fails closed without a pinned key', async () => {
    await withCandidate(async (candidate) => {
        const url = `${baseUrl}/${candidate.archive.name}`;
        const dryRun = signRelease(candidate, { channel: 'beta', url, dryRun: true });
        assert.equal(JSON.parse(dryRun.payload).sha256, candidate.archive.sha256);
        assert.throws(() => signRelease(candidate, { channel: 'beta', url, env: {} }), /cpm_release_signing_key_missing/u);
        assert.throws(() => signRelease(candidate, { channel: 'beta', url, privateKeyPem: 'not a key', env: {} }), /cpm_release_signing_key_invalid/u);
        const key = testKey();
        assert.throws(() => signRelease(candidate, { channel: 'beta', url, privateKeyPem: key.pem, env: {} }), /cpm_release_signing_key_not_anchored/u);
        assert.throws(() => signRelease(candidate, { channel: 'beta', url: `${baseUrl}/other.tgz`, dryRun: true }), /cpm_release_url_invalid/u);
        assert.throws(() => signRelease(candidate, { channel: 'beta', url: `http://releases.peanut-harness.dev/${candidate.archive.name}`, dryRun: true }), /cpm_release_url_invalid/u);
    });
});

test('temporary test key signs a verifiable entry that never contains private material', async () => {
    await withCandidate(async (candidate) => {
        const key = testKey();
        const signed = signRelease(candidate, { channel: 'beta', url: `${baseUrl}/${candidate.archive.name}`, privateKeyPem: key.pem, env: key.env });
        const text = JSON.stringify(signed);
        assertNoSecrets([text]);
        assert.equal(text.includes(key.pem.split('\n')[1]), false);
        const manifest = mergeManifest({ schemaVersion: 2, channel: 'stable', publicKey: null, releases: [] }, signed, key.parseOptions);
        const parsed = CpmReleaseManifest.parse(manifest, key.parseOptions);
        assert.equal(CpmReleaseManifest.select(parsed, 'beta').sha256, candidate.archive.sha256);
        assert.equal(CpmReleaseManifest.select(parsed, 'stable'), null);
        assert.throws(() => assertNoSecrets([key.pem]), /cpm_release_secret_detected/u);
    });
});

test('manifest merge is idempotent but refuses version overwrites and key mixing', async () => {
    await withCandidate(async (candidate) => {
        const key = testKey();
        const url = `${baseUrl}/${candidate.archive.name}`;
        const signed = signRelease(candidate, { channel: 'beta', url, privateKeyPem: key.pem, env: key.env });
        const manifest = mergeManifest({ schemaVersion: 2, channel: 'stable', publicKey: null, releases: [] }, signed, key.parseOptions);
        assert.equal(mergeManifest(manifest, signed, key.parseOptions), manifest);
        const rebuilt = signRelease({ ...candidate, archive: { ...candidate.archive, sha256: 'f'.repeat(64) } }, { channel: 'beta', url, privateKeyPem: key.pem, env: key.env });
        assert.throws(() => mergeManifest(manifest, rebuilt, key.parseOptions), /cpm_release_version_overwrite/u);
        const other = testKey();
        const foreign = signRelease(candidate, { channel: 'beta', url, privateKeyPem: other.pem, env: other.env });
        assert.throws(() => mergeManifest(manifest, foreign, { allowTestTrustAnchors: true, testTrustAnchors: [key.anchor, other.anchor] }), /cpm_release_manifest_key_mismatch/u);
    });
});

test('read-back verifies uploaded bytes without following redirects', async () => {
    await withCandidate(async (candidate, root) => {
        const archive = await readFile(join(root, candidate.archive.name));
        const url = `${baseUrl}/${candidate.archive.name}`;
        const seen = [];
        const evidence = await verifyReadback(candidate, url, async (requested, init) => {
            seen.push([requested, init.redirect]);
            return { ok: true, redirected: false, arrayBuffer: async () => archive };
        });
        assert.deepEqual(seen, [[url, 'error']]);
        assert.equal(evidence.sha256, candidate.archive.sha256);
        await assert.rejects(verifyReadback(candidate, url, async () => ({ ok: true, redirected: false, arrayBuffer: async () => Buffer.concat([archive, Buffer.from('x')]) })), /cpm_release_readback_mismatch/u);
        await assert.rejects(verifyReadback(candidate, url, async () => ({ ok: true, redirected: true, arrayBuffer: async () => archive })), /cpm_release_readback_redirect_refused/u);
        await assert.rejects(verifyReadback(candidate, url, async () => ({ ok: false, status: 403 })), /cpm_release_readback_refused:403/u);
    });
});
