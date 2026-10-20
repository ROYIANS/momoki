import {readHttpJson} from '@momoki/agent-providers/http';
import {requestOnce} from "../../../platform/http/requestBoundary";
import {isReadAbort, readResponseBlob, ResponseLimitError} from "@momoki/agent-providers/http";
import {MAX_AUDIO_BYTES, MAX_ERROR_BYTES, MAX_JSON_BYTES} from "../../../platform/media/limits";
import {canonicalizeAudioTaskIds, isAudioTaskId} from "../generation/taskIds";
import {z} from "zod";
import {MUSIC_DURATION_LIMITS} from "../../music/models/music";
import type {ApimartCredentials, ApimartFailure, ApimartRequestOptions, ApimartResult} from "../../video/providers/apimart";
import {normalizeBaseUrl} from "@momoki/agent-providers/http";
import {redactCredentials} from "@momoki/agent-providers/http";

export const SPEECH_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
const unicode = (max: number) => z.string().refine(value => [...value].length <= max, `最多 ${max} 个字符`);
export const speechInputSchema = z.object({
    model: z.literal("gpt-4o-mini-tts"), input: unicode(4096).refine(value => !!value.trim(), "请输入配音文字"),
    voice: z.enum(SPEECH_VOICES), response_format: z.enum(["wav", "opus", "aac", "flac", "pcm"]),
    speed: z.number().finite().min(.25).max(4).optional(),
}).strict();
export const flowMusicInputSchema = z.object({
    model: z.literal("flowmusic"),
    sound_prompt: z.string().optional(),
    lyrics: z.string().optional(),
    title: z.string().optional(),
    bpm: z.string().refine(value => value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 1, "BPM 必须至少为 1").optional(),
    length: z.number().int("音乐时长必须为整数秒").min(MUSIC_DURATION_LIMITS.flowmusic.min).max(MUSIC_DURATION_LIMITS.flowmusic.max).optional(),
    seed: z.string().optional(),
}).strict().refine(value => !!(value.sound_prompt?.trim() || value.lyrics?.trim()), "请填写风格描述或歌词");
export const sunoMusicInputSchema = z.object({
    model: z.literal("suno"),
    version: z.enum(["v6", "v6-wild", "v6-mini"]),
    custom: z.boolean(),
    instrumental: z.boolean(),
    prompt: unicode(5000).optional(),
    title: unicode(80).optional(),
    style: unicode(1000).optional(),
    negative_tags: z.string().optional(),
    auto_lyrics: z.boolean().optional(),
    vocal_gender: z.enum(["Male", "Female"]).optional(),
    style_weight: z.number().finite().min(0).max(1).optional(),
    weirdness_constraint: z.number().finite().min(0).max(1).optional(),
    audio_weight: z.number().finite().min(0).max(1).optional(),
    variety: z.enum(["off", "normal", "high", "extra", "max"]).optional(),
    max_mode: z.boolean().optional(),
    audio_format: z.enum(["mp3", "m4a", "wav"]).optional(),
    duration: z.number().int("音乐时长必须为整数秒").min(MUSIC_DURATION_LIMITS.suno.min).max(MUSIC_DURATION_LIMITS.suno.max).optional(),
}).strict().superRefine((value, ctx) => {
    const issue = (message: string) => ctx.addIssue({code: "custom", message});
    if ((!value.custom || !value.instrumental) && !value.prompt?.trim()) issue("请填写创作描述或歌词");
    if (!value.custom && [...(value.prompt ?? "")].length > 3000) issue("灵感描述最多 3000 个字符");
    if (!value.custom && [value.title, value.style, value.negative_tags, value.auto_lyrics, value.duration, value.max_mode].some(field => field !== undefined)) issue("标题、风格、歌词调整、时长和 Max 模式仅适用于自定义模式");
});
export type SpeechInput = z.infer<typeof speechInputSchema>;
export type FlowMusicInput = z.infer<typeof flowMusicInputSchema>;
export type SunoMusicInput = z.infer<typeof sunoMusicInputSchema>;
export type MusicInput = FlowMusicInput | SunoMusicInput;
export const musicInputSchema = z.union([flowMusicInputSchema, sunoMusicInputSchema]);

export interface MusicResultTrack {
    /** Provider array position, one-based; never derive from a sorted/filtered list. */
    audioIndex: number;
    clipId?: string;
    audioId?: string;
    title: string;
    lyrics?: string;
    duration?: number;
    audioUrl: string;
    wavUrl?: string;
    imageUrl?: string;
}

export interface MusicTask {
    id: string;
    status: "pending" | "processing" | "completed" | "failed" | "unknown";
    providerStatus: string;
    progress?: number;
    tracks: MusicResultTrack[];
    cost?: number;
    creditsCost?: number;
    error?: string;
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nonempty = (v: unknown): v is string => typeof v === "string" && !!v.trim();

function safeUrl(v: unknown): v is string {
    if (!nonempty(v)) return false;
    try {
        const u = new URL(v);
        return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password;
    } catch {
        return false;
    }
}

const failure = (kind: ApimartFailure["kind"], message: string): ApimartFailure => ({ok: false, kind, message});
const protocol = () => failure("protocol", "APIMart 音频响应不符合接口约定；请保留任务记录，不要自动重复提交");

async function audioRequest(credentials: ApimartCredentials, path: string, input: SpeechInput | MusicInput | undefined, options: ApimartRequestOptions): Promise<ApimartResult<{
    response: Response
}>> {
    const base = normalizeBaseUrl(credentials.baseUrl), key = credentials.apiKey.trim();
    if (!key || !safeUrl(base) || new URL(base).search || new URL(base).hash) return failure("validation", "请配置有效的 APIMart 地址和 API Key");
    if (options.signal?.aborted) return failure("aborted", "请求已停止；远端生成不会因此取消");
    try {
        const response = await requestOnce(`${base}${path}`, {
            method: input ? "POST" : "GET",
            headers: {Authorization: `Bearer ${key}`, ...(input ? {"Content-Type": "application/json"} : {})},
            ...(input ? {body: JSON.stringify(input)} : {}),
        }, {fetchImpl: options.fetchImpl, signal: options.signal, credentials: "omit", redirect: "error"});
        if (!response.ok) {
            let body: unknown;
            try {
                body = await readHttpJson(response, {
                    success: {
                        kind: "bounded-json",
                        maxBytes: MAX_JSON_BYTES,
                        fatalUtf8: true
                    }, failure: {kind: "bounded-json", maxBytes: MAX_ERROR_BYTES, fatalUtf8: true}
                }, options.signal);
            } catch (error) {
                if (isReadAbort(error, options.signal)) return failure("aborted", "请求已停止；远端生成不会因此取消");
                /* HTTP status remains authoritative for other body failures. */
            }
            const error = record(body) && record(body.error) ? body.error : undefined;
            const detail = typeof error?.message === "string" ? redactCredentials(error.message, key).slice(0, 300) : "请检查连接权限、余额和请求参数";
            return {
                ok: false,
                kind: "http",
                httpStatus: response.status,
                message: `APIMart 请求失败（${response.status}）：${detail}`
            };
        }
        return {ok: true, response};
    } catch (error) {
        return failure(isReadAbort(error, options.signal) ? "aborted" : "network", "音频请求未能完成；提交结果可能尚未确认，请勿自动重复生成");
    }
}

async function jsonEnvelope(credentials: ApimartCredentials, path: string, input: MusicInput | undefined, options: ApimartRequestOptions): Promise<ApimartResult<{
    data: unknown
}>> {
    const result = await audioRequest(credentials, path, input, options);
    if (!result.ok) return result;
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
        if (isReadAbort(error, options.signal)) return failure("aborted", "请求已停止；远端生成不会因此取消");
        return error instanceof ResponseLimitError ? failure("protocol", error.message) : protocol();
    }
    if (!record(body)) return protocol();
    if (body.error != null || body.success === false || (body.code !== undefined && body.code !== 200)) {
        const message = record(body.error) ? body.error.message : body.message;
        return failure("provider", typeof message === "string" ? redactCredentials(message, credentials.apiKey).slice(0, 300) : "APIMart 音频任务失败");
    }
    return body.code === 200 ? {ok: true, data: body.data} : protocol();
}

function speechReadFailure(error: unknown, signal?: AbortSignal): ApimartFailure {
    if (isReadAbort(error, signal)) return failure("aborted", "请求已停止；远端生成不会因此取消");
    const message = error instanceof ResponseLimitError
        ? "配音响应超过本地读取限制（音频 32 MiB / JSON 4 MiB）；不会自动重新生成"
        : "未能读取完整的配音文件；不会自动重新生成";
    return failure("protocol", message);
}

export async function generateApimartSpeech(credentials: ApimartCredentials, input: SpeechInput, options: ApimartRequestOptions = {}): Promise<ApimartResult<{
    blob: Blob
}>> {
    const parsed = speechInputSchema.safeParse(input);
    if (!parsed.success) return failure("validation", parsed.error.issues[0]?.message ?? "配音参数无效");
    const result = await audioRequest(credentials, "/audio/speech", parsed.data, options);
    if (!result.ok) return result;
    try {
        const isJson = result.response.headers.get("content-type")?.includes("application/json");
        const blob = await readResponseBlob(result.response, isJson ? MAX_JSON_BYTES : MAX_AUDIO_BYTES, options.signal);
        const mime = blob.type.split(";")[0];
        if (mime === "application/json") {
            const body: unknown = JSON.parse(await blob.text());
            const message = record(body) && record(body.error) ? body.error.message : undefined;
            return failure("provider", typeof message === "string" ? redactCredentials(message, credentials.apiKey).slice(0, 300) : "APIMart 未返回配音文件");
        }
        if (!blob.size || (mime && !mime.startsWith("audio/") && mime !== "application/octet-stream")) return protocol();
        const mimeTypes = {wav: "audio/wav", opus: "audio/ogg", aac: "audio/aac", flac: "audio/flac", pcm: "audio/pcm"};
        return {
            ok: true,
            blob: new Blob([blob], {type: mime?.startsWith("audio/") ? blob.type : mimeTypes[input.response_format]})
        };
    } catch (error) {
        return speechReadFailure(error, options.signal);
    }
}

export async function submitApimartMusic(credentials: ApimartCredentials, input: MusicInput, options: ApimartRequestOptions = {}): Promise<ApimartResult<{
    taskIds: string[]
}>> {
    const parsed = musicInputSchema.safeParse(input);
    if (!parsed.success) return failure("validation", parsed.error.issues[0]?.message ?? "音乐参数无效");
    const result = await jsonEnvelope(credentials, "/music/generations", parsed.data, options);
    if (!result.ok) return result;
    if (!Array.isArray(result.data) || !result.data.length || !result.data.every(record)) return protocol();
    try {
        return {ok: true, taskIds: canonicalizeAudioTaskIds(result.data.map(row => row.task_id))};
    } catch {
        return protocol();
    }
}

export async function getApimartMusicTask(credentials: ApimartCredentials, taskId: string, options: ApimartRequestOptions = {}): Promise<ApimartResult<{
    task: MusicTask
}>> {
    if (!isAudioTaskId(taskId)) return failure("validation", "音乐任务 ID 无效；请保留任务记录，不要重复提交");
    const result = await jsonEnvelope(credentials, `/music/tasks/${encodeURIComponent(taskId)}?language=zh`, undefined, options);
    if (!result.ok) return result;
    const row = result.data;
    if (!record(row) || row.id !== taskId || !nonempty(row.status)) return protocol();
    const statuses = ["pending", "processing", "completed", "failed"];
    const status = statuses.includes(row.status) ? row.status as MusicTask["status"] : "unknown";
    const tracks: MusicResultTrack[] = [];
    const diagnostics: string[] = [];
    const music = record(row.result) ? row.result.music : undefined;
    if (status === "completed") {
        if (!Array.isArray(music) || !music.length) return protocol();
        for (const [index, track] of music.entries()) {
            if (!record(track) || !safeUrl(track.audio_url)) {
                diagnostics.push(`第 ${index + 1} 首音频缺少有效下载地址`);
                continue;
            }
            const rawDuration = track.duration ?? track.duration_seconds;
            const duration = typeof rawDuration === "string" && rawDuration.trim() ? Number(rawDuration) : rawDuration;
            tracks.push({
                audioIndex: index + 1, audioUrl: track.audio_url,
                title: typeof track.title === "string" ? track.title : `作品 ${index + 1}`,
                ...(nonempty(track.clip_id) ? {clipId: track.clip_id} : {}), ...(nonempty(track.audio_id) ? {audioId: track.audio_id} : {}),
                ...(typeof track.lyrics === "string" ? {lyrics: track.lyrics} : {}),
                ...(finite(duration) && duration > 0 ? {duration} : {}),
                ...(safeUrl(track.wav_url) ? {wavUrl: track.wav_url} : {}), ...(safeUrl(track.image_url) ? {imageUrl: track.image_url} : {}),
            });
        }
    }
    return {
        ok: true, task: {
            id: taskId, status, providerStatus: row.status, tracks,
            ...(finite(row.progress) ? {progress: Math.max(0, Math.min(100, row.progress))} : {}),
            ...(finite(row.cost) ? {cost: row.cost} : {}), ...(finite(row.credits_cost) ? {creditsCost: row.credits_cost} : {}),
            ...(diagnostics.length ? {error: diagnostics.join("；")} : record(row.error) && typeof row.error.message === "string" ? {error: redactCredentials(row.error.message, credentials.apiKey).slice(0, 300)} : {}),
        }
    };
}

/** CDN downloads never receive the connector's bearer token. */
export async function downloadApimartAudio(url: string, options: ApimartRequestOptions = {}): Promise<ApimartResult<{
    blob: Blob
}>> {
    if (!safeUrl(url)) return failure("validation", "音频下载地址无效");
    try {
        const response = await requestOnce(url, {}, {
            fetchImpl: options.fetchImpl,
            signal: options.signal,
            credentials: "omit",
            redirect: "error",
            runtimePurpose: "result-download"
        });
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return failure("http", `音频下载失败（${response.status}），可以重试下载`);
        }
        const blob = await readResponseBlob(response, MAX_AUDIO_BYTES, options.signal);
        if (!blob.size || (blob.type && !blob.type.startsWith("audio/") && blob.type !== "application/octet-stream")) return protocol();
        return {ok: true, blob};
    } catch (error) {
        if (isReadAbort(error, options.signal)) return failure("aborted", "音频下载已停止；无需重新生成");
        if (error instanceof ResponseLimitError) return failure("protocol", "音频下载超过本地 32 MiB 限制，已停止读取；保留任务记录，不会重新生成");
        return failure("network", "音频下载未完成，请重试下载；无需重新生成");
    }
}
