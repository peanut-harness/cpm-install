import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

import { CreatorOccupancy } from '../cli/install/creator-occupancy.mjs';
import { LiteProjectInstaller } from '../cli/install/lite-project-installer.mjs';
import { LiteProductCatalog } from '../cli/product-catalog.mjs';
import { CpmSigningProtocol } from '../signing-protocol.mjs';
import { coreFiles, hostFiles, packageDigest, sha256, tarGzip } from './fixtures/lite-release.mjs';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const key = (() => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const value = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    return { privateKey, anchor: { keyId: 'install-test', value }, publicKey: { keyId: 'install-test', algorithm: 'ed25519', format: 'spki-der-base64', value } };
})();
const closed = new CreatorOccupancy(async () => []);

test('clean install writes Host, Core and schema v2 index, then is idempotent', async () => {
    const fixture = await createFixture();
    try {
        await writeFile(join(fixture.project, 'peanut-plugins/installed.json'), `${JSON.stringify(proIndex(), null, 4)}\n`);
        const first = await installer(fixture).run('install', fixture.project, fixture.catalog, 'beta');
        assert.equal(first.status, 'installed');
        assert.equal(first.previousVersion, null);
        const index = JSON.parse(await readFile(join(fixture.project, 'peanut-plugins/installed.json'), 'utf8'));
        assert.deepEqual(index.plugins.map((plugin) => [plugin.pluginId, plugin.activeVersion]), [['peanut.cocos-mcp-pro', '1.0.0'], ['peanut.pod-lite', '0.2.0']]);
        assert.deepEqual(index.plugins[1].versions, [{ version: '0.2.0', installPath: join('peanut-plugins', 'plugins', 'peanut.pod-lite', '0.2.0') }]);
        assert.equal(await readFile(join(fixture.project, 'extensions/peanut-pod-lite-host/dist/main.js'), 'utf8'), 'host 0.2.0');
        assert.equal(await readFile(join(fixture.project, 'peanut-plugins/plugins/peanut.pod-lite/0.2.0/peanut.pod-lite.bundle.js'), 'utf8'), 'core 0.2.0');
        const before = await snapshot(fixture.project);
        const second = await installer(fixture).run('install', fixture.project, fixture.catalog, 'beta');
        assert.equal(second.status, 'unchanged');
        assert.deepEqual(await snapshot(fixture.project), before);
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});

test('upgrade switches the active version and keeps the previous version record', async () => {
    const fixture = await createFixture(['0.2.0', '0.3.0']);
    try {
        await installer(fixture).run('install', fixture.project, catalogWith(fixture, ['0.2.0']), 'beta');
        const upgraded = await installer(fixture).run('upgrade', fixture.project, fixture.catalog, 'beta');
        assert.equal(upgraded.status, 'upgraded');
        assert.equal(upgraded.previousVersion, '0.2.0');
        const entry = JSON.parse(await readFile(join(fixture.project, 'peanut-plugins/installed.json'), 'utf8')).plugins[0];
        assert.equal(entry.activeVersion, '0.3.0');
        assert.deepEqual(entry.versions.map((version) => version.version), ['0.2.0', '0.3.0']);
        assert.equal(await readFile(join(fixture.project, 'extensions/peanut-pod-lite-host/dist/main.js'), 'utf8'), 'host 0.3.0');
        assert.equal(await readFile(join(fixture.project, 'peanut-plugins/plugins/peanut.pod-lite/0.2.0/peanut.pod-lite.bundle.js'), 'utf8'), 'core 0.2.0');
        await assert.rejects(installer(fixture).run('upgrade', fixture.project, catalogWith(fixture, ['0.2.0']), 'beta'), /cpm_lite_downgrade_refused/u);
        await assert.rejects(installer(fixture).run('install', fixture.project, catalogWith(fixture, ['0.2.0']), 'beta'), /cpm_lite_already_installed/u);
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});

test('commands refuse missing installs, unsupported Creator versions, open projects and held locks without changes', async () => {
    const fixture = await createFixture();
    try {
        const before = await snapshot(fixture.project);
        await assert.rejects(installer(fixture).run('upgrade', fixture.project, fixture.catalog, 'beta'), /cpm_lite_not_installed/u);
        await assert.rejects(installer(fixture).run('repair', fixture.project, fixture.catalog, 'beta'), /cpm_lite_not_installed/u);
        await assert.rejects(installer(fixture).run('install', fixture.project, fixture.catalog, 'stable'), /cpm_product_unavailable/u);
        const open = new CreatorOccupancy(async () => [`/Applications/Cocos/Creator/3.8.3/CocosCreator.app/Contents/MacOS/CocosCreator --project ${fixture.project}`]);
        await assert.rejects(installer(fixture, { occupancy: open }).run('install', fixture.project, fixture.catalog, 'beta'), /cpm_lite_creator_project_open/u);
        const unknown = new CreatorOccupancy(async () => { throw new Error('ps unavailable'); });
        await assert.rejects(installer(fixture, { occupancy: unknown }).run('install', fixture.project, fixture.catalog, 'beta'), /cpm_lite_creator_occupancy_unknown/u);
        const other = new CreatorOccupancy(async () => [`/Applications/CocosCreator.app/Contents/MacOS/CocosCreator --project ${fixture.project}-other`]);
        assert.deepEqual(await snapshot(fixture.project), before);
        await writeFile(join(fixture.project, 'peanut-plugins/.installed.lock'), `${Date.now()}\n`);
        await assert.rejects(installer(fixture, { occupancy: other }).run('install', fixture.project, fixture.catalog, 'beta'), /cpm_lite_project_locked/u);
        await rm(join(fixture.project, 'peanut-plugins/.installed.lock'));
        await writeFile(join(fixture.project, 'package.json'), JSON.stringify({ creator: { version: '3.8.4' } }));
        await assert.rejects(installer(fixture).run('install', fixture.project, fixture.catalog, 'beta'), /cpm_lite_creator_version_unsupported/u);
        await writeFile(join(fixture.project, 'peanut-plugins/installed.json'), '{"schemaVersion":1}');
        await assert.rejects(installer(fixture).run('install', fixture.project, fixture.catalog, 'beta'), /cpm_lite_installed_index_invalid/u);
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});

test('failures before activation leave the project unchanged', async () => {
    const fixture = await createFixture(['0.2.0', '0.3.0']);
    try {
        await installer(fixture).run('install', fixture.project, catalogWith(fixture, ['0.2.0']), 'beta');
        const before = await snapshot(fixture.project);
        for (const [name, options] of [
            ['digest', { archives: { ...fixture.archives, 'peanut-pod-lite-core-0.3.0.tar.gz': gzipSync(Buffer.from('corrupt')) } }],
            ['resolved', { onPhase: failAt('resolved') }],
            ['downloaded', { onPhase: failAt('downloaded') }],
            ['staged', { onPhase: failAt('staged') }],
        ]) {
            const upgradeFixture = { ...fixture, ...(options.archives == null ? {} : { archives: options.archives }) };
            const catalog = await signedCatalog(upgradeFixture, ['0.2.0', '0.3.0']);
            await assert.rejects(installer(upgradeFixture, options).run('upgrade', fixture.project, catalog, 'beta'), /cpm_lite_install_unchanged:/u, name);
            assert.deepEqual(await snapshot(fixture.project), before, name);
        }
        const served = { archives: { ...fixture.archives, 'peanut-pod-lite-host-0.3.0.tar.gz': fixture.archives['peanut-pod-lite-host-0.2.0.tar.gz'] } };
        await assert.rejects(installer(fixture, served).run('upgrade', fixture.project, fixture.catalog, 'beta'), /cpm_lite_install_unchanged:cpm_product_digest_mismatch/u);
        assert.deepEqual(await snapshot(fixture.project), before);
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});

test('failures after activation recover the previous installation', async () => {
    const fixture = await createFixture(['0.2.0', '0.3.0']);
    try {
        await installer(fixture).run('install', fixture.project, catalogWith(fixture, ['0.2.0']), 'beta');
        const before = await snapshot(fixture.project);
        for (const phase of ['committed', 'verified']) {
            await assert.rejects(installer(fixture, { onPhase: failAt(phase) }).run('upgrade', fixture.project, fixture.catalog, 'beta'), /cpm_lite_install_recovered:/u, phase);
            assert.deepEqual(await snapshot(fixture.project), before, phase);
        }
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});

test('unprovable recovery reports may_have_changed and keeps the journal', async () => {
    const fixture = await createFixture(['0.2.0', '0.3.0']);
    try {
        await installer(fixture).run('install', fixture.project, catalogWith(fixture, ['0.2.0']), 'beta');
        await assert.rejects(
            installer(fixture, { onPhase: failAt('committed'), onRecover: () => { throw new Error('disk gone'); } }).run('upgrade', fixture.project, fixture.catalog, 'beta'),
            /cpm_lite_install_may_have_changed:committed failure/u,
        );
        const transactions = await readdir(join(fixture.project, 'peanut-plugins/.cpm-transactions'));
        assert.equal(transactions.length, 1);
        const journal = JSON.parse(await readFile(join(fixture.project, 'peanut-plugins/.cpm-transactions', transactions[0], 'journal.json'), 'utf8'));
        assert.equal(journal.phase, 'committed');
        assert.equal(journal.previousActiveVersion, '0.2.0');
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});

test('repair restores tampered Host and Core files of the active version', async () => {
    const fixture = await createFixture();
    try {
        await installer(fixture).run('install', fixture.project, fixture.catalog, 'beta');
        const healthy = await snapshot(fixture.project);
        assert.equal((await installer(fixture).run('repair', fixture.project, fixture.catalog, 'beta')).status, 'unchanged');
        await writeFile(join(fixture.project, 'peanut-plugins/plugins/peanut.pod-lite/0.2.0/peanut.pod-lite.bundle.js'), 'tampered');
        await writeFile(join(fixture.project, 'extensions/peanut-pod-lite-host/extra.js'), 'unexpected');
        await assert.rejects(installer(fixture).run('install', fixture.project, fixture.catalog, 'beta'), /cpm_lite_repair_required/u);
        const repaired = await installer(fixture).run('repair', fixture.project, fixture.catalog, 'beta');
        assert.equal(repaired.status, 'repaired');
        assert.deepEqual(await snapshot(fixture.project), healthy);
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});

test('CLI installs from a local signed catalog only behind the explicit test gate', async () => {
    const fixture = await createFixture();
    try {
        const catalogPath = join(fixture.root, 'products.json');
        await writeFile(catalogPath, JSON.stringify(fixture.catalogJson));
        const archiveDirectory = join(fixture.root, 'archives');
        await mkdir(archiveDirectory);
        for (const [name, content] of Object.entries(fixture.archives)) await writeFile(join(archiveDirectory, name), content);
        const env = { ...process.env, CPM_TEST_MODE: '1', CPM_TEST_PRODUCT_TRUSTED_PUBLIC_KEYS: JSON.stringify([key.anchor]), CPM_TEST_PRODUCT_ARCHIVE_DIR: archiveDirectory };
        const args = [join(repositoryRoot, 'cli/cpm.mjs'), 'lite', 'install', '--project', fixture.project, '--catalog', catalogPath, '--channel', 'beta', '--json'];
        const installed = spawnSync(process.execPath, args, { encoding: 'utf8', env });
        assert.equal(installed.status, 0, installed.stderr);
        assert.equal(JSON.parse(installed.stdout).status, 'installed');
        const again = spawnSync(process.execPath, args, { encoding: 'utf8', env });
        assert.equal(JSON.parse(again.stdout).status, 'unchanged');
        const ungated = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...env, CPM_TEST_MODE: '0' } });
        assert.equal(ungated.status, 1);
        assert.match(ungated.stderr, /cpm_product_trust_anchor_mismatch/u);
        const usage = spawnSync(process.execPath, [join(repositoryRoot, 'cli/cpm.mjs'), 'lite', 'install', '--json'], { encoding: 'utf8', env });
        assert.equal(usage.status, 2);
    } finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});

function installer(fixture, options = {}) {
    const archives = options.archives ?? fixture.archives;
    return new LiteProjectInstaller({
        occupancy: options.occupancy ?? closed,
        onPhase: options.onPhase,
        onRecover: options.onRecover,
        fetchImpl: async (url) => {
            const content = archives[new URL(url).pathname.split('/').at(-1)];
            return content == null ? { ok: false, status: 404 } : { ok: true, redirected: false, arrayBuffer: async () => content };
        },
    });
}

function failAt(phase) {
    return (current) => {
        if (current === phase) throw new Error(`${phase} failure`);
    };
}

async function createFixture(versions = ['0.2.0']) {
    const root = await mkdtemp(join(tmpdir(), 'cpm-product-install-'));
    const project = join(root, 'project');
    await mkdir(join(project, 'assets'), { recursive: true });
    await mkdir(join(project, 'peanut-plugins'), { recursive: true });
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'demo', creator: { version: '3.8.7' } }));
    await writeFile(join(project, 'assets/sentinel.txt'), 'unchanged\n');
    const archives = {};
    const products = {};
    for (const version of versions) {
        const host = hostFiles(version);
        const core = coreFiles(version);
        archives[`peanut-pod-lite-host-${version}.tar.gz`] = tarGzip(`peanut-pod-lite-host-${version}`, host);
        archives[`peanut-pod-lite-core-${version}.tar.gz`] = tarGzip(`peanut.pod-lite-${version}`, core);
        products[version] = { hostDigest: packageDigest(host), coreDigest: JSON.parse(core.get('peanut.pod-lite.manifest.json')).package.digest };
    }
    const fixture = { root, project, archives, products, versions };
    fixture.catalogJson = catalogJson(fixture, versions);
    fixture.catalog = LiteProductCatalog.parse(fixture.catalogJson, { allowTestTrustAnchors: true, testTrustAnchors: [key.anchor] });
    return fixture;
}

function catalogWith(fixture, versions) {
    return LiteProductCatalog.parse(catalogJson(fixture, versions), { allowTestTrustAnchors: true, testTrustAnchors: [key.anchor] });
}

async function signedCatalog(fixture, versions) {
    return catalogWith(fixture, versions);
}

function catalogJson(fixture, versions) {
    return {
        schemaVersion: 1,
        kind: 'lite-product-catalog',
        channel: 'beta',
        publicKey: key.publicKey,
        products: versions.map((version) => {
            const host = `peanut-pod-lite-host-${version}.tar.gz`;
            const core = `peanut-pod-lite-core-${version}.tar.gz`;
            const fields = {
                id: 'peanut.pod-lite',
                version,
                channel: 'beta',
                sourceCommit: 'c'.repeat(40),
                hostUrl: `https://releases.peanut-harness.dev/lite/${version}/${host}`,
                hostSha256: sha256(fixture.archives[host]),
                hostPackageDigest: fixture.products[version].hostDigest,
                coreUrl: `https://releases.peanut-harness.dev/lite/${version}/${core}`,
                coreSha256: sha256(fixture.archives[core]),
                corePackageDigest: fixture.products[version].coreDigest,
                creatorProfiles: ['3.8.3', '3.8.7'],
            };
            return { ...fields, signature: sign(null, Buffer.from(CpmSigningProtocol.canonicalize('lite-product-v1', fields)), key.privateKey).toString('base64') };
        }),
    };
}

function proIndex() {
    return { schemaVersion: 2, plugins: [{ pluginId: 'peanut.cocos-mcp-pro', activeVersion: '1.0.0', versions: [{ version: '1.0.0', installPath: join('peanut-plugins', 'plugins', 'peanut.cocos-mcp-pro', '1.0.0') }] }] };
}






async function snapshot(root) {
    const entries = {};
    const walk = async (directory, prefix) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const relative = `${prefix}${entry.name}`;
            if (entry.isDirectory()) {
                entries[`${relative}/`] = 'dir';
                await walk(join(directory, entry.name), `${relative}/`);
            } else {
                entries[relative] = sha256(await readFile(join(directory, entry.name)));
            }
        }
    };
    await walk(root, '');
    return entries;
}

