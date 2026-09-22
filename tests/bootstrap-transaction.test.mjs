import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';

import { CpmBootstrap } from '../bootstrap.mjs';
import { CpmRuntimeManifest } from '../runtime-manifest.mjs';
import { buildRuntimeArchive } from '../scripts/build-runtime.mjs';

test('installs, upgrades, and idempotently reuses exact runtime versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cpm-runtime-transaction-'));
    try {
        const releases = new Map([
            ['1.0.0', await createRelease(root, '1.0.0')],
            ['1.1.0', await createRelease(root, '1.1.0')],
        ]);
        const bootstrap = new CpmBootstrap(createFetch(releases));
        const first = await bootstrap.install(releases.get('1.0.0').release, join(root, 'install'));
        const upgraded = await bootstrap.install(releases.get('1.1.0').release, join(root, 'install'));
        const repeated = await bootstrap.install(releases.get('1.1.0').release, join(root, 'install'));

        assert.equal(first.endsWith('/versions/peanut-cpm-cli/1.0.0'), true);
        assert.equal(upgraded.endsWith('/versions/peanut-cpm-cli/1.1.0'), true);
        assert.equal(repeated, upgraded);
        assert.deepEqual(JSON.parse(await readFile(join(root, 'install/current.json'), 'utf8')), {
            schemaVersion: 1,
            id: 'peanut-cpm-cli',
            version: '1.1.0',
            path: 'versions/peanut-cpm-cli/1.1.0',
        });
        await access(join(first, 'runtime.manifest.json'));
        await assert.rejects(access(join(root, 'install/.transactions')), { code: 'ENOENT' });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

for (const phase of ['resolved', 'downloaded', 'staged']) {
    test(`failure at ${phase} leaves a clean unchanged install root`, async () => {
        const root = await mkdtemp(join(tmpdir(), `cpm-runtime-${phase}-`));
        try {
            const candidate = await createRelease(root, '1.0.0');
            const bootstrap = new CpmBootstrap(createFetch(new Map([['1.0.0', candidate]])), {
                onPhase(current) {
                    if (current === phase) throw new Error(`fault:${phase}`);
                },
            });
            await assert.rejects(bootstrap.install(candidate.release, join(root, 'install')), new RegExp(`fault:${phase}`, 'u'));
            await assert.rejects(access(join(root, 'install/current.json')), { code: 'ENOENT' });
            await assert.rejects(access(join(root, 'install/versions/peanut-cpm-cli/1.0.0')), { code: 'ENOENT' });
            await assert.rejects(access(join(root, 'install/.transactions')), { code: 'ENOENT' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

for (const phase of ['committed', 'verified']) {
    test(`failure at ${phase} restores the previous current snapshot`, async () => {
        const root = await mkdtemp(join(tmpdir(), `cpm-runtime-${phase}-`));
        try {
            const first = await createRelease(root, '1.0.0');
            const next = await createRelease(root, '1.1.0');
            const releases = new Map([['1.0.0', first], ['1.1.0', next]]);
            const installRoot = join(root, 'install');
            await new CpmBootstrap(createFetch(releases)).install(first.release, installRoot);
            const failing = new CpmBootstrap(createFetch(releases), {
                onPhase(current) {
                    if (current === phase) throw new Error(`fault:${phase}`);
                },
            });
            await assert.rejects(failing.install(next.release, installRoot), new RegExp(`cpm_runtime_install_recovered:fault:${phase}`, 'u'));
            assert.equal(JSON.parse(await readFile(join(installRoot, 'current.json'), 'utf8')).version, '1.0.0');
            await access(join(installRoot, 'versions/peanut-cpm-cli/1.0.0/runtime.manifest.json'));
            await assert.rejects(access(join(installRoot, 'versions/peanut-cpm-cli/1.1.0')), { code: 'ENOENT' });
            await assert.rejects(access(join(installRoot, '.transactions')), { code: 'ENOENT' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test('reports may_have_changed when current recovery cannot be proven', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cpm-runtime-uncertain-'));
    try {
        const first = await createRelease(root, '1.0.0');
        const next = await createRelease(root, '1.1.0');
        const releases = new Map([['1.0.0', first], ['1.1.0', next]]);
        const installRoot = join(root, 'install');
        await new CpmBootstrap(createFetch(releases)).install(first.release, installRoot);
        const failing = new CpmBootstrap(createFetch(releases), {
            onPhase(phase) {
                if (phase === 'committed') throw new Error('activation_failed');
            },
            onRecover() {
                throw new Error('recovery_failed');
            },
        });
        await assert.rejects(
            failing.install(next.release, installRoot),
            /cpm_runtime_install_may_have_changed:activation_failed/u,
        );
        assert.equal(JSON.parse(await readFile(join(installRoot, 'current.json'), 'utf8')).version, '1.1.0');
        await access(join(installRoot, 'versions/peanut-cpm-cli/1.1.0/runtime.manifest.json'));
        await access(join(installRoot, '.transactions'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

for (const fixture of [
    { name: 'path escape', mutate: (tar) => mutateFirstHeader(tar, { path: '../escape' }), error: /cpm_runtime_archive_path_invalid/u },
    { name: 'hidden file', mutate: (tar) => mutateFirstHeader(tar, { path: '.hidden' }), error: /cpm_runtime_archive_path_invalid/u },
    { name: 'symbolic link', mutate: (tar) => mutateFirstHeader(tar, { type: 0x32 }), error: /cpm_runtime_archive_special_file_rejected/u },
    { name: 'special file', mutate: (tar) => mutateFirstHeader(tar, { type: 0x33 }), error: /cpm_runtime_archive_special_file_rejected/u },
    { name: 'trailing hidden payload', mutate: (tar) => Buffer.concat([tar, Buffer.from('hidden')]), error: /cpm_runtime_archive_hidden_payload/u },
]) {
    test(`rejects an archive containing ${fixture.name} before activation`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'cpm-runtime-malicious-'));
        try {
            const candidate = await createRelease(root, '1.0.0');
            const tampered = gzipSync(fixture.mutate(gunzipSync(candidate.content)), { level: 9, mtime: 0 });
            const release = { ...candidate.release, sha256: createHash('sha256').update(tampered).digest('hex') };
            const bootstrap = new CpmBootstrap(async () => ({
                ok: true,
                arrayBuffer: async () => tampered.buffer.slice(tampered.byteOffset, tampered.byteOffset + tampered.byteLength),
            }));
            await assert.rejects(bootstrap.install(release, join(root, 'install')), fixture.error);
            await assert.rejects(access(join(root, 'install/current.json')), { code: 'ENOENT' });
            await assert.rejects(access(join(root, 'install/.transactions')), { code: 'ENOENT' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test('rejects regular files omitted from the runtime manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cpm-runtime-extra-file-'));
    try {
        await mkdir(join(root, 'cli'), { recursive: true });
        await writeFile(join(root, 'cli/cpm.mjs'), 'runtime\n');
        await writeFile(join(root, 'extra.txt'), 'extra\n');
        const manifest = CpmRuntimeManifest.parse({
            schemaVersion: 1,
            id: 'peanut-cpm-cli',
            version: '1.0.0',
            entry: 'cli/cpm.mjs',
            files: [{ path: 'cli/cpm.mjs', sha256: createHash('sha256').update('runtime\n').digest('hex') }],
        });
        await assert.rejects(CpmRuntimeManifest.verifyDirectory(root, manifest), /cpm_runtime_integrity_mismatch/u);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

async function createRelease(root, version) {
    const archive = join(root, `runtime-${version}.tgz`);
    const identity = { schemaVersion: 1, id: 'peanut-cpm-cli', version };
    const entry = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${JSON.stringify(identity)}\n`)});\n`;
    await buildRuntimeArchive(archive, {
        identity,
        files: [{ path: 'cli/cpm.mjs', mode: 0o755, content: entry }],
    });
    const content = await readFile(archive);
    return {
        content,
        release: {
            id: identity.id,
            version,
            channel: 'beta',
            url: `https://example.test/runtime-${version}.tgz`,
            sha256: createHash('sha256').update(content).digest('hex'),
            signature: 'already-verified',
        },
    };
}

function createFetch(releases) {
    return async (url) => {
        const version = /runtime-(\d+\.\d+\.\d+)\.tgz$/u.exec(url)?.[1];
        const candidate = releases.get(version);
        return candidate == null
            ? { ok: false, status: 404 }
            : { ok: true, arrayBuffer: async () => candidate.content.buffer.slice(candidate.content.byteOffset, candidate.content.byteOffset + candidate.content.byteLength) };
    };
}

function mutateFirstHeader(tar, mutation) {
    const changed = Buffer.from(tar);
    if (mutation.path != null) {
        changed.fill(0, 0, 100);
        Buffer.from(mutation.path, 'utf8').copy(changed, 0);
    }
    if (mutation.type != null) changed[156] = mutation.type;
    changed.fill(0x20, 148, 156);
    const checksum = changed.subarray(0, 512).reduce((total, value) => total + value, 0);
    Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(changed, 148);
    return changed;
}
