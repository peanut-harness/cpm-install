import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CpmBootstrap } from '../bootstrap.mjs';

test('refuses bootstrap when the selected channel has no release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cpm-bootstrap-'));
    try {
        const path = join(root, 'releases.json');
        await writeFile(path, JSON.stringify({ schemaVersion: 2, channel: 'stable', releases: [] }));
        await assert.rejects(new CpmBootstrap().resolve(path), /cpm_release_unavailable/u);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('refuses non-HTTPS manifest sources before any download', async () => {
    await assert.rejects(new CpmBootstrap().resolve('http://example.test/releases.json'), /ENOENT|cpm_release_manifest_request_refused|cpm_release_manifest_invalid/u);
});

test('downloads and atomically writes a digest-verified release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cpm-bootstrap-install-'));
    try {
        const content = new TextEncoder().encode('signed cli artifact');
        const digest = (await import('node:crypto')).createHash('sha256').update(content).digest('hex');
        const calls = [];
        const fetchImpl = async (url) => {
            calls.push(url);
            return { ok: true, arrayBuffer: async () => content.buffer };
        };
        const bootstrap = new CpmBootstrap(fetchImpl);
        const path = await bootstrap.install({ id: 'peanut.cpm', version: '1.0.0', channel: 'stable', url: 'https://example.test/cpm.tgz', sha256: digest, signature: 'verified-by-manifest' }, root);
        assert.equal(calls[0], 'https://example.test/cpm.tgz');
        assert.deepEqual(new Uint8Array(await (await import('node:fs/promises')).readFile(path)), content);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('rejects a release whose downloaded bytes do not match the manifest digest', async () => {
    const bootstrap = new CpmBootstrap(async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('wrong').buffer }));
    await assert.rejects(bootstrap.install({ id: 'peanut.cpm', version: '1.0.0', channel: 'stable', url: 'https://example.test/cpm.tgz', sha256: 'a'.repeat(64), signature: 'verified-by-manifest' }, '/tmp/cpm-invalid-install'), /cpm_release_digest_mismatch/u);
});
