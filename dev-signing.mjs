import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';

/**
 * Built-in development signing keys. They are derived from public seeds, so
 * anyone can reproduce them: they authenticate nothing and exist only for
 * development and testing. They are trusted only when `CPM_DEV_KEYS=1` is set
 * explicitly, and never for the `stable` channel.
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SEEDS = Object.freeze({
    'cpm-release': 'peanut-harness/cpm-release-dev/v1',
    'lite-product': 'peanut-harness/lite-product-dev/v1',
});

/**
 * @description 返回指定用途的开发私钥（KeyObject）；种子公开，私钥即公开。
 * @param {'cpm-release' | 'lite-product'} purpose 签名用途。
 */
export function devPrivateKey(purpose) {
    const seed = SEEDS[purpose];
    if (seed == null) throw new Error('cpm_dev_key_purpose_invalid');
    return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, createHash('sha256').update(seed).digest()]), format: 'der', type: 'pkcs8' });
}

/**
 * @description 开发信任锚（keyId + SPKI Base64 公钥）。
 * @param {'cpm-release' | 'lite-product'} purpose 签名用途。
 */
export function devTrustAnchor(purpose) {
    return Object.freeze({
        keyId: `${purpose}-dev`,
        algorithm: 'ed25519',
        format: 'spki-der-base64',
        value: createPublicKey(devPrivateKey(purpose)).export({ type: 'spki', format: 'der' }).toString('base64'),
    });
}

/** @description 是否显式启用开发密钥。 */
export function devKeysEnabled(env = process.env) {
    return env.CPM_DEV_KEYS === '1';
}

/** @description 公钥是否为任一开发锚。 */
export function isDevKey(publicKeyValue) {
    return Object.keys(SEEDS).some((purpose) => devTrustAnchor(purpose).value === publicKeyValue);
}
