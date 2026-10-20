import {readBinaryBlob} from "../../../platform/storage/binary";
import {binaryMimeType} from "../../../platform/media/binaryTypes";
import type {ProductStore} from "../../../platform/storage/types";
import {describeAudioGeneration} from "./presentation";
import {db as productDb} from "../../../platform/product/store";
import {resolveConnector} from "../../settings/commands/connectors";
import {addAudioTake} from "../commands/audio";
import {addMusicWork} from "../../music/commands/music";
import {claimAudioGenerationJob, patchAudioGenerationJob, prepareAudioGenerationJob} from "../commands/generation";
import {assertAudioProject, ownedAudioRow} from "../commands/ownership";
import {assertAudioRevision} from "../models/row";
import {AUDIO_TRANSACTION_TABLES} from "../../../platform/product/scopes";
import type {
    AudioGenerationInput,
    AudioGenerationJob,
    AudioGenerationResult,
    AudioGenerationStatus,
    AudioTaskObservation
} from "../models/audioGeneration";
import type {AudioSourceMetadata} from "../models/audio";
import {
    downloadApimartAudio,
    generateApimartSpeech,
    getApimartMusicTask,
    submitApimartMusic
} from "../providers/apimartAudio";
import {generateMimoSpeech, MIMO_MODELS} from "../providers/mimoSpeech";
import {validateSpeechReference} from "./reference";
import type {ApimartRequestOptions} from "../../video/providers/apimart";
import {normalizeBaseUrl} from "../../agent/providers/openaiCompatible";
import {audioBufferMetadata, decodeAudioBlob} from "../engine/engine";
import {createId, nowIso} from "../../../platform/identity";
import {audioMimeExtension, detectAudioMime} from "../engine/mime";
import {musicWireInput, speechWireInput, validateGenerationInput} from "./input";
import {observeAudioTask, validateAudioTaskObservations} from "./observations";
import {canonicalizeAudioTaskIds} from "./taskIds";
import {inspectAudioGenerationOutputs} from "./outputEvidence";
import {assertAudioBatchDispatch} from "../commands/batches";

export interface AudioGenerationOptions extends ApimartRequestOptions {
    /** Test seam; production always validates through a real audio decoder. */
    decode?: (blob: Blob) => Promise<AudioSourceMetadata>;
    beforeSubmit?: () => Promise<void>;
}

const localLocks = new Map<string, Promise<unknown>>();

async function locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request(`momoki.audio-job.${id}`, operation);
    const previous = localLocks.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => {
    }).then(operation);
    localLocks.set(id, pending);
    try {
        return await pending;
    } finally {
        if (localLocks.get(id) === pending) localLocks.delete(id);
    }
}

const readJob = (projectId: string, id: string, store?: ProductStore) => (db => ownedAudioRow(db.audioGenerationJobs, projectId, id))(store ?? productDb);
const change = (job: AudioGenerationJob, patch: Parameters<typeof patchAudioGenerationJob>[3], store?: ProductStore) => (db => patchAudioGenerationJob(job.projectId, job.id, job.revision, patch, db))(store ?? productDb);

async function connection(job: Pick<AudioGenerationJob, "connector">, store?: ProductStore) {
    const db = store ?? productDb;
    const value = await resolveConnector(job.connector.id, db);
    if (!value || value.definitionId !== job.connector.provider || !value.apiKey.trim() || normalizeBaseUrl(value.baseUrl) !== normalizeBaseUrl(job.connector.baseUrl)) throw new Error("生成连接已删除或地址发生变化，请恢复原连接后继续查询");
    return value;
}

async function validateTarget(projectId: string, input: AudioGenerationInput, store?: ProductStore) {
    const db = store ?? productDb;
    await assertAudioProject(projectId, input.kind === "speech" ? "audio" : "music", db);
    if (input.kind === "speech" && input.segmentId) {
        const segment = await ownedAudioRow(db.audioSegments, projectId, input.segmentId);
        if (input.segmentRevision !== undefined) assertAudioRevision(segment, input.segmentRevision);
    }
    if (input.kind === "music" && input.draftId) {
        const draft = await ownedAudioRow(db.musicDrafts, projectId, input.draftId);
        if (input.draftRevision !== undefined) assertAudioRevision(draft, input.draftRevision);
    }
}

export async function prepareAudioGeneration(args: {
    projectId: string;
    connectorId: string;
    input: AudioGenerationInput;
    intentId?: string;
    source?: AudioGenerationJob["source"];
}, store?: ProductStore): Promise<AudioGenerationJob> {
    const db = store ?? productDb;
    const input = validateGenerationInput(args.input);
    await validateTarget(args.projectId, input, db);
    const reference = input.kind === "speech" ? await validateSpeechReference(args.projectId, input, db) : undefined;
    const provider = input.kind === "speech" && input.mimo ? "mimo" : "apimart";
    const connector = await resolveConnector(args.connectorId, db);
    if (!connector || connector.definitionId !== provider || !connector.apiKey.trim()) throw new Error(`请先选择已配置密钥的 ${provider === "mimo" ? "MiMo" : "APIMart"} 连接`);
    return prepareAudioGenerationJob(args.projectId, {
        intentId: args.intentId ?? createId("audio-intent"),
        input,
        connector: {id: connector.id, provider, baseUrl: normalizeBaseUrl(connector.baseUrl)},
        source: args.source ?? {kind: "manual"}, ...(reference ? {referenceFingerprint: reference.fingerprint} : {})
    }, db);
}

async function persistResult(job: AudioGenerationJob, result: AudioGenerationResult, blob: Blob, options: AudioGenerationOptions, store?: ProductStore) {
    const db = store ?? productDb;
    const metadata = await (options.decode ?? (async audio => audioBufferMetadata(await decodeAudioBlob(audio))))(blob);
    const mime = await detectAudioMime(blob);
    options.signal?.throwIfAborted();
    return db.transaction("rw", AUDIO_TRANSACTION_TABLES, async (db) => {
        const latest = await readJob(job.projectId, job.id, db);
        await assertAudioProject(job.projectId, undefined, db);
        if (latest.source.kind === "batch") {
            const batch = await db.audioGenerationBatches.get(latest.source.batchId);
            if (!batch || batch.projectId !== job.projectId || !await db.audioChapters.get(batch.chapterId)) throw new Error("批次章节已删除，不能保存迟到结果");
        }
        const prior = latest.results.find(row => row.key === result.key);
        if (prior?.deleted || prior?.takeId || prior?.workId) return latest;
        const mediaId = createId("med");
        const media = {
            id: mediaId,
            projectId: job.projectId,
            filename: `${result.title || "音频"}.${audioMimeExtension(mime)}`,
            mimeType: mime,
            blob: new Blob([blob], {type: mime})
        };
        let saved: AudioGenerationResult;
        if (latest.input.kind === "speech") {
            const segment = latest.input.segmentId ? await db.audioSegments.get(latest.input.segmentId) : undefined;
            const take = await addAudioTake(job.projectId, {
                ...metadata,
                mediaId,
                name: result.title,
                source: "tts",
                textSnapshot: result.finalTextPreview ?? latest.input.text,
                ...(segment?.projectId === job.projectId ? {segmentId: segment.id} : {}),
                provenance: result.provenance
            }, media, db);
            saved = {...result, mediaId, takeId: take.id, durationSec: metadata.durationSec, error: undefined};
        } else {
            const work = await addMusicWork(job.projectId, {
                ...metadata, mediaId, title: result.title, notes: "", favorite: false,
                lyrics: result.lyrics ?? "", settings: latest.input.settings, provenance: result.provenance
            }, media, db);
            saved = {...result, mediaId, workId: work.id, durationSec: metadata.durationSec, error: undefined};
        }
        // Only this job owns its temporary raw speech response; promotion is atomic.
        if (prior?.mediaId && !prior.takeId && !prior.workId && prior.mediaId !== mediaId) await db.media.delete(prior.mediaId);
        return change(latest, {results: latest.results.map(row => row.key === result.key ? saved : row)}, db);
    });
}

async function downloadResults(job: AudioGenerationJob, options: AudioGenerationOptions, finishStatus: AudioGenerationStatus = "saved", monitoringError?: string, store?: ProductStore): Promise<AudioGenerationJob> {
    const db = store ?? productDb;
    job = await change(job, {status: "downloading", error: undefined}, db);
    const errors: string[] = [];
    for (const result of job.results) {
        if (result.deleted || result.takeId || result.workId) continue;
        try {
            options.signal?.throwIfAborted();
            let blob = result.mediaId ? (await db.media.get(result.mediaId))?.blob : undefined;
            if (!blob && result.provenance.audioUrl) {
                const downloaded = await downloadApimartAudio(result.provenance.audioUrl, options);
                if (!downloaded.ok) throw new Error(downloaded.message);
                blob = downloaded.blob;
            }
            if (!blob) throw new Error("原始音频暂不可用，请保留任务并重试下载");
            job = await persistResult(job, result, await readBinaryBlob(blob), options, db);
        } catch (error) {
            const message = error instanceof Error ? error.message : "无法保存音频，请重试下载";
            errors.push(`${result.title}：${message}`);
            job = await readJob(job.projectId, job.id, db);
            job = await change(job, {
                results: job.results.map(row => row.key === result.key ? {
                    ...row,
                    error: message
                } : row)
            }, db);
            if (options.signal?.aborted) break;
        }
    }
    return change(job, {
        status: errors.length && finishStatus === "saved" ? "remote-completed" : finishStatus,
        error: [monitoringError, ...errors].filter(Boolean).join("；") || undefined
    }, db);
}

export async function submitAudioGeneration(projectId: string, jobId: string, options: AudioGenerationOptions = {}, store?: ProductStore): Promise<AudioGenerationJob> {
    const db = store ?? productDb;
    return locked(jobId, async () => {
        let job = await readJob(projectId, jobId, db);
        if (job.status !== "prepared" || job.dormant) return job;
        if (job.source.kind !== "manual" && !options.beforeSubmit) throw new Error("助手或批次生成需要通过已确认的请求提交");
        validateGenerationInput(job.input);
        await validateTarget(projectId, job.input, db);
        let reference = job.input.kind === "speech" ? await validateSpeechReference(projectId, job.input, db) : undefined;
        if (job.referenceFingerprint && reference?.fingerprint !== job.referenceFingerprint) throw new Error("克隆参考音频已变化，请重新准备生成");
        const credentials = await connection(job, db);
        options.signal?.throwIfAborted();
        if (job.source.kind === "batch") await assertAudioBatchDispatch(projectId, job.id, db);
        await options.beforeSubmit?.();
        job = await claimAudioGenerationJob(projectId, job.id, job.revision, createId("submit"), db);
        try {
            await validateTarget(projectId, job.input, db);
            const current = await connection(job, db);
            if (current.apiKey !== credentials.apiKey) throw new Error("连接密钥已变化，请重新准备生成");
            await options.beforeSubmit?.();
            if (job.source.kind === "batch") await assertAudioBatchDispatch(projectId, job.id, db);
            reference = job.input.kind === "speech" ? await validateSpeechReference(projectId, job.input, db) : undefined;
            if (job.referenceFingerprint && reference?.fingerprint !== job.referenceFingerprint) throw new Error("克隆参考音频已变化，请重新准备生成");
            options.signal?.throwIfAborted();
        } catch (error) {
            return change(job, {
                status: "failed",
                failureStage: "preflight",
                error: error instanceof Error ? error.message : "提交前检查失败"
            }, db);
        }
        if (job.input.kind === "speech") {
            const response = job.input.mimo
                ? await generateMimoSpeech(credentials, {
                    text: job.input.text,
                    voice: job.input.voice,
                    mimo: job.input.mimo,
                    referenceBlob: reference?.blob
                }, options)
                : await generateApimartSpeech(credentials, speechWireInput(job.input), options);
            if (!response.ok) return change(job, {
                status: ["network", "aborted", "protocol"].includes(response.kind) ? "uncertain" : "failed",
                failureStage: response.kind === "http" && response.httpStatus !== undefined && [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.httpStatus) ? "provider" : undefined,
                error: response.message
            }, db);
            const result: AudioGenerationResult = {
                key: `${job.id}:speech`,
                title: job.input.text.slice(0, 24) || "配音",
                provenance: {
                    provider: job.connector.provider,
                    model: job.input.mimo ? MIMO_MODELS[job.input.mimo.mode] : "gpt-4o-mini-tts",
                    jobId: job.id
                },
                ...("finalTextPreview" in response && typeof response.finalTextPreview === "string" ? {finalTextPreview: response.finalTextPreview} : {})
            };
            // Persist returned bytes before decoding, so interrupted local processing can recover without another paid request.
            job = await db.transaction("rw", AUDIO_TRANSACTION_TABLES, async (db) => {
                await assertAudioProject(projectId, undefined, db);
                if (job.source.kind === "batch") {
                    const batch = await db.audioGenerationBatches.get(job.source.batchId);
                    if (!batch || batch.projectId !== projectId || !await db.audioChapters.get(batch.chapterId)) throw new Error("批次章节已删除，迟到响应不会创建新的成果");
                }
                const rawId = createId("med");
                await db.media.add({
                    id: rawId,
                    projectId,
                    filename: "speech.wav",
                    mimeType: binaryMimeType(response.blob),
                    blob: response.blob
                });
                return change(job, {status: "remote-completed", results: [{...result, mediaId: rawId}]}, db);
            });
            return downloadResults(job, options, undefined, undefined, db);
        }
        const response = await submitApimartMusic(credentials, musicWireInput(job.input.settings), options);
        if (!response.ok) return change(job, {
            status: ["network", "aborted", "protocol"].includes(response.kind) ? "uncertain" : "failed",
            failureStage: response.kind === "http" && response.httpStatus !== undefined && [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.httpStatus) ? "provider" : undefined,
            error: response.message
        }, db);
        return change(job, {status: "submitted", taskIds: response.taskIds, error: undefined}, db);
    });
}

/** One bounded monitoring pass. Mounting a workspace may call this, never submit. */
export async function refreshAudioGeneration(projectId: string, jobId: string, options: AudioGenerationOptions = {}, store?: ProductStore): Promise<AudioGenerationJob> {
    const db = store ?? productDb;
    return locked(jobId, async () => {
        let job = await readJob(projectId, jobId, db);
        if (job.dormant || job.status === "saved" || job.status === "prepared") return job;
        await assertAudioProject(projectId, undefined, db);
        // Repair submitted legacy duplicates before strict checkpoint validation or any request.
        const taskIds = canonicalizeAudioTaskIds(job.taskIds);
        if (taskIds.length !== job.taskIds.length) job = await change(job, {taskIds}, db);
        validateAudioTaskObservations(job.taskObservations, job.taskIds);
        if (job.status === "submitting") return change(job, {
            status: "uncertain",
            error: "提交过程已中断，结果尚不确定；请核实后再创建新的生成"
        }, db);
        if ((job.status === "remote-completed" || job.status === "downloading" && job.input.kind === "speech") && job.results.length) return downloadResults(job, options, undefined, undefined, db);
        if (!job.taskIds.length) return job;
        const results: AudioGenerationResult[] = [...job.results];
        const errors: string[] = [];
        const observed: AudioTaskObservation[] = [];
        const observe = (taskId: string, status: AudioTaskObservation["status"]) => {
            const row = observeAudioTask(taskId, status, nowIso(), job.taskObservations?.find(item => item.taskId === taskId));
            observed.push(row);
            return row;
        };
        const persistObservations = async (store?: ProductStore) => {
            const db = store ?? productDb;
            // During a partial pass, only this pass's verified processing can set running.
            const taskObservations = job.taskIds.flatMap(taskId => {
                const row = observed.find(item => item.taskId === taskId) ?? job.taskObservations?.find(item => item.taskId === taskId);
                return row ? [row] : [];
            });
            job = await change(job, {
                taskObservations,
                results: [...results],
                status: observed.some(row => row.status === "processing") ? "running" : "submitted",
                error: errors.join("；") || undefined
            }, db);
        };
        let credentials: Awaited<ReturnType<typeof connection>>;
        try {
            credentials = await connection(job, db);
        } catch (error) {
            for (const taskId of job.taskIds) observe(taskId, "query-failed");
            errors.push(error instanceof Error ? error.message : "查询连接不可用，请恢复连接后重试查询");
            await persistObservations(db);
            return job;
        }
        for (const taskId of job.taskIds) {
            if (options.signal?.aborted) {
                // Preserve completed sibling responses; interrupted checks provide no new provider fact.
                for (const remaining of job.taskIds.filter(id => !observed.some(row => row.taskId === id))) observe(remaining, "query-failed");
                errors.push("查询已停止，未检查的任务状态尚未核实");
                await persistObservations(db);
                return job;
            }
            const response = await getApimartMusicTask(credentials, taskId, options);
            observe(taskId, response.ok ? response.task.status : "query-failed");
            if (!response.ok) errors.push(response.message);
            else if (response.task.status === "failed") errors.push(response.task.error ?? "音乐生成失败");
            else if (response.task.status === "unknown") errors.push("服务商返回未知状态，请稍后重新查询确认");
            else if (response.task.status === "completed") {
                if (response.task.error) errors.push(response.task.error);
                for (const track of response.task.tracks) {
                    const key = `${taskId}:${track.audioIndex}`;
                    if (results.some(row => row.key === key)) continue;
                    results.push({
                        key, title: track.title, lyrics: track.lyrics, durationSec: track.duration,
                        provenance: {
                            provider: "apimart",
                            model: job.input.kind === "music" ? job.input.settings.engine : "gpt-4o-mini-tts",
                            jobId,
                            taskId,
                            audioIndex: track.audioIndex,
                            clipId: track.clipId,
                            audioUrl: track.audioUrl,
                            coverUrl: track.imageUrl
                        }
                    });
                }
            }
            // Save every response before the next request; reload/Stop never discards earlier siblings.
            await persistObservations(db);
        }
        const allTerminal = observed.every(row => row.status === "completed" || row.status === "failed");
        const unresolvedStatus = observed.some(row => row.status === "processing") ? "running" : "submitted";
        const status = allTerminal ? errors.length ? "failed" : "remote-completed" : unresolvedStatus;
        job = await change(job, {status, error: errors.join("；") || undefined}, db);
        if (!results.length || options.signal?.aborted) return job;
        return downloadResults(job, options, allTerminal ? errors.length ? "failed" : "saved" : unresolvedStatus, job.error, db);
    });
}

export function audioJobSummary(job: AudioGenerationJob) {
    const observation = describeAudioGeneration(job);
    return {
        id: job.id, projectId: job.projectId, revision: job.revision, status: job.status,
        statusLabel: observation.label, taskCounts: observation.counts, checkedAt: observation.checkedAt,
        taskObservations: job.taskObservations ?? [], source: job.source,
        ...(job.input.kind === "music" ? {draftId: job.input.draftId, draftRevision: job.input.draftRevision} : {}),
        error: job.error, taskIds: job.taskIds,
        results: job.results.map(({title, takeId, workId, mediaId, deleted, error}) => ({
            title,
            takeId,
            workId,
            mediaId,
            deleted,
            error
        })),
        note: "这是该任务的状态快照；source 表示原始提交来源，查询不代表本轮新提交。服务商状态以 taskObservations 的查询时间为准；历史 lastVerified 不代表当前状态。远端完成、本地保存与实际试听是不同阶段，未试听。"
    };
}

/** Reload job and current local outputs together; historical IDs alone prove no delivery. */
export async function readAudioJobSummary(projectId: string, jobId: string, store?: ProductStore) {
    const db = store ?? productDb;
    return db.transaction("r", AUDIO_TRANSACTION_TABLES, async (db) => {
        const job = await readJob(projectId, jobId, db);
        const outputs = await inspectAudioGenerationOutputs(job, undefined, db);
        return {...audioJobSummary(job), outputs, inspectedAt: nowIso()};
    });
}
