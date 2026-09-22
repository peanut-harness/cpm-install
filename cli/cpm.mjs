#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { LiteProjectInstaller } from './install/lite-project-installer.mjs';
import { LiteProductCatalog } from './product-catalog.mjs';
import { CPM_RUNTIME } from './runtime-config.mjs';

const USAGE = 'cpm_cli_usage: expected "version --json", "product resolve <catalog> [channel] --json" or "lite <install|upgrade|repair> --project <path> --catalog <catalog> [--channel <channel>] --json"\n';

export async function run(args, output = process.stdout, errorOutput = process.stderr, env = process.env) {
    if (args.length === 2 && args[0] === 'version' && args[1] === '--json') {
        output.write(`${JSON.stringify(CPM_RUNTIME)}\n`);
        return 0;
    }
    if ((args.length === 4 || args.length === 5) && args[0] === 'product' && args[1] === 'resolve' && args.at(-1) === '--json') {
        return report(output, errorOutput, 'cpm_product_resolve_failed', async () => {
            const source = args[2];
            const catalog = await LiteProductCatalog.read(source, productTestTrustAnchorOptions(source, env));
            const product = LiteProductCatalog.select(catalog, args.length === 5 ? args[3] : 'stable');
            if (product == null) throw new Error('cpm_product_unavailable');
            return product;
        });
    }
    const lite = parseLiteArgs(args);
    if (lite != null) {
        return report(output, errorOutput, 'cpm_lite_install_failed', async () => {
            const catalog = await LiteProductCatalog.read(lite.catalog, productTestTrustAnchorOptions(lite.catalog, env));
            const installer = new LiteProjectInstaller({ fetchImpl: productTestFetch(lite.catalog, env) });
            return installer.run(lite.action, lite.project, catalog, lite.channel);
        });
    }

    errorOutput.write(USAGE);
    return 2;
}

async function report(output, errorOutput, fallback, operation) {
    try {
        output.write(`${JSON.stringify(await operation())}\n`);
        return 0;
    } catch (error) {
        errorOutput.write(`${error instanceof Error ? error.message : fallback}\n`);
        return 1;
    }
}

function parseLiteArgs(args) {
    if (args[0] !== 'lite' || !['install', 'upgrade', 'repair'].includes(args[1]) || args.at(-1) !== '--json') return null;
    const options = { action: args[1], channel: 'stable' };
    const flags = args.slice(2, -1);
    if (flags.length % 2 !== 0) return null;
    for (let index = 0; index < flags.length; index += 2) {
        const key = { '--project': 'project', '--catalog': 'catalog', '--channel': 'channel' }[flags[index]];
        if (key == null || typeof flags[index + 1] !== 'string') return null;
        options[key] = flags[index + 1];
    }
    return options.project != null && options.catalog != null ? options : null;
}

function productTestTrustAnchorOptions(source, env) {
    const encoded = env.CPM_TEST_PRODUCT_TRUSTED_PUBLIC_KEYS;
    if (!isLocalTestSource(source, env) || encoded == null) return undefined;
    let anchors;
    try {
        anchors = JSON.parse(encoded);
    } catch {
        throw new Error('cpm_product_test_trust_anchor_invalid');
    }
    return { allowTestTrustAnchors: true, testTrustAnchors: anchors };
}

/** @description 测试模式下从本地目录按 URL 文件名提供 archive；公共 HTTPS catalog 永不启用。 */
function productTestFetch(source, env) {
    const directory = env.CPM_TEST_PRODUCT_ARCHIVE_DIR;
    if (!isLocalTestSource(source, env) || directory == null) return globalThis.fetch;
    return async (url) => {
        const content = await readFile(join(directory, basename(new URL(url).pathname)));
        return { ok: true, redirected: false, arrayBuffer: async () => content };
    };
}

function isLocalTestSource(source, env) {
    return env.CPM_TEST_MODE === '1' && !source.startsWith('https://');
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    process.exitCode = await run(process.argv.slice(2));
}
