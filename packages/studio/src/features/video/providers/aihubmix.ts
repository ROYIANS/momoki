import {readHttpJson} from '@momoki/agent-providers/http';
import {requestOnce} from "../../../platform/http/requestBoundary";
import {normalizeBaseUrl} from "@momoki/agent-providers/http";
import {isReadAbort, readResponseBlob, ResponseLimitError} from "@momoki/agent-providers/http";
import {MAX_ERROR_BYTES, MAX_JSON_BYTES, MAX_MEDIA_DOWNLOAD_BYTES} from "../../../platform/media/limits";
import {redactCredentials} from "@momoki/agent-providers/http";
import {type ChatModelMetadata, parseModelMetadata} from "../../settings/models/modelMetadata";

export type AIHubMixCredentials = { baseUrl: string; apiKey: string };
export type AIHubMixRequestOptions = { signal?: AbortSignal; fetchImpl?: typeof fetch };
export type AIHubMixJson = null | boolean | number | string | AIHubMixJson[] | { [key: string]: AIHubMixJson };
export type AIHubMixFailure = {
    ok: false;
    kind: "validation" | "http" | "provider" | "protocol" | "network" | "aborted";
    message: string;
    httpStatus?: number;
    providerCode?: string | number;
    providerType?: string;
    taskId?: string;
};
export type AIHubMixResult<T> = ({ ok: true } & T) | AIHubMixFailure;
export type AIHubMixModel = {
    metadata?: ChatModelMetadata;
    id: string;
    types: string[];
    endpoints: string[];
    inputModalities: string[];
    outputModalities: string[];
    features: string[];
    schemaChecked?: boolean;
    metadataStatus: "available" | "missing" | "invalid";
};
export type AIHubMixMediaKind = "image" | "video";
/** Preserve provider-native parameters; model-specific validation belongs to the provider. */
export type AIHubMixGenerationRequest = {
    model: string;
    prompt: string;
    [key: string]: AIHubMixJson | undefined;
};
export type AIHubMixImageGenerationRequest = AIHubMixGenerationRequest & { async?: boolean; n?: number | null };
export type AIHubMixVideoGenerationRequest = AIHubMixGenerationRequest & { duration?: number | null };
export type AIHubMixOutput = {
    index: number;
    type: "file";
    resultId?: string;
    contentType?: string;
    contentUrl?: string;
    b64Json?: string;
    /** contentUrl is a protected API route, never a public preview URL. */
    requiresAuthentication: true;
};
export type AIHubMixTask = {
    id: string;
    kind: AIHubMixMediaKind;
    model: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";
    providerStatus: string;
    outputs: AIHubMixOutput[];
    createdAt?: number | null;
    completedAt?: number | null;
    expiresAt?: number | null;
    error?: { code?: string | number; message?: string; type?: string; upstreamDetail?: AIHubMixJson };
};
export type AIHubMixModelSchema = {
    status: "available" | "missing" | "invalid";
    path: string;
    schema?: { [key: string]: AIHubMixJson } | boolean;
};
const PATHS = {image: "/ai/v1/images/generations", video: "/ai/v1/videos"} as const;
const TYPE_ALIASES: Record<string, string> = {t2t: "llm", t2i: "image_generation", t2v: "video", reranking: "rerank"};

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function finite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function jsonValue(value: unknown): value is AIHubMixJson {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(jsonValue);
    return record(value) && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(jsonValue);
}

function redact(value: string, key: string): string {
    return redactCredentials(value, key).slice(0, 500);
}

function sanitizedJson(value: AIHubMixJson, key: string): AIHubMixJson {
    if (typeof value === "string") return redact(value, key);
    if (Array.isArray(value)) return value.map((item) => sanitizedJson(item, key));
    if (record(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [redact(name, key), sanitizedJson(item, key)]));
    return value;
}

function failure(kind: AIHubMixFailure["kind"], message: string): AIHubMixFailure {
    return {ok: false, kind, message};
}

function protocol(taskId?: string): AIHubMixFailure {
    return {...failure("protocol", "AIHubMix 返回的数据格式不符合接口约定"), ...(taskId ? {taskId} : {})};
}

function aborted(): AIHubMixFailure {
    return failure("aborted", "请求已中止；已提交的远端任务不会因此取消");
}


function providerRoot(baseUrl: string): string | undefined {
    try {
        const base = normalizeBaseUrl(baseUrl);
        const url = new URL(base);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash ||
            !url.pathname.endsWith("/v1") || /\\|%(?:2f|5c)/i.test(base)) return undefined;
        return `${url.origin}${url.pathname.slice(0, -3)}`;
    } catch {
        return undefined;
    }
}

function segment(value: unknown): value is string {
    return nonempty(value) && value === value.trim() && value !== "." && value !== ".." && !/[\\/?#%]/.test(value);
}

function taskError(value: unknown, key: string): AIHubMixTask["error"] {
    if (!record(value)) return undefined;
    return {
        code: typeof value.code === "string" ? redact(value.code, key) : finite(value.code) ? value.code : undefined,
        message: typeof value.message === "string" ? redact(value.message, key) : undefined,
        type: typeof value.type === "string" ? redact(value.type, key) : undefined,
        upstreamDetail: value.upstream_detail !== undefined && jsonValue(value.upstream_detail) ? sanitizedJson(value.upstream_detail, key) : undefined,
    };
}

function responseFailure(response: Response, body: unknown, key: string): AIHubMixFailure {
    const envelope = record(body) ? body : undefined;
    const error = taskError(envelope?.error, key);
    const detail = error?.message ?? (typeof envelope?.message === "string" ? redact(envelope.message, key) : undefined);
    return {
        ok: false, kind: response.ok ? "provider" : "http", httpStatus: response.status,
        message: `AIHubMix 请求失败（${response.status}）${detail ? `：${detail}` : ""}`,
        providerCode: error?.code, providerType: error?.type,
        ...(nonempty(envelope?.id) ? {taskId: redact(envelope.id, key)} : {}),
    };
}

async function transport(
    credentials: AIHubMixCredentials, path: string,
    options: AIHubMixRequestOptions, authenticated: boolean, body?: string,
): Promise<AIHubMixResult<{ response: Response }>> {
    const root = providerRoot(credentials.baseUrl);
    if (!root) return failure("validation", "Base URL 必须是以 /v1 结尾的 HTTP(S) 地址，且不包含账号、查询参数或片段");
    if (authenticated && !credentials.apiKey.trim()) return failure("validation", "请填写 API Key");
    if (options.signal?.aborted) return aborted();
    try {
        const response = await requestOnce(`${root}${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                ...(authenticated ? {Authorization: `Bearer ${credentials.apiKey.trim()}`} : {}),
                ...(body !== undefined ? {"Content-Type": "application/json"} : {}),
            },
            ...(body === undefined ? {} : {body}),
        }, {fetchImpl: options.fetchImpl, signal: options.signal, credentials: "omit", redirect: "error"});
        if (options.signal?.aborted) return aborted();
        return {ok: true, response};
    } catch (error) {
        return isReadAbort(error, options.signal) ? aborted() : failure("network", "无法连接 AIHubMix，请检查网络、Base URL 和浏览器跨域限制；提交结果可能尚未确认");
    }
}

async function request(
    credentials: AIHubMixCredentials, path: string, options: AIHubMixRequestOptions,
    authenticated: boolean, body?: string, taskResponse = false,
): Promise<AIHubMixResult<{ data: Record<string, unknown> }>> {
    const result = await transport(credentials, path, options, authenticated, body);
    if (!result.ok) return result;
    const {response} = result;
    let data: unknown;
    try {
        data = await readHttpJson(response, {
            success: {kind: "native-json"},
            failure: {kind: "native-json"}
        }, options.signal);
    } catch (error) {
        if (isReadAbort(error, options.signal)) return aborted();
        return response.ok ? protocol() : responseFailure(response, undefined, credentials.apiKey);
    }
    if (options.signal?.aborted) return aborted();
    // Failed task reads are successful reads; only request error envelopes are failures.
    const isTask = taskResponse && record(data) && (data.object === "image" || data.object === "video") && nonempty(data.id);
    if (!response.ok || (record(data) && (data.success === false || (!isTask && data.error != null)))) {
        return responseFailure(response, data, credentials.apiKey);
    }
    return record(data) ? {ok: true, data} : protocol();
}

function tokens(value: unknown): string[] | undefined {
    if (value == null) return [];
    if (typeof value === "string") return [...new Set(value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return [...new Set(value.flatMap((item) => tokens(item) ?? []))];
    return undefined;
}

/** Public directory; success is never evidence that the configured key is valid. */
export async function listAIHubMixModels(credentials: AIHubMixCredentials, options: AIHubMixRequestOptions = {}): Promise<AIHubMixResult<{
    models: AIHubMixModel[]
}>> {
    const result = await request(credentials, "/api/v1/models", options, false);
    if (!result.ok) return result;
    if (result.data.success !== true || !Array.isArray(result.data.data)) return protocol();
    const models: AIHubMixModel[] = [];
    for (const row of result.data.data) {
        if (!record(row) || !nonempty(row.model_id)) return protocol();
        const types = tokens(row.types), endpoints = tokens(row.endpoints), input = tokens(row.input_modalities),
            output = tokens(row.output_modalities), features = tokens(row.features);
        const invalid = [types, endpoints, input, output, features].some((value) => value === undefined) || (row.schema_checked != null && typeof row.schema_checked !== "boolean");
        const explicitMetadata = parseModelMetadata(row);
        // The public directory declares image input separately from capabilities.
        // An explicit boolean (including false) remains authoritative.
        const metadata = explicitMetadata?.vision === undefined && input?.includes("image")
            ? {...explicitMetadata, source: "provider" as const, vision: true} : explicitMetadata;
        models.push({
            ...(metadata ? {metadata} : {}),
            id: row.model_id.trim(),
            types: [...new Set((types ?? []).map((type) => Object.hasOwn(TYPE_ALIASES, type) ? TYPE_ALIASES[type] : type))],
            endpoints: endpoints ?? [],
            inputModalities: input ?? [],
            outputModalities: output ?? [],
            features: features ?? [],
            schemaChecked: typeof row.schema_checked === "boolean" ? row.schema_checked : undefined,
            metadataStatus: invalid ? "invalid" : types?.length ? "available" : "missing",
        });
    }
    return {ok: true, models};
}

/** Authenticated read only; proves access to task listing, not every model entitlement. */
export async function testAIHubMixConnection(credentials: AIHubMixCredentials, options: AIHubMixRequestOptions = {}): Promise<AIHubMixResult<Record<never, never>>> {
    const result = await request(credentials, "/ai/v1/images?limit=1", options, true);
    if (!result.ok) return result;
    const data = result.data;
    if (data.object !== "list" || !Array.isArray(data.data) || typeof data.has_more !== "boolean" ||
        !(data.next_after === null || typeof data.next_after === "string") ||
        !data.data.every((row) => record(row) && nonempty(row.id) && row.object === "image")) return protocol();
    return {ok: true};
}

function validSchema(value: unknown): value is NonNullable<AIHubMixModelSchema["schema"]> {
    if (typeof value === "boolean") return true;
    return record(value) && jsonValue(value) &&
        (value.properties === undefined || record(value.properties)) &&
        (value.required === undefined || (Array.isArray(value.required) && value.required.every(nonempty))) &&
        (value.type === undefined || nonempty(value.type) || (Array.isArray(value.type) && value.type.every(nonempty)));
}

export async function getAIHubMixModelSchema(credentials: AIHubMixCredentials, model: string, kind: AIHubMixMediaKind, options: AIHubMixRequestOptions = {}): Promise<AIHubMixResult<AIHubMixModelSchema>> {
    if (!nonempty(model) || model === "." || model === ".." || !Object.hasOwn(PATHS, kind)) return failure("validation", "请提供有效的模型和媒体类型");
    const result = await request(credentials, `/call/schema/models/${encodeURIComponent(model)}/endpoints`, options, false);
    if (!result.ok) return result;
    const path = PATHS[kind];
    if (!Array.isArray(result.data.endpoints) || result.data.modality !== kind || !result.data.endpoints.every(record)) return {
        ok: true,
        path,
        status: "invalid"
    };
    const candidates = result.data.endpoints.filter((row) => row.path === path && row.method === "POST");
    if (!candidates.length) return {ok: true, path, status: "missing"};
    if (candidates.length !== 1) return {ok: true, path, status: "invalid"};
    const candidate = candidates[0];
    const schema = record(candidate.request) ? candidate.request.schema : undefined;
    return validSchema(schema) ? {ok: true, path, status: "available", schema} : {ok: true, path, status: "invalid"};
}

function parseTask(data: Record<string, unknown>, kind: AIHubMixMediaKind, key: string, expectedId?: string): AIHubMixResult<{
    task: AIHubMixTask
}> {
    const id = nonempty(data.id) ? redact(data.id, key) : undefined;
    if (!segment(data.id) || data.object !== kind || (expectedId !== undefined && data.id !== expectedId) || !nonempty(data.model) || !Array.isArray(data.output)) return protocol(id);
    if (data.status !== undefined && !nonempty(data.status)) return protocol(id);
    if ([data.created_at, data.completed_at, data.expires_at].some((value) => value !== undefined && value !== null && (!finite(value) || !Number.isInteger(value)))) return protocol(id);
    if (data.error != null && !record(data.error)) return protocol(id);
    const outputs: AIHubMixOutput[] = [];
    for (const item of data.output) {
        if (!record(item) || !finite(item.index) || !Number.isInteger(item.index) || item.index < 0 || item.type !== "file" || outputs.some((output) => output.index === item.index)) return protocol(id);
        if ([item.content_url, item.b64_json, item.content_type, item.result_id].some((value) => value != null && !nonempty(value))) return protocol(id);
        if (!nonempty(item.content_url) && !nonempty(item.b64_json)) return protocol(id);
        outputs.push({
            index: item.index, type: "file", requiresAuthentication: true,
            contentUrl: nonempty(item.content_url) ? item.content_url : undefined,
            b64Json: nonempty(item.b64_json) ? item.b64_json : undefined,
            contentType: nonempty(item.content_type) ? item.content_type : undefined,
            resultId: nonempty(item.result_id) ? item.result_id : undefined,
        });
    }
    if (data.status === "completed" && !outputs.length) return protocol(id);
    const providerStatus = typeof data.status === "string" ? data.status : "";
    const statuses: Record<string, AIHubMixTask["status"]> = {
        pending: "queued",
        in_progress: "running",
        completed: "completed",
        failed: "failed",
        cancelled: "cancelled"
    };
    const timestamp = (value: unknown) => value === null ? null : finite(value) ? value : undefined;
    return {
        ok: true, task: {
            id: data.id,
            kind,
            model: data.model,
            status: Object.hasOwn(statuses, providerStatus) ? statuses[providerStatus] : "unknown",
            providerStatus,
            outputs,
            createdAt: timestamp(data.created_at),
            completedAt: timestamp(data.completed_at),
            expiresAt: timestamp(data.expires_at),
            error: taskError(data.error, key),
        }
    };
}

async function submit(credentials: AIHubMixCredentials, input: AIHubMixGenerationRequest, kind: AIHubMixMediaKind, options: AIHubMixRequestOptions): Promise<AIHubMixResult<{
    task: AIHubMixTask
}>> {
    if (!record(input) || !nonempty(input.model) || !nonempty(input.prompt)) return failure("validation", "请填写生成模型和提示词");
    if (kind === "image" && input.async !== undefined && typeof input.async !== "boolean") return failure("validation", "async 必须是布尔值");
    if (kind === "video" && input.duration != null && (!finite(input.duration) || !Number.isInteger(input.duration) || input.duration <= 0)) return failure("validation", "视频时长必须是正整数");
    let body: string;
    try {
        if (!Object.values(input).every((value) => value === undefined || jsonValue(value))) return failure("validation", "生成参数必须是有效的 JSON");
        body = JSON.stringify(input);
    } catch {
        return failure("validation", "生成参数必须是有效的 JSON");
    }
    const result = await request(credentials, PATHS[kind], options, true, body, true);
    return result.ok ? parseTask(result.data, kind, credentials.apiKey) : result;
}

export function submitAIHubMixImageGeneration(credentials: AIHubMixCredentials, input: AIHubMixImageGenerationRequest, options: AIHubMixRequestOptions = {}) {
    return submit(credentials, input, "image", options);
}

export function submitAIHubMixVideoGeneration(credentials: AIHubMixCredentials, input: AIHubMixVideoGenerationRequest, options: AIHubMixRequestOptions = {}) {
    return submit(credentials, input, "video", options);
}

async function getTask(credentials: AIHubMixCredentials, taskId: string, kind: AIHubMixMediaKind, options: AIHubMixRequestOptions): Promise<AIHubMixResult<{
    task: AIHubMixTask
}>> {
    if (!segment(taskId)) return failure("validation", "请提供有效的任务 ID");
    const result = await request(credentials, `/ai/v1/${kind}s/${encodeURIComponent(taskId)}`, options, true, undefined, true);
    return result.ok ? parseTask(result.data, kind, credentials.apiKey, taskId) : result;
}

export function getAIHubMixImageTask(credentials: AIHubMixCredentials, taskId: string, options: AIHubMixRequestOptions = {}) {
    return getTask(credentials, taskId, "image", options);
}

export function getAIHubMixVideoTask(credentials: AIHubMixCredentials, taskId: string, options: AIHubMixRequestOptions = {}) {
    return getTask(credentials, taskId, "video", options);
}

/** Explicit protected binary read. Never follows redirects or writes to local media storage. */
export async function downloadAIHubMixResult(credentials: AIHubMixCredentials, task: AIHubMixTask, output: AIHubMixOutput, options: AIHubMixRequestOptions = {}): Promise<AIHubMixResult<{
    blob: Blob
}>> {
    if (options.signal?.aborted) return aborted();
    if (task.status !== "completed") return {
        ...failure("validation", "任务结果尚未就绪"),
        providerCode: "result_not_ready"
    };
    const root = providerRoot(credentials.baseUrl);
    if (!root || !segment(task.id) || !["image", "video"].includes(task.kind) || !nonempty(output.contentUrl) ||
        !task.outputs.some((item) => item.index === output.index && item.contentUrl === output.contentUrl)) return failure("validation", "请提供该任务的有效下载地址");
    let path: string;
    try {
        const url = new URL(output.contentUrl, `${root}/`);
        const expected = new URL(`${root}/ai/v1/${task.kind}s/${encodeURIComponent(task.id)}/content`);
        const tail = url.pathname.slice(expected.pathname.length + 1);
        if (url.origin !== expected.origin || url.username || url.password || url.search || url.hash ||
            (task.kind === "video" ? url.pathname !== expected.pathname : !url.pathname.startsWith(`${expected.pathname}/`) || !segment(decodeURIComponent(tail)))) throw new Error("invalid content route");
        path = url.pathname.slice(new URL(root).pathname.replace(/\/$/, "").length);
    } catch {
        return failure("validation", "下载地址必须属于当前供应商及当前任务的结果接口");
    }
    const result = await transport(credentials, path, options, true);
    if (!result.ok) return result;
    try {
        if (!result.response.ok || result.response.headers.get("Content-Type")?.includes("application/json")) {
            let body: unknown;
            try {
                body = await readHttpJson(result.response, {
                    success: {
                        kind: "bounded-json",
                        maxBytes: MAX_JSON_BYTES,
                        fatalUtf8: true
                    }, failure: {kind: "bounded-json", maxBytes: MAX_ERROR_BYTES, fatalUtf8: true}
                }, options.signal);
            } catch (error) {
                if (isReadAbort(error, options.signal)) return aborted();
            }
            return result.response.ok && !(record(body) && body.error != null) ? protocol(task.id) : responseFailure(result.response, body, credentials.apiKey);
        }
        const blob = await readResponseBlob(result.response, MAX_MEDIA_DOWNLOAD_BYTES, options.signal);
        if (options.signal?.aborted) return aborted();
        return blob.size > 0 ? {ok: true, blob} : protocol(task.id);
    } catch (error) {
        if (isReadAbort(error, options.signal)) return aborted();
        if (error instanceof ResponseLimitError) return failure("protocol", "AIHubMix 图片/视频下载超过本地 256 MiB 限制，已停止读取；保留任务记录，不会重新生成");
        return failure("network", "AIHubMix 结果读取失败，请检查网络和浏览器跨域限制");
    }
}
