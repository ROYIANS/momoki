import {useProductQuery} from "../../../platform/product/queries";
import type {AgentRun, AgentToolCall} from "../models/agent";
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

export type ComposerActionData = ApprovalCardData | RecoveryCardData;

/**
 * The approval and resume/end cards of a thread. Only the newest run is actionable, mirroring the
 * "stale run" rule the commands enforce, so a card never offers an action that would be refused.
 * Calls are shown one at a time in saved order; deciding one reveals the next.
 */
export function useComposerActions({threadId, readOnly}: {threadId?: string; readOnly?: boolean}): ComposerActionData[] {
    const state = useProductQuery(async db => {
        if (!threadId) return undefined;
        const [runs, calls, messages] = await Promise.all([
            db.agentRuns.where("threadId").equals(threadId).toArray(),
            db.agentToolCalls.where("threadId").equals(threadId).toArray(),
            db.chatMessages.where("threadId").equals(threadId).toArray(),
        ]);
        return {threadId, runs, calls, messages};
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
    return cards;
}
