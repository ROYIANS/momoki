import type {ReferenceAttachment} from "../../references/models/references";
import type {ReferenceImportDraft} from "../models/chatDraft";
import type {ChatModelMetadata} from "../../settings/models/modelMetadata";
import type {AgentInteractionMode, AgentReasoningEffort, AgentTask} from "../models/agent";
import type {RunAction} from "../models/chatRunAction";
import type {ReactNode} from "react";
import type {ConnectorConfig} from "../../settings/models/connector";
import type {Id} from "../../../platform/identity";
import type {Project} from "../../projects/models/project";
import type {ChatModelPolicy} from "../../settings/models/chatModelPolicy";

export type ChatSurfaceMode = "agent" | "task";
export type {AgentInteractionMode} from "../models/agent";

export type ComposerProps = {
    threadId?: string;
    attachments?: readonly Readonly<ReferenceAttachment>[];
    referenceImports?: readonly Readonly<ReferenceImportDraft>[];
    onAttachReference?: (attachment: ReferenceAttachment) => void;
    onRemoveReference?: (attachment: ReferenceAttachment) => void;
    onImportReferences?: (files: File[]) => void;
    onCancelReferenceImport?: (id: string) => void;
    onRetryReferenceImport?: (job: ReferenceImportDraft) => void;
    value: string;
    sending: boolean;
    stopping?: boolean;
    blocked?: boolean;
    blockedReason?: string;
    readOnly?: boolean;
    connectors: ConnectorConfig[];
    selectedConnectorId?: Id;
    model: string;
    reasoningEffort?: AgentReasoningEffort;
    onReasoningEffortChange: (value: AgentReasoningEffort | undefined) => void;
    modelMetadata?: Record<string, ChatModelMetadata>;
    modelOptions: Array<{ label: string; value: string }>;
    probingModels: boolean;
    modelPolicy: ChatModelPolicy;
    modelWarning?: string;
    chatMode: ChatSurfaceMode;
    projects: Project[];
    projectId?: Id;
    projectRequired?: boolean;
    projectLocked?: boolean;
    onProjectChange: (projectId: Id | undefined) => void | Promise<void>;
    interactionMode: AgentInteractionMode;
    onChange: (value: string) => void;
    onSend: () => void;
    onStop: () => void;
    onConnectorChange: (id: string) => void;
    onModelChange: (model: string) => void;
    onChatModeChange: (mode: ChatSurfaceMode) => void;
    onInteractionModeChange: (mode: AgentInteractionMode) => void;
    large?: boolean;
    contextUsage?: ReactNode;
    /** Problem card, rendered above the composer frame. */
    notice?: ReactNode;
    /** Approval/confirmation queue for the decision card. Omitted on the home composer. */
    attention?: {
        threadId: string;
        task?: AgentTask;
        projectUnavailable: boolean;
        onOpenTask: () => void;
    };
    /** Durable pending-send queue for this thread, drawn above the draft frame. */
    queue?: {threadId: string};
    /** Approval and resume/end cards for this thread; they run the same handler the message area used to. */
    actions?: {threadId: string; onRunAction: (runId: string, action: RunAction, callId?: string) => void};
};
