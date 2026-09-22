import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

import { CpmReleaseManifest } from '../release-manifest.mjs';
import { CpmRuntimeManifest } from '../runtime-manifest.mjs';
import { CpmInstallJournal } from './install-journal.mjs';

const runFile = promisify(execFile);

/**
 * @description CPM runtime 的 prepare/commit/verify/recover 安装事务。
 */
export class CpmRuntimeInstallTransaction {
    constructor(fetchImpl, options = {}) {
        this.fetchImpl = fetchImpl;
        this.onPhase = options.onPhase;
        this.onRecover = options.onRecover;
    }

    async install(release, installRoot) {
        validateInput(release, installRoot);
        await ensureInstallRoot(installRoot);
        const previousCurrentRaw = await readOptionalFile(join(installRoot, 'current.json'));
        const previousCurrent = parseCurrent(previousCurrentRaw);
        const transactionId = randomUUID();
        const journal = new CpmInstallJournal(installRoot, transactionId, release);
        await mkdir(join(installRoot, '.transactions'), { recursive: true });
        await journal.initialize(previousCurrent);

        const archive = join(journal.root, 'download.tgz');
        const staging = join(journal.root, 'staging');
        const destination = join(installRoot, 'versions', release.id, release.version);
        let ownsDestination = false;
        let pointerTouched = false;
        try {
            await this.emit('resolved');
            const response = await this.fetchImpl(release.url, { redirect: 'error' });
            if (!response.ok) throw new Error(`cpm_release_request_refused:${response.status}`);
            const content = new Uint8Array(await response.arrayBuffer());
            if (!CpmReleaseManifest.verifyDigest(content, release.sha256)) throw new Error('cpm_release_digest_mismatch');
            const entries = inspectArchive(content);
            await writeFile(archive, content, { flag: 'wx' });
            await journal.write('downloaded');
            await this.emit('downloaded');

            await mkdir(staging);
            await extractEntries(entries, staging);
            const manifest = CpmRuntimeManifest.parse(JSON.parse(await readFile(join(staging, 'runtime.manifest.json'), 'utf8')));
            if (manifest.id !== release.id || manifest.version !== release.version) throw new Error('cpm_runtime_release_mismatch');
            await CpmRuntimeManifest.verifyDirectory(staging, manifest);
            await journal.write('staged');
            await this.emit('staged');

            await mkdir(join(installRoot, 'versions', release.id), { recursive: true });
            if (await exists(destination)) {
                await verifyInstalledVersion(destination, manifest);
                await rm(staging, { recursive: true, force: true });
            } else {
                await rename(staging, destination);
                ownsDestination = true;
            }

            const current = { schemaVersion: 1, id: release.id, version: release.version, path: `versions/${release.id}/${release.version}` };
            await replaceCurrent(installRoot, transactionId, `${JSON.stringify(current, null, 4)}\n`);
            pointerTouched = true;
            await journal.write('committed');
            await this.emit('committed');

            await verifyRuntime(destination, manifest);
            await journal.write('verified');
            await this.emit('verified');
            await journal.cleanup();
            await removeTransactionsDirectoryIfEmpty(installRoot);
            return destination;
        } catch (error) {
            const original = error instanceof Error ? error : new Error('cpm_runtime_install_failed');
            if (pointerTouched) {
                try {
                    if (this.onRecover != null) await this.onRecover();
                    await restoreCurrent(installRoot, transactionId, previousCurrentRaw);
                    if (ownsDestination) await rm(destination, { recursive: true, force: true });
                    await journal.write('recovered');
                    await journal.cleanup();
                    await removeTransactionsDirectoryIfEmpty(installRoot);
                } catch {
                    throw new Error(`cpm_runtime_install_may_have_changed:${original.message}`);
                }
                throw new Error(`cpm_runtime_install_recovered:${original.message}`);
            }
            if (ownsDestination) await rm(destination, { recursive: true, force: true });
            await journal.cleanup();
            await removeTransactionsDirectoryIfEmpty(installRoot);
            throw original;
        }
    }

    async emit(phase) {
        if (this.onPhase != null) await this.onPhase(phase);
    }
}

function validateInput(release, installRoot) {
    if (!release
        || typeof release.id !== 'string'
        || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(release.id)
        || typeof release.version !== 'string'
        || !/^\d+\.\d+\.\d+$/u.test(release.version)
        || typeof release.url !== 'string'
        || !release.url.startsWith('https://')
        || typeof release.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/u.test(release.sha256)
        || typeof installRoot !== 'string'
        || installRoot.length === 0) {
        throw new Error('cpm_install_input_invalid');
    }
}

async function ensureInstallRoot(installRoot) {
    if (await exists(installRoot)) {
        const stats = await lstat(installRoot);
        if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('cpm_install_root_invalid');
        return;
    }
    await mkdir(installRoot, { recursive: true });
}

function inspectArchive(content) {
    let tar;
    try {
        tar = gunzipSync(content);
    } catch {
        throw new Error('cpm_runtime_archive_invalid');
    }
    const paths = new Set();
    const entries = [];
    let zeroBlocks = 0;
    for (let offset = 0; offset + 512 <= tar.length; offset += 512) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((value) => value === 0)) {
            zeroBlocks += 1;
            if (zeroBlocks === 2) {
                if (tar.subarray(offset + 512).some((value) => value !== 0)) throw new Error('cpm_runtime_archive_hidden_payload');
                return entries;
            }
            continue;
        }
        zeroBlocks = 0;
        const name = readTarString(header, 0, 100);
        const prefix = readTarString(header, 345, 155);
        const path = prefix.length === 0 ? name : `${prefix}/${name}`;
        const type = header[156];
        const sizeText = readTarString(header, 124, 12).trim();
        const size = Number.parseInt(sizeText || '0', 8);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('cpm_runtime_archive_invalid');
        if (!isSafeArchivePath(path)) throw new Error('cpm_runtime_archive_path_invalid');
        if (paths.has(path)) throw new Error('cpm_runtime_archive_duplicate_path');
        paths.add(path);
        if (type !== 0 && type !== 0x30 && type !== 0x35) throw new Error('cpm_runtime_archive_special_file_rejected');
        if (type === 0x35 && size !== 0) throw new Error('cpm_runtime_archive_invalid');
        if (offset + 512 + size > tar.length) throw new Error('cpm_runtime_archive_truncated');
        entries.push({ path: path.replace(/\\/gu, '/').replace(/\/$/u, ''), directory: type === 0x35, content: tar.subarray(offset + 512, offset + 512 + size) });
        offset += Math.ceil(size / 512) * 512;
    }
    throw new Error('cpm_runtime_archive_truncated');
}

/** @description 按已校验的 ustar 条目写入暂存目录；不依赖各平台行为不一的系统 tar。 */
async function extractEntries(entries, staging) {
    for (const entry of entries) {
        const target = join(staging, ...entry.path.split('/'));
        if (entry.directory) {
            await mkdir(target, { recursive: true });
            continue;
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, entry.content, { flag: 'wx' });
    }
}

function isSafeArchivePath(value) {
    const normalized = value.replace(/\\/gu, '/').replace(/\/$/u, '');
    const segments = normalized.split('/');
    return normalized.length > 0
        && !normalized.startsWith('/')
        && !/^[A-Za-z]:/u.test(normalized)
        && !segments.some((segment) => segment === '' || segment === '..' || segment === '.' || segment.startsWith('.'));
}

function readTarString(buffer, offset, length) {
    const slice = buffer.subarray(offset, offset + length);
    const end = slice.indexOf(0);
    return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8');
}

async function verifyInstalledVersion(destination, expectedManifest) {
    const manifest = CpmRuntimeManifest.parse(JSON.parse(await readFile(join(destination, 'runtime.manifest.json'), 'utf8')));
    if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) throw new Error('cpm_runtime_version_conflict');
    await CpmRuntimeManifest.verifyDirectory(destination, manifest);
}

async function verifyRuntime(destination, manifest) {
    let result;
    try {
        result = await runFile(process.execPath, [join(destination, manifest.entry), 'version', '--json'], { cwd: destination });
    } catch {
        throw new Error('cpm_runtime_smoke_failed');
    }
    let identity;
    try {
        identity = JSON.parse(result.stdout);
    } catch {
        throw new Error('cpm_runtime_smoke_invalid');
    }
    if (identity?.schemaVersion !== 1 || identity.id !== manifest.id || identity.version !== manifest.version) {
        throw new Error('cpm_runtime_smoke_mismatch');
    }
}

async function replaceCurrent(installRoot, transactionId, content) {
    const temporary = join(installRoot, `current.json.${transactionId}.tmp`);
    await writeFile(temporary, content, { flag: 'wx' });
    await rename(temporary, join(installRoot, 'current.json'));
}

async function restoreCurrent(installRoot, transactionId, previousCurrentRaw) {
    if (previousCurrentRaw == null) {
        await rm(join(installRoot, 'current.json'), { force: true });
        return;
    }
    await replaceCurrent(installRoot, `${transactionId}.recover`, previousCurrentRaw);
}

function parseCurrent(content) {
    if (content == null) return null;
    let value;
    try {
        value = JSON.parse(content);
    } catch {
        throw new Error('cpm_runtime_current_invalid');
    }
    if (value?.schemaVersion !== 1 || typeof value.id !== 'string' || typeof value.version !== 'string' || typeof value.path !== 'string') {
        throw new Error('cpm_runtime_current_invalid');
    }
    return { id: value.id, version: value.version, path: value.path };
}

async function readOptionalFile(path) {
    try {
        return await readFile(path, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

async function exists(path) {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

async function removeTransactionsDirectoryIfEmpty(installRoot) {
    try {
        await rmdir(join(installRoot, '.transactions'));
    } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY' && error?.code !== 'EEXIST') throw error;
    }
}
