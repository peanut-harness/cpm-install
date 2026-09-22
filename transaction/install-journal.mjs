import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * @description 记录单次 runtime 安装的稳定身份、阶段和事务自有路径。
 */
export class CpmInstallJournal {
    constructor(installRoot, transactionId, release) {
        this.root = join(installRoot, '.transactions', transactionId);
        this.path = join(this.root, 'journal.json');
        this.temporaryPath = join(this.root, 'journal.json.tmp');
        this.record = {
            schemaVersion: 1,
            transactionId,
            release: { id: release.id, version: release.version, sha256: release.sha256 },
            phase: 'resolved',
            ownedPaths: ['download.tgz', 'staging'],
            previousCurrent: null,
        };
    }

    async initialize(previousCurrent) {
        await mkdir(this.root, { recursive: false });
        this.record.previousCurrent = previousCurrent;
        await this.write('resolved');
    }

    async write(phase) {
        this.record.phase = phase;
        await writeFile(this.temporaryPath, `${JSON.stringify(this.record, null, 4)}\n`, { flag: 'wx' });
        await rename(this.temporaryPath, this.path);
    }

    async cleanup() {
        await rm(this.root, { recursive: true, force: true });
    }
}
