import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const CREATOR_EXECUTABLE = /CocosCreator(?:\.app\/|\.exe\b| Helper\b)/iu;

/**
 * @description 判断 Cocos Creator 是否正在占用目标工程；无法证明未占用时按占用处理。
 */
export class CreatorOccupancy {
    /**
     * @param {() => Promise<string[]>} [listProcesses] 进程命令行列举实现，测试可注入。
     */
    constructor(listProcesses = listProcessCommandLines) {
        this.listProcesses = listProcesses;
    }

    /**
     * @description 目标工程被 Creator 进程引用时拒绝继续。
     * @param {string[]} projectPaths 工程路径及其 realpath。
     */
    async assertClosed(projectPaths) {
        let commandLines;
        try {
            commandLines = await this.listProcesses();
        } catch {
            throw new Error('cpm_lite_creator_occupancy_unknown');
        }
        if (!Array.isArray(commandLines)) throw new Error('cpm_lite_creator_occupancy_unknown');
        const needles = [...new Set(projectPaths)].map(normalize);
        const occupied = commandLines.some((line) => {
            const normalized = normalize(line);
            return CREATOR_EXECUTABLE.test(line) && needles.some((needle) => containsPath(normalized, needle));
        });
        if (occupied) throw new Error('cpm_lite_creator_project_open');
    }
}

async function listProcessCommandLines() {
    if (process.platform === 'win32') {
        const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }'], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
        return stdout.split(/\r?\n/u);
    }
    const { stdout } = await runFile('ps', ['-axww', '-o', 'command='], { maxBuffer: 64 * 1024 * 1024 });
    return stdout.split('\n');
}

function normalize(value) {
    const slashed = value.replace(/\\/gu, '/').replace(/\/+$/u, '');
    return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

function containsPath(line, projectPath) {
    let index = line.indexOf(projectPath);
    while (index >= 0) {
        const next = line[index + projectPath.length];
        if (next === undefined || next === '/' || next === '"' || next === "'" || /\s/u.test(next)) return true;
        index = line.indexOf(projectPath, index + 1);
    }
    return false;
}
