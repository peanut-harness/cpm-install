import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { writeFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CpmReleaseManifest } from '../release-manifest.mjs';
import { CpmSigningProtocol } from '../signing-protocol.mjs';
import { CPM_RELEASE_TRUST_ANCHORS } from '../trust-anchors.mjs';

function signedRelease(key, version = '1.2.0', channel = 'stable') {
    const release = { id: 'peanut.cpm', version, channel, url: `https://get.peanut-harness.dev/cpm/peanut-cpm-${version}.tgz`, sha256: 'a'.repeat(64) };
    const payload = CpmSigningProtocol.canonicalize('cpm-release-v1', release);
    return { ...release, signature: sign(null, Buffer.from(payload), key).toString('base64') };
}

test('accepts signed releases and selects the highest version per channel', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyValue = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const anchor = { keyId: 'test-release', value: publicKeyValue };
    const options = { allowTestTrustAnchors: true, testTrustAnchors: [anchor] };
    const manifest = CpmReleaseManifest.parse({ schemaVersion: 2, channel: 'stable', publicKey: { keyId: anchor.keyId, algorithm: 'ed25519', format: 'spki-der-base64', value: publicKeyValue }, releases: [signedRelease(privateKey, '1.1.0'), signedRelease(privateKey, '1.2.0'), signedRelease(privateKey, '2.0.0', 'beta')] }, options);
    assert.equal(CpmReleaseManifest.select(manifest).version, '1.2.0');
    assert.equal(CpmReleaseManifest.select(manifest, 'beta').version, '2.0.0');
});

test('requires a fixed trust anchor when bootstrap parses a non-empty release list', () => {
    const release = { schemaVersion: 2, channel: 'stable', publicKey: { keyId: 'unknown', algorithm: 'ed25519', format: 'spki-der-base64', value: 'key' }, releases: [{ id: 'peanut.cpm', version: '1.0.0', channel: 'stable', url: 'https://example.test/cpm.tgz', sha256: 'a'.repeat(64), signature: 'sig' }] };
    assert.throws(() => CpmReleaseManifest.parse(release, { allowTestTrustAnchors: true, testTrustAnchors: [] }), /cpm_release_trust_anchor_missing/u);
    assert.throws(() => CpmReleaseManifest.parse(release, { allowTestTrustAnchors: true, testTrustAnchors: [{ keyId: 'different', value: 'different-key' }] }), /cpm_release_trust_anchor_mismatch/u);
    assert.throws(() => CpmReleaseManifest.parse(release, { testTrustAnchors: [{ keyId: 'unknown', value: 'key' }] }), /cpm_release_test_trust_anchor_refused/u);
});

test('rejects unsigned, non-HTTPS, duplicate, and empty-release mistakes', () => {
    const empty = CpmReleaseManifest.parse({ schemaVersion: 2, channel: 'stable', releases: [] });
    assert.equal(CpmReleaseManifest.select(empty), null);
    assert.throws(() => CpmReleaseManifest.parse({ schemaVersion: 2, channel: 'stable', releases: [{ id: 'peanut.cpm', version: '1.0.0', channel: 'stable', url: 'http://example.test/cpm.tgz', sha256: 'a'.repeat(64), signature: 'bad' }] }), /cpm_release_public_key_missing/u);
});

test('rejects bad signatures, signed-field tampering, and duplicate versions', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const value = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const anchor = { keyId: 'test-release', value };
    const options = { allowTestTrustAnchors: true, testTrustAnchors: [anchor] };
    const publicKeyRecord = { ...anchor, algorithm: 'ed25519', format: 'spki-der-base64' };
    const release = signedRelease(privateKey, '1.0.0');
    assert.throws(
        () => CpmReleaseManifest.parse({ schemaVersion: 2, channel: 'stable', publicKey: publicKeyRecord, releases: [{ ...release, signature: 'invalid' }] }, options),
        /cpm_release_signature_invalid/u,
    );
    assert.throws(
        () => CpmReleaseManifest.parse({ schemaVersion: 2, channel: 'stable', publicKey: publicKeyRecord, releases: [{ ...release, url: 'https://example.test/tampered.tgz' }] }, options),
        /cpm_release_signature_invalid/u,
    );
    assert.throws(
        () => CpmReleaseManifest.parse({ schemaVersion: 2, channel: 'stable', publicKey: publicKeyRecord, releases: [release, release] }, options),
        /cpm_release_duplicate/u,
    );
});

test('accepts releases signed by either pinned anchor during rotation', async () => {
    const fixture = JSON.parse(await readFile(new URL('./fixtures/trust-anchor-rotation.json', import.meta.url), 'utf8'));
    assert.deepEqual(fixture.vectors.map((vector) => vector.publicKey), CPM_RELEASE_TRUST_ANCHORS.map((anchor) => anchor.value));
    for (const vector of fixture.vectors) {
        const manifest = CpmReleaseManifest.parse({
            schemaVersion: 2,
            channel: 'beta',
            publicKey: { keyId: vector.keyId, algorithm: 'ed25519', format: 'spki-der-base64', value: vector.publicKey },
            releases: [{ ...vector.fields, signature: vector.signature }],
        });
        assert.equal(CpmReleaseManifest.select(manifest, 'beta')?.version, vector.fields.version);
    }
});

test('reads an empty release manifest from disk without enabling installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cpm-release-manifest-'));
    try {
        const path = join(root, 'releases.json');
        await writeFile(path, JSON.stringify({ schemaVersion: 2, channel: 'stable', releases: [] }));
        const manifest = await CpmReleaseManifest.read(path);
        assert.equal(CpmReleaseManifest.select(manifest), null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
