import type {Id} from "../../../platform/identity";
import type {ContextPolicy} from "./context";
import type {ReferenceAttachment} from "../../references/models/references";
import type {AgentSelectedReferences} from "../../references/models/referenceInput";

/** Studio-global Agent chat (not part of project ZIP). */
export type ChatMessageRole = "user" | "assistant" | "system";

export type ChatMessageStatus = "pending" | "streaming" | "complete" | "error" | "aborted" | "interrupted";

export interface ChatThread {
    excludedMemoryIds?: Id[];
    projectId?: Id;
    taskMode?: boolean;
    contextPolicy?: ContextPolicy;
    interactionMode?: import("./agent").AgentInteractionMode;
    reasoningSelection?: {
        connectorId: Id;
        baseUrl: string;
        model: string;
        value?: import("./agent").AgentReasoningEffort
    };
    id: Id;
    title: string;
    connectorId?: Id;
    model?: string;
    createdAt: string;
    updatedAt: string;
}

export interface ChatMessage {
    /** Revision of the exact publicly rendered assistant snapshot. */
    publicRevision?: number;
    attachments?: ReferenceAttachment[];
    referenceContext?: AgentSelectedReferences;
    runId?: Id;
    /** Execution notices are separate from answer content and never sent as history. */
    error?: string;
    id: Id;
    threadId: Id;
    role: ChatMessageRole;
    content: string;
    createdAt: string;
    status?: ChatMessageStatus;
    /** Model chain-of-thought / reasoning text (not re-sent on follow-ups). */
    reasoning?: string;
    /** Wall time from first reasoning delta to first answer content delta. */
    reasoningDurationMs?: number;
    /** Set on queue-injected system rows (not user input). */
    origin?: "system";
    /** Run into which this user row was steered mid-run. */
    steeredIntoRunId?: Id;
    /** Model step the run had completed when the row was delivered; the row sits after that step's output. */
    steeredAfterStep?: number;
    /** Short text shown for system rows. */
    display?: string;
}
