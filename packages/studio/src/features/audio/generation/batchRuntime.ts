import {reserveAgentBatchWork} from "../../agent/runtime/threadWork";
import type {ProductStore} from "../../../platform/storage/types";
import {db as productDb} from "../../../platform/product/store";
import {
    assertAudioBatchDispatch,
    controlAudioGenerationBatch,
    linkAudioBatchJob,
    ownedAudioGenerationBatch,
    readAudioGenerationBatch,
    settleAudioGenerationBatch
} from "../commands/batches";
import {AUDIO_BATCH_CONCURRENCY, type AudioGenerationBatch} from "../models/audioGenerationBatch";
import {type AudioGenerationOptions, refreshAudioGeneration, submitAudioGeneration} from "./runtime";
import type {ThreadLockManager} from "../../agent/runtime/runOwnership";

interface AudioBatchWorker {
    batch: AudioGenerationBatch;
    controller: AbortController;
    paused: boolean;
    ownsLock: boolean;
    done: Promise<void>;
    actions: Set<Promise<unknown>>;
    closing: boolean;
}

const workers = new Map<string, AudioBatchWorker>();

function browserLocks(): ThreadLockManager {
    if (typeof navigator === "undefined" || !navigator.locks) throw new Error("批量配音需要支持 Web Locks 的浏览器，并通过 HTTPS 或 localhost 打开");
    return navigator.locks;
}

/** Every audio batch, agent-owned or not, is excluded by its own lock: the conversation stays free to chat. */
async function ownership<T>(batch: AudioGenerationBatch, action: () => Promise<T>, locks: ThreadLockManager = browserLocks()): Promise<T> {
    return locks.request(`cuepoint.audio-batch.${batch.id}`, {ifAvailable: true}, async lock => {
        if (!lock) throw new Error("此批次正在另一个页面执行");
        return action();
    });
}

/** Review/control mutations share live dispatch ownership until every write settles. */
export async function audioBatchUserAction<T>(projectId: string, id: string, action: () => Promise<T>, locks?: ThreadLockManager, store?: ProductStore): Promise<T> {
    const db = store ?? productDb;
    const worker = workers.get(id);
    if (worker?.ownsLock && !worker.closing) {
        const pending = Promise.resolve().then(action);
        worker.actions.add(pending);
        try {
            return await pending;
        } finally {
            worker.actions.delete(pending);
        }
    }
    if (worker) await worker.done;
    return ownership(await ownedAudioGenerationBatch(projectId, id, undefined, db), action, locks);
}

/** Explicit continuation only. Mount/reload never invokes this dispatcher. */
export async function startAudioGenerationBatch(projectId: string, id: string, options: AudioGenerationOptions & {
    locks?: ThreadLockManager;
    agentThreadId?: string
} = {}, store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    if (workers.has(id)) throw new Error("此批次已在当前页面执行");
    const controller = new AbortController();
    let reservation = options.agentThreadId ? reserveAgentBatchWork(db,
        {kind: "audioBatch", threadId: options.agentThreadId, batchId: id, projectId}, controller) : undefined;
    const preparation = (async () => {
        const batch = await ownedAudioGenerationBatch(projectId, id, true, db);
        if (options.agentThreadId && (batch.owner.kind !== "agent" || batch.owner.threadId !== options.agentThreadId)) throw new Error("音频批次对话归属不匹配");
        if (!batch.confirmedAt || batch.status === "draft" || batch.status === "cancelled") throw new Error("请先核对并确认本批付费请求");
        const worker: AudioBatchWorker = {
            batch,
            controller,
            paused: false,
            ownsLock: false,
            done: Promise.resolve(),
            actions: new Set(),
            closing: false
        };
        // Reserve before awaiting ownership so simultaneous starts cannot both dispatch.
        if (workers.has(id)) throw new Error("此批次已在当前页面执行");
        if (!reservation && batch.owner.kind === "agent") reservation = reserveAgentBatchWork(db,
            {kind: "audioBatch", threadId: batch.owner.threadId, batchId: id, projectId}, controller);
        workers.set(id, worker);
        const abort = () => {
            worker.paused = true;
            controller.abort();
        };
        options.signal?.addEventListener("abort", abort, {once: true});
        if (options.signal?.aborted) abort();
        worker.done = ownership(batch, async () => {
            worker.ownsLock = true;
            const pause = async (reason: string, store?: ProductStore) => {
                const db = store ?? productDb;
                worker.paused = true;
                await controlAudioGenerationBatch(projectId, id, "pause", reason, db);
            };
            const drain = async (execute: () => Promise<void>) => {
                const outcomes = await Promise.allSettled(Array.from({length: AUDIO_BATCH_CONCURRENCY}, execute));
                const failure = outcomes.find(outcome => outcome.status === "rejected");
                if (failure?.status === "rejected") throw failure.reason instanceof Error ? failure.reason : new Error("批次子任务失败", {cause: failure.reason});
            };
            try {
                // Stored bytes and known jobs recover before any remaining paid request.
                const before = await readAudioGenerationBatch(projectId, id, db);
                const recover = before.jobs.filter(job => !job.dormant && !["prepared", "saved", "failed"].includes(job.status));
                let recoveryIndex = 0;
                await drain(async () => {
                    while (!controller.signal.aborted && !worker.paused) {
                        const job = recover[recoveryIndex++];
                        if (!job) return;
                        try {
                            await refreshAudioGeneration(projectId, job.id, {...options, signal: controller.signal}, db);
                        } catch (error) {
                            await pause(error instanceof Error ? error.message : "已有音频恢复已暂停", db);
                        }
                    }
                });
                if (controller.signal.aborted || worker.paused) return;
                await controlAudioGenerationBatch(projectId, id, "run", undefined, db);
                const items = (await readAudioGenerationBatch(projectId, id, db)).items;
                let index = 0;
                await drain(async () => {
                    while (!controller.signal.aborted && !worker.paused) {
                        const item = items[index++];
                        if (!item) return;
                        if (item.state === "cancelled" || item.state === "draft") continue;
                        try {
                            const job = await linkAudioBatchJob(projectId, id, item.id, db);
                            if (!job || job.status !== "prepared") continue;
                            const result = await submitAudioGeneration(projectId, job.id, {
                                ...options, signal: controller.signal,
                                beforeSubmit: async () => {
                                    if (worker.paused || controller.signal.aborted) throw new Error("队列已停止，尚未付费提交");
                                    await assertAudioBatchDispatch(projectId, job.id, db);
                                }
                            }, db);
                            if (result.status === "uncertain" || result.failureStage === "preflight" || result.status === "failed" && !result.failureStage) await pause(result.error ?? "本批已暂停，请检查提交状态", db);
                        } catch (error) {
                            // Latch before persistence: a storage failure cannot allow the sibling to send again.
                            await pause(error instanceof Error ? error.message : "批量发送已暂停", db);
                        }
                    }
                });
            } finally {
                worker.closing = true;
                await Promise.allSettled([...worker.actions]);
                await settleAudioGenerationBatch(projectId, id, db);
            }
        }, options.locks).finally(() => {
            if (workers.get(id) === worker) workers.delete(id);
            options.signal?.removeEventListener("abort", abort);
        });
        if (reservation && !options.agentThreadId) reservation.follow(worker.done);
        return worker.done;
    })();
    if (reservation) reservation.follow(preparation);
    return preparation;
}

export async function stopAudioGenerationBatch(projectId: string, id: string, action: "pause" | "cancel", locks?: ThreadLockManager, store?: ProductStore) {
    const db = store ?? productDb;
    const worker = workers.get(id);
    if (worker) {
        worker.paused = true;
        worker.controller.abort();
        await worker.done.catch(() => undefined);
    }
    return audioBatchUserAction(projectId, id, () => controlAudioGenerationBatch(projectId, id, action, undefined, db), locks, db);
}

/** One read/download/local-decode pass, never a paid POST. */
export async function recoverAudioGenerationBatch(projectId: string, id: string, options: AudioGenerationOptions & {
    locks?: ThreadLockManager
} = {}, store?: ProductStore) {
    const db = store ?? productDb;
    return audioBatchUserAction(projectId, id, async () => {
        const view = await readAudioGenerationBatch(projectId, id, db);
        if (view.batch.dormant) throw new Error("导入的历史批次不能恢复网络任务");
        for (const job of view.jobs) if (!job.dormant && !["prepared", "saved", "failed"].includes(job.status)) await refreshAudioGeneration(projectId, job.id, options, db);
        await settleAudioGenerationBatch(projectId, id, db);
    }, options.locks, db);
}

/** Teardown/Agent Stop stops local waits and future dispatch; accepted results stay durable. */
export function pauseAudioGenerationBatches(owner: { projectId?: string; threadId?: string; projectOnly?: boolean }) {
    for (const worker of workers.values()) if (owner.projectId === worker.batch.projectId && (!owner.projectOnly || worker.batch.owner.kind !== "agent") || worker.batch.owner.kind === "agent" && owner.threadId === worker.batch.owner.threadId) {
        worker.paused = true;
        worker.controller.abort();
    }
}

export async function reconcileAudioBatchHistory(projectId: string, id: string, locks?: ThreadLockManager, store?: ProductStore) {
    const db = store ?? productDb;
    // Mounting the same live queue must not turn its accepted in-flight job into an abandoned one.
    if (workers.has(id)) return;
    return audioBatchUserAction(projectId, id, async () => {
        const view = await readAudioGenerationBatch(projectId, id, db);
        if (view.batch.dormant) return;
        for (const job of view.jobs) if (job.status === "submitting") {
            const current = await db.audioGenerationJobs.get(job.id);
            if (current?.status === "submitting") await refreshAudioGeneration(projectId, current.id);
        }
        if (view.batch.status === "running") await controlAudioGenerationBatch(projectId, id, "pause", "上次本地执行已中断，进度保留；不会自动发送", db);
    }, locks, db);
}
