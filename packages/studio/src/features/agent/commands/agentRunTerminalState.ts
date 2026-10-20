import {publishAssistantActivity} from "./threadActivity";
import type {ThreadActivityIdentity} from "../models/threadActivity";
import {canSettleRun} from '@momoki/agent-core';
import type {StoreTx} from "../../../platform/storage/types";
import type {AgentRun, AgentRunOutput, AgentRunStatus} from "../models/agent";
import {nowIso} from "../../../platform/identity";
import type {AgentPendingInputHeldReason} from "../models/agentPendingInput";
import {holdPendingInputs} from "./agentPendingInputs";

const SETTLED_MESSAGE_STATUS = {
    completed: "complete",
    failed: "error",
    cancelled: "aborted",
    interrupted: "interrupted"
} as const;

const HOLD_REASON: Partial<Record<AgentRunStatus, AgentPendingInputHeldReason>> = {
    cancelled: "stopped", failed: "failed", interrupted: "interrupted"
};

/**
 * The one writer for a run's terminal state, shared by every caller that ends an
 * execution. Callers supply their own transaction so the ledger mutation, the run
 * record and the assistant message settle together; nothing else may write these
 * fields by hand.
 */
export async function settleRun(db: StoreTx, runId: string, status: Exclude<AgentRunStatus, "running" | "waiting_approval">, options: {
    activity: ThreadActivityIdentity | undefined;
    output?: AgentRunOutput;
    error?: string;
    finishReason?: string;
    pauseReason?: AgentRun["pauseReason"];
    /** Keep the visible answer text and reasoning instead of overwriting it with `output`. */
    preserveOutput?: boolean;
    /** A notice addressed to the reader only; the run record keeps `error` unchanged. */
    messageError?: string;
    /** Source states this transition accepts. Resumable runs may also be ended explicitly. */
    allowedFrom?: readonly AgentRunStatus[];
}): Promise<boolean> {
    const run = await db.agentRuns.get(runId);
    if (!run || !canSettleRun(run.status,options.allowedFrom)) return false;
    if (!options.activity) throw new Error("公开结束状态缺少对话阅读标识");
    const message = await db.chatMessages.get(run.assistantMessageId);
    if (!message || message.runId !== run.id) throw new Error("执行消息不存在");
    const at = nowIso();
    // A caller that supplies output owns the answer text and the closing reasoning timing.
    // An empty final attempt must not erase already-visible text from an earlier step.
    const content = options.output?.content ?? "";
    const outputPatch = options.preserveOutput ? {} : {content: content || message.content, error: undefined};
    const timingPatch = options.preserveOutput || options.output === undefined
        ? {} : {
            reasoning: options.output.reasoning || message.reasoning,
            reasoningDurationMs: options.output.reasoningDurationMs ?? message.reasoningDurationMs
        };
    await db.chatMessages.update(message.id, {
        ...outputPatch, ...timingPatch,
        status: SETTLED_MESSAGE_STATUS[status],
        error: options.messageError ?? options.error,
    });
    await db.agentRuns.update(run.id, {
        status,
        error: options.error,
        finishReason: options.finishReason,
        // Only an explicit pause keeps a pause reason; every terminal state clears it.
        ...(options.pauseReason === undefined ? {pauseReason: undefined} : {pauseReason: options.pauseReason}),
        updatedAt: at,
        endedAt: at,
    });
    // Queued follow-ups never outlive a stop/failure/interruption as auto-sendable items. Ending an already
    // interrupted/failed run again does not count: its queue was held when it first stopped.
    const reason = HOLD_REASON[status];
    if (reason && (run.status === "running" || run.status === "waiting_approval")) await holdPendingInputs(db, run.threadId, reason);
    await publishAssistantActivity(options.activity, run, db);
    return true;
}

