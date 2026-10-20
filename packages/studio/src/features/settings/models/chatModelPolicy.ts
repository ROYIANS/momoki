import {MIMO_NON_CHAT_MODELS} from "../../audio/providers/mimoSpeech";
import type {ChatModelMetadata} from "./modelMetadata";
import type {ConnectorConfig} from "./connector";

export type ChatModelConnector = Pick<ConnectorConfig, "definitionId" | "baseUrl" | "apiKey"> & { id?: string };
export type ChatModelCatalog = {
    connector: ChatModelConnector;
    status: "loading" | "ready" | "error";
    models: string[];
    metadata?: Record<string, ChatModelMetadata>;
    incompatibleModels: string[];
};
export type ChatModelPolicy = {
    verified: boolean;
    incompatibleModels: readonly string[];
};

export function requiresChatModelVerification(connector: ChatModelConnector | undefined): boolean {
    return connector?.definitionId === "apimart" || connector?.definitionId === "aihubmix" || connector?.definitionId === "mimo";
}

/** Credentials are compared in memory only; never use a key-bearing serialized cache key. */
export function sameChatModelConnector(left: ChatModelConnector | undefined, right: ChatModelConnector | undefined): boolean {
    return Boolean(left && right && left.id === right.id && left.definitionId === right.definitionId &&
        left.baseUrl === right.baseUrl && left.apiKey === right.apiKey);
}

export function getChatModelPolicy(
    connector: ChatModelConnector | undefined,
    catalog: ChatModelCatalog | undefined,
): ChatModelPolicy {
    if (!requiresChatModelVerification(connector)) return {verified: true, incompatibleModels: []};
    if (connector?.definitionId === "mimo") return {verified: true, incompatibleModels: MIMO_NON_CHAT_MODELS};
    if (!catalog || !sameChatModelConnector(connector, catalog.connector)) return {
        verified: false,
        incompatibleModels: []
    };
    return {verified: catalog.status === "ready", incompatibleModels: catalog.incompatibleModels};
}

export function chatModelIssue(model: string, policy: ChatModelPolicy): string | undefined {
    if (policy.incompatibleModels.includes(model.trim())) {
        return "当前模型的能力或接口与聊天不兼容，无法用于对话。请选择聊天模型；已有消息会保留。";
    }
    // An unverified connector is not an error the user can act on: sending re-checks it, so stay quiet.
    return undefined;
}

/** Every option source passes through the same policy, including manual search and saved selections. */
export function buildChatModelOptions(
    suggestions: readonly string[],
    current: string,
    search: string,
    policy: ChatModelPolicy,
): string[] {
    if (!policy.verified) return [];
    return [...new Set([...suggestions, current.trim(), search.trim()])]
        .filter((id) => id && !policy.incompatibleModels.includes(id))
        .sort((a, b) => a.localeCompare(b));
}
