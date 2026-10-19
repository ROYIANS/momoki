import type {Id} from "../../../platform/identity";
import type {ChatModelMetadata} from "../../settings/models/modelMetadata";
import type {ReferenceAttachment} from "../../references/models/references";
import type {AgentInteractionMode, AgentReasoningEffort} from "./agent";

export type AgentPendingInputSource = "user" | "system";
/** next-turn waits for the run to end; next-step is delivered at the next tool-call boundary. */
export type AgentPendingInputMode = "next-turn" | "next-step";
/** held items stay visible but are never sent automatically. */
export type AgentPendingInputStatus = "queued" | "held";
export type AgentPendingInputHeldReason = "stopped" | "failed" | "interrupted" | "dispatch_failed" | "uncertain";

/** Submit settings frozen when a user item is queued. */
export interface AgentPendingInputSubmit {
    connector: {id: Id; definitionId: string; baseUrl: string};
    model: string;
    reasoningEffort?: AgentReasoningEffort;
    interactionMode: AgentInteractionMode;
    taskMode: boolean;
    modelMetadata?: ChatModelMetadata;
}

export interface AgentPendingInputSystemApplied {
    targetKey: string;
    label: string;
    kind: string;
    jobId: Id;
}

export interface AgentPendingInputSystem {
    kind: "batch-adopted";
    batchId: Id;
    adoptionId: Id;
    applied: AgentPendingInputSystemApplied[];
}

/** Durable queued message; not a chat message until it is actually delivered. */
export interface AgentPendingInput {
    id: Id;
    threadId: Id;
    projectId?: Id;
    /** Per-thread order, assigned inside the enqueue transaction. */
    position: number;
    source: AgentPendingInputSource;
    mode: AgentPendingInputMode;
    status: AgentPendingInputStatus;
    heldReason?: AgentPendingInputHeldReason;
    content: string;
    /** Short faint line shown for system items in the conversation. */
    display?: string;
    attachments?: ReferenceAttachment[];
    /** Pre-allocated admission identity, so delivery is idempotent. */
    runId: Id;
    userMessageId: Id;
    assistantMessageId: Id;
    submit?: AgentPendingInputSubmit;
    system?: AgentPendingInputSystem;
    /** Sparse unique key for system items. */
    dedupeKey?: string;
    /** Starts at 1; incremented by every edit, mode or status change (CAS token). */
    revision: number;
    lastError?: string;
    createdAt: string;
    updatedAt: string;
}

export const AGENT_PENDING_INPUT_LIMIT = 20;
