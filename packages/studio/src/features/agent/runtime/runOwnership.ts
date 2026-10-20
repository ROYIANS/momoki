import type {ProductStore} from "../../../platform/storage/types";
import {isLegacyAtomicPlanCall, isUnknownBatchPreparation} from "../commands/agentToolRecovery";
import {recoverAbandonedGenerationBatch, runningGenerationBatchIds} from "../commands/agentGenerationBatches";
import {db as productDb} from "../../../platform/product/store";
import {interruptThreadRuns} from "../commands/agentRuns";

export interface ThreadLockManager {
    request<T>(name: string, options: {
        ifAvailable: true
    }, callback: (lock: unknown) => Promise<T>): Promise<T>;
}

/** The thread is executing in another page; callers that merely probe (queue drain) treat this as "not now". */
export class ThreadLockBusyError extends Error {
    constructor() {
        super("此对话正在另一个页面执行，请先在那里停止或等待完成");
        this.name = "ThreadLockBusyError";
    }
}

function browserLocks(): ThreadLockManager {
    if (typeof navigator === "undefined" || !navigator.locks) {
        throw new Error("此浏览器无法安全协调执行，请使用支持 Web Locks 的浏览器并通过 HTTPS 或 localhost 打开");
    }
    return navigator.locks;
}

/** A generation batch is excluded by its own lock, never by the conversation's. */
export const generationBatchLockName = (batchId: string) => `cuepoint.generation-batch.${batchId}`;

export function withGenerationBatchLock<T>(batchId: string, execute: () => Promise<T>, locks: ThreadLockManager = browserLocks()): Promise<T> {
    return locks.request(generationBatchLockName(batchId), {ifAvailable: true}, async lock => {
        if (!lock) throw new Error("此批次正在另一个页面执行");
        return execute();
    });
}

/** A running batch whose lock is free has no live worker anywhere: mark it paused. A held lock means it is alive. */
async function recoverIdleGenerationBatches(batchIds: readonly string[], locks: ThreadLockManager, store: ProductStore) {
    for (const batchId of batchIds) {
        await locks.request(generationBatchLockName(batchId), {ifAvailable: true}, async lock => {
            if (lock) await recoverAbandonedGenerationBatch(batchId, store);
        });
    }
}

const ownershipBrand:unique symbol=Symbol('ThreadOwnership');
export interface ThreadOwnership {
    readonly [ownershipBrand]:true;
    readonly threadId:string;
    assertHeld():void;
}
// An explicit capability is the only lookup key. This registry cannot supply an ambient current owner.
type CapabilityState={held:boolean;executing:boolean;accepting:boolean;threadId:string;execution?:Promise<unknown>};
const capabilities=new WeakMap<ThreadOwnership,CapabilityState>();
export function assertThreadOwnership(ownership:ThreadOwnership,threadId:string):void {
    const state=capabilities.get(ownership);
    if (!state?.held || state.threadId !== threadId) throw new Error('执行所有权无效、已经释放或对话不匹配');
}
export function withOwnedExecution<T>(ownership:ThreadOwnership,threadId:string,execute:()=>Promise<T>):Promise<T> {
    assertThreadOwnership(ownership,threadId);
    const state=capabilities.get(ownership)!;
    if (!state.accepting) throw new Error('执行所有权回调已经结束');
    if (state.executing) throw new Error('同一执行所有权不能并发或重复进入执行循环');
    state.executing=true;
    const completion=Promise.resolve().then(execute).finally(()=>{state.executing=false;});
    state.execution=completion;
    void completion.catch(()=>undefined);
    return completion;
}

/** An execution-only lease never runs recovery against a newly created run. */
export async function withExecutionOwnership<T>(threadId:string,execute:(ownership:ThreadOwnership)=>Promise<T>,locks:ThreadLockManager=browserLocks()):Promise<T> {
    return locks.request(`cuepoint:agent:${threadId}`,{ifAvailable:true},async lock=>{
        if (!lock) throw new ThreadLockBusyError();
        const state:CapabilityState={held:true,executing:false,accepting:true,threadId};
        const ownership:ThreadOwnership={
            [ownershipBrand]:true,threadId,assertHeld(){assertThreadOwnership(ownership,threadId);}
        };
        capabilities.set(ownership,state);
        try {
            const result=await execute(ownership);
            state.accepting=false;
            await state.execution;
            return result;
        } catch (cause) {
            state.accepting=false;
            await state.execution?.catch(()=>undefined);
            throw cause;
        } finally {state.held=false;}
    });
}

export async function withThreadRunLock<T>(threadId:string,execute:(ownership:ThreadOwnership)=>Promise<T>,locks:ThreadLockManager=browserLocks(),store:ProductStore=productDb):Promise<T> {
    return withExecutionOwnership(threadId,async ownership=>{
        await (await import("../commands/agentJobs")).recoverAgentJobs(threadId, ownership, store);
        // Starting a turn must not touch a batch that is still dispatching: only idle ones are recovered.
        await recoverIdleGenerationBatches(await runningGenerationBatchIds(threadId, store), locks, store);
        await interruptThreadRuns(threadId, store);
        return execute(ownership);
    },locks);
}

export async function recoverAbandonedRuns(locks: ThreadLockManager = browserLocks(), store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    const active = await db.agentRuns.where("status").equals("running").toArray();
    const batchIds = await runningGenerationBatchIds(undefined, db);
    // Repair known local-only history under the same lock, without running tools.
    const repairableCalls = await db.agentToolCalls.filter(call => isLegacyAtomicPlanCall(call) || isUnknownBatchPreparation(call)).toArray();
    const jobs = await db.agentJobs.filter(job => ['accepted', 'running', 'stopping'].includes(job.status)).toArray();
    for (const threadId of new Set([...active, ...repairableCalls, ...jobs].map((run) => run.threadId))) {
        await locks.request(`cuepoint:agent:${threadId}`, {ifAvailable: true}, async (lock) => {
            if (lock) {
                const state: CapabilityState = {held: true, executing: false, accepting: true, threadId};
                const ownership: ThreadOwnership = {[ownershipBrand]: true, threadId, assertHeld() {assertThreadOwnership(ownership, threadId);}};
                capabilities.set(ownership, state);
                try {
                    await (await import("../commands/agentJobs")).recoverAgentJobs(threadId, ownership, db);
                    await interruptThreadRuns(threadId, db);
                } finally {state.held = false;}
            }
        });
    }
    // Batches no longer ride on the conversation lock, so each is recovered under its own.
    await recoverIdleGenerationBatches(batchIds, locks, db);
}
