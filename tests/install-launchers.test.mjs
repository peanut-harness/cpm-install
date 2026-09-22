import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildRuntimeArchive } from '../scripts/build-runtime.mjs';
import { CpmSigningProtocol } from '../signing-protocol.mjs';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('Bash launcher installs, verifies, and idempotently reuses the signed runtime', async () => {
    const fixture = await createFixture('bash');
    try {
        const first = runLauncher('/bin/bash', [join(repositoryRoot, 'install.sh')], fixture.env);
        assert.equal(first.status, 0, first.stderr);
        assert.deepEqual(JSON.parse(first.stdout), { schemaVersion: 1, id: 'peanut-cpm-cli', version: '1.0.0', path: fixture.versionPath });
        const second = runLauncher('/bin/bash', [join(repositoryRoot, 'install.sh')], fixture.env);
        assert.equal(second.status, 0, second.stderr);
        assert.deepEqual(JSON.parse(second.stdout), JSON.parse(first.stdout));
        await assertInstalled(fixture);
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});

test('PowerShell launcher installs and verifies the signed runtime', { skip: spawnSync('pwsh', ['--version']).error?.code === 'ENOENT' }, async () => {
    const fixture = await createFixture('powershell');
    try {
        const result = runLauncher('pwsh', ['-NoProfile', '-File', join(repositoryRoot, 'install.ps1')], fixture.env);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { schemaVersion: 1, id: 'peanut-cpm-cli', version: '1.0.0', path: fixture.versionPath });
        await assertInstalled(fixture);
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});

async function createFixture(name) {
    const root = await mkdtemp(join(tmpdir(), `cpm-install-${name}-`));
    const installRoot = join(root, 'home');
    const project = join(root, 'project');
    const archivePath = join(root, 'runtime.tgz');
    const manifestPath = join(root, 'releases.json');
    await mkdir(project);
    await writeFile(join(project, 'sentinel.txt'), 'unchanged\n');
    await buildRuntimeArchive(archivePath);
    const content = await readFile(archivePath);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyValue = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const release = {
        id: 'peanut-cpm-cli',
        version: '1.0.0',
        channel: 'beta',
        url: 'https://example.test/peanut-cpm-cli-1.0.0.tgz',
        sha256: createHash('sha256').update(content).digest('hex'),
    };
    const signature = sign(null, Buffer.from(CpmSigningProtocol.canonicalize('cpm-release-v1', release)), privateKey).toString('base64');
    await writeFile(manifestPath, `${JSON.stringify({
        schemaVersion: 2,
        channel: 'beta',
        publicKey: { keyId: 'launcher-test', algorithm: 'ed25519', format: 'spki-der-base64', value: publicKeyValue },
        releases: [{ ...release, signature }],
    }, null, 2)}\n`);
    return {
        root,
        installRoot,
        project,
        versionPath: join(installRoot, 'versions/peanut-cpm-cli/1.0.0'),
        env: {
            ...process.env,
            CPM_BOOTSTRAP_PATH: join(repositoryRoot, 'bootstrap.mjs'),
            CPM_RELEASE_MANIFEST_PATH: manifestPath,
            CPM_TEST_MODE: '1',
            CPM_TEST_TRUSTED_PUBLIC_KEYS: JSON.stringify([{ keyId: 'launcher-test', value: publicKeyValue }]),
            CPM_TEST_RELEASE_ARCHIVE_PATH: archivePath,
            CPM_CHANNEL: 'beta',
            CPM_HOME: installRoot,
            CPM_PROJECT: project,
        },
    };
}

function runLauncher(command, args, env) {
    return spawnSync(command, args, { cwd: repositoryRoot, encoding: 'utf8', env });
}

async function assertInstalled(fixture) {
    assert.deepEqual(JSON.parse(await readFile(join(fixture.installRoot, 'current.json'), 'utf8')), {
        schemaVersion: 1,
        id: 'peanut-cpm-cli',
        version: '1.0.0',
        path: 'versions/peanut-cpm-cli/1.0.0',
    });
    const smoke = spawnSync(process.execPath, [join(fixture.versionPath, 'cli/cpm.mjs'), 'version', '--json'], { encoding: 'utf8' });
    assert.equal(smoke.status, 0, smoke.stderr);
    assert.equal(JSON.parse(smoke.stdout).version, '1.0.0');
    assert.equal(await readFile(join(fixture.project, 'sentinel.txt'), 'utf8'), 'unchanged\n');
}
