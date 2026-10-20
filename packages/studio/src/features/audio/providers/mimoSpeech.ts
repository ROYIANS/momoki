import {requestOnce} from "../../../platform/http/requestBoundary";
import {isReadAbort, readErrorText, readResponseText, ResponseLimitError} from "@momoki/agent-providers/http";
import {MAX_AUDIO_BYTES, MAX_ERROR_BYTES, MAX_JSON_BYTES, MAX_SPEECH_ENVELOPE_BYTES} from "../../../platform/media/limits";
import type {MimoSpeechSettings} from "../models/audio";
import {detectAudioMime} from "../engine/mime";
import {collectModelMetadata, parseModelMetadata} from "../../settings/models/modelMetadata";
import type {ListModelsResult} from "../../agent/providers/openaiCompatible";
import {normalizeBaseUrl} from "@momoki/agent-providers/http";
import {redactCredentials} from "@momoki/agent-providers/http";

export const MIMO_VOICES = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"] as const;
export const MIMO_MODELS = {
    preset: "mimo-v2.5-tts", design: "mimo-v2.5-tts-voicedesign", clone: "mimo-v2.5-tts-voiceclone",
} as const;
/** Documented audio-only models, not a name heuristic. */
export const MIMO_NON_CHAT_MODELS: readonly string[] = [...Object.values(MIMO_MODELS), "mimo-v2.5-asr"];
export const MIMO_REFERENCE_ENCODED_LIMIT = 10 * 1024 * 1024;
export type MimoCredentials = { baseUrl: string; apiKey: string };
export type MimoRequestOptions = { fetchImpl?: typeof fetch; signal?: AbortSignal };
export type MimoFailure = {
    ok: false;
    kind: "validation" | "http" | "provider" | "protocol" | "network" | "aborted";
    message: string;
    /** Structured response evidence for paid retry; the human message is not a classifier. */
    httpStatus?: number
};
const fail = (kind: MimoFailure["kind"], message: string): MimoFailure => ({ok: false, kind, message});
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const protocol = () => fail("protocol", "MiMo 未返回完整有效的配音文件；请保留任务记录，不要自动重复生成");

function connection(credentials: MimoCredentials): { base: string; key: string } | undefined {
    const base = normalizeBaseUrl(credentials.baseUrl), key = credentials.apiKey.trim();
    try {
        const url = new URL(base);
        if (!key || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/v1")) return;
        return {base, key};
    } catch {
        return;
    }
}

/** Classify the bounded body without losing observed HTTP failures or reader aborts. */
async function readMimoResponse(response: Response, limit: number, key: string, signal?: AbortSignal): Promise<{
    ok: true;
    data: unknown
} | MimoFailure> {
    let text: string;
    try {
        text = response.ok
            ? await readResponseText(response, limit, signal)
            : await readErrorText(response, MAX_ERROR_BYTES, signal);
    } catch (error) {
        if (isReadAbort(error, signal)) throw error;
        return error instanceof ResponseLimitError ? fail("protocol", error.message) : protocol();
    }
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch { /* Preserve HTTP status, otherwise protocol failure. */
    }
    if (!response.ok || (record(data) && data.error != null)) {
        const detail = record(data) && record(data.error) && typeof data.error.message === "string" ? data.error.message : text;
        return {...fail(response.ok ? "provider" : "http", `MiMo 请求失败${response.ok ? "" : `（${response.status}）`}：${redactCredentials(detail, key).slice(0, 300) || "请检查连接权限、余额和参数"}`), ...(!response.ok ? {httpStatus: response.status} : {})};
    }
    return {ok: true, data};
}

async function request(credentials: MimoCredentials, path: "/models" | "/chat/completions", body: unknown, options: MimoRequestOptions): Promise<{
    ok: true;
    data: unknown
} | MimoFailure> {
    const config = connection(credentials);
    if (!config) return fail("validation", "请配置有效的 MiMo Base URL（以 /v1 结尾）和 API Key");
    if (options.signal?.aborted) return fail("aborted", "请求已停止；远端生成不会因此取消");
    try {
        const response = await requestOnce(`${config.base}${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {Authorization: `Bearer ${config.key}`, ...(body === undefined ? {} : {"Content-Type": "application/json"})},
            ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        }, {fetchImpl: options.fetchImpl, signal: options.signal, credentials: "omit", redirect: "error"});
        return await readMimoResponse(response, path === "/models" ? MAX_JSON_BYTES : MAX_SPEECH_ENVELOPE_BYTES, config.key, options.signal);
    } catch (error) {
        if (isReadAbort(error, options.signal)) return fail("aborted", "请求已停止；远端生成不会因此取消");
        if (error instanceof ResponseLimitError) return protocol();
        const detail = redactCredentials(error instanceof Error ? error.message : "网络错误", config.key).slice(0, 200);
        return fail("network", `MiMo 请求未完成：${detail}；不会自动重复提交`);
    }
}

/** Read-only authentication/model probe, never falls back to paid chat. */
export async function listMimoModels(credentials: MimoCredentials, options: MimoRequestOptions = {}): Promise<ListModelsResult> {
    const result = await request(credentials, "/models", undefined, options);
    if (!result.ok) return result;
    const body = result.data;
    if (!record(body) || !Array.isArray(body.data) || !body.data.every(row => record(row) && typeof row.id === "string" && row.id.trim())) return {
        ok: false,
        message: "MiMo 模型目录响应无效"
    };
    const rows = body.data as Array<Record<string, unknown> & { id: string }>;
    const entries = rows.flatMap(row => {
        const metadata = parseModelMetadata(row);
        return metadata ? [[row.id.trim(), metadata] as const] : [];
    });
    return {
        ok: true,
        models: [...new Set(rows.map(row => row.id.trim()))].sort((a, b) => a.localeCompare(b)), ...(entries.length ? {metadata: collectModelMetadata(entries)} : {})
    };
}

/** Validate actual container bytes, ignoring a misleading declared MIME. Runtime also decodes. */
export async function validateMimoReference(blob: Blob): Promise<"audio/wav" | "audio/mpeg"> {
    if (!blob.size || Math.ceil(blob.size / 3) * 4 > MIMO_REFERENCE_ENCODED_LIMIT) throw new Error("克隆参考音频编码后（含前缀）不能超过 10 MB");
    let mime: string;
    try {
        mime = await detectAudioMime(blob.slice(0, 64, ""));
    } catch {
        throw new Error("克隆参考音频必须是有效的 WAV 或 MP3 文件");
    }
    if (mime !== "audio/wav" && mime !== "audio/mpeg") throw new Error("克隆参考音频仅支持 WAV 或 MP3，请先转换格式");
    if (Math.ceil(blob.size / 3) * 4 + `data:${mime};base64,`.length > MIMO_REFERENCE_ENCODED_LIMIT) throw new Error("克隆参考音频编码后（含前缀）不能超过 10 MB");
    return mime;
}

async function referenceDataUri(blob: Blob): Promise<string> {
    const mime = await validateMimoReference(blob);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
    return `data:${mime};base64,${btoa(binary)}`;
}

export async function generateMimoSpeech(credentials: MimoCredentials, input: {
    text: string;
    voice: string;
    mimo: MimoSpeechSettings;
    referenceBlob?: Blob
}, options: MimoRequestOptions = {}): Promise<{
    ok: true;
    blob: Blob;
    finalTextPreview?: string;
    model: string
} | MimoFailure> {
    const {mimo, text} = input;
    if (!mimo || !Object.hasOwn(MIMO_MODELS, mimo.mode) || typeof mimo.instruction !== "string" || typeof text !== "string") return fail("validation", "MiMo 配音参数无效");
    if (mimo.mode === "design" && !mimo.instruction.trim()) return fail("validation", "请描述要设计的音色");
    if (!text.trim() && !(mimo.mode === "design" && mimo.optimizeTextPreview === true)) return fail("validation", "请输入配音文字");
    if ((mimo.mode !== "design" && mimo.optimizeTextPreview !== undefined) || (mimo.mode !== "clone" && (mimo.referenceMediaId !== undefined || input.referenceBlob !== undefined))) return fail("validation", "音色参数与当前模式不匹配");
    if (mimo.mode === "preset" && !(MIMO_VOICES as readonly string[]).includes(input.voice)) return fail("validation", "请选择 MiMo 预置音色");
    if (mimo.mode === "clone" && (!mimo.referenceMediaId?.trim() || !input.referenceBlob)) return fail("validation", "请选择克隆参考音频");
    const messages = [
        ...(mimo.instruction.trim() ? [{role: "user", content: mimo.instruction}] : []),
        ...(text.trim() ? [{role: "assistant", content: text}] : []),
    ];
    let voice: string | undefined;
    try {
        if (mimo.mode === "clone") voice = await referenceDataUri(input.referenceBlob!);
        else if (mimo.mode === "preset") voice = input.voice;
    } catch (error) {
        return fail("validation", error instanceof Error ? error.message : "克隆参考音频无效");
    }
    const model = MIMO_MODELS[mimo.mode];
    const result = await request(credentials, "/chat/completions", {
        model, messages, stream: false,
        audio: {format: "wav", ...(voice !== undefined ? {voice} : {}), ...(mimo.mode === "design" ? {optimize_text_preview: mimo.optimizeTextPreview ?? false} : {})},
    }, options);
    if (!result.ok) return result;
    const body = result.data;
    const choice: unknown = record(body) && Array.isArray(body.choices) ? body.choices[0] : undefined;
    if (!record(choice) || choice.finish_reason !== "stop" || !record(choice.message) || !record(choice.message.audio)) return protocol();
    const message = choice.message, encoded = choice.message.audio.data;
    if (typeof encoded !== "string" || !encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return protocol();
    let padding = 0;
    if (encoded.endsWith("=")) padding = 1;
    if (encoded.endsWith("==")) padding = 2;
    if (encoded.length / 4 * 3 - padding > MAX_AUDIO_BYTES) return fail("protocol", "MiMo 配音超过本地 32 MiB 音频限制；不会自动重新生成");
    try {
        const decoded = atob(encoded), bytes = new Uint8Array(decoded.length);
        // Copy binary code units directly without materializing an iterable of audio-sized characters.
        for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
        // Validate a WAV container; the runtime performs the complete audio decode after checkpointing.
        const blob = new Blob([bytes], {type: "audio/wav"});
        if (blob.size > MAX_AUDIO_BYTES) return fail("protocol", "MiMo 配音超过本地 32 MiB 音频限制；不会自动重新生成");
        if (await detectAudioMime(blob.slice(0, 64, "")) !== "audio/wav") return protocol();
        const preview = message.final_text_preview;
        if (mimo.optimizeTextPreview && (typeof preview !== "string" || !preview.trim())) return protocol();
        return {
            ok: true,
            blob,
            model, ...(typeof preview === "string" && preview.trim() ? {finalTextPreview: preview} : {})
        };
    } catch {
        return protocol();
    }
}
