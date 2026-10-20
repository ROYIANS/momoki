import {redactCredentials} from "@momoki/agent-providers/http";
import type {ProductStore} from "../../../platform/storage/types";
import {db as productDb} from "../../../platform/product/store";
import {createId, nowIso} from "../../../platform/identity";
import {withMemoryContext} from "../../memory/services/retrieval";
import {resolveConnector} from "../../settings/commands/connectors";
import {assertReasoningEffort, selectAgentProtocol} from "../../settings/models/reasoningPolicy";
import type {ChatModelMetadata} from "../../settings/models/modelMetadata";
import type {ConnectorConfig} from "../../settings/models/connector";
import {connectorRunIdentity} from "../commands/agentRuns";
import {readAgentContextPreview} from "../commands/agentContextPreview";
import {runBlocksThread} from "../models/agentToolSelection";
import type {AgentReasoningEffort, AgentRequestMessage} from "../models/agent";
import type {ContextCompaction, ContextPolicy, ContextSource} from "../models/context";
import {streamChatCompletions} from "../providers/chatStream";
import {streamResponses} from "../providers/responsesStream";
import {normalizeContextPolicy, resolveContextCapacity} from "./contextPolicy";
import {budgetContext, buildContextMessages, findApplicableSummary, isSourcePrefix, selectContextHistory, summaryCandidates} from "./contextPlanner";
import {estimateRequestTokens, type WireProtocol} from "./contextMeasurement";
import {summaryInput, summaryOutputCap, summaryReasoningEffort} from "./contextCompaction";
import {estimateTokens} from "./contextUsage";
import {type ThreadLockManager, withThreadRunLock} from "./runOwnership";

/**
 * Typed outcomes of an explicit "compact now" (modelled on dsh `/compact`):
 * busy - a run, approval, task wrap-up, another compaction or another page owns the thread;
 * unavailable - thread, connector or model cannot be used right now;
 * nothing - no complete turn is left to summarize;
 * changed - history, policy or ownership moved while the summary was produced;
 * summary - the model produced no useful, shorter summary;
 * cancelled - the user stopped it; persistence - the result could not be saved.
 */
export type ManualCompactionCode = "busy" | "unavailable" | "nothing" | "changed" | "summary" | "cancelled" | "persistence";
export class ManualCompactionError extends Error {
    constructor(readonly code: ManualCompactionCode, message: string) {
        super(message);
        this.name = "ManualCompactionError";
    }
}

export interface ManualCompactionResult {
    record: ContextCompaction;
    /** Request-level estimates (wire-shaped, tools/skills/memory included) for the next send without a draft. */
    before: number;
    after: number;
    turns: number;
}

const MANUAL_RUN_ID = "manual";

function groups(history: readonly ContextSource[]): ContextSource[][] {
    const result: ContextSource[][] = [];
    for (const message of history) {
        if (message.role === "user" || !result.length) result.push([]);
        result[result.length - 1].push(message);
    }
    return result;
}

/** Latest ledger state only: pending, running or unknown tool outcomes can never be bypassed by a summary. */
async function assertQuiet(threadId: string, db: ProductStore) {
    const runs = await db.agentRuns.where("threadId").equals(threadId).sortBy("createdAt");
    if (runs.some(runBlocksThread)) throw new ManualCompactionError("busy", "当前对话有未完成的执行或待确认的工具调用，请先完成或停止后再整理。");
    const latest = runs.at(-1);
    if (latest) {
        const calls = await db.agentToolCalls.where("runId").equals(latest.id).toArray();
        if (calls.some(call => ["awaiting_approval", "running", "unknown", "approved", "pending"].includes(call.status))) throw new ManualCompactionError("busy", "有工具调用尚未结束或核实，请先处理后再整理。");
    }
    if (await db.agentTaskWrapups.where("threadId").equals(threadId).filter(record => record.status === "preparing").count()) throw new ManualCompactionError("busy", "任务总结正在整理，请稍后再试。");
}

async function readState(threadId: string, db: ProductStore) {
    return db.transaction("r", [db.chatThreads, db.chatMessages, db.contextCompactions, db.agentRuns, db.agentToolCalls, db.agentTaskWrapups], async tx => {
        const thread = await tx.chatThreads.get(threadId);
        if (!thread) throw new ManualCompactionError("unavailable", "对话不存在");
        await assertQuiet(threadId, tx);
        return {
            thread,
            messages: await tx.chatMessages.where("threadId").equals(threadId).sortBy("createdAt"),
            records: await tx.contextCompactions.where("threadId").equals(threadId).sortBy("createdAt"),
        };
    });
}

/** Under the thread lock a stored "running" manual record is abandoned: close it without any request. */
export async function recoverManualCompactions(threadId: string, locks?: ThreadLockManager, store?: ProductStore) {
    const db = store ?? productDb;
    const manager: ThreadLockManager | undefined = locks ?? (typeof navigator !== "undefined" ? navigator.locks : undefined);
    if (!manager) return;
    await manager.request(`momoki:agent:${threadId}`, {ifAvailable: true}, async lock => {
        if (!lock) return;
        await db.contextCompactions.where("threadId").equals(threadId).filter(record => record.status === "running" && record.origin === "manual")
            .modify({status: "interrupted", error: "上次整理已中断，未启用未完成的摘要。", updatedAt: nowIso()});
    });
}

async function requestShape(threadId: string, input: {model: string; definitionId: string; modelMetadata?: ChatModelMetadata; reasoningEffort?: AgentReasoningEffort}, db: ProductStore) {
    const read = await readAgentContextPreview({threadId, draft: "", attachments: [], model: input.model, providerId: input.definitionId, metadata: input.modelMetadata}, db);
    if (read.status !== "ready") return undefined;
    const {facts} = read;
    return {
        instructions: facts.taskContext?.instructions ?? "",
        skills: facts.skillSurface.skillInstructions,
        tools: facts.toolSchemas,
        memory: facts.memorySelection,
    };
}

/**
 * Compact a thread outside any run. Reuses the run pipeline's summary prompt, window checks and exact
 * prefix coverage; the record stays inactive until the next send selects it, so reviewed memory,
 * confirmations and pending tool results are never touched. The caller must hold the thread-work
 * reservation (see agentExecutionService); this function additionally takes the thread Web Lock.
 */
export async function compactThreadNow(input: {
    threadId: string;
    connector: ConnectorConfig;
    model: string;
    reasoningEffort?: AgentReasoningEffort;
    modelMetadata?: ChatModelMetadata;
    controller: AbortController;
    fetchImpl?: typeof fetch;
    locks?: ThreadLockManager;
    store?: ProductStore;
    onStarted?: (id: string) => void;
}): Promise<ManualCompactionResult> {
    const db = input.store ?? productDb;
    const {controller, threadId} = input;
    const model = input.model.trim();
    if (!input.connector.apiKey.trim() || !model) throw new ManualCompactionError("unavailable", "请选择模型并配置连接");
    let identity;
    try {
        identity = connectorRunIdentity(input.connector);
        assertReasoningEffort(identity, model, input.reasoningEffort);
    } catch (cause) {
        throw new ManualCompactionError("unavailable", cause instanceof Error ? cause.message : "连接不可用");
    }
    const usedKeys = new Set([input.connector.apiKey]);
    const safe = (text: string) => [...usedKeys].reduce((value, key) => redactCredentials(value, key), text).slice(0, 300);
    const stopped = () => controller.signal.aborted;
    if (stopped()) throw new ManualCompactionError("cancelled", "整理已停止，未生成摘要。");
    try {
        return await withThreadRunLock(threadId, async () => {
            const {thread, messages, records} = await readState(threadId, db);
            const policy: ContextPolicy = normalizeContextPolicy(thread.contextPolicy);
            const history = selectContextHistory(messages, policy);
            const previous = findApplicableSummary(history, summaryCandidates(records, policy));
            const remaining = groups(history.slice(previous?.coverage.length ?? 0));
            if (!remaining.length) throw new ManualCompactionError("nothing", "没有更多可整理的完整对话。");
            const capacity = resolveContextCapacity(model, input.modelMetadata, identity.definitionId, policy).capacity;
            const reserve = capacity ? budgetContext([], [], capacity).outputReserve : 4096;
            const selected: ContextSource[] = [];
            for (const group of remaining) {
                if (budgetContext(summaryInput(previous, [...selected, ...group]), [], capacity).overBudget) break;
                selected.push(...group);
            }
            if (!selected.length) throw new ManualCompactionError("summary", "最早的一轮对话已超出模型的安全输入预算，无法整理。请缩短历史范围或更换更大上下文的模型。");
            const shape = await requestShape(threadId, {model, definitionId: identity.definitionId, modelMetadata: input.modelMetadata, reasoningEffort: input.reasoningEffort}, db);
            const protocol: WireProtocol = selectAgentProtocol(identity, model, input.reasoningEffort, !!shape?.tools.length);
            const measure = (summary?: ContextCompaction) => {
                const request: AgentRequestMessage[] = withMemoryContext(buildContextMessages(shape?.instructions ?? "", shape?.skills ?? "", history, "", summary), shape?.memory);
                return estimateRequestTokens(request, shape?.tools ?? [], protocol);
            };
            const before = measure(previous);
            const summaryMessages = summaryInput(previous, selected);
            const at = nowIso();
            const record: ContextCompaction = {
                id: createId("ctx"), threadId, runId: MANUAL_RUN_ID, origin: "manual", previousSummaryId: previous?.id, status: "running",
                coverage: [...(previous?.coverage ?? []), ...selected], input: summaryMessages, policy, connector: identity, model, content: "",
                beforeTokens: estimateTokens((previous?.content ?? "") + JSON.stringify(selected.map(({role, content}) => ({role, content})))),
                requestBefore: before, createdAt: at, updatedAt: at,
            };
            await db.transaction("rw", [db.chatThreads, db.contextCompactions, db.agentRuns, db.agentToolCalls, db.agentTaskWrapups], async tx => {
                if (stopped()) throw new ManualCompactionError("cancelled", "整理已停止，未生成摘要。");
                await assertQuiet(threadId, tx);
                if (!await tx.chatThreads.get(threadId)) throw new ManualCompactionError("unavailable", "对话不存在");
                await tx.contextCompactions.add(record);
            });
            input.onStarted?.(record.id);
            const fail = async (code: ManualCompactionCode, message: string): Promise<never> => {
                const status = stopped() ? "interrupted" : "failed";
                const error = stopped() ? "整理已停止，未完成的摘要不会启用。" : message;
                await db.contextCompactions.where("id").equals(record.id).filter(item => item.status === "running").modify({status, error, updatedAt: nowIso()});
                throw new ManualCompactionError(stopped() ? "cancelled" : code, error);
            };
            try {
                controller.signal.throwIfAborted();
                const current = await resolveConnector(identity.id, db);
                if (!current || !current.apiKey.trim()) throw new ManualCompactionError("unavailable", "原连接不可用，请重新配置后整理");
                usedKeys.add(current.apiKey);
                const refreshed = connectorRunIdentity(current);
                if (refreshed.id !== identity.id || refreshed.definitionId !== identity.definitionId || refreshed.baseUrl !== identity.baseUrl) throw new ManualCompactionError("changed", "原连接已变化，请重新选择后整理");
                controller.signal.throwIfAborted();
                const transport = selectAgentProtocol(identity, model, input.reasoningEffort, false) === "responses" ? streamResponses : streamChatCompletions;
                const result = await transport({
                    baseUrl: identity.baseUrl, apiKey: current.apiKey, connectorDefinitionId: identity.definitionId, model,
                    messages: summaryMessages, maxOutputTokens: summaryOutputCap(summaryMessages, reserve),
                    reasoningEffort: summaryReasoningEffort(identity, model, input.reasoningEffort),
                }, {signal: controller.signal, fetchImpl: input.fetchImpl});
                controller.signal.throwIfAborted();
                if (!result.ok) throw new ManualCompactionError("summary", result.message);
                const content = result.content.trim();
                if (!content || result.toolCalls?.length) throw new ManualCompactionError("summary", "没有得到有效的摘要，原始对话已保留。");
                if (estimateTokens(content) + 32 >= record.beforeTokens) throw new ManualCompactionError("summary", "摘要未能有效缩短上下文，原始对话已保留。");
                const completed: ContextCompaction = {...record, status: "completed", content, usage: result.usage, afterTokens: estimateTokens(content), activatedAt: nowIso(), updatedAt: nowIso()};
                const after = measure(completed);
                if (after >= before) throw new ManualCompactionError("summary", "整理后请求没有变小，原始对话已保留。");
                completed.requestAfter = after;
                try {
                    await db.transaction("rw", [db.chatThreads, db.chatMessages, db.contextCompactions, db.agentRuns, db.agentToolCalls, db.agentTaskWrapups], async tx => {
                        controller.signal.throwIfAborted();
                        await assertQuiet(threadId, tx);
                        const saved = await tx.contextCompactions.get(record.id);
                        const currentThread = await tx.chatThreads.get(threadId);
                        if (!saved || saved.status !== "running" || !currentThread) throw new ManualCompactionError("changed", "对话已变化，摘要未启用");
                        const nowHistory = selectContextHistory(await tx.chatMessages.where("threadId").equals(threadId).sortBy("createdAt"), normalizeContextPolicy(currentThread.contextPolicy));
                        if (JSON.stringify(normalizeContextPolicy(currentThread.contextPolicy)) !== JSON.stringify(policy) || !isSourcePrefix(completed.coverage, nowHistory)) throw new ManualCompactionError("changed", "对话历史已变化，摘要未启用");
                        controller.signal.throwIfAborted();
                        await tx.contextCompactions.put(completed);
                    });
                } catch (cause) {
                    if (cause instanceof ManualCompactionError || controller.signal.aborted) throw cause;
                    throw new ManualCompactionError("persistence", "摘要未能保存，原始对话已保留。");
                }
                return {record: completed, before, after, turns: groups(selected).length};
            } catch (cause) {
                if (cause instanceof ManualCompactionError) return fail(cause.code, safe(cause.message));
                return fail("summary", stopped() ? "" : safe(cause instanceof Error ? cause.message : "整理失败，原始对话已保留"));
            }
        }, input.locks, db);
    } catch (cause) {
        if (cause instanceof ManualCompactionError) throw cause;
        const message = cause instanceof Error ? cause.message : "";
        if (message.includes("另一个页面")) throw new ManualCompactionError("busy", message);
        throw new ManualCompactionError("unavailable", safe(message || "整理失败"));
    }
}
