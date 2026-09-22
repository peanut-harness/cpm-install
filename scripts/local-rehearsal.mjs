#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { LiteProductCatalog } from '../cli/product-catalog.mjs';
import { CPM_RUNTIME } from '../cli/runtime-config.mjs';
import { devPrivateKey, devTrustAnchor } from '../dev-signing.mjs';
import { CpmSigningProtocol } from '../signing-protocol.mjs';
import { buildRuntimeArchive } from './build-runtime.mjs';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCAL_BASE = 'https://rehearsal.invalid';

/**
 * @description 无需任何长期密钥的本地发布演练：每次运行在内存中生成一次性 CPM 与产品密钥，
 * 签名本地 manifest/catalog，经真实 Bash（macOS/Linux）或 PowerShell（Windows）入口安装 CLI，
 * 再用已安装 CLI 把 Lite 装进工程。一次性私钥不落盘；所有注入只走 `CPM_TEST_MODE=1` + 本地文件门禁。
 * @param {{ liteRelease: string, workDirectory: string, project?: string, action?: string, launcher?: 'bash' | 'powershell', keys?: 'ephemeral' | 'dev' }} options 演练参数。
 * @returns {Promise<object>} 演练证据（不含私钥）。
 */
export async function runLocalRehearsal(options) {
    const work = resolve(options.workDirectory);
    const cpmHome = join(work, 'cpm-home');
    await mkdir(join(work, 'archives'), { recursive: true });

    const devKeys = options.keys === 'dev';
    const cpmKey = devKeys ? builtInDevKey('cpm-release') : ephemeralKey('rehearsal-cpm');
    const productKey = devKeys ? builtInDevKey('lite-product') : ephemeralKey('rehearsal-product');
    const runtimeArchive = join(work, 'archives', `${CPM_RUNTIME.id}-${CPM_RUNTIME.version}.tgz`);
    const runtime = await buildRuntimeArchive(runtimeArchive);
    const manifestPath = join(work, 'releases.json');
    const release = { id: CPM_RUNTIME.id, version: CPM_RUNTIME.version, channel: 'beta', url: `${LOCAL_BASE}/cpm/${CPM_RUNTIME.version}/${CPM_RUNTIME.id}-${CPM_RUNTIME.version}.tgz`, sha256: runtime.sha256 };
    await writeJson(manifestPath, { schemaVersion: 2, channel: 'beta', publicKey: cpmKey.publicKey, releases: [{ ...release, signature: cpmKey.sign('cpm-release-v1', release) }] });

    const descriptor = JSON.parse(await readFile(join(options.liteRelease, 'lite-release-descriptor.json'), 'utf8'));
    for (const artifact of [descriptor.host, descriptor.core]) await copyFile(join(options.liteRelease, artifact.archive), join(work, 'archives', artifact.archive));
    const base = `${LOCAL_BASE}/lite/${descriptor.version}`;
    const product = {
        id: descriptor.productId,
        version: descriptor.version,
        channel: 'beta',
        sourceCommit: descriptor.sourceCommit,
        hostUrl: `${base}/${descriptor.host.archive}`,
        hostSha256: descriptor.host.sha256,
        hostPackageDigest: descriptor.host.packageDigest,
        coreUrl: `${base}/${descriptor.core.archive}`,
        coreSha256: descriptor.core.sha256,
        corePackageDigest: descriptor.core.packageDigest,
        creatorProfiles: descriptor.creatorProfiles.map((profile) => profile.version),
    };
    const catalogPath = join(work, 'products.json');
    await writeJson(catalogPath, { schemaVersion: 1, kind: 'lite-product-catalog', channel: 'beta', publicKey: productKey.publicKey, products: [{ ...product, signature: productKey.sign('lite-product-v1', product) }] });
    const productAnchors = [{ keyId: productKey.publicKey.keyId, value: productKey.publicKey.value }];
    LiteProductCatalog.verifyDescriptor(LiteProductCatalog.parse(JSON.parse(await readFile(catalogPath, 'utf8')), { allowTestTrustAnchors: true, testTrustAnchors: productAnchors }).products[0], descriptor);

    const env = {
        ...process.env,
        CPM_TEST_MODE: '1',
        ...(devKeys ? { CPM_DEV_KEYS: '1' } : {}),
        CPM_BOOTSTRAP_PATH: join(repositoryRoot, 'bootstrap.mjs'),
        CPM_RELEASE_MANIFEST_PATH: manifestPath,
        ...(devKeys ? {} : { CPM_TEST_TRUSTED_PUBLIC_KEYS: JSON.stringify([{ keyId: cpmKey.publicKey.keyId, value: cpmKey.publicKey.value }]) }),
        CPM_TEST_RELEASE_ARCHIVE_PATH: runtimeArchive,
        CPM_CHANNEL: 'beta',
        CPM_HOME: cpmHome,
        ...(devKeys ? {} : { CPM_TEST_PRODUCT_TRUSTED_PUBLIC_KEYS: JSON.stringify(productAnchors) }),
        CPM_TEST_PRODUCT_ARCHIVE_DIR: join(work, 'archives'),
    };
    const launcher = (options.launcher ?? (process.platform === 'win32' ? 'powershell' : 'bash')) === 'powershell'
        ? run(powershell(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repositoryRoot, 'install.ps1')], env)
        : run('/bin/bash', [join(repositoryRoot, 'install.sh')], env);
    const cli = JSON.parse(launcher);
    const evidence = { schemaVersion: 1, platform: process.platform, cli, product: { id: product.id, version: product.version, sourceCommit: product.sourceCommit, hostPackageDigest: product.hostPackageDigest, corePackageDigest: product.corePackageDigest } };
    if (options.project != null) {
        const entry = join(cli.path, 'cli', 'cpm.mjs');
        evidence.install = JSON.parse(run(process.execPath, [entry, 'lite', options.action ?? 'install', '--project', resolve(options.project), '--catalog', catalogPath, '--channel', 'beta', '--json'], env));
    }
    return evidence;
}

function builtInDevKey(purpose) {
    const privateKey = devPrivateKey(purpose);
    return {
        publicKey: devTrustAnchor(purpose),
        sign: (kind, fields) => sign(null, Buffer.from(CpmSigningProtocol.canonicalize(kind, fields), 'utf8'), privateKey).toString('base64'),
    };
}

function ephemeralKey(keyId) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
        publicKey: { keyId, algorithm: 'ed25519', format: 'spki-der-base64', value: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') },
        sign: (kind, fields) => sign(null, Buffer.from(CpmSigningProtocol.canonicalize(kind, fields), 'utf8'), privateKey).toString('base64'),
    };
}

function powershell() {
    return spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { windowsHide: true }).status === 0 ? 'pwsh' : 'powershell.exe';
}

function run(command, args, env) {
    const result = spawnSync(command, args, { env, encoding: 'utf8', windowsHide: true });
    if (result.error != null) throw new Error(`cpm_rehearsal_command_unavailable:${command}`);
    if (result.status !== 0) throw new Error(`cpm_rehearsal_command_failed:${result.stderr.trim().split(/\r?\n/u).at(-1) ?? result.status}`);
    return result.stdout.trim().split(/\r?\n/u).at(-1);
}

async function writeJson(path, value) {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const option = (name) => {
        const index = process.argv.indexOf(name);
        return index >= 0 ? process.argv[index + 1] : undefined;
    };
    try {
        const evidence = await runLocalRehearsal({ liteRelease: option('--lite-release'), workDirectory: option('--work') ?? '', project: option('--project'), action: option('--action'), launcher: option('--launcher'), keys: option('--keys') });
        process.stdout.write(`${JSON.stringify(evidence)}\n`);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : 'cpm_rehearsal_failed'}\n`);
        process.exitCode = 1;
    }
}
