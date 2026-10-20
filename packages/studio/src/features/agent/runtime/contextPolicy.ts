import type {ContextPolicy} from "../models/context";
import {type ChatModelMetadata, resolveModelMetadata} from "../../settings/models/modelMetadata";

export {DEFAULT_CONTEXT_POLICY,normalizeContextPolicy} from '@momoki/agent-core';

export function resolveContextCapacity(model: string, metadata?: ChatModelMetadata, providerId?: string, policy?: ContextPolicy) {
    const limit = resolveModelMetadata(model, metadata, providerId).contextWindow;
    const local = policy?.customContextTokens;
    if (local && (!limit || local < limit.tokens)) return {capacity: local, capacitySource: "本地预算"};
    return {
        capacity: limit?.tokens,
        capacitySource: limit ? limit.source === "provider" ? "供应商" : "模型目录" : undefined
    };
}
