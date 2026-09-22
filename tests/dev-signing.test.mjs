import assert from 'node:assert/strict';
import { createPublicKey, sign } from 'node:crypto';
import test from 'node:test';

import { LiteProductCatalog } from '../cli/product-catalog.mjs';
import { devKeysEnabled, devPrivateKey, devTrustAnchor, isDevKey } from '../dev-signing.mjs';
import { CpmReleaseManifest } from '../release-manifest.mjs';
import { mergeManifest, signRelease } from '../scripts/release-cli.mjs';
import { CpmSigningProtocol } from '../signing-protocol.mjs';
import { CPM_RELEASE_TRUST_ANCHORS } from '../trust-anchors.mjs';

const CPM_DEV_PUBLIC_KEY = 'MCowBQYDK2VwAyEAfLO/7cT4pAKTHs0k1PajDsGlCsIHAqUONyj71TkKmrg=';
const PRODUCT_DEV_PUBLIC_KEY = 'MCowBQYDK2VwAyEAeKAVKJRVwUCfHV9QVs1arFqN5VFsz4iBcQ531fXzbtk=';

function withDevKeys(enabled, run) {
    const previous = process.env.CPM_DEV_KEYS;
    if (enabled) process.env.CPM_DEV_KEYS = '1';
    else delete process.env.CPM_DEV_KEYS;
    try {
        return run();
    } finally {
        if (previous == null) delete process.env.CPM_DEV_KEYS;
        else process.env.CPM_DEV_KEYS = previous;
    }
}

function devManifest(channel) {
    const release = { id: 'peanut-cpm-cli', version: '1.0.0', channel, url: 'https://dev.invalid/cpm/1.0.0/peanut-cpm-cli-1.0.0.tgz', sha256: 'a'.repeat(64) };
    const signature = sign(null, Buffer.from(CpmSigningProtocol.canonicalize('cpm-release-v1', release)), devPrivateKey('cpm-release')).toString('base64');
    return { schemaVersion: 2, channel, publicKey: devTrustAnchor('cpm-release'), releases: [{ ...release, signature }] };
}

function devCatalog(channel, purpose = 'lite-product') {
    const product = {
        id: 'peanut.pod-lite', version: '0.2.0', channel, sourceCommit: 'c'.repeat(40),
        hostUrl: 'https://dev.invalid/lite/0.2.0/peanut-pod-lite-host-0.2.0.tar.gz', hostSha256: '1'.repeat(64), hostPackageDigest: '2'.repeat(64),
        coreUrl: 'https://dev.invalid/lite/0.2.0/peanut-pod-lite-core-0.2.0.tar.gz', coreSha256: '3'.repeat(64), corePackageDigest: '4'.repeat(64),
        creatorProfiles: ['3.8.3', '3.8.7'],
    };
    const signature = sign(null, Buffer.from(CpmSigningProtocol.canonicalize('lite-product-v1', product)), devPrivateKey(purpose)).toString('base64');
    return { schemaVersion: 1, kind: 'lite-product-catalog', channel, publicKey: devTrustAnchor(purpose), products: [{ ...product, signature }] };
}

test('built-in dev keys are deterministic, purpose-separated and never production anchors', () => {
    assert.equal(devTrustAnchor('cpm-release').value, CPM_DEV_PUBLIC_KEY);
    assert.equal(devTrustAnchor('lite-product').value, PRODUCT_DEV_PUBLIC_KEY);
    assert.equal(createPublicKey(devPrivateKey('cpm-release')).export({ type: 'spki', format: 'der' }).toString('base64'), CPM_DEV_PUBLIC_KEY);
    assert.equal(CPM_RELEASE_TRUST_ANCHORS.some((anchor) => isDevKey(anchor.value)), false);
    assert.equal(devKeysEnabled({}), false);
    assert.equal(devKeysEnabled({ CPM_DEV_KEYS: '1' }), true);
    assert.throws(() => devPrivateKey('other'), /cpm_dev_key_purpose_invalid/u);
});

test('dev-signed CLI releases are trusted only with CPM_DEV_KEYS=1 and never for stable', () => {
    withDevKeys(false, () => assert.throws(() => CpmReleaseManifest.parse(devManifest('beta')), /cpm_release_trust_anchor_mismatch/u));
    withDevKeys(true, () => {
        assert.equal(CpmReleaseManifest.select(CpmReleaseManifest.parse(devManifest('beta')), 'beta').version, '1.0.0');
        assert.throws(() => CpmReleaseManifest.parse(devManifest('stable')), /cpm_release_dev_key_stable_refused/u);
    });
});

test('dev-signed Lite catalogs are trusted only with CPM_DEV_KEYS=1, never for stable, and never with the CPM dev key', () => {
    withDevKeys(false, () => assert.throws(() => LiteProductCatalog.parse(devCatalog('beta')), /cpm_product_trust_anchor_(?:missing|mismatch)/u));
    withDevKeys(true, () => {
        assert.equal(LiteProductCatalog.select(LiteProductCatalog.parse(devCatalog('internal')), 'internal').version, '0.2.0');
        assert.throws(() => LiteProductCatalog.parse(devCatalog('stable')), /cpm_product_dev_key_stable_refused/u);
        assert.throws(() => LiteProductCatalog.parse(devCatalog('beta', 'cpm-release')), /cpm_product_key_reuse/u);
    });
});

test('release tooling signs with the dev key but keeps it out of official manifests', () => {
    const candidate = { id: 'peanut-cpm-cli', version: '1.0.0', archive: { name: 'peanut-cpm-cli-1.0.0.tgz', sha256: 'b'.repeat(64) } };
    const url = 'https://dev.invalid/cpm/1.0.0/peanut-cpm-cli-1.0.0.tgz';
    assert.throws(() => signRelease(candidate, { channel: 'stable', url, devKey: true }), /cpm_release_dev_key_stable_refused/u);
    const signed = signRelease(candidate, { channel: 'beta', url, devKey: true });
    assert.equal(signed.keyId, 'cpm-release-dev');
    const empty = { schemaVersion: 2, channel: 'beta', publicKey: null, releases: [] };
    assert.throws(() => mergeManifest(empty, signed), /cpm_release_dev_key_refused/u);
    withDevKeys(true, () => assert.equal(mergeManifest(empty, signed, undefined, { allowDevKey: true }).releases.length, 1));
});
