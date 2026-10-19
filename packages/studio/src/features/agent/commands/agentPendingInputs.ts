import {createId, nowIso} from "../../../platform/identity";
import {db as productDb} from "../../../platform/product/store";
import type {ProductStore} from "../../../platform/storage/types";
import type {ReferenceAttachment} from "../../references/models/references";
import {AGENT_PENDING_INPUT_LIMIT, type AgentPendingInput, type AgentPendingInputHeldReason, type AgentPendingInputMode, type AgentPendingInputSubmit, type AgentPendingInputSystem} from "../models/agentPendingInput";
import {assertChatAdmissionIdentity, normalizeSubmittedChatContent, type ChatAdmissionIdentity} from "../models/chatSubmission";

export const PENDING_INPUT_GONE = "该消息已送出或被删除";
export const PENDING_INPUT_CHANGED = "该消息已被修改，请刷新后重试";
/** The queued row was deleted (gone) or edited/held (changed) between claiming and delivering it. */
export class PendingInputConflictError extends Error {
    constructor(readonly reason: "gone" | "changed") {
        super(reason === "gone" ? PENDING_INPUT_GONE : PENDING_INPUT_CHANGED);
        this.name = "PendingInputConflictError";
    }
}
const PENDING_INPUT_FULL = `待发送消息已满（每个对话最多 ${AGENT_PENDING_INPUT_LIMIT} 条），请先处理已有消息`;

const tables = (db: ProductStore) => [db.agentPendingInputs, db.chatThreads, db.projects];
const byPosition = (a: AgentPendingInput, b: AgentPendingInput) => a.position - b.position;

async function threadRows(db: ProductStore, threadId: string): Promise<AgentPendingInput[]> {
    return (await db.agentPendingInputs.where("threadId").equals(threadId).toArray()).sort(byPosition);
}

async function requireRow(db: ProductStore, id: string, expectedRevision?: number): Promise<AgentPendingInput> {
    const row = await db.agentPendingInputs.get(id);
    if (!row) throw new PendingInputConflictError("gone");
    if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new PendingInputConflictError("changed");
    return row;
}

/** Thread and linked project must still exist; returns the thread's project ID. */
async function requireThreadScope(db: ProductStore, threadId: string): Promise<string | undefined> {
    const thread = await db.chatThreads.get(threadId);
    if (!thread) throw new Error("对话不存在");
    if (thread.projectId && !await db.projects.get(thread.projectId)) throw new Error("关联项目已不存在，无法执行");
    return thread.projectId;
}

/** Ordered rows (queued and held) for one thread. */
export async function listPendingInputs(threadId: string, store?: ProductStore): Promise<AgentPendingInput[]> {
    return threadRows(store ?? productDb, threadId);
}

export interface EnqueueUserInput {
    threadId: string;
    content?: string;
    attachments?: readonly ReferenceAttachment[];
    mode?: AgentPendingInputMode;
    admission: ChatAdmissionIdentity;
    submit: AgentPendingInputSubmit;
}

export async function enqueueUserInput(input: EnqueueUserInput, store?: ProductStore): Promise<AgentPendingInput> {
    const content = normalizeSubmittedChatContent(input.content, input.attachments);
    if (!content) throw new Error("消息不能为空");
    assertChatAdmissionIdentity(input.admission);
    const mode = input.mode ?? "next-turn";
    if (mode === "next-step" && input.attachments?.length) throw new Error("带资料的消息只能排队");
    const base = store ?? productDb;
    return base.transaction("rw", tables(base), async (db) => {
        const projectId = await requireThreadScope(db, input.threadId);
        const rows = await threadRows(db, input.threadId);
        if (rows.length >= AGENT_PENDING_INPUT_LIMIT) throw new Error(PENDING_INPUT_FULL);
        const at = nowIso();
        const row: AgentPendingInput = {
            id: createId("pin"), threadId: input.threadId, ...(projectId ? {projectId} : {}),
            position: rows.reduce((max, item) => Math.max(max, item.position), 0) + 1,
            source: "user", mode, status: "queued", content,
            ...(input.attachments?.length ? {attachments: input.attachments.map(item => ({...item}))} : {}),
            runId: input.admission.runId, userMessageId: input.admission.userMessageId, assistantMessageId: input.admission.assistantMessageId,
            submit: input.submit, revision: 1, createdAt: at, updatedAt: at,
        };
        await db.agentPendingInputs.add(row);
        return row;
    });
}

export interface EnqueueSystemInput {
    threadId: string;
    dedupeKey: string;
    system: AgentPendingInputSystem;
    /** Builds the text from the merged system source, so repeated groups regenerate it. */
    compose: (system: AgentPendingInputSystem) => {content: string; display?: string};
}

function mergeSystem(existing: AgentPendingInputSystem, next: AgentPendingInputSystem): AgentPendingInputSystem {
    const applied = new Map(existing.applied.map(item => [item.targetKey, item]));
    for (const item of next.applied) applied.set(item.targetKey, item);
    return {...next, applied: [...applied.values()]};
}

/**
 * Idempotent upsert by dedupeKey, meant to run inside the caller's (adoption) transaction.
 * At capacity a new key merges into the thread's latest system item for the same batch; if
 * there is none the enqueue is refused.
 */
export async function enqueueSystemInput(store: ProductStore, input: EnqueueSystemInput): Promise<AgentPendingInput> {
    return store.transaction("rw", tables(store), async (db) => {
        const projectId = await requireThreadScope(db, input.threadId);
        const merge = async (target: AgentPendingInput) => {
            const system = mergeSystem(target.system ?? input.system, input.system);
            const text = input.compose(system);
            const row: AgentPendingInput = {
                ...target, system, content: text.content, display: text.display,
                revision: target.revision + 1, updatedAt: nowIso(),
            };
            if (text.display === undefined) delete row.display;
            await db.agentPendingInputs.put(row);
            return row;
        };
        const existing = await db.agentPendingInputs.where("dedupeKey").equals(input.dedupeKey).first();
        if (existing) {
            if (existing.threadId !== input.threadId) throw new Error("系统消息归属不一致");
            return merge(existing);
        }
        const rows = await threadRows(db, input.threadId);
        if (rows.length >= AGENT_PENDING_INPUT_LIMIT) {
            const sibling = rows.filter(item => item.source === "system" && item.system?.batchId === input.system.batchId).pop();
            if (!sibling) throw new Error(PENDING_INPUT_FULL);
            return merge(sibling);
        }
        const text = input.compose(input.system);
        const at = nowIso();
        const row: AgentPendingInput = {
            id: createId("pin"), threadId: input.threadId, ...(projectId ? {projectId} : {}),
            position: rows.reduce((max, item) => Math.max(max, item.position), 0) + 1,
            source: "system", mode: "next-turn", status: "queued", content: text.content,
            ...(text.display !== undefined ? {display: text.display} : {}),
            runId: createId("run"), userMessageId: createId("msg"), assistantMessageId: createId("msg"),
            system: input.system, dedupeKey: input.dedupeKey, revision: 1, createdAt: at, updatedAt: at,
        };
        await db.agentPendingInputs.add(row);
        return row;
    });
}

/** User items only; only the text changes. */
export async function editPendingInput(id: string, expectedRevision: number, patch: {content: string}, store?: ProductStore): Promise<AgentPendingInput> {
    const base = store ?? productDb;
    return base.transaction("rw", tables(base), async (db) => {
        const row = await requireRow(db, id, expectedRevision);
        if (row.source !== "user") throw new Error("系统消息不可编辑");
        const content = patch.content.trim();
        if (!content && !row.attachments?.length) throw new Error("消息不能为空");
        const next: AgentPendingInput = {...row, content: content || normalizeSubmittedChatContent("", row.attachments), revision: row.revision + 1, updatedAt: nowIso()};
        await db.agentPendingInputs.put(next);
        return next;
    });
}

/** "Steer" is next-turn to next-step; only attachment-free user items may be steered. */
export async function setPendingMode(id: string, expectedRevision: number, mode: AgentPendingInputMode, store?: ProductStore): Promise<AgentPendingInput> {
    const base = store ?? productDb;
    return base.transaction("rw", tables(base), async (db) => {
        const row = await requireRow(db, id, expectedRevision);
        if (mode === "next-step") {
            if (row.source !== "user") throw new Error("系统消息不能引导");
            if (row.attachments?.length) throw new Error("带资料的消息只能排队");
        }
        if (row.mode === mode) return row;
        const next: AgentPendingInput = {...row, mode, revision: row.revision + 1, updatedAt: nowIso()};
        await db.agentPendingInputs.put(next);
        return next;
    });
}

/** Swaps position with the neighbour; at the edge this is a no-op. Does not change revision. */
export async function movePendingInput(id: string, direction: "up" | "down", store?: ProductStore): Promise<void> {
    const base = store ?? productDb;
    await base.transaction("rw", tables(base), async (db) => {
        const row = await requireRow(db, id);
        const rows = await threadRows(db, row.threadId);
        const index = rows.findIndex(item => item.id === id);
        const other = rows[direction === "up" ? index - 1 : index + 1];
        if (!other) return;
        const at = nowIso();
        await db.agentPendingInputs.put({...row, position: other.position, updatedAt: at});
        await db.agentPendingInputs.put({...other, position: row.position, updatedAt: at});
    });
}

export async function removePendingInput(id: string, expectedRevision?: number, store?: ProductStore): Promise<void> {
    const base = store ?? productDb;
    await base.transaction("rw", tables(base), async (db) => {
        await requireRow(db, id, expectedRevision);
        await db.agentPendingInputs.delete(id);
    });
}

/** Queued items become held (never auto-sent). Join the caller's terminal-state transaction. */
export async function holdPendingInputs(tx: ProductStore, threadId: string, reason: AgentPendingInputHeldReason): Promise<number> {
    return tx.transaction("rw", [tx.agentPendingInputs], async (db) => {
        const queued = (await db.agentPendingInputs.where("threadId").equals(threadId).toArray()).filter(item => item.status === "queued");
        const at = nowIso();
        for (const row of queued) await db.agentPendingInputs.put({...row, status: "held", heldReason: reason, revision: row.revision + 1, updatedAt: at});
        return queued.length;
    });
}

/** One queued item becomes held (dispatch failure or uncertainty). A row that is already gone or held is left alone. */
export async function holdPendingInput(id: string, reason: AgentPendingInputHeldReason, lastError?: string, store?: ProductStore): Promise<boolean> {
    const base = store ?? productDb;
    return base.transaction("rw", [base.agentPendingInputs], async (db) => {
        const row = await db.agentPendingInputs.get(id);
        if (!row || row.status !== "queued") return false;
        await db.agentPendingInputs.put({
            ...row, status: "held", heldReason: reason, revision: row.revision + 1, updatedAt: nowIso(),
            ...(lastError ? {lastError} : {}),
        });
        return true;
    });
}

/** First queued item by position; `systemOnly` (startup) considers only system items. Held items are never returned. */
export async function nextQueuedInput(threadId: string, options: {systemOnly?: boolean} = {}, store?: ProductStore): Promise<AgentPendingInput | undefined> {
    const rows = await threadRows(store ?? productDb, threadId);
    return rows.find(row => row.status === "queued" && (!options.systemOnly || row.source === "system"));
}

/** Thread IDs that still have queued system items (startup drain). */
export async function threadsWithQueuedSystemInputs(store?: ProductStore): Promise<string[]> {
    const rows = await (store ?? productDb).agentPendingInputs.where("status").equals("queued").toArray();
    return [...new Set(rows.filter(row => row.source === "system").map(row => row.threadId))];
}

/**
 * Delivery gate used inside the begin transaction: the row must still exist, belong to the thread and
 * the pre-allocated user message, and carry the revision the dispatcher claimed (queued or held: an explicit
 * "send now" may deliver a held item; every hold or edit bumps the revision). It is deleted with the
 * run's creation, so delivery happens exactly once across tabs and repeated drains.
 */
export async function consumePendingInput(db: ProductStore, expected: {id: string; revision: number; threadId: string; userMessageId?: string}): Promise<AgentPendingInput> {
    return db.transaction("rw", [db.agentPendingInputs], async (tx) => {
        const row = await tx.agentPendingInputs.get(expected.id);
        if (!row) throw new PendingInputConflictError("gone");
        if (row.threadId !== expected.threadId || row.userMessageId !== expected.userMessageId || row.revision !== expected.revision) {
            throw new PendingInputConflictError("changed");
        }
        await tx.agentPendingInputs.delete(row.id);
        return row;
    });
}
