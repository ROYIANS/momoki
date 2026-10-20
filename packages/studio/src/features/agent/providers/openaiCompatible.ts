import {authHeaders, chatCompletionsUrl} from '@momoki/agent-providers';
import {readHttpJson} from '@momoki/agent-providers/http';
import {requestOnce} from "../../../platform/http/requestBoundary";
import {isReadAbort} from "@momoki/agent-providers/http";
import {normalizeBaseUrl} from "@momoki/agent-providers/http";
import {redactCredentials} from "@momoki/agent-providers/http";
import {type ChatModelMetadata, collectModelMetadata, parseModelMetadata} from "../../settings/models/modelMetadata";
import {connectorProbeFetch} from "../../../platform/runtime/runtimeFetch";

export {normalizeBaseUrl} from "@momoki/agent-providers/http";

export function modelsUrl(baseUrl: string): string {
    return `${normalizeBaseUrl(baseUrl)}/models`;
}

export function maskApiKey(apiKey: string): string {
    const key = apiKey.trim();
    if (!key) return "";
    if (key.length <= 8) return "••••••••";
    return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

export type TestConnectionInput = {
    baseUrl: string;
    apiKey: string;
    defaultModel?: string;
};

export type TestConnectionResult =
    | { ok: true; via: "models" | "chat"; modelCount?: number }
    | { ok: false; message: string };

function formatHttpError(status: number, body: string, apiKey: string): string {
    const trimmed = redactCredentials(body, apiKey).trim().slice(0, 200);
    if (status === 401 || status === 403) {
        return trimmed ? `鉴权失败（${status}）：${trimmed}` : `鉴权失败（${status}）`;
    }
    return trimmed ? `请求失败（${status}）：${trimmed}` : `请求失败（${status}）`;
}

export type ListModelsResult =
    | { ok: true; models: string[]; metadata?: Record<string, ChatModelMetadata> }
    | { ok: false; message: string };

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serviceEnvelope(value: unknown): Record<string, unknown> {
    if (!record(value)) throw new Error("服务返回了无效的响应格式");
    if (value.error != null || value.success === false) {
        const error = value.error;
        if (record(error) && typeof error.message === "string") throw new Error(error.message);
        if (typeof error === "string") throw new Error(error);
        if (typeof value.message === "string") throw new Error(value.message);
        throw new Error("模型服务返回错误");
    }
    return value;
}

function decodeModelDirectory(value: unknown): {
    models: string[];
    modelCount: number;
    metadata?: Record<string, ChatModelMetadata>;
} {
    const envelope = serviceEnvelope(value);
    if (!Array.isArray(envelope.data)) throw new Error("模型目录缺少有效的 data 数组");
    const models: string[] = [];
    const entries: Array<readonly [string, ChatModelMetadata]> = [];
    for (const row of envelope.data) {
        if (!record(row) || typeof row.id !== "string" || !row.id.trim()) {
            throw new Error("模型目录包含无效的模型 ID");
        }
        const id = row.id.trim();
        models.push(id);
        const metadata = parseModelMetadata(row);
        if (metadata) entries.push([id, metadata]);
    }
    return {
        models: [...new Set(models)].sort((left, right) => left.localeCompare(right)),
        modelCount: envelope.data.length,
        ...(entries.length ? {metadata: collectModelMetadata(entries)} : {}),
    };
}

function validateChatProbe(value: unknown): void {
    const envelope = serviceEnvelope(value);
    if (!Array.isArray(envelope.choices) || !record(envelope.choices[0])) {
        throw new Error("模型响应缺少有效的 choices");
    }
    const message = envelope.choices[0].message;
    if (!record(message) || message.role !== "assistant") throw new Error("模型回复格式无效");
    // A one-token probe may finish before producing any text.
    for (const field of ["content", "reasoning_content", "reasoning"]) {
        if (message[field] != null && typeof message[field] !== "string") {
            throw new Error("模型回复包含无效的文本格式");
        }
    }
}

async function readProtocolBody(response: Response, signal?: AbortSignal): Promise<unknown> {
    try {
        return await readHttpJson(response, {success: {kind: "native-json"}, failure: {kind: "native-json"}}, signal);
    } catch (error) {
        if (isReadAbort(error, signal)) throw error;
        throw new Error(`服务响应解析失败：${error instanceof Error ? error.message : "无效 JSON"}`);
    }
}

async function readHttpError(response: Response, signal?: AbortSignal): Promise<string> {
    try {
        signal?.throwIfAborted();
        const text = await response.text();
        signal?.throwIfAborted();
        return text;
    } catch (error) {
        if (isReadAbort(error, signal)) throw error;
        return "";
    }
}

function failure(error: unknown, apiKey: string): { ok: false; message: string } {
    return {
        ok: false,
        message: redactCredentials(error instanceof Error ? error.message : "网络错误", apiKey).slice(0, 300),
    };
}

/**
 * List model ids from GET /v1/models (OpenAI-compatible).
 */
export async function listModels(
    input: { baseUrl: string; apiKey: string },
    fetchImpl?: typeof fetch,
    options: { signal?: AbortSignal } = {},
): Promise<ListModelsResult> {
    const base = normalizeBaseUrl(input.baseUrl);
    const apiKey = input.apiKey.trim();
    if (!base) return {ok: false, message: "请填写 Base URL"};
    if (!apiKey) return {ok: false, message: "请填写 API Key"};

    try {
        fetchImpl = connectorProbeFetch(input.baseUrl, fetchImpl);
        const res = await requestOnce(modelsUrl(base), {
            method: "GET",
            headers: authHeaders(apiKey),
        }, {fetchImpl, signal: options.signal, credentials: "same-origin", redirect: "follow"});
        if (!res.ok) {
            const text = await readHttpError(res, options.signal);
            return {ok: false, message: formatHttpError(res.status, text, apiKey)};
        }
        const {models, metadata} = decodeModelDirectory(await readProtocolBody(res, options.signal));
        return {ok: true, models, ...(metadata ? {metadata} : {})};
    } catch (error) {
        return failure(error, apiKey);
    }
}

/**
 * Cheap connectivity check for OpenAI-compatible endpoints.
 * Only an unavailable /models route or GET fetch TypeError permits one chat probe.
 */
export async function testConnection(
    input: TestConnectionInput,
    fetchImpl?: typeof fetch,
    options: { signal?: AbortSignal } = {},
): Promise<TestConnectionResult> {
    const base = normalizeBaseUrl(input.baseUrl);
    const apiKey = input.apiKey.trim();
    if (!base) return {ok: false, message: "请填写 Base URL"};
    if (!apiKey) return {ok: false, message: "请填写 API Key"};

    const headers = authHeaders(apiKey);
    let modelsRes: Response | undefined;
    try {
        fetchImpl = connectorProbeFetch(input.baseUrl, fetchImpl);
        modelsRes = await requestOnce(modelsUrl(base), {method: "GET", headers}, {
            fetchImpl,
            signal: options.signal,
            credentials: "same-origin",
            redirect: "follow"
        });
    } catch (error) {
        // Keep this gate limited to fetch: body/decoder failures must never send a POST.
        if (isReadAbort(error, options.signal)) return failure(error, apiKey);
        if (!(error instanceof TypeError)) return failure(error, apiKey);
    }
    if (modelsRes) {
        try {
            if (modelsRes.ok) {
                const {modelCount} = decodeModelDirectory(await readProtocolBody(modelsRes, options.signal));
                return {ok: true, via: "models", modelCount};
            }
            if (modelsRes.status !== 404 && modelsRes.status !== 405) {
                const text = await readHttpError(modelsRes, options.signal);
                return {ok: false, message: formatHttpError(modelsRes.status, text, apiKey)};
            }
        } catch (error) {
            return failure(error, apiKey);
        }
    }

    const model = input.defaultModel?.trim() || "gpt-4o-mini";
    try {
        const chatRes = await requestOnce(chatCompletionsUrl(base), {
            method: "POST",
            headers,
            body: JSON.stringify({
                model,
                messages: [{role: "user", content: "ping"}],
                max_tokens: 1,
            }),
        }, {fetchImpl, signal: options.signal, credentials: "same-origin", redirect: "follow"});
        if (!chatRes.ok) {
            const text = await readHttpError(chatRes, options.signal);
            return {ok: false, message: formatHttpError(chatRes.status, text, apiKey)};
        }
        validateChatProbe(await readProtocolBody(chatRes, options.signal));
        return {ok: true, via: "chat"};
    } catch (error) {
        return failure(error, apiKey);
    }
}
