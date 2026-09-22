import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/** Synthetic Lite Host/Core release builders shared by CPM install tests. */

export function hostFiles(version) {
    return new Map([
        ['package.json', Buffer.from(JSON.stringify({ name: 'peanut-pod-lite-host', version, main: './dist/main.js' }))],
        ['dist/main.js', Buffer.from(`host ${version}`)],
        ['panels/standalone/.gitkeep', Buffer.alloc(0)],
        ['dist/main.js.map', Buffer.from('map')],
    ]);
}

export function coreFiles(version) {
    const payload = new Map([
        ['peanut.pod-lite.bundle.js', Buffer.from(`core ${version}`)],
        ['package.json', Buffer.from('{"type":"commonjs"}')],
        ['libs/.keep', Buffer.alloc(0)],
        ['bundled/default_prefab/2d.meta', Buffer.from('meta')],
        ['bundled/default_prefab_24/2d-camera.prefab', Buffer.from('camera')],
        ['bundled/default_prefab_24/2d-camera.prefab.meta', Buffer.from('camera meta')],
    ]);
    const files = [...payload.entries()].map(([path, content]) => ({ path, digest: sha256(content) }));
    const manifest = { id: 'peanut.pod-lite', version, kind: 'tooling-plugin', main: './peanut.pod-lite.bundle.js', package: { schemaVersion: 1, files, digest: packageDigest(payload) } };
    return new Map([...payload, ['peanut.pod-lite.manifest.json', Buffer.from(JSON.stringify(manifest))]]);
}

export function packageDigest(files) {
    const records = [...files.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([path, content]) => `${path}:${sha256(content)}`);
    return sha256(records.join('\n'));
}

export function tarGzip(rootName, files) {
    const blocks = [header(`${rootName}/`, 0, 0x35)];
    for (const [path, content] of [...files.entries()].sort(([left], [right]) => (left < right ? -1 : 1))) {
        blocks.push(header(`${rootName}/${path}`, content.length, 0x30), content, Buffer.alloc((512 - (content.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(blocks));
}

function header(path, size, type) {
    const block = Buffer.alloc(512);
    block.write(path, 0, 100, 'utf8');
    block.write('0000644\0', 100);
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    block[156] = type;
    block.write('ustar\0', 257);
    return block;
}

export function sha256(content) {
    return createHash('sha256').update(content).digest('hex');
}

/**
 * @description 生成与 Lite descriptor 协议一致的发布目录（Host/Core archive + lite-release-descriptor.json）内容。
 * @returns {{ descriptor: object, archives: Record<string, Buffer> }}
 */
export function liteRelease(version = '0.2.0') {
    const host = hostFiles(version);
    const core = coreFiles(version);
    const hostArchive = `peanut-pod-lite-host-${version}.tar.gz`;
    const coreArchive = `peanut-pod-lite-core-${version}.tar.gz`;
    const archives = { [hostArchive]: tarGzip(`peanut-pod-lite-host-${version}`, host), [coreArchive]: tarGzip(`peanut.pod-lite-${version}`, core) };
    const profile = (creatorVersion) => ({ version: creatorVersion, operationCount: 83, readOperationCount: 38, writeOperationCount: 45 });
    const descriptor = {
        schemaVersion: 1,
        productId: 'peanut.pod-lite',
        version,
        sourceCommit: 'c'.repeat(40),
        creatorProfiles: [profile('3.8.3'), profile('3.8.7')],
        host: { kind: 'host', archive: hostArchive, sha256: sha256(archives[hostArchive]), packageDigest: packageDigest(host) },
        core: { kind: 'core', archive: coreArchive, sha256: sha256(archives[coreArchive]), packageDigest: JSON.parse(core.get('peanut.pod-lite.manifest.json')).package.digest },
    };
    return { descriptor, archives };
}
