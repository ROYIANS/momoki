import type {ThreadActivityIdentity} from "../models/threadActivity";
import {prepareThreadActivityKey, prepareRunActivityKey, publishAssistantActivity} from "./threadActivity";
import type {ProductStore} from "../../../platform/storage/types";
import {mcpRuntimeOwner} from "../mcp/runtime/owner";
import {assertMcpSnapshotCurrent} from "../mcp/runtime/surface";
import {composeRunSkills, type RunSkillSurface} from "../runtime/runSkills";
import {retainInstalledSkills} from "../skills/commands/retention";
import {settleRun} from "./agentRunTerminalState";
import {runBlocksThread} from "../models/agentToolSelection";
import type {ReferenceAttachment} from "../../references/models/references";
import {referenceSelectionCharacterBudget, selectReferenceContext} from "../../references/agent/referenceContext";
import {initModelCatalog, snapshotModelPricing} from "../../settings/modelCatalog/store";
import {requireVision, resolveVisionCapability} from "../../settings/models/visionCapability";
import {getMemorySelection} from "../../memory/queries/memoryRetrieval";
import {interruptedToolState, recoverBatchPreparationCalls, upgradeLegacyPlanCalls} from "./agentToolRecovery";
import {createAgentTaskForThread} from "./agentTasks";
import {getTaskContext} from "../runtime/taskContext";
import {db as productDb} from "../../../platform/product/store";
import type {
    AgentInteractionMode,
    AgentModelMetrics,
    AgentReasoningEffort,
    AgentRun,
    AgentRunOutput,
    AgentRunStatus,
    AgentTokenUsage
} from "../models/agent";
import type {ChatMessage} from "../models/chat";
import type {ContextAnchor} from "../models/context";
import type {ConnectorConfig} from "../../settings/models/connector";
import {createId, nowIso} from "../../../platform/identity";
import {getGeneralAgentConfig} from "./agentSettings";
import {normalizeContextPolicy, resolveContextCapacity} from "../runtime/contextPolicy";
import {buildContextMessages, findApplicableSummary, selectContextHistory, summaryCandidates} from "../runtime/contextPlanner";
import type {ChatModelMetadata} from "../../settings/models/modelMetadata";
import {assertReasoningEffort, selectAgentProtocol} from "../../settings/models/reasoningPolicy";
import {deriveChatTitle} from "../models/chatTitle";
import {assertChatAdmissionIdentity, normalizeSubmittedChatContent} from "../models/chatSubmission";
import type {ChatAdmissionIdentity} from "../models/chatSubmission";
import {consumePendingInput, PendingInputConflictError} from "./agentPendingInputs";

export function connectorRunIdentity(connector: ConnectorConfig): AgentRun["connector"] {
    const url = new URL(connector.baseUrl.trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error("连接地址必须是无凭据、查询参数或片段的 HTTP(S) 地址");
    }
    return {id: connector.id, definitionId: connector.definitionId, baseUrl: url.toString().replace(/\/+$/, "")};
}

export function assertRetryConnector(run: AgentRun, connector: ConnectorConfig): void {
    const identity = connectorRunIdentity(connector);
    if (identity.id !== run.connector.id || identity.definitionId !== run.connector.definitionId || identity.baseUrl !== run.connector.baseUrl) {
        throw new Error("原连接已更改，请恢复原连接配置或发送新消息");
    }
}

export function canRetryRun(run: AgentRun, runs: AgentRun[], messages: ChatMessage[]): boolean {
    if (run.status === "running" || run.status === "waiting_approval" || run.status === "completed" || run.hasToolCalls) return false;
    const latest = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    if (latest?.id !== run.id) return false;
    const lastUser = [...messages].filter((m) => m.role === "user").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    return lastUser?.id === run.userMessageId;
}

export async function beginAgentRun(input: {
    threadId: string;
    connector: ConnectorConfig;
    model: string;
    content?: string;
    attachments?: ReferenceAttachment[];
    retryOfRunId?: string;
    admission?: ChatAdmissionIdentity;
    expectedOwner?: Readonly<{projectId?: string}>;
    reasoningEffort?: AgentReasoningEffort;
    interactionMode?: AgentInteractionMode;
    createTask?: boolean;
    modelMetadata?: ChatModelMetadata;
    /** Delivers a queued item: its row is validated and deleted in this same transaction. */
    pendingInput?: Readonly<{id: string; revision: number}>;
}, store?: ProductStore): Promise<AgentRun> {
    const db = store ?? productDb;
    prepareThreadActivityKey(input.threadId);
    const identity = connectorRunIdentity(input.connector);
    if (!input.model.trim() || !input.connector.apiKey.trim()) throw new Error("请选择模型并配置 API Key");
    // Capture before catalog preparation so a caller cannot replace IDs while begin awaits.
    const admission = input.admission ? {...input.admission} : undefined;
    const expectedOwner = input.expectedOwner ? {...input.expectedOwner} : undefined;
    const pendingInput = input.pendingInput ? {...input.pendingInput} : undefined;
    if (pendingInput && (!admission || input.retryOfRunId !== undefined)) throw new Error("待发送消息必须使用其预分配的提交标识");
    if (admission) {
        assertChatAdmissionIdentity(admission);
        if (input.retryOfRunId !== undefined) throw new Error("重新生成不能复用新消息提交标识");
    }
    // Both catalog reads happen before the transaction: loading may import the baseline chunk,
    // while the lookups inside the transaction below only read memory.
    await initModelCatalog();
    const visionCapability = await resolveVisionCapability(input.model, identity.definitionId, input.modelMetadata);
    const mcpOwner = input.retryOfRunId ? undefined : mcpRuntimeOwner()?.connections;
    const mcpGenerations = mcpOwner?.capture() ?? [];
    const modelPricing = snapshotModelPricing(identity, input.model.trim(), nowIso());
    return db.transaction("rw", db.tables, async (db) => {
        const thread = await db.chatThreads.get(input.threadId);
        if (!thread) throw new Error("对话不存在");
        if (expectedOwner && thread.projectId !== expectedOwner.projectId) throw new Error("对话项目归属已变化，请核对后重新发送");
        if ((thread.taskMode || input.createTask) && !thread.projectId) throw new Error("任务模式请先选择项目");
        if (thread.projectId && !await db.projects.get(thread.projectId)) throw new Error("关联项目已不存在，无法执行");
        if (await db.agentTaskWrapups.where("threadId").equals(thread.id).filter((record) => record.status === "preparing").count()) throw new Error("总结正在整理，请先等待或停止");
        const runs = await db.agentRuns.where("threadId").equals(thread.id).toArray();
        if (runs.some(runBlocksThread)) throw new Error("此对话已有执行，请等待完成或恢复中断状态");
        const history = await db.chatMessages.where("threadId").equals(thread.id).sortBy("createdAt");
        // Keep order deterministic even when several IndexedDB writes share a millisecond.
        const at = new Date(Math.max(Date.now(), ...history.map((m) => Date.parse(m.createdAt) + 1).filter(Number.isFinite))).toISOString();
        const agent = await getGeneralAgentConfig(db);
        const previous = input.retryOfRunId ? runs.find((run) => run.id === input.retryOfRunId) : undefined;
        if (input.retryOfRunId && (!previous || !canRetryRun(previous, runs, history))) {
            throw new Error("只能重新生成当前最后一次未完成的回复；后续已有消息时请发送新问题");
        }
        if (previous) {
            if (previous.projectId !== thread.projectId) throw new Error("原执行项目归属已变化");
            assertRetryConnector(previous, input.connector);
            if (previous.model !== input.model.trim()) throw new Error("重新生成必须使用原模型");
        }
        const reasoningEffort = previous ? previous.reasoningEffort : input.reasoningEffort;
        assertReasoningEffort(identity, input.model, reasoningEffort);
        const content = normalizeSubmittedChatContent(input.content, input.attachments);
        if (!previous && !content) throw new Error("消息不能为空");
        let task = await db.agentTasks.where("threadId").equals(thread.id).first();
        if (input.createTask && !task && !previous) task = await createAgentTaskForThread(thread.id, {
            title: deriveChatTitle(content),
            goal: content
        }, db);
        if (task && task.projectId !== thread.projectId) throw new Error("任务与对话项目归属不一致");
        if (task && task.lifecycle !== "open") throw new Error("请先重新打开任务，再继续对话");
        if (previous?.taskId && previous.taskId !== task?.id) throw new Error("原任务关联已失效");

        const userMessageId = previous?.userMessageId ?? admission?.userMessageId ?? createId("cmsg");
        const runId = admission?.runId ?? createId("run");
        const assistantMessageId = admission?.assistantMessageId ?? createId("cmsg");
        const interactionMode = previous ? previous.interactionMode ?? "smart" : input.interactionMode ?? thread.interactionMode ?? "smart";
        const taskMode = previous ? previous.taskMode === true : thread.taskMode === true;
        const taskContext = await getTaskContext(thread.id, agent.instructions, taskMode, interactionMode, thread.projectId, db);
        const instructions = taskContext.instructions;
        // A retry with no installed snapshot stays legacy; it never discovers today's catalogue.
        const installedSkills = interactionMode === "conversation" || (previous && previous.installedSkills === undefined)
            ? undefined : await retainInstalledSkills(db, previous?.installedSkills);
        const surface: RunSkillSurface = previous ? {
            mcpSnapshot: interactionMode === "conversation" ? undefined : previous.mcpSnapshot,
            enabledToolNames: interactionMode === "conversation" ? [] : previous.enabledToolNames ?? [],
            toolLoading: interactionMode === "conversation" ? undefined : previous.toolLoading,
            skillInstructions: interactionMode === "conversation" ? "" : previous.skillInstructions ?? "",
        } : composeRunSkills({enabledSkillIds: agent.enabledSkillIds ?? [], taskToolNames: taskContext.taskToolNames,
            projectId: thread.projectId, projectKind: taskContext.projectKind, interactionMode, installedSkills, mcpGenerations});
        const {enabledToolNames, toolLoading, skillInstructions, mcpSnapshot} = surface;
        const policy = normalizeContextPolicy(thread.contextPolicy);
        const selectedHistory = selectContextHistory(history, policy);
        const summary = findApplicableSummary(selectedHistory, summaryCandidates(await db.contextCompactions.where("threadId").equals(thread.id).toArray(), policy));
        const capacity = resolveContextCapacity(input.model, input.modelMetadata, identity.definitionId, policy);
        const memorySelection = previous?.memorySelection ?? (thread.projectId ? await getMemorySelection({
            projectId: thread.projectId,
            threadId: thread.id,
            draft: content,
            recentUserTurns: selectedHistory.filter(m => m.role === 'user').map(m => m.content),
            taskTitle: task?.title,
            taskGoal: task?.goal,
            capacity: capacity.capacity
        }, db) : undefined);
        const selectedReferences = previous?.context?.selectedReferences ?? await selectReferenceContext(thread.projectId, input.attachments ?? [], referenceSelectionCharacterBudget(capacity.capacity), db);
        if (selectedReferences?.images?.length) requireVision(previous?.visionCapability ?? visionCapability);
        const baseMessages = buildContextMessages(instructions, skillInstructions, selectedHistory, content, summary, memorySelection?.envelope, selectedReferences);
        const requestMessages = previous?.context?.baseMessages ?? previous?.requestMessages ?? baseMessages;
        const context = previous ? previous.context : {
            policy,
            history: selectedHistory,
            baseMessages,
            draft: content,
            selectedReferences,
            summaryId: summary?.id,
            memoryEnvelope: memorySelection?.envelope, ...capacity
        };
        const frozenPricing = previous?.modelPricing ?? modelPricing;
        const run: AgentRun = {
            context,
            memorySelection,
            memoryAudit: [],
            referenceAudit: [],
            visionCapability: previous?.visionCapability ?? visionCapability,
            ...(frozenPricing ? {modelPricing: frozenPricing} : {}),
            projectId: thread.projectId,
            projectContext: previous?.projectContext ?? taskContext.projectContext,
            id: runId,
            threadId: thread.id,
            taskId: previous?.taskId ?? task?.id,
            plan: previous?.plan ?? task?.plan,
            agentId: previous?.agentId ?? agent.id,
            agentSnapshot: previous?.agentSnapshot ?? {name: agent.name, instructions},
            userMessageId,
            assistantMessageId,
            retryOfRunId: previous?.id,
            model: input.model.trim(),
            connector: identity,
            requestMessages,
            // A retry always reuses the frozen protocol; only a new send selects one.
            protocol: previous?.protocol ?? selectAgentProtocol(identity, input.model, reasoningEffort, enabledToolNames.length > 0),
            ...(reasoningEffort !== undefined ? {reasoningEffort} : {}),
            permissionMode: previous ? previous.permissionMode ?? "ask" : agent.permissionMode ?? "ask",
            interactionMode,
            taskMode,
            enabledToolNames,
            ...(installedSkills ? {installedSkills} : {}),
            ...(mcpSnapshot ? {mcpSnapshot} : {}),
            toolLoading,
            skillInstructions,
            status: "running",
            checkpoint: 0,
            createdAt: at,
            updatedAt: at,
        };
        // Delivery gate: a gone or edited queue row aborts the whole begin (nothing is created).
        const delivered = pendingInput ? await consumePendingInput(db, {...pendingInput, threadId: thread.id, userMessageId}) : undefined;
        if (delivered && delivered.content !== content) throw new PendingInputConflictError("changed");
        if (!previous) await db.chatMessages.add({
            id: userMessageId,
            threadId: thread.id,
            role: "user",
            content, ...(selectedReferences ? {
                attachments: selectedReferences.references,
                referenceContext: selectedReferences
            } : {}),
            ...(delivered?.source === "system" ? {origin: "system" as const, ...(delivered.display ? {display: delivered.display} : {})} : {}),
            createdAt: at,
            status: "complete"
        });
        await db.chatMessages.add({
            id: assistantMessageId,
            threadId: thread.id,
            role: "assistant",
            content: "",
            createdAt: new Date(Date.parse(at) + 1).toISOString(),
            status: "streaming",
            runId
        });
        await db.agentRuns.add(run);
        if (task) await db.agentTasks.update(task.id, {updatedAt: at});
        await db.chatThreads.update(thread.id, {
            updatedAt: at, connectorId: identity.id, model: run.model,
            ...(!previous && (thread.title === "新话题" || thread.title === "新对话")
                ? {title: deriveChatTitle(content)} : {}),
        });
        // Final transaction check after all awaited preparation/writes. Retry
        // preserves historical facts and never grants today's generation.
        if (!previous) await assertMcpSnapshotCurrent(mcpSnapshot, mcpOwner, db);
        return run;
    });
}

export async function checkpointAgentRun(runId: string, sequence: number, output: AgentRunOutput, store?: ProductStore, preparedActivity?: ThreadActivityIdentity): Promise<boolean> {
    const db = store ?? productDb;
    const activity = preparedActivity ?? await prepareRunActivityKey(runId, db);
    return db.transaction("rw", [db.agentRuns, db.chatMessages, db.chatThreads, db.deviceSettings], async (db) => {
        const run = await db.agentRuns.get(runId);
        if (!run) throw new Error("执行已删除");
        if (run.status !== "running" || sequence <= run.checkpoint) return false;
        const message = await db.chatMessages.get(run.assistantMessageId);
        if (!message || message.runId !== run.id) throw new Error("执行消息不存在");
        const reasoning = Object.hasOwn(output, "reasoning") ? output.reasoning : message.reasoning;
        const changed = output.content !== message.content || (reasoning ?? "") !== (message.reasoning ?? "");
        await db.chatMessages.update(message.id, {...output});
        if (changed && (output.content || reasoning) && activity) await publishAssistantActivity(activity, run, db);
        await db.agentRuns.update(run.id, {checkpoint: sequence, updatedAt: nowIso()});
        return true;
    });
}

export async function finishAgentRun(runId: string, status: Exclude<AgentRunStatus, "running" | "waiting_approval">, output?: AgentRunOutput, error?: string, finishReason?: string, store?: ProductStore, preparedActivity?: ThreadActivityIdentity): Promise<void> {
    const db = store ?? productDb;
    const activity = preparedActivity ?? await prepareRunActivityKey(runId, db);
    // Terminal output and its public revision share the original transaction.
    await db.transaction("rw", [db.agentRuns, db.chatMessages, db.chatThreads, db.deviceSettings, db.agentPendingInputs], (tx) =>
        settleRun(tx, runId, status, {output, error, finishReason, activity}).then(() => undefined));
}

/** Caller must own the thread's Web Lock; elapsed wall time is not proof of abandonment. */
export async function interruptThreadRuns(threadId: string, store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    const activity = prepareThreadActivityKey(threadId);
    await db.transaction("rw", [db.deviceSettings, db.chatThreads, db.agentRuns, db.agentToolCalls, db.chatMessages, db.contextCompactions, db.agentGenerationJobs, db.agentGenerationBatches, db.agentGenerationBatchItems, db.agentPendingInputs], async (db) => {
        const runs = await db.agentRuns.where("threadId").equals(threadId).toArray();
        for (const run of runs) {
            await upgradeLegacyPlanCalls(run.id, db);
            await recoverBatchPreparationCalls(run.id, db, activity);
            if (run.status !== "running") continue;
            await db.contextCompactions.where("runId").equals(run.id).filter((record) => record.status === "running").modify({
                status: "interrupted",
                error: "整理已中断，未启用未完成的摘要。请手动继续或重新生成。",
                updatedAt: nowIso()
            });
            const running = await db.agentToolCalls.where("runId").equals(run.id).filter((call) => call.status === "running").toArray();
            for (const call of running) await db.agentToolCalls.update(call.id, await interruptedToolState(call, db));
            const calls = await db.agentToolCalls.where("runId").equals(run.id).toArray();
            // A crash may fall between persisting an approval request and parking the
            // run. Restore its actionable waiting state instead of stranding the call
            // behind an interrupted run that cannot accept an approval or resume.
            if (calls.some((call) => call.status === "awaiting_approval") && !calls.some((call) => call.status === "unknown")) {
                await db.agentRuns.update(run.id, {status: "waiting_approval", updatedAt: nowIso()});
                await db.chatMessages.update(run.assistantMessageId, {status: "pending", error: undefined});
                await publishAssistantActivity(activity, run, db);
                continue;
            }
            await finishAgentRun(run.id, "interrupted", undefined, run.hasToolCalls
                ? "执行已中断。继续时将使用已保存的步骤与结果；结果不确定的操作需要先核实。"
                : "上次生成已中断，已保留收到的内容。重新生成会创建一次新的请求。", undefined, db, activity);
        }
    });
}


/** One immutable metrics record per model step, safe to replay after local recovery. */
export async function recordAgentModelMetrics(runId: string, metrics: AgentModelMetrics, store?: ProductStore, anchor?: ContextAnchor): Promise<void> {
    const db = store ?? productDb;
    await db.transaction("rw", [db.agentRuns].flat(), async (db) => {
        const run = await db.agentRuns.get(runId);
        if (!run || run.status !== "running") return;
        if (!Number.isSafeInteger(metrics.step) || metrics.step < 1 || metrics.step !== run.modelStep) throw new Error("模型用量所属步骤无效");
        if (run.modelMetrics?.some((item) => item.step === metrics.step)) return;
        const modelMetrics = [...(run.modelMetrics ?? []), metrics].sort((a, b) => a.step - b.step);
        const usage: AgentTokenUsage = {};
        const completeSteps = modelMetrics.length === run.modelStep;
        for (const name of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens"] as const) {
            if (completeSteps && modelMetrics.every((item) => item.usage?.[name] !== undefined)) {
                const sum = modelMetrics.reduce((total, item) => total + item.usage![name]!, 0);
                if (Number.isSafeInteger(sum)) usage[name] = sum;
            }
        }
        // Streaming generation speed excludes first-token latency, tool execution and
        // approval waits. JSON responses cannot reveal a first-token timestamp.
        const duration = modelMetrics.reduce((total, item) => total + (item.firstTokenAt === undefined ? 0 : item.endedAt - item.firstTokenAt), 0);
        const measurable = completeSteps && modelMetrics.every((item) => item.firstTokenAt !== undefined && item.endedAt > item.firstTokenAt);
        const outputTokensPerSecond = measurable && duration > 0 && usage.outputTokens !== undefined ? usage.outputTokens * 1000 / duration : undefined;
        await db.agentRuns.update(runId, {
            modelMetrics,
            ...(anchor && anchor.step === metrics.step && (!run.contextAnchor || run.contextAnchor.step < anchor.step) ? {contextAnchor: anchor} : {}),
            usage: Object.keys(usage).length ? usage : undefined,
            outputTokensPerSecond,
            // Usage-only changes still belong to this run's revision so live readers refresh.
            updatedAt: nowIso()
        });
    });
}
