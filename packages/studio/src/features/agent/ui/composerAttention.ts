import {useProductQuery} from "../../../platform/product/queries";
import type {AgentTask} from "../models/agent";
import {selectActivityAttention} from "../runtime/activityAttention";
import {isReviewedCall} from "../runtime/runActionState";
import {getTaskDisplayState} from "../runtime/taskState";
import {isCardApproval, runActionState} from "../runtime/runActionState";
import {useAgentActivityNavigation} from "./AgentActivityNavigation";

/** One composer decision: the action name, the target, and the existing queue action. */
export interface ComposerDecision {
    id: string;
    title: string;
    detail: string;
    action: string;
    onAction: () => void;
}

export interface ComposerAttentionView {
    status: "loading" | "error" | "ready";
    items: ComposerDecision[];
}

/**
 * The approval/confirmation queue already attached to the composer.
 * Navigation only: the card never approves or executes work itself.
 */
export function useComposerAttention({threadId, task, projectUnavailable, onOpenTask}: {
    threadId?: string;
    task?: AgentTask;
    projectUnavailable: boolean;
    onOpenTask: () => void;
}): ComposerAttentionView {
    const {reveal} = useAgentActivityNavigation();
    const state = useProductQuery(async (db) => {
        if (!threadId) return {threadId: "", idle: true as const};
        try {
            const [calls, batches, items, jobs, tasks, runs, messages] = await Promise.all([
                db.agentToolCalls.where("threadId").equals(threadId).toArray(),
                db.agentGenerationBatches.where("threadId").equals(threadId).toArray(),
                db.agentGenerationBatchItems.where("threadId").equals(threadId).toArray(),
                db.agentGenerationJobs.where("threadId").equals(threadId).toArray(),
                db.agentTasks.where("threadId").equals(threadId).toArray(),
                db.agentRuns.where("threadId").equals(threadId).toArray(),
                db.chatMessages.where("threadId").equals(threadId).toArray(),
            ]);
            return {threadId, calls, batches, items, jobs, tasks, runs, messages};
        } catch {
            return {threadId, error: true as const};
        }
    }, [threadId]);
    if (!threadId) return {status: "ready", items: []};
    if (!state || state.threadId !== threadId || "idle" in state) return {status: "loading", items: []};
    if ("error" in state) return {status: "error", items: []};
    // A batch waiting on the user already has its own row above the composer; a second pill for it would repeat it.
    // A proposal waiting for confirmation also has its own row above the composer.
    const proposalIds = new Set(state.calls.filter(call => call.status === "awaiting_approval" && isReviewedCall(call)).map(call => call.id));
    const attention = selectActivityAttention({...state, projectUnavailable})
        .filter(item => !item.target.batchId && !(item.target.callId && proposalIds.has(item.target.callId)));
    // A plain approval is decided on its own action card; the navigation item would only repeat it.
    const coveredByCard = (item: (typeof attention)[number]) => {
        if (item.kind !== "approval" || !item.target.callId) return false;
        const run = state.runs.find(candidate => candidate.id === item.target.runId);
        const call = state.calls.find(candidate => candidate.id === item.target.callId);
        if (!run || !call) return false;
        const runCalls = state.calls.filter(candidate => candidate.runId === run.id);
        return isCardApproval(runActionState(run, runCalls), call);
    };
    const items: ComposerDecision[] = attention.filter(item => !coveredByCard(item)).map(item => ({
        id: item.id,
        title: item.label,
        detail: item.detail,
        action: item.action,
        onAction: () => reveal(item.target),
    }));
    const taskReview = !projectUnavailable && task?.threadId === threadId && task.lifecycle === "open" &&
        getTaskDisplayState(task, state.runs) === "review";
    if (taskReview && task) items.push({
        id: `task:${task.id}`,
        title: "任务待你验收",
        detail: task.title,
        action: "查看",
        onAction: onOpenTask,
    });
    return {status: "ready", items};
}
