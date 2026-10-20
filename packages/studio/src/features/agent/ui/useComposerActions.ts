import {useProductQuery} from "../../../platform/product/queries";
import type {AgentRun, AgentToolCall} from "../models/agent";
import type {AgentGenerationStatus} from "../models/agentGeneration";
import type {GenerationBatch} from "../models/agentGenerationBatch";
import {readGenerationBatch} from "../commands/agentGenerationBatches";
import {isLaterUserTurn} from "../models/chatTurns";
import {isCardApproval, runActionState, type RunActionState} from "../runtime/runActionState";

export interface ApprovalCardData {
    kind: "approval";
    run: AgentRun;
    call: AgentToolCall;
    /** Pending decisions of this run including this one; shown as "1/N". */
    position: number;
    total: number;
}

export interface RecoveryCardData {
    kind: "recovery";
    run: AgentRun;
    state: RunActionState;
}

/** What a generation batch is waiting for, derived the same way the review surface derives it. */
export interface BatchCardData {
    kind: "batch";
    batch: GenerationBatch;
    draft: boolean;
    running: boolean;
    queued: number;
    active: number;
    failed: number;
    unknown: boolean;
    downloaded: number;
    selectedCount: number;
    /** Chosen candidates not yet written to their targets. */
    pendingWrites: number;
    readOnly: boolean;
}

export type ComposerActionData = ApprovalCardData | RecoveryCardData | BatchCardData;

const WORKING = new Set<AgentGenerationStatus>(["submitting", "submitted", "running", "remote_completed", "downloading"]);

/** A batch needs a card only while something waits on the user: confirm, resume, write, or look at results. */
function batchCard(batch: GenerationBatch, detail: Awaited<ReturnType<typeof readGenerationBatch>>, readOnly: boolean,
                   latest: boolean): BatchCardData | undefined {
    const {items, jobs} = detail;
    const queued = items.filter(item => item.state === "queued").length;
    const active = jobs.filter(job => WORKING.has(job.status)).length;
    const failed = jobs.filter(job => job.status === "failed").length;
    const downloaded = jobs.filter(job => job.result).length;
    const selectedCount = Object.keys(batch.selections).length;
    const applied = items.filter(item => {
        const job = jobs.find(candidate => candidate.id === item.jobId);
        return job?.result && detail.currentMedia[item.targetKey] === job.result.mediaId;
    }).length;
    const card: BatchCardData = {
        kind: "batch", batch, draft: batch.status === "draft", running: batch.status === "running", queued, active, failed,
        unknown: jobs.some(job => job.status === "unknown"), downloaded, selectedCount,
        pendingWrites: Math.max(0, selectedCount - applied), readOnly,
    };
    // A failure keeps asking only while it is the newest batch; older ones stay readable in the message.
    const waiting = card.draft || card.running || queued > 0 || active > 0 || card.pendingWrites > 0 || (latest && failed > 0);
    // Finished results nobody has looked at yet: nudge for the newest batch only, never for old threads' history.
    const unreviewed = latest && downloaded > 0 && selectedCount === 0;
    return waiting || unreviewed ? card : undefined;
}

/**
 * The approval and resume/end cards of a thread. Only the newest run is actionable, mirroring the
 * "stale run" rule the commands enforce, so a card never offers an action that would be refused.
 * Calls are shown one at a time in saved order; deciding one reveals the next.
 */
export function useComposerActions({threadId, readOnly}: {threadId?: string; readOnly?: boolean}): ComposerActionData[] {
    const state = useProductQuery(async db => {
        if (!threadId) return undefined;
        const [runs, calls, messages, batches] = await Promise.all([
            db.agentRuns.where("threadId").equals(threadId).toArray(),
            db.agentToolCalls.where("threadId").equals(threadId).toArray(),
            db.chatMessages.where("threadId").equals(threadId).toArray(),
            db.agentGenerationBatches.where("threadId").equals(threadId).sortBy("createdAt"),
        ]);
        const cards: BatchCardData[] = [];
        for (const [index, batch] of batches.entries()) {
            try {
                const detail = await readGenerationBatch(batch.id, threadId, db);
                const task = batch.taskId ? await db.agentTasks.get(batch.taskId) : undefined;
                const card = batchCard(batch, detail, Boolean(batch.taskId && task?.lifecycle !== "open"),
                    index === batches.length - 1);
                if (card) cards.push(card);
            } catch { /* An unreadable batch keeps its in-message status; it must not hide the other cards. */ }
        }
        return {threadId, runs, calls, messages, batchCards: cards};
    }, [threadId]);
    if (!threadId || readOnly || !state || state.threadId !== threadId) return [];
    const cards: ComposerActionData[] = [];
    for (const run of state.runs) {
        if (run.threadId !== threadId || !run.hasToolCalls) continue;
        if (state.runs.some(other => other.id !== run.id && other.createdAt >= run.createdAt)) continue;
        if (state.messages.some(message => isLaterUserTurn(message, run))) continue;
        const calls = state.calls.filter(call => call.runId === run.id && call.threadId === run.threadId)
            .sort((a, b) => a.step - b.step || a.order - b.order);
        const actions = runActionState(run, calls);
        const pending = calls.filter(call => isCardApproval(actions, call));
        pending.forEach((call, index) => cards.push({kind: "approval", run, call, position: index + 1, total: pending.length}));
        if (actions.recoverable && !pending.length) cards.push({kind: "recovery", run, state: actions});
    }
    cards.push(...state.batchCards);
    return cards;
}
