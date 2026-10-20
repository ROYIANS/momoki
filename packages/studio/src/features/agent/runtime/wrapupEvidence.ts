import {binaryByteLength} from "../../../platform/media/binaryTypes";
import type {ProductStore} from "../../../platform/storage/types";
import {collectReferenceEvidence, historicalToolSummary, toolReferenceAttachments} from "../../references/agent/referenceEvidence";
import {provesCompletedEffect, taskGenerationEvidenceId} from "../commands/agentTaskRecords";
import {
    ownedTaskAudioGenerationJob,
    SOUND_GENERATION_TOOLS,
    taskAudioGenerationOutputSources,
    taskAudioGenerationSource,
    taskAudioToolSource
} from "../../audio/agent/taskEvidence";
import {db as productDb} from "../../../platform/product/store";
import type {AgentTask} from "../models/agent";
import type {WrapupEvidence, WrapupSnapshot} from "../models/agentTaskWrapup";
import {targetRevision} from "../../../platform/data/revision";
import {type BusinessKind, getRow, navigation, projection} from "./businessStore";
import {
    inspectTaskGenerationOutput,
    ownedTaskGenerationJob,
    PICTURE_GENERATION_TOOLS,
    taskGenerationToolSource
} from "../../video/agent/taskEvidence";

const kinds = ["project", "episode", "beat", "shot", "character", "scene", "prop", "style", "media"];

function json(value: unknown): Record<string, unknown> {
    try {
        const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

/** Caller opens a consistent read transaction; full fingerprints include omitted history. */
export async function collectWrapupSnapshot(task: AgentTask, includeAllEvidence = false, store?: ProductStore): Promise<WrapupSnapshot> {
    const db = store ?? productDb;
    const runs = (await db.agentRuns.where("threadId").equals(task.threadId).toArray()).filter(r => r.taskId === task.id);
    const runIds = new Set(runs.map(r => r.id));
    const messages = (await db.chatMessages.where("threadId").equals(task.threadId).sortBy("createdAt")).filter(m => m.role === "user" ? m.origin !== "system" : !!m.runId && runIds.has(m.runId));
    const calls = (await db.agentToolCalls.where("threadId").equals(task.threadId).toArray()).filter(c => runIds.has(c.runId));
    const records = await db.agentTaskRecords.where("taskId").equals(task.id).sortBy("updatedAt");
    const jobs = (await db.agentGenerationJobs.where("threadId").equals(task.threadId).toArray()).filter(j => runIds.has(j.runId));
    const batches = (await db.agentGenerationBatches.where("threadId").equals(task.threadId).toArray()).filter(batch => runIds.has(batch.runId));
    const batchItems = (await db.agentGenerationBatchItems.where("threadId").equals(task.threadId).toArray()).filter(item => batches.some(batch => batch.id === item.batchId));
    const audioBatches = (await db.audioGenerationBatches.where("owner.threadId").equals(task.threadId).toArray()).filter(batch => batch.owner.kind === "agent" && batch.owner.taskId === task.id && runIds.has(batch.owner.runId) && batch.projectId === task.projectId);
    const audioBatchItems = (await db.audioGenerationBatchItems.where("projectId").equals(task.projectId).toArray()).filter(item => audioBatches.some(batch => batch.id === item.batchId));
    const evidence: WrapupEvidence[] = [], fingerprints: unknown[] = [];
    const add = (item: WrapupEvidence, raw: unknown) => {
        fingerprints.push([item.id, targetRevision(raw)]);
        evidence.push({...item, body: item.body.slice(0, 1800), truncated: item.body.length > 1800});
    };
    const entityIds = new Set<string>();
    // Cache hits and invalid locators can settle without any IndexedDB request.
    // Callers adopt this native promise through the transaction-zone Promise; a long
    // loop of bare awaits otherwise exhausts Dexie's zone tracking in real browsers.
    async function entity(kind: BusinessKind, id: string, ownerId?: string, episodeId?: string, label?: string, store?: ProductStore) {
        const db = store ?? productDb;
        const key = `entity:${kind}:${id}`;
        if (entityIds.has(key)) return;
        entityIds.add(key);
        try {
            const row = await getRow(kind, id, ownerId, episodeId, db);
            const link = navigation(kind, row);
            add({
                id: key,
                kind: "entity",
                label: link.label,
                body: JSON.stringify(projection(kind, row)),
                outcome: "fact",
                available: true,
                supportsResult: true,
                href: link.href
            }, row);
        } catch {
            add({
                id: key,
                kind: "entity",
                label: label ?? `${kind} · ${id}`,
                body: "原目标已删除或不再属于原范围",
                outcome: "unresolved",
                available: false
            }, null);
        }
    }

    for (const call of calls) {
        const value = json(call.result), args = json(call.arguments);
        const unsettled = !['completed', 'failed', 'rejected'].includes(call.status);
        const generation = (PICTURE_GENERATION_TOOLS as readonly string[]).includes(call.name);
        const failed = call.status !== "completed" || !!value.error || value.ok === false || value.success === false || (!generation && value.applied === false);
        const outcome: WrapupEvidence['outcome'] = unsettled || failed ? "unresolved" : generation ? (value.status === "applied" ? "applied" : value.status === "downloaded" ? "downloaded" : "unresolved") : "fact";
        add({
            id: `tool:${call.id}`,
            kind: "tool",
            label: call.title,
            body: JSON.stringify({
                status: call.status,
                result: historicalToolSummary(call.name, call.result, task.projectId ?? "") ?? value,
                error: call.error
            }),
            outcome,
            available: true,
            supportsResult: call.status === "completed" && provesCompletedEffect(call)
        }, call);
        if (generation) {
            const current = await Promise.resolve(taskGenerationToolSource(task, call, db));
            const source = evidence.at(-1)!;
            source.supportsResult = current?.supportsResult === true;
            source.outcome = "unresolved";
            if (current?.supportsResult) source.outcome = current.applied ? "applied" : "downloaded";
            source.available = current?.available === true;
            const body = `${source.body}\n当前输出状态：${source.outcome}；原工具返回只记录当时事实。`;
            source.body = body.slice(0, 1800);
            source.truncated ||= body.length > 1800;
            fingerprints.push([source.id, {
                jobId: current?.jobId,
                available: source.available,
                applied: current?.applied
            }]);
        }
        if ((SOUND_GENERATION_TOOLS as readonly string[]).includes(call.name)) {
            const current = call.status === "completed" ? await Promise.resolve(taskAudioToolSource(task, call, db)) : undefined;
            const source = evidence.at(-1)!;
            source.supportsResult = current?.supportsResult === true;
            source.outcome = current?.supportsResult ? current.applied ? "applied" : "downloaded" : "unresolved";
            source.available = current?.available === true;
            source.body = current?.body.slice(0, 1800) ?? "当前声音成果不可核实；原工具返回只记录当时事实，不能证明文件仍可交付。";
            source.truncated = !!current && current.body.length > 1800;
            fingerprints.push([source.id, current?.body ?? null]);
        }
        const rows = Array.isArray(value.items) ? value.items : [value];
        for (const item of rows) {
            const row = json(item);
            const kind = typeof row.kind === 'string' && kinds.includes(row.kind) ? row.kind : typeof args.kind === 'string' && kinds.includes(args.kind) ? args.kind : call.name.split('_')[0];
            const id = typeof row.id === 'string' ? row.id : typeof args.id === 'string' ? args.id : undefined;
            if (id && kinds.includes(kind)) {
                await Promise.resolve(entity(kind as BusinessKind, id, typeof row.ownerId === 'string' ? row.ownerId : typeof args.ownerId === 'string' ? args.ownerId : undefined, typeof row.episodeId === 'string' ? row.episodeId : typeof args.episodeId === 'string' ? args.episodeId : undefined, typeof row.label === 'string' ? row.label : undefined, db));
                // Keep successful deletion as a historical effect. Creation/update/copy
                // evidence cannot certify a currently delivered object after its removal.
                if (call.effect === 'write' && !call.name.includes('_delete') && !evidence.find(e => e.id === `entity:${kind}:${id}`)?.available) {
                    const source = evidence.find(e => e.id === `tool:${call.id}`)!;
                    source.supportsResult = false;
                    source.outcome = 'unresolved';
                    source.body = `${source.body}\n当前关联目标不可用；此结果仅证明当时执行过操作，不能证明成果仍可交付。`;
                }
            }
        }
    }
    for (const batch of batches) {
        const items = batchItems.filter(item => item.batchId === batch.id);
        const unresolved = batch.status === 'draft' || items.some(item => item.state === 'queued') || jobs.some(job => job.batchId === batch.id && ['submitting', 'submitted', 'running', 'downloading', 'remote_completed', 'unknown'].includes(job.status));
        add({
            id: `batch:${batch.id}`,
            kind: 'generation',
            label: `批量生成 · ${batch.title}`,
            body: JSON.stringify({
                status: batch.status,
                candidates: items.map(item => ({
                    id: item.id,
                    state: item.state,
                    jobId: item.jobId,
                    selected: batch.selections[item.targetKey] === item.id
                })),
                pauseReason: batch.pauseReason
            }),
            outcome: unresolved ? 'unresolved' : 'fact',
            available: true,
            supportsResult: false
        }, {batch, items});
    }
    for (const job of jobs) {
        const target = job.target;
        if (target.kind !== 'library') await Promise.resolve(entity(target.kind, target.entityId, target.projectId, 'episodeId' in target ? target.episodeId : undefined, undefined, db));
        const owned = await Promise.resolve(ownedTaskGenerationJob(task, job, db));
        const output = await Promise.resolve(inspectTaskGenerationOutput(job, db));
        const {media} = output;
        const available = owned && output.available, applied = available && output.applied;
        let href: string | undefined;
        if (target.kind === 'library') href = `/assets?project=${encodeURIComponent(target.projectId)}`;
        else try {
            const row = await getRow(target.kind, target.entityId, target.projectId, 'episodeId' in target ? target.episodeId : undefined, db);
            href = navigation(target.kind, row).href;
        } catch {/* Missing targets remain historical evidence. */
        }
        const status = applied ? 'applied' : available ? 'downloaded' : 'unresolved';
        add({
            id: `generation:${job.id}`,
            kind: "generation",
            label: `${job.kind === 'image' ? '图片' : '视频'} · ${job.model}`,
            body: JSON.stringify({
                status: job.status,
                currentOutcome: status,
                target: job.target,
                result: job.result,
                mediaAvailable: available,
                appliedToCurrentTarget: applied,
                error: job.error
            }),
            outcome: status,
            available,
            supportsResult: status !== "unresolved",
            href
        }, {
            ...job,
            media: media ? {
                id: media.id,
                projectId: media.projectId,
                mimeType: media.mimeType,
                size: binaryByteLength(media.blob)
            } : null,
            currentAvailable: available,
            currentApplied: applied
        });
    }
    for (const job of await db.audioGenerationJobs.where("projectId").equals(task.projectId).toArray()) {
        if (!await Promise.resolve(ownedTaskAudioGenerationJob(task, job, db))) continue;
        const source = await Promise.resolve(taskAudioGenerationSource(task, job, undefined, db));
        add({
            id: `generation:${job.id}`, kind: "generation", label: source.label, body: source.body,
            outcome: source.supportsResult ? source.applied ? "applied" : "downloaded" : "unresolved",
            available: source.available, supportsResult: source.supportsResult,
            href: source.available ? `/p/${encodeURIComponent(job.projectId)}` : undefined
        }, {jobRevision: job.revision, jobFingerprint: targetRevision(job), source: source.body});
        for (const output of await Promise.resolve(taskAudioGenerationOutputSources(task, job, db))) add({
            id: taskGenerationEvidenceId(job.id, output.resultKey),
            kind: "generation",
            label: output.label,
            body: output.body,
            outcome: output.supportsResult ? output.applied ? "applied" : "downloaded" : "unresolved",
            available: output.available,
            supportsResult: output.supportsResult,
            href: output.available ? `/p/${encodeURIComponent(job.projectId)}` : undefined
        }, {jobRevision: job.revision, source: output.body});
    }
    for (const record of records) add({
        id: `record:${record.id}`,
        kind: "record",
        label: record.title,
        body: JSON.stringify({
            kind: record.kind,
            claim: record.claim,
            author: record.author,
            body: record.body,
            sources: record.sources
        }),
        outcome: record.kind === 'question' ? 'unresolved' : 'fact',
        available: true
    }, record);
    for (const message of messages) add({
        id: `message:${message.id}`,
        kind: "message",
        label: message.role === 'user' ? '用户要求与反馈' : 'AI 回复（待核实）',
        body: message.content,
        outcome: message.role === 'assistant' && message.status !== 'complete' ? 'unresolved' : 'fact',
        available: true
    }, message);
    if (task.projectId) {
        const attachments = [
            ...messages.flatMap(message => message.attachments ?? []),
            ...calls.filter(call => call.status === "completed").flatMap(call => toolReferenceAttachments(call.result, task.projectId)),
        ];
        for (const source of await collectReferenceEvidence(task.projectId, attachments, db)) add(source.evidence, source.fingerprint);
    }
    // Prioritize unresolved outcomes and the latest user corrections. Record all omissions.
    const ordered = [...evidence].reverse(), selected: WrapupEvidence[] = [];
    const take = (items: WrapupEvidence[], count: number) => {
        for (const item of items.filter(item => !selected.some(s => s.id === item.id)).slice(0, count)) selected.push(item);
    };
    take(ordered.filter(e => e.outcome === 'unresolved'), 6);
    for (const kind of ['generation', 'entity', 'tool', 'record', 'reference'] as const) take(ordered.filter(e => e.kind === kind), Math.min(8, 48 - selected.length));
    take(ordered.filter(e => e.kind === 'message'), Math.min(10, 48 - selected.length));
    take(ordered, 48 - selected.length);
    const selectedIds = new Set(selected.map(e => e.id));
    return {
        fingerprint: targetRevision({
            project: task.projectId ? await db.projects.get(task.projectId) : null,
            task: {
                id: task.id,
                projectId: task.projectId,
                title: task.title,
                goal: task.goal,
                plan: task.plan,
                acceptanceCriteria: task.acceptanceCriteria ?? [],
                revision: task.revision ?? 1,
                artifacts: task.artifacts
            },
            runs: runs.map(r => ({id: r.id, status: r.status, updatedAt: r.updatedAt})),
            audioBatches, audioBatchItems,
            sources: fingerprints.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        }),
        taskRevision: task.revision ?? 1,
        criteria: task.acceptanceCriteria ?? [],
        evidence: includeAllEvidence ? evidence.map(item => selectedIds.has(item.id) ? item : {
            ...item,
            body: "",
            truncated: true
        }) : selected,
        coverage: {
            total: evidence.length,
            included: selected.length,
            omitted: evidence.length - selected.length,
            truncated: selected.filter(e => e.truncated).length
        }
    };
}
