import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { runLocalRehearsal } from '../scripts/local-rehearsal.mjs';
import { liteRelease } from './fixtures/lite-release.mjs';

const bashAvailable = process.platform !== 'win32' && spawnSync('/bin/bash', ['-c', 'exit 0']).status === 0;
const powershellAvailable = ['pwsh', 'powershell.exe'].some((command) => spawnSync(command, ['-NoProfile', '-Command', 'exit 0']).error == null);

for (const [launcher, available] of [['bash', bashAvailable], ['powershell', powershellAvailable]]) test(`keyless local rehearsal installs the CLI through the ${launcher} launcher and Lite into a project`, { skip: !available }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'cpm-local-rehearsal-'));
    try {
        const release = join(root, 'lite-release');
        const project = join(root, 'project');
        await mkdir(release);
        await mkdir(project);
        const { descriptor, archives } = liteRelease('0.2.0');
        await writeFile(join(release, 'lite-release-descriptor.json'), JSON.stringify(descriptor));
        for (const [name, content] of Object.entries(archives)) await writeFile(join(release, name), content);
        await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'rehearsal', creator: { version: '3.8.7' } }));

        const evidence = await runLocalRehearsal({ liteRelease: release, workDirectory: join(root, 'work'), project, launcher });
        assert.equal(evidence.cli.id, 'peanut-cpm-cli');
        assert.equal(evidence.install.status, 'installed');
        assert.equal(evidence.install.core.packageDigest, descriptor.core.packageDigest);
        assert.equal(await readFile(join(project, 'extensions', 'peanut-pod-lite-host', 'dist', 'main.js'), 'utf8'), 'host 0.2.0');
        assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE KEY/u);
        const written = await readdir(join(root, 'work'));
        assert.deepEqual(written.sort(), ['archives', 'cpm-home', 'products.json', 'releases.json']);
        for (const name of ['products.json', 'releases.json']) assert.doesNotMatch(await readFile(join(root, 'work', name), 'utf8'), /PRIVATE KEY/u);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
