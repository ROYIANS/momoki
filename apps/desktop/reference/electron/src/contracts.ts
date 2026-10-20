import type {WorkspaceId, WorkspaceRef} from '@momoki/studio/reference/lib/workspace';
import {mediaWorkspaceRef, resolveWorkspaceRef, workspaceId} from '@momoki/studio/reference/lib/workspace';

export const FORMAT = 'momoki.native-prototype.v1';
export const SCHEMA = 1;
export const APPLICATION_ID = 0x43555031;
export const CHUNK = 256 * 1024;
export const COMPLETE = 'workspace.complete.json';
export const BACKUP_MANIFEST = 'backup.complete.json';

export interface Project {
    id: string;
    title: string
}

export interface Asset {
    id: string;
    projectId: string;
    kind: 'media' | 'output';
    name: string;
    mime: string;
    size: number;
    hash: string;
    ref: WorkspaceRef;
}

export interface AssetReference {
    id: string;
    projectId: string;
    assetId: string;
    startMs: number;
    durationMs: number
}

export interface WorkspaceState {
    workspaceId: WorkspaceId;
    projects: Project[];
    assets: (Asset & { availability: 'present' | 'missing' | 'corrupt' })[];
    references: AssetReference[];
}

export interface ImportRequest {
    id?: string;
    projectId: string;
    kind: 'media' | 'output';
    name: string;
    mime: string;
    reference?: { id: string; startMs: number; durationMs: number };
}

export interface BackupManifest {
    format: 'momoki.native-backup.v1';
    schema: 1;
    workspaceId: WorkspaceId;
    database: { size: number; hash: string };
    assets: { id: string; path: string; size: number; hash: string }[];
}

export type Command =
    | { op: 'getState' | 'createWorkspace' | 'openWorkspace' | 'backup' | 'restore' | 'reopen' }
    | { op: 'saveProject'; project: Project }
    | { op: 'importFile'; projectId: string; kind: 'media' | 'output' };
export type Reply = { ok: true; state: WorkspaceState | null; message: string } | { ok: false; message: string };

export interface PrototypeBridge {
    getState(): Promise<Reply>;

    createWorkspace(): Promise<Reply>;

    openWorkspace(): Promise<Reply>;

    saveProject(project: Project): Promise<Reply>;

    importFile(projectId: string, kind: 'media' | 'output'): Promise<Reply>;

    backup(): Promise<Reply>;

    restore(): Promise<Reply>;

    reopen(): Promise<Reply>;
}

export function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('数据格式无效');
    const v = value as Record<string, unknown>;
    if (Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) throw new Error('数据含未知或缺少字段');
    return v;
}

export function text(value: unknown, max = 300): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('文本字段无效');
    return value;
}

export function integer(value: unknown, positive = false): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new Error('数值字段无效');
    return value;
}

export function digest(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error('校验值无效');
    return value;
}

export function identity(value: unknown): string {
    const id = text(value, 120);
    // The shared owner validates exact UTF-16 and derives lossless components.
    const ref = mediaWorkspaceRef(workspaceId('identity-validation'), id, id);
    portableLength(ref.relativePath);
    return id;
}

export function portableLength(path: string): void {
    if (path.length > 1000 || path.split('/').some(p => p.length > 240)) throw new Error('标识编码后的文件路径过长');
}

export function canonicalRef(id: WorkspaceId, project: string, asset: string): WorkspaceRef {
    const ref = mediaWorkspaceRef(id, identity(project), identity(asset));
    portableLength(ref.relativePath);
    resolveWorkspaceRef(ref, {workspaceId: id, absolutePath: '/validation-root'});
    return ref;
}

export function parseProject(value: unknown): Project {
    const v = record(value, ['id', 'title']);
    return {id: identity(v.id), title: text(v.title)};
}

export function parseAsset(value: unknown, id: WorkspaceId): Asset {
    const v = record(value, ['id', 'projectId', 'kind', 'name', 'mime', 'size', 'hash', 'ref']);
    if (v.kind !== 'media' && v.kind !== 'output') throw new Error('素材种类无效');
    const ref = record(v.ref, ['workspaceId', 'projectId', 'relativePath']);
    const expected = canonicalRef(id, identity(v.projectId), identity(v.id));
    if (ref.workspaceId !== id || ref.projectId !== expected.projectId || ref.relativePath !== expected.relativePath) throw new Error('素材归属与路径不匹配');
    const mime = text(v.mime, 120);
    if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u.test(mime)) throw new Error('文件类型无效');
    return {
        id: identity(v.id),
        projectId: expected.projectId,
        kind: v.kind,
        name: text(v.name),
        mime,
        size: integer(v.size, true),
        hash: digest(v.hash),
        ref: expected
    };
}

export function parseReference(value: unknown): AssetReference {
    const v = record(value, ['id', 'projectId', 'assetId', 'startMs', 'durationMs']);
    return {
        id: identity(v.id),
        projectId: identity(v.projectId),
        assetId: identity(v.assetId),
        startMs: integer(v.startMs),
        durationMs: integer(v.durationMs, true)
    };
}

export function parseImport(value: ImportRequest): ImportRequest {
    const allowed = ['id', 'projectId', 'kind', 'name', 'mime', 'reference'];
    if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error('导入含未知字段');
    const projectId = identity(value.projectId);
    if (value.kind !== 'media' && value.kind !== 'output') throw new Error('素材种类无效');
    const mime = text(value.mime, 120);
    if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u.test(mime)) throw new Error('文件类型无效');
    const reference = value.reference === undefined ? undefined : record(value.reference, ['id', 'startMs', 'durationMs']);
    return {
        id: value.id === undefined ? undefined : identity(value.id),
        projectId,
        kind: value.kind,
        name: text(value.name),
        mime,
        reference: reference && {
            id: identity(reference.id),
            startMs: integer(reference.startMs),
            durationMs: integer(reference.durationMs, true)
        }
    };
}

export function parseCommand(value: unknown): Command {
    if (value === null || typeof value !== 'object' || !('op' in value)) throw new Error('请求无效');
    switch (value.op) {
        case 'getState':
        case 'createWorkspace':
        case 'openWorkspace':
        case 'backup':
        case 'restore':
        case 'reopen':
            record(value, ['op']);
            return {op: value.op};
        case 'saveProject': {
            const v = record(value, ['op', 'project']);
            return {op: 'saveProject', project: parseProject(v.project)};
        }
        case 'importFile': {
            const v = record(value, ['op', 'projectId', 'kind']);
            if (v.kind !== 'media' && v.kind !== 'output') throw new Error('素材种类无效');
            return {op: 'importFile', projectId: identity(v.projectId), kind: v.kind};
        }
        default:
            throw new Error('未知操作');
    }
}

export function parseBackup(value: unknown): BackupManifest {
    const v = record(value, ['format', 'schema', 'workspaceId', 'database', 'assets']);
    if (v.format !== 'momoki.native-backup.v1' || v.schema !== SCHEMA) throw new Error('备份版本不支持');
    const id = workspaceId(text(v.workspaceId, 100));
    if (id === 'browser-local') throw new Error('备份工作区标识无效');
    const database = record(v.database, ['size', 'hash']);
    if (!Array.isArray(v.assets) || v.assets.length > 10000) throw new Error('备份清单无效');
    const seen = new Set<string>();
    const paths = new Set<string>();
    const assets = v.assets.map((item: unknown) => {
        const a = record(item, ['id', 'path', 'size', 'hash']);
        const assetId = identity(a.id);
        const path = text(a.path, 1000);
        if (seen.has(assetId) || paths.has(path) || path.includes('..') || path.startsWith('/') || path.includes('\\')) throw new Error('备份路径或标识重复/无效');
        seen.add(assetId);
        paths.add(path);
        return {id: assetId, path, size: integer(a.size, true), hash: digest(a.hash)};
    });
    return {
        format: 'momoki.native-backup.v1',
        schema: 1,
        workspaceId: id,
        database: {size: integer(database.size, true), hash: digest(database.hash)},
        assets
    };
}
