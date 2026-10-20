import type {AgentRun} from "./agent";

export const DISCOVERY_TOOL_NAME = "load_tool_groups";
export {MAX_LOADED_TOOLS,offeredToolNames as getOfferedToolNames,offeredToolNamesForCall as toolNamesForCall} from '@momoki/agent-core';

/**
 * A run that holds its thread: it is either active now, or ended with saved work
 * that the user must resume or end before another message can be accepted.
 * One definition for the UI's leave confirmation and the DB's admission check.
 */
export function runBlocksThread(run: Pick<AgentRun, "status" | "hasToolCalls">): boolean {
    return run.status === "running" || run.status === "waiting_approval" ||
        (Boolean(run.hasToolCalls) && (run.status === "interrupted" || run.status === "failed"));
}
