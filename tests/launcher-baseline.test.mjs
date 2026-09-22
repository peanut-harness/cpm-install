import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function runLauncher(command, args) {
    const root = await mkdtemp(join(tmpdir(), 'cpm-launcher-baseline-'));
    const project = join(root, 'project');
    const manifest = join(root, 'releases.json');
    await writeFile(manifest, `${JSON.stringify({ schemaVersion: 2, channel: 'stable', publicKey: null, releases: [] })}\n`);
    await writeFile(project, 'sentinel\n');
    const before = await readdir(root);
    try {
        const result = spawnSync(command, args, {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                CPM_BOOTSTRAP_PATH: join(repositoryRoot, 'bootstrap.mjs'),
                CPM_RELEASE_MANIFEST_PATH: manifest,
                CPM_PROJECT: project,
            },
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        assert.match(`${result.stdout}\n${result.stderr}`, /No project changes were made\./u);
        assert.deepEqual(await readdir(root), before);
        assert.equal(await readFile(project, 'utf8'), 'sentinel\n');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test('Bash launcher fails closed without modifying the requested project', async () => {
    await runLauncher('/bin/bash', [join(repositoryRoot, 'install.sh')]);
});

test('PowerShell launcher fails closed without modifying the requested project', { skip: spawnSync('pwsh', ['--version']).error?.code === 'ENOENT' }, async () => {
    await runLauncher('pwsh', ['-NoProfile', '-File', join(repositoryRoot, 'install.ps1')]);
});
