import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeAll, describe, expect, it, vi} from 'vitest';
import type {ResourceGrantRequest} from '@momoki/agent-core';
import type {TodoRun, TodoCall, TodoResourceFact, Faults} from '../examples/agent-todo/src/types.js';
import type {TodoStore as Store} from '../examples/agent-todo/src/store.js';

const [major, minor] = process.versions.node.split('.').map(Number);
const hasSQLite = major > 24 || major === 24 && minor >= 11;
let api: typeof import('../examples/agent-todo/src/host.js');
let storage: typeof import('../examples/agent-todo/src/store.js');
let core: typeof import('@momoki/agent-core');

// The ordinary Node22 lane discovers this file without importing node:sqlite.
// The dedicated source config requires Node24.11+ before any tests may run.
describe.skipIf(!hasSQLite)('Node24 SQLite actual independent Todo source host', () => {
    beforeAll(async () => {
        [api, storage, core] = await Promise.all([import('../examples/agent-todo/src/host.js'), import('../examples/agent-todo/src/store.js'), import('@momoki/agent-core')]);
    });
    async function fixture(faults: Faults = {}, install = true) {
        const directory = await mkdtemp(join(tmpdir(), 'momoki-todo-source-'));
        let store = new storage.TodoStore(join(directory, 'todo.sqlite'), faults);
        if (install) store.installCreateCapability();
        let effects = 0;
        const watch = () => {
            const prepare = store.db.prepare.bind(store.db);
            vi.spyOn(store.db, 'prepare').mockImplementation(sql => {if (/^INSERT INTO todos\b/.test(sql)) effects++; return prepare(sql);});
        };
        watch();
        return {
            get store() {return store;}, effects: () => effects,
            reopen() {store.close(); store = new storage.TodoStore(join(directory, 'todo.sqlite')); watch(); return store;},
            async cleanup() {store.close(); vi.restoreAllMocks(); await rm(directory, {recursive: true, force: true});},
        };
    }
    function begin(store: Store, permission: 'ask' | 'assist' | 'full' = 'ask', scope = 'list-a') {
        const run = store.begin(scope, 'todo', permission); const grant = store.issueCreateAuthority(run.id); return {run, grant};
    }
    function noEffect(store: Store, run: TodoRun, effects: () => number) {
        expect(store.list(run.scope)).toEqual([]); expect(effects()).toBe(0);
        expect(store.db.prepare('SELECT count(*) AS n FROM todo_evidence').get()?.n).toBe(0);
    }
    async function waiting(store: Store, run: TodoRun) {
        await api.execute(store, run);
        expect(store.current(run.id).status).toBe('waiting_approval');
        const call = store.calls(run.id)[0]; expect(call.status).toBe('awaiting_approval'); return call;
    }
    function approve(store: Store, run: TodoRun, call: TodoCall) {store.decide(run.id, call.id, storage.encode(call), true);}

    it('public registration plus exact host-issued preview/approval/claim/atomic facts commit one business/evidence/completion', async () => {
        const f = await fixture(); try {
            const {run, grant} = begin(f.store); const call = await waiting(f.store, run);
            const expected = call.preview!.authority!;
            expect(call.binding).toEqual(run.createBinding);
            expect(expected).toEqual({version: 1, subject: {runId: run.id, callId: call.id, scopeId: run.scope}, binding: run.createBinding,
                facts: [{kind: 'todo-list', listId: run.scope, action: 'create'}], grants: [{id: grant.id, revision: grant.revision}]});
            noEffect(f.store, run, f.effects);
            approve(f.store, run, call); await api.execute(f.store, f.store.resume(run.id));
            expect(f.effects()).toBe(1); expect(f.store.list(run.scope)).toEqual([{id: call.id, title: 'Independent todo', done: false}]);
            expect(f.store.call(call.id)).toMatchObject({status: 'completed', appended: true, arguments: call.arguments, preview: call.preview, binding: call.binding});
            const evidence = JSON.parse(String(f.store.db.prepare('SELECT data FROM todo_evidence').get()?.data));
            expect(evidence).toMatchObject({callId: call.id, scope: run.scope, binding: run.createBinding, authority: expected});
            expect(f.store.current(run.id).responseItems.filter(item => item.type === 'function_call_output')).toHaveLength(1);
        } finally {await f.cleanup();}
    });

    it.each(['missing-installation', 'missing-grant', 'foreign-grant'] as const)('default denies %s even in full mode without minting in prepare', async kind => {
        const f = await fixture({}, kind !== 'missing-installation'); try {
            const run = f.store.begin('list-a', 'todo', 'full');
            if (kind === 'foreign-grant') {const other = f.store.begin('list-b', 'todo', 'full'); f.store.issueCreateAuthority(other.id);}
            const count = f.store.db.prepare('SELECT count(*) AS n FROM todo_authorities').get()?.n;
            await api.execute(f.store, run); noEffect(f.store, run, f.effects);
            expect(f.store.calls(run.id)[0].status).toBe('failed');
            expect(f.store.db.prepare('SELECT count(*) AS n FROM todo_authorities').get()?.n).toBe(count);
        } finally {await f.cleanup();}
    });

    it('same-process file reopen keeps the exact installation, authority and approval; reopening alone makes no request', async () => {
        const f = await fixture(); try {
            const {run, grant} = begin(f.store); const call = await waiting(f.store, run);
            const reopened = f.reopen(), recovered = reopened.recover(run.id);
            expect(recovered.requestCount).toBe(1); expect(recovered.createBinding).toEqual(run.createBinding);
            expect(reopened.authority(grant.id)).toEqual(grant); expect(reopened.call(call.id)).toEqual(call);
            approve(reopened, recovered, call); await api.execute(reopened, reopened.resume(run.id));
            expect(f.effects()).toBe(1); expect(reopened.current(run.id).requestCount).toBe(2);
            expect(reopened.call(call.id)?.preview).toEqual(call.preview);
        } finally {await f.cleanup();}
    });

    it.each(['revoked', 'stale-revision', 'foreign-subject', 'foreign-fact', 'foreign-reference', 'replaced-installation', 'disposed-installation'] as const)('transactional approval rejects %s with zero effects', async kind => {
        const f = await fixture(); try {
            const {run, grant} = begin(f.store), call = await waiting(f.store, run);
            if (kind === 'revoked') f.store.revokeAuthority(grant.id);
            if (kind === 'stale-revision') {const revised = {...grant, revision: 2}; f.store.db.prepare('UPDATE todo_authorities SET data=? WHERE id=?').run(storage.encode(revised), grant.id);}
            if (kind === 'replaced-installation') f.store.installCreateCapability();
            if (kind === 'disposed-installation') f.store.disposeCreateCapability(run.createBinding!);
            if (kind === 'foreign-subject') call.preview!.authority = {...call.preview!.authority!, subject: {...call.preview!.authority!.subject, runId: 'other-run'}};
            if (kind === 'foreign-fact') call.preview!.authority = {...call.preview!.authority!, facts: [{kind: 'todo-list', listId: 'list-b', action: 'create'}]};
            if (kind === 'foreign-reference') {
                const other = begin(f.store, 'ask', 'list-b');
                call.preview!.authority = {...call.preview!.authority!, grants: [{id: other.grant.id, revision: other.grant.revision}]};
            }
            if (kind.startsWith('foreign-')) f.store.saveCall(call);
            expect(() => approve(f.store, run, f.store.call(call.id)!)).toThrow(); noEffect(f.store, run, f.effects);
            expect(f.store.call(call.id)?.status).toBe('awaiting_approval');
            // Rejection remains available when authority is no longer executable.
            const saved = f.store.call(call.id)!; f.store.decide(run.id, call.id, storage.encode(saved), false);
            expect(f.store.call(call.id)?.status).toBe('rejected');
        } finally {await f.cleanup();}
    });

    it('a copied root reference cannot authorize another run; only an explicit subset child retains live ancestry', async () => {
        const f = await fixture(); try {
            const parent = begin(f.store);
            f.store.settle(parent.run.id, 'completed', {content: 'trusted parent setup done'});
            const child = f.store.begin(parent.run.scope, 'todo');
            expect(() => f.store.deriveCreateAuthority({id: parent.grant.id, revision: 999}, child.id)).toThrow();
            const other = f.store.begin('list-b', 'todo');
            expect(() => f.store.deriveCreateAuthority(parent.grant, other.id)).toThrow(/widen/);
            expect(() => f.store.deriveCreateAuthority(parent.grant, child.id, [{kind: 'todo-list', listId: 'list-b', action: 'create'}])).toThrow(/widen/);
            const derived = f.store.deriveCreateAuthority(parent.grant, child.id);
            const call = await waiting(f.store, child);
            expect(call.preview?.authority?.grants).toEqual([{id: derived.id, revision: 1}, {id: parent.grant.id, revision: 1}]);
            const forged = {...call, preview: {...call.preview!, authority: {...call.preview!.authority!, grants: [{id: parent.grant.id, revision: 1}]}}};
            f.store.saveCall(forged); expect(() => approve(f.store, child, forged)).toThrow(/Foreign/); f.store.saveCall(call);
            f.store.revokeAuthority(parent.grant.id);
            expect(() => approve(f.store, child, call)).toThrow(/ancestry|revoked/i);
            noEffect(f.store, child, f.effects);
        } finally {await f.cleanup();}
    });

    it('explicit subset child grants can execute, while empty subsets never acquire create', async () => {
        const f = await fixture(); try {
            const parent = begin(f.store); f.store.settle(parent.run.id, 'completed', {content: ''});
            const child = f.store.begin(parent.run.scope, 'todo', 'full'); f.store.deriveCreateAuthority(parent.grant, child.id);
            await api.execute(f.store, child); expect(f.effects()).toBe(1);
            const next = f.store.begin(parent.run.scope, 'todo', 'full'); f.store.deriveCreateAuthority(parent.grant, next.id, []);
            await api.execute(f.store, next); expect(f.effects()).toBe(1); expect(f.store.calls(next.id)[0].status).toBe('failed');
        } finally {await f.cleanup();}
    });

    it('a new explicit root can authorize a new call after child ancestry revocation without repairing the old preview', async () => {
        const f = await fixture(); try {
            const parent = begin(f.store); f.store.settle(parent.run.id, 'completed', {content: ''});
            const run = f.store.begin(parent.run.scope, 'todo'); f.store.deriveCreateAuthority(parent.grant, run.id);
            const oldCall = await waiting(f.store, run); f.store.revokeAuthority(parent.grant.id);
            const replacement = f.store.issueCreateAuthority(run.id);
            expect(() => approve(f.store, run, oldCall)).toThrow();
            f.store.decide(run.id, oldCall.id, storage.encode(oldCall), false);
            const resumed = f.store.resume(run.id), host = api.createHost(f.store, resumed), request = host.request;
            host.request = async (...args) => {
                if (args[0].modelStep === 2) {
                    const id = `${run.id}:fresh-explicit`, arguments_ = '{"title":"New explicit call"}';
                    return {ok: true, content: '', toolCalls: [{id, type: 'function', function: {name: 'create_todo', arguments: arguments_}}],
                        continuation: [{type: 'function_call', call_id: id, name: 'create_todo', arguments: arguments_}]};
                }
                return request(...args);
            };
            await core.executeRun(resumed, new AbortController(), host);
            const fresh = f.store.calls(run.id)[1];
            expect(fresh.status).toBe('awaiting_approval');
            expect(fresh.preview?.authority?.grants).toEqual([{id: replacement.id, revision: 1}]);
            expect(f.store.call(oldCall.id)?.preview).toEqual(oldCall.preview);
            approve(f.store, run, fresh); await api.execute(f.store, f.store.resume(run.id));
            expect(f.effects()).toBe(1); expect(f.store.list(run.scope)[0].title).toBe('New explicit call');
        } finally {await f.cleanup();}
    });

    it.each(['revocation-before-claim', 'replacement-before-claim', 'revocation-in-atomic', 'call-change-in-atomic'] as const)('actual claim and final SQL boundary reject %s', async race => {
        const f = await fixture(); try {
            const {run, grant} = begin(f.store), call = await waiting(f.store, run); approve(f.store, run, call);
            const resumed = f.store.resume(run.id), host = api.createHost(f.store, resumed);
            if (race.endsWith('before-claim')) {
                const transition = host.tools.transition;
                host.tools.transition = (...args) => {
                    if (args[3] === 'running') {if (race.startsWith('revocation')) f.store.revokeAuthority(grant.id); else f.store.installCreateCapability();}
                    return transition(...args);
                };
            } else {
                let atomic = false;
                const originalAtomic = f.store.atomic.bind(f.store), transaction = f.store.transaction.bind(f.store);
                vi.spyOn(f.store, 'atomic').mockImplementation((...args) => {atomic = true; try {return originalAtomic(...args);} finally {atomic = false;}});
                vi.spyOn(f.store, 'transaction').mockImplementation(operation => transaction(() => {
                    if (atomic) {
                        if (race === 'revocation-in-atomic') f.store.db.prepare('UPDATE todo_authorities SET data=? WHERE id=?').run(storage.encode({...grant, revoked: true, revision: 2}), grant.id);
                        else {const current = f.store.call(call.id)!; current.arguments = '{"title":"late different title"}'; f.store.saveCall(current);}
                    }
                    return operation();
                }));
            }
            await core.executeRun(resumed, new AbortController(), host);
            noEffect(f.store, run, f.effects); expect(f.store.calls(run.id)[0].status).not.toBe('completed');
            if (race.endsWith('atomic')) expect(f.store.calls(run.id)[0].result).toContain('rolled_back');
        } finally {await f.cleanup();}
    });

    it('an in-flight model offer and an already approved call never rebind to a replacement generation', async () => {
        for (const phase of ['model', 'approval'] as const) {
            const f = await fixture(); try {
                const {run} = begin(f.store, phase === 'model' ? 'full' : 'ask');
                const host = api.createHost(f.store, run);
                if (phase === 'model') {
                    const request = host.request; let offeredBinding: unknown;
                    host.request = async (...args) => {offeredBinding = args[3].find(tool => tool.name === 'create_todo')?.binding;
                        expect(Object.isFrozen(args[3])).toBe(true); expect(Object.isFrozen(args[3][0].parameters)).toBe(true);
                        await Promise.resolve(); f.store.installCreateCapability(); return request(...args);
                    };
                    await core.executeRun(run, new AbortController(), host);
                    expect(offeredBinding).toEqual(run.createBinding); expect(f.store.calls(run.id)[0].binding).toEqual(run.createBinding);
                } else {
                    const call = await waiting(f.store, run); approve(f.store, run, call);
                    const resumed = f.store.resume(run.id); f.store.installCreateCapability();
                    await api.execute(f.store, resumed); expect(f.store.call(call.id)?.binding).toEqual(run.createBinding);
                }
                noEffect(f.store, run, f.effects);
            } finally {await f.cleanup();}
        }
    });

    it('complete_todo and list_todos need their own host-issued action grant, even in full mode', async () => {
        const f = await fixture(); try {
            const seed = begin(f.store, 'full'); await api.execute(f.store, seed.run);
            expect(f.store.list(seed.run.scope)).toHaveLength(1);
            // A create-only root cannot complete or list.
            const creator = f.store.begin(seed.run.scope, 'update', 'full'); f.store.issueCreateAuthority(creator.id, ['create']);
            await api.execute(f.store, creator);
            const names = f.store.calls(creator.id).map(call => `${call.name}:${call.status}`);
            expect(names).toContain('create_todo:completed'); expect(names).toContain('complete_todo:failed');
            expect(f.store.list(seed.run.scope).filter(todo => todo.done)).toEqual([]);
            const reader = f.store.begin('list-r', 'budget', 'full'); f.store.issueCreateAuthority(reader.id, ['create', 'complete']);
            await api.execute(f.store, reader);
            expect(f.store.calls(reader.id).every(call => call.name === 'list_todos' && call.status === 'failed')).toBe(true);
            // Exactly the granted action succeeds and records its fact in the snapshot.
            const complete = f.store.begin('list-c', 'todo', 'full'); f.store.issueCreateAuthority(complete.id, ['create', 'complete', 'list']);
            await api.execute(f.store, complete);
            const granted = f.store.calls(complete.id)[0];
            expect(granted.preview?.authority?.facts).toEqual([{kind: 'todo-list', listId: 'list-c', action: 'create'}]);
        } finally {await f.cleanup();}
    });

    it('revoking the installation or a grant stops complete_todo and list_todos before their effects', async () => {
        for (const kind of ['grant', 'installation'] as const) {
            const f = await fixture(); try {
                const seed = begin(f.store, 'full'); await api.execute(f.store, seed.run);
                const todo = f.store.list(seed.run.scope)[0];
                const run = f.store.begin(seed.run.scope, 'update', 'full'), grant = f.store.issueCreateAuthority(run.id);
                const host = api.createHost(f.store, run), request = host.request;
                host.request = async (...args) => {
                    const result = await request(...args);
                    if (result.ok && result.toolCalls?.[0].function.name === 'complete_todo') {
                        if (kind === 'grant') f.store.revokeAuthority(grant.id); else f.store.installCreateCapability();
                    }
                    return result;
                };
                await core.executeRun(run, new AbortController(), host);
                const completes = f.store.calls(run.id).filter(call => call.name === 'complete_todo');
                expect(completes.every(call => call.status === 'failed')).toBe(true);
                expect(f.store.list(seed.run.scope).find(item => item.id === todo.id)?.done).toBe(false);
            } finally {await f.cleanup();}
        }
    });

    it.each(['filesystem', 'process', 'network', 'server'] as const)('unsupported %s policy fixture denies before the Todo effect seam', async family => {
        const f = await fixture(); try {
            const {run} = begin(f.store), call = await waiting(f.store, run);
            f.store.saveCall({...call, status: 'pending'});
            f.store.transaction(() => {const current = f.store.current(run.id); current.status = 'running'; f.store.saveRun(current);});
            // Deliberately untyped incoming resource data must fail actual host validation.
            const request: unknown = {subject: {runId: run.id, callId: call.id, scopeId: run.scope}, binding: run.createBinding!,
                facts: [{kind: family, listId: run.scope, action: 'create'}], signal: new AbortController().signal};
            expect(() => f.store.prepareCreateAuthority(request as ResourceGrantRequest<TodoResourceFact>)).toThrow(/Foreign|unsupported/);
            noEffect(f.store, run, f.effects);
        } finally {await f.cleanup();}
    });

    it.each(['ask', 'assist', 'full'] as const)('a resource grant never bypasses mandatory confirmation in %s', async permission => {
        const f = await fixture(); try {
            const {run} = begin(f.store, permission), toolsFor = f.store.toolsFor.bind(f.store);
            // Host policy fixture supplies the same code-owned flag to its actual
            // offer, approval, claim and final atomic metadata validation.
            vi.spyOn(f.store, 'toolsFor').mockImplementation(current => toolsFor(current).map(tool => tool.name === 'create_todo' ? {...tool, requiresConfirmation: true} : tool));
            const call = await waiting(f.store, run);
            expect(call.requiresConfirmation).toBe(true); expect(call.preview?.authority).toBeDefined();
            noEffect(f.store, run, f.effects);
            approve(f.store, run, call); await api.execute(f.store, f.store.resume(run.id));
            expect(f.effects()).toBe(1); expect(f.store.call(call.id)?.status).toBe('completed');
        } finally {await f.cleanup();}
    });

    it.each([{afterCommit: true}, {afterCommit: true, unreadableConfirmation: true}, {receipt: true}])('preserves atomic completion/rollback certainty under %j', async faults => {
        const f = await fixture(faults); try {
            const {run} = begin(f.store, 'full'); await api.execute(f.store, run);
            const saved = f.store.calls(run.id)[0];
            if (faults.receipt) {noEffect(f.store, run, () => f.store.list(run.scope).length); expect(saved.status).toBe('failed'); expect(saved.result).toContain('rolled_back');}
            else {expect(f.effects()).toBe(1); expect(f.store.list(run.scope)).toHaveLength(1); expect(saved.status).toBe('completed');}
            expect(() => f.store.resume(run.id)).toThrow();
            const reopened = f.reopen(); reopened.recover(run.id);
            expect(reopened.call(saved.id)?.result).toBe(saved.result); expect(f.effects()).toBe(1);
        } finally {await f.cleanup();}
    });

    it('static external unknown keeps its one durable dispatch and cannot replay after same-process reopen', async () => {
        const f = await fixture(); try {
            const run = f.store.begin('list-a', 'external', 'full'); await api.execute(f.store, run);
            expect(f.store.calls(run.id)[0].status).toBe('unknown');
            expect(f.store.db.prepare('SELECT dispatches FROM todo_intents').get()?.dispatches).toBe(1);
            const reopened = f.reopen(); reopened.recover(run.id);
            expect(() => reopened.resume(run.id)).toThrow(/Unresolved/); expect(reopened.current(run.id).requestCount).toBe(1);
            expect(reopened.db.prepare('SELECT dispatches FROM todo_intents').get()?.dispatches).toBe(1);
            expect(reopened.list(run.scope)).toEqual([]);
        } finally {await f.cleanup();}
    });
});
