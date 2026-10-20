import {randomUUID} from 'node:crypto';
import {backup as sqliteBackup, DatabaseSync} from 'node:sqlite';
import {lstat, open, unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname, join} from 'node:path';
import type {WorkspaceId} from '@momoki/studio/reference/lib/workspace';
import {workspaceId} from '@momoki/studio/reference/lib/workspace';
import type {Asset, AssetReference, BackupManifest, ImportRequest, Project, WorkspaceState} from './contracts';
import {
    BACKUP_MANIFEST,
    canonicalRef,
    COMPLETE,
    FORMAT,
    parseBackup,
    parseImport,
    parseProject,
    record,
    SCHEMA
} from './contracts';
import type {Intent, Inventory} from './database';
import {configure, createDatabase, insertAsset, inspectDatabase} from './database';
import {
    aborted,
    absent,
    copyOwned,
    existingRoot,
    flushDirectory,
    hashFile,
    openOwned,
    ownedPath,
    publish,
    readJson,
    removeOwned,
    reserveRoot,
    stream,
    writeAtomic
} from './nativePaths';

export type Failpoint =
    'intent'
    | 'chunk'
    | 'verified'
    | 'linked'
    | 'published'
    | 'beforeCommit'
    | 'committed'
    | 'backupSnapshot'
    | 'backupBeforeComplete'
    | 'backupComplete'
    | 'restoreBeforeComplete';

export interface InternalHooks {
    at?(point: Failpoint): Promise<void> | void
}

async function validateJournals(root: string): Promise<void> {
    for (const path of ['workspace.sqlite', 'workspace.sqlite-journal', 'workspace.sqlite-wal', 'workspace.sqlite-shm', 'writer.sqlite', 'writer.sqlite-journal']) await ownedPath(root, path, 'file');
}

async function createEmpty(root: string, path: string): Promise<void> {
    const h = await openOwned(root, path, true);
    try {
        await h.sync();
    } finally {
        await h.close();
    }
    await flushDirectory(root);
}

function sameSizeHash(actual: { size: number; hash: string }, expected: { size: number; hash: string }): void {
    if (actual.size !== expected.size || actual.hash !== expected.hash) throw new Error('素材或数据库校验失败');
}

function marker(id: WorkspaceId): object {
    return {format: FORMAT, schema: SCHEMA, workspaceId: id};
}

async function validateMarker(root: string, id?: WorkspaceId): Promise<WorkspaceId> {
    const v = record(await readJson(root, COMPLETE), ['format', 'schema', 'workspaceId']);
    if (v.format !== FORMAT || v.schema !== SCHEMA || typeof v.workspaceId !== 'string') throw new Error('工作区未完成或版本不支持');
    const wid = workspaceId(v.workspaceId);
    if (wid === 'browser-local' || (id !== undefined && wid !== id)) throw new Error('工作区身份不匹配');
    return wid;
}

async function lockWriter(root: string): Promise<DatabaseSync> {
    await validateJournals(root);
    const path = await ownedPath(root, 'writer.sqlite', 'file');
    try {
        await lstat(path);
    } catch (error) {
        if (!absent(error)) throw error;
        await createEmpty(root, 'writer.sqlite');
    }
    const db = new DatabaseSync(path);
    try {
        db.exec('PRAGMA busy_timeout=150; BEGIN EXCLUSIVE');
        return db;
    } catch (error) {
        db.close();
        throw new Error('工作区正在由另一个进程使用', {cause: error});
    }
}

async function recoverIntent(root: string, db: DatabaseSync, intent: Intent): Promise<void> {
    // A SIGKILL can leave the exclusive publication's own two-link pair.
    // Only this exact same-inode, intent-derived pair is allowed to detach.
    const paths = [join(root, intent.stage), join(root, intent.path)];
    const stats = await Promise.all(paths.map(async path => {
        try {
            return await lstat(path);
        } catch (error) {
            if (absent(error)) return undefined;
            throw error;
        }
    }));
    const [stage, final] = stats;
    if (stage?.nlink === 2 || final?.nlink === 2) {
        if (!stage?.isFile() || !final?.isFile() || stage.ino !== final.ino || stage.dev !== final.dev || stage.nlink !== 2 || final.nlink !== 2) throw new Error('未完成导入含外部硬链接');
        await ownedPath(root, intent.stage, 'file', false, true);
        await ownedPath(root, intent.path, 'file', false, true);
        await unlink(paths[0]);
        await flushDirectory(dirname(paths[0]));
    }
    await removeOwned(root, intent.stage);
    await removeOwned(root, intent.path);
    db.prepare('DELETE FROM pending_imports WHERE op=?').run(intent.op);
}

async function snapshotInventory(root: string): Promise<Inventory> {
    const path = await ownedPath(root, 'workspace.sqlite', 'file');
    const db = new DatabaseSync(path, {readOnly: true});
    try {
        return inspectDatabase(db);
    } finally {
        db.close();
    }
}

async function verifyBackup(root: string, signal?: AbortSignal): Promise<{
    manifest: BackupManifest;
    inventory: Inventory
}> {
    const manifest = parseBackup(await readJson(root, BACKUP_MANIFEST));
    sameSizeHash(await hashFile(root, 'workspace.sqlite', signal), manifest.database);
    const inventory = await snapshotInventory(root);
    if (inventory.id !== manifest.workspaceId || inventory.intents.length) throw new Error('备份身份或未完成导入无效');
    const closure = inventory.assets.map(a => ({id: a.id, path: a.ref.relativePath, size: a.size, hash: a.hash}));
    const sorted = (entries: BackupManifest['assets']) => [...entries].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (JSON.stringify(sorted(closure)) !== JSON.stringify(sorted(manifest.assets))) throw new Error('备份素材清单不完整');
    for (const a of manifest.assets) sameSizeHash(await hashFile(root, a.path, signal), a);
    return {manifest, inventory};
}

export class NativeWorkspace {
    private tail: Promise<unknown> = Promise.resolve();
    private closing = false;
    private closed = false;

    private constructor(readonly root: string, readonly id: WorkspaceId, private readonly db: DatabaseSync, private readonly writer: DatabaseSync, private readonly hooks: InternalHooks) {
    }

    static async create(input: string, hooks: InternalHooks = {}): Promise<NativeWorkspace> {
        const root = await reserveRoot(input);
        const id = workspaceId(randomUUID());
        const writer = await lockWriter(root);
        let db: DatabaseSync | undefined;
        try {
            await createEmpty(root, 'workspace.sqlite');
            db = new DatabaseSync(join(root, 'workspace.sqlite'));
            createDatabase(db, id);
            await writeAtomic(root, COMPLETE, marker(id));
            return new NativeWorkspace(root, id, db, writer, hooks);
        } catch (error) {
            db?.close();
            writer.close();
            throw error;
        }
    }

    static async open(input: string, hooks: InternalHooks = {}): Promise<NativeWorkspace> {
        const root = await existingRoot(input);
        const expected = await validateMarker(root);
        const writer = await lockWriter(root);
        let db: DatabaseSync | undefined;
        try {
            await validateJournals(root);
            const path = await ownedPath(root, 'workspace.sqlite', 'file');
            // readOnly inspection ensures missing/corrupt DB is never initialized on reopen.
            const before = await snapshotInventory(root);
            if (before.id !== expected) throw new Error('工作区数据库身份不匹配');
            db = new DatabaseSync(path);
            configure(db);
            db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL');
            for (const intent of before.intents) await recoverIntent(root, db, intent);
            inspectDatabase(db);
            return new NativeWorkspace(root, expected, db, writer, hooks);
        } catch (error) {
            db?.close();
            writer.close();
            throw error;
        }
    }

    static async restore(backupPath: string, destination: string, signal?: AbortSignal, hooks: InternalHooks = {}): Promise<string> {
        const backupRoot = await existingRoot(backupPath);
        const {manifest} = await verifyBackup(backupRoot, signal);
        aborted(signal);
        const root = await reserveRoot(destination);
        sameSizeHash(await copyOwned(backupRoot, 'workspace.sqlite', root, 'workspace.sqlite', signal), manifest.database);
        for (const a of manifest.assets) sameSizeHash(await copyOwned(backupRoot, a.path, root, a.path, signal), a);
        const data = await snapshotInventory(root);
        if (data.id !== manifest.workspaceId || data.intents.length) throw new Error('恢复数据不完整');
        await hooks.at?.('restoreBeforeComplete');
        aborted(signal);
        await writeAtomic(root, COMPLETE, marker(data.id));
        return root;
    }

    saveProject(input: Project): Promise<Project> {
        const value = parseProject(input); // snapshot before queue admission
        return this.enqueue(async () => {
            await validateJournals(this.root);
            this.db.prepare('INSERT INTO projects VALUES (?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title').run(value.id, value.title);
            return {...value};
        });
    }

    state(): Promise<WorkspaceState> {
        return this.enqueue(async () => {
            await validateMarker(this.root, this.id);
            await validateJournals(this.root);
            const data = inspectDatabase(this.db);
            const assets: WorkspaceState['assets'] = [];
            for (const a of data.assets) {
                let availability: 'present' | 'missing' | 'corrupt' = 'present';
                try {
                    sameSizeHash(await hashFile(this.root, a.ref.relativePath), a);
                } catch (error) {
                    availability = absent(error) ? 'missing' : 'corrupt';
                }
                assets.push({...a, availability});
            }
            return {workspaceId: this.id, projects: data.projects, assets, references: data.references};
        });
    }

    importFile(sourcePath: string, request: ImportRequest, signal?: AbortSignal): Promise<Asset> {
        const metadata = parseImport(request);
        const source = sourcePath;
        const operationSignal = signal;
        return this.enqueue(async () => {
            aborted(operationSignal);
            await validateJournals(this.root);
            if (!this.db.prepare('SELECT id FROM projects WHERE id=?').get(metadata.projectId)) throw new Error('素材所属项目不存在');
            const assetId = metadata.id ?? randomUUID();
            const ref = canonicalRef(this.id, metadata.projectId, assetId);
            if (this.db.prepare('SELECT id FROM assets WHERE id=?').get(assetId)) throw new Error('素材标识已存在');
            const target = await ownedPath(this.root, ref.relativePath, 'file', true);
            try {
                await lstat(target);
                throw new Error('素材目标已存在');
            } catch (error) {
                if (!absent(error)) throw error;
            }
            const op = randomUUID();
            const intent: Intent = {
                op,
                assetId,
                projectId: metadata.projectId,
                stage: `.staging/${op}`,
                path: ref.relativePath
            };
            this.db.prepare('INSERT INTO pending_imports VALUES (?,?)').run(op, JSON.stringify(intent));
            let committed = false;
            try {
                await this.point('intent');
                aborted(operationSignal);
                const from = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
                let copied: { size: number; hash: string };
                try {
                    const to = await openOwned(this.root, intent.stage, true);
                    try {
                        copied = await stream(from, to, operationSignal, async () => {
                            await this.point('chunk');
                        });
                    } finally {
                        await to.close();
                    }
                } finally {
                    await from.close();
                }
                await this.point('verified');
                aborted(operationSignal);
                await publish(this.root, intent.stage, intent.path, async () => {
                    await this.point('linked');
                });
                await this.point('published');
                aborted(operationSignal);
                await validateJournals(this.root);
                sameSizeHash(await hashFile(this.root, intent.path, operationSignal), copied);
                const asset: Asset = {
                    id: assetId,
                    projectId: metadata.projectId,
                    kind: metadata.kind,
                    name: metadata.name,
                    mime: metadata.mime, ...copied,
                    ref
                };
                const reference: AssetReference | undefined = metadata.reference && {
                    ...metadata.reference,
                    projectId: metadata.projectId,
                    assetId
                };
                await this.point('beforeCommit');
                aborted(operationSignal);
                insertAsset(this.db, asset, reference, op);
                committed = true;
                // No cancellation check after the actual SQLite COMMIT.
                await this.point('committed');
                return asset;
            } catch (error) {
                if (!committed) {
                    try {
                        await recoverIntent(this.root, this.db, intent);
                    } catch (cleanup) {
                        throw new AggregateError([error, cleanup], '导入失败，恢复清理需要检查');
                    }
                }
                throw error;
            }
        });
    }

    backup(destination: string, signal?: AbortSignal): Promise<string> {
        const target = destination;
        const operationSignal = signal;
        return this.enqueue(async () => {
            aborted(operationSignal);
            await validateJournals(this.root);
            const initial = inspectDatabase(this.db);
            if (initial.intents.length) throw new Error('未完成恢复不能备份');
            const root = await reserveRoot(target);
            await createEmpty(root, 'workspace.sqlite');
            await sqliteBackup(this.db, join(root, 'workspace.sqlite'));
            const snapshot = await snapshotInventory(root);
            if (snapshot.id !== this.id || snapshot.intents.length) throw new Error('备份数据库身份错误');
            await this.point('backupSnapshot');
            aborted(operationSignal);
            for (const a of snapshot.assets) sameSizeHash(await copyOwned(this.root, a.ref.relativePath, root, a.ref.relativePath, operationSignal), a);
            const database = await hashFile(root, 'workspace.sqlite', operationSignal);
            const manifest: BackupManifest = {
                format: 'momoki.native-backup.v1', schema: 1, workspaceId: this.id, database,
                assets: snapshot.assets.map(a => ({id: a.id, path: a.ref.relativePath, size: a.size, hash: a.hash}))
            };
            await this.point('backupBeforeComplete');
            aborted(operationSignal);
            await writeAtomic(root, BACKUP_MANIFEST, manifest);
            await this.point('backupComplete'); // final publication is authoritative
            return root;
        });
    }

    close(): Promise<void> {
        if (this.closing || this.closed) return Promise.reject(new Error('工作区已关闭或正在关闭'));
        this.closing = true;
        const result = this.tail.then(() => {
            this.db.close();
            this.writer.close();
            this.closed = true;
        });
        this.tail = result;
        return result;
    }

    private enqueue<T>(fn: () => Promise<T>): Promise<T> {
        if (this.closing || this.closed) return Promise.reject(new Error('工作区已关闭或正在关闭'));
        const result = this.tail.then(fn);
        this.tail = result.catch(() => undefined);
        return result;
    }

    private async point(point: Failpoint): Promise<void> {
        await this.hooks.at?.(point);
    }
}
