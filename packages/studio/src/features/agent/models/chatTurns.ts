import type {AgentRun} from "./agent";
import type {ChatMessage} from "./chat";

/** True when a user turn was created after the run, making that run stale. */
export function isLaterUserTurn(message: Pick<ChatMessage, "role" | "createdAt">, run: Pick<AgentRun, "createdAt">): boolean {
    return message.role === "user" && message.createdAt > run.createdAt;
}
