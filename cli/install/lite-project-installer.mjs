import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { LiteProductCatalog } from '../product-catalog.mjs';
import { CreatorOccupancy } from './creator-occupancy.mjs';
import { LiteProductArchive } from './product-archive.mjs';

const HOST_DIRECTORY = join('extensions', 'peanut-pod-lite-host');
const INDEX_PATH = join('peanut-plugins', 'installed.json');
const LOCK_PATH = join('peanut-plugins', '.installed.lock');
const TRANSACTIONS_PATH = join('peanut-plugins', '.cpm-transactions');
const STALE_LOCK_MS = 120_000;
const ACTIONS = Object.freeze(['install', 'upgrade', 'repair']);

/**
 * @description 对 Creator 工程执行显式 Lite install/upgrade/repair：
 * 校验前失败保持 unchanged；切换后失败尝试恢复并报告 recovered 或 may_have_changed。
 */
export class LiteProjectInstaller {
    /**
     * @param {object} [options]
     * @param {typeof fetch} [options.fetchImpl] Host/Core archive 下载实现。
     * @param {CreatorOccupancy} [options.occupancy] Creator 占用检查。
     * @param {(phase: string) => Promise<void> | void} [options.onPhase] 阶段回调，测试用于故障注入。
     * @param {() => Promise<void> | void} [options.onRecover] 恢复前回调，测试用于模拟恢复失败。
     */
    constructor(options = {}) {
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
        this.occupancy = options.occupancy ?? new CreatorOccupancy();
        this.onPhase = options.onPhase;
        this.onRecover = options.onRecover;
    }

    /**
     * @description 按动作从已验证 catalog 中选择产品并安装到工程。
     * @param {'install' | 'upgrade' | 'repair'} action 项目命令。
     * @param {string} projectPath Creator 工程目录。
     * @param {object} catalog 已由 {@link LiteProductCatalog.parse} 校验的 catalog。
     * @param {string} channel 发行渠道。
     * @returns {Promise<object>} 结构化结果。
     */
    async run(action, projectPath, catalog, channel) {
        if (!ACTIONS.includes(action)) throw new Error('cpm_lite_action_invalid');
        const project = await openProject(projectPath);
        await this.occupancy.assertClosed([projectPath, resolve(projectPath), project.root]);
        const index = await readIndex(project.root);
        const activeVersion = liteEntry(index.value, catalogProductId(catalog))?.activeVersion ?? null;
        const product = selectProduct(action, catalog, channel, activeVersion);
        if (!product.creatorProfiles.includes(project.creatorVersion)) throw new Error('cpm_lite_creator_version_unsupported');
        if (action === 'upgrade' && compareVersions(product.version, activeVersion) < 0) throw new Error('cpm_lite_downgrade_refused');
        if (action === 'install' && activeVersion != null && activeVersion !== product.version) throw new Error('cpm_lite_already_installed');

        const lock = await acquireLock(project.root);
        try {
            if (activeVersion === product.version && await isInstalled(project.root, product)) {
                return result(action, 'unchanged', product, activeVersion);
            }
            if (action === 'install' && activeVersion === product.version) throw new Error('cpm_lite_repair_required');
            return await this.commit(action, project.root, index, product, activeVersion);
        } finally {
            await lock.release();
        }
    }

    /** @description 下载、暂存、原子提交、验证，失败时按阶段恢复。 */
    async commit(action, root, index, product, activeVersion) {
        const transactionId = randomUUID();
        const transactionRoot = join(root, TRANSACTIONS_PATH, transactionId);
        const journalPath = join(transactionRoot, 'journal.json');
        const hostTarget = join(root, HOST_DIRECTORY);
        const coreInstallPath = join('peanut-plugins', 'plugins', product.id, product.version);
        const coreTarget = join(root, coreInstallPath);
        const state = { hostBackedUp: false, hostPlaced: false, coreCreated: false, coreReplaced: false, indexTouched: false };
        const journal = async (phase) => {
            await writeFile(journalPath, `${JSON.stringify({ schemaVersion: 1, transactionId, action, product: { id: product.id, version: product.version }, previousActiveVersion: activeVersion, phase, state }, null, 4)}\n`);
            if (this.onPhase != null) await this.onPhase(phase);
        };
        await mkdir(transactionRoot, { recursive: true });
        try {
            await journal('resolved');
            const hostFiles = LiteProductArchive.verifyHost(product, await LiteProductCatalog.download(product, 'host', this.fetchImpl));
            const coreFiles = LiteProductArchive.verifyCore(product, await LiteProductCatalog.download(product, 'core', this.fetchImpl));
            await journal('downloaded');
            await writeTree(join(transactionRoot, 'host'), hostFiles);
            await writeTree(join(transactionRoot, 'core'), coreFiles);
            await mkdir(join(transactionRoot, 'backup'));
            await journal('staged');
        } catch (error) {
            await rm(transactionRoot, { recursive: true, force: true });
            await removeIfEmpty(join(root, TRANSACTIONS_PATH));
            throw new Error(`cpm_lite_install_unchanged:${messageOf(error)}`);
        }

        try {
            if (await exists(coreTarget)) {
                if (!await isCoreInstalled(coreTarget, product)) {
                    await rename(coreTarget, join(transactionRoot, 'backup', 'core'));
                    state.coreReplaced = true;
                    await rename(join(transactionRoot, 'core'), coreTarget);
                }
            } else {
                await mkdir(dirname(coreTarget), { recursive: true });
                await rename(join(transactionRoot, 'core'), coreTarget);
                state.coreCreated = true;
            }
            if (await exists(hostTarget)) {
                await rename(hostTarget, join(transactionRoot, 'backup', 'host'));
                state.hostBackedUp = true;
            } else {
                await mkdir(dirname(hostTarget), { recursive: true });
            }
            await rename(join(transactionRoot, 'host'), hostTarget);
            state.hostPlaced = true;
            await writeIndex(root, transactionId, nextIndex(index.value, product, coreInstallPath));
            state.indexTouched = true;
            await journal('committed');

            if (!await isInstalled(root, product)) throw new Error('cpm_lite_install_verification_failed');
            await journal('verified');
        } catch (error) {
            const cause = messageOf(error);
            try {
                if (this.onRecover != null) await this.onRecover();
                await recover(root, transactionRoot, index.raw, state, hostTarget, coreTarget);
                await journal('recovered');
            } catch {
                throw new Error(`cpm_lite_install_may_have_changed:${cause}`);
            }
            await rm(transactionRoot, { recursive: true, force: true });
            await removeIfEmpty(join(root, TRANSACTIONS_PATH));
            throw new Error(`cpm_lite_install_recovered:${cause}`);
        }
        await rm(transactionRoot, { recursive: true, force: true });
        await removeIfEmpty(join(root, TRANSACTIONS_PATH));
        const status = { install: 'installed', upgrade: activeVersion === product.version ? 'repaired' : 'upgraded', repair: 'repaired' }[action];
        return result(action, status, product, activeVersion);
    }
}

async function openProject(projectPath) {
    if (typeof projectPath !== 'string' || projectPath.length === 0) throw new Error('cpm_lite_project_invalid');
    let root;
    try {
        root = await realpath(projectPath);
        if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
    } catch {
        throw new Error('cpm_lite_project_invalid');
    }
    let creatorVersion;
    try {
        creatorVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))?.creator?.version;
    } catch {
        throw new Error('cpm_lite_project_invalid');
    }
    if (typeof creatorVersion !== 'string') throw new Error('cpm_lite_project_invalid');
    return { root, creatorVersion };
}

function catalogProductId(catalog) {
    return catalog.products[0]?.id ?? 'peanut.pod-lite';
}

function selectProduct(action, catalog, channel, activeVersion) {
    if (action === 'repair') {
        if (activeVersion == null) throw new Error('cpm_lite_not_installed');
        const product = catalog.products.find((entry) => entry.channel === channel && entry.version === activeVersion);
        if (product == null) throw new Error('cpm_product_unavailable');
        return product;
    }
    if (action === 'upgrade' && activeVersion == null) throw new Error('cpm_lite_not_installed');
    const product = LiteProductCatalog.select(catalog, channel);
    if (product == null) throw new Error('cpm_product_unavailable');
    return product;
}

async function readIndex(root) {
    const path = join(root, INDEX_PATH);
    let raw;
    try {
        const stats = await lstat(path);
        if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('cpm_lite_installed_index_invalid');
        raw = await readFile(path, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return { raw: null, value: { schemaVersion: 2, plugins: [] } };
        throw new Error('cpm_lite_installed_index_invalid');
    }
    let value;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new Error('cpm_lite_installed_index_invalid');
    }
    if (!isValidIndex(value)) throw new Error('cpm_lite_installed_index_invalid');
    return { raw, value };
}

function isValidIndex(value) {
    if (value?.schemaVersion !== 2 || !Array.isArray(value.plugins)) return false;
    const ids = new Set();
    for (const plugin of value.plugins) {
        if (typeof plugin?.pluginId !== 'string' || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(plugin.pluginId) || ids.has(plugin.pluginId) || !Array.isArray(plugin.versions) || 'packagePath' in plugin) return false;
        ids.add(plugin.pluginId);
        const versions = new Set();
        for (const entry of plugin.versions) {
            if (typeof entry?.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(entry.version) || versions.has(entry.version) || entry.installPath !== join('peanut-plugins', 'plugins', plugin.pluginId, entry.version)) return false;
            versions.add(entry.version);
        }
        if (!versions.has(plugin.activeVersion)) return false;
    }
    return true;
}

function liteEntry(index, productId) {
    return index.plugins.find((plugin) => plugin.pluginId === productId);
}

function nextIndex(index, product, installPath) {
    const plugins = index.plugins.map((plugin) => {
        if (plugin.pluginId !== product.id) return plugin;
        const versions = plugin.versions.some((entry) => entry.version === product.version) ? plugin.versions : [...plugin.versions, { version: product.version, installPath }];
        return { ...plugin, activeVersion: product.version, versions };
    });
    if (!plugins.some((plugin) => plugin.pluginId === product.id)) {
        plugins.push({ pluginId: product.id, activeVersion: product.version, versions: [{ version: product.version, installPath }] });
    }
    return { schemaVersion: 2, plugins };
}

async function writeIndex(root, transactionId, index) {
    await writeIndexText(root, transactionId, `${JSON.stringify(index, null, 4)}\n`);
}

async function writeIndexText(root, transactionId, text) {
    const target = join(root, INDEX_PATH);
    const temporary = `${target}.${transactionId}.tmp`;
    await writeFile(temporary, text, { flag: 'wx' });
    await rename(temporary, target);
}

async function acquireLock(root) {
    const path = join(root, LOCK_PATH);
    await mkdir(dirname(path), { recursive: true });
    try {
        await writeFile(path, `${Date.now()}\n`, { flag: 'wx' });
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const stats = await lstat(path);
        if (!stats.isFile() || Date.now() - stats.mtimeMs < STALE_LOCK_MS) throw new Error('cpm_lite_project_locked');
        await rm(path, { force: true });
        try {
            await writeFile(path, `${Date.now()}\n`, { flag: 'wx' });
        } catch {
            throw new Error('cpm_lite_project_locked');
        }
    }
    return { release: () => rm(path, { force: true }) };
}

async function isInstalled(root, product) {
    try {
        const index = await readIndex(root);
        const entry = liteEntry(index.value, product.id);
        return entry?.activeVersion === product.version
            && await isHostInstalled(join(root, HOST_DIRECTORY), product)
            && await isCoreInstalled(join(root, 'peanut-plugins', 'plugins', product.id, product.version), product);
    } catch {
        return false;
    }
}

async function isHostInstalled(path, product) {
    const files = await readTree(path);
    return files != null && LiteProductArchive.packageDigest(files) === product.hostPackageDigest;
}

async function isCoreInstalled(path, product) {
    const files = await readTree(path);
    if (files == null) return false;
    try {
        LiteProductArchive.verifyCoreManifest(product, files, `${product.id}.manifest.json`);
        return true;
    } catch {
        return false;
    }
}

async function recover(root, transactionRoot, previousIndexRaw, state, hostTarget, coreTarget) {
    if (state.indexTouched) {
        if (previousIndexRaw == null) await rm(join(root, INDEX_PATH), { force: true });
        else await writeIndexText(root, `${randomUUID()}.recover`, previousIndexRaw);
    }
    if (state.hostPlaced) await rm(hostTarget, { recursive: true, force: true });
    if (state.hostBackedUp) await rename(join(transactionRoot, 'backup', 'host'), hostTarget);
    if (state.coreCreated) await rm(coreTarget, { recursive: true, force: true });
    if (state.coreReplaced) {
        await rm(coreTarget, { recursive: true, force: true });
        await rename(join(transactionRoot, 'backup', 'core'), coreTarget);
    }
    const restoredIndex = await readOptional(join(root, INDEX_PATH));
    if (restoredIndex !== previousIndexRaw) throw new Error('cpm_lite_recovery_unproven');
    if (state.hostBackedUp !== await exists(hostTarget)) throw new Error('cpm_lite_recovery_unproven');
}

async function writeTree(root, files) {
    for (const [path, content] of files) {
        const target = join(root, ...path.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, { flag: 'wx' });
    }
}

/** @description 读取目录全部普通文件；存在链接或特殊文件时返回 null。忽略 Finder 的 .DS_Store。 */
async function readTree(root) {
    const files = new Map();
    const walk = async (directory, prefix) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (entry.name === '.DS_Store') continue;
            const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
            const absolute = join(directory, entry.name);
            if (entry.isDirectory()) await walk(absolute, relative);
            else if (entry.isFile()) files.set(relative, await readFile(absolute));
            else throw new Error('cpm_lite_tree_invalid');
        }
    };
    try {
        const stats = await lstat(root);
        if (!stats.isDirectory()) return null;
        await walk(root, '');
        return files;
    } catch {
        return null;
    }
}

function result(action, status, product, previousVersion) {
    return Object.freeze({
        schemaVersion: 1,
        action,
        status,
        product: Object.freeze({ id: product.id, version: product.version, channel: product.channel, sourceCommit: product.sourceCommit }),
        previousVersion,
        host: Object.freeze({ path: 'extensions/peanut-pod-lite-host', packageDigest: product.hostPackageDigest }),
        core: Object.freeze({ path: `peanut-plugins/plugins/${product.id}/${product.version}`, packageDigest: product.corePackageDigest }),
    });
}

function compareVersions(left, right) {
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
}

async function exists(path) {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

async function readOptional(path) {
    try {
        return await readFile(path, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

async function removeIfEmpty(path) {
    try {
        await rmdir(path);
    } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY' && error?.code !== 'EEXIST') throw error;
    }
}

function messageOf(error) {
    return error instanceof Error ? error.message : 'cpm_lite_install_failed';
}
