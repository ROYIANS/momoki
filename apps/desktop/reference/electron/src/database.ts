import {DatabaseSync} from 'node:sqlite';
import type {Asset, AssetReference, Project} from './contracts';
import {
    APPLICATION_ID,
    canonicalRef,
    FORMAT,
    identity,
    integer,
    parseAsset,
    parseProject,
    parseReference,
    record,
    SCHEMA,
    text
} from './contracts';
import type {WorkspaceId} from '@momoki/studio/reference/lib/workspace';
import {workspaceId} from '@momoki/studio/reference/lib/workspace';

const TABLES = [
    'CREATE TABLE workspace_meta (id TEXT PRIMARY KEY, format TEXT NOT NULL, version INTEGER NOT NULL)',
    'CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL)',
    "CREATE TABLE assets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL CHECK(kind IN ('media','output')), name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>0), hash TEXT NOT NULL, path TEXT NOT NULL UNIQUE)",
    'CREATE TABLE asset_references (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), assetId TEXT NOT NULL REFERENCES assets(id), startMs INTEGER NOT NULL CHECK(startMs>=0), durationMs INTEGER NOT NULL CHECK(durationMs>0))',
    'CREATE TABLE pending_imports (op TEXT PRIMARY KEY, intent TEXT NOT NULL)'
];

export interface Intent {
    op: string;
    assetId: string;
    projectId: string;
    stage: string;
    path: string
}

export interface Inventory {
    id: WorkspaceId;
    projects: Project[];
    assets: Asset[];
    references: AssetReference[];
    intents: Intent[]
}

export function configure(db: DatabaseSync): void {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=150;');
}

export function createDatabase(db: DatabaseSync, id: WorkspaceId): void {
    configure(db);
    db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA}; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE`);
    try {
        for (const sql of TABLES) db.exec(sql);
        db.prepare('INSERT INTO workspace_meta VALUES (?,?,?)').run(id, FORMAT, SCHEMA);
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

function scalar(db: DatabaseSync, sql: string, field: string): unknown {
    return db.prepare(sql).get()?.[field];
}

export function inspectDatabase(db: DatabaseSync): Inventory {
    configure(db);
    if (scalar(db, 'PRAGMA application_id', 'application_id') !== APPLICATION_ID || scalar(db, 'PRAGMA user_version', 'user_version') !== SCHEMA) throw new Error('工作区数据库版本不支持');
    if (scalar(db, 'PRAGMA integrity_check', 'integrity_check') !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('工作区数据库完整性失败');
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => text(r.sql, 1000));
    if (JSON.stringify(schema.toSorted()) !== JSON.stringify(TABLES.toSorted())) throw new Error('数据库结构不匹配');
    const rows = db.prepare('SELECT * FROM workspace_meta').all();
    if (rows.length !== 1) throw new Error('工作区身份记录不完整');
    const meta = record(rows[0], ['id', 'format', 'version']);
    const id = workspaceId(text(meta.id, 100));
    if (id === 'browser-local' || meta.format !== FORMAT || meta.version !== SCHEMA) throw new Error('工作区标识/格式无效');
    const projects = db.prepare('SELECT * FROM projects ORDER BY id').all().map(parseProject);
    const assets = db.prepare('SELECT * FROM assets ORDER BY id').all().map(row => {
        const v = record(row, ['id', 'projectId', 'kind', 'name', 'mime', 'size', 'hash', 'path']);
        const ref = canonicalRef(id, identity(v.projectId), identity(v.id));
        if (v.path !== ref.relativePath) throw new Error('数据库素材路径不匹配');
        return parseAsset({
            id: v.id,
            projectId: v.projectId,
            kind: v.kind,
            name: v.name,
            mime: v.mime,
            size: v.size,
            hash: v.hash,
            ref
        }, id);
    });
    const references = db.prepare('SELECT * FROM asset_references ORDER BY id').all().map(parseReference);
    for (const ref of references) if (!assets.some(a => a.id === ref.assetId && a.projectId === ref.projectId)) throw new Error('素材引用归属错误');
    const intents = db.prepare('SELECT * FROM pending_imports ORDER BY op').all().map(row => {
        const v = record(row, ['op', 'intent']);
        const intent = parseIntent(JSON.parse(text(v.intent, 3000)) as unknown, id);
        if (v.op !== intent.op || assets.some(a => a.id === intent.assetId)) throw new Error('恢复记录与完成素材冲突');
        return intent;
    });
    return {id, projects, assets, references, intents};
}

export function parseIntent(value: unknown, id: WorkspaceId): Intent {
    const v = record(value, ['op', 'assetId', 'projectId', 'stage', 'path']);
    const op = text(v.op, 40);
    if (!/^[a-f0-9-]{36}$/u.test(op) || v.stage !== `.staging/${op}`) throw new Error('恢复暂存标识无效');
    const ref = canonicalRef(id, identity(v.projectId), identity(v.assetId));
    if (v.path !== ref.relativePath) throw new Error('恢复目标路径无效');
    return {
        op,
        assetId: identity(v.assetId),
        projectId: identity(v.projectId),
        stage: `.staging/${op}`,
        path: ref.relativePath
    };
}

export function insertAsset(db: DatabaseSync, asset: Asset, reference: AssetReference | undefined, op: string): void {
    db.exec('BEGIN IMMEDIATE');
    try {
        db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?,?)').run(asset.id, asset.projectId, asset.kind, asset.name, asset.mime, asset.size, asset.hash, asset.ref.relativePath);
        if (reference) db.prepare('INSERT INTO asset_references VALUES (?,?,?,?,?)').run(reference.id, reference.projectId, reference.assetId, integer(reference.startMs), integer(reference.durationMs, true));
        db.prepare('DELETE FROM pending_imports WHERE op=?').run(op);
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}
