import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { CpmRuntimeManifest } from '../runtime-manifest.mjs';
import { buildRuntimeArchive } from '../scripts/build-runtime.mjs';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scratchRoot = join(repositoryRoot, 'tests', `.runtime-builder-${process.pid}`);
const expectedIdentity = Object.freeze({ schemaVersion: 1, id: 'peanut-cpm-cli', version: '1.0.0' });

test.after(async () => {
    await rm(scratchRoot, { recursive: true, force: true });
});

test('builds byte-identical archives with a sorted per-file digest manifest', async () => {
    await mkdir(scratchRoot, { recursive: true });
    const firstPath = join(scratchRoot, 'first.tgz');
    const secondPath = join(scratchRoot, 'second.tgz');
    const first = await buildRuntimeArchive(firstPath);
    const second = await buildRuntimeArchive(secondPath);
    const firstBytes = await readFile(firstPath);
    const secondBytes = await readFile(secondPath);

    assert.deepEqual(firstBytes, secondBytes);
    assert.equal(first.sha256, second.sha256);
    assert.deepEqual(first.manifest.files.map(({ path }) => path), ['cli/cpm.mjs', 'cli/runtime-config.mjs']);

    const entries = readTar(firstBytes);
    assert.deepEqual([...entries.keys()], ['cli/cpm.mjs', 'cli/runtime-config.mjs', 'runtime.manifest.json']);
    const manifest = CpmRuntimeManifest.parse(JSON.parse(entries.get('runtime.manifest.json').toString('utf8')));
    for (const record of manifest.files) {
        assert.equal(createHash('sha256').update(entries.get(record.path)).digest('hex'), record.sha256);
    }
});

test('runs version --json from a relocated extracted runtime', async () => {
    const runtimeRoot = await extractRuntime('relocated');
    const foreignCwd = join(scratchRoot, 'foreign-cwd');
    await mkdir(foreignCwd, { recursive: true });
    const result = runNode(join(runtimeRoot, 'cli', 'cpm.mjs'), ['version', '--json'], foreignCwd);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expectedIdentity);
});

test('supports Bash and shell-independent Windows-compatible Node invocation', async (context) => {
    const runtimeRoot = await extractRuntime('smoke');
    const entry = join(runtimeRoot, 'cli', 'cpm.mjs');
    const direct = runNode(entry, ['version', '--json'], runtimeRoot);
    assert.equal(direct.status, 0, direct.stderr);
    assert.deepEqual(JSON.parse(direct.stdout), expectedIdentity);

    const bash = spawnSync('/bin/bash', ['-c', 'exec "$1" "$2" version --json', 'cpm-runtime-smoke', process.execPath, entry], {
        cwd: runtimeRoot,
        encoding: 'utf8',
    });
    if (bash.error?.code === 'ENOENT') {
        context.skip('Bash is not available on this host');
        return;
    }
    assert.equal(bash.status, 0, bash.stderr);
    assert.deepEqual(JSON.parse(bash.stdout), expectedIdentity);
});

test('runtime payload contains no product packages, credentials, secrets, or adjacent paths', async () => {
    const archivePath = join(scratchRoot, 'scanned.tgz');
    await mkdir(scratchRoot, { recursive: true });
    await buildRuntimeArchive(archivePath);
    const entries = readTar(await readFile(archivePath));
    const text = [...entries.entries()].map(([path, content]) => `${path}\n${content.toString('utf8')}`).join('\n');
    const forbidden = [
        /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/u,
        /\b(?:ghp|github_pat|glpat)-?[A-Za-z0-9_]{20,}\b/u,
        /\b(?:token|password|secret)\s*[:=]\s*["'][^"']+/iu,
        /peanut-pod-(?:lite|pro)/iu,
        /peanut-workspace/iu,
        /\/Users\/|[A-Za-z]:\\/u,
    ];

    for (const pattern of forbidden) assert.doesNotMatch(text, pattern);
});

async function extractRuntime(name) {
    await mkdir(scratchRoot, { recursive: true });
    const archivePath = join(scratchRoot, `${name}.tgz`);
    const runtimeRoot = join(scratchRoot, name);
    await buildRuntimeArchive(archivePath);
    for (const [path, content] of readTar(await readFile(archivePath))) {
        const destination = join(runtimeRoot, ...path.split('/'));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content);
        if (path === 'cli/cpm.mjs') await chmod(destination, 0o755);
    }
    return runtimeRoot;
}

function runNode(entry, args, cwd) {
    return spawnSync(process.execPath, [entry, ...args], {
        cwd,
        encoding: 'utf8',
        env: process.env,
        windowsHide: true,
    });
}

function readTar(archive) {
    const tar = gunzipSync(archive);
    const entries = new Map();
    for (let offset = 0; offset + 512 <= tar.length;) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((value) => value === 0)) break;
        const path = readString(header, 0, 100);
        const size = Number.parseInt(readString(header, 124, 12).trim() || '0', 8);
        const contentStart = offset + 512;
        entries.set(path, Buffer.from(tar.subarray(contentStart, contentStart + size)));
        offset = contentStart + Math.ceil(size / 512) * 512;
    }
    return entries;
}

function readString(buffer, offset, length) {
    const end = buffer.indexOf(0, offset);
    return buffer.toString('utf8', offset, end === -1 || end > offset + length ? offset + length : end);
}
