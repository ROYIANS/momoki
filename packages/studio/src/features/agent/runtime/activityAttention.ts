import type {AgentRun, AgentTask, AgentToolCall} from "../models/agent";
import type {AgentGenerationJob} from "../models/agentGeneration";
import type {GenerationBatch, GenerationBatchItem} from "../models/agentGenerationBatch";
import type {ChatMessage} from "../models/chat";
import {isLaterUserTurn} from "../models/chatTurns";

export interface ActivityAttention {
    id: string;
    kind: "unknown" | "approval" | "batch";
    label: string;
    detail: string;
    action: string;
    target: { runId: string; callId?: string; batchId?: string };
}

type AttentionInput = {
    threadId: string;
    runs: readonly Pick<AgentRun, "id" | "threadId" | "taskId" | "status" | "hasToolCalls" | "createdAt" | "pauseReason">[];
    calls: readonly Pick<AgentToolCall, "id" | "runId" | "threadId" | "title" | "status">[];
    batches: readonly Pick<GenerationBatch, "id" | "runId" | "threadId" | "taskId" | "title" | "status">[];
    items: readonly Pick<GenerationBatchItem, "batchId" | "threadId" | "state">[];
    jobs: readonly Pick<AgentGenerationJob, "id" | "runId" | "threadId" | "batchId" | "callId" | "status">[];
    tasks: readonly Pick<AgentTask, "id" | "threadId" | "lifecycle">[];
    messages: readonly Pick<ChatMessage, "threadId" | "role" | "createdAt">[];
    projectUnavailable?: boolean;
};

/** Keep durable batch work visible after the model finishes; never suggest resuming stale runs. */
export function selectActivityAttention(input: AttentionInput): ActivityAttention[] {
    const {threadId} = input;
    const runs = input.runs.filter(run => run.threadId === threadId);
    const runIds = new Set(runs.map(run => run.id));
    const calls = input.calls.filter(call => call.threadId === threadId && runIds.has(call.runId));
    const jobs = input.jobs.filter(job => job.threadId === threadId && runIds.has(job.runId));
    const taskClosed = (taskId?: string) => Boolean(taskId && !input.tasks.some(task => task.id === taskId && task.threadId === threadId && task.lifecycle === "open"));
    const result: ActivityAttention[] = [];
    for (const batch of input.batches) {
        if (batch.threadId !== threadId || !runIds.has(batch.runId)) continue;
        const batchJobs = jobs.filter(job => job.batchId === batch.id && job.runId === batch.runId);
        const unknown = batchJobs.some(job => job.status === "unknown");
        const blocked = input.projectUnavailable || taskClosed(batch.taskId);
        const target = {runId: batch.runId, batchId: batch.id};
        if (unknown) {
            result.push({
                id: `batch:${batch.id}`,
                kind: "unknown",
                label: "生成结果待核实",
                detail: `${batch.title}${blocked ? " · 当前仅可查看记录" : " · 请先核实已提交的请求"}`,
                action: "查看批次",
                target
            });
        } else if (!blocked && batch.status === "draft") {
            result.push({
                id: `batch:${batch.id}`,
                kind: "batch",
                label: "待你确认生成",
                detail: `${batch.title} · 确认后可能产生费用`,
                action: "检查并确认",
                target
            });
        } else if (!blocked && ["ready", "paused"].includes(batch.status) && (input.items.some(item => item.threadId === threadId && item.batchId === batch.id && item.state === "queued") || batchJobs.some(job => ["submitting", "submitted", "running", "remote_completed", "downloading"].includes(job.status)))) {
            result.push({
                id: `batch:${batch.id}`,
                kind: "batch",
                label: batch.status === "ready" ? "批次等待开始" : "批次已暂停",
                detail: batch.title,
                action: "查看并继续",
                target
            });
        }
    }
    const unknownCalls = new Set<string>();
    for (const call of calls) {
        if (call.status !== "unknown" && !jobs.some(job => !job.batchId && job.callId === call.id && job.status === "unknown")) continue;
        unknownCalls.add(call.id);
        result.push({
            id: `call:${call.id}`,
            kind: "unknown",
            label: "操作结果待核实",
            detail: call.title,
            action: "查看操作",
            target: {runId: call.runId, callId: call.id}
        });
    }
    for (const run of runs) {
        if (input.projectUnavailable || taskClosed(run.taskId) || !run.hasToolCalls || !["waiting_approval", "interrupted", "failed"].includes(run.status)) continue;
        if (runs.some(other => other.id !== run.id && other.createdAt >= run.createdAt) || input.messages.some(message => message.threadId === threadId && isLaterUserTurn(message, run))) continue;
        const runCalls = calls.filter(call => call.runId === run.id);
        // Approval cannot proceed while an existing operation is unresolved.
        if (runCalls.some(call => unknownCalls.has(call.id) || call.status === "running")) continue;
        const approvals = runCalls.filter(call => call.status === "awaiting_approval");
        for (const call of approvals) result.push({
            id: `call:${call.id}`,
            kind: "approval",
            label: "待批准",
            detail: call.title,
            action: "查看",
            target: {runId: run.id, callId: call.id}
        });
    }
    // Interrupted/failed runs without a pending approval are the turn-problem bubble's job, not this queue's.
    const order = {unknown: 0, approval: 1, batch: 2};
    return result.sort((a, b) => order[a.kind] - order[b.kind]);
}
