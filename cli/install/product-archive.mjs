import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const PATH_SEGMENT = /^[A-Za-z0-9._\- ]+$/u;

/**
 * @description 在内存中解析并校验 Lite Host/Core 发行 archive，不依赖系统 tar。
 */
export class LiteProductArchive {
    /**
     * @description 解析确定性 ustar+gzip，要求唯一顶层目录，只接受普通文件与目录。
     * @param {Uint8Array} content 已通过签名摘要校验的 archive 字节。
     * @param {string} rootName 期望的顶层目录名。
     * @returns {Map<string, Buffer>} 相对顶层目录的文件路径到内容。
     */
    static read(content, rootName) {
        let tar;
        try {
            tar = gunzipSync(content);
        } catch {
            throw new Error('cpm_product_archive_invalid');
        }
        const files = new Map();
        const seen = new Set();
        let zeroBlocks = 0;
        for (let offset = 0; offset + 512 <= tar.length; offset += 512) {
            const header = tar.subarray(offset, offset + 512);
            if (header.every((value) => value === 0)) {
                zeroBlocks += 1;
                if (zeroBlocks === 2) {
                    if (tar.subarray(offset + 512).some((value) => value !== 0)) throw new Error('cpm_product_archive_hidden_payload');
                    if (files.size === 0) throw new Error('cpm_product_archive_empty');
                    return files;
                }
                continue;
            }
            zeroBlocks = 0;
            const name = readString(header, 0, 100);
            const prefix = readString(header, 345, 155);
            const rawPath = (prefix.length === 0 ? name : `${prefix}/${name}`).replace(/\/$/u, '');
            const type = header[156];
            const size = Number.parseInt(readString(header, 124, 12).trim() || '0', 8);
            if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('cpm_product_archive_invalid');
            if (type !== 0 && type !== 0x30 && type !== 0x35) throw new Error('cpm_product_archive_special_file_rejected');
            if (!isSafePath(rawPath)) throw new Error('cpm_product_archive_path_invalid');
            if (seen.has(rawPath)) throw new Error('cpm_product_archive_duplicate_path');
            seen.add(rawPath);
            const segments = rawPath.split('/');
            if (segments[0] !== rootName) throw new Error('cpm_product_archive_root_invalid');
            if (type === 0x35) {
                if (size !== 0) throw new Error('cpm_product_archive_invalid');
            } else {
                if (segments.length === 1) throw new Error('cpm_product_archive_root_invalid');
                files.set(segments.slice(1).join('/'), Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
            }
            offset += Math.ceil(size / 512) * 512;
        }
        throw new Error('cpm_product_archive_truncated');
    }

    /**
     * @description 按码元序 `path:sha256` 换行记录计算目录包摘要，与 Lite 打包器一致。
     * @param {Map<string, Buffer>} files 目录包文件。
     * @param {string} [excluded] 不计入摘要的路径（Core 清单自身）。
     * @returns {string} 小写十六进制摘要。
     */
    static packageDigest(files, excluded) {
        const records = [...files.entries()]
            .filter(([path]) => path !== excluded)
            .map(([path, content]) => [path, sha256(content)])
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
        return sha256(records.map(([path, digest]) => `${path}:${digest}`).join('\n'));
    }

    /**
     * @description 校验 Host archive 属于签名产品记录。
     * @returns {Map<string, Buffer>} Host 扩展文件。
     */
    static verifyHost(product, content) {
        const files = this.read(content, `peanut-pod-lite-host-${product.version}`);
        if (!files.has('package.json') || !files.has('dist/main.js')) throw new Error('cpm_product_host_invalid');
        let packageJson;
        try {
            packageJson = JSON.parse(files.get('package.json').toString('utf8'));
        } catch {
            throw new Error('cpm_product_host_invalid');
        }
        if (packageJson?.name !== 'peanut-pod-lite-host' || packageJson.version !== product.version) throw new Error('cpm_product_identity_mismatch');
        if (this.packageDigest(files) !== product.hostPackageDigest) throw new Error('cpm_product_package_digest_mismatch');
        return files;
    }

    /**
     * @description 校验 Core 目录包清单、逐文件摘要、文件集合与签名包摘要。
     * @returns {Map<string, Buffer>} Core 目录包文件。
     */
    static verifyCore(product, content) {
        const files = this.read(content, `${product.id}-${product.version}`);
        const manifestName = `${product.id}.manifest.json`;
        this.verifyCoreManifest(product, files, manifestName);
        return files;
    }

    /** @description 校验 Core 清单与其描述的完整载荷。 */
    static verifyCoreManifest(product, files, manifestName) {
        let manifest;
        try {
            manifest = JSON.parse(files.get(manifestName)?.toString('utf8') ?? '');
        } catch {
            throw new Error('cpm_product_core_manifest_invalid');
        }
        const metadata = manifest?.package;
        if (manifest?.id !== product.id || manifest.version !== product.version || manifest.kind !== 'tooling-plugin' || manifest.main !== `./${product.id}.bundle.js`) throw new Error('cpm_product_identity_mismatch');
        if (metadata?.schemaVersion !== 1 || !Array.isArray(metadata.files) || metadata.digest !== product.corePackageDigest) throw new Error('cpm_product_package_digest_mismatch');
        const declared = new Map();
        for (const record of metadata.files) {
            if (typeof record?.path !== 'string' || !isSafePath(record.path) || typeof record.digest !== 'string' || declared.has(record.path)) throw new Error('cpm_product_core_manifest_invalid');
            declared.set(record.path, record.digest);
        }
        const payload = [...files.keys()].filter((path) => path !== manifestName);
        if (payload.length !== declared.size || payload.some((path) => declared.get(path) !== sha256(files.get(path)))) throw new Error('cpm_product_core_payload_mismatch');
        if (!declared.has(manifest.main.slice(2)) || !declared.has('package.json') || ![...declared.keys()].some((path) => path.startsWith('libs/'))) throw new Error('cpm_product_core_manifest_invalid');
        if (this.packageDigest(files, manifestName) !== metadata.digest) throw new Error('cpm_product_package_digest_mismatch');
    }
}

function isSafePath(value) {
    return value.length > 0
        && !value.startsWith('/')
        && !value.includes('\\')
        && value.split('/').every((segment) => segment !== '.' && segment !== '..' && PATH_SEGMENT.test(segment));
}

function readString(buffer, offset, length) {
    const slice = buffer.subarray(offset, offset + length);
    const end = slice.indexOf(0);
    return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8');
}

function sha256(content) {
    return createHash('sha256').update(content).digest('hex');
}
