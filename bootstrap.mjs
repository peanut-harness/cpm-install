import { CpmReleaseManifest } from './release-manifest.mjs';
import { CpmRuntimeManifest } from './runtime-manifest.mjs';
import { lstat } from 'node:fs/promises';

/**
 * @description CPM bootstrap 的 release 解析与安全门禁。
 */
export class CpmBootstrap {
    /**
     * @description 创建 bootstrap，并允许测试注入 Fetch 实现。
     * @param fetchImpl 可选 Fetch 实现。
     */
    constructor(fetchImpl = fetch) {
        this.fetchImpl = fetchImpl;
    }

    /**
     * @description 从本地文件或 HTTPS 地址读取 release manifest，并选择发行。
     * @param manifestSource 本地 manifest 路径或 HTTPS URL。
     * @param channel 目标发行渠道。
     * @returns 选中的发行；无可用发行时抛出拒绝错误。
     */
    async resolve(manifestSource, channel = 'stable') {
        const manifest = await this.readManifest(manifestSource);
        const release = CpmReleaseManifest.select(manifest, channel);
        if (release == null) throw new Error('cpm_release_unavailable');
        return release;
    }

    /**
     * @description 读取并校验本地或 HTTPS release manifest。
     * @param source manifest 来源。
     * @returns 已校验 manifest。
     */
    async readManifest(source) {
        if (typeof source !== 'string' || source.length === 0) throw new Error('cpm_release_manifest_source_missing');
        if (source.startsWith('https://')) {
            const response = await this.fetchImpl(source, { redirect: 'error' });
            if (!response.ok) throw new Error(`cpm_release_manifest_request_refused:${response.status}`);
            return CpmReleaseManifest.parse(await response.json(), process.env.CPM_TRUSTED_PUBLIC_KEY);
        }
        return CpmReleaseManifest.read(source, process.env.CPM_TRUSTED_PUBLIC_KEY);
    }

    /**
     * @description 下载已签名发行并以原子方式写入目标目录。
     * @param release 已通过 manifest 签名校验的发行。
     * @param installRoot CPM 安装根目录。
     * @returns 实际写入的发行文件路径。
     */
    async install(release, installRoot) {
        if (!release || typeof installRoot !== 'string' || installRoot.length === 0) throw new Error('cpm_install_input_invalid');
        const response = await this.fetchImpl(release.url, { redirect: 'error' });
        if (!response.ok) throw new Error(`cpm_release_request_refused:${response.status}`);
        const content = new Uint8Array(await response.arrayBuffer());
        if (!CpmReleaseManifest.verifyDigest(content, release.sha256)) throw new Error('cpm_release_digest_mismatch');
        const { mkdir, writeFile, rename, rm, mkdtemp, readdir, readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const runFile = promisify(execFile);
        await mkdir(installRoot, { recursive: true });
        const archive = join(installRoot, `.download-${release.id}-${release.version}-${process.pid}.tgz`);
        const temporary = `${archive}.tmp`;
        await writeFile(temporary, content, { flag: 'wx' });
        try {
            await rename(temporary, archive);
            const staging = await mkdtemp(join(installRoot, `.staging-${release.id}-${release.version}-`));
            let destination;
            try {
                const archiveEntries = (await runFile('tar', ['-tzf', archive])).stdout.split('\n').filter(Boolean);
                if (archiveEntries.some((entry) => !isSafeArchivePath(entry))) throw new Error('cpm_runtime_archive_path_invalid');
                await runFile('tar', ['-xzf', archive, '-C', staging]);
                const entries = await readdir(staging, { withFileTypes: true });
                if (entries.some((entry) => entry.name !== 'runtime.manifest.json' && entry.name.startsWith('.'))) throw new Error('cpm_runtime_hidden_path_rejected');
                const manifestPath = join(staging, 'runtime.manifest.json');
                const manifest = CpmRuntimeManifest.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
                if (manifest.id !== release.id || manifest.version !== release.version) throw new Error('cpm_runtime_release_mismatch');
                await CpmRuntimeManifest.verifyDirectory(staging, manifest);
                destination = join(installRoot, 'versions', release.id, release.version);
                if (await exists(destination)) throw new Error('cpm_runtime_version_already_installed');
                await mkdir(join(installRoot, 'versions', release.id), { recursive: true });
                await rename(staging, destination);
                await writeFile(join(installRoot, 'current.json.tmp'), `${JSON.stringify({ schemaVersion: 1, id: release.id, version: release.version, path: `versions/${release.id}/${release.version}` }, null, 4)}\n`, { flag: 'wx' });
                await rename(join(installRoot, 'current.json.tmp'), join(installRoot, 'current.json'));
                return destination;
            } catch (error) {
                await rm(staging, { recursive: true, force: true });
                if (destination) await rm(destination, { recursive: true, force: true });
                throw error;
            }
        } catch (error) {
            await rm(temporary, { force: true });
            await rm(archive, { force: true });
            throw error;
        }
    }
}

function isSafeArchivePath(value) {
    const normalized = value.replace(/\\/g, '/').replace(/\/$/u, '');
    return normalized.length > 0 && !normalized.startsWith('/') && !normalized.split('/').some((segment) => segment === '..' || segment === '.');
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

if (process.argv[1]?.endsWith('bootstrap.mjs')) {
    try {
        const release = await new CpmBootstrap().resolve(process.argv[2], process.argv[3] ?? 'stable');
        process.stdout.write(`${JSON.stringify(release)}\n`);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : 'cpm_bootstrap_failed'}\n`);
        process.exitCode = 1;
    }
}
