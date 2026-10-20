import {failStoreTableOnce} from "./helpers/storeFaults";
import {registeredTools} from "./helpers/registeredTools";
import { saveFixtureToolRound } from "./helpers/toolDispatch";
import { taskGenerationSource, saveTaskRecord, validateTaskSources } from '@/features/agent/commands/agentTaskRecords';
import { createAgentTaskForThread } from '@/features/agent/commands/agentTasks';
import { getTaskWrapupState } from '@/features/agent/commands/agentTaskWrapups';
import { describe, expect, it, vi } from 'vitest';
import { db } from '@/platform/product/store';
import { beginAgentRun } from '@/features/agent/commands/agentRuns';
import {  transitionToolCall } from '@/features/agent/commands/agentTools';
import {createProject} from "@/features/projects/commands/projects";
import {addShot, patchShot} from "@/features/video/commands/shots";
import {createChatThread} from "@/features/agent/commands/chat";
import {deleteChatThread} from "@/features/agent/commands/lifecycle";
import {deleteProject} from "@/features/projects/commands/lifecycle";
import {deleteMediaIfOrphan, putMedia} from "@/features/library/commands/media";
import { prepareGenerationBatch, readGenerationBatch, saveGenerationBatchDraft, changeGenerationBatchItems, confirmGenerationBatch, applyBatchSelections, selectBatchCandidate, retryFailedBatch, controlGenerationBatch, recoverAbandonedGenerationBatch } from '@/features/agent/commands/agentGenerationBatches';
import { startGenerationBatch, stopGenerationBatch, batchUserAction } from '@/features/video/agent/generationBatchRuntime';
import { applyAgentGeneration } from '@/features/video/agent/generationRuntime';
import { generationSubmitSchema, type GenerationSubmitArgs } from '@/features/video/agent/generationProfiles';
import type {ConnectorConfig} from "@/features/settings/models/connector";
import type { AgentToolContext } from '@/features/agent/runtime/tools';
import type { ThreadLockManager } from '@/features/agent/runtime/runOwnership';
import { GENERATION_TOOLS as GENERATION_TOOLS_DEFINITIONS } from '@/features/video/agent/generationTools';
const GENERATION_TOOLS = registeredTools(GENERATION_TOOLS_DEFINITIONS);


const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
function lockManager(): ThreadLockManager {
  let held = false;
  return { async request(_name, _options, callback) { if (held) return callback(null); held = true; try { return await callback({}); } finally { held = false; } } };
}
async function fixture(count = 4, provider: 'apimart' | 'aihubmix' = 'apimart') {
  const config: ConnectorConfig = { id: 'batch-connector', name: 'Generation', definitionId: provider, baseUrl: `https://${provider}.test/v1`, apiKey: 'private-batch-key', updatedAt: 'now' };
  await db.connectors.put(config);
  const project = await createProject('批量测试');
  const episode = (await db.episodes.where('projectId').equals(project.id).first())!;
  const shot = await addShot(project.id, episode.id), thread = await createChatThread();
  const run = await beginAgentRun({ threadId: thread.id, connector: config, model: 'chat', content: '准备候选' });
  const draft: GenerationSubmitArgs = { connectorId: config.id, model: 'gpt-image-2', prompt: '雨夜车站', parameters: {}, inputs: [], target: { kind: 'shot', projectId: project.id, episodeId: episode.id, entityId: shot.id, slot: 'firstFrame' } };
  const candidates = Array.from({ length: count }, (_, index) => ({ ...draft, target: { ...draft.target, slot: index > 3 ? 'lastFrame' : 'firstFrame' } }));
  await saveFixtureToolRound(run.id, '', [{ id: 'batch-source', type: 'function', function: { name: 'prepare_generation_batch', arguments: JSON.stringify({ title: '候选批次', candidates }) } }], [{ title: '准备批量生成', effect: 'bookkeeping', highRisk: false, atomic: true }]);
  const call = (await db.agentToolCalls.where('runId').equals(run.id).first())!;
  await transitionToolCall(run.id, call.id, ['pending'], 'running');
  const context: AgentToolContext = { runId: run.id, threadId: thread.id, callId: call.id, signal: new AbortController().signal };
  const result = await prepareGenerationBatch('候选批次', candidates, context) as { batchId: string };
  return { config, project, episode, shot, thread, run, call, context, candidates, id: result.batchId, locks: lockManager() };
}
function apimartMock(behavior?: (index: number) => Response | Promise<Response>) {
  let posts = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method === 'POST') { posts++; return behavior ? behavior(posts) : Response.json({ code: 200, data: [{ task_id: `task-${posts}`, status: 'submitted' }] }); }
    if (String(url).includes('/tasks/')) return Response.json({ code: 200, data: { id: new URL(String(url)).pathname.split('/').at(-1), status: 'completed', progress: 100, result: { images: [{ url: 'https://cdn.test/output' }] } } });
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  });
  return { fetchImpl, posts: () => posts };
}
async function confirm(f: Awaited<ReturnType<typeof fixture>>) { const state = await readGenerationBatch(f.id, f.thread.id); return confirmGenerationBatch(f.id, f.thread.id, state.batch.revision, new AbortController().signal); }
async function run(f: Awaited<ReturnType<typeof fixture>>, fetchImpl: typeof fetch) { await startGenerationBatch(f.id, f.thread.id, { locks: f.locks, fetchImpl, pollIntervalMs: 0, maxPolls: 2 }); return readGenerationBatch(f.id, f.thread.id); }

describe('durable generation batch review', () => {
  it('saves draft and tool result together, replays without creating candidates, preserves envelopes', async () => {
    const f = await fixture();
    const before = await db.agentToolCalls.get(f.call.id);
    expect(before?.status).toBe('completed'); expect(JSON.parse(before!.result!)).toMatchObject({ status: 'draft', submitted: false, candidateCount: 4 });
    expect(await prepareGenerationBatch('different', f.candidates, f.context)).toMatchObject({ batchId: f.id, candidateCount: 4 });
    expect(await db.agentGenerationBatches.count()).toBe(1); expect(await db.agentGenerationJobs.count()).toBe(0);
    expect((await db.agentToolCalls.get(f.call.id))?.arguments).toBe(f.call.arguments);
  });
  it('accepts 20 requests, rejects 21 or five for one slot, rejects foreign owner', async () => {
    const f = await fixture(1), tool = GENERATION_TOOLS.find(t => t.name === 'prepare_generation_batch')!;
    const candidates = Array.from({ length: 20 }, (_, i) => ({ ...f.candidates[0], target: { ...f.candidates[0].target, entityId: `entity-${Math.floor(i / 4)}` } }));
    expect(() => tool.parseArguments({ title: '20', candidates })).not.toThrow();
    expect(() => tool.parseArguments({ title: '21', candidates: [...candidates, candidates[0]] })).toThrow();
    expect(() => tool.parseArguments({ title: '5', candidates: Array(5).fill(candidates[0]) })).toThrow();
    expect(() => tool.parseArguments({ title: 'mixed', candidates: [candidates[0], { ...candidates[1], target: { ...candidates[1].target, projectId: 'foreign' } }] })).toThrow();
    expect(() => tool.parseArguments({ title: 'strict', candidates: [{ ...candidates[0], apiKey: 'secret' }] })).toThrow();
  });
  it('keeps whitespace editing, revisions and atomic all-or-none confirmation across reopen', async () => {
    const f = await fixture(2), initial = await readGenerationBatch(f.id, f.thread.id);
    const edits = initial.items.map(item => ({ id: item.id, draft: { ...item.draft, prompt: '  ' }, included: true }));
    const saved = await saveGenerationBatchDraft(f.id, f.thread.id, 1, edits);
    await expect(saveGenerationBatchDraft(f.id, f.thread.id, 1, edits)).rejects.toThrow('更新');
    await expect(confirm(f)).rejects.toThrow();
    expect((await readGenerationBatch(f.id, f.thread.id)).items.every(i => !i.snapshot)).toBe(true);
    const valid = await saveGenerationBatchDraft(f.id, f.thread.id, saved.revision, edits.map(e => ({ ...e, draft: { ...e.draft, prompt: '修订描述' } })));
    db.close(); await db.open();
    expect((await readGenerationBatch(f.id, f.thread.id)).items[0].draft.prompt).toBe('修订描述');
    const spy = failStoreTableOnce(db, "agentGenerationBatches", "put", new Error('storage full'));
    await expect(confirmGenerationBatch(f.id, f.thread.id, valid.revision, new AbortController().signal)).rejects.toThrow('storage full'); spy.mockRestore();
    expect((await readGenerationBatch(f.id, f.thread.id)).items.every(i => !i.snapshot)).toBe(true);
    const outcomes = await Promise.allSettled([confirm(f), confirm(f)]);
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1); expect(await db.agentGenerationJobs.count()).toBe(0);
  });
  it('clones/removes/deselects without changing original target or input identity', async () => {
    const f = await fixture(1), first = await readGenerationBatch(f.id, f.thread.id);
    let batch = await changeGenerationBatchItems(f.id, f.thread.id, 1, first.items[0].id, 'clone');
    const state = await readGenerationBatch(f.id, f.thread.id);
    await expect(saveGenerationBatchDraft(f.id, f.thread.id, batch.revision, state.items.map(i => ({ id: i.id, included: true, draft: { ...i.draft, inputs: [{ mediaId: 'other', role: 'reference-image' }] } })))).rejects.toThrow('不能修改');
    batch = await saveGenerationBatchDraft(f.id, f.thread.id, batch.revision, state.items.map((i, index) => ({ id: i.id, draft: i.draft, included: index === 1 })));
    await confirmGenerationBatch(f.id, f.thread.id, batch.revision, new AbortController().signal);
    expect((await readGenerationBatch(f.id, f.thread.id)).items.map(i => i.state)).toEqual(['cancelled', 'queued']);
  });
});

describe('bounded paid queue and explicit recovery', () => {
  it('submits four intentional identical candidates with max two active and never replays after reopen', async () => {
    const f = await fixture(); await confirm(f);
    let active = 0, maximum = 0;
    const releases: Array<() => void> = [];
    const mock = apimartMock(index => new Promise(resolve => { active++; maximum = Math.max(maximum, active); releases.push(() => { active--; resolve(Response.json({ code: 200, data: [{ task_id: `task-${index}`, status: 'submitted' }] })); }); }));
    const executing = run(f, mock.fetchImpl);
    await vi.waitFor(() => expect(releases.length).toBe(2)); expect(mock.posts()).toBe(2);
    releases.splice(0).forEach(release => release());
    await vi.waitFor(() => expect(releases.length).toBe(2)); releases.splice(0).forEach(release => release());
    const result = await executing;
    expect(maximum).toBe(2); expect(result.jobs).toHaveLength(4); expect(result.jobs.every(j => j.status === 'downloaded' && !j.callId && j.batchItemId)).toBe(true);
    expect(new Set(result.jobs.map(j => j.fingerprint)).size).toBe(1);
    db.close(); await db.open(); await run(f, mock.fetchImpl); expect(mock.posts()).toBe(4);
    expect(JSON.stringify(result)).not.toContain(f.config.apiKey);
  });
  it('continues after known failure, retries only through a new unpaid draft', async () => {
    const f = await fixture(3); await confirm(f);
    const mock = apimartMock(index => index === 1 ? Response.json({ error: { message: 'invalid prompt' } }, { status: 400 }) : Response.json({ code: 200, data: [{ task_id: `task-${index}` }] }));
    const state = await run(f, mock.fetchImpl);
    expect(mock.posts()).toBe(3); expect(state.jobs.filter(j => j.status === 'failed')).toHaveLength(1); expect(state.jobs.filter(j => j.result)).toHaveLength(2);
    const retry = await retryFailedBatch(f.id, f.thread.id); expect(retry.status).toBe('draft'); expect(retry.retrySourceBatchId).toBe(f.id);
    expect((await readGenerationBatch(retry.id, f.thread.id)).items).toHaveLength(1); expect(mock.posts()).toBe(3);
  });
  it('unknown acceptance durably pauses new dispatch and cannot retry or erase ambiguity by cancellation', async () => {
    const f = await fixture(); await confirm(f);
    const mock = apimartMock(() => { throw new TypeError('lost response'); });
    let state = await run(f, mock.fetchImpl);
    expect(mock.posts()).toBeLessThanOrEqual(2); expect(state.batch.status).toBe('paused'); expect(state.jobs.some(j => j.status === 'unknown')).toBe(true);
    await expect(retryFailedBatch(f.id, f.thread.id)).rejects.toThrow('未知');
    const posts = mock.posts(); db.close(); await db.open(); await run(f, mock.fetchImpl); expect(mock.posts()).toBe(posts);
    await stopGenerationBatch(f.id, f.thread.id, 'cancel', f.locks);
    state = await readGenerationBatch(f.id, f.thread.id); expect(state.items.filter(i => !i.jobId).every(i => i.state === 'cancelled')).toBe(true); expect(state.jobs.some(j => j.status === 'unknown')).toBe(true);
  });
  it('recovers accepted remote identity without a POST after interrupted polling', async () => {
    const f = await fixture(1); await confirm(f); let complete = false;
    const mock = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'POST') return Response.json({ code: 200, data: [{ task_id: 'saved-task' }] });
      if (String(url).includes('/tasks/')) return Response.json({ code: 200, data: { id: 'saved-task', status: complete ? 'completed' : 'processing', ...(complete ? { result: { images: [{ url: 'https://cdn.test/result' }] } } : {}) } });
      return new Response(png);
    });
    expect((await run(f, mock)).batch.status).toBe('paused'); complete = true; db.close(); await db.open();
    const state = await run(f, mock); expect(state.jobs[0].status).toBe('downloaded'); expect(mock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('marks abandoned submitting intent unknown locally and honors locks before any user write', async () => {
    const f = await fixture(1); await confirm(f);
    let release: (() => void) | undefined;
    const delayed: ThreadLockManager = { async request(_name, _options, callback) { await new Promise<void>(resolve => { release = resolve; }); return callback(null); } };
    const starting = startGenerationBatch(f.id, f.thread.id, { locks: delayed }).catch(() => undefined);
    const action = vi.fn(async () => 'written');
    const editing = batchUserAction(f.id, action, { async request(_n, _o, callback) { return callback(null); } }).catch(() => undefined);
    await Promise.resolve(); expect(action).not.toHaveBeenCalled(); release!(); await starting; await editing; expect(action).not.toHaveBeenCalled();
    const item = (await readGenerationBatch(f.id, f.thread.id)).items[0];
    await db.agentGenerationJobs.add({ ...item.snapshot!, version: 1, id: 'abandoned', batchId: f.id, batchItemId: item.id, projectId: f.project.id, threadId: f.thread.id, runId: f.run.id, status: 'submitting', createdAt: 'now', updatedAt: 'now' });
    await db.agentGenerationBatchItems.update(item.id, { state: 'claimed', jobId: 'abandoned' }); await db.agentGenerationBatches.update(f.id, { status: 'running' });
    await recoverAbandonedGenerationBatch(f.id); expect((await db.agentGenerationJobs.get('abandoned'))?.status).toBe('unknown');
  });
  it('AIHubMix synchronous media uses the shared adapter and retains exact one-result mapping', async () => {
    const f = await fixture(2, 'aihubmix'); await confirm(f);
    const mock = vi.fn<typeof fetch>(async (_url, init) => { expect(init?.method).toBe('POST'); expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-image-2', n: 1 }); return Response.json({ id: `hub-${Math.random()}`, object: 'image', model: 'gpt-image-2', status: 'completed', output: [{ index: 0, type: 'file', b64_json: btoa(String.fromCharCode(...png)) }] }); });
    const state = await run(f, mock); expect(mock).toHaveBeenCalledTimes(2); expect(state.jobs.every(j => j.status === 'downloaded')).toBe(true);
  });
});

describe('explicit selection, revisions and lifecycle', () => {
  it('applies sibling slots, switches A→B→A idempotently, preserves text and prevents manual conflict overwrite', async () => {
    const f = await fixture(5); await confirm(f); const mock = apimartMock(); let state = await run(f, mock.fetchImpl);
    const [a, b, , , tail] = state.items;
    await selectBatchCandidate(f.id, f.thread.id, a.id); await selectBatchCandidate(f.id, f.thread.id, tail.id);
    expect((await applyBatchSelections(f.id, f.thread.id)).every(o => o.applied)).toBe(true);
    for (const item of [b, a]) { await selectBatchCandidate(f.id, f.thread.id, item.id); expect((await applyBatchSelections(f.id, f.thread.id)).every(o => o.applied)).toBe(true); }
    state = await readGenerationBatch(f.id, f.thread.id); const auditCount = state.batch.applications.length;
    await applyBatchSelections(f.id, f.thread.id); expect((await readGenerationBatch(f.id, f.thread.id)).batch.applications).toHaveLength(auditCount);
    await patchShot(f.shot.id, { notes: '人工改动' }); await selectBatchCandidate(f.id, f.thread.id, b.id);
    expect((await applyBatchSelections(f.id, f.thread.id)).every(o => !o.applied)).toBe(true); expect((await db.shots.get(f.shot.id))?.notes).toBe('人工改动');
    for (const job of state.jobs) await deleteMediaIfOrphan(job.result!.mediaId); expect(await db.media.count()).toBe(5);
    await expect(applyAgentGeneration(state.jobs[0].id, f.context)).rejects.toThrow('用户');
    await deleteChatThread(f.thread.id); expect(await db.agentGenerationBatches.count()).toBe(0); expect(await db.agentGenerationBatchItems.count()).toBe(0); expect(await db.media.count()).toBe(2);
  });
  it('rolls back whole entity group and audit on application storage failure', async () => {
    const f = await fixture(5); await confirm(f); const state = await run(f, apimartMock().fetchImpl);
    await selectBatchCandidate(f.id, f.thread.id, state.items[0].id); await selectBatchCandidate(f.id, f.thread.id, state.items[4].id);
    const spy = failStoreTableOnce(db, "agentGenerationBatches", "put", new Error('audit full'));
    const outcomes = await applyBatchSelections(f.id, f.thread.id); spy.mockRestore();
    expect(outcomes.every(o => !o.applied)).toBe(true); expect((await db.shots.get(f.shot.id))?.firstFrame.result).toBeUndefined(); expect((await readGenerationBatch(f.id, f.thread.id)).batch.applications).toHaveLength(0);
  });
  it('deletion during download cannot resurrect batch/job/media', async () => {
    const f = await fixture(1); await confirm(f); const mock = apimartMock();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => { if (String(url).includes('cdn.test')) await deleteProject(f.project.id); return mock.fetchImpl(url, init); });
    await startGenerationBatch(f.id, f.thread.id, { fetchImpl, locks: f.locks, pollIntervalMs: 0 }).catch(() => undefined);
    expect(await db.agentGenerationJobs.count()).toBe(0); expect(await db.agentGenerationBatches.count()).toBe(0); expect(await db.media.count()).toBe(0);
  });
  it('keeps draft inputs through orphan cleanup and rejects changed bytes before confirmation', async () => {
    const f = await fixture(1); const state = await readGenerationBatch(f.id, f.thread.id);
    const media = { id: 'input', projectId: f.project.id, blob: new Blob([png]), mimeType: 'image/png', filename: 'input.png' };
    await putMedia(media);
    // Seed a persisted reference like a prepared proposal; API itself forbids changing identity.
    await db.agentGenerationBatchItems.update(state.items[0].id, { draft: generationSubmitSchema.parse({ ...state.items[0].draft, inputs: [{ mediaId: media.id, role: 'reference-image' }] }) });
    await deleteMediaIfOrphan(media.id); expect(await db.media.get(media.id)).toBeTruthy();
    await expect(confirm(f)).rejects.toThrow('输入');
    await controlGenerationBatch(f.id, f.thread.id, 'cancel');
  });
});


describe('batch task evidence', () => {
  it('blocks open queues and records genuine outputs independently from draft bookkeeping', async () => {
    const f = await fixture(2);
    await db.chatThreads.update(f.thread.id, { projectId: f.project.id });
    await db.agentRuns.update(f.run.id, { status: 'completed', projectId: f.project.id });
    const task = await createAgentTaskForThread(f.thread.id, { title: '生成测试', goal: '选择真实结果', projectId: f.project.id });
    await db.agentRuns.update(f.run.id, { taskId: task.id }); await db.agentGenerationBatches.update(f.id, { taskId: task.id });
    let evidence = await getTaskWrapupState(task.id);
    expect(evidence.completionBlockers.some(reason => reason.includes('批量'))).toBe(true);
    expect(evidence.currentEvidence.find(item => item.id === `tool:${f.call.id}`)?.supportsResult).toBe(false);
    const fingerprint = evidence.currentEvidence.find(item => item.id === `batch:${f.id}`);
    expect(fingerprint?.outcome).toBe('unresolved');
    await confirm(f); const state = await run(f, apimartMock().fetchImpl);
    evidence = await getTaskWrapupState(task.id);
    expect(evidence.completionBlockers.some(reason => reason.includes('批量'))).toBe(false);
    const a = state.items[0], b = state.items[1];
    await selectBatchCandidate(f.id, f.thread.id, a.id); await applyBatchSelections(f.id, f.thread.id);
    expect(await taskGenerationSource(task, a.jobId!)).toMatchObject({ available: true, applied: true });
    await selectBatchCandidate(f.id, f.thread.id, b.id); await applyBatchSelections(f.id, f.thread.id);
    expect(await taskGenerationSource(task, a.jobId!)).toMatchObject({ available: true, applied: false });
    await saveTaskRecord(task.id, { kind: 'verification', claim: 'result', title: '本地结果', body: '候选素材已保存，第二份已选用', sources: [{ type: 'generation', id: b.jobId! }] });
    expect(await db.agentTaskRecords.where('taskId').equals(task.id).count()).toBe(1);
    await expect(validateTaskSources({ id: 'foreign', threadId: task.threadId }, [{ type: 'generation', id: b.jobId! }], 'result', 'ai')).rejects.toThrow('不属于');
    await db.media.delete(state.jobs.find(job => job.id === b.jobId)!.result!.mediaId);
    await expect(validateTaskSources(task, [{ type: 'generation', id: b.jobId! }], 'result', 'ai')).rejects.toThrow('完成结果');
  });
});
