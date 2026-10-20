import type {ProductStore} from "../../../platform/storage/types";
import {db as productDb} from "../../../platform/product/store";
import type {ProductionTarget} from "../../video/models/production";
import type {AgentGenerationJob} from "../models/agentGeneration";
import type {GenerationSlot} from "../../library/models/slots";
import {emptySlot} from "../../library/models/slot";
import {targetRevision} from "../../../platform/data/revision";

/** Library targets never change underneath a request, so their revision is a constant. */
export const LIBRARY_TARGET_REVISION = "library-v1";

async function readTargetEntity(target: ProductionTarget, store?: ProductStore) {
    const db = store ?? productDb;
    switch (target.kind) {
        case "shot":
            return db.shots.get(target.entityId);
        case "character":
            return db.characters.get(target.entityId);
        case "scene":
            return db.scenes.get(target.entityId);
        case "prop":
            return db.props.get(target.entityId);
        case "style":
        default:
            return db.styles.get(target.entityId);
    }
}

type GenerationEntity = NonNullable<Awaited<ReturnType<typeof readTargetEntity>>>;

async function assertShotEpisode(target: Extract<ProductionTarget, {
    kind: "shot"
}>, entity: GenerationEntity, store?: ProductStore) {
    const db = store ?? productDb;
    const episode = await db.episodes.get(target.episodeId);
    if (!episode || episode.projectId !== target.projectId || !("episodeId" in entity) || entity.episodeId !== target.episodeId) throw new Error("生成目标不属于当前故事");
}

/** Reads the current owned target inside the caller's transaction, if any. */
export async function readGenerationTarget(target: ProductionTarget, store?: ProductStore) {
    const db = store ?? productDb;
    if (target.kind === "library") {
        // The material library has no slot to conflict with: a stable revision and an empty slot.
        if (!await db.projects.get(target.projectId)) throw new Error("生成目标项目已删除");
        return {entity: undefined, slot: emptySlot(), revision: LIBRARY_TARGET_REVISION, label: target.label ?? "素材库"};
    }
    if (target.projectId !== "studio" && !await db.projects.get(target.projectId)) throw new Error("生成目标项目已删除");
    const entity = await readTargetEntity(target, db);
    if (!entity || entity.projectId !== target.projectId) throw new Error("生成目标不存在或归属不匹配");
    if (target.kind === "shot") await assertShotEpisode(target, entity, db);
    if (!target.slot) throw new Error("生成目标缺少素材槽位");
    let slot: GenerationSlot;
    if ("slots" in entity) {
        const slots: Partial<Record<string, GenerationSlot>> = entity.slots;
        slot = slots[target.slot] ?? emptySlot();
    } else if (target.kind === "shot") slot = entity[target.slot];
    else slot = emptySlot();
    return {
        entity,
        slot,
        revision: targetRevision(entity),
        label: "name" in entity ? entity.name : `镜头 ${entity.shotNumber || entity.order + 1}`
    };
}

/** Name for a generated material: the request's label, else the start of its prompt. */
export function libraryMaterialName(job: Pick<AgentGenerationJob, "target" | "parameters">): string {
    if (job.target.kind === "library" && job.target.label) return job.target.label;
    const prompt = String(job.parameters.prompt ?? "").trim().replace(/\s+/g, " ");
    return prompt ? prompt.slice(0, 24) : "生成素材";
}
