#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeFiles = Object.freeze([
    Object.freeze({ path: 'cli/cpm.mjs', mode: 0o755 }),
    Object.freeze({ path: 'cli/runtime-config.mjs', mode: 0o644 }),
]);

export async function buildRuntimeArchive(outputPath, options = {}) {
    if (typeof outputPath !== 'string' || outputPath.length === 0) throw new Error('cpm_runtime_output_path_missing');

    const sourceFiles = options.files ?? runtimeFiles;
    if (!Array.isArray(sourceFiles) || sourceFiles.length === 0 || new Set(sourceFiles.map((record) => record.path)).size !== sourceFiles.length || sourceFiles.some((record) => !isSafeRuntimePath(record.path))) {
        throw new Error('cpm_runtime_build_files_invalid');
    }
    const files = await Promise.all(sourceFiles.map(async (record) => {
        const content = record.content == null ? await readFile(resolve(repositoryRoot, record.path)) : Buffer.from(record.content);
        return Object.freeze({
            path: record.path,
            mode: record.mode ?? 0o644,
            content,
            sha256: createHash('sha256').update(content).digest('hex'),
        });
    }));
    const runtime = await import(pathToFileURL(resolve(repositoryRoot, 'cli/runtime-config.mjs')).href);
    const identity = options.identity ?? runtime.CPM_RUNTIME;
    if (identity?.schemaVersion !== 1 || typeof identity.id !== 'string' || typeof identity.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(identity.version)) {
        throw new Error('cpm_runtime_build_identity_invalid');
    }
    const manifest = {
        schemaVersion: identity.schemaVersion,
        id: identity.id,
        version: identity.version,
        entry: options.entry ?? 'cli/cpm.mjs',
        files: files.map(({ path, sha256 }) => ({ path, sha256 })),
    };
    const manifestContent = Buffer.from(`${JSON.stringify(manifest, null, 4)}\n`, 'utf8');
    const archiveEntries = [
        { path: 'runtime.manifest.json', mode: 0o644, content: manifestContent },
        ...files,
    ].sort((left, right) => left.path.localeCompare(right.path));
    const archive = deterministicGzip(createTar(archiveEntries));
    await writeFile(outputPath, archive, { flag: 'wx' });
    return Object.freeze({
        archivePath: resolve(outputPath),
        sha256: createHash('sha256').update(archive).digest('hex'),
        manifest,
    });
}

function createTar(entries) {
    const blocks = [];
    for (const entry of entries) {
        const header = Buffer.alloc(512);
        writeString(header, 0, 100, entry.path);
        writeOctal(header, 100, 8, entry.mode);
        writeOctal(header, 108, 8, 0);
        writeOctal(header, 116, 8, 0);
        writeOctal(header, 124, 12, entry.content.length);
        writeOctal(header, 136, 12, 0);
        header.fill(0x20, 148, 156);
        header[156] = 0x30;
        writeString(header, 257, 6, 'ustar');
        writeString(header, 263, 2, '00');
        writeString(header, 265, 32, 'root');
        writeString(header, 297, 32, 'root');
        const checksum = header.reduce((total, value) => total + value, 0);
        writeChecksum(header, checksum);
        blocks.push(header, entry.content);
        const padding = (512 - (entry.content.length % 512)) % 512;
        if (padding > 0) blocks.push(Buffer.alloc(padding));
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
}

function deterministicGzip(content) {
    const archive = gzipSync(content, { level: 9, mtime: 0 });
    archive.fill(0, 4, 8);
    archive[9] = 0xff;
    return archive;
}

function writeString(buffer, offset, length, value) {
    const encoded = Buffer.from(value, 'utf8');
    if (encoded.length > length) throw new Error('cpm_runtime_archive_path_too_long');
    encoded.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
    writeString(buffer, offset, length, value.toString(8).padStart(length - 1, '0'));
}

function writeChecksum(buffer, value) {
    const encoded = Buffer.from(`${value.toString(8).padStart(6, '0')}\0 `, 'ascii');
    encoded.copy(buffer, 148);
}

function isSafeRuntimePath(value) {
    return typeof value === 'string'
        && value.length > 0
        && !value.startsWith('/')
        && !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || segment.startsWith('.'));
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const result = await buildRuntimeArchive(process.argv[2]);
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : 'cpm_runtime_build_failed'}\n`);
        process.exitCode = 1;
    }
}
