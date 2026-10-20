import {canResumeAgentRun} from "../commands/agentTools";
import type {AgentRun, AgentToolCall} from "../models/agent";

/** Calls whose approval is a reviewed form (paid generation, music), not a plain approve/reject decision. */
export function isReviewedCall(call: Pick<AgentToolCall, "name">): boolean {
    return call.name === "submit_generation" || call.name === "music_generate";
}

export interface RunActionState {
    recoverable: boolean;
    unknown: boolean;
    executing: boolean;
    pendingApproval: boolean;
    budgetPaused: boolean;
    /** The saved steps may be continued: nothing unresolved and nothing waiting for a decision. */
    canResume: boolean;
    /** A pending call may be decided now: no operation is unresolved or still executing. */
    canDecide: boolean;
}

/** One source for the approval/recovery predicates shared by the message status text and the composer cards. */
export function runActionState(run: AgentRun, calls: readonly Pick<AgentToolCall, "status">[]): RunActionState {
    const unknown = calls.some(call => call.status === "unknown");
    const executing = calls.some(call => call.status === "running");
    const pendingApproval = calls.some(call => call.status === "awaiting_approval");
    const recoverable = canResumeAgentRun(run);
    return {
        recoverable, unknown, executing, pendingApproval,
        budgetPaused: run.status === "interrupted" && run.pauseReason === "model_step_limit",
        canResume: recoverable && !unknown && !pendingApproval,
        canDecide: recoverable && !unknown && !executing,
    };
}

/** True when the composer approval card (not an inline review form) owns this call's decision. */
export function isCardApproval(state: RunActionState, call: Pick<AgentToolCall, "name" | "status">): boolean {
    return call.status === "awaiting_approval" && state.canDecide && !isReviewedCall(call);
}
