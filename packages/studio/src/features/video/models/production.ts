import type {CharacterImageSlot, GenerationResult, PropImageSlot, SceneImageSlot, StyleImageSlot} from "../../library/models/slots";
import type {Id} from "../../../platform/identity";
import type {ShotPictureField} from "./shots";

export type ProductionTarget =
    | { kind: "shot"; projectId: Id; episodeId: Id; entityId: Id; slot?: ShotPictureField }
    | { kind: "character"; projectId: Id; entityId: Id; slot: CharacterImageSlot }
    | { kind: "scene"; projectId: Id; entityId: Id; slot: SceneImageSlot }
    | { kind: "prop"; projectId: Id; entityId: Id; slot: PropImageSlot }
    | { kind: "style"; projectId: Id; entityId: Id; slot: StyleImageSlot }
    /** No slot: the result is kept in the project's material library. `entityId` names a group of alternatives; `slot` is the media type. */
    | { kind: "library"; projectId: Id; entityId: Id; slot: "image" | "video"; label?: string };

export interface SourceRevision {
    kind: string;
    id: Id;
    revision: string
}

export type ProductionChange =
    | { kind: "shot-text"; patch: { content?: string; notes?: string; durationSec?: number } }
    | { kind: "slot-result"; result: GenerationResult };
export type ProposalSource =
    | { kind: "manual" }
    | {
    kind: "generation";
    intentId: Id;
    provider: string;
    model: string;
    providerTaskId?: string;
    sourceRevisions: SourceRevision[]
};

export interface ProductionProposal {
    id: Id;
    projectId: Id;
    episodeId?: Id;
    target: ProductionTarget;
    change: ProductionChange;
    before: { content?: string; notes?: string; durationSec?: number; result?: GenerationResult };
    baseRevision: string;
    appliedRevision?: string;
    source: ProposalSource;
    status: "pending" | "applied" | "cancelled" | "undone";
    createdAt: string;
    updatedAt: string;
}

export interface GenerationMediaInput {
    mediaId: Id;
    role: "first-frame" | "last-frame" | "reference-image" | "reference-video";
}

export interface GenerationIntent {
    id: Id;
    target: ProductionTarget;
    baseRevision: string;
    sourceRevisions: SourceRevision[];
    provider: string;
    model: string;
    parameters: Record<string, string | number | boolean>;
    inputs: GenerationMediaInput[];
    status: "prepared" | "submitted" | "running" | "succeeded" | "failed" | "cancelled";
    providerTaskId?: string;
    error?: string;
    result?: GenerationResult;
}
