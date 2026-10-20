import {describe, expect, it, vi} from "vitest";
import {db} from "@/platform/product/store";
import {saveFixtureToolRound} from "./helpers/toolDispatch";
import {beginAgentRun} from "@/features/agent/commands/agentRuns";
import {transitionToolCall} from "@/features/agent/commands/agentTools";
import {createProject} from "@/features/projects/commands/projects";
import {addShot} from "@/features/video/commands/shots";
import {createChatThread} from "@/features/agent/commands/chat";
import {applyBatchSelections, confirmGenerationBatch, prepareGenerationBatch, readGenerationBatch, selectBatchCandidate} from "@/features/agent/commands/agentGenerationBatches";
import {startGenerationBatch} from "@/features/video/agent/generationBatchRuntime";
import {type GenerationSubmitArgs} from "@/features/video/agent/generationProfiles";
import {validateProductionTarget} from "@/features/video/models/productionRevision";
import type {ConnectorConfig} from "@/features/settings/models/connector";
import type {AgentToolContext} from "@/features/agent/runtime/tools";
import type {ThreadLockManager} from "@/features/agent/runtime/runOwnership";

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
function lockManager(): ThreadLockManager {
  let held = false;
  return { async request(_name, _options, callback) { if (held) return callback(null); held = true; try { return await callback({}); } finally { held = false; } } };
}
async function fixture(count = 2) {
  const config: ConnectorConfig = {id: 'lib-connector', name: 'Generation', definitionId: 'apimart', baseUrl: 'https://apimart.test/v1', apiKey: 'private-lib-key', updatedAt: 'now'};
  await db.connectors.put(config);
  const project = await createProject('素材库生成');
  const episode = (await db.episodes.where('projectId').equals(project.id).first())!;
  const shot = await addShot(project.id, episode.id), thread = await createChatThread();
  const run = await beginAgentRun({threadId: thread.id, connector: config, model: 'chat', content: '准备候选'});
  const candidates: GenerationSubmitArgs[] = Array.from({length: count}, (_, index) => ({
    connectorId: config.id, model: 'gpt-image-2', prompt: `海报方案 ${index}`, parameters: {}, inputs: [],
    target: {kind: 'library', projectId: project.id, entityId: 'posters', slot: 'image', label: '海报'}
  }));
  await saveFixtureToolRound(run.id, '', [{id: 'batch-source', type: 'function', function: {name: 'prepare_generation_batch', arguments: JSON.stringify({title: '素材库候选', candidates})}}], [{title: '准备批量生成', effect: 'bookkeeping', highRisk: false, atomic: true}]);
  const call = (await db.agentToolCalls.where('runId').equals(run.id).first())!;
  await transitionToolCall(run.id, call.id, ['pending'], 'running');
  const context: AgentToolContext = {runId: run.id, threadId: thread.id, callId: call.id, signal: new AbortController().signal};
  const result = await prepareGenerationBatch('素材库候选', candidates, context) as {batchId: string};
  return {config, project, episode, shot, thread, run, call, context, candidates, id: result.batchId, locks: lockManager()};
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

describe('generation into the material library', () => {
  it('validates a library target by media type and keeps slot targets as they were', () => {
    const base = {projectId: 'p', entityId: 'g'};
    expect(validateProductionTarget({kind: 'library', ...base, slot: 'video', label: ' 封面 '})).toEqual({kind: 'library', ...base, slot: 'video', label: '封面'});
    expect(() => validateProductionTarget({kind: 'library', ...base, slot: 'firstFrame'})).toThrow('图片或视频');
    expect(() => validateProductionTarget({kind: 'library', ...base})).toThrow();
    expect(validateProductionTarget({kind: 'character', ...base, slot: 'front'})).toMatchObject({kind: 'character', slot: 'front'});
  });

  it('keeps the chosen candidate as a project material once, and writes no slot', async () => {
    const f = await fixture(); await confirm(f);
    const state = await run(f, apimartMock().fetchImpl);
    expect(state.jobs.every(job => job.status === 'downloaded' && job.target.kind === 'library' && job.kind === 'image')).toBe(true);
    const [first] = state.items;
    await selectBatchCandidate(f.id, f.thread.id, first.id);
    expect((await applyBatchSelections(f.id, f.thread.id)).every(outcome => outcome.applied)).toBe(true);
    const materials = (await db.libraryMaterials.toArray()).filter(item => item.scope.kind === 'project' && item.scope.id === f.project.id);
    expect(materials).toHaveLength(1);
    expect(materials[0]).toMatchObject({name: '海报', kind: 'image', archived: false});
    const mediaId = state.jobs.find(job => job.id === first.jobId)!.result!.mediaId;
    expect(materials[0].source).toMatchObject({projectId: f.project.id, entityId: mediaId, generated: true});
    expect((await db.media.get(mediaId))?.libraryRetained).toBe(true);
    expect((await db.shots.get(f.shot.id))!.firstFrame.result).toBeUndefined();
    // Applying again neither duplicates the material nor fails.
    await applyBatchSelections(f.id, f.thread.id);
    expect((await db.libraryMaterials.toArray()).filter(item => item.scope.kind === 'project')).toHaveLength(1);
    const after = await readGenerationBatch(f.id, f.thread.id);
    expect(after.jobs.find(job => job.id === first.jobId)!.status).toBe('applied');
    expect(after.currentMedia[first.targetKey]).toBe(mediaId);
  });

  it('does not keep the candidates nobody chose', async () => {
    const f = await fixture(); await confirm(f);
    const state = await run(f, apimartMock().fetchImpl);
    await selectBatchCandidate(f.id, f.thread.id, state.items[1].id);
    await applyBatchSelections(f.id, f.thread.id);
    const names = (await db.libraryMaterials.toArray()).filter(item => item.scope.kind === 'project').map(item => item.source?.entityId);
    expect(names).toEqual([state.jobs.find(job => job.id === state.items[1].jobId)!.result!.mediaId]);
  });
});
