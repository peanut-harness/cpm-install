import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CpmReleaseManifest } from '../release-manifest.mjs';

function signedRelease(key, version = '1.2.0', channel = 'stable') {
    const release = { id: 'peanut.cpm', version, channel, url: `https://get.peanut-harness.dev/cpm/peanut-cpm-${version}.tgz`, sha256: 'a'.repeat(64) };
    const payload = JSON.stringify(release);
    return { ...release, signature: sign(null, Buffer.from(payload), key).toString('base64') };
}

test('accepts signed releases and selects the highest version per channel', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyValue = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const manifest = CpmReleaseManifest.parse({ schemaVersion: 2, channel: 'stable', publicKey: { algorithm: 'ed25519', format: 'spki-der-base64', value: publicKeyValue }, releases: [signedRelease(privateKey, '1.1.0'), signedRelease(privateKey, '1.2.0'), signedRelease(privateKey, '2.0.0', 'beta')] });
    assert.equal(CpmReleaseManifest.select(manifest).version, '1.2.0');
    assert.equal(CpmReleaseManifest.select(manifest, 'beta').version, '2.0.0');
});

test('rejects unsigned, non-HTTPS, duplicate, and empty-release mistakes', () => {
    const empty = CpmReleaseManifest.parse({ schemaVersion: 2, channel: 'stable', releases: [] });
    assert.equal(CpmReleaseManifest.select(empty), null);
    assert.throws(() => CpmReleaseManifest.parse({ schemaVersion: 2, channel: 'stable', releases: [{ id: 'peanut.cpm', version: '1.0.0', channel: 'stable', url: 'http://example.test/cpm.tgz', sha256: 'a'.repeat(64), signature: 'bad' }] }), /cpm_release_public_key_missing/u);
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
