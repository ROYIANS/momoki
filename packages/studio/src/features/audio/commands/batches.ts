import type {ProductStore} from "../../../platform/storage/types";
import {db as productDb} from "../../../platform/product/store";
import {assertAudioProject, ownedAudioRow} from "./ownership";
import {assertAudioRevision, newAudioRow} from "../models/row";
import {prepareAudioGenerationJob} from "./generation";
import type {
    AudioBatchOwner,
    AudioBatchSnapshot,
    AudioGenerationBatch,
    AudioGenerationBatchItem
} from "../models/audioGenerationBatch";
import {AUDIO_BATCH_LIMIT, audioBatchItemState, type AudioBatchItemState} from "../models/audioGenerationBatch";
import type {AudioGenerationJob} from "../models/audioGeneration";
import {assertAudioBatchSnapshot, prepareAudioBatchSnapshot} from "../generation/batchPreparation";
import {createId, nowIso} from "../../../platform/identity";
import {targetRevision} from "../../../platform/data/revision";
import {inspectAudioGenerationOutputs} from "../generation/outputEvidence";
import {isLaterUserTurn} from "../../agent/models/chatTurns";

export async function ownedAudioGenerationBatch(projectId: string, id: string, mutate = false, store?: ProductStore): Promise<AudioGenerationBatch> {
    const db = store ?? productDb;
    await assertAudioProject(projectId, "audio", db);
    const batch = await ownedAudioRow(db.audioGenerationBatches, projectId, id);
    await ownedAudioRow(db.audioChapters, projectId, batch.chapterId);
    if (mutate && batch.dormant) throw new Error("导入的历史批次不能确认或继续发送");
    if (batch.owner.kind === "agent" && !batch.dormant) {
        const owner = batch.owner;
        const run = await db.agentRuns.get(owner.runId), thread = await db.chatThreads.get(owner.threadId),
            call = await db.agentToolCalls.get(owner.callId);
        if (!run || !thread || !call || run.threadId !== owner.threadId || thread.projectId !== projectId || run.projectId !== projectId || call.runId !== run.id || call.threadId !== owner.threadId || call.name !== "prepare_audio_generation_batch") throw new Error("批次的原始助手来源或项目归属已失效");
        if (owner.taskId) {
            const task = await db.agentTasks.get(owner.taskId);
            if (!task || task.threadId !== owner.threadId || task.projectId !== projectId || run.taskId !== task.id || mutate && task.lifecycle !== "open") throw new Error("批次关联任务不可继续");
        }
        if (mutate) {
            if (run.interactionMode === "conversation" || !run.enabledToolNames?.includes("prepare_audio_generation_batch") || call.status !== "completed" || run.status === "cancelled") throw new Error("批次来源未完成准备、已结束或未启用音频制作技能");
            // Only a draft must come from the newest turn. A confirmed batch is a paid request the user already
            // authorised: the conversation moving on (a new message or run) must not void it mid-flight.
            if (!batch.confirmedAt) {
                const siblings = await db.agentRuns.where("threadId").equals(owner.threadId).toArray();
                const history = await db.chatMessages.where("threadId").equals(owner.threadId).toArray();
                if (siblings.some(other => other.id !== run.id && other.createdAt >= run.createdAt) || history.some(message => isLaterUserTurn(message, run))) throw new Error("此批次属于较早执行，请在当前执行重新准备需要发送的段落");
            }
        }
    }
    return batch;
}

const itemsFor = (id: string, store?: ProductStore) => (db => db.audioGenerationBatchItems.where("batchId").equals(id).sortBy("order"))(store ?? productDb);

async function writeBatch(batch: AudioGenerationBatch, patch: Partial<Pick<AudioGenerationBatch, "status" | "pauseReason" | "confirmedAt" | "confirmedItemIds">>, store?: ProductStore) {
    const db = store ?? productDb;
    const next = {...batch, ...patch, revision: batch.revision + 1, updatedAt: nowIso()};
    await db.audioGenerationBatches.put(next);
    return next;
}

export async function readAudioGenerationBatch(projectId: string, id: string, store?: ProductStore) {
    const db = store ?? productDb;
    return db.transaction("r", db.tables, async (db) => {
        const batch = await ownedAudioGenerationBatch(projectId, id, undefined, db), items = await itemsFor(id, db);
        const jobs: AudioGenerationJob[] = [];
        const rows: Array<{
            item: AudioGenerationBatchItem;
            job?: AudioGenerationJob;
            state: AudioBatchItemState;
            selected: boolean;
            placed: boolean
        }> = [];
        for (const item of items) {
            const candidate = item.jobId ? await db.audioGenerationJobs.get(item.jobId) : undefined;
            const job = candidate?.projectId === projectId && candidate.input.kind === "speech" && candidate.input.segmentId === item.segmentId &&
            candidate.source.kind === "batch" && candidate.source.batchId === batch.id && candidate.source.itemId === item.id &&
            batch.itemIds.includes(item.id) && item.chapterId === batch.chapterId && item.intentId === candidate.intentId && targetRevision(candidate.source.owner) === targetRevision(batch.owner) &&
            targetRevision(candidate.input) === targetRevision(item.snapshot.input) && targetRevision(candidate.connector) === targetRevision(item.snapshot.connector) ? candidate : undefined;
            if (job) jobs.push(job);
            let state = audioBatchItemState(item, job);
            let selected = false, placed = false;
            if (state === "saved" && job) {
                const evidence = await inspectAudioGenerationOutputs(job, undefined, db);
                if (!evidence.allAvailable) state = "unavailable";
                selected = evidence.selectedCount > 0;
                placed = evidence.timelineClipCount > 0;
            }
            rows.push({item, job, state, selected, placed});
        }
        const counts = Object.fromEntries(["draft", "queued", "submitting", "pending", "saved", "failed", "uncertain", "cancelled", "recovery", "unavailable"].map(state => [state, rows.filter(row => row.state === state).length]));
        return {batch, items, jobs, rows, counts};
    });
}

export async function prepareAudioGenerationBatch(args: {
    projectId: string;
    chapterId: string;
    segmentIds: string[];
    connectorId?: string;
    title?: string;
    owner?: AudioBatchOwner;
    retrySourceBatchId?: string;
}, store?: ProductStore): Promise<AudioGenerationBatch> {
    const db = store ?? productDb;
    if (!args.segmentIds.length || args.segmentIds.length > AUDIO_BATCH_LIMIT || new Set(args.segmentIds).size !== args.segmentIds.length) throw new Error("每批请选择 1–20 个不重复段落");
    const snapshots: AudioBatchSnapshot[] = [];
    for (const [index, id] of args.segmentIds.entries()) {
        try {
            snapshots.push(await prepareAudioBatchSnapshot(args.projectId, args.chapterId, id, args.connectorId, db));
        } catch (cause) {
            throw new Error(`第 ${index + 1} 个所选段落未准备：${cause instanceof Error ? cause.message : "请检查文本、音色和连接"}`, {cause});
        }
    }
    return db.transaction("rw", db.tables, async (db) => {
        const owner = args.owner ?? {kind: "manual"};
        if (owner.kind === "agent" && !args.retrySourceBatchId) {
            const existing = await db.audioGenerationBatches.where("sourceCallId").equals(owner.callId).first();
            if (existing) return ownedAudioGenerationBatch(args.projectId, existing.id, undefined, db);
        }
        for (const snapshot of snapshots) await assertAudioBatchSnapshot(args.projectId, args.chapterId, snapshot, db);
        const id = createId("audiobatch");
        const items = snapshots.map((snapshot, order) => newAudioRow<AudioGenerationBatchItem>(args.projectId, "audioitem", {
            batchId: id,
            chapterId: args.chapterId,
            segmentId: args.segmentIds[order],
            order,
            included: true,
            state: "draft",
            snapshot,
            intentId: createId("batch-intent")
        }));
        const row: AudioGenerationBatch = {
            ...newAudioRow<AudioGenerationBatch>(args.projectId, "audiobatch", {
                version: 1,
                chapterId: args.chapterId,
                title: args.title?.trim().slice(0, 160) || "批量配音",
                owner,
                ...(owner.kind === "agent" && !args.retrySourceBatchId ? {sourceCallId: owner.callId} : {}),
                retrySourceBatchId: args.retrySourceBatchId,
                status: "draft",
                itemIds: items.map(item => item.id),
                confirmedItemIds: []
            }), id
        };
        await db.audioGenerationBatches.add(row);
        await db.audioGenerationBatchItems.bulkAdd(items);
        return row;
    });
}

export async function includeAudioBatchItem(projectId: string, id: string, revision: number, itemId: string, included: boolean, store?: ProductStore) {
    const db = store ?? productDb;
    return db.transaction("rw", db.tables, async (db) => {
        const batch = await ownedAudioGenerationBatch(projectId, id, true, db);
        assertAudioRevision(batch, revision);
        const item = await ownedAudioRow(db.audioGenerationBatchItems, projectId, itemId);
        if (batch.status !== "draft" || item.batchId !== id) throw new Error("确认后的批次不能修改包含项");
        await db.audioGenerationBatchItems.update(item.id, {
            included,
            revision: item.revision + 1,
            updatedAt: nowIso()
        });
        return writeBatch(batch, {}, db);
    });
}

export async function confirmAudioGenerationBatch(projectId: string, id: string, revision: number, store?: ProductStore) {
    const db = store ?? productDb;
    return db.transaction("rw", db.tables, async (db) => {
        const batch = await ownedAudioGenerationBatch(projectId, id, true, db);
        assertAudioRevision(batch, revision);
        const items = await itemsFor(id, db), included = items.filter(item => item.included);
        if (batch.status !== "draft" || !included.length) throw new Error("请检查草稿并至少包含一个段落");
        for (const item of included) await assertAudioBatchSnapshot(projectId, batch.chapterId, item.snapshot, db);
        for (const item of items) await db.audioGenerationBatchItems.update(item.id, {
            state: item.included ? "queued" : "cancelled",
            revision: item.revision + 1,
            updatedAt: nowIso()
        });
        return writeBatch(batch, {
            status: "ready",
            confirmedAt: nowIso(),
            confirmedItemIds: included.map(item => item.id),
            pauseReason: undefined
        }, db);
    });
}

export async function controlAudioGenerationBatch(projectId: string, id: string, action: "run" | "pause" | "cancel", reason?: string, store?: ProductStore) {
    const db = store ?? productDb;
    return db.transaction("rw", db.tables, async (db) => {
        const batch = await ownedAudioGenerationBatch(projectId, id, action === "run", db);
        if (batch.dormant) throw new Error("历史批次不能执行");
        const items = await itemsFor(id, db);
        if (action === "run") {
            if (!batch.confirmedAt || batch.status === "cancelled" || batch.status === "draft") throw new Error("请先确认本批付费请求");
            for (const item of items) {
                const job = item.jobId ? await db.audioGenerationJobs.get(item.jobId) : undefined;
                if (job?.status === "uncertain" || job?.status === "submitting" || job?.status === "failed" && !job.failureStage) throw new Error("本批有尚不确定的提交，请先核实已有任务；不会重发");
            }
        }
        if (action === "cancel") for (const item of items) {
            const job = item.jobId ? await db.audioGenerationJobs.get(item.jobId) : undefined;
            if (!job || job.status === "prepared") await db.audioGenerationBatchItems.update(item.id, {
                state: "cancelled",
                revision: item.revision + 1,
                updatedAt: nowIso()
            });
        }
        let status: AudioGenerationBatch["status"] = "paused";
        if (action === "run") status = "running";
        if (action === "cancel") status = "cancelled";
        return writeBatch(batch, {status, pauseReason: reason}, db);
    });
}

export async function linkAudioBatchJob(projectId: string, id: string, itemId: string, store?: ProductStore): Promise<AudioGenerationJob | undefined> {
    const db = store ?? productDb;
    return db.transaction("rw", db.tables, async (db) => {
        const batch = await ownedAudioGenerationBatch(projectId, id, true, db);
        const item = await ownedAudioRow(db.audioGenerationBatchItems, projectId, itemId);
        if (batch.status !== "running" || item.batchId !== id || item.state === "cancelled" || !batch.confirmedItemIds.includes(item.id)) return;
        if (item.jobId) return ownedAudioRow(db.audioGenerationJobs, projectId, item.jobId);
        await assertAudioBatchSnapshot(projectId, batch.chapterId, item.snapshot, db);
        const job = await prepareAudioGenerationJob(projectId, {
            intentId: item.intentId,
            input: item.snapshot.input,
            connector: item.snapshot.connector,
            source: {kind: "batch", batchId: id, itemId: item.id, owner: batch.owner},
            referenceFingerprint: item.snapshot.referenceFingerprint
        }, db);
        await db.audioGenerationBatchItems.update(item.id, {
            jobId: job.id,
            state: "linked",
            revision: item.revision + 1,
            updatedAt: nowIso()
        });
        return job;
    });
}

export async function assertAudioBatchDispatch(projectId: string, jobId: string, store?: ProductStore) {
    const db = store ?? productDb;
    return db.transaction("r", db.tables, async (db) => {
        const job = await ownedAudioRow(db.audioGenerationJobs, projectId, jobId);
        if (job.source.kind !== "batch") throw new Error("缺少批次来源");
        const batch = await ownedAudioGenerationBatch(projectId, job.source.batchId, true, db);
        const item = await ownedAudioRow(db.audioGenerationBatchItems, projectId, job.source.itemId);
        if (batch.status !== "running" || !batch.confirmedAt || item.batchId !== batch.id || item.jobId !== job.id || item.state !== "linked" || !batch.confirmedItemIds.includes(item.id)) throw new Error("批次已暂停或取消，尚未提交");
        if (!batch.itemIds.includes(item.id) || !item.included || item.chapterId !== batch.chapterId || job.intentId !== item.intentId ||
            targetRevision(item.snapshot.input) !== targetRevision(job.input) || targetRevision(item.snapshot.connector) !== targetRevision(job.connector) || targetRevision(job.source.owner) !== targetRevision(batch.owner)) throw new Error("批次任务与已确认快照不一致，尚未提交");
        const jobs = await db.audioGenerationJobs.where("projectId").equals(projectId).filter(row => row.source.kind === "batch" && row.source.batchId === batch.id).toArray();
        if (jobs.some(row => row.status === "uncertain" || row.status === "failed" && !row.failureStage)) throw new Error("本批有未知提交，后续发送已暂停");
        await assertAudioBatchSnapshot(projectId, batch.chapterId, item.snapshot, db);
    });
}

export async function settleAudioGenerationBatch(projectId: string, id: string, store?: ProductStore) {
    const db = store ?? productDb;
    return db.transaction("rw", db.tables, async (db) => {
        const view = await readAudioGenerationBatch(projectId, id, db);
        if (view.batch.status === "cancelled") return view.batch;
        const pending = view.rows.some(row => ["queued", "submitting", "pending", "uncertain", "recovery"].includes(row.state));
        return writeBatch(view.batch, {
            status: pending ? "paused" : "settled",
            pauseReason: pending ? view.batch.pauseReason ?? "进度已保存；继续发送需明确操作，已有音频仅恢复保存" : undefined
        }, db);
    });
}

export async function retryFailedAudioBatch(projectId: string, id: string, itemIds: string[], store?: ProductStore) {
    const db = store ?? productDb;
    if (!itemIds.length || new Set(itemIds).size !== itemIds.length) throw new Error("请选择明确失败的段落");
    return db.transaction("rw", db.tables, async (db) => {
        const source = await ownedAudioGenerationBatch(projectId, id, true, db);
        const before = await readAudioGenerationBatch(projectId, id, db);
        const failed = before.rows.filter(row => itemIds.includes(row.item.id));
        if (failed.length !== itemIds.length || failed.some(row => row.job?.status !== "failed" || row.job.failureStage !== "provider" || row.job.results.length !== 0)) throw new Error("仅明确的供应商失败可创建付费重试；已保存、未知和本地恢复项不可重发");
        return prepareAudioGenerationBatch({
            projectId,
            chapterId: source.chapterId,
            segmentIds: failed.map(row => row.item.segmentId),
            title: `${source.title} · 重试`,
            owner: source.owner,
            retrySourceBatchId: id
        }, db);
    });
}
