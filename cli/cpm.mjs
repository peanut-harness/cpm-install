#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { LiteProductCatalog } from './product-catalog.mjs';
import { CPM_RUNTIME } from './runtime-config.mjs';

export async function run(args, output = process.stdout, errorOutput = process.stderr, env = process.env) {
    if (args.length === 2 && args[0] === 'version' && args[1] === '--json') {
        output.write(`${JSON.stringify(CPM_RUNTIME)}\n`);
        return 0;
    }
    if ((args.length === 4 || args.length === 5) && args[0] === 'product' && args[1] === 'resolve' && args.at(-1) === '--json') {
        try {
            const source = args[2];
            const catalog = await LiteProductCatalog.read(source, productTestTrustAnchorOptions(source, env));
            const product = LiteProductCatalog.select(catalog, args.length === 5 ? args[3] : 'stable');
            if (product == null) throw new Error('cpm_product_unavailable');
            output.write(`${JSON.stringify(product)}\n`);
            return 0;
        } catch (error) {
            errorOutput.write(`${error instanceof Error ? error.message : 'cpm_product_resolve_failed'}\n`);
            return 1;
        }
    }

    errorOutput.write('cpm_cli_usage: expected "version --json" or "product resolve <catalog> [channel] --json"\n');
    return 2;
}

function productTestTrustAnchorOptions(source, env) {
    const encoded = env.CPM_TEST_PRODUCT_TRUSTED_PUBLIC_KEYS;
    if (env.CPM_TEST_MODE !== '1' || encoded == null || source.startsWith('https://')) return undefined;
    let anchors;
    try {
        anchors = JSON.parse(encoded);
    } catch {
        throw new Error('cpm_product_test_trust_anchor_invalid');
    }
    return { allowTestTrustAnchors: true, testTrustAnchors: anchors };
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    process.exitCode = await run(process.argv.slice(2));
}
