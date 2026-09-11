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

test('rejects a digest-verified payload that is not a CPM runtime archive', async () => {
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
        await assert.rejects(bootstrap.install({ id: 'peanut.cpm', version: '1.0.0', channel: 'stable', url: 'https://example.test/cpm.tgz', sha256: digest, signature: 'verified-by-manifest' }, root), /archive|tar|runtime/u);
        assert.equal(calls[0], 'https://example.test/cpm.tgz');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('rejects a release whose downloaded bytes do not match the manifest digest', async () => {
    const bootstrap = new CpmBootstrap(async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('wrong').buffer }));
    await assert.rejects(bootstrap.install({ id: 'peanut.cpm', version: '1.0.0', channel: 'stable', url: 'https://example.test/cpm.tgz', sha256: 'a'.repeat(64), signature: 'verified-by-manifest' }, '/tmp/cpm-invalid-install'), /cpm_release_digest_mismatch/u);
});

test('installs a tar.gz runtime only after runtime manifest and file digests pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cpm-bootstrap-runtime-'));
    const staging = await mkdtemp(join(tmpdir(), 'cpm-bootstrap-archive-'));
    try {
        const { mkdir, writeFile: write, readFile: read, rm: remove } = await import('node:fs/promises');
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const run = promisify(execFile);
        const cli = 'bin/cpm';
        await mkdir(join(staging, 'bin'), { recursive: true });
        await write(join(staging, cli), '#!/usr/bin/env node\n');
        const digest = (await import('node:crypto')).createHash('sha256').update('#!/usr/bin/env node\n').digest('hex');
        await write(join(staging, 'runtime.manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'peanut-cpm-cli', version: '1.0.0', entry: cli, files: [{ path: cli, sha256: digest }] }));
        const archive = join(root, 'cli.tgz');
        await run('tar', ['-czf', archive, '-C', staging, 'runtime.manifest.json', cli]);
        const content = await read(archive);
        const bootstrap = new CpmBootstrap(async () => ({ ok: true, arrayBuffer: async () => content.buffer }));
        const path = await bootstrap.install({ id: 'peanut-cpm-cli', version: '1.0.0', channel: 'stable', url: 'https://example.test/cpm-cli.tgz', sha256: (await import('node:crypto')).createHash('sha256').update(content).digest('hex'), signature: 'verified-by-manifest' }, join(root, 'install'));
        assert.equal(path.endsWith('/versions/peanut-cpm-cli/1.0.0'), true);
        assert.equal((await read(join(path, cli), 'utf8')).includes('node'), true);
        await remove(staging, { recursive: true, force: true });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
