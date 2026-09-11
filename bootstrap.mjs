import { CpmReleaseManifest } from './release-manifest.mjs';

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
            return CpmReleaseManifest.parse(await response.json());
        }
        return CpmReleaseManifest.read(source);
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
        const { mkdir, writeFile, rename, rm } = await import('node:fs/promises');
        const { join } = await import('node:path');
        await mkdir(installRoot, { recursive: true });
        const destination = join(installRoot, `${release.id}-${release.version}.tgz`);
        const temporary = `${destination}.tmp-${process.pid}`;
        await writeFile(temporary, content, { flag: 'wx' });
        try {
            await rename(temporary, destination);
        } catch (error) {
            await rm(temporary, { force: true });
            throw error;
        }
        return destination;
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
