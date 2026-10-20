import type {AgentSelectedReferences} from "../../references/models/referenceInput";
import type {AgentRequestMessage, AgentRun, AgentTokenUsage} from "./agent";

import type {ContextPolicy} from '@momoki/agent-core';
export type {ContextPolicy} from '@momoki/agent-core';

export interface ContextSource {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    referenceContext?: AgentSelectedReferences
}

export interface ContextSnapshot {
    policy: ContextPolicy;
    capacity?: number;
    capacitySource?: string;
    history: ContextSource[];
    summaryId?: string;
    /** Current base envelope; tool continuation is always appended after it. */
    baseMessages: AgentRequestMessage[];
    draft: string;
    selectedReferences?: AgentSelectedReferences;
    /** Separate, replaceable upcoming memory layer; excluded from history compaction. */
    memoryEnvelope?: string;
}

/** One provider-reported prompt size and our own estimate of the identical request (tools included). */
export interface ContextAnchor {
    step: number;
    model: string;
    definitionId: string;
    protocol: NonNullable<AgentRun["protocol"]>;
    summaryId?: string;
    reportedTokens: number;
    estimatedTokens: number;
}

export interface ContextCompaction {
    id: string;
    threadId: string;
    /** The sentinel "manual" for a run-less compaction (the index key must stay present). */
    runId: string;
    previousSummaryId?: string;
    status: "running" | "completed" | "failed" | "interrupted";
    /** Exact source coverage allows validation without hash collision ambiguity. */
    coverage: ContextSource[];
    input: AgentRequestMessage[];
    policy: ContextPolicy;
    connector: AgentRun["connector"];
    model: string;
    /** `manual` records are created outside a run and activated only by the next send. */
    origin?: "run" | "manual";
    /** Request-level estimates (wire-shaped, tools included) before and after a manual compaction. */
    requestBefore?: number;
    requestAfter?: number;
    content: string;
    beforeTokens: number;
    afterTokens?: number;
    usage?: AgentTokenUsage;
    error?: string;
    createdAt: string;
    updatedAt: string;
    activatedAt?: string;
}
