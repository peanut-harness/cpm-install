import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { devKeysEnabled, devTrustAnchor } from '../dev-signing.mjs';
import { CpmSigningProtocol } from '../signing-protocol.mjs';
import { CPM_RELEASE_TRUST_ANCHORS } from '../trust-anchors.mjs';
import { LITE_PRODUCT_TRUST_ANCHORS } from './product-trust-anchors.mjs';

const PRODUCT_ID = 'peanut.pod-lite';
const CREATOR_PROFILES = Object.freeze(['3.8.3', '3.8.7']);
const SIGNED_FIELDS = Object.freeze([
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
]);

/**
 * @description 校验签名 Lite 产品 catalog，并把 Host/Core 双 archive 绑定为同一发行候选。
 */
export class LiteProductCatalog {
    /**
     * @description 从 HTTPS 或本地路径读取 catalog；HTTPS 禁止重定向且不接受测试信任锚。
     * @param {string} source catalog 位置。
     * @param {object} [options] 仅本地测试可用的信任锚注入。
     * @param {typeof fetch} [fetchImpl] 网络实现。
     * @returns {Promise<object>} 已校验 catalog。
     */
    static async read(source, options, fetchImpl = globalThis.fetch) {
        if (typeof source !== 'string' || source.length === 0) throw new Error('cpm_product_catalog_source_missing');
        if (source.startsWith('https://')) {
            const response = await fetchImpl(source, { redirect: 'error' });
            if (response.redirected) throw new Error('cpm_product_redirect_refused');
            if (!response.ok) throw new Error(`cpm_product_catalog_request_refused:${response.status}`);
            return this.parse(await response.json());
        }
        return this.parse(JSON.parse(await readFile(source, 'utf8')), options);
    }

    /**
     * @description 校验 catalog 结构、固定产品信任锚、逐条签名与版本唯一性。
     * @param {unknown} value 未受信 JSON 值。
     * @param {object} [options] 测试信任锚注入。
     * @returns {object} 已校验 catalog。
     */
    static parse(value, options) {
        if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'lite-product-catalog' || !isChannel(value.channel) || !Array.isArray(value.products)) throw new Error('cpm_product_catalog_invalid');
        const publicKey = value.publicKey;
        if (value.products.length > 0) {
            if (!isRecord(publicKey) || typeof publicKey.keyId !== 'string' || publicKey.algorithm !== 'ed25519' || publicKey.format !== 'spki-der-base64' || typeof publicKey.value !== 'string' || publicKey.value.length === 0) throw new Error('cpm_product_public_key_missing');
            if ([...CPM_RELEASE_TRUST_ANCHORS, devTrustAnchor('cpm-release')].some((anchor) => anchor.value === publicKey.value)) throw new Error('cpm_product_key_reuse');
            const trustAnchors = resolveTrustAnchors(options);
            if (trustAnchors.length === 0) throw new Error('cpm_product_trust_anchor_missing');
            if (!trustAnchors.some((anchor) => anchor.keyId === publicKey.keyId && anchor.value === publicKey.value)) throw new Error('cpm_product_trust_anchor_mismatch');
        }
        const products = value.products.map((product) => this.parseProduct(product, publicKey));
        if (products.length > 0 && publicKey.value === devTrustAnchor('lite-product').value) {
            if (products.some((product) => product.channel === 'stable')) throw new Error('cpm_product_dev_key_stable_refused');
            process.emitWarning('CPM dev keys are enabled (CPM_DEV_KEYS=1); dev-signed Lite products are for development only and are not authentic.', { code: 'CPM_DEV_KEYS' });
        }
        const keys = new Set();
        for (const product of products) {
            const key = `${product.id}@${product.version}`;
            if (keys.has(key)) throw new Error('cpm_product_duplicate');
            keys.add(key);
        }
        return Object.freeze({ schemaVersion: 1, kind: 'lite-product-catalog', channel: value.channel, publicKey: publicKey ?? null, products: Object.freeze(products) });
    }

    /**
     * @description 选择指定渠道中的最高语义化版本。
     * @returns {object | null} 选中的产品发行。
     */
    static select(catalog, channel = catalog.channel) {
        const candidates = catalog.products.filter((product) => product.channel === channel).sort((left, right) => compareVersions(right.version, left.version));
        return candidates[0] ?? null;
    }

    /**
     * @description 已发布的 id@version 在后续 catalog 中只能保持完全相同的受签字段。
     * @param {object} previous 上一已验证 catalog。
     * @param {object} next 待发布 catalog。
     */
    static assertImmutable(previous, next) {
        const published = new Map(previous.products.map((product) => [`${product.id}@${product.version}`, product]));
        for (const product of next.products) {
            const prior = published.get(`${product.id}@${product.version}`);
            if (prior != null && CpmSigningProtocol.canonicalize('lite-product-v1', prior) !== CpmSigningProtocol.canonicalize('lite-product-v1', product)) {
                throw new Error('cpm_product_version_overwrite');
            }
        }
    }

    /**
     * @description 核对 Lite release descriptor 与已签名产品记录属于同一候选。
     * @param {object} product 已校验产品记录。
     * @param {unknown} descriptor Lite `lite-release-descriptor.json` 内容。
     */
    static verifyDescriptor(product, descriptor) {
        const profiles = isRecord(descriptor) && Array.isArray(descriptor.creatorProfiles)
            ? descriptor.creatorProfiles.map((profile) => (isRecord(profile) ? profile.version : null))
            : null;
        const matches = isRecord(descriptor)
            && descriptor.schemaVersion === 1
            && descriptor.productId === product.id
            && descriptor.version === product.version
            && descriptor.sourceCommit === product.sourceCommit
            && artifactMatches(descriptor.host, 'host', product.hostUrl, product.hostSha256, product.hostPackageDigest)
            && artifactMatches(descriptor.core, 'core', product.coreUrl, product.coreSha256, product.corePackageDigest)
            && profiles != null
            && JSON.stringify([...profiles].sort()) === JSON.stringify(product.creatorProfiles);
        if (!matches) throw new Error('cpm_product_identity_mismatch');
    }

    /**
     * @description 下载 Host 或 Core archive，拒绝重定向并校验签名声明的 SHA-256。
     * @param {object} product 已校验产品记录。
     * @param {'host' | 'core'} kind archive 类型。
     * @param {typeof fetch} [fetchImpl] 网络实现。
     * @returns {Promise<Buffer>} 已校验 archive 字节。
     */
    static async download(product, kind, fetchImpl = globalThis.fetch) {
        if (kind !== 'host' && kind !== 'core') throw new Error('cpm_product_artifact_kind_invalid');
        const response = await fetchImpl(product[`${kind}Url`], { redirect: 'error' });
        if (response.redirected) throw new Error('cpm_product_redirect_refused');
        if (!response.ok) throw new Error(`cpm_product_request_refused:${response.status}`);
        const content = Buffer.from(await response.arrayBuffer());
        if (createHash('sha256').update(content).digest('hex') !== product[`${kind}Sha256`]) throw new Error('cpm_product_digest_mismatch');
        return content;
    }

    /** @description 校验单条产品记录的字段、Host/Core 区分与 Ed25519 签名。 */
    static parseProduct(value, publicKey) {
        if (!isRecord(value)
            || value.id !== PRODUCT_ID
            || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value.version)
            || !isChannel(value.channel)
            || typeof value.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(value.sourceCommit)
            || !isHttpsUrl(value.hostUrl) || !isHttpsUrl(value.coreUrl) || value.hostUrl === value.coreUrl
            || ![value.hostSha256, value.hostPackageDigest, value.coreSha256, value.corePackageDigest].every(isDigest)
            || value.hostSha256 === value.coreSha256 || value.hostPackageDigest === value.corePackageDigest
            || !isCanonicalProfiles(value.creatorProfiles)
            || typeof value.signature !== 'string' || value.signature.length === 0
            || !isRecord(publicKey)) throw new Error('cpm_product_entry_invalid');
        if (!CpmSigningProtocol.verify('lite-product-v1', value, value.signature, publicKey.value)) throw new Error('cpm_product_signature_invalid');
        const product = { signature: value.signature };
        for (const field of SIGNED_FIELDS) product[field] = field === 'creatorProfiles' ? Object.freeze([...value[field]]) : value[field];
        return Object.freeze(product);
    }
}

function resolveTrustAnchors(options) {
    if (options == null) return devKeysEnabled() ? [...LITE_PRODUCT_TRUST_ANCHORS, devTrustAnchor('lite-product')] : LITE_PRODUCT_TRUST_ANCHORS;
    if (!isRecord(options) || options.allowTestTrustAnchors !== true || !Array.isArray(options.testTrustAnchors)) throw new Error('cpm_product_test_trust_anchor_refused');
    return options.testTrustAnchors.filter((anchor) => isRecord(anchor) && typeof anchor.keyId === 'string' && typeof anchor.value === 'string');
}

function artifactMatches(artifact, kind, url, sha256, packageDigest) {
    return isRecord(artifact)
        && artifact.kind === kind
        && typeof artifact.archive === 'string'
        && new URL(url).pathname.endsWith(`/${artifact.archive}`)
        && artifact.sha256 === sha256
        && artifact.packageDigest === packageDigest;
}

function isCanonicalProfiles(value) {
    return Array.isArray(value)
        && value.length > 0
        && value.every((profile, index) => CREATOR_PROFILES.includes(profile) && (index === 0 || compareVersions(value[index - 1], profile) < 0));
}

function isDigest(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isChannel(value) {
    return value === 'stable' || value === 'beta' || value === 'internal';
}

function isHttpsUrl(value) {
    if (typeof value !== 'string') return false;
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
