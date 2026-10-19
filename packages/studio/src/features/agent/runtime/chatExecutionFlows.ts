import type {ProductStore} from "../../../platform/storage/types";
import type {ConnectorConfig} from "../../settings/models/connector";
import type {ChatModelMetadata} from "../../settings/models/modelMetadata";
import {resolveConnector} from "../../settings/commands/connectors";
import {runWithCompatibleChatModel} from "../../settings/models/connectors";
import type {AgentInteractionMode, AgentReasoningEffort, AgentRun} from "../models/agent";
import type {ChatAdmissionIdentity} from "../models/chatSubmission";
import type {ChatThread} from "../models/chat";
import type {ReferenceAttachment} from "../../references/models/references";
import type {RunAction} from "../models/chatRunAction";
import {deriveChatTitle} from "../models/chatTitle";
import {createChatThread, updateChatThread} from "../commands/chat";
import {assertRetryConnector, beginAgentRun} from "../commands/agentRuns";
import {cancelAgentRun, resolveAgentToolApproval} from "../commands/agentTools";
import {executeChatRun, resumeChatRun} from "./runChat";
import {withThreadRunLock, type ThreadLockManager} from "./runOwnership";
import type {AgentToolDefinition} from "./tools";
import type {ExecutionFeedbackInvocation} from "./executionFeedback";

/** Named existing Studio dependencies, not another execution algorithm or store. */
export interface ChatExecutionBinding {
    store: ProductStore;
    locks?: ThreadLockManager;
    fetchImpl?: typeof fetch;
    registry?: readonly AgentToolDefinition[];
}

export interface NewChatMessage {
    threadId: string;
    admission: ChatAdmissionIdentity;
    content: string;
    attachments: ReferenceAttachment[];
    activeThread?: ChatThread;
    originThreadId?: string;
    connector: ConnectorConfig;
    model: string;
    taskMode: boolean;
    projectId?: string;
    interactionMode: AgentInteractionMode;
    reasoningEffort?: AgentReasoningEffort;
    modelMetadata?: ChatModelMetadata;
    controller: AbortController;
    isCurrent: () => boolean;
    feedback?: ExecutionFeedbackInvocation;
    onThreadReady?: (thread: ChatThread) => void;
    onAdmitted?: (run: AgentRun) => void;
    /** Queue delivery: the begin transaction validates and deletes this row. */
    pendingInput?: {id: string; revision: number};
}

export async function executeNewChatMessage(input: NewChatMessage, binding: ChatExecutionBinding) {
    const {store, locks, fetchImpl, registry} = binding;
    const {controller, connector, model, feedback} = input;
    return runWithCompatibleChatModel(connector, model, async () => {
        let thread = input.activeThread;
        if (input.originThreadId && input.originThreadId !== input.threadId) throw new Error("对话归属不匹配");
        if (!thread && input.originThreadId) thread = await store.chatThreads.get(input.threadId);
        if (!thread && input.originThreadId) throw new Error("对话不存在");
        if (!thread) {
            thread = await createChatThread({id: input.threadId, connectorId: connector.id, model,
                title: deriveChatTitle(input.content), taskMode: input.taskMode, projectId: input.projectId}, store);
            input.onThreadReady?.(thread);
            feedback?.bindThread(thread.id);
        }
        if (thread.id !== input.threadId) throw new Error("对话归属不匹配");
        if (controller.signal.aborted) return;
        const target = thread;
        await withThreadRunLock(target.id, async ownership => {
            if (controller.signal.aborted) return;
            await store.transaction("rw", [store.chatThreads], async tx => {
                const current = await tx.chatThreads.get(target.id);
                if (!current || current.projectId !== input.projectId) throw new Error("对话或项目归属已变化，请核对后重新发送");
                await updateChatThread(target.id, {
                    interactionMode: input.originThreadId ? input.interactionMode : "smart",
                    reasoningSelection: {connectorId: connector.id, baseUrl: connector.baseUrl, model, value: input.reasoningEffort}
                }, tx);
            });
            if (controller.signal.aborted) return;
            const run = await beginAgentRun({admission: input.admission, expectedOwner: {projectId: input.projectId},
                threadId: target.id, connector, model, content: input.content, attachments: input.attachments,
                modelMetadata: input.modelMetadata, reasoningEffort: input.reasoningEffort,
                interactionMode: input.originThreadId ? input.interactionMode : "smart",
                ...(input.pendingInput ? {pendingInput: input.pendingInput} : {})}, store);
            input.onAdmitted?.(run);
            feedback?.admitted(run);
            await executeChatRun(run, connector.apiKey, controller, fetchImpl, registry, store, ownership, feedback?.runtime);
        }, locks, store);
    }, {signal: controller.signal, isCurrent: input.isCurrent, fetchImpl});
}

export interface ExistingChatRun {
    threadId: string;
    runId: string;
    controller: AbortController;
    isCurrent: () => boolean;
    feedback?: ExecutionFeedbackInvocation;
}

async function ownedRun(input: ExistingChatRun, store: ProductStore): Promise<AgentRun> {
    const run = await store.agentRuns.get(input.runId);
    if (!run || run.threadId !== input.threadId) throw new Error("执行不存在");
    return run;
}

export async function retryFrozenChatRun(input: ExistingChatRun, binding: ChatExecutionBinding) {
    const {store, locks, fetchImpl, registry} = binding;
    const previous = await ownedRun(input, store);
    const connector = await resolveConnector(previous.connector.id, store);
    if (!connector) throw new Error("原连接已删除，请重新配置后发送新消息");
    assertRetryConnector(previous, connector);
    return runWithCompatibleChatModel(connector, previous.model, () => withThreadRunLock(previous.threadId, async ownership => {
        if (input.controller.signal.aborted) return;
        const run = await beginAgentRun({threadId: previous.threadId, connector, model: previous.model, retryOfRunId: previous.id}, store);
        input.feedback?.admitted(run);
        await executeChatRun(run, connector.apiKey, input.controller, fetchImpl, registry, store, ownership, input.feedback?.runtime);
    }, locks, store), {signal: input.controller.signal, isCurrent: input.isCurrent, fetchImpl});
}

export async function resolveChatRunAction(input: ExistingChatRun & {action: RunAction; callId?: string}, binding: ChatExecutionBinding) {
    const {store, locks, fetchImpl, registry} = binding;
    const run = await ownedRun(input, store);
    if (input.action === "cancel") {
        await withThreadRunLock(run.threadId, async () => {
            if (!input.controller.signal.aborted) await cancelAgentRun(run.id, store);
        }, locks, store);
        return;
    }
    if (input.action === "approve" || input.action === "reject") {
        if (!input.callId) throw new Error("请选择需要处理的工具调用");
        const callId = input.callId;
        const decision = input.action;
        await withThreadRunLock(run.threadId, async () => {
            if (!input.controller.signal.aborted) await resolveAgentToolApproval(run.id, callId, decision, store);
        }, locks, store);
    }
    const outstanding = await store.agentToolCalls.where("runId").equals(run.id).filter(call => call.status === "awaiting_approval").count();
    if (outstanding > 0 || input.controller.signal.aborted) return;
    // Decisions persist without a connector; only an actual continuation needs its current key.
    const connector = await resolveConnector(run.connector.id, store);
    if (!connector) throw new Error("决定已保存。原连接不存在，请恢复连接后继续或结束执行。");
    assertRetryConnector(run, connector);
    return runWithCompatibleChatModel(connector, run.model, () => withThreadRunLock(run.threadId, async ownership => {
        if (input.controller.signal.aborted) return;
        input.feedback?.admitted(run);
        await resumeChatRun(run.id, connector.apiKey, input.controller, fetchImpl, registry, store, ownership, input.feedback?.runtime);
    }, locks, store), {signal: input.controller.signal, isCurrent: input.isCurrent, fetchImpl});
}
