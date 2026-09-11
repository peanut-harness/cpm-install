import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * @description 校验并验证 CPM CLI 解压后的运行时清单。
 */
export class CpmRuntimeManifest {
    /**
     * @description 解析运行时清单的最小协议。
     * @param value 未受信 JSON 值。
     * @returns 已校验运行时清单。
     */
    static parse(value) {
        if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !ID_PATTERN.test(value.id) || typeof value.version !== 'string' || !VERSION_PATTERN.test(value.version) || typeof value.entry !== 'string' || !isSafePath(value.entry) || !Array.isArray(value.files)) throw new Error('cpm_runtime_manifest_invalid');
        const files = value.files.map((record) => {
            if (!isRecord(record) || typeof record.path !== 'string' || !isSafePath(record.path) || typeof record.sha256 !== 'string' || !DIGEST_PATTERN.test(record.sha256)) throw new Error('cpm_runtime_file_record_invalid');
            return { path: record.path, sha256: record.sha256 };
        });
        const paths = new Set(files.map((record) => record.path));
        if (paths.size !== files.length || !paths.has(value.entry)) throw new Error('cpm_runtime_entry_missing');
        return Object.freeze({ schemaVersion: 1, id: value.id, version: value.version, entry: value.entry, files: Object.freeze([...files].sort((left, right) => left.path.localeCompare(right.path))) });
    }

    /**
     * @description 验证解压目录的实际文件集合与摘要。
     * @param root 解压后的运行时目录。
     * @param manifest 已校验运行时清单。
     * @returns 验证通过的运行时清单。
     */
    static async verifyDirectory(root, manifest) {
        const actual = await collectFiles(root);
        if (actual.length !== manifest.files.length || actual.some((record, index) => record.path !== manifest.files[index]?.path || record.sha256 !== manifest.files[index]?.sha256)) throw new Error('cpm_runtime_integrity_mismatch');
        return manifest;
    }
}

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const PATH_PATTERN = /^[A-Za-z0-9._\-\s]+(?:\/[A-Za-z0-9._\-\s]+)*$/u;

function isSafePath(value) {
    return typeof value === 'string' && PATH_PATTERN.test(value) && !value.split('/').some((segment) => segment === '.' || segment === '..');
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function collectFiles(root, prefix = '') {
    const records = [];
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
        const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
        const absolute = join(root, path);
        const stats = await lstat(absolute);
        if (stats.isSymbolicLink()) throw new Error('cpm_runtime_symbolic_link_rejected');
        if (stats.isDirectory()) {
            records.push(...(await collectFiles(root, path)));
        } else if (stats.isFile() && path !== 'runtime.manifest.json') {
            records.push({ path, sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') });
        } else if (!stats.isFile()) {
            throw new Error('cpm_runtime_special_file_rejected');
        }
    }
    return records.sort((left, right) => left.path.localeCompare(right.path));
}
