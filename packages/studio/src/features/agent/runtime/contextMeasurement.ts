import {budgetTokens, estimateTokens} from "@momoki/agent-core";
import {toResponseInput} from "@momoki/agent-providers";
import type {AgentRequestMessage, AgentToolSchema} from "../models/agent";
import type {AgentImageReference} from "../../references/models/referenceInput";
import type {ContextAnchor} from "../models/context";

/**
 * What the context figure measures
 * --------------------------------
 * The number of input tokens the NEXT model request will occupy: system prompt, skills, tool schemas,
 * history (or its summary), memory, references, tool results and opaque Responses reasoning. Output
 * reserve is a separate budget line and never part of the figure.
 *
 * Source `reported`: the provider's own prompt size for a previous request (`ContextAnchor`) plus our
 * estimate of only what changed since (`delta`). Source `estimated`: the whole request estimated.
 * An anchor is discarded whenever it cannot describe the request (model/connector/protocol switch,
 * a different summary, or a request that became smaller than the anchor) - never silently reused.
 *
 * Estimates are made over the wire-shaped payload for the request's protocol (internal-only
 * `referenceInput`/`sourceToolCallId` never serialize; Responses uses flat tools and items), and
 * images are priced separately by `estimateImageTokens`.
 */
type ContextSourceKind = "reported" | "estimated";
export type WireProtocol = NonNullable<ContextAnchor["protocol"]>;

/** Safety allowance applied to estimated tokens only, before comparing to thresholds. */
const ESTIMATE_MARGIN = 0.25;
/** Inclusive bounds of the per-image estimate; providers price images by size tiers, not bytes. */
export const IMAGE_TOKEN_FLOOR = 256;
export const IMAGE_TOKEN_CAP = 1600;
const IMAGE_BYTES_PER_TOKEN = 512;

/**
 * Pixel dimensions are not retained with a reference, so encoded size is the proxy: roughly one token
 * per 512 bytes, floored at 256 (a small image still costs a base tile) and capped at 1600 (the
 * largest `detail: auto` cost among common vision providers).
 */
export function estimateImageTokens(image: Pick<AgentImageReference, "size">): number {
    const bytes = Number.isFinite(image.size) && image.size > 0 ? image.size : 0;
    return Math.min(IMAGE_TOKEN_CAP, Math.max(IMAGE_TOKEN_FLOOR, Math.ceil(bytes / IMAGE_BYTES_PER_TOKEN)));
}

function imageTokensOf(messages: readonly AgentRequestMessage[]): number {
    return messages.reduce((sum, message) => sum + (message.referenceInput?.images ?? []).reduce((inner, image) => inner + estimateImageTokens(image), 0), 0);
}

/** Exactly what the transport serializes, minus pixels (priced separately). */
export function wireMessages(messages: readonly AgentRequestMessage[], protocol: WireProtocol): unknown[] {
    if (protocol === "responses") return toResponseInput(messages);
    return messages.map(({referenceInput: _input, sourceToolCallId: _source, sourceQueueItemId: _queue, ...message}) => message);
}

export function wireTools(tools: readonly AgentToolSchema[], protocol: WireProtocol): unknown[] {
    return protocol === "responses" ? tools.map(tool => ({type: "function", ...tool.function, strict: false})) : [...tools];
}

/** Tokens of the full request, identical for the trigger, the ring and recorded anchors. */
export function estimateRequestTokens(messages: readonly AgentRequestMessage[], tools: readonly AgentToolSchema[], protocol: WireProtocol, extraTokens = 0): number {
    return estimateTokens(JSON.stringify(wireMessages(messages, protocol))) + (tools.length ? estimateTokens(JSON.stringify(wireTools(tools, protocol))) : 0) + imageTokensOf(messages) + extraTokens;
}

export interface AnchorScope {
    model: string;
    definitionId?: string;
    protocol: WireProtocol;
    summaryId?: string;
}

/** Only an anchor of the same model, connector family, protocol and summary describes this request. */
export function usableAnchor(anchor: ContextAnchor | undefined, scope: AnchorScope): ContextAnchor | undefined {
    if (!anchor || !Number.isSafeInteger(anchor.reportedTokens) || anchor.reportedTokens <= 0) return undefined;
    if (anchor.model !== scope.model || anchor.protocol !== scope.protocol) return undefined;
    if (scope.definitionId !== undefined && anchor.definitionId !== scope.definitionId) return undefined;
    if ((anchor.summaryId ?? undefined) !== (scope.summaryId ?? undefined)) return undefined;
    return anchor;
}

export function measureContext(input: {
    messages: readonly AgentRequestMessage[];
    tools: readonly AgentToolSchema[];
    protocol: WireProtocol;
    extraTokens?: number;
    capacity?: number;
    hasSummary?: boolean;
    anchor?: ContextAnchor;
    scope?: AnchorScope;
}) {
    const estimate = estimateRequestTokens(input.messages, input.tools, input.protocol, input.extraTokens);
    const anchor = input.scope ? usableAnchor(input.anchor, input.scope) : undefined;
    const delta = anchor ? estimate - anchor.estimatedTokens : undefined;
    // A request smaller than its anchor means compaction/pruning happened: the report is stale.
    const reported = anchor && delta !== undefined && delta >= 0 ? anchor : undefined;
    const used = reported ? reported.reportedTokens + (delta ?? 0) : estimate;
    const estimatedPart = reported ? (delta ?? 0) : estimate;
    const margin = Math.ceil(estimatedPart * (1 + ESTIMATE_MARGIN)) - estimatedPart;
    return {
        ...budgetTokens(used, margin, input.capacity, input.hasSummary),
        source: (reported ? "reported" : "estimated") satisfies ContextSourceKind,
        requestEstimate: estimate,
        reportedTokens: reported?.reportedTokens,
        deltaTokens: reported ? delta : undefined,
    };
}

/** Pair a provider report with our estimate of the identical request. */
export function createContextAnchor(input: {
    step: number;
    model: string;
    definitionId: string;
    protocol: WireProtocol;
    summaryId?: string;
    reportedTokens: number | undefined;
    messages: readonly AgentRequestMessage[];
    tools: readonly AgentToolSchema[];
    extraTokens?: number;
}): ContextAnchor | undefined {
    if (input.reportedTokens === undefined || !Number.isSafeInteger(input.reportedTokens) || input.reportedTokens <= 0) return undefined;
    return {
        step: input.step, model: input.model, definitionId: input.definitionId, protocol: input.protocol,
        ...(input.summaryId ? {summaryId: input.summaryId} : {}),
        reportedTokens: input.reportedTokens,
        estimatedTokens: estimateRequestTokens(input.messages, input.tools, input.protocol, input.extraTokens),
    };
}
