import {reserveAgentBatchWork} from "../../agent/runtime/threadWork";
import type {ProductStore} from "../../../platform/storage/types";
import {resolveConnector} from "../../settings/commands/connectors";
import {db as productDb} from '../../../platform/product/store';
import {
    assertBatchDispatch,
    claimBatchItem,
    controlGenerationBatch,
    ownedGenerationBatch,
    readGenerationBatch,
    settleGenerationBatch
} from '../../agent/commands/agentGenerationBatches';
import {updateGenerationJob} from '../../agent/commands/agentGeneration';
import {BATCH_CONCURRENCY} from '../../agent/models/agentGenerationBatch';
import {type GenerationRuntimeOptions, monitorAgentGeneration, submitClaimedGeneration} from './generationRuntime';
import {type ThreadLockManager, withGenerationBatchLock} from '../../agent/runtime/runOwnership';

interface LocalWorker {
    batchId: string;
    threadId: string;
    controller: AbortController;
    done: Promise<void>;
    actions: Set<Promise<unknown>>;
    closing: boolean;
    ownsLock: boolean
}

/** Keyed by batch id: a batch is excluded by its own lock, so the conversation stays free to chat. */
const workers = new Map<string, LocalWorker>();

export async function batchUserAction<T>(batchId: string, action: () => Promise<T>, locks?: ThreadLockManager): Promise<T> {
    const worker = workers.get(batchId);
    // The current local worker already owns the batch lock. Keep it held until UI writes settle.
    if (worker && worker.ownsLock && !worker.closing) {
        const pending = Promise.resolve().then(action);
        worker.actions.add(pending);
        try {
            return await pending;
        } finally {
            worker.actions.delete(pending);
        }
    }
    if (worker) await worker.done;
    return withGenerationBatchLock(batchId, action, locks);
}


export async function startGenerationBatch(id: string, threadId: string, options: GenerationRuntimeOptions & {
    locks?: ThreadLockManager;
    signal?: AbortSignal
} = {}) {
    if (workers.has(id)) throw new Error('此批次已在当前页面执行');
    // One dispatching batch per conversation keeps cost predictable; this is not a lock on chatting.
    if ([...workers.values()].some(worker => worker.threadId === threadId)) throw new Error('此对话已有批次正在执行');
    const controller = new AbortController();
    const reservation = reserveAgentBatchWork(productDb, {kind: "videoBatch", threadId, batchId: id}, controller);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, {once: true});
    if (options.signal?.aborted) controller.abort();
    const worker: LocalWorker = {
        batchId: id,
        threadId,
        controller,
        done: Promise.resolve(),
        actions: new Set(),
        closing: false,
        ownsLock: false
    };
    workers.set(id, worker);
    worker.done = withGenerationBatchLock(id, async () => {
        worker.ownsLock = true;
        const context = {threadId, signal: controller.signal};
        controller.signal.throwIfAborted();
        await ownedGenerationBatch(id, threadId);
        await controlGenerationBatch(id, threadId, 'run');
        // Storage may be the reason execution stopped. Do not rely solely on a
        // successful pause write to prevent another paid request in this process.
        let dispatchPaused = false;
        const pause = async (reason: string, store?: ProductStore) => {
            const db = store ?? productDb;
            dispatchPaused = true;
            await controlGenerationBatch(id, threadId, 'pause', reason, db);
        };
        const settleWorkers = async (execute: () => Promise<void>) => {
            const outcomes = await Promise.allSettled(Array.from({length: BATCH_CONCURRENCY}, execute));
            const failed = outcomes.find(outcome => outcome.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason instanceof Error ? failed.reason : new Error("批次子任务失败", {cause: failed.reason});
        };
        try {
            // Retrieval comes first; a saved accepted job is never submitted a second time.
            const saved = await readGenerationBatch(id, threadId);
            const recover = saved.jobs.filter(j => !['downloaded', 'applied', 'conflict', 'failed', 'unknown'].includes(j.status));
            let recoveryIndex = 0;
            const retrieve = async (store?: ProductStore) => {
                const db = store ?? productDb;
                while (!controller.signal.aborted) {
                    const job = recover[recoveryIndex++];
                    if (!job) return;
                    try {
                        await monitorAgentGeneration(job.id, context, options, db);
                    } catch (error) {
                        await pause(error instanceof Error ? error.message : '查询已暂停', db);
                    }
                }
            };
            await settleWorkers(retrieve);
            const items = (await readGenerationBatch(id, threadId)).items;
            let index = 0;
            const dispatch = async (store?: ProductStore) => {
                const db = store ?? productDb;
                while (!controller.signal.aborted && !dispatchPaused) {
                    const item = items[index++];
                    if (!item) return;
                    if (item.state !== 'queued') continue;
                    let job;
                    let transportEntered = false;
                    try {
                        job = await claimBatchItem(id, threadId, item.id, db);
                        if (!job) continue;
                        const claimedJob = job;
                        const config = await resolveConnector(job.connectorId, db);
                        if (!config?.apiKey.trim() || config.definitionId !== job.provider || config.baseUrl !== job.baseUrl) throw new Error('供应商配置已变化，尚未付费提交');
                        transportEntered = true;
                        await submitClaimedGeneration(job, config, context, options, async (db) => {
                            if (dispatchPaused) throw new Error('本地队列已暂停，尚未付费提交');
                            await assertBatchDispatch(claimedJob, db);
                        }, db);
                    } catch (error) {
                        try {
                            const latest = job ? await db.agentGenerationJobs.get(job.id) : undefined;
                            if (!transportEntered && latest?.status === 'submitting' && !latest.providerTaskId) {
                                // Only this live stack knows preparation failed before entering shared transport.
                                await updateGenerationJob(latest.id, {
                                    status: 'failed',
                                    error: '本地配置校验失败，尚未付费提交'
                                }, db);
                            }
                            const current = job ? await db.agentGenerationJobs.get(job.id) : undefined;
                            if (!current || current.status !== 'failed') await pause(error instanceof Error ? error.message : '生成等待已暂停', db);
                        } catch (storageError) {
                            dispatchPaused = true;
                            throw storageError;
                        }
                    }
                }
            };
            await settleWorkers(dispatch);
        } finally {
            worker.closing = true;
            await Promise.allSettled([...worker.actions]);
            await settleGenerationBatch(id, threadId);
        }
    }, options.locks).finally(() => {
        workers.delete(id);
        options.signal?.removeEventListener('abort', abort);
    });
    reservation.follow(worker.done);
    return worker.done;
}

export async function stopGenerationBatch(id: string, threadId: string, action: 'pause' | 'cancel', locks?: ThreadLockManager) {
    const worker = workers.get(id);
    if (worker) {
        worker.controller.abort();
        await worker.done.catch(() => undefined);
    }
    await batchUserAction(id, () => controlGenerationBatch(id, threadId, action), locks);
}
