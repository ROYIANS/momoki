import {StorageError} from "../../../platform/storage/errors";
import {readBinaryBlob} from "../../../platform/storage/binary";
import {binaryByteLength} from "../../../platform/media/binaryTypes";
import type {ProductStore, StoreTx} from "../../../platform/storage/types";
import {readResponseBlob} from "@cuepoint/agent-providers/http";
import {MAX_MEDIA_DOWNLOAD_BYTES} from "../../../platform/media/limits";
import {redactCredentials} from "@cuepoint/agent-providers/http";
import {ownedGenerationBatch} from "../../agent/commands/agentGenerationBatches";
import {assertProjectToolScope} from "../../agent/runtime/projectScope";
import {db as productDb} from "../../../platform/product/store";
import {
    claimGenerationJob,
    generationJobSummary,
    markUnacknowledgedGeneration,
    storeGenerationMedia,
    updateGenerationJob
} from "../../agent/commands/agentGeneration";
import {AtomicToolRollbackError, executeAtomicTool} from "../../agent/commands/agentTools";
import {resolveConnector} from "../../settings/commands/connectors";
import {setCharacterSlot, setPropSlot, setSceneSlot, setStyleSlot} from "../../library/commands/assets";
import {adoptGeneratedMedia} from "../../library/commands/materials";
import {setShotSlot} from "../commands/shots";
import type {AgentGenerationJob} from "../../agent/models/agentGeneration";
import type {AgentToolPreview} from "../../agent/models/agent";
import type {ProductionTarget} from "../models/production";
import type {ConnectorConfig} from "../../settings/models/connector";
import type {MediaRecord} from "../../library/models/media";
import {flushPendingDrafts} from "../../../platform/product/drafts";
import {createId, nowIso} from "../../../platform/identity";
import {isApimartImage25} from "../models/output";
import {
    getApimartTask,
    submitApimartImageGeneration,
    submitApimartVideoGeneration,
    uploadApimartImage
} from "../providers/apimart";
import type {AIHubMixGenerationRequest, AIHubMixTask} from "../providers/aihubmix";
import {
    downloadAIHubMixResult,
    getAIHubMixImageTask,
    getAIHubMixVideoTask,
    submitAIHubMixImageGeneration,
    submitAIHubMixVideoGeneration
} from "../providers/aihubmix";
import type {AgentToolContext} from "../../agent/runtime/tools";
import {ToolPendingError} from "../../agent/runtime/toolErrors";
import type {GenerationSubmitArgs} from "./generationProfiles";
import {loadGenerationInputs, prepareGenerationSnapshot, resolveGenerationConnector} from "./generationPreparation";
import {libraryMaterialName, readGenerationTarget} from "../../agent/commands/agentGenerationTarget";
import {runtimeResultFetch} from "../../../platform/runtime/runtimeFetch";

export interface GenerationRuntimeOptions {
    fetchImpl?: typeof fetch;
    pollIntervalMs?: number;
    maxPolls?: number
}

export class GenerationPendingError extends ToolPendingError {
    constructor(public readonly jobId: string, message: string) {
        super(message);
        this.name = "GenerationPendingError";
    }
}

function generationTargetHref(target: ProductionTarget): string {
    if (target.kind === "library") return `/assets?project=${encodeURIComponent(target.projectId)}`;
    const id = encodeURIComponent(target.entityId);
    if (target.kind === "shot") return `/p/${encodeURIComponent(target.projectId)}/e/${encodeURIComponent(target.episodeId)}/shots?shot=${id}`;
    const plural = target.kind === "character" ? "characters" : target.kind === "scene" ? "scenes" : target.kind === "prop" ? "props" : "styles";
    return target.projectId === "studio" ? `/${plural}/${id}` : `/p/${encodeURIComponent(target.projectId)}/assets/${plural}/${id}`;
}

function safeTaskId(id: string, config: ConnectorConfig) {
    if (!id.trim() || id.includes(config.apiKey.trim()) || /[\\/?#%]/.test(id) || id === "." || id === "..") throw new Error("供应商任务标识格式异常，提交结果需人工核实");
    return id;
}

function cleanError(error: unknown, config?: ConnectorConfig) {
    const text = error instanceof Error ? error.message : "生成操作失败";
    return redactCredentials(text, config?.apiKey ?? "").slice(0, 700);
}

export async function prepareAgentGeneration(raw: GenerationSubmitArgs, context: AgentToolContext, store?: ProductStore): Promise<AgentToolPreview> {
    const db = store ?? context.store ?? productDb;
    await assertProjectToolScope(context, "submit_generation", {projectId: raw.target.projectId}, true, db);
    const snapshot = await prepareGenerationSnapshot(raw, context.signal, db);
    return {
        summary: `使用 ${snapshot.provider} / ${snapshot.args.model} 为${snapshot.request.target.kind === "library" ? "项目素材库" : `「${snapshot.current.label}」`}生成${snapshot.request.kind === "image" ? "图片" : "视频"}`,
        changes: [snapshot.request.target.kind === "library" ? `保存位置：项目素材库「${snapshot.current.label}」` : `槽位：${snapshot.request.target.slot}`, `提示词：${snapshot.args.prompt.slice(0, 1500)}`, `参考素材：${snapshot.inputs.length} 项；此操作可能产生供应商费用，完成后需要单独写入目标。`],
        revision: snapshot.fingerprint,
        target: {label: snapshot.current.label, href: generationTargetHref(snapshot.request.target)}
    };
}

async function jobForContext(jobId: string, context: Pick<AgentToolContext, 'threadId' | 'signal'> & Partial<AgentToolContext>, store?: ProductStore) {
    const db = store ?? context.store ?? productDb;
    const job = await db.agentGenerationJobs.get(jobId);
    if (!job || job.threadId !== context.threadId || !await db.chatThreads.get(job.threadId) || !await db.agentRuns.get(job.runId)) throw new Error("生成任务不存在或不属于当前对话");
    if (job.batchId) await ownedGenerationBatch(job.batchId, context.threadId, undefined, db);
    if (context.runId && context.callId) await assertProjectToolScope(context as AgentToolContext, "generation_job", {projectId: job.projectId}, true, db);
    return job;
}

async function dataUri(media: MediaRecord) {
    const bytes = new Uint8Array(await (await readBinaryBlob(media.blob)).arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return `data:${media.mimeType};base64,${btoa(binary)}`;
}

async function nativeRequest(job: AgentGenerationJob, config: ConnectorConfig, context: Pick<AgentToolContext, 'threadId' | 'signal'> & Partial<AgentToolContext>, options: GenerationRuntimeOptions, store?: ProductStore): Promise<AIHubMixGenerationRequest> {
    const db = store ?? context.store ?? productDb;
    const records = await loadGenerationInputs(job, db);
    const input: AIHubMixGenerationRequest = {model: job.model, prompt: String(job.parameters.prompt)};
    for (const [key, value] of Object.entries(job.parameters)) if (!["mode", "quality"].includes(key)) input[key] = value;
    if (job.provider === "aihubmix" && job.parameters.quality) input.extra = {quality: job.parameters.quality};
    if (job.provider === "apimart" && isApimartImage25(job.model) && typeof job.parameters.quality === "string") input.quality = job.parameters.quality;
    const urls: string[] = [];
    for (const media of records) {
        context.signal.throwIfAborted();
        if (job.provider === "apimart") {
            const uploaded = await uploadApimartImage(config, new Blob([await readBinaryBlob(media.blob)], {type: media.mimeType}), {
                signal: context.signal,
                fetchImpl: options.fetchImpl,
                filename: media.filename
            });
            if (!uploaded.ok) throw new Error(uploaded.message);
            urls.push(uploaded.image.url);
        } else urls.push(await dataUri(media));
    }
    if (urls.length) {
        if (job.provider === "apimart") {
            if (job.kind === "image") input.image_urls = urls;
            else input.image_with_roles = job.inputs.map((item, index) => ({
                url: urls[index],
                role: item.role.replaceAll("-", "_")
            }));
        } else if (job.kind === "image") input.images = urls;
        else if (job.parameters.mode === "frames") input.frame_images = job.inputs.map((item, index) => ({
            frame_type: item.role.replaceAll("-", "_"),
            image_url: {url: urls[index]}
        }));
        else input.input_references = job.inputs.map((item, index) => ({
                type: item.role === "reference-video" ? "video_url" : "image_url",
                url: urls[index]
            }));
    }
    return input;
}

export async function submitAgentGeneration(raw: GenerationSubmitArgs, context: AgentToolContext, options: GenerationRuntimeOptions = {}, store?: ProductStore): Promise<AgentGenerationJob> {
    const db = store ?? context.store ?? productDb;
    context.signal.throwIfAborted();
    const saved = await db.agentGenerationJobs.where("callId").equals(context.callId).first();
    if (saved) {
        if (saved.runId !== context.runId || saved.threadId !== context.threadId) throw new Error("生成记录归属不匹配");
        return monitorAgentGeneration(saved.id, context, options, db);
    }
    let snapshot;
    try {
        await assertProjectToolScope(context, "submit_generation", {projectId: raw.target.projectId}, true, db);
        snapshot = await prepareGenerationSnapshot(raw, context.signal, db);
        if (context.preview?.revision && context.preview.revision !== snapshot.fingerprint) throw new Error("生成目标、输入或配置已变化，请重新确认，尚未付费提交");
    } catch (error) {
        if (error instanceof StorageError && error.certainty === "unknown") throw error;
        throw new AtomicToolRollbackError(cleanError(error));
    }
    const at = nowIso();
    const claim = await claimGenerationJob({
        version: 1,
        id: createId("genjob"),
        runId: context.runId,
        threadId: context.threadId,
        callId: context.callId,
        projectId: snapshot.request.target.projectId,
        connectorId: snapshot.config.id,
        provider: snapshot.provider,
        baseUrl: snapshot.config.baseUrl,
        model: snapshot.args.model,
        kind: snapshot.request.kind,
        target: snapshot.request.target,
        baseRevision: snapshot.current.revision,
        sourceRevisions: [{
            kind: snapshot.request.target.kind,
            id: snapshot.request.target.entityId,
            revision: snapshot.current.revision
        }],
        parameters: snapshot.request.parameters,
        inputs: snapshot.inputs,
        fingerprint: snapshot.fingerprint,
        status: "submitting",
        createdAt: at,
        updatedAt: at
    }, db).catch((error: unknown) => {
        if (error instanceof StorageError && error.certainty === "unknown") throw error;
        throw new AtomicToolRollbackError(cleanError(error, snapshot.config));
    });
    if (!claim.claimed) return monitorAgentGeneration(claim.job.id, context, options, db);
    const job = claim.job;
    return submitClaimedGeneration(job, snapshot.config, context, options, async (db) => {
        // Reference uploads may take time; never submit paid work against a changed target.
        const latest = await readGenerationTarget(job.target, db);
        if (latest.revision !== job.baseRevision) throw new Error("生成目标已修改，尚未付费提交");
        context.signal.throwIfAborted();
        const active = await db.agentRuns.get(context.runId);
        const activeCall = await db.agentToolCalls.get(context.callId);
        if (!await db.agentGenerationJobs.get(job.id) || !active || active.status !== "running" || !activeCall || activeCall.status !== "running") throw new Error("生成记录或执行已停止，尚未付费提交");
        await assertProjectToolScope(context, "submit_generation", {projectId: job.projectId}, true, db);
    }, db);
}

/** Shared paid transport. Caller must own the job and provide a final durable dispatch guard. */
export async function submitClaimedGeneration(job: AgentGenerationJob, config: ConnectorConfig,
                                              context: Pick<AgentToolContext, 'threadId' | 'signal' | 'store'>, options: GenerationRuntimeOptions, beforePost: (store: StoreTx) => Promise<void>, store?: ProductStore) {
    const db = store ?? context.store ?? productDb;
    let postStarted = false;
    try {
        const request = await nativeRequest(job, config, context, options, db);
        // Hash inputs outside Dexie after uploads/encoding, then validate current records
        // and caller ownership together immediately before either provider's paid POST.
        const inputs = await loadGenerationInputs(job, db);
        await db.transaction("r", db.tables, async (db) => {
            await beforePost(db);
            const latest = await resolveConnector(config.id, db);
            if (!latest?.apiKey.trim() || latest.definitionId !== job.provider ||
                latest.baseUrl !== job.baseUrl || latest.apiKey !== config.apiKey) {
                throw new Error("供应商配置已变化，尚未付费提交");
            }
            for (const input of inputs) {
                const current = await db.media.get(input.id);
                if (!current || current.projectId !== input.projectId || current.mimeType !== input.mimeType || binaryByteLength(current.blob) !== binaryByteLength(input.blob)) {
                    throw new Error("生成输入素材已变化，尚未付费提交");
                }
            }
        });
        context.signal.throwIfAborted();
        postStarted = true;
        if (job.provider === "apimart") {
            const result = await (job.kind === "image" ? submitApimartImageGeneration : submitApimartVideoGeneration)(config, request, {
                signal: context.signal,
                fetchImpl: options.fetchImpl,
                idempotencyKey: job.id
            });
            if (!result.ok) {
                await updateGenerationJob(job.id, {
                    status: result.kind === "validation" || result.kind === "http" && [400, 401, 402, 403, 404, 422, 429].includes(result.httpStatus ?? 0) ? "failed" : "unknown",
                    error: cleanError(new Error(result.message), config)
                }, db);
                return monitorAgentGeneration(job.id, context, options, db);
            }
            // n=1 profiles create exactly one task. Preserve first received identity before further work.
            await updateGenerationJob(job.id, {
                providerTaskId: safeTaskId(result.tasks[0].id, config),
                status: "submitted"
            }, db);
            if (result.tasks.length !== 1) {
                await updateGenerationJob(job.id, {
                    status: "unknown",
                    providerTaskIds: result.tasks.map((task) => safeTaskId(task.id, config)),
                    error: "供应商返回多个任务，已保留任务标识，请核实账户记录，不能自动选择结果或重复提交"
                }, db);
                throw new GenerationPendingError(job.id, "供应商返回多个任务，需要人工核实，不能自动选择或重新提交");
            }
        } else {
            const result = await (job.kind === "image" ? submitAIHubMixImageGeneration : submitAIHubMixVideoGeneration)(config, request, {
                signal: context.signal,
                fetchImpl: options.fetchImpl
            });
            if (!result.ok) {
                await updateGenerationJob(job.id, {
                    ...(result.taskId ? {providerTaskId: safeTaskId(result.taskId, config)} : {}),
                    status: result.taskId ? "submitted" : result.kind === "validation" || result.kind === "http" && [400, 401, 402, 403, 404, 422, 429].includes(result.httpStatus ?? 0) ? "failed" : "unknown",
                    error: cleanError(new Error(result.message), config)
                }, db);
                if (!result.taskId) return monitorAgentGeneration(job.id, context, options, db);
            } else {
                await updateGenerationJob(job.id, {
                    providerTaskId: safeTaskId(result.task.id, config),
                    status: "submitted"
                }, db);
                // Synchronous completion may carry the only copy of base64 output.
                if (result.task.status === "completed") return await acceptHubTask(job.id, result.task, config, context, options, db);
            }
        }
    } catch (error) {
        if (error instanceof StorageError && error.certainty === "unknown") throw error;
        const current = await db.agentGenerationJobs.get(job.id);
        if (!current) throw error;
        await updateGenerationJob(current.id, {
            status: current.providerTaskId ? current.status : postStarted ? "unknown" : "failed",
            error: cleanError(error, config)
        }, db);
        if (!postStarted) throw new AtomicToolRollbackError(cleanError(error, config));
        if (context.signal.aborted) throw new GenerationPendingError(current.id, "已停止本地等待；远端提交结果需核实，不能当作远端取消");
        throw new GenerationPendingError(current.id, cleanError(error, config));
    }
    return monitorAgentGeneration(job.id, context, options, db);
}

async function validateBlob(blob: Blob, kind: "image" | "video") {
    if (!blob.size) throw new Error("供应商结果文件为空");
    const bytes = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
    const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
    let mime = "";
    if (bytes[0] === 137 && ascii(1, 4) === "PNG") mime = "image/png";
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = "image/jpeg";
    else if (ascii(0, 3) === "GIF") mime = "image/gif";
    else if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") mime = "image/webp";
    else if (ascii(4, 8) === "ftyp") mime = "video/mp4";
    else if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) mime = "video/webm";
    if (!mime.startsWith(`${kind}/`)) throw new Error("下载内容不是可识别的目标图片/视频，未写入素材");
    return new Blob([blob], {type: mime});
}

async function saveBlob(job: AgentGenerationJob, blob: Blob, store?: ProductStore) {
    const db = store ?? productDb;
    const verified = await validateBlob(blob, job.kind);
    const ext = verified.type.split("/")[1];
    return storeGenerationMedia(job.id, {
        id: createId("media"),
        projectId: job.projectId,
        mimeType: verified.type,
        filename: `${job.model}-${job.id}.${ext}`,
        blob: verified
    }, db);
}

async function acceptHubTask(jobId: string, task: AIHubMixTask, config: ConnectorConfig, context: Pick<AgentToolContext, 'threadId' | 'signal'> & Partial<AgentToolContext>, options: GenerationRuntimeOptions, store?: ProductStore) {
    const db = store ?? context.store ?? productDb;
    let job = await jobForContext(jobId, context, db);
    if (task.model !== job.model) throw new Error("供应商实际模型与已确认模型不同，保留任务但不应用结果");
    if (task.status === "failed" || task.status === "cancelled") return updateGenerationJob(jobId, {
        status: "failed",
        providerStatus: cleanError(new Error(task.providerStatus), config),
        error: cleanError(new Error(task.error?.message ?? "远端任务失败或已取消"), config)
    }, db);
    if (task.status !== "completed") return updateGenerationJob(jobId, {
        status: task.status === "running" ? "running" : "submitted",
        providerStatus: cleanError(new Error(task.providerStatus), config),
        error: undefined
    }, db);
    if (task.outputs.length !== 1) throw new Error("预期单个生成结果，供应商返回数量不匹配，请核实任务");
    job = await updateGenerationJob(jobId, {
        status: "downloading",
        providerStatus: cleanError(new Error(task.providerStatus), config),
        error: undefined
    }, db);
    const output = task.outputs[0];
    let blob: Blob;
    if (output.b64Json) {
        let decoded: string;
        try {
            decoded = atob(output.b64Json);
        } catch {
            throw new Error("生成结果 Base64 格式无效");
        }
        blob = new Blob([Uint8Array.from(decoded, (character) => character.charCodeAt(0))]);
    } else {
        const result = await downloadAIHubMixResult(config, task, output, {
            signal: context.signal,
            fetchImpl: options.fetchImpl
        });
        if (!result.ok) throw new Error(result.message);
        blob = result.blob;
    }
    context.signal.throwIfAborted();
    return saveBlob(job, blob, db);
}

export async function checkAgentGeneration(jobId: string, context: Pick<AgentToolContext, 'threadId' | 'signal'> & Partial<AgentToolContext>, options: GenerationRuntimeOptions = {}, store?: ProductStore): Promise<AgentGenerationJob> {
    const db = store ?? context.store ?? productDb;
    context.signal.throwIfAborted();
    let job;
    try {
        job = await jobForContext(jobId, context, db);
    } catch (error) {
        if (error instanceof StorageError && error.certainty === "unknown") throw error;
        throw new AtomicToolRollbackError(cleanError(error));
    }
    if (["downloaded", "applied", "conflict", "failed"].includes(job.status)) return job;
    if (job.status === "unknown") return job;
    if (!job.providerTaskId) {
        if (job.status === "submitting") job = await markUnacknowledgedGeneration(jobId, db);
        return job;
    }
    let config: ConnectorConfig | undefined;
    try {
        config = await resolveGenerationConnector(job.connectorId, job, db);
        if (job.provider === "aihubmix") {
            const response = await (job.kind === "image" ? getAIHubMixImageTask : getAIHubMixVideoTask)(config, job.providerTaskId, {
                signal: context.signal,
                fetchImpl: options.fetchImpl
            });
            if (!response.ok) throw new Error(response.message);
            return await acceptHubTask(jobId, response.task, config, context, options, db);
        }
        const response = await getApimartTask(config, job.providerTaskId, {
            signal: context.signal,
            fetchImpl: options.fetchImpl
        });
        if (!response.ok) throw new Error(response.message);
        const task = response.task;
        if (task.status === "failed" || task.status === "cancelled") return updateGenerationJob(jobId, {
            status: "failed",
            providerStatus: cleanError(new Error(task.providerStatus), config),
            error: cleanError(new Error(task.error?.message ?? "远端任务失败或已取消"), config)
        }, db);
        if (task.status !== "completed") return updateGenerationJob(jobId, {
            status: task.status === "processing" ? "running" : "submitted",
            providerStatus: cleanError(new Error(task.providerStatus), config),
            progress: task.progress,
            error: undefined
        }, db);
        const urls = (job.kind === "image" ? task.images : task.videos).flatMap((item) => item.urls);
        if (urls.length !== 1) throw new Error("预期单个生成结果，供应商返回数量或类型不匹配");
        const url = new URL(urls[0]);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("供应商结果下载地址无效");
        job = await updateGenerationJob(jobId, {
            status: "downloading",
            providerStatus: cleanError(new Error(task.providerStatus), config),
            progress: task.progress,
            error: undefined
        }, db);
        // Public signed CDN result: never attach connector credentials or cookies.
        const download = await (options.fetchImpl ?? runtimeResultFetch)(url.href, {
            signal: context.signal,
            credentials: "omit",
            redirect: "error"
        });
        if (!download.ok) throw new Error(`结果下载失败（${download.status}），请检查过期时间、网络和跨域限制`);
        const blob = await readResponseBlob(download, MAX_MEDIA_DOWNLOAD_BYTES, context.signal);
        context.signal.throwIfAborted();
        return await saveBlob(job, blob, db);
    } catch (error) {
        if (error instanceof StorageError && error.certainty === "unknown") throw error;
        await updateGenerationJob(jobId, {error: cleanError(error, config)}, db);
        if (context.signal.aborted) throw new GenerationPendingError(jobId, "已停止本地查询或下载；远端任务仍可能继续，稍后可恢复查询");
        throw new GenerationPendingError(jobId, cleanError(error, config));
    }
}

function wait(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        const abort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            reject(new DOMException("本地监控已停止", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, ms);
        signal.addEventListener("abort", abort, {once: true});
    });
}

export async function monitorAgentGeneration(jobId: string, context: Pick<AgentToolContext, 'threadId' | 'signal'> & Partial<AgentToolContext>, options: GenerationRuntimeOptions = {}, store?: ProductStore) {
    const db = store ?? context.store ?? productDb;
    for (let step = 0; step < (options.maxPolls ?? 40); step++) {
        const job = await checkAgentGeneration(jobId, context, options, db);
        if (job.status === "unknown") throw new GenerationPendingError(jobId, job.error ?? "提交结果未知，请核实供应商账户，不会自动重试");
        if (["downloaded", "applied", "conflict", "failed"].includes(job.status)) return job;
        try {
            await wait(options.pollIntervalMs ?? Math.min(15000, 3000 + step * 2000), context.signal);
        } catch {
            throw new GenerationPendingError(jobId, "本地监控已停止；远端任务没有取消，继续执行时只查询已有任务");
        }
    }
    throw new GenerationPendingError(jobId, "本轮等待已暂停；任务仍在远端处理，继续执行可恢复查询，无需重新提交");
}

export async function prepareGenerationApply(jobId: string, context: AgentToolContext, store?: ProductStore): Promise<AgentToolPreview> {
    const db = store ?? context.store ?? productDb;
    const job = await jobForContext(jobId, context, db);
    if (job.batchId) throw new Error("批量候选需要由用户在批量结果中选择并写入");
    if (!job.result) throw new Error("生成结果尚未下载到本地，不能写入目标");
    await flushPendingDrafts(job.projectId);
    let label = "已删除或失效的目标";
    try {
        label = (await readGenerationTarget(job.target, db)).label;
    } catch { /* Apply records a visible conflict while preserving output. */
    }
    if (job.target.kind === "library") return {
        summary: `将生成${job.kind === "image" ? "图片" : "视频"}保存到项目素材库`,
        changes: [`素材名称：${libraryMaterialName(job)}`, `结果素材：${job.result.mediaId}`, "不会改变任何槽位、镜头或封面。"],
        revision: job.baseRevision,
        target: {label, href: generationTargetHref(job.target)}
    };
    return {
        summary: `将生成${job.kind === "image" ? "图片" : "视频"}写入「${label}」`,
        changes: [`目标槽位：${job.target.slot}`, `结果素材：${job.result.mediaId}`, "不会改变镜头文字、时长或人工状态。"],
        revision: job.baseRevision,
        target: {label, href: generationTargetHref(job.target)}
    };
}

export async function applyAgentGeneration(jobId: string, context: AgentToolContext, store?: ProductStore) {
    const db = store ?? context.store ?? productDb;
    let original;
    try {
        original = await jobForContext(jobId, context, db);
        await flushPendingDrafts(original.projectId);
    } catch (error) {
        if (error instanceof StorageError && error.certainty === "unknown") throw error;
        throw new AtomicToolRollbackError(cleanError(error));
    }
    if (original.batchId) throw new AtomicToolRollbackError("批量候选需要由用户在批量结果中选择并写入");
    if (!original.result || !["downloaded", "conflict", "applied"].includes(original.status)) throw new AtomicToolRollbackError("没有可写入的本地生成结果");
    if (original.status === "applied") return executeAtomicTool(context, async (db) => {
        const boundContext = {...context, store: db};
        return generationJobSummary(await jobForContext(jobId, boundContext, db));
    }, db);
    // Hash Blob inputs outside Dexie; atomic callback rechecks immutable record metadata.
    let records: MediaRecord[];
    try {
        records = await loadGenerationInputs(original, db);
    } catch (error) {
        if (error instanceof StorageError && error.certainty === "unknown") throw error;
        return executeAtomicTool(context, async (db) => generationJobSummary(await updateGenerationJob(original.id, {
            status: "conflict",
            error: cleanError(error)
        }, db)), db);
    }
    return executeAtomicTool(context, async (db) => {
        const boundContext = {...context, store: db};
        const job = await jobForContext(jobId, boundContext, db);
        if (job.status === "applied") return generationJobSummary(job);
        if (!job.result || !["downloaded", "conflict"].includes(job.status)) throw new Error("没有可写入的本地生成结果");
        let current;
        try {
            current = await readGenerationTarget(job.target, db);
        } catch {
            return generationJobSummary(await updateGenerationJob(job.id, {
                status: "conflict",
                error: "目标已删除或归属变化；生成结果已保留，未写入目标"
            }, db));
        }
        if (current.revision !== job.baseRevision || boundContext.preview?.revision && boundContext.preview.revision !== job.baseRevision) {
            return generationJobSummary(await updateGenerationJob(job.id, {
                status: "conflict",
                error: "目标已被修改；生成结果已保留，请手动确认后使用已有素材"
            }, db));
        }
        for (const record of records) {
            const saved = await db.media.get(record.id);
            if (!saved || saved.projectId !== record.projectId || saved.mimeType !== record.mimeType || binaryByteLength(saved.blob) !== binaryByteLength(record.blob)) throw new Error("输入素材已变化，结果未应用");
        }
        const result = await db.media.get(job.result.mediaId);
        if (!result || result.projectId !== job.projectId || !binaryByteLength(result.blob) || !result.mimeType.startsWith(`${job.kind}/`)) throw new Error("生成结果素材已删除或类型不匹配");
        const slot = {...current.slot, result: job.result};
        switch (job.target.kind) {
            case "library":
                await adoptGeneratedMedia(job.projectId, job.result.mediaId, libraryMaterialName(job), db);
                break;
            case "shot":
                await setShotSlot(job.target.entityId, job.target.slot!, slot, undefined, db);
                break;
            case "character":
                await setCharacterSlot(job.target.entityId, job.target.slot, slot, undefined, db);
                break;
            case "scene":
                await setSceneSlot(job.target.entityId, job.target.slot, slot, undefined, db);
                break;
            case "prop":
                await setPropSlot(job.target.entityId, job.target.slot, slot, undefined, db);
                break;
            case "style":
                await setStyleSlot(job.target.entityId, job.target.slot, slot, undefined, db);
                break;
        }
        return generationJobSummary(await updateGenerationJob(job.id, {status: "applied", error: undefined}, db));
    }, db);
}
