import {readBinaryBlob} from "../../../platform/storage/binary";
import {binaryByteLength} from "../../../platform/media/binaryTypes";
import type {ProductStore, StoreTable} from "../../../platform/storage/types";
import {db as productDb} from '../../../platform/product/store';
import type {
    LibraryMaterial,
    MaterialEntity,
    MaterialKind,
    MaterialPayload,
    MaterialScope,
    MaterialUse,
    MaterialVersion,
    SettingMaterialKind
} from '../models/materials';
import {remapSlot, slotMediaIds} from '../models/slot';
import {createId, nowIso} from '../../../platform/identity';
import {STUDIO_LIBRARY_ID} from "../models/ownership";
import {mediaDependencyIds, remapMediaRelations} from "../models/mediaRelations";

const tables = (store?: ProductStore) => (db => [db.projects, db.ipProfiles, db.projectIpLinks, db.libraryMaterials, db.materialVersions, db.materialUses, db.materialEvents, db.media, db.characters, db.scenes, db.props, db.styles])(store ?? productDb);
const MAX_FILE_SIZE = 512 * 1024 * 1024;
const MIME_KINDS: Record<string, MaterialKind> = {
    'image/png': 'image',
    'image/jpeg': 'image',
    'image/webp': 'image',
    'image/gif': 'image',
    'image/avif': 'image',
    'video/mp4': 'video',
    'video/webm': 'video',
    'video/quicktime': 'video',
    'audio/mpeg': 'audio',
    'audio/mp3': 'audio',
    'audio/wav': 'audio',
    'audio/x-wav': 'audio',
    'audio/ogg': 'audio',
    'audio/mp4': 'audio',
    'audio/webm': 'audio',
    'audio/flac': 'audio',
    'audio/aac': 'audio',
    'text/plain': 'document',
    'text/markdown': 'document',
    'application/pdf': 'document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
};
const EXT_MIME: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    aac: 'audio/aac',
    txt: 'text/plain',
    md: 'text/markdown',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

function filePayload(blob: Blob, filename: string, mime: string): { kind: MaterialKind; payload: MaterialPayload } {
    if (!blob || !Number.isFinite(blob.size) || blob.size <= 0) throw new Error('文件为空，无法加入素材库');
    if (blob.size > MAX_FILE_SIZE) throw new Error('单个素材文件不能超过 512 MB');
    const extension = filename.split('.').pop()?.toLowerCase() ?? '';
    if (['svg', 'html', 'htm', 'js', 'exe', 'xml'].includes(extension)) throw new Error('不支持此文件格式，请使用图片、视频、音频、TXT、Markdown、PDF 或 DOCX');
    const mimeType = (mime || EXT_MIME[extension] || '').toLowerCase();
    const kind = MIME_KINDS[mimeType.split(";")[0].trim()];
    if (!kind) throw new Error('不支持此文件格式，请使用图片、视频、音频、TXT、Markdown、PDF 或 DOCX');
    return {kind, payload: {type: 'file', blob: blob.slice(0, blob.size, mimeType), filename, mimeType}};
}

function validName(name: string): string {
    if (typeof name !== 'string' || !name.trim() || name.length > 300) throw new Error('请填写 1–300 字的素材名称');
    return name.trim();
}

async function assertScope(scope: MaterialScope, store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    if (scope.kind === 'global') return;
    if (scope.kind === 'ip') {
        const ip = await db.ipProfiles.get(scope.id);
        if (!ip || ip.archived) throw new Error('所属 IP 不存在或已归档，请先恢复 IP');
    } else if (scope.kind === 'project') {
        const project = await db.projects.get(scope.id);
        if (!project || project.archivedAt) throw new Error('所属项目不存在或已归档');
    } else throw new Error('素材归属无效');
}

async function activeMaterial(id: string, expectedRevision?: number, store?: ProductStore): Promise<LibraryMaterial> {
    const db = store ?? productDb;
    const material = await db.libraryMaterials.get(id);
    if (!material) throw new Error('素材不存在');
    if (material.archived) throw new Error('素材已归档，请先恢复');
    if (expectedRevision !== undefined && material.revision !== expectedRevision) throw new Error('素材已更新，请重新加载后再操作');
    await assertScope(material.scope, db);
    return material;
}

async function versionOf(material: LibraryMaterial, store?: ProductStore): Promise<MaterialVersion> {
    const db = store ?? productDb;
    const version = await db.materialVersions.where('[materialId+revision]').equals([material.id, material.revision]).first();
    if (!version) throw new Error('素材版本缺失，无法继续操作');
    return version;
}

async function event(materialId: string, action: string, detail = '', store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    await db.materialEvents.add({id: createId('mev'), materialId, action, detail, createdAt: nowIso()});
}

async function insertMaterial(name: string, kind: MaterialKind, scope: MaterialScope, payload: MaterialPayload, source?: LibraryMaterial['source'], metadata?: Pick<LibraryMaterial, 'notes' | 'tags'>, store?: ProductStore): Promise<LibraryMaterial> {
    const db = store ?? productDb;
    await assertScope(scope, db);
    const at = nowIso();
    const material: LibraryMaterial = {
        id: createId('mat'),
        name: validName(name),
        kind,
        scope: structuredClone(scope),
        revision: 1,
        archived: false,
        notes: metadata?.notes ?? '',
        tags: [...(metadata?.tags ?? [])],
        source,
        createdAt: at,
        updatedAt: at
    };
    await db.libraryMaterials.add(material);
    await db.materialVersions.add({id: createId('mvr'), materialId: material.id, revision: 1, payload, createdAt: at});
    await event(material.id, source ? 'promote' : 'create', undefined, db);
    return material;
}

async function nextVersion(material: LibraryMaterial, payload: MaterialPayload, patch: Partial<Pick<LibraryMaterial, 'name' | 'notes' | 'tags'>> = {}, store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    const at = nowIso();
    const revision = material.revision + 1;
    await db.materialVersions.add({id: createId('mvr'), materialId: material.id, revision, payload, createdAt: at});
    await db.libraryMaterials.put({...material, ...patch, revision, updatedAt: at});
    await event(material.id, 'version', `v${revision}`, db);
}

function settingTable(kind: SettingMaterialKind, store?: ProductStore): StoreTable<MaterialEntity> {
    const db = store ?? productDb;
    return (kind === 'character' ? db.characters : kind === 'scene' ? db.scenes : kind === 'prop' ? db.props : db.styles) as StoreTable<MaterialEntity>;
}

function isSetting(kind: MaterialKind | 'media'): kind is SettingMaterialKind {
    return ['character', 'scene', 'prop', 'style'].includes(kind);
}

async function snapshotSetting(kind: SettingMaterialKind, entityId: string, store?: ProductStore): Promise<Extract<MaterialPayload, {
    type: 'setting'
}>> {
    const db = store ?? productDb;
    const entity = await settingTable(kind, db).get(entityId);
    if (!entity) throw new Error('来源设定不存在');
    if (entity.projectId !== STUDIO_LIBRARY_ID && !await db.projects.get(entity.projectId)) throw new Error('来源项目不存在');
    const media = [];
    const ids = new Set<string>();
    for (const slot of Object.values(entity.slots)) if (slot) {
        for (const id of slotMediaIds(slot)) ids.add(id);
        for (const [kindExpected, references] of [['image', slot.referenceImageIds], ['video', slot.referenceVideoIds], ...(slot.result ? [[slot.result.kind, [slot.result.mediaId]]] : [])] as Array<[string, string[]]>) {
            for (const id of references) {
                const item = await db.media.get(id);
                if (!item || item.projectId !== entity.projectId) throw new Error('来源设定引用的素材缺失或不属于同一项目');
                if (filePayload(await db.waitFor(readBinaryBlob(item.blob)), item.filename, item.mimeType).kind !== kindExpected) throw new Error('来源设定素材类型与槽位不一致');
            }
        }
    }
    const sourceMedia = await db.media.where("projectId").equals(entity.projectId).toArray();
    for (const id of mediaDependencyIds(ids, sourceMedia)) {
        const item = sourceMedia.find(record => record.id === id);
        if (!item) throw new Error('来源设定引用的素材缺失');
        media.push({
            ...item,
            blob: (await db.waitFor(readBinaryBlob(item.blob))).slice(0, binaryByteLength(item.blob), item.mimeType)
        });
    }
    return {type: 'setting', kind, entity: structuredClone(entity), media};
}

export async function createFileMaterial(file: File, scope: MaterialScope, name?: string, store?: ProductStore): Promise<LibraryMaterial> {
    const db = store ?? productDb;
    const {kind, payload} = filePayload(file, file.name, file.type);
    return db.transaction('rw', tables(db), async (db) => await insertMaterial(name ?? file.name, kind, scope, payload, undefined, undefined, db));
}

export async function promoteLegacyMaterial(kind: MaterialKind | 'media', entityId: string, scope: MaterialScope, store?: ProductStore): Promise<LibraryMaterial> {
    const db = store ?? productDb;
    return db.transaction('rw', tables(db), async (db) => {
        if (isSetting(kind)) {
            const payload = await snapshotSetting(kind, entityId, db);
            return insertMaterial(payload.entity.name, kind, scope, payload, {
                projectId: payload.entity.projectId,
                entityId
            }, undefined, db);
        }
        const media = await db.media.get(entityId);
        if (!media) throw new Error('来源素材不存在');
        if (media.derivative) throw new Error('视频缩略图不能作为独立素材保存，请选择来源视频');
        if (media.projectId !== STUDIO_LIBRARY_ID && !await db.projects.get(media.projectId)) throw new Error('来源项目不存在');
        const parsed = filePayload(await db.waitFor(readBinaryBlob(media.blob)), media.filename, media.mimeType);
        if (kind !== 'media' && kind !== parsed.kind) throw new Error('来源素材类型不匹配');
        if (media.thumbnailMediaId && parsed.payload.type === 'file') {
            const records = await db.media.where('projectId').equals(media.projectId).toArray();
            const ids = mediaDependencyIds([media.id], records);
            parsed.payload.sourceMediaId = media.id;
            parsed.payload.media = [];
            for (const item of records.filter(record => ids.has(record.id))) parsed.payload.media.push({...item,
                blob: item.id === media.id ? parsed.payload.blob : await db.waitFor(readBinaryBlob(item.blob))});
        }
        return insertMaterial(media.filename, parsed.kind, scope, parsed.payload, {
            projectId: media.projectId,
            entityId
        }, undefined, db);
    });
}

/**
 * Keeps a generated image/video as a project material. The same media is kept once: asking again returns the
 * material already made from it. The media is marked retained so it outlives the generation history.
 */
export async function adoptGeneratedMedia(projectId: string, mediaId: string, name: string | undefined, store?: ProductStore): Promise<LibraryMaterial> {
    const db = store ?? productDb;
    return db.transaction('rw', tables(db), async (db) => {
        const media = await db.media.get(mediaId);
        if (!media || media.projectId !== projectId) throw new Error('生成结果素材不存在或不属于该项目');
        if (!media.mimeType.startsWith('image/') && !media.mimeType.startsWith('video/')) throw new Error('只能把图片或视频保存为生成素材');
        const existing = (await db.libraryMaterials.toArray()).find(item => !item.archived && item.scope.kind === 'project' && item.scope.id === projectId
            && item.source?.projectId === projectId && item.source.entityId === mediaId);
        if (existing) return existing;
        const material = await promoteLegacyMaterial('media', mediaId, {kind: 'project', id: projectId}, db);
        const label = name?.trim();
        if (label && label !== material.name) await db.libraryMaterials.put({...material, name: validName(label.slice(0, 120))});
        await db.media.update(mediaId, {libraryRetained: true});
        return (await db.libraryMaterials.get(material.id))!;
    });
}

export async function promoteMaterial(id: string, scope: MaterialScope, store?: ProductStore): Promise<LibraryMaterial> {
    const db = store ?? productDb;
    return db.transaction('rw', tables(db), async (db) => {
        const material = await activeMaterial(id, undefined, db);
        const version = await versionOf(material, db);
        return insertMaterial(material.name, material.kind, scope, version.payload, {
            materialId: id,
            revision: material.revision
        }, material, db);
    });
}

export async function addFileMaterialVersion(id: string, file: File, expectedRevision: number, store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    const parsed = filePayload(file, file.name, file.type);
    await db.transaction('rw', tables(db), async (db) => {
        const material = await activeMaterial(id, expectedRevision, db);
        if (material.kind !== parsed.kind) throw new Error('新版本必须与原素材属于同一类型');
        await nextVersion(material, parsed.payload, undefined, db);
    });
}

export async function refreshSettingMaterial(id: string, expectedRevision: number, store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    await db.transaction('rw', tables(db), async (db) => {
        const material = await activeMaterial(id, expectedRevision, db);
        if (!isSetting(material.kind) || !material.source?.entityId) throw new Error('此素材没有可刷新版本的来源设定');
        const payload = await snapshotSetting(material.kind, material.source.entityId, db);
        if (payload.entity.projectId !== material.source.projectId) throw new Error('来源设定归属已变化');
        await nextVersion(material, payload, undefined, db);
    });
}

export async function updateMaterialMetadata(id: string, patch: Partial<Pick<LibraryMaterial, 'name' | 'notes' | 'tags'>>, expectedRevision: number, store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    const safe: typeof patch = {};
    if (patch.name !== undefined) safe.name = validName(patch.name);
    if (patch.notes !== undefined) {
        if (typeof patch.notes !== 'string' || patch.notes.length > 20_000) throw new Error('素材备注过长');
        safe.notes = patch.notes;
    }
    if (patch.tags !== undefined) {
        if (!Array.isArray(patch.tags) || patch.tags.length > 50 || patch.tags.some(tag => typeof tag !== 'string' || tag.length > 100)) throw new Error('标签无效或过长');
        safe.tags = [...new Set(patch.tags.map(tag => tag.trim()).filter(Boolean))];
    }
    await db.transaction('rw', tables(db), async (db) => {
        const material = await activeMaterial(id, expectedRevision, db);
        await nextVersion(material, (await versionOf(material, db)).payload, safe, db);
    });
}

export async function setMaterialArchived(id: string, archived: boolean, store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    await db.transaction('rw', tables(db), async (db) => {
        const material = await db.libraryMaterials.get(id);
        if (!material) throw new Error('素材不存在');
        if (material.archived === archived) return;
        if (!archived) await assertScope(material.scope, db);
        await nextVersion(material, (await versionOf(material, db)).payload, undefined, db);
        await db.libraryMaterials.update(id, {archived});
        await event(id, archived ? 'archive' : 'restore', undefined, db);
    });
}

export async function deleteMaterial(id: string, store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    await db.transaction('rw', tables(db), async (db) => {
        const material = await db.libraryMaterials.get(id);
        if (!material) throw new Error('素材不存在');
        if (!material.archived) throw new Error('请先归档素材，再彻底删除');
        if (await db.materialUses.where('materialId').equals(id).count()) throw new Error('素材仍被项目使用，无法彻底删除');
        if (await db.libraryMaterials.filter(item => item.source?.materialId === id).count()) throw new Error('素材仍是其他素材的来源，无法彻底删除');
        await db.materialVersions.where('materialId').equals(id).delete();
        await db.libraryMaterials.delete(id);
        await event(id, 'delete', material.name, db);
    });
}

function fingerprint(entity: MaterialEntity): string {
    // Stable sorting prevents incidental key order from looking like an authored edit.
    const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
    return JSON.stringify(stable(entity));
}

async function assertProjectScope(material: LibraryMaterial, projectId: string, store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    if (material.scope.kind === 'global') return;
    if (material.scope.kind === 'project') {
        if (material.scope.id !== projectId) throw new Error('项目专属素材只能用于所属项目，请先明确加入通用或 IP 素材');
        return;
    }
    const link = await db.projectIpLinks.get(projectId);
    if (link?.ipId !== material.scope.id) throw new Error('IP 专属素材只能用于关联同一 IP 的项目');
}

async function adopt(material: LibraryMaterial, projectId: string, store?: ProductStore): Promise<MaterialUse> {
    const db = store ?? productDb;
    await assertProjectScope(material, projectId, db);
    const project = await db.projects.get(projectId);
    if (!project || project.archivedAt) throw new Error('目标项目不存在或已归档');
    const version = await versionOf(material, db);
    const at = nowIso();
    const use: MaterialUse = {
        id: createId('mus'),
        materialId: material.id,
        revision: material.revision,
        projectId,
        targetKind: 'media',
        targetId: '',
        mediaIds: [],
        createdAt: at,
        updatedAt: at
    };
    const payload = version.payload;
    if (payload.type === 'file') {
        filePayload(await db.waitFor(readBinaryBlob(payload.blob)), payload.filename, payload.mimeType);
        if (payload.sourceMediaId && payload.media) {
            const source = payload.media.find(item => item.id === payload.sourceMediaId);
            if (!source || source.filename !== payload.filename || source.mimeType !== payload.mimeType || source.derivative) throw new Error('素材来源快照不匹配');
            const ids = mediaDependencyIds([source.id], payload.media);
            if (ids.size !== payload.media.length) throw new Error('素材来源快照包含无关文件');
            const map = new Map(payload.media.map(item => [item.id, createId('med')]));
            use.targetId = map.get(source.id)!;
            use.mediaIds = [...map.values()];
            for (const item of payload.media) {
                filePayload(await db.waitFor(readBinaryBlob(item.blob)), item.filename, item.mimeType);
                await db.media.add({...remapMediaRelations(item, map, projectId), libraryRetained: !item.derivative});
            }
        } else {
            if (payload.sourceMediaId || payload.media) throw new Error('素材来源快照不完整');
            use.targetId = createId('med');
            use.mediaIds = [use.targetId];
            await db.media.add({
            id: use.targetId,
            projectId,
            libraryRetained: true,
            blob: payload.blob,
            filename: payload.filename,
            mimeType: payload.mimeType
            });
        }
    } else {
        const map = new Map<string, string>();
        for (const item of payload.media) map.set(item.id, createId('med'));
        mediaDependencyIds(payload.media.map(item => item.id), payload.media);
        for (const item of payload.media) {
            const id = map.get(item.id)!;
            filePayload(await db.waitFor(readBinaryBlob(item.blob)), item.filename, item.mimeType);
            await db.media.add({...remapMediaRelations(item, map, projectId), libraryRetained: !item.derivative});
            use.mediaIds.push(id);
        }
        for (const slot of Object.values(payload.entity.slots)) for (const id of slotMediaIds(slot)) if (!map.has(id)) throw new Error('素材版本包含缺失的图片或视频');
        const prefixes = {character: 'chr', scene: 'scn', prop: 'prp', style: 'sty'};
        const entity: MaterialEntity = {
            ...structuredClone(payload.entity),
            id: createId(prefixes[payload.kind]),
            projectId,
            createdAt: at,
            updatedAt: at,
            slots: Object.fromEntries(Object.entries(payload.entity.slots).filter(([, slot]) => slot).map(([key, slot]) => [key, remapSlot(slot, id => id ? map.get(id) : undefined)])),
            extra: {...payload.entity.extra, sourceMaterialId: material.id, sourceMaterialRevision: material.revision}
        };
        await settingTable(payload.kind, db).add(entity);
        use.targetId = entity.id;
        use.targetKind = payload.kind;
        use.targetFingerprint = fingerprint(entity);
    }
    await db.materialUses.add(use);
    await db.projects.update(projectId, {updatedAt: at});
    await event(material.id, 'use', projectId, db);
    return use;
}

export async function adoptMaterialInProject(id: string, projectId: string, store?: ProductStore): Promise<MaterialUse> {
    const db = store ?? productDb;
    return db.transaction('rw', tables(db), async (db) => {
        const material = await activeMaterial(id, undefined, db);
        await assertProjectScope(material, projectId, db);
        const project = await db.projects.get(projectId);
        if (!project || project.archivedAt) throw new Error('目标项目不存在或已归档');
        const existing = await db.materialUses.where('[materialId+projectId]').equals([id, projectId]).filter(use => use.revision === material.revision && !use.supersededBy).toArray();
        for (const use of existing) {
            const target = use.targetKind === 'media' ? await db.media.get(use.targetId) : await settingTable(use.targetKind, db).get(use.targetId);
            if (target?.projectId === projectId) return use;
        }
        return adopt(material, projectId, db);
    });
}

export async function updateMaterialUse(useId: string, store?: ProductStore): Promise<MaterialUse> {
    const db = store ?? productDb;
    return db.transaction('rw', tables(db), async (db) => {
        const use = await db.materialUses.get(useId);
        if (!use) throw new Error('素材使用记录不存在');
        if (use.supersededBy) throw new Error('此使用记录已有更新，请选择最新记录');
        const material = await activeMaterial(use.materialId, undefined, db);
        await assertProjectScope(material, use.projectId, db);
        const project = await db.projects.get(use.projectId);
        if (!project || project.archivedAt) throw new Error('目标项目不存在或已归档');
        if (use.revision === material.revision) {
            const target = use.targetKind === 'media' ? await db.media.get(use.targetId) : await settingTable(use.targetKind, db).get(use.targetId);
            if (!target || target.projectId !== use.projectId) throw new Error('项目内的素材副本已删除或归属变化，请重新加入项目');
            return use;
        }
        if (use.targetKind !== 'media') {
            const entity = await settingTable(use.targetKind, db).get(use.targetId);
            if (!entity || entity.projectId !== use.projectId) throw new Error('项目内的设定已删除或归属变化');
            if (fingerprint(entity) !== use.targetFingerprint) throw new Error('项目内的设定已有本地修改，不能更新。请另行加入新版本以保留修改');
        }
        const next = await adopt(material, use.projectId, db);
        await db.materialUses.put({...use, supersededBy: next.id, updatedAt: nowIso()});
        await event(material.id, 'update-use', `${use.revision} → ${next.revision}`, db);
        return next;
    });
}
