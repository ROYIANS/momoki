import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {executeRun, requiresToolApproval, offeredToolNames, selectCapabilityGroups, type RuntimeEvent} from '@momoki/agent-core';
import {streamResponses, streamChatCompletions} from '@momoki/agent-providers';
import {TodoStore, encode} from './store.js';
import {execute, createHost} from './host.js';
import {registry} from './tools.js';
import {prepareContext} from './summary.js';
import type {Faults, TodoRun, TodoCall} from './types.js';

async function fixture(faults: Faults = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'momoki-todo-conformance-'));
    const store = new TodoStore(join(directory, 'todo.sqlite'), faults);
    store.installCreateCapability();
    return {directory, store, cleanup: async () => {store.close(); await rm(directory, {recursive: true, force: true});}};
}
function trustedBegin(store: TodoStore, ...args: Parameters<TodoStore['begin']>): TodoRun {
    const run = store.begin(...args); store.issueCreateAuthority(run.id); return run;
}
interface State {run: TodoRun; calls: TodoCall[]; output: {content: string}; todos: unknown[]; summaries: Array<{status: string}>}
interface Frame {ready: string; runId?: string; state?: State; run?: TodoRun; calls?: TodoCall[]; todos?: unknown[]; output?: {content: string}; summaries?: Array<{status: string}>}
function child(args: string[], env: Record<string, string> = {}) {
    const process = spawn(globalThis.process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), ...args], {env: {...globalThis.process.env, ...env}, stdio: ['pipe', 'pipe', 'pipe']});
    let output = '', error = '';
    const frames: Frame[] = [], waiters: Array<(frame: Frame) => void> = [];
    process.stdout.on('data', (chunk: Buffer) => {output += chunk.toString(); let newline: number; while ((newline = output.indexOf('\n')) >= 0) {const frame = JSON.parse(output.slice(0, newline)) as Frame; output = output.slice(newline + 1); const waiter = waiters.shift(); if (waiter) waiter(frame); else frames.push(frame);}});
    process.stderr.on('data', (chunk: Buffer) => {error += chunk.toString();});
    const exit = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolve => process.once('close', (code, signal) => resolve({code, signal})));
    return {process, exit, error: () => error, frame: () => frames.length ? Promise.resolve(frames.shift()!) : new Promise<Frame>(resolve => waiters.push(resolve))};
}
async function stop(process: ChildProcessWithoutNullStreams, exit: Promise<unknown>) {assert.equal(process.kill('SIGKILL'), true); await exit;}
async function cli(args: string[], env: Record<string, string> = {}): Promise<Frame> {
    const running = child(args, env), result = await running.exit;
    assert.equal(result.code, 0, running.error()); return running.frame();
}

await test('independent schema freezes scope/permissions and rejects duplicate begin and stale owners', async () => {
    const f = await fixture(); try {
        const run = trustedBegin(f.store, 'list-a', 'todo'); assert.throws(() => trustedBegin(f.store, 'list-a', 'todo'), /unfinished/);
        assert.equal(run.permissionMode, 'ask'); assert.equal(JSON.stringify(run).includes('apiKey'), false);
        const names = f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
        assert.deepEqual(names.sort(), ['todo_authorities', 'todo_calls', 'todo_evidence', 'todo_installations', 'todo_intents', 'todo_outputs', 'todo_runs', 'todo_summaries', 'todos']);
        f.store.transaction(() => {const current = f.store.current(run.id); current.ownerId = 'old-owner'; f.store.saveRun(current);});
        assert.throws(() => f.store.checkpoint(run.id, 1, {content: 'stale'}), /Stale owner/);
        assert.throws(() => f.store.settle(run.id, 'completed', {content: 'stale'}), /Stale owner/);
    } finally {await f.cleanup();}
});

await test('real live process ownership rejects a second process, then kernel releases it after SIGKILL', {timeout: 20_000}, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'momoki-todo-live-')), file = join(directory, 'todos.sqlite');
    const first = child(['hold', file]); try {
        assert.equal((await first.frame()).ready, 'ownership');
        const second = child(['hold', file]); assert.equal((await second.exit).code, 1); assert.match(second.error(), /live owner/);
        await stop(first.process, first.exit);
        const third = child(['hold', file]); assert.equal((await third.frame()).ready, 'ownership'); await stop(third.process, third.exit);
    } finally {if (first.process.exitCode === null && first.process.signalCode === null) await stop(first.process, first.exit); await rm(directory, {recursive: true, force: true});}
});

await test('monotonic checkpoints and the sole terminal writer retain visible output after reopen', async () => {
    const f = await fixture(); try {
        const run = trustedBegin(f.store, 'list', 'stream');
        const old = structuredClone(run), latest = f.store.current(run.id); latest.error = 'new revision'; f.store.saveRun(latest);
        assert.throws(() => f.store.saveRun(old), /Stale run revision/); assert.equal(f.store.current(run.id).error, 'new revision');
        assert.equal(f.store.checkpoint(run.id, 2, {content: 'saved'}), true);
        assert.equal(f.store.checkpoint(run.id, 1, {content: 'stale'}), false);
        assert.equal(f.store.settle(run.id, 'cancelled', {content: ''}), 'cancelled');
        assert.equal(f.store.settle(run.id, 'completed', {content: 'late'}), 'cancelled');
        assert.equal(f.store.checkpoint(run.id, 3, {content: 'late'}), false);
        assert.equal(f.store.output(run.id).content, 'saved');
    } finally {await f.cleanup();}
});

await test('two-pass approval saves all immutable calls and rejects stale decisions before any mutation', async () => {
    const f = await fixture(); try {
        const run = trustedBegin(f.store, 'list', 'pair'); await execute(f.store, run);
        const calls = f.store.calls(run.id); assert.equal(calls.length, 2); assert.equal(f.store.list('list').length, 0);
        assert.equal(f.store.current(run.id).status, 'waiting_approval');
        f.store.decide(run.id, calls[0].id, encode(calls[0]), true);
        assert.throws(() => f.store.decide(run.id, calls[0].id, encode(calls[0]), false), /Stale approval/);
        assert.throws(() => f.store.resume(run.id), /approval/);
        f.store.decide(run.id, calls[1].id, encode(calls[1]), false);
        await execute(f.store, f.store.resume(run.id));
        assert.equal(f.store.list('list').length, 1); assert.equal(f.store.call(calls[1].id)?.status, 'rejected');
        assert.equal(f.store.call(calls[0].id)?.arguments, calls[0].arguments);
        assert.equal(f.store.current(run.id).requestCount, 2);
        const tool = registry.find(tool => tool.name === 'create_todo')!;
        assert.equal(requiresToolApproval('ask', tool, {title: 'x'}), true); assert.equal(requiresToolApproval('assist', tool, {title: 'x'}), false);
    } finally {await f.cleanup();}
});

await test('actual claim transaction rejects changed args, permission and offered authority after the last core validation', async () => {
    for (const mutation of ['args', 'approval', 'offer']) {
        const f = await fixture(); try {
            const run = trustedBegin(f.store, 'list', 'todo'); await execute(f.store, run); const call = f.store.calls(run.id)[0]; f.store.decide(run.id, call.id, encode(call), true);
            const resumed = f.store.resume(run.id), host = createHost(f.store, resumed), transition = host.tools.transition;
            host.tools.transition = (run, call, from, to, extra) => {
                if (to === 'running') f.store.transaction(() => {
                    const current = f.store.current(run.id), saved = f.store.call(call.id)!;
                    if (mutation === 'args') saved.arguments = '{"title":"changed"}';
                    if (mutation === 'approval') {saved.status = 'pending'; saved.decision = undefined;}
                    if (mutation === 'offer') current.enabledToolNames = [];
                    f.store.saveCall(saved); f.store.saveRun(current);
                });
                return transition(run, call, from, to, extra);
            };
            await executeRun(resumed, new AbortController(), host); assert.equal(f.store.list('list').length, 0);
        } finally {await f.cleanup();}
    }
});

await test('local mutation, evidence and original atomic result commit once and survive acknowledgement loss', async () => {
    const f = await fixture({afterCommit: true}); try {
        const run = trustedBegin(f.store, 'list', 'todo', 'full'); await execute(f.store, run);
        assert.equal(f.store.current(run.id).status, 'completed'); assert.equal(f.store.list('list').length, 1);
        assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM todo_evidence').get()?.count, 1);
        assert.equal(f.store.calls(run.id)[0].status, 'completed'); assert.equal(f.store.calls(run.id)[0].appended, true);
        assert.equal(f.store.current(run.id).responseItems.filter(item => item.type === 'function_call_output').length, 1);
    } finally {await f.cleanup();}
});

await test('result/receipt serialization failures roll back every business and evidence write', async () => {
    for (const faults of [{result: 'oversize'}, {result: 'nonserializable'}, {receipt: true}] as Faults[]) {
        const f = await fixture(faults); try {
            const run = trustedBegin(f.store, 'list', 'todo', 'full'); await execute(f.store, run);
            assert.equal(f.store.list('list').length, 0); assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM todo_evidence').get()?.count, 0);
            assert.equal(f.store.calls(run.id)[0].status, 'failed'); assert.match(f.store.calls(run.id)[0].result ?? '', /rolled_back/);
        } finally {await f.cleanup();}
    }
});

await test('unreadable completion cannot authorize a duplicate effect, while later durable success remains intact', async () => {
    const f = await fixture({afterCommit: true, unreadableConfirmation: true}); try {
        const run = trustedBegin(f.store, 'list', 'todo', 'full'); await execute(f.store, run);
        assert.equal(f.store.list('list').length, 1); assert.equal(f.store.calls(run.id)[0].status, 'completed');
        assert.throws(() => f.store.resume(run.id), /not resumable/); assert.equal(f.store.current(run.id).requestCount, 1);
    } finally {await f.cleanup();}
});

await test('external intent is durable before one dispatch and unknown outcomes cannot replay on recovery/resume', async () => {
    const f = await fixture(); try {
        const run = trustedBegin(f.store, 'list', 'external', 'full'); await execute(f.store, run);
        assert.equal(f.store.calls(run.id)[0].status, 'unknown');
        assert.deepEqual(f.store.db.prepare('SELECT dispatches,status FROM todo_intents').get(), Object.assign(Object.create(null), {dispatches: 1, status: 'unknown'}));
        f.store.recover(run.id); assert.throws(() => f.store.resume(run.id), /Unresolved/);
        assert.equal(f.store.current(run.id).requestCount, 1); assert.equal(f.store.db.prepare('SELECT dispatches FROM todo_intents').get()?.dispatches, 1);
    } finally {await f.cleanup();}
});

await test('abort immediately before local COMMIT rolls back; partial stream flushes before cancellation', async () => {
    const controller = new AbortController(), f = await fixture({abortBeforeCommit: () => controller.abort()}); try {
        const run = trustedBegin(f.store, 'list', 'todo', 'full'); await execute(f.store, run, controller);
        assert.equal(f.store.list('list').length, 0); assert.equal(f.store.calls(run.id)[0].status, 'failed');
        const other = trustedBegin(f.store, 'other', 'stream'), stop = new AbortController();
        await execute(f.store, other, stop, {hold: () => {stop.abort(); return Promise.reject(new Error('Stop'));}});
        assert.equal(f.store.output(other.id).content, 'durable partial answer'); assert.equal(f.store.current(other.id).status, 'cancelled');
    } finally {await f.cleanup();}
});

await test('actual durable checkpoint handshake then SIGKILL/reopen performs zero work until explicit resume', {timeout: 20_000}, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'momoki-todo-restart-')), file = join(directory, 'todo.sqlite');
    const running = child(['begin', file, 'restart'], {TODO_HOLD: 'checkpoint'});
    try {
        const saved = await running.frame(); assert.equal(saved.ready, 'checkpoint'); assert.ok(saved.state!.run.checkpoint > 0); assert.equal(saved.state!.output.content, 'durable partial answer');
        const id = saved.runId!; await stop(running.process, running.exit);
        const reopened = await cli(['open', file, id]); assert.equal(reopened.run?.status, 'interrupted'); assert.equal(reopened.run?.requestCount, 1); assert.equal(reopened.todos?.length, 0); assert.equal(reopened.output?.content, 'durable partial answer');
        const waiting = await cli(['resume', file, id]); assert.equal(waiting.run?.status, 'waiting_approval'); assert.equal(waiting.run?.requestCount, 2);
        const call = waiting.calls![0]; assert.equal(call.arguments, '{"title":"Independent todo"}');
        const decision = await cli(['approve', file, id, call.id]); assert.equal(decision.run?.requestCount, 2); assert.equal(decision.todos?.length, 0);
        const finished = await cli(['resume', file, id]); assert.equal(finished.run?.status, 'completed'); assert.equal(finished.todos?.length, 1); assert.equal(finished.run?.requestCount, 3);
    } finally {if (running.process.exitCode === null && running.process.signalCode === null) await stop(running.process, running.exit); await rm(directory, {recursive: true, force: true});}
});

await test('32-request segment persists its cumulative budget and only explicit next segment replenishes', async () => {
    const f = await fixture(); try {
        const run = trustedBegin(f.store, 'list', 'budget', 'full'); await execute(f.store, run);
        assert.equal(f.store.current(run.id).modelStep, 32); assert.equal(f.store.current(run.id).requestCount, 32); assert.equal(f.store.current(run.id).status, 'interrupted');
        assert.throws(() => f.store.resume(run.id), /next segment/); assert.equal(f.store.recover(run.id).modelStep, 32);
        const next = f.store.resume(run.id, true); assert.equal(next.modelStepSegmentStart, 32); assert.equal(next.modelStep, 32);
    } finally {await f.cleanup();}
});

await test('shared capability loading persists the ceiling, pins pending calls and excludes newly offered same-round tools', async () => {
    const f = await fixture(); try {
        const run = trustedBegin(f.store, 'list', 'load', 'full'); await execute(f.store, run);
        assert.equal(f.store.current(run.id).status, 'completed'); assert.equal(f.store.list('list').length, 1);
        const current = f.store.current(run.id); assert.equal(current.toolLoading?.loadedGroupIds.includes('write'), true);
        assert.equal(current.offeredTools[0].names.includes('create_todo'), false); assert.equal(current.offeredTools[1].names.includes('create_todo'), true);
        assert.throws(() => selectCapabilityGroups(current.toolLoading!, ['disabled'], [], current.enabledToolNames));
        const pinned = selectCapabilityGroups(current.toolLoading, ['read'], [{name: 'create_todo', status: 'approved'}], current.enabledToolNames);
        assert.equal(pinned.loadedToolNames.includes('create_todo'), true); assert.ok(offeredToolNames({...current, toolLoading: pinned}).includes('create_todo'));
    } finally {await f.cleanup();}
});

await test('summary job is durable before summarization, kill/reopen performs zero startup requests and explicit resume activates once', {timeout: 20_000}, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'momoki-todo-summary-')), file = join(directory, 'todo.sqlite');
    const running = child(['begin', file, 'summary'], {TODO_HOLD: 'summary'}); try {
        const frame = await running.frame(); assert.equal(frame.ready, 'summary'); assert.equal(frame.state?.summaries[0].status, 'running'); assert.equal(frame.state?.run.summaryRequests, 1); assert.equal(frame.state?.run.requestCount, 0);
        const id = frame.runId!; await stop(running.process, running.exit);
        const reopened = await cli(['open', file, id]); assert.equal(reopened.run?.summaryRequests, 1); assert.equal(reopened.run?.requestCount, 0); assert.equal(reopened.summaries?.[0].status, 'interrupted');
        const finished = await cli(['resume', file, id]); assert.equal(finished.run?.status, 'completed'); assert.equal(finished.run?.summaryRequests, 2); assert.equal(finished.run?.requestCount, 1); assert.equal(finished.summaries?.filter(summary => summary.status === 'completed').length, 1);
    } finally {if (running.process.exitCode === null && running.process.signalCode === null) await stop(running.process, running.exit); await rm(directory, {recursive: true, force: true});}
});

await test('typed scope rejects foreign todo mutation and ownership rejects reentry/expired execution', async () => {
    const f = await fixture(); try {
        const run = trustedBegin(f.store, 'list', 'stream', 'full');
        let release!: () => void; const blocked = new Promise<void>(resolve => {release = resolve;});
        const execution = execute(f.store, run, new AbortController(), {hold: () => blocked});
        assert.throws(() => f.store.close(), /still active/); assert.throws(() => new TodoStore(f.store.file), /live owner/);
        // A held execution entry rejects concurrent reuse even if its first await has not finished.
        await assert.rejects(execute(f.store, run), /already active/); release(); await execution;
        const seed = trustedBegin(f.store, 'seed', 'todo', 'full'); await execute(f.store, seed);
        const other = trustedBegin(f.store, 'other', 'todo', 'full'), foreign = f.store.list('seed')[0], foreignCallId = `${other.id}:foreign`;
        const foreignCall: TodoCall = {id: foreignCallId, runId: other.id, name: 'complete_todo', arguments: JSON.stringify({id: foreign.id}), status: 'running', step: 1, order: 0, effect: 'write', atomic: true, highRisk: false};
        f.store.db.prepare('INSERT INTO todo_calls VALUES(?,?,?)').run(foreignCall.id, other.id, encode(foreignCall));
        assert.throws(() => f.store.mutate(other.id, foreignCall.id, new AbortController().signal, {kind: 'complete', id: foreign.id}), /rolled back/);
        assert.equal(f.store.list('seed')[0].done, false); assert.equal(f.store.call(foreignCall.id)?.status, 'running');
        const host = createHost(f.store, other); f.store.close(); assert.throws(() => host.ownership.assertHeld(), /expired/);
        // close happened deliberately to verify the capability lifetime.
        await rm(f.directory, {recursive: true, force: true});
    } catch (cause) {try {await f.cleanup();} catch { /* Preserve original test failure after explicit close. */ } throw cause;}
});

await test('packed protocols dispatch deterministic fixtures with exact opaque continuation and no secret events', async () => {
    const secret = 'private-example-key', opaque = ' encrypted\r\n exact=+ ';
    let count = 0;
    const response = await streamResponses({baseUrl: 'https://fixture.invalid/v1', apiKey: secret, model: 'fixture', maxOutputTokens: 128, messages: [{role: 'user', content: 'fixture'}]}, {fetchImpl: () => {count++; return Promise.resolve(Response.json({status: 'completed', output: [{type: 'reasoning', encrypted_content: opaque, summary: []}, {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'done'}]}]}));}});
    assert.equal(response.ok, true); if (!response.ok) throw new Error('Fixture failed'); assert.equal(response.responseOutput?.[0].type, 'reasoning'); assert.equal(response.responseOutput?.[0].type === 'reasoning' && response.responseOutput[0].encrypted_content, opaque);
    const chat = await streamChatCompletions({baseUrl: 'https://fixture.invalid/v1', apiKey: secret, model: 'fixture', maxOutputTokens: 128, messages: [{role: 'user', content: 'fixture'}]}, {fetchImpl: () => Promise.reject(new Error(`Authorization Bearer ${secret}`))});
    assert.equal(chat.ok, false); assert.equal(JSON.stringify(chat).includes(secret), false); assert.equal(count, 1);
    const f = await fixture(); try {const events: RuntimeEvent[] = [], run = trustedBegin(f.store, 'list', 'todo', 'full'); await execute(f.store, run, new AbortController(), {observe: event => events.push(event)}); assert.equal(JSON.stringify(events).includes('opaque exact'), false); assert.deepEqual(events.map(event => event.sequence), events.map((_event, i) => i + 1)); assert.equal(events.at(-1)?.type, 'settled');} finally {await f.cleanup();}
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {dependencies: Record<string, string>}; assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@momoki/agent-core', '@momoki/agent-providers']);
});


await test('a later run in the same scope creates and completes its own todo with exact original wire bytes', async () => {
    const f = await fixture(); try {
        const first = trustedBegin(f.store, 'list', 'todo', 'full'); await execute(f.store, first);
        const run = trustedBegin(f.store, 'list', 'update', 'full'), host = createHost(f.store, run), request = host.request;
        host.request = async (...args) => {const result = await request(...args); if (result.ok && result.toolCalls?.[0].function.name === 'create_todo') {
            result.toolCalls[0].function.arguments = '{ "title" : "spaced wire" }';
            const item = result.continuation?.find(item => item.type === 'function_call'); if (item?.type === 'function_call') item.arguments = result.toolCalls[0].function.arguments;
        } return result;};
        await executeRun(run, new AbortController(), host);
        assert.equal(f.store.current(run.id).status, 'completed'); assert.equal(f.store.calls(run.id)[0].arguments, '{ "title" : "spaced wire" }');
        assert.equal(f.store.list('list').length, 2); assert.equal(f.store.list('list').filter(todo => todo.done).length, 1);
        assert.equal(new Set([...f.store.calls(first.id), ...f.store.calls(run.id)].map(call => call.id)).size, 3);
    } finally {await f.cleanup();}
});

await test('summary activation refuses a changed durable job and retains an exact opaque suffix on valid activation', async () => {
    const f = await fixture(); try {
        const invalid = trustedBegin(f.store, 'invalid', 'summary', 'full');
        f.store.faults.beforeSummaryActivation = () => {const summary = f.store.summaries(invalid.id)[0]; f.store.saveSummary({...summary, status: 'interrupted'}); return Promise.resolve();};
        await assert.rejects(prepareContext(f.store, invalid, new AbortController().signal), /Stale summary job/);
        assert.equal(f.store.current(invalid.id).summaryId, undefined); assert.equal(f.store.current(invalid.id).requestCount, 0);
        f.store.faults.beforeSummaryActivation = undefined;
        const valid = trustedBegin(f.store, 'valid', 'summary', 'full'), opaque = {type: 'reasoning' as const, encrypted_content: ' opaque exact\n=+ ', summary: []};
        valid.responseItems = [opaque]; f.store.saveRun(valid);
        const activated = await prepareContext(f.store, valid, new AbortController().signal);
        assert.deepEqual(activated.responseItems.at(-1), opaque); const summary = f.store.summaries(valid.id)[0]; assert.equal(summary.status, 'completed');
        assert.throws(() => f.store.saveSummary({...summary, status: 'failed'}), /already completed/);
    } finally {await f.cleanup();}
});


await test('SIGKILL after a completed tool and durable checkpoint reuses the saved result without another mutation', {timeout: 20_000}, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'momoki-todo-committed-')), file = join(directory, 'todo.sqlite');
    const running = child(['begin', file, 'committed'], {TODO_HOLD: 'checkpoint', TODO_PERMISSION: 'full'}); try {
        const frame = await running.frame(); assert.equal(frame.ready, 'checkpoint'); assert.equal(frame.state?.calls[0].status, 'completed'); assert.equal(frame.state?.todos.length, 1); assert.ok(frame.state.run.checkpoint > 0);
        const saved = frame.state.calls[0], id = frame.runId!; await stop(running.process, running.exit);
        const reopened = await cli(['open', file, id]); assert.equal(reopened.run?.requestCount, 2); assert.equal(reopened.calls?.[0].result, saved.result); assert.equal(reopened.todos?.length, 1); assert.equal(reopened.output?.content, 'durable partial answer');
        const completed = await cli(['resume', file, id]); assert.equal(completed.run?.status, 'completed'); assert.equal(completed.run?.requestCount, 3); assert.equal(completed.calls?.[0].result, saved.result); assert.equal(completed.todos?.length, 1);
        assert.equal(completed.run?.responseItems.filter(item => item.type === 'function_call_output').length, 1);
    } finally {if (running.process.exitCode === null && running.process.signalCode === null) await stop(running.process, running.exit); await rm(directory, {recursive: true, force: true});}
});
