import {interceptStoreTable} from "./helpers/storeFaults";
import {registeredTools} from "./helpers/registeredTools";
import { describe, expect, it, vi } from 'vitest';
import { db } from '@/platform/product/store';
import { beginAgentRun } from '@/features/agent/commands/agentRuns';
import { resolveAgentToolApproval } from '@/features/agent/commands/agentTools';
import {createChatThread} from "@/features/agent/commands/chat";
import {createProject} from "@/features/projects/commands/projects";
import { bindProjectIp, createIpProfile, setIpArchived, updateIpProfile } from '@/features/library/commands/ipProfiles';
import {putMedia} from '@/features/library/commands/media';
import { IP_TOOLS as IP_TOOLS_DEFINITIONS } from '@/features/library/agent/ipTools';
import { IP_TOOL_NAMES } from '@/features/library/agent/ipToolNames';
import { getProjectContext, refreshRunProjectContext } from '@/features/agent/runtime/projectContext';
import { executeChatRun, resumeChatRun } from '@/features/agent/runtime/runChat';
import { requiresToolApproval, type AgentToolContext } from '@/features/agent/runtime/tools';
import type { AgentRun } from '@/features/agent/models/agent';
import type {ConnectorConfig} from "@/features/settings/models/connector";
import { createId } from '@/platform/identity';
const IP_TOOLS = registeredTools(IP_TOOLS_DEFINITIONS);


const connector: ConnectorConfig = { id: 'fixture', definitionId: 'openai-compatible', baseUrl: 'https://example.test/v1', apiKey: 'fixture', updatedAt: '2026-09-21' };
async function begin(projectId?: string) {
  const thread = await createChatThread({ projectId });
  const run = await beginAgentRun({ threadId: thread.id, connector, model: 'fixture', content: '建立 INFP 美食博主 IP' });
  // Exercise legacy-compatible fully loaded execution; discovery authorization has a separate suite.
  const ready = { ...run, permissionMode: 'full' as const, enabledToolNames: [...IP_TOOL_NAMES], toolLoading: undefined };
  await db.agentRuns.put(ready);
  return ready;
}
function context(run: AgentRun): AgentToolContext { return { runId: run.id, threadId: run.threadId, callId: createId('call'), signal: new AbortController().signal }; }
const tool = (name: string) => IP_TOOLS.find(item => item.name === name)!;
const response = (name: string, args: unknown) => Response.json({ choices: [{ message: { content: '', tool_calls: [{ id: 'provider-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
const answer = () => Response.json({ choices: [{ message: { content: '已处理' }, finish_reason: 'stop' }] });
async function paused(run: AgentRun, name: string, args: unknown) {
  await executeChatRun(run, connector.apiKey, new AbortController(), vi.fn(async () => response(name, args)), IP_TOOLS);
  const calls = await db.agentToolCalls.where('runId').equals(run.id).toArray();
  expect(calls).toHaveLength(1);
  expect(calls[0].status, calls[0].error).toBe('awaiting_approval');
  return calls[0];
}

describe('IP tools with approval, scope and current facts', () => {
  it('always confirms IP creation with readable fields, commits once and never replays after a failed next request', async () => {
    const run = await begin();
    for (const mode of ['ask', 'assist', 'full'] as const) expect(requiresToolApproval(mode, tool('ip_create'), {})).toBe(true);
    const call = await paused(run, 'ip_create', { name: 'INFP 美食博主', positioning: '用家常料理记录生活', visual: '自然光' });
    expect(call.preview?.changes.join('\n')).toContain('定位：用家常料理记录生活');
    expect(await db.ipProfiles.count()).toBe(0);
    await resolveAgentToolApproval(run.id, call.id, 'approve');
    await resumeChatRun(run.id, connector.apiKey, new AbortController(), vi.fn(async () => new Response('down', { status: 500 })), IP_TOOLS);
    expect(await db.ipProfiles.count()).toBe(1);
    expect((await db.agentToolCalls.get(call.id))?.status).toBe('completed');
    await resumeChatRun(run.id, connector.apiKey, new AbortController(), vi.fn(async () => answer()), IP_TOOLS);
    expect(await db.ipProfiles.count()).toBe(1);
    expect((await db.ipProfiles.toArray())[0]).toMatchObject({ name: 'INFP 美食博主', positioning: '用家常料理记录生活', revision: 1 });
  });
  it('rejecting a confirmation does not create a record and resumes with an explicit rejection result', async () => {
    const run = await begin(), call = await paused(run, 'ip_create', { name: '不可创建' });
    await resolveAgentToolApproval(run.id, call.id, 'reject');
    await resumeChatRun(run.id, connector.apiKey, new AbortController(), vi.fn(async (_url, init) => { expect(String(init?.body)).toContain('用户拒绝'); return answer(); }), IP_TOOLS);
    expect(await db.ipProfiles.count()).toBe(0);
  });
  it('detects shared impact changes between preview and approval and leaves existing fields intact', async () => {
    const ip = await createIpProfile({ name: '共享 IP' }), a = await createProject('A'), b = await createProject('B');
    await bindProjectIp(a.id, ip.id);
    const run = await begin(a.id), call = await paused(run, 'ip_update', { id: ip.id, expectedRevision: 1, patch: { expression: '温柔' } });
    expect(call.preview?.changes.join('\n')).toContain('关联 1 个项目');
    await bindProjectIp(b.id, ip.id);
    await resolveAgentToolApproval(run.id, call.id, 'approve');
    await resumeChatRun(run.id, connector.apiKey, new AbortController(), vi.fn(async () => answer()), IP_TOOLS);
    expect((await db.ipProfiles.get(ip.id))?.expression).toBe('');
    expect(await db.agentToolCalls.get(call.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('影响范围已变化') });
  });
  it('rejects stale revisions and cross-project/IP detail or mutation while allowing the name catalog', async () => {
    const ip = await createIpProfile({ name: '所属 IP' }), other = await createIpProfile({ name: '其他 IP', positioning: 'PRIVATE' });
    const a = await createProject('A'), b = await createProject('B'); await bindProjectIp(a.id, ip.id);
    const run = await begin(a.id), ctx = context(run);
    await expect(tool('ip_read').execute({ id: other.id }, ctx)).rejects.toThrow('所属 IP');
    await expect(tool('ip_update').prepare!({ id: other.id, expectedRevision: 1, patch: { name: 'bad' } }, ctx)).rejects.toThrow('所属 IP');
    await expect(tool('project_bind_ip').prepare!({ projectId: b.id, ipId: ip.id }, ctx)).rejects.toThrow('绑定项目');
    const search = await tool('ip_search').execute({}, ctx); expect(JSON.stringify(search)).toContain('其他 IP'); expect(JSON.stringify(search)).not.toContain('PRIVATE');
    await updateIpProfile(ip.id, { expression: '新版' }, 1);
    await expect(tool('ip_update').prepare!({ id: ip.id, expectedRevision: 1, patch: { name: 'bad' } }, ctx)).rejects.toThrow('已更新');
  });
  it('confirms a new project association, refreshes IP facts and permits bounded field reads afterward', async () => {
    const ip = await createIpProfile({ name: '新 IP', expression: '文'.repeat(5000) }), project = await createProject('项目');
    const run = await begin(project.id), call = await paused(run, 'project_bind_ip', { projectId: project.id, ipId: ip.id });
    expect(call.preview?.changes[0]).toContain('独立创作 → 新 IP');
    await resolveAgentToolApproval(run.id, call.id, 'approve');
    const fetcher = vi.fn(async (_url, init) => { expect(String(init?.body)).toContain('新 IP'); return answer(); });
    await resumeChatRun(run.id, connector.apiKey, new AbortController(), fetcher, IP_TOOLS);
    expect((await db.projectIpLinks.get(project.id))?.ipId).toBe(ip.id);
    const read = await tool('ip_read').execute({ id: ip.id, field: 'expression', offset: 100, limit: 1200 }, context(run));
    expect(read).toMatchObject({ revision: 1, text: '文'.repeat(1200), totalLength: 5000, nextOffset: 1300 });
    expect(() => tool('ip_update').parseArguments({ id: ip.id, expectedRevision: 1, patch: {}, approved: true })).toThrow();
  });
  it('rejects outdated preview after a manual IP edit without overwriting the manual change', async () => {
    const ip = await createIpProfile({ name: '原名' }), run = await begin();
    const call = await paused(run, 'ip_update', { id: ip.id, expectedRevision: 1, patch: { name: 'AI 名称' } });
    await updateIpProfile(ip.id, { name: '用户修改' }, 1);
    await resolveAgentToolApproval(run.id, call.id, 'approve');
    await resumeChatRun(run.id, connector.apiKey, new AbortController(), vi.fn(async () => answer()), IP_TOOLS);
    expect((await db.ipProfiles.get(ip.id))?.name).toBe('用户修改');
    expect((await db.agentToolCalls.get(call.id))?.status).toBe('failed');
  });
  it.each(['chat-completions', 'responses'] as const)('includes only a bounded linked IP summary and clears changed facts using %s', async protocol => {
    const ip = await createIpProfile({ name: '食物 IP', topics: '长'.repeat(5000), voice: '轻柔' });
    await createIpProfile({ name: 'FOREIGN_PRIVATE' });
    const project = await createProject('A'); await bindProjectIp(project.id, ip.id);
    const initial = await getProjectContext(project.id), facts = JSON.parse(initial.content);
    expect(facts.ip).toMatchObject({ id: ip.id, revision: 1, voice: '轻柔' }); expect(facts.ip.topics.length).toBe(240); expect(initial.coverage.truncated).toBe(true); expect(initial.content).not.toContain('FOREIGN_PRIVATE');
    const run = await begin(project.id); await db.agentRuns.update(run.id, { protocol });
    await updateIpProfile(ip.id, { voice: '活泼' }, 1);
    let fresh = await refreshRunProjectContext(run.id); expect(fresh.continuationMessages?.at(-1)?.content).toContain('活泼'); if (protocol === 'responses') expect(fresh.responseItems?.at(-1)).toMatchObject({ role: 'user' });
    await setIpArchived(ip.id, true); fresh = await refreshRunProjectContext(run.id); expect(fresh.continuationMessages?.at(-1)?.content).toContain('"ip":null');
    await setIpArchived(ip.id, false); await refreshRunProjectContext(run.id);
    await bindProjectIp(project.id, null); fresh = await refreshRunProjectContext(run.id); expect(JSON.parse(fresh.projectContext!.content).ip).toBeNull(); expect(fresh.continuationMessages?.at(-1)?.content).toContain('"ip":null');
    expect(fresh.requestMessages).toEqual(run.requestMessages);
  });
  it('rolls back IP mutation together with the ledger if local result persistence fails', async () => {
    const run = await begin(), def = tool('ip_create'), ctx = context(run), args = { name: 'Rollback IP' };
    ctx.preview = await def.prepare!(args, ctx);
    await db.agentToolCalls.add({ id: ctx.callId, runId: run.id, threadId: run.threadId, providerCallId: ctx.callId, step: 1, order: 0, name: def.name, title: def.title, arguments: JSON.stringify(args), effect: 'write', highRisk: false, atomic: true, status: 'running', createdAt: '2026-09-21', updatedAt: '2026-09-21' });

    const spy = interceptStoreTable(db, "agentToolCalls", 'update', async (_tx,args,next)=> {const params=args; if ((params[1] as { status?: string }).status === 'completed') throw new Error('ledger persistence failed'); return next(); });
    try { await expect(def.execute(args, ctx)).rejects.toThrow('ledger persistence failed'); } finally { spy.mockRestore(); }
    expect(await db.ipProfiles.count()).toBe(0); expect((await db.agentToolCalls.get(ctx.callId))?.status).toBe('running');
  });
});

describe('IP portrait through ip_update', () => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
  const image = async (projectId: string) => {
    const id = createId('med');
    await putMedia({ id, projectId, mimeType: 'image/png', filename: 'portrait.png', blob: new Blob([png], { type: 'image/png' }) });
    return id;
  };
  it('previews and applies a portrait with text fields, keeping a studio copy', async () => {
    const project = await createProject('头像项目'), ip = await createIpProfile({ name: '带头像' });
    await bindProjectIp(project.id, ip.id);
    const mediaId = await image(project.id), run = await begin(project.id);
    const call = await paused(run, 'ip_update', { id: ip.id, expectedRevision: 1, patch: { positioning: '山里的信', avatarMediaId: mediaId } });
    expect(call.preview?.changes.join('\n')).toContain('头像');
    await resolveAgentToolApproval(run.id, call.id, 'approve');
    await resumeChatRun(run.id, connector.apiKey, new AbortController(), vi.fn(async () => answer()), IP_TOOLS);
    const saved = (await db.ipProfiles.get(ip.id))!;
    expect(saved.positioning).toBe('山里的信');
    expect((await db.media.get(saved.avatarMediaId!))?.projectId).toBe('studio');
    expect(saved.revision).toBe(3);
  });
  it('refuses an image from a project the conversation is not bound to', async () => {
    const project = await createProject('绑定项目'), other = await createProject('别的项目'), ip = await createIpProfile({ name: '越界' });
    await bindProjectIp(project.id, ip.id);
    const run = await begin(project.id), foreign = await image(other.id);
    await expect(tool('ip_update').prepare!({ id: ip.id, expectedRevision: 1, patch: { avatarMediaId: foreign } }, context(run))).rejects.toThrow('当前项目');
  });
});
