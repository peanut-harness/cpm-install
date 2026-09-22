#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

import { devPrivateKey, devTrustAnchor, isDevKey } from '../dev-signing.mjs';
import { CpmReleaseManifest } from '../release-manifest.mjs';
import { CpmSigningProtocol } from '../signing-protocol.mjs';
import { CPM_RELEASE_TRUST_ANCHORS } from '../trust-anchors.mjs';
import { buildRuntimeArchive } from './build-runtime.mjs';

const runFile = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRET_PATTERNS = Object.freeze([
    /BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY/u,
    /\b(?:ghp|gho|ghs|github_pat|glpat)_?[A-Za-z0-9_]{20,}\b/u,
    /\b(?:token|password|secret|private[_-]?key)\s*[:=]\s*["'][^"']+/iu,
]);

/**
 * @description 构建不可变 CLI 候选：确定性 runtime archive、SBOM 与候选证据，不接触任何私钥。
 * @param {string} outputDirectory 候选输出目录（必须尚不存在同名文件）。
 * @param {{ sourceCommit?: string }} [options] 测试可注入 source commit；正常路径要求干净 HEAD。
 * @returns {Promise<object>} 候选证据。
 */
export async function buildCandidate(outputDirectory, options = {}) {
    const sourceCommit = options.sourceCommit ?? await cleanSourceCommit();
    const runtime = await import(pathToFileURL(join(repositoryRoot, 'cli/runtime-config.mjs')).href);
    const { id, version } = runtime.CPM_RUNTIME;
    await mkdir(outputDirectory, { recursive: true });
    const archiveName = `${id}-${version}.tgz`;
    const built = await buildRuntimeArchive(join(outputDirectory, archiveName));
    const archive = await readFile(built.archivePath);
    const files = readTarFiles(gunzipSync(archive));
    assertDependencyFree(files);
    const sbomName = `${id}-${version}.sbom.json`;
    const sbom = Buffer.from(`${JSON.stringify(createSbom(id, version, sourceCommit, built.sha256, files), null, 4)}\n`);
    await writeFile(join(outputDirectory, sbomName), sbom, { flag: 'wx' });
    const candidate = {
        schemaVersion: 1,
        kind: 'cpm-cli-candidate',
        id,
        version,
        sourceCommit,
        archive: { name: archiveName, sha256: built.sha256, size: archive.length },
        sbom: { name: sbomName, sha256: sha256(sbom) },
        runtimeFiles: built.manifest.files,
    };
    const candidateText = `${JSON.stringify(candidate, null, 4)}\n`;
    assertNoSecrets([candidateText, sbom.toString('utf8'), ...[...files.values()].map((content) => content.toString('utf8'))]);
    await writeFile(join(outputDirectory, `${id}-${version}.candidate.json`), candidateText, { flag: 'wx' });
    return candidate;
}

/**
 * @description 生成 `cpm-release-v1` 签名记录。无私钥时只能 dry-run 输出待签 payload；
 * 私钥对应公钥必须是固定信任锚（测试锚仅在 CPM_TEST_MODE=1 时可用）。
 * @param {object} candidate {@link buildCandidate} 生成的候选证据。
 * @param {{ channel: string, url: string, privateKeyPem?: string, devKey?: boolean, dryRun?: boolean, env?: NodeJS.ProcessEnv }} options 签名参数；devKey 使用内置开发密钥（拒绝 stable）。
 * @returns {object} dry-run 时为 `{ payload }`，否则为可写入 manifest 的发行记录与公钥 keyId。
 */
export function signRelease(candidate, options) {
    const url = options.url;
    if (typeof url !== 'string' || !url.startsWith('https://') || !new URL(url).pathname.endsWith(`/${candidate.archive.name}`)) throw new Error('cpm_release_url_invalid');
    const fields = { id: candidate.id, version: candidate.version, channel: options.channel, url, sha256: candidate.archive.sha256 };
    const payload = CpmSigningProtocol.canonicalize('cpm-release-v1', fields);
    if (options.dryRun === true) return { payload };
    let privateKey;
    if (options.devKey === true) {
        if (options.channel === 'stable') throw new Error('cpm_release_dev_key_stable_refused');
        privateKey = devPrivateKey('cpm-release');
    } else {
        if (typeof options.privateKeyPem !== 'string' || options.privateKeyPem.length === 0) throw new Error('cpm_release_signing_key_missing');
        try {
            privateKey = createPrivateKey(options.privateKeyPem);
        } catch {
            throw new Error('cpm_release_signing_key_invalid');
        }
    }
    const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
    const anchors = options.devKey === true ? [devTrustAnchor('cpm-release')] : signingAnchors(options.env ?? process.env);
    const anchor = anchors.find((candidateAnchor) => candidateAnchor.value === publicKey);
    if (anchor == null) throw new Error('cpm_release_signing_key_not_anchored');
    const signature = sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64');
    return { keyId: anchor.keyId, publicKey, release: { ...fields, signature } };
}

/**
 * @description 把签名记录并入 manifest：同版本只允许字节等价的幂等重放，不允许改写。
 * @param {object} manifest 现有 manifest JSON。
 * @param {{ keyId: string, publicKey: string, release: object }} signed {@link signRelease} 输出。
 * @param {object} [parseOptions] 测试信任锚。
 * @param {{ allowDevKey?: boolean }} [mergeOptions] 仅开发 manifest 可显式接受开发密钥记录。
 * @returns {object} 已校验的新 manifest JSON。
 */
export function mergeManifest(manifest, signed, parseOptions, mergeOptions = {}) {
    if (isDevKey(signed.publicKey) && mergeOptions.allowDevKey !== true) throw new Error('cpm_release_dev_key_refused');
    const current = CpmReleaseManifest.parse(manifest, parseOptions);
    if (current.publicKey != null && (current.publicKey.keyId !== signed.keyId || current.publicKey.value !== signed.publicKey)) throw new Error('cpm_release_manifest_key_mismatch');
    const existing = current.releases.find((release) => release.id === signed.release.id && release.version === signed.release.version);
    if (existing != null) {
        const same = ['channel', 'url', 'sha256', 'signature'].every((field) => existing[field] === signed.release[field]);
        if (!same) throw new Error('cpm_release_version_overwrite');
        return manifest;
    }
    const next = {
        schemaVersion: 2,
        channel: current.channel,
        publicKey: { keyId: signed.keyId, algorithm: 'ed25519', format: 'spki-der-base64', value: signed.publicKey },
        releases: [...current.releases, signed.release],
    };
    CpmReleaseManifest.parse(next, parseOptions);
    return next;
}

/**
 * @description 从 HTTPS 发行地址回读 archive，确认字节与候选证据一致。
 * @returns {Promise<object>} 回读证据。
 */
export async function verifyReadback(candidate, url, fetchImpl = globalThis.fetch) {
    const response = await fetchImpl(url, { redirect: 'error' });
    if (response.redirected) throw new Error('cpm_release_readback_redirect_refused');
    if (!response.ok) throw new Error(`cpm_release_readback_refused:${response.status}`);
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length !== candidate.archive.size || sha256(content) !== candidate.archive.sha256) throw new Error('cpm_release_readback_mismatch');
    return { schemaVersion: 1, id: candidate.id, version: candidate.version, url, sha256: candidate.archive.sha256, size: content.length };
}

/** @description 输出文本中出现私钥或凭据样式内容时失败，不回显匹配内容。 */
export function assertNoSecrets(texts) {
    for (const text of texts) {
        if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) throw new Error('cpm_release_secret_detected');
    }
}

async function cleanSourceCommit() {
    const { stdout: status } = await runFile('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repositoryRoot });
    if (status.trim().length > 0) throw new Error('cpm_release_source_dirty');
    const { stdout } = await runFile('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot });
    return stdout.trim();
}

function signingAnchors(env) {
    if (env.CPM_TEST_MODE !== '1' || env.CPM_TEST_TRUSTED_PUBLIC_KEYS == null) return CPM_RELEASE_TRUST_ANCHORS;
    try {
        return JSON.parse(env.CPM_TEST_TRUSTED_PUBLIC_KEYS);
    } catch {
        throw new Error('cpm_release_test_trust_anchor_invalid');
    }
}

function createSbom(id, version, sourceCommit, archiveSha256, files) {
    return {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        version: 1,
        metadata: {
            component: {
                type: 'application',
                name: id,
                version,
                hashes: [{ alg: 'SHA-256', content: archiveSha256 }],
                licenses: [{ license: { name: 'NOASSERTION' } }],
                properties: [{ name: 'peanut:sourceCommit', value: sourceCommit }],
            },
        },
        components: [...files.entries()]
            .filter(([path]) => path !== 'runtime.manifest.json')
            .map(([path, content]) => ({ type: 'file', name: path, hashes: [{ alg: 'SHA-256', content: sha256(content) }] })),
        properties: [
            { name: 'peanut:thirdPartyDependencies', value: '0' },
            { name: 'peanut:runtime', value: 'node builtins only' },
        ],
    };
}

/** @description runtime 只允许 `node:` 内建模块与 archive 内相对路径，保证许可证清单无第三方依赖。 */
function assertDependencyFree(files) {
    for (const [path, content] of files) {
        if (!path.endsWith('.mjs')) continue;
        for (const match of content.toString('utf8').matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
            const specifier = match[1] ?? match[2];
            if (specifier.startsWith('node:')) continue;
            if (!specifier.startsWith('.')) throw new Error(`cpm_release_third_party_dependency:${specifier}`);
            const target = new URL(specifier, `file:///${path}`).pathname.slice(1);
            if (!files.has(target)) throw new Error(`cpm_release_runtime_import_missing:${target}`);
        }
    }
}

function readTarFiles(tar) {
    const files = new Map();
    for (let offset = 0; offset + 512 <= tar.length;) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((value) => value === 0)) break;
        const end = header.indexOf(0);
        const path = header.subarray(0, end < 0 || end > 100 ? 100 : end).toString('utf8');
        const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/u, '').trim() || '0', 8);
        files.set(path, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    return files;
}

function sha256(content) {
    return createHash('sha256').update(content).digest('hex');
}

async function main(args) {
    const [command, ...rest] = args;
    const option = (name) => {
        const index = rest.indexOf(name);
        return index >= 0 ? rest[index + 1] : undefined;
    };
    if (command === 'build') return buildCandidate(resolve(option('--out') ?? 'release-candidate'));
    if (command === 'merge') {
        const manifestPath = option('--manifest') ?? '';
        const merged = mergeManifest(JSON.parse(await readFile(manifestPath, 'utf8')), JSON.parse(await readFile(option('--signed') ?? '', 'utf8')), undefined, { allowDevKey: rest.includes('--dev') });
        await writeFile(manifestPath, `${JSON.stringify(merged, null, 2)}\n`);
        return merged;
    }
    const candidate = JSON.parse(await readFile(option('--candidate') ?? '', 'utf8'));
    if (command === 'sign') {
        const dryRun = rest.includes('--dry-run');
        const devKey = rest.includes('--dev-key');
        const keyFile = option('--key-file');
        const privateKeyPem = dryRun || devKey ? undefined : process.env.CPM_RELEASE_SIGNING_KEY ?? (keyFile == null ? undefined : await readFile(keyFile, 'utf8'));
        return signRelease(candidate, { channel: option('--channel') ?? 'beta', url: option('--url'), privateKeyPem, devKey, dryRun });
    }
    if (command === 'readback') return verifyReadback(candidate, option('--url'));
    throw new Error('cpm_release_cli_usage');
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : 'cpm_release_failed'}\n`);
        process.exitCode = 1;
    }
}
