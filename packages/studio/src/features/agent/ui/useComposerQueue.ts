import {useProductQueryState} from "../../../platform/product/queries";
import type {AgentPendingInput} from "../models/agentPendingInput";
import {runBlocksThread} from "../models/agentToolSelection";

/**
 * running: a turn is executing in this page, so new cards wait for the next turn and may be steered.
 * blocked: no local invocation, but a saved run still holds the thread (approval, or interrupted work).
 * paused: the queue was held by a stop/failure/interruption and will never be sent on its own.
 * idle: only queued items remain; the drain delivers them after the thread is free.
 */
type ComposerQueueMode = "running" | "blocked" | "paused" | "idle";
/** Why a blocked thread is not delivering: approval parking, or saved work the next send must end. */
type ComposerQueueBlock = "approval" | "resume";

export interface ComposerQueueView {
    status: "loading" | "error" | "ready";
    mode: ComposerQueueMode;
    blocked?: ComposerQueueBlock;
    /** One line explaining why the cards are not being sent. */
    notice?: string;
    items: readonly AgentPendingInput[];
}

const LOADING: ComposerQueueView = {status: "loading", mode: "idle", items: []};

interface QueueRows {
    threadId: string;
    rows: AgentPendingInput[];
    blockers: {status: string; hasToolCalls?: boolean}[];
}

/**
 * Durable pending-send rows for one thread plus the local execution state that decides how the
 * attached cards behave. Reading never sends anything; only an explicit action or the service drain does.
 */
export function useComposerQueue({threadId, active}: {threadId?: string; active: boolean}): ComposerQueueView {
    const state = useProductQueryState<QueueRows | undefined>(async (db) => {
        if (!threadId) return undefined;
        const [rows, runs] = await Promise.all([
            db.agentPendingInputs.where("threadId").equals(threadId).toArray(),
            db.agentRuns.where("threadId").equals(threadId).toArray(),
        ]);
        return {
            threadId,
            rows: [...rows].sort((a, b) => a.position - b.position),
            blockers: runs.filter(runBlocksThread).map(run => ({status: run.status, hasToolCalls: run.hasToolCalls})),
        };
    }, [threadId]);
    if (!threadId) return LOADING;
    if (state.error) return {status: "error", mode: "idle", items: []};
    const value = state.value;
    if (!value || value.threadId !== threadId) return LOADING;
    if (!value.rows.length) return {status: "ready", mode: "idle", items: []};
    const items = value.rows;
    if (active) return {status: "ready", mode: "running", items};
    const approval = value.blockers.some(run => run.status === "waiting_approval");
    if (approval) {
        return {status: "ready", mode: "blocked", blocked: "approval", items, notice: "等待审批，处理完成后再发送"};
    }
    if (value.blockers.length) {
        return {status: "ready", mode: "blocked", blocked: "resume", items, notice: "上次执行未结束，发送前会先结束它"};
    }
    if (items.some(row => row.status === "held")) {
        return {status: "ready", mode: "paused", items, notice: "已停止，未自动发送"};
    }
    return {status: "ready", mode: "idle", items};
}
