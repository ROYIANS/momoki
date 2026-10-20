import type {McpRunSnapshot} from "../mcp/models/manifest";
import type {McpToolPreviewFacts} from "../mcp/models/execution";
import type {AgentReasoningEffort, AgentRunStatus, AgentPermissionMode, AgentInteractionMode, AgentToolCallStatus, ToolMetadata, AgentModelMetrics, AgentActivityStep, AgentToolLoading, AgentTokenUsage} from "@momoki/agent-core";
import type {ChatMessage, ResponseItem} from '@momoki/agent-providers';
export type {AgentReasoningEffort, AgentRunStatus, AgentPermissionMode, AgentInteractionMode, AgentWireToolCall, AgentToolSchema, AgentToolCallStatus, AgentToolEffect, AgentModelMetrics, AgentActivityStep, AgentToolLoading, AgentTokenUsage, AgentRunOutput} from "@momoki/agent-core";
export {MODEL_STEPS_PER_SEGMENT} from "@momoki/agent-core";
export const GENERAL_AGENT_ID = "agent_general";
import type {AgentReferenceAudit, AgentReferenceInput, AgentVisionCapability} from "../../references/models/referenceInput";
import type {MemoryDispatchAudit, MemorySelection} from "../../memory/models/memoryRetrieval";
import type {ProjectContextSnapshot} from "./projectContext";
import type {GenerationPreferences} from "../../settings/models/generationPreferences";
import type {ContextAnchor, ContextPolicy, ContextSnapshot} from "./context";
import type {ConnectorConfig} from "../../settings/models/connector";
import type {Id} from "../../../platform/identity";
import type {InstalledSkillsSnapshot} from "../skills/models/installedSkill";

export interface AgentConfig {
    generationPreferences?: GenerationPreferences;
    contextPolicy?: ContextPolicy;
    id: Id;
    name: string;
    instructions: string;
    updatedAt: string;
    permissionMode?: AgentPermissionMode;
    enabledSkillIds?: string[];
    skillDefaultsVersion?: number;
}

export type AgentRequestMessage = ChatMessage & {
    referenceInput?: AgentReferenceInput;
    sourceToolCallId?: string;
    /** Provenance of a steered pending input; never sent to a provider. */
    sourceQueueItemId?: string
};

export interface AgentPlanItem {
    id: string;
    title: string;
    status: "pending" | "in_progress" | "completed"
}

export interface MusicGenerationReviewSnapshot {
    version: 1;
    projectId: string;
    projectName: string;
    draftId: string;
    draftRevision: number;
    connectorId: string;
    connectorLabel: string;
    settings: import("../../music/models/music").MusicSettings;
}

export interface AgentToolPreview {
    mcp?: McpToolPreviewFacts;
    music?: MusicGenerationReviewSnapshot;
    summary: string;
    changes: string[];
    revision?: string;
    target?: { label: string; href: string };
}

export interface AgentToolCall extends ToolMetadata {
    /** Explicit user-reviewed request; original provider arguments/envelopes stay immutable. */
    generationOverride?: { arguments: string; preview: AgentToolPreview };
    preview?: AgentToolPreview;
    recovery?: "generation" | "repeatable";
    id: string;
    runId: string;
    threadId: string;
    providerCallId: string;
    step: number;
    order: number;
    name: string;
    title: string;
    arguments: string;
    status: AgentToolCallStatus;
    result?: string;
    error?: string;
    decision?: "approve" | "reject";
    decidedAt?: string;
    createdAt: string;
    updatedAt: string;
}

export type AgentProtocol = "chat-completions" | "responses";
/** Opaque provider continuation lives only in the run, never in display messages. */
export type AgentResponseItem = ResponseItem & {
    referenceInput?: AgentReferenceInput;
    sourceToolCallId?: string;
    /** Provenance of a steered pending input; never sent to a provider. */
    sourceQueueItemId?: string
};

/** Provider-reported counts only; absence is unknown, never zero. */
/** Frozen price snapshot taken when a run starts. USD per million tokens; unknown figures are absent, never 0. */
export interface ModelPricing {
    source: "baseline" | "synced";
    provider: string;
    modelId: string;
    /** True when the price comes from the model's original vendor, not the connector's own provider. */
    reference: boolean;
    currency: "USD";
    unit: "per_million_tokens";
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    capturedAt: string;
}

/** Frozen execution inputs. Credentials are resolved from the connector at dispatch. */
export interface AgentRun {
    visionCapability?: AgentVisionCapability;
    modelPricing?: ModelPricing;
    referenceAudit?: AgentReferenceAudit[];
    memorySelection?: MemorySelection;
    memoryAudit?: MemoryDispatchAudit[];
    projectId?: Id;
    projectContext?: ProjectContextSnapshot;
    /** Code-owned one-time creation origin; original request/history remain immutable. */
    createdProjectBinding?: { projectId: Id; callId: Id };
    /** One bounded finishing check per run, preserved across explicit resumes. */
    finishingCheck?: { step: number; createdAt: string; reason?: "unfinished_plan" | "terminal_reply" };
    /** Frozen task-intake eligibility; never inferred from model arguments. */
    taskMode?: boolean;
    context?: ContextSnapshot;
    id: Id;
    threadId: Id;
    taskId?: Id;
    agentId: Id;
    agentSnapshot: Pick<AgentConfig, "name" | "instructions">;
    userMessageId: Id;
    assistantMessageId: Id;
    retryOfRunId?: Id;
    model: string;
    reasoningEffort?: AgentReasoningEffort;
    protocol?: AgentProtocol;
    responseItems?: AgentResponseItem[];
    /** Idempotent successful final Responses envelope checkpoint, independent of the once-only review. */
    finalResponseStep?: number;
    modelMetrics?: AgentModelMetrics[];
    /** Provider-reported prompt size paired with our estimate of that same request; see contextMeasurement. */
    contextAnchor?: ContextAnchor;
    activitySteps?: AgentActivityStep[];
    usage?: AgentTokenUsage;
    outputTokensPerSecond?: number;
    connector: Pick<ConnectorConfig, "id" | "definitionId" | "baseUrl">;
    requestMessages: AgentRequestMessage[];
    status: AgentRunStatus;
    permissionMode?: AgentPermissionMode;
    /** Frozen per-run execution surface. Conversation mode never exposes tools. */
    interactionMode?: AgentInteractionMode;
    enabledToolNames?: string[];
    /** Immutable installed guidance and retained content revisions, separate from tool authority. */
    installedSkills?: InstalledSkillsSnapshot;
    /** Frozen external catalogue; absent legacy runs never acquire live connections. */
    mcpSnapshot?: McpRunSnapshot;
    /** Absent on legacy runs: retain their original full-tool surface. */
    toolLoading?: AgentToolLoading;
    offeredTools?: Array<{ step: number; names: string[] }>;
    skillInstructions?: string;
    continuationMessages?: AgentRequestMessage[];
    modelStep?: number;
    /** Cumulative step at the last explicit budget continuation; legacy runs start at zero. */
    modelStepSegmentStart?: number;
    pauseReason?: "model_step_limit";
    hasToolCalls?: boolean;
    plan?: AgentPlanItem[];
    checkpoint: number;
    error?: string;
    finishReason?: string;
    createdAt: string;
    updatedAt: string;
    endedAt?: string;
}

export interface AgentTask {
    projectId: Id;
    acceptanceCriteria?: string[];
    revision?: number;
    id: Id;
    threadId: Id;
    title: string;
    goal: string;
    agentId: Id;
    plan: AgentPlanItem[];
    lifecycle: "open" | "completed" | "archived";
    artifacts: Array<{ id: Id; runId: Id; messageId: Id; createdAt: string }>;
    createdAt: string;
    updatedAt: string;
}
