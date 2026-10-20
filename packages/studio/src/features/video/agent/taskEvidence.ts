import {binaryByteLength} from "../../../platform/media/binaryTypes";
import {binaryAvailability} from "../../../platform/storage/binary";
import {isBinaryReference} from "../../../platform/storage/codec";
import type {ProductStore} from "../../../platform/storage/types";
import type {AgentRun, AgentTask, AgentToolCall} from "../../agent/models/agent";
import type {AgentGenerationJob} from "../../agent/models/agentGeneration";
import type {ProductionTarget} from "../models/production";
import {parseGenerationSlot} from "../../library/models/slot";
import {CHARACTER_SLOTS, type GenerationResult, PROP_SLOTS, SCENE_SLOTS, STYLE_SLOTS} from "../../library/models/slots";
import {type MediaRecord} from "../../library/models/media";
import {STUDIO_LIBRARY_ID} from "../../library/models/ownership";
import {db as productDb} from "../../../platform/product/store";

type TaskOwner = Pick<AgentTask, "id" | "threadId">;
export const PICTURE_GENERATION_TOOLS = ["submit_generation", "check_generation", "apply_generation"] as const;

function objectJson(text: string | undefined): Record<string, unknown> {
    try {
        const value: unknown = JSON.parse(text ?? "null");
        return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

function isGenerationResult(value: unknown): value is GenerationResult {
    if (!value || typeof value !== "object") return false;
    if (!("mediaId" in value) || typeof value.mediaId !== "string" || !value.mediaId) return false;
    return "kind" in value && (value.kind === "image" || value.kind === "video");
}

/** Historical success is necessary, but does not establish current deliverability. */
export function provesCompletedGeneration(call: AgentToolCall): boolean {
    if (call.status !== "completed" || call.error) return false;
    if (!(PICTURE_GENERATION_TOOLS as readonly string[]).includes(call.name)) return false;
    const value = objectJson(call.result);
    if (value.error || value.ok === false || value.success === false) return false;
    if (!isGenerationResult(value.result)) return false;
    if (call.name === "apply_generation") return value.status === "applied" && value.applied === true;
    return value.status === "downloaded" || value.status === "applied";
}

function ownsGenerationRun(task: TaskOwner, job: AgentGenerationJob, run: AgentRun | undefined): boolean {
    return !!run && run.taskId === task.id && run.threadId === task.threadId && run.projectId === job.projectId;
}

export async function ownedTaskGenerationJob(task: TaskOwner, job: AgentGenerationJob, store?: ProductStore): Promise<boolean> {
    const db = store ?? productDb;
    const current = await db.agentTasks.get(task.id);
    if (!current || current.threadId !== task.threadId || current.projectId !== job.projectId || job.threadId !== task.threadId) return false;
    if (!ownsGenerationRun(task, job, await db.agentRuns.get(job.runId))) return false;
    if (!job.batchId) return true;
    const batch = await db.agentGenerationBatches.get(job.batchId);
    return !!batch && batch.taskId === task.id && batch.threadId === task.threadId && batch.projectId === job.projectId && batch.runId === job.runId;
}

function hasDownloadedGenerationResult(job: AgentGenerationJob): boolean {
    if (job.target.projectId !== job.projectId || !isGenerationResult(job.result)) return false;
    if (job.result.kind !== job.kind) return false;
    return ["downloaded", "applied", "conflict"].includes(job.status);
}

function hasAvailableGenerationMedia(job: AgentGenerationJob, media: MediaRecord | undefined): media is MediaRecord {
    if (!media || media.projectId !== job.projectId) return false;
    if (!(media.blob instanceof Blob) && !isBinaryReference(media.blob) || binaryByteLength(media.blob) === 0) return false;
    if (typeof media.mimeType !== "string") return false;
    const prefix = `${job.kind}/`;
    return media.mimeType.startsWith(prefix) && media.mimeType.length > prefix.length;
}

async function readCurrentShotSlot(job: AgentGenerationJob, target: Extract<ProductionTarget, {
    kind: "shot"
}>, store?: ProductStore) {
    const db = store ?? productDb;
    if (!target.slot || !["firstFrame", "lastFrame", "clip"].includes(target.slot)) return undefined;
    const expectedKind = target.slot === "clip" ? "video" : "image";
    if (job.kind !== expectedKind) return undefined;
    const shot = await db.shots.get(target.entityId);
    if (!shot || shot.projectId !== target.projectId || shot.episodeId !== target.episodeId) return undefined;
    const episode = await db.episodes.get(target.episodeId);
    if (!episode || episode.projectId !== target.projectId) return undefined;
    return shot[target.slot];
}

function currentAssetSlot(job: AgentGenerationJob, entity: {
    projectId: string;
    slots?: unknown
} | undefined, slots: readonly { id: string }[]): unknown {
    if (job.kind !== "image" || !slots.some(slot => slot.id === job.target.slot)) return undefined;
    if (!entity || entity.projectId !== job.target.projectId) return undefined;
    if (!entity.slots || typeof entity.slots !== "object") return undefined;
    return (entity.slots as Record<string, unknown>)[job.target.slot!];
}

async function readCurrentGenerationSlot(job: AgentGenerationJob, store?: ProductStore): Promise<unknown> {
    const db = store ?? productDb;
    const target = job.target;
    if (!target.slot || target.projectId !== job.projectId) return undefined;
    if (target.projectId !== STUDIO_LIBRARY_ID && !await db.projects.get(target.projectId)) return undefined;
    switch (target.kind) {
        case "shot":
            return Promise.resolve(readCurrentShotSlot(job, target, db));
        case "character":
            return currentAssetSlot(job, await db.characters.get(target.entityId), CHARACTER_SLOTS);
        case "scene":
            return currentAssetSlot(job, await db.scenes.get(target.entityId), SCENE_SLOTS);
        case "prop":
            return currentAssetSlot(job, await db.props.get(target.entityId), PROP_SLOTS);
        case "style":
            return currentAssetSlot(job, await db.styles.get(target.entityId), STYLE_SLOTS);
        case "library":
        default:
            return undefined;
    }
}

/** File availability survives target deletion; application requires a currently legal slot. */
export async function inspectTaskGenerationOutput(job: AgentGenerationJob, store?: ProductStore) {
    const db = store ?? productDb;
    let media: MediaRecord | undefined;
    if (isGenerationResult(job.result)) media = await db.media.get(job.result.mediaId);
    const available = hasDownloadedGenerationResult(job) && hasAvailableGenerationMedia(job, media) && await db.waitFor(binaryAvailability(media.blob)) === "ready";
    let applied = false;
    if (available) {
        const result = parseGenerationSlot(await Promise.resolve(readCurrentGenerationSlot(job, db))).result;
        applied = !!result && result.mediaId === media?.id && result.kind === job.kind;
    }
    return {media, available, applied, supportsResult: available};
}

/** Callers adopt native helper promises with Promise.resolve inside Dexie transactions.
 * A successful call must identify the same owned job and output it actually returned. */
export async function taskGenerationToolSource(task: TaskOwner, call: AgentToolCall, store?: ProductStore) {
    const db = store ?? productDb;
    if (!provesCompletedGeneration(call)) return undefined;
    const value = objectJson(call.result), args = objectJson(call.arguments);
    if (typeof value.jobId !== "string" || !isGenerationResult(value.result)) return undefined;
    const job = await db.agentGenerationJobs.get(value.jobId);
    if (!job || !await Promise.resolve(ownedTaskGenerationJob(task, job, db)) || call.threadId !== task.threadId) return undefined;
    if (!ownsGenerationRun(task, job, await db.agentRuns.get(call.runId))) return undefined;
    if (call.name === "submit_generation") {
        if (job.callId !== call.id || job.runId !== call.runId) return undefined;
    } else if (args.jobId !== job.id) return undefined;
    if (call.name === "apply_generation" && job.batchId) return undefined;
    if (value.result.mediaId !== job.result?.mediaId || value.result.kind !== job.kind) return undefined;
    return {jobId: job.id, ...await Promise.resolve(inspectTaskGenerationOutput(job, db))};
}
