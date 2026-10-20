import {binaryByteLength} from "../../../platform/media/binaryTypes";
import type {ProductStore} from "../../../platform/storage/types";
import {type GenerationSlot} from "../models/slots";
import {createId, type Id} from "../../../platform/identity";
import {type MediaRecord} from "../models/media";
import {db as productDb} from "../../../platform/product/store";
import {collectSlotsMedia, SHOT_PICTURE_FIELDS, slotMediaIds} from "../models/slot";
import {assertProjectOwner, touchProject} from "../../projects/commands/ownership";
import {PRODUCTION_TABLES} from "../../../platform/product/scopes";
import {mediaDependencyIds, remapMediaRelations} from "../models/mediaRelations";

/** Caller supplies the existing media/project transaction and a shared copy map. */
export async function copyMediaDependencies(roots: Iterable<Id>, sourceProjectId: Id, projectId: Id, db: ProductStore, map = new Map<Id, Id>()): Promise<Map<Id, Id>> {
    const records = await db.media.where("projectId").equals(sourceProjectId).toArray();
    const selected = mediaDependencyIds(roots, records);
    const copies: MediaRecord[] = [];
    for (const id of selected) {
        if (map.has(id)) continue;
        const record = records.find(item => item.id === id);
        if (!record) throw new Error("来源素材已失效，请重新选择");
        map.set(id, createId("med"));
        copies.push(record);
    }
    for (const record of copies) await db.media.add(remapMediaRelations(record, map, projectId));
    return map;
}

export async function collectMediaIds(projectId?: Id, store?: ProductStore): Promise<Set<Id>> {
    const db = store ?? productDb;
    const ipAvatars = projectId === undefined || projectId === "studio" ? (await db.ipProfiles.toArray()).flatMap(ip => ip.avatarMediaId ? [ip.avatarMediaId] : []) : [];
    const [projects, characters, scenes, props, styles, shots, references, materialUses, retainedMedia] = await Promise.all([
        projectId === undefined ? db.projects.toArray() : db.projects.where("id").equals(projectId).toArray(),
        (projectId === undefined ? db.characters : db.characters.where("projectId").equals(projectId)).toArray(),
        (projectId === undefined ? db.scenes : db.scenes.where("projectId").equals(projectId)).toArray(),
        (projectId === undefined ? db.props : db.props.where("projectId").equals(projectId)).toArray(),
        (projectId === undefined ? db.styles : db.styles.where("projectId").equals(projectId)).toArray(),
        (projectId === undefined ? db.shots : db.shots.where("projectId").equals(projectId)).toArray(),
        (projectId === undefined ? db.projectReferences : db.projectReferences.where("projectId").equals(projectId)).toArray(),
        (projectId === undefined ? db.materialUses : db.materialUses.where("projectId").equals(projectId)).toArray(),
        (projectId === undefined ? db.media : db.media.where("projectId").equals(projectId)).filter((media) => media.libraryRetained === true).toArray(),
    ]);
    const ids = new Set<Id>();
    for (const table of [db.audioTakes, db.musicWorks, db.audioExports]) {
        const rows = await (projectId === undefined ? table : table.where("projectId").equals(projectId)).toArray();
        for (const row of rows) ids.add(row.mediaId);
    }
    const audioJobs = await (projectId === undefined ? db.audioGenerationJobs : db.audioGenerationJobs.where("projectId").equals(projectId)).toArray();
    for (const job of audioJobs) {
        if (job.input.kind === "speech" && job.input.mimo?.referenceMediaId) ids.add(job.input.mimo.referenceMediaId);
        for (const result of job.results) if (result.mediaId) ids.add(result.mediaId);
    }
    const speakers = await (projectId === undefined ? db.audioSpeakers : db.audioSpeakers.where("projectId").equals(projectId)).toArray();
    for (const speaker of speakers) if (speaker.mimo?.referenceMediaId) ids.add(speaker.mimo.referenceMediaId);
    const audioItems = await (projectId === undefined ? db.audioGenerationBatchItems : db.audioGenerationBatchItems.where("projectId").equals(projectId)).toArray();
    for (const item of audioItems) if (item.snapshot.input.mimo?.referenceMediaId) ids.add(item.snapshot.input.mimo.referenceMediaId);
    for (const mediaId of ipAvatars) ids.add(mediaId);
    for (const use of materialUses) for (const mediaId of use.mediaIds) ids.add(mediaId);
    for (const media of retainedMedia) ids.add(media.id);
    for (const reference of references) if (reference.status !== "unavailable") ids.add(reference.mediaId);
    for (const project of projects) if (project.coverMediaId) ids.add(project.coverMediaId);
    for (const mediaId of collectSlotsMedia([
        ...characters.flatMap((character) => Object.values(character.slots ?? {})),
        ...scenes.flatMap((scene) => Object.values(scene.slots ?? {})),
        ...props.flatMap((prop) => Object.values(prop.slots ?? {})),
        ...styles.flatMap((style) => Object.values(style.slots ?? {})),
        ...shots.flatMap((shot) => SHOT_PICTURE_FIELDS.map((field) => shot[field])),
    ])) {
        ids.add(mediaId);
    }
    return mediaDependencyIds(ids, await (projectId === undefined ? db.media : db.media.where("projectId").equals(projectId)).toArray());
}

export async function recycleSlotMedia(
    previous: GenerationSlot | undefined,
    next: GenerationSlot | undefined, store?: ProductStore
): Promise<void> {
    const db = store ?? productDb;
    const kept = new Set(slotMediaIds(next));
    await deleteMediaIfOrphans(slotMediaIds(previous).filter((mediaId) => !kept.has(mediaId)), db);
}

export async function putMedia(record: MediaRecord, store?: ProductStore): Promise<Id> {
    const db = store ?? productDb;
    return db.transaction("rw", [db.media, db.projects].flat(), async (db) => {
        await assertProjectOwner(record.projectId, db);
        // Physical replacement is a new record; immutable IDs keep pending previews valid.
        await db.media.add(record);
        await touchProject(record.projectId, db);
        return record.id;
    });
}

/** Fresh history snapshot for one candidate owner, including cancelled/undone outcomes. */
async function collectHistoryMediaIds(projectId: Id, store?: ProductStore): Promise<Set<Id>> {
    const db = store ?? productDb;
    const [proposals, jobs, batches, items] = await Promise.all([
        db.productionProposals.where("projectId").equals(projectId).toArray(),
        db.agentGenerationJobs.where("projectId").equals(projectId).toArray(),
        db.agentGenerationBatches.where("projectId").equals(projectId).toArray(),
        db.agentGenerationBatchItems.where("projectId").equals(projectId).toArray(),
    ]);
    const ids = new Set<Id>();
    for (const proposal of proposals) {
        if (proposal.before.result) ids.add(proposal.before.result.mediaId);
        if (proposal.change.kind === "slot-result") ids.add(proposal.change.result.mediaId);
    }
    for (const job of jobs) {
        if (job.result) ids.add(job.result.mediaId);
        for (const input of job.inputs) ids.add(input.mediaId);
    }
    for (const batch of batches) for (const application of batch.applications) {
        if (application.before) ids.add(application.before.mediaId);
        ids.add(application.result.mediaId);
    }
    for (const item of items) for (const input of item.draft.inputs) ids.add(input.mediaId);
    return ids;
}

/** Call after all owner/history/flag changes; never reuse this snapshot across operations. */
export async function deleteMediaIfOrphans(mediaIds: readonly (Id | undefined)[], store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    const candidates = [...new Set(mediaIds.filter((id): id is Id => !!id))];
    if (!candidates.length) return;
    await db.transaction("rw", PRODUCTION_TABLES, async (db) => {
        const allMedia = await db.media.toArray();
        const candidateIds = mediaDependencyIds(candidates, allMedia);
        const records = allMedia.filter(record => candidateIds.has(record.id));
        if (!records.length) return;
        const used = await collectMediaIds(undefined, db);
        // History belongs to each candidate record's owner; current references remain global.
        const histories = new Map<Id, Set<Id>>();
        for (const projectId of new Set(records.map((record) => record.projectId))) {
            histories.set(projectId, mediaDependencyIds(await collectHistoryMediaIds(projectId, db), allMedia));
        }
        for (const record of records) {
            if (!used.has(record.id) && !histories.get(record.projectId)?.has(record.id)) {
                await db.media.delete(record.id);
            }
        }
    });
}

export async function deleteMediaIfOrphan(mediaId: Id | undefined, store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    await deleteMediaIfOrphans([mediaId], db);
}

export async function assertSlotMedia(projectId: Id, slot: GenerationSlot, allowVideoResult = false, store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    if (slot.result && slot.result.kind !== "image" && !(allowVideoResult && slot.result.kind === "video")) {
        throw new Error("素材结果类型不适用于当前槽位");
    }
    const expected = [
        ...slot.referenceImageIds.map((id) => ({id, kind: "image" as const})),
        ...slot.referenceVideoIds.map((id) => ({id, kind: "video" as const})),
        ...(slot.result ? [{id: slot.result.mediaId, kind: slot.result.kind}] : []),
    ];
    for (const {id, kind} of expected) {
        const media = await db.media.get(id);
        if (!media || media.projectId !== projectId || binaryByteLength(media.blob) === 0 || !media.mimeType.startsWith(`${kind}/`)) {
            throw new Error("素材已失效、类型不符或不属于当前项目，请重新选择");
        }
    }
}
