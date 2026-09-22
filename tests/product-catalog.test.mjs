import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { LiteProductCatalog } from '../cli/product-catalog.mjs';
import { LITE_PRODUCT_TRUST_ANCHORS } from '../cli/product-trust-anchors.mjs';
import { CpmSigningProtocol } from '../signing-protocol.mjs';
import { CPM_RELEASE_TRUST_ANCHORS } from '../trust-anchors.mjs';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hostArchive = Buffer.from('host archive bytes');
const coreArchive = Buffer.from('core archive bytes');

function signer() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const value = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const anchor = { keyId: 'test-product', value };
    return {
        privateKey,
        anchor,
        options: { allowTestTrustAnchors: true, testTrustAnchors: [anchor] },
        publicKey: { ...anchor, algorithm: 'ed25519', format: 'spki-der-base64' },
    };
}

function productFields(version = '0.2.0', channel = 'beta', seed = '') {
    return {
        id: 'peanut.pod-lite',
        version,
        channel,
        sourceCommit: 'c'.repeat(40),
        hostUrl: `https://releases.peanut-harness.dev/lite/${version}/peanut-pod-lite-host-${version}.tar.gz`,
        hostSha256: createHash('sha256').update(Buffer.concat([hostArchive, Buffer.from(seed)])).digest('hex'),
        hostPackageDigest: '2'.repeat(64),
        coreUrl: `https://releases.peanut-harness.dev/lite/${version}/peanut-pod-lite-core-${version}.tar.gz`,
        coreSha256: createHash('sha256').update(Buffer.concat([coreArchive, Buffer.from(seed)])).digest('hex'),
        corePackageDigest: '4'.repeat(64),
        creatorProfiles: ['3.8.3', '3.8.7'],
    };
}

function signed(key, fields) {
    const payload = CpmSigningProtocol.canonicalize('lite-product-v1', fields);
    return { ...fields, signature: sign(null, Buffer.from(payload), key.privateKey).toString('base64') };
}

function catalog(key, products, channel = 'beta') {
    return { schemaVersion: 1, kind: 'lite-product-catalog', channel, publicKey: key.publicKey, products };
}

function descriptorFor(product) {
    return {
        schemaVersion: 1,
        productId: product.id,
        version: product.version,
        sourceCommit: product.sourceCommit,
        creatorProfiles: product.creatorProfiles.map((version) => ({ version, operationCount: 83, readOperationCount: 38, writeOperationCount: 45 })),
        host: { kind: 'host', archive: product.hostUrl.split('/').at(-1), sha256: product.hostSha256, packageDigest: product.hostPackageDigest },
        core: { kind: 'core', archive: product.coreUrl.split('/').at(-1), sha256: product.coreSha256, packageDigest: product.corePackageDigest },
    };
}

test('accepts a signed catalog and selects the highest version per channel', () => {
    const key = signer();
    const parsed = LiteProductCatalog.parse(catalog(key, [
        signed(key, productFields('0.2.0')),
        signed(key, productFields('0.3.0')),
        signed(key, productFields('0.4.0', 'internal')),
    ]), key.options);
    assert.equal(LiteProductCatalog.select(parsed).version, '0.3.0');
    assert.equal(LiteProductCatalog.select(parsed, 'internal').version, '0.4.0');
    assert.equal(LiteProductCatalog.select(parsed, 'stable'), null);
    assert.deepEqual(LiteProductCatalog.select(parsed).creatorProfiles, ['3.8.3', '3.8.7']);
});

test('rejects every signed-field mutation', () => {
    const key = signer();
    const product = signed(key, productFields());
    const replacements = {
        id: null,
        version: '0.2.1',
        channel: 'stable',
        sourceCommit: 'd'.repeat(40),
        hostUrl: 'https://releases.peanut-harness.dev/lite/0.2.0/other-host.tar.gz',
        hostSha256: '5'.repeat(64),
        hostPackageDigest: '6'.repeat(64),
        coreUrl: 'https://releases.peanut-harness.dev/lite/0.2.0/other-core.tar.gz',
        coreSha256: '7'.repeat(64),
        corePackageDigest: '8'.repeat(64),
        creatorProfiles: ['3.8.3'],
    };
    for (const [field, replacement] of Object.entries(replacements)) {
        if (replacement == null) continue;
        assert.throws(
            () => LiteProductCatalog.parse(catalog(key, [{ ...product, [field]: replacement }]), key.options),
            /cpm_product_signature_invalid/u,
            field,
        );
    }
    assert.throws(() => LiteProductCatalog.parse(catalog(key, [{ ...product, id: 'peanut.pod-pro' }]), key.options), /cpm_product_entry_invalid/u);
    assert.throws(() => LiteProductCatalog.parse(catalog(key, [{ ...product, signature: 'invalid' }]), key.options), /cpm_product_signature_invalid/u);
});

test('rejects Host and Core artifacts crossed between two signed candidates', () => {
    const key = signer();
    const first = signed(key, productFields('0.2.0', 'beta', 'first'));
    const second = signed(key, productFields('0.2.0', 'beta', 'second'));
    const crossed = { ...first, hostUrl: second.hostUrl, hostSha256: second.hostSha256, hostPackageDigest: second.hostPackageDigest };
    assert.throws(() => LiteProductCatalog.parse(catalog(key, [crossed]), key.options), /cpm_product_signature_invalid/u);
    const mirrored = productFields();
    assert.throws(() => LiteProductCatalog.parse(catalog(key, [signed(key, { ...mirrored, coreUrl: mirrored.hostUrl })]), key.options), /cpm_product_entry_invalid/u);
    assert.throws(() => LiteProductCatalog.parse(catalog(key, [signed(key, { ...mirrored, coreSha256: mirrored.hostSha256 })]), key.options), /cpm_product_entry_invalid/u);
});

test('rejects malformed URLs, unsupported or non-canonical profiles', () => {
    const key = signer();
    const fields = productFields();
    for (const change of [
        { hostUrl: 'http://releases.peanut-harness.dev/lite/host.tar.gz' },
        { coreUrl: 'https://user@releases.peanut-harness.dev/lite/core.tar.gz' },
        { coreUrl: 'https://releases.peanut-harness.dev/lite/core.tar.gz#fragment' },
        { creatorProfiles: ['3.8.7', '3.8.3'] },
        { creatorProfiles: ['3.8.3', '3.8.3'] },
        { creatorProfiles: ['3.8.4'] },
        { sourceCommit: 'c'.repeat(39) },
    ]) {
        assert.throws(() => LiteProductCatalog.parse(catalog(key, [signed(key, { ...fields, ...change })]), key.options), /cpm_product_entry_invalid/u, JSON.stringify(change));
    }
});

test('requires a dedicated product trust anchor distinct from CPM release keys', () => {
    const key = signer();
    const products = [signed(key, productFields())];
    assert.deepEqual(LITE_PRODUCT_TRUST_ANCHORS, []);
    assert.throws(() => LiteProductCatalog.parse(catalog(key, products)), /cpm_product_trust_anchor_missing/u);
    assert.throws(() => LiteProductCatalog.parse(catalog(key, products), { allowTestTrustAnchors: true, testTrustAnchors: [{ keyId: 'other', value: 'other' }] }), /cpm_product_trust_anchor_mismatch/u);
    assert.throws(() => LiteProductCatalog.parse(catalog(key, products), { testTrustAnchors: [key.anchor] }), /cpm_product_test_trust_anchor_refused/u);
    const cpmKey = { ...CPM_RELEASE_TRUST_ANCHORS[0] };
    assert.throws(
        () => LiteProductCatalog.parse({ ...catalog(key, products), publicKey: cpmKey }, { allowTestTrustAnchors: true, testTrustAnchors: [cpmKey] }),
        /cpm_product_key_reuse/u,
    );
    const empty = LiteProductCatalog.parse({ schemaVersion: 1, kind: 'lite-product-catalog', channel: 'stable', products: [] });
    assert.equal(LiteProductCatalog.select(empty), null);
});

test('rejects duplicate versions and overwriting a published version', () => {
    const key = signer();
    const product = signed(key, productFields());
    assert.throws(() => LiteProductCatalog.parse(catalog(key, [product, product]), key.options), /cpm_product_duplicate/u);
    const previous = LiteProductCatalog.parse(catalog(key, [product]), key.options);
    const same = LiteProductCatalog.parse(catalog(key, [product, signed(key, productFields('0.3.0'))]), key.options);
    LiteProductCatalog.assertImmutable(previous, same);
    const rebuilt = LiteProductCatalog.parse(catalog(key, [signed(key, productFields('0.2.0', 'beta', 'rebuilt'))]), key.options);
    assert.throws(() => LiteProductCatalog.assertImmutable(previous, rebuilt), /cpm_product_version_overwrite/u);
});

test('binds the Lite release descriptor to the signed product', () => {
    const key = signer();
    const product = LiteProductCatalog.select(LiteProductCatalog.parse(catalog(key, [signed(key, productFields())]), key.options));
    LiteProductCatalog.verifyDescriptor(product, descriptorFor(product));
    const descriptor = descriptorFor(product);
    for (const mutate of [
        (value) => { value.version = '0.2.1'; },
        (value) => { value.sourceCommit = 'd'.repeat(40); },
        (value) => { value.host.sha256 = '9'.repeat(64); },
        (value) => { value.core.packageDigest = '9'.repeat(64); },
        (value) => { value.host.archive = 'renamed.tar.gz'; },
        (value) => { [value.host, value.core] = [{ ...value.core, kind: 'host' }, { ...value.host, kind: 'core' }]; },
        (value) => { value.creatorProfiles = value.creatorProfiles.slice(0, 1); },
    ]) {
        const copy = structuredClone(descriptor);
        mutate(copy);
        assert.throws(() => LiteProductCatalog.verifyDescriptor(product, copy), /cpm_product_identity_mismatch/u);
    }
});

test('downloads archives without redirects and verifies signed digests', async () => {
    const key = signer();
    const product = LiteProductCatalog.select(LiteProductCatalog.parse(catalog(key, [signed(key, productFields())]), key.options));
    const requests = [];
    const fetchImpl = async (url, init) => {
        requests.push([url, init.redirect]);
        const body = url === product.hostUrl ? hostArchive : coreArchive;
        return { ok: true, redirected: false, arrayBuffer: async () => body };
    };
    assert.deepEqual(await LiteProductCatalog.download(product, 'host', fetchImpl), hostArchive);
    assert.deepEqual(await LiteProductCatalog.download(product, 'core', fetchImpl), coreArchive);
    assert.deepEqual(requests, [[product.hostUrl, 'error'], [product.coreUrl, 'error']]);
    await assert.rejects(LiteProductCatalog.download(product, 'host', async () => ({ ok: true, redirected: true, arrayBuffer: async () => hostArchive })), /cpm_product_redirect_refused/u);
    await assert.rejects(LiteProductCatalog.download(product, 'core', async () => ({ ok: true, redirected: false, arrayBuffer: async () => hostArchive })), /cpm_product_digest_mismatch/u);
    await assert.rejects(LiteProductCatalog.download(product, 'core', async () => ({ ok: false, status: 404 })), /cpm_product_request_refused:404/u);
});

test('reads HTTPS catalogs without redirects and never with test anchors', async () => {
    const key = signer();
    const body = catalog(key, [signed(key, productFields())]);
    const seen = [];
    await assert.rejects(
        LiteProductCatalog.read('https://get.peanut-harness.dev/cpm/products.json', key.options, async (url, init) => {
            seen.push(init.redirect);
            return { ok: true, redirected: false, json: async () => body };
        }),
        /cpm_product_trust_anchor_missing/u,
    );
    assert.deepEqual(seen, ['error']);
    await assert.rejects(
        LiteProductCatalog.read('https://get.peanut-harness.dev/cpm/products.json', undefined, async () => ({ ok: true, redirected: true, json: async () => body })),
        /cpm_product_redirect_refused/u,
    );
});

test('CLI resolves a local test catalog only behind the explicit test gate', async () => {
    const key = signer();
    const root = await mkdtemp(join(tmpdir(), 'cpm-product-catalog-'));
    try {
        const catalogPath = join(root, 'products.json');
        await writeFile(catalogPath, JSON.stringify(catalog(key, [signed(key, productFields())])));
        const entry = join(repositoryRoot, 'cli/cpm.mjs');
        const env = { ...process.env, CPM_TEST_MODE: '1', CPM_TEST_PRODUCT_TRUSTED_PUBLIC_KEYS: JSON.stringify([key.anchor]) };
        const resolved = spawnSync(process.execPath, [entry, 'product', 'resolve', catalogPath, 'beta', '--json'], { encoding: 'utf8', env });
        assert.equal(resolved.status, 0, resolved.stderr);
        assert.equal(JSON.parse(resolved.stdout).version, '0.2.0');
        const ungated = spawnSync(process.execPath, [entry, 'product', 'resolve', catalogPath, 'beta', '--json'], { encoding: 'utf8', env: { ...env, CPM_TEST_MODE: '0' } });
        assert.equal(ungated.status, 1);
        assert.match(ungated.stderr, /cpm_product_trust_anchor_missing/u);
        const stable = spawnSync(process.execPath, [entry, 'product', 'resolve', catalogPath, '--json'], { encoding: 'utf8', env });
        assert.equal(stable.status, 1);
        assert.match(stable.stderr, /cpm_product_unavailable/u);
        const usage = spawnSync(process.execPath, [entry, 'product', 'resolve'], { encoding: 'utf8', env });
        assert.equal(usage.status, 2);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
