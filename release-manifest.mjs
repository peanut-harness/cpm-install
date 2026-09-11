import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * @description 校验 CPM release manifest，并选择指定渠道的最新发行。
 */
export class CpmReleaseManifest {
    /**
     * @description 从 JSON 文件读取并校验 release manifest。
     * @param manifestPath manifest 文件路径。
     * @returns 已校验 manifest。
     */
    static async read(manifestPath, trustedPublicKey) {
        const value = JSON.parse(await readFile(manifestPath, 'utf8'));
        return this.parse(value, trustedPublicKey);
    }

    /**
     * @description 校验外部 manifest 的结构、发行字段和签名。
     * @param value 未受信 JSON 值。
     * @returns 已校验 manifest。
     */
    static parse(value, trustedPublicKey) {
        if (!isRecord(value) || value.schemaVersion !== 2 || !isChannel(value.channel) || !Array.isArray(value.releases)) throw new Error('cpm_release_manifest_invalid');
        const publicKey = value.publicKey;
        if (value.releases.length > 0 && (typeof trustedPublicKey !== 'string' || trustedPublicKey.length === 0)) throw new Error('cpm_release_trust_anchor_missing');
        if (value.releases.length > 0 && publicKey?.value !== trustedPublicKey) throw new Error('cpm_release_trust_anchor_mismatch');
        if (value.releases.length > 0 && (!isRecord(publicKey) || publicKey.algorithm !== 'ed25519' || publicKey.format !== 'spki-der-base64' || typeof publicKey.value !== 'string' || publicKey.value.length === 0)) throw new Error('cpm_release_public_key_missing');
        const releases = value.releases.map((release) => this.parseRelease(release, publicKey));
        const ids = new Set();
        for (const release of releases) {
            const key = `${release.id}@${release.version}`;
            if (ids.has(key)) throw new Error('cpm_release_duplicate');
            ids.add(key);
        }
        return Object.freeze({ schemaVersion: 2, channel: value.channel, publicKey: publicKey ?? null, releases: Object.freeze(releases) });
    }

    /**
     * @description 选择指定渠道中的最高语义化版本。
     * @param manifest 已校验 manifest。
     * @param channel 目标发行渠道。
     * @returns 选中的发行或 null。
     */
    static select(manifest, channel = manifest.channel) {
        const candidates = manifest.releases.filter((release) => release.channel === channel).sort((left, right) => compareVersions(right.version, left.version));
        return candidates[0] ?? null;
    }

    /**
     * @description 校验下载内容的 SHA-256 摘要。
     * @param content 下载内容。
     * @param expected 发行声明摘要。
     * @returns 摘要是否匹配。
     */
    static verifyDigest(content, expected) {
        return createHash('sha256').update(content).digest('hex') === expected;
    }

    /** @description 校验单个发行记录及其 Ed25519 签名。 */
    static parseRelease(value, publicKey) {
        if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(value.id) || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value.version) || !isChannel(value.channel) || typeof value.url !== 'string' || !isHttpsUrl(value.url) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256) || typeof value.signature !== 'string' || value.signature.length === 0 || !isRecord(publicKey)) throw new Error('cpm_release_entry_invalid');
        const payload = JSON.stringify({ id: value.id, version: value.version, channel: value.channel, url: value.url, sha256: value.sha256 });
        let valid = false;
        try {
            valid = verifySignature(null, Buffer.from(payload), createPublicKey({ key: Buffer.from(publicKey.value, 'base64'), format: 'der', type: 'spki' }), Buffer.from(value.signature, 'base64'));
        } catch {
            valid = false;
        }
        if (!valid) throw new Error('cpm_release_signature_invalid');
        return Object.freeze({ id: value.id, version: value.version, channel: value.channel, url: value.url, sha256: value.sha256, signature: value.signature });
    }
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isChannel(value) {
    return value === 'stable' || value === 'beta' || value === 'internal';
}

function isHttpsUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
    } catch {
        return false;
    }
}

function compareVersions(left, right) {
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
}
