import type {AgentRun} from "./agent";
import type {ChatMessage} from "./chat";

/** True when a user turn was created after the run, making that run stale; a row steered into this very run does not. */
export function isLaterUserTurn(message: Pick<ChatMessage, "role" | "createdAt" | "steeredIntoRunId">, run: Pick<AgentRun, "createdAt" | "id">): boolean {
    return message.role === "user" && message.createdAt > run.createdAt && message.steeredIntoRunId !== run.id;
}
