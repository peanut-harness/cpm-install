import { createPublicKey, verify as verifySignature } from 'node:crypto';

const FIELD_ORDERS = Object.freeze({
    'cpm-release-v1': Object.freeze(['id', 'version', 'channel', 'url', 'sha256']),
    'lite-product-v1': Object.freeze([
        'id',
        'version',
        'channel',
        'sourceCommit',
        'hostUrl',
        'hostSha256',
        'hostPackageDigest',
        'coreUrl',
        'coreSha256',
        'corePackageDigest',
        'creatorProfiles',
    ]),
});

/**
 * @description CPM 与产品发行共用的 v1 规范化签名协议。
 */
export class CpmSigningProtocol {
    /**
     * @description 按协议固定字段顺序生成 UTF-8 JSON payload。
     * @param {'cpm-release-v1' | 'lite-product-v1'} kind 签名用途。
     * @param {Record<string, unknown>} fields 受签字段。
     * @returns {string} 规范化 JSON。
     */
    static canonicalize(kind, fields) {
        const order = FIELD_ORDERS[kind];
        if (order == null || !isRecord(fields)) throw new Error('cpm_signing_payload_invalid');
        const payload = { schemaVersion: 1, kind };
        for (const field of order) {
            const value = fields[field];
            if (field === 'creatorProfiles') {
                if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) throw new Error('cpm_signing_payload_invalid');
                payload[field] = [...value];
            } else {
                if (typeof value !== 'string' || value.length === 0) throw new Error('cpm_signing_payload_invalid');
                payload[field] = value;
            }
        }
        return JSON.stringify(payload);
    }

    /**
     * @description 使用 DER/SPKI Base64 Ed25519 公钥验证规范化 payload。
     */
    static verify(kind, fields, signature, publicKey) {
        if (typeof signature !== 'string' || signature.length === 0 || typeof publicKey !== 'string' || publicKey.length === 0) return false;
        try {
            return verifySignature(
                null,
                Buffer.from(this.canonicalize(kind, fields), 'utf8'),
                createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }),
                Buffer.from(signature, 'base64'),
            );
        } catch {
            return false;
        }
    }
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
