import {readHttpJson} from '@momoki/agent-providers/http';
import {requestOnce} from "../../../platform/http/requestBoundary";
import {isReadAbort} from "@momoki/agent-providers/http";
import {redactCredentials} from "@momoki/agent-providers/http";
import {type ChatModelMetadata, parseModelMetadata} from "../../settings/models/modelMetadata";
import {normalizeBaseUrl} from "@momoki/agent-providers/http";

export type ApimartCredentials = { baseUrl: string; apiKey: string };
export type ApimartRequestOptions = { signal?: AbortSignal; fetchImpl?: typeof fetch; idempotencyKey?: string };
export type ApimartJson = null | boolean | number | string | ApimartJson[] | { [key: string]: ApimartJson };
export type ApimartFailure = {
    ok: false;
    kind: "validation" | "http" | "provider" | "protocol" | "network" | "aborted";
    message: string;
    httpStatus?: number;
    providerCode?: string | number;
    providerType?: string;
};
export type ApimartResult<T> = ({ ok: true } & T) | ApimartFailure;

/** Metadata only: endpoint and schema references are never fetched or executed. */
export type ApimartModelParameters = {
    [key: string]: ApimartJson;
    input_schema: { [key: string]: ApimartJson } | boolean;
};
export type ApimartModel = {
    metadata?: ChatModelMetadata;
    id: string;
    category: string;
    capabilityTags: string[];
    parameters?: ApimartModelParameters;
    parameterStatus: "available" | "missing" | "invalid";
};
export type ApimartModelQuery = {
    expand?: "category" | "parameters";
    category?: "chat" | "image" | "video" | "audio" | "unknown";
};

/** Server-side model validation is authoritative; extension fields retain native names. */
export type ApimartGenerationRequest = {
    model: string;
    prompt?: string;
    [key: string]: ApimartJson | undefined;
};
export type ApimartImageGenerationRequest = ApimartGenerationRequest & {
    n?: number;
    size?: string;
    image_urls?: ApimartJson[];
};
export type ApimartVideoGenerationRequest = ApimartGenerationRequest & {
    duration?: number;
    size?: string;
    aspect_ratio?: string;
    generate_audio?: boolean;
    image_urls?: ApimartJson[];
    image_with_roles?: ApimartJson[];
};
export type ApimartTaskStatus = "pending" | "processing" | "completed" | "failed" | "cancelled" | "unknown";
export type ApimartMediaResult = { urls: string[]; expiresAt?: number };
export type ApimartTask = {
    id: string;
    status: ApimartTaskStatus;
    providerStatus: string;
    progress?: number;
    images: ApimartMediaResult[];
    videos: ApimartMediaResult[];
    cost?: number;
    creditsCost?: number;
    createdAt?: number;
    completedAt?: number;
    estimatedTime?: number;
    actualTime?: number;
    error?: { code?: string | number; message?: string; type?: string };
};
export type ApimartUpload = {
    url: string;
    filename?: string;
    contentType?: string;
    bytes?: number;
    createdAt?: number;
    /** Unix seconds, derived from APIMart's documented 72-hour retention. */
    expiresAt?: number;
};

export const APIMART_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
};

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function finite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function jsonValue(value: unknown): value is ApimartJson {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(jsonValue);
    return record(value) && Object.values(value).every(jsonValue);
}

function redact(value: string, key: string): string {
    return redactCredentials(value, key).slice(0, 300);
}

function failure(kind: ApimartFailure["kind"], message: string): ApimartFailure {
    return {ok: false, kind, message};
}

function protocol(): ApimartFailure {
    return failure("protocol", "APIMart 返回的数据格式不符合接口约定");
}

function safeUrl(value: unknown): value is string {
    if (!nonempty(value)) return false;
    try {
        const url = new URL(value);
        return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
    } catch {
        return false;
    }
}

function providerError(value: unknown, key: string): ApimartTask["error"] {
    if (!record(value)) return undefined;
    return {
        code: typeof value.code === "string" ? redact(value.code, key) : finite(value.code) ? value.code : undefined,
        message: typeof value.message === "string" ? redact(value.message, key) : undefined,
        type: typeof value.type === "string" ? redact(value.type, key) : undefined,
    };
}

function acceptedCode(code: unknown): boolean {
    return code === 200 || code === 202;
}

async function request(
    credentials: ApimartCredentials,
    path: string,
    init: { method: "GET" | "POST"; body?: string | FormData; headers?: Record<string, string> },
    options: ApimartRequestOptions,
): Promise<ApimartResult<{ data: Record<string, unknown> }>> {
    const base = normalizeBaseUrl(credentials.baseUrl);
    const key = credentials.apiKey.trim();
    if (!base) return failure("validation", "请填写 Base URL");
    if (!key) return failure("validation", "请填写 API Key");
    if (!safeUrl(base) || new URL(base).search || new URL(base).hash) {
        return failure("validation", "Base URL 必须是有效的 HTTP(S) 地址，且不包含查询参数或片段");
    }
    if (options.signal?.aborted) return failure("aborted", "请求已中止；已提交的远端任务不会因此取消");
    try {
        const response = await requestOnce(`${base}${path}`, {
            ...init,
            headers: {
                ...(typeof init.body === "string" ? {"Content-Type": "application/json"} : {}),
                ...init.headers,
                Authorization: `Bearer ${key}`,
            },
        }, {fetchImpl: options.fetchImpl, signal: options.signal, credentials: "omit", redirect: "error"});
        // Read as unknown even when HTTP is successful: provider errors also use HTTP 200.
        let body: unknown;
        try {
            body = await readHttpJson(response, {
                success: {kind: "native-json"},
                failure: {kind: "native-json"}
            }, options.signal);
        } catch (error) {
            if (isReadAbort(error, options.signal)) throw error;
            if (response.ok) return protocol();
        }
        const envelope = record(body) ? body : undefined;
        const error = providerError(envelope?.error, key);
        const code = envelope?.code;
        const providerFailed = envelope?.success === false ||
            (code !== undefined && !acceptedCode(code)) || (envelope?.error !== undefined && envelope.error !== null);
        if (!response.ok || providerFailed) {
            const prefix = response.status === 401 || response.status === 403 ? "鉴权失败" : "APIMart 请求失败";
            const detail = error?.message ?? (typeof envelope?.message === "string" ? redact(envelope.message, key) : undefined);
            return {
                ok: false,
                kind: response.ok ? "provider" : "http",
                message: `${prefix}（${response.status}）${detail ? `：${detail}` : ""}`,
                httpStatus: response.status,
                providerCode: error?.code ?? (typeof code === "string" ? redact(code, key) : finite(code) ? code : undefined),
                providerType: error?.type,
            };
        }
        return envelope ? {ok: true, data: envelope} : protocol();
    } catch (error) {
        if (isReadAbort(error, options.signal)) {
            return failure("aborted", "请求已中止；已提交的远端任务不会因此取消");
        }
        // Do not expose raw transport errors: they may contain credentials or request data.
        return failure("network", "无法连接 APIMart，请检查网络、Base URL 和浏览器跨域限制；提交结果可能尚未确认");
    }
}

function modelParameters(value: unknown): ApimartModelParameters | undefined {
    if (!record(value) || !jsonValue(value)) return undefined;
    const schema = value.input_schema;
    if (typeof schema !== "boolean" && !record(schema)) return undefined;
    if (record(schema)) {
        if (schema.properties !== undefined && !record(schema.properties)) return undefined;
        if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every(nonempty))) return undefined;
        if (schema.type !== undefined && typeof schema.type !== "string" &&
            !(Array.isArray(schema.type) && schema.type.every(nonempty))) return undefined;
    }
    return {...value, input_schema: schema};
}

export async function listApimartModels(
    credentials: ApimartCredentials,
    query: ApimartModelQuery = {},
    options: ApimartRequestOptions = {},
): Promise<ApimartResult<{ models: ApimartModel[] }>> {
    const params = new URLSearchParams({expand: query.expand ?? "category"});
    if (query.category) params.set("category", query.category);
    const response = await request(credentials, `/models?${params}`, {method: "GET"}, options);
    if (!response.ok) return response;
    if (!Array.isArray(response.data.data)) return protocol();
    const models: ApimartModel[] = [];
    for (const row of response.data.data) {
        if (!record(row) || !nonempty(row.id)) return protocol();
        const parameters = modelParameters(row.parameters);
        models.push({
            ...(parseModelMetadata(row) ? {metadata: parseModelMetadata(row)} : {}),
            id: row.id.trim(),
            category: nonempty(row.category) ? row.category.trim() : "unknown",
            capabilityTags: Array.isArray(row.capability_tags) ? row.capability_tags.filter(nonempty) : [],
            parameters,
            parameterStatus: parameters ? "available" : row.parameters == null ? "missing" : "invalid",
        });
    }
    return {ok: true, models};
}

/** A read-only probe. Never falls back to a paid generation/chat request. */
export async function testApimartConnection(
    credentials: ApimartCredentials,
    options: ApimartRequestOptions = {},
): Promise<ApimartResult<{ modelCount: number }>> {
    const result = await listApimartModels(credentials, {expand: "category"}, options);
    return result.ok ? {ok: true, modelCount: result.models.length} : result;
}

export async function uploadApimartImage(
    credentials: ApimartCredentials,
    file: Blob,
    options: ApimartRequestOptions & { filename?: string } = {},
): Promise<ApimartResult<{ image: ApimartUpload }>> {
    const extension = IMAGE_EXTENSIONS[file.type];
    if (!extension) return failure("validation", "参考图仅支持 JPEG、PNG、WebP 或 GIF 格式");
    if (file.size <= 0 || file.size > APIMART_MAX_IMAGE_BYTES) return failure("validation", "参考图不能为空，且不能超过 20 MB");
    const filename = options.filename || ("name" in file && typeof file.name === "string" ? file.name : `reference.${extension}`);
    const body = new FormData();
    body.append("file", file, filename);
    const response = await request(credentials, "/uploads/images", {method: "POST", body}, options);
    if (!response.ok) return response;
    const data = response.data;
    if (!safeUrl(data.url)) return protocol();
    const createdAt = finite(data.created_at) ? data.created_at : undefined;
    return {
        ok: true,
        image: {
            url: data.url,
            filename: typeof data.filename === "string" ? data.filename : undefined,
            contentType: typeof data.content_type === "string" ? data.content_type : undefined,
            bytes: finite(data.bytes) ? data.bytes : undefined,
            createdAt,
            expiresAt: createdAt === undefined ? undefined : createdAt + 72 * 60 * 60,
        },
    };
}

function parseSubmittedTasks(data: unknown, allowObject: boolean): ApimartResult<{
    tasks: { id: string; providerStatus?: string }[]
}> {
    if (Array.isArray(data) && data.length > 0) {
        const tasks: { id: string; providerStatus?: string }[] = [];
        for (const row of data) {
            if (!record(row) || !nonempty(row.task_id)) return protocol();
            tasks.push({id: row.task_id, providerStatus: typeof row.status === "string" ? row.status : undefined});
        }
        return {ok: true, tasks};
    }
    if (allowObject && record(data)) {
        const id = nonempty(data.id) ? data.id : nonempty(data.task_id) ? data.task_id : undefined;
        if (!id) return protocol();
        return {ok: true, tasks: [{id, providerStatus: typeof data.status === "string" ? data.status : undefined}]};
    }
    return protocol();
}

async function submitGeneration(
    credentials: ApimartCredentials,
    input: ApimartGenerationRequest,
    path: string,
    options: ApimartRequestOptions,
    allowObject: boolean,
): Promise<ApimartResult<{ tasks: { id: string; providerStatus?: string }[] }>> {
    if (!nonempty(input.model)) return failure("validation", "请指定生成模型");
    let body: string;
    try {
        // Reject non-JSON values before stringify silently turns NaN into null.
        if (!Object.values(input).every((value) => value === undefined || jsonValue(value))) {
            return failure("validation", "生成参数必须是有效的 JSON");
        }
        body = JSON.stringify(input);
    } catch {
        return failure("validation", "生成参数必须是有效的 JSON");
    }
    const headers = input.model === "gpt-image-2.5-ext" && path === "/images/generations" ? {
        "X-APIMart-Response-Version": "2026-07-27",
        ...(options.idempotencyKey ? {"Idempotency-Key": options.idempotencyKey} : {}),
    } : undefined;
    // Exactly one request: retries after network/abort failure could create duplicate paid jobs.
    const response = await request(credentials, path, {method: "POST", body, headers}, options);
    if (!response.ok) return response;
    if (!acceptedCode(response.data.code)) return protocol();
    return parseSubmittedTasks(response.data.data, allowObject);
}

export function submitApimartImageGeneration(
    credentials: ApimartCredentials,
    input: ApimartImageGenerationRequest,
    options: ApimartRequestOptions = {},
) {
    return submitGeneration(credentials, input, "/images/generations", options, true);
}

export function submitApimartVideoGeneration(
    credentials: ApimartCredentials,
    input: ApimartVideoGenerationRequest,
    options: ApimartRequestOptions = {},
) {
    return submitGeneration(credentials, input, "/videos/generations", options, false);
}

function mediaResults(value: unknown): ApimartMediaResult[] | undefined {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return undefined;
    const results: ApimartMediaResult[] = [];
    for (const row of value) {
        if (!record(row)) return undefined;
        const urls = Array.isArray(row.url) ? row.url : [row.url];
        if (!urls.length || !urls.every(safeUrl)) return undefined;
        if (row.expires_at !== undefined && !finite(row.expires_at)) return undefined;
        results.push({urls, expiresAt: finite(row.expires_at) ? row.expires_at : undefined});
    }
    return results;
}

function taskStatus(value: string): ApimartTaskStatus {
    switch (value) {
        case "pending":
        case "processing":
        case "completed":
        case "failed":
        case "cancelled":
            return value;
        default:
            return "unknown";
    }
}

/** One status read, no polling or media downloads. Aborting does not cancel a remote job. */
export async function getApimartTask(
    credentials: ApimartCredentials,
    taskId: string,
    options: ApimartRequestOptions = {},
): Promise<ApimartResult<{ task: ApimartTask }>> {
    if (!nonempty(taskId) || taskId === "." || taskId === "..") return failure("validation", "请提供有效的任务 ID");
    const response = await request(credentials, `/tasks/${encodeURIComponent(taskId)}?language=zh`, {method: "GET"}, options);
    if (!response.ok) return response;
    const data = response.data.data;
    if (response.data.code !== 200 || !record(data) || !nonempty(data.id) || !nonempty(data.status) || data.id !== taskId) return protocol();
    if (data.result != null && !record(data.result)) return protocol();
    const result = record(data.result) ? data.result : {};
    const images = mediaResults(result.images);
    const videos = mediaResults(result.videos);
    if (!images || !videos || (data.status === "completed" && images.length + videos.length === 0)) return protocol();
    return {
        ok: true,
        task: {
            id: data.id, status: taskStatus(data.status), providerStatus: data.status,
            progress: finite(data.progress) ? data.progress : undefined,
            images, videos,
            cost: finite(data.cost) ? data.cost : undefined,
            creditsCost: finite(data.credits_cost) ? data.credits_cost : undefined,
            createdAt: finite(data.created) ? data.created : undefined,
            completedAt: finite(data.completed) ? data.completed : undefined,
            estimatedTime: finite(data.estimated_time) ? data.estimated_time : undefined,
            actualTime: finite(data.actual_time) ? data.actual_time : undefined,
            error: providerError(data.error, credentials.apiKey),
        },
    };
}
