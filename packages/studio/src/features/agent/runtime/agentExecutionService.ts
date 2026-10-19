import {currentAgentThreadWork, reserveAgentThreadWork, subscribeAgentThreadWork, shutdownAgentThreadWork, type AgentThreadWork} from "./threadWork";
import {recoverTaskWrapups, prepareTaskWrapup} from "./taskWrapup";
import {compactThreadNow, ManualCompactionError, recoverManualCompactions} from "./manualCompaction";
import type {AgentReasoningEffort} from "../models/agent";
import {createId} from "../../../platform/identity";
import {StorageError} from "../../../platform/storage/errors";
import {resolveConnector} from "../../settings/commands/connectors";
import type {ChatModelMetadata} from "../../settings/models/modelMetadata";
import {connectorRunIdentity} from "../commands/agentRuns";
import type {ChatSubmissionAttempt} from "../models/chatSubmissionAttempt";
import type {RunAction} from "../models/chatRunAction";
import {readAgentAdmission} from "../queries/agentAdmission";
import {createExecutionFeedbackController, type ExecutionFeedbackInvocation, type ExecutionFeedbackSnapshot} from "./executionFeedback";
import {executeNewChatMessage, resolveChatRunAction, retryFrozenChatRun, type ChatExecutionBinding} from "./chatExecutionFlows";
import {recoverAbandonedRuns, ThreadLockBusyError, withThreadRunLock} from "./runOwnership";
import {runBlocksThread} from "../models/agentToolSelection";
import {cancelAgentRun} from "../commands/agentTools";
import type {AgentPendingInput, AgentPendingInputMode, AgentPendingInputSubmit} from "../models/agentPendingInput";
import type {ChatAdmissionIdentity} from "../models/chatSubmission";
import type {ReferenceAttachment} from "../../references/models/references";
import {
    editPendingInput, enqueueUserInput, holdPendingInput, holdPendingInputs, movePendingInput, nextQueuedInput,
    PendingInputConflictError, removePendingInput, setPendingMode, threadsWithQueuedSystemInputs
} from "../commands/agentPendingInputs";

const invocationBrand: unique symbol = Symbol("AgentInvocation");
/** Opaque local identity; persisted IDs never reconstruct an invocation owner. */
export interface AgentExecutionToken {readonly [invocationBrand]: true; readonly id: string}
export interface AgentExecutionHandle {
    readonly threadId: string;
    readonly token: AgentExecutionToken;
    readonly done: Promise<void>;
}
export interface AgentExecutionSnapshot {
    readonly threadId: string;
    readonly active: boolean;
    readonly stopping: boolean;
    readonly token?: AgentExecutionToken;
    readonly kind?: "submit" | "retry" | "decision" | "check" | "recovery" | "taskWrapup" | "videoBatch" | "audioBatch" | "contextCompaction" | "queue";
    readonly feedback?: Readonly<ExecutionFeedbackSnapshot>;
    readonly attempts: readonly ChatSubmissionAttempt[];
    readonly error?: string;
    readonly wrapupId?: string;
    readonly work?: AgentThreadWork;
}
interface Invocation {
    token: AgentExecutionToken;
    controller: AbortController;
    feedback: ExecutionFeedbackInvocation;
    done: Promise<void>;
    stopping: boolean;
    wrapupId?: string;
    kind: NonNullable<AgentExecutionSnapshot["kind"]>;
    /** Startup continuation: a chain of queue dispatches that only ever delivers system items. */
    systemOnly: boolean;
}
interface ThreadState {
    invocation?: Invocation;
    feedback?: Readonly<ExecutionFeedbackSnapshot>;
    feedbackOwner: ReturnType<typeof createExecutionFeedbackController>;
    lastFeedback?: {token: AgentExecutionToken; invocation: ExecutionFeedbackInvocation};
    attempts: ChatSubmissionAttempt[];
    snapshot: AgentExecutionSnapshot;
    listeners: Set<() => void>;
    error?: string;
}

/** Kinds whose normal end may hand the thread to the next queued item. */
const DRAINING_KINDS: ReadonlySet<string> = new Set(["submit", "retry", "decision", "queue"]);
const MAX_DISPATCH_ERROR = 200;

/** Copy only local submitted data; never store a ConnectorConfig/API key in snapshots. */
function freezeAttempt(attempt: ChatSubmissionAttempt): ChatSubmissionAttempt {
    const attachments = attempt.submitted.attachments.map(item => Object.freeze({...item}));
    const imports = attempt.submitted.imports.map(item => Object.freeze({...item}));
    Object.freeze(attachments);
    Object.freeze(imports);
    const createdThread = attempt.createdThread ? structuredClone(attempt.createdThread) : undefined;
    if (createdThread) {
        if (createdThread.excludedMemoryIds) Object.freeze(createdThread.excludedMemoryIds);
        if (createdThread.contextPolicy) Object.freeze(createdThread.contextPolicy);
        if (createdThread.reasoningSelection) Object.freeze(createdThread.reasoningSelection);
        Object.freeze(createdThread);
    }
    return Object.freeze({...attempt,
        admission: Object.freeze({...attempt.admission}), connector: Object.freeze({id: attempt.connector.id,
            definitionId: attempt.connector.definitionId, baseUrl: attempt.connector.baseUrl}),
        recovery: Object.freeze({...attempt.recovery}),
        submitted: Object.freeze({...attempt.submitted, attachments, imports}), createdThread});
}

/** One application/document owner; views can detach without disposing its executions. */
export function createAgentExecutionService(options: ChatExecutionBinding) {
    const binding = Object.freeze({...options, registry: options.registry ? Object.freeze([...options.registry]) : undefined});
    const threads = new Map<string, ThreadState>();
    let admissionOpen = true;
    let initialized: Promise<void> | undefined;
    let shutdownPromise: Promise<void> | undefined;
    const scopeListeners = new Map<string, Set<() => void>>();
    const scopeSnapshots = new Map<string, readonly ChatSubmissionAttempt[]>();

    function state(threadId: string): ThreadState {
        let current = threads.get(threadId);
        if (current) return current;
        const feedbackOwner = createExecutionFeedbackController({onChange: feedback => {
            const owner = threads.get(threadId);
            if (!owner) return;
            owner.feedback = feedback ? Object.freeze({...feedback}) : undefined;
            if (owner.invocation) publish(threadId, owner);
        }});
        const work = currentAgentThreadWork(binding.store, threadId);
        current = {feedbackOwner, attempts: [], listeners: new Set(),
            snapshot: Object.freeze({threadId, active: !!work, stopping: work?.controller.signal.aborted ?? false, work,
                kind: work?.identity.kind === "model" ? undefined : work?.identity.kind, attempts: Object.freeze([])})};
        threads.set(threadId, current);
        return current;
    }
    function publish(threadId: string, owner: ThreadState) {
        const invocation = owner.invocation;
        const work = currentAgentThreadWork(binding.store, threadId);
        owner.snapshot = Object.freeze({threadId, active: !!invocation || !!work, stopping: invocation?.stopping ?? work?.controller.signal.aborted ?? false,
            wrapupId: invocation?.wrapupId, token: invocation?.token ?? owner.lastFeedback?.token, kind: invocation?.kind ?? (work?.identity.kind === "model" ? undefined : work?.identity.kind), work, feedback: owner.feedback,
            attempts: Object.freeze([...owner.attempts]), error: owner.error});
        for (const scope of new Set([...scopeSnapshots.keys(), ...scopeListeners.keys()])) {
            const listeners = scopeListeners.get(scope) ?? [];
            const previous = scopeSnapshots.get(scope);
            const next = [...threads.values()].flatMap(entry => entry.attempts).filter(attempt => attempt.submitted.scope === scope);
            if (!previous || previous.length !== next.length || next.some((item, index) => item !== previous[index])) {
                scopeSnapshots.set(scope, Object.freeze(next));
                for (const listener of [...listeners]) {try {listener();} catch { /* Detached view. */ }}
            }
        }
        for (const listener of [...owner.listeners]) {
            try {listener();} catch { /* A detached/broken view cannot own execution. */ }
        }
    }
    function patchAttempt(threadId: string, id: string, patch: Partial<ChatSubmissionAttempt>) {
        const owner = state(threadId);
        owner.attempts = owner.attempts.map(attempt => attempt.admission.userMessageId === id ? freezeAttempt({...attempt, ...patch}) : attempt);
        publish(threadId, owner);
    }
    function attemptFor(threadId: string, userMessageId: string) {
        const attempt = state(threadId).attempts.find(item => item.admission.userMessageId === userMessageId);
        if (!attempt) throw new Error("发送记录不存在");
        return attempt;
    }
    function admissionInput(attempt: ChatSubmissionAttempt) {
        return {threadId: attempt.threadId, admission: attempt.admission, connector: attempt.connector,
            model: attempt.model, projectId: attempt.projectId, content: attempt.submitted.text.trim(), attachments: attempt.submitted.attachments};
    }
    function initialize(): Promise<void> {
        initialized ??= (async () => {
            await recoverAbandonedRuns(binding.locks, binding.store);
            const rows = await binding.store.agentTaskWrapups.filter(row => row.status === "preparing").toArray();
            for (const threadId of new Set(rows.map(row => row.threadId))) await recoverTaskWrapups(threadId, binding.locks, binding.store);
            const compactions = await binding.store.contextCompactions.filter(row => row.status === "running" && row.origin === "manual").toArray();
            for (const threadId of new Set(compactions.map(row => row.threadId))) await recoverManualCompactions(threadId, binding.locks, binding.store);
            // Startup continues only system items (a user-confirmed adoption); queued user items stay visible
            // for an explicit "send now" so a restart never auto-sends a paid request the user typed.
            try {
                for (const threadId of await threadsWithQueuedSystemInputs(binding.store)) scheduleDrain(threadId, true);
            } catch { /* The queue stays durable; a later drain or explicit send picks it up. */ }
        })();
        return initialized;
    }
    function claim(threadId: string, kind: Invocation["kind"], operation: (entry: Invocation) => Promise<void>,
                   submitted?: ChatSubmissionAttempt, taskId?: string, systemOnly = false, quiet = false): AgentExecutionHandle {
        if (!admissionOpen) throw new Error("应用正在退出，暂时无法开始执行");
        const owner = state(threadId);
        if (owner.invocation) throw new Error("当前对话尚有执行未结束，请等待完成或先停止");
        const token: AgentExecutionToken = Object.freeze({[invocationBrand]: true as const, id: createId("invocation")});
        const controller = new AbortController();
        const reservation = reserveAgentThreadWork(binding.store, kind === "taskWrapup" ? {kind, threadId, taskId: taskId!} :
            kind === "contextCompaction" ? {kind, threadId, invocationId: token.id} :
            {kind: "model", threadId, invocationId: token.id}, controller);
        // Feedback initialization is private until the complete reservation is published.
        let resolveDone!: () => void;
        let rejectDone!: (cause: unknown) => void;
        const done = new Promise<void>((resolve, reject) => {resolveDone = resolve; rejectDone = reject;});
        const entry: Invocation = {token, controller, done, stopping: false, kind, systemOnly,
            feedback: owner.feedbackOwner.begin(token.id, threadId)};
        owner.invocation = entry;
        owner.error = undefined;
        if (submitted) owner.attempts = [...owner.attempts, submitted];
        owner.lastFeedback = {token, invocation: entry.feedback};
        publish(threadId, owner);
        void (async () => {
            let finishedNormally = false;
            try {
                await initialize();
                // Closing admission or stopping a reserved preparation never dispatches later.
                if (!controller.signal.aborted) await operation(entry);
                else {
                    if (submitted) patchAttempt(threadId, submitted.admission.userMessageId,
                        {phase: "failed", error: "发送已停止"});
                    // A stopped queue dispatch keeps its items, but never sends them on its own.
                    if (kind === "queue") await holdPendingInputs(binding.store, threadId, "stopped");
                }
                resolveDone();
                finishedNormally = true;
            } catch (cause) {
                // Error content is retained by the concrete operation/durable run, never by a toast callback.
                // A silent drain that met another page's lock is not a user-visible failure of this page.
                if (cause instanceof ThreadLockBusyError) {
                    if (!quiet) owner.error = cause.message;
                } else owner.error ??= "执行未完成";
                if (submitted && attemptFor(threadId, submitted.admission.userMessageId).phase === "preparing") {
                    patchAttempt(threadId, submitted.admission.userMessageId, {phase: "failed", error: "未发送"});
                }
                rejectDone(cause);
            } finally {
                // Original operation includes the actual writer flush/settlement, not an abort acknowledgement.
                if (owner.invocation === entry) {
                    entry.feedback.release();
                    owner.invocation = undefined;
                    publish(threadId, owner);
                }
                // Invocation, work slot and lock are released only after the original completion; the next queued
                // item starts only after a clean end that no Stop touched and that left no error behind.
                if (finishedNormally && !entry.stopping && !owner.error && DRAINING_KINDS.has(kind)) scheduleDrain(threadId, entry.systemOnly);
            }
        })();
        reservation.follow(done);
        void done.catch(() => undefined);
        return Object.freeze({threadId, token, done: reservation.work.done});
    }
    async function checkAttempt(attempt: ChatSubmissionAttempt, feedback?: ExecutionFeedbackInvocation) {
        const status = await readAgentAdmission(admissionInput(attempt), binding.store);
        if (status.status === "accepted") {
            feedback?.admitted(status.run);
            patchAttempt(attempt.threadId, attempt.admission.userMessageId, {phase: "accepted",
                recoveryRequired: status.run.status === "running", error: undefined});
        }
        return status;
    }
    async function recordSubmissionFailure(attempt: ChatSubmissionAttempt, entry: Invocation, cause: unknown) {
        const uncertain = cause instanceof StorageError && cause.certainty === "unknown";
        patchAttempt(attempt.threadId, attempt.admission.userMessageId, {phase: uncertain ? "uncertain" : "failed",
            error: uncertain ? "发送未确认" : "未发送"});
        if (uncertain) {
            try {await checkAttempt(attempt, entry.feedback);} catch { /* Failed/absent reads never prove rollback. */ }
        }
    }
    async function send(attempt: ChatSubmissionAttempt, entry: Invocation, retry = false) {
        const modelMetadata = attempt.modelMetadata;
        const id = attempt.admission.userMessageId;
        let admitted = false;
        try {
            if (retry) {
                const receipt = await checkAttempt(attempt, entry.feedback);
                if (receipt.status === "accepted") return; // Positive receipt is not dispatch permission.
                if (receipt.status !== "absent") {
                    patchAttempt(attempt.threadId, id, {phase: "uncertain", error: "发送记录不一致"});
                    return;
                }
            }
            entry.controller.signal.throwIfAborted();
            const connector = await resolveConnector(attempt.connector.id, binding.store);
            if (!connector) throw new Error("原连接已删除，请恢复连接后处理发送内容");
            const identity = connectorRunIdentity(connector);
            if (identity.id !== attempt.connector.id || identity.definitionId !== attempt.connector.definitionId ||
                identity.baseUrl !== new URL(attempt.connector.baseUrl).toString().replace(/\/+$/, "")) throw new Error("原连接已更改，请恢复草稿后重新发送");
            entry.controller.signal.throwIfAborted();
            const checked = await executeNewChatMessage({threadId: attempt.threadId, admission: attempt.admission,
                content: attempt.submitted.text.trim(), attachments: attempt.submitted.attachments,
                activeThread: attempt.createdThread, originThreadId: attempt.originThreadId, connector,
                model: attempt.model, taskMode: attempt.taskMode, projectId: attempt.projectId,
                interactionMode: attempt.interactionMode, reasoningEffort: attempt.reasoningEffort, modelMetadata,
                controller: entry.controller, feedback: entry.feedback,
                isCurrent: () => state(attempt.threadId).invocation === entry && !entry.controller.signal.aborted,
                onThreadReady: thread => patchAttempt(attempt.threadId, id, {createdThread: thread}),
                onAdmitted: () => {admitted = true; patchAttempt(attempt.threadId, id, {phase: "accepted", error: undefined});}
            }, binding);
            if (!admitted) patchAttempt(attempt.threadId, id, {phase: "failed",
                error: !checked.ok && !checked.aborted ? checked.message : "发送已停止"});
        } catch (cause) {
            if (!admitted) await recordSubmissionFailure(attempt, entry, cause);
            // Do not expose a raw connector/provider/storage exception through the service snapshot.
            throw cause;
        }
    }
    function submit(input: {attempt: ChatSubmissionAttempt; modelMetadata?: ChatModelMetadata; afterOptimisticPaint?: Promise<void>}) {
        const modelMetadata = input.modelMetadata ? Object.freeze(structuredClone(input.modelMetadata)) : undefined;
        const attempt = freezeAttempt({...input.attempt, modelMetadata, phase: "preparing", error: undefined});
        if (state(attempt.threadId).attempts.some(item => item.admission.userMessageId === attempt.admission.userMessageId)) throw new Error("发送内容已提交，请使用原发送记录");
        return claim(attempt.threadId, "submit", async entry => {
            await input.afterOptimisticPaint;
            if (entry.controller.signal.aborted) {patchAttempt(attempt.threadId, attempt.admission.userMessageId, {phase: "failed", error: "发送已停止"}); return;}
            await send(attempt, entry);
        }, attempt);
    }
    function retrySubmission(input: {threadId: string; userMessageId: string}) {
        const attempt = attemptFor(input.threadId, input.userMessageId);
        if (attempt.phase !== "failed") throw new Error("只有确认未发送的内容可以重试，请先核对发送状态");
        return claim(input.threadId, "submit", async entry => {
            patchAttempt(input.threadId, input.userMessageId, {phase: "preparing", error: undefined});
            await send(attempt, entry, true);
        });
    }
    function runAction(input: {threadId: string; runId: string; action: RunAction; callId?: string}) {
        return claim(input.threadId, "decision", async entry => {
            const checked = await resolveChatRunAction({...input, controller: entry.controller, feedback: entry.feedback,
                isCurrent: () => state(input.threadId).invocation === entry && !entry.controller.signal.aborted}, binding);
            if (checked && !checked.ok && !checked.aborted) state(input.threadId).error = checked.message;
        });
    }
    function dispatchFailure(cause: unknown): string {
        const message = cause instanceof Error && cause.message ? cause.message : "发送失败";
        return message.length > MAX_DISPATCH_ERROR ? `${message.slice(0, MAX_DISPATCH_ERROR)}…` : message;
    }
    /** Settings a queued item is delivered with: frozen for user items, the thread's latest for system items (D7). */
    async function queuedSettings(item: AgentPendingInput) {
        if (item.submit) return {...item.submit, frozen: true as const};
        const thread = await binding.store.chatThreads.get(item.threadId);
        if (!thread?.connectorId || !thread.model) throw new Error("找不到此对话最近使用的连接和模型，请手动发送");
        const selection = thread.reasoningSelection;
        const submit: AgentPendingInputSubmit = {
            connector: {id: thread.connectorId, definitionId: "", baseUrl: ""}, model: thread.model,
            reasoningEffort: selection?.connectorId === thread.connectorId && selection.model === thread.model ? selection.value : undefined,
            interactionMode: thread.interactionMode ?? "smart", taskMode: thread.taskMode === true
        };
        return {...submit, frozen: false as const};
    }
    /**
     * Delivers one queued item as a fresh turn under the already claimed invocation. The begin transaction deletes
     * the row, so a repeated or cross-tab dispatch can only deliver once. Not delivered means it stays visible
     * (held on failure), never lost and never silently resent.
     */
    async function dispatchItem(entry: Invocation, threadId: string, itemId: string, explicit: boolean) {
        const store = binding.store;
        const fail = (message: string) => {if (explicit) state(threadId).error = message;};
        const item = await store.agentPendingInputs.get(itemId);
        if (!item || item.threadId !== threadId) {
            if (explicit) throw new PendingInputConflictError("gone");
            return;
        }
        // The row may have been held (Stop, failure) after the drain picked it: only an explicit send delivers held cards.
        if (!explicit && (item.status !== "queued" || entry.systemOnly && item.source !== "system")) return;
        const blockers = (await store.agentRuns.where("threadId").equals(threadId).toArray()).filter(runBlocksThread);
        if (blockers.some(run => run.status === "running" || run.status === "waiting_approval")) {
            // Waiting for approval or another page's run: the card stays queued until that run ends.
            fail(blockers.some(run => run.status === "waiting_approval") ? "等待审批，处理完成后再发送" : "此对话已有执行，请等待完成后再发送");
            return;
        }
        if (blockers.length) {
            // Interrupted/failed work with saved tool steps holds the thread. Only an explicit send ends it (D3).
            if (!explicit) return;
            await withThreadRunLock(threadId, async () => {
                for (const run of blockers) await cancelAgentRun(run.id, store);
            }, binding.locks, store);
        }
        if (entry.controller.signal.aborted) {await holdPendingInputs(store, threadId, "stopped"); return;}
        let admitted = false;
        try {
            const settings = await queuedSettings(item);
            const connector = await resolveConnector(settings.connector.id, store);
            if (!connector) throw new Error("原连接已删除，请恢复连接后处理待发送消息");
            const identity = connectorRunIdentity(connector);
            if (settings.frozen && (identity.id !== settings.connector.id || identity.definitionId !== settings.connector.definitionId ||
                identity.baseUrl !== new URL(settings.connector.baseUrl).toString().replace(/\/+$/, ""))) throw new Error("原连接已更改，请恢复连接配置或重新发送");
            const admission: ChatAdmissionIdentity = {runId: item.runId, userMessageId: item.userMessageId, assistantMessageId: item.assistantMessageId};
            const receipt = await readAgentAdmission({threadId, admission, connector: identity, model: settings.model,
                content: item.content, attachments: item.attachments, projectId: item.projectId}, store);
            if (receipt.status === "accepted") { // A positive receipt is never dispatch permission; only tidy the stale row.
                try {await removePendingInput(item.id, undefined, store);} catch (cause) {if (!(cause instanceof PendingInputConflictError)) throw cause;}
                return;
            }
            if (receipt.status !== "absent") {
                await holdPendingInput(item.id, "uncertain", "发送记录不一致", store);
                fail("待发送消息的发送记录不一致，请核对后处理");
                return;
            }
            entry.controller.signal.throwIfAborted();
            const checked = await executeNewChatMessage({threadId, admission, content: item.content,
                attachments: item.attachments ? item.attachments.map(reference => ({...reference})) : [],
                originThreadId: threadId, connector, model: settings.model, taskMode: settings.taskMode, projectId: item.projectId,
                interactionMode: settings.interactionMode, reasoningEffort: settings.reasoningEffort, modelMetadata: settings.modelMetadata,
                controller: entry.controller, feedback: entry.feedback,
                isCurrent: () => state(threadId).invocation === entry && !entry.controller.signal.aborted,
                onAdmitted: () => {admitted = true;},
                pendingInput: {id: item.id, revision: item.revision}}, binding);
            if (!admitted) {
                if (entry.controller.signal.aborted || !checked.ok && checked.aborted) await holdPendingInputs(store, threadId, "stopped");
                else {
                    const message = !checked.ok ? checked.message : "发送已停止";
                    await holdPendingInput(item.id, "dispatch_failed", message, store);
                    fail(message);
                }
            }
        } catch (cause) {
            if (cause instanceof ThreadLockBusyError) throw cause; // Another page runs this thread: leave the card as it is.
            if (cause instanceof PendingInputConflictError) {
                // Edited or removed while being claimed: nothing was delivered. A drain simply picks the next state up.
                fail(cause.message);
                return;
            }
            if (!admitted) {
                if (entry.controller.signal.aborted) await holdPendingInputs(store, threadId, "stopped");
                else {
                    const uncertain = cause instanceof StorageError && cause.certainty === "unknown";
                    await holdPendingInput(item.id, uncertain ? "uncertain" : "dispatch_failed", uncertain ? "发送未确认" : dispatchFailure(cause), store);
                }
            }
            throw cause;
        }
    }
    function claimQueueItem(threadId: string, itemId: string, explicit: boolean, systemOnly = false) {
        // Only an explicit card send reports its failure; a scheduled drain gives up quietly.
        return claim(threadId, "queue", entry => dispatchItem(entry, threadId, itemId, explicit), undefined, undefined, systemOnly, !explicit);
    }
    async function drain(threadId: string, systemOnly: boolean): Promise<AgentExecutionHandle | undefined> {
        if (!admissionOpen) return undefined;
        const owner = state(threadId);
        if (owner.invocation) return undefined;
        const item = await nextQueuedInput(threadId, {systemOnly}, binding.store);
        if (!item) return undefined;
        const runs = await binding.store.agentRuns.where("threadId").equals(threadId).toArray();
        if (runs.some(runBlocksThread)) return undefined;
        if (!admissionOpen || owner.invocation || currentAgentThreadWork(binding.store, threadId)) return undefined;
        try {
            return claimQueueItem(threadId, item.id, false, systemOnly);
        } catch {
            return undefined; // Another command took the thread first.
        }
    }
    function scheduleDrain(threadId: string, systemOnly = false) {
        if (!admissionOpen) return;
        void drain(threadId, systemOnly).catch(() => undefined);
    }
    subscribeAgentThreadWork(binding.store, () => {
        for (const [threadId, owner] of threads) publish(threadId, owner);
    });
    return {
        initialize,
        prepareTaskWrapup(input: {threadId: string; taskId: string; connectorId: string; model: string;
            reasoningEffort?: AgentReasoningEffort; modelMetadata?: ChatModelMetadata}) {
            const captured = {...input, modelMetadata: input.modelMetadata ? structuredClone(input.modelMetadata) : undefined};
            return claim(input.threadId, "taskWrapup", async entry => {
                const task = await binding.store.agentTasks.get(captured.taskId);
                if (!task || task.threadId !== captured.threadId) throw new Error("任务归属已变化");
                const connector = await resolveConnector(captured.connectorId, binding.store);
                if (!connector) throw new Error("连接不存在，请重新配置");
                if (entry.controller.signal.aborted) return;
                await prepareTaskWrapup(captured.taskId, connector, captured.model, entry.controller, binding.fetchImpl,
                    captured.reasoningEffort, captured.modelMetadata, binding.locks, binding.store, id => {
                        entry.wrapupId = id; publish(input.threadId, state(input.threadId));
                    });
            }, undefined, input.taskId);
        },
        /** Explicit "compact now"; typed failures surface as the snapshot error, the result is the saved record. */
        compactContext(input: {threadId: string; connectorId: string; model: string; reasoningEffort?: AgentReasoningEffort;
            modelMetadata?: ChatModelMetadata}) {
            const captured = {...input, modelMetadata: input.modelMetadata ? structuredClone(input.modelMetadata) : undefined};
            return claim(input.threadId, "contextCompaction", async entry => {
                const connector = await resolveConnector(captured.connectorId, binding.store);
                if (!connector) {state(input.threadId).error = "连接不存在，请重新配置"; return;}
                if (entry.controller.signal.aborted) return;
                try {
                    await compactThreadNow({threadId: captured.threadId, connector, model: captured.model, reasoningEffort: captured.reasoningEffort,
                        modelMetadata: captured.modelMetadata, controller: entry.controller, fetchImpl: binding.fetchImpl,
                        locks: binding.locks, store: binding.store});
                } catch (cause) {
                    if (!(cause instanceof ManualCompactionError)) throw cause;
                    if (cause.code !== "cancelled") state(input.threadId).error = cause.message;
                }
            });
        },
        snapshot: (threadId: string): AgentExecutionSnapshot => state(threadId).snapshot,
        subscribe(threadId: string, listener: () => void) {
            const owner = state(threadId);
            owner.listeners.add(listener);
            return () => {owner.listeners.delete(listener);};
        },
        attemptsForScope(scope: string) {
            let snapshot = scopeSnapshots.get(scope);
            if (!snapshot) {
                snapshot = Object.freeze([...threads.values()].flatMap(entry => entry.attempts).filter(attempt => attempt.submitted.scope === scope));
                scopeSnapshots.set(scope, snapshot);
            }
            return snapshot;
        },
        subscribeScope(scope: string, listener: () => void) {
            let listeners = scopeListeners.get(scope);
            if (!listeners) {listeners = new Set(); scopeListeners.set(scope, listeners);}
            listeners.add(listener); return () => {listeners.delete(listener);};
        },
        /** Queue a message while a run is active (or the thread is blocked). It never interrupts the run. */
        enqueue(input: {threadId: string; content?: string; attachments?: readonly ReferenceAttachment[]; mode?: AgentPendingInputMode;
            admission: ChatAdmissionIdentity; submit: AgentPendingInputSubmit}) {
            if (!admissionOpen) throw new Error("应用正在退出，暂时无法开始执行");
            return enqueueUserInput(input, binding.store);
        },
        editPending: (input: {id: string; expectedRevision: number; content: string}) =>
            editPendingInput(input.id, input.expectedRevision, {content: input.content}, binding.store),
        removePending: (input: {id: string; expectedRevision?: number}) => removePendingInput(input.id, input.expectedRevision, binding.store),
        setPendingMode: (input: {id: string; expectedRevision: number; mode: AgentPendingInputMode}) =>
            setPendingMode(input.id, input.expectedRevision, input.mode, binding.store),
        movePending: (input: {id: string; direction: "up" | "down"}) => movePendingInput(input.id, input.direction, binding.store),
        /**
         * "Send now" for one card (queued or held). A thread held by interrupted/failed work with saved tool calls is
         * ended first (D3); a running or approval-waiting thread keeps the card and reports why in the snapshot error.
         */
        dispatchPending: (input: {threadId: string; id: string}) => claimQueueItem(input.threadId, input.id, true),
        /** Delivers the next queued item if the thread is idle and unblocked; held items are never touched. */
        drainQueue: (threadId: string) => drain(threadId, false),
        submit, retrySubmission,
        retry(input: {threadId: string; runId: string}) {
            return claim(input.threadId, "retry", async entry => {
                const checked = await retryFrozenChatRun({...input, controller: entry.controller, feedback: entry.feedback,
                    isCurrent: () => state(input.threadId).invocation === entry && !entry.controller.signal.aborted}, binding);
                if (!checked.ok && !checked.aborted) state(input.threadId).error = checked.message;
            });
        },
        resolveApproval: (input: {threadId: string; runId: string; callId: string; decision: "approve" | "reject"}) =>
            runAction({...input, action: input.decision}),
        resume: (input: {threadId: string; runId: string}) => runAction({...input, action: "resume"}),
        cancelSavedRun: (input: {threadId: string; runId: string}) => runAction({...input, action: "cancel"}),
        checkAdmission(input: {threadId: string; userMessageId: string}) {
            const attempt = attemptFor(input.threadId, input.userMessageId);
            if (attempt.phase !== "uncertain") throw new Error("此发送记录不需要核对状态");
            return claim(input.threadId, "check", async () => {
                patchAttempt(input.threadId, input.userMessageId, {phase: "checking"});
                try {
                    const status = await checkAttempt(attempt);
                    if (status.status !== "accepted") patchAttempt(input.threadId, input.userMessageId,
                        {phase: "uncertain", error: "仍未确认"});
                } catch {
                    patchAttempt(input.threadId, input.userMessageId, {phase: "uncertain", error: "检查失败，请重试"});
                }
            });
        },
        /**
         * User exit for an unresolved send: the user asserts the message was not delivered. This only makes the
         * frozen attempt actionable; a later retry still performs the positive admission read first, so an
         * actually-committed run is adopted rather than duplicated.
         */
        confirmNotSent(input: {threadId: string; userMessageId: string}): boolean {
            const owner = threads.get(input.threadId);
            const attempt = owner?.attempts.find(item => item.admission.userMessageId === input.userMessageId);
            if (!owner || !attempt || owner.invocation || attempt.phase !== "uncertain") return false;
            patchAttempt(input.threadId, input.userMessageId, {phase: "failed", error: "未发送"});
            return true;
        },
        recoverAdmissionState(input: {threadId: string; userMessageId: string}) {
            const attempt = attemptFor(input.threadId, input.userMessageId);
            if (attempt.phase !== "accepted" || !attempt.recoveryRequired) throw new Error("此发送记录不需要恢复状态");
            return claim(input.threadId, "recovery", async entry => {
                // Real lock-aware local recovery only. Never model/tool dispatch.
                try {await withThreadRunLock(input.threadId, () => {
                    if (!entry.controller.signal.aborted) patchAttempt(input.threadId, input.userMessageId, {recoveryRequired: false, error: undefined});
                    return Promise.resolve();
                }, binding.locks, binding.store);
                } catch (cause) {patchAttempt(input.threadId, input.userMessageId, {error: "恢复失败，请重试"}); throw cause;}
            });
        },
        requestStop(input: {threadId: string; token: AgentExecutionToken}): boolean {
            const owner = threads.get(input.threadId), entry = owner?.invocation;
            if (!owner || !entry || entry.token !== input.token || entry.stopping) return false;
            entry.stopping = true;
            entry.feedback.requestStop();
            publish(input.threadId, owner);
            entry.controller.abort();
            return true;
        },
        requestWorkStop(input: {threadId: string; work: AgentThreadWork}): boolean {
            if (currentAgentThreadWork(binding.store, input.threadId) !== input.work || input.work.controller.signal.aborted) return false;
            input.work.controller.abort();
            publish(input.threadId, state(input.threadId));
            return true;
        },
        /** Content-free timing marks of this thread's recent invocations (bounded by the feedback controller). */
        feedbackTimeline(threadId: string) {
            return threads.get(threadId)?.feedbackOwner.timeline() ?? [];
        },
        feedback(threadId: string, token: AgentExecutionToken): ExecutionFeedbackInvocation | undefined {
            const feedback = threads.get(threadId)?.lastFeedback;
            return feedback?.token === token ? feedback.invocation : undefined;
        },
        /** Repeated view observations may outlive the ephemeral attempt they already removed. */
        dismissAttempt(input: {threadId: string; userMessageId: string}) {
            const owner = threads.get(input.threadId);
            const attempt = owner?.attempts.find(item => item.admission.userMessageId === input.userMessageId);
            // Observation cleanup is idempotent; retry/check/recovery still use
            // the strict lookup and preserve their exact action authority.
            if (!owner || !attempt || owner.invocation || attempt.phase === "uncertain" || attempt.phase === "checking" || attempt.recoveryRequired) return false;
            owner.attempts = owner.attempts.filter(item => item !== attempt);
            publish(input.threadId, owner);
            return true;
        },
        shutdown(): Promise<void> {
            if (shutdownPromise) return shutdownPromise;
            admissionOpen = false;
            let resolveShutdown!: () => void;
            shutdownPromise = new Promise<void>(resolve => {resolveShutdown = resolve;});
            const current = [...threads.entries()].flatMap(([threadId, owner]) => owner.invocation ? [{threadId, owner, entry: owner.invocation}] : []);
            for (const {threadId, owner, entry} of current) {
                if (!entry.stopping) {
                    entry.stopping = true;
                    entry.feedback.requestStop();
                    publish(threadId, owner);
                    entry.controller.abort();
                }
            }
            void Promise.allSettled([...current.map(({entry}) => entry.done), shutdownAgentThreadWork(binding.store)]).then(resolveShutdown);
            return shutdownPromise;
        }
    };
}
export type AgentExecutionService = ReturnType<typeof createAgentExecutionService>;
