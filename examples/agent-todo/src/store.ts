import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {canSettleRun, createCapabilityLoading, modelStepLimitReached, offeredToolNames, offeredToolNamesForCall, requiresToolApproval, toolMetadataMatches, selectCapabilityGroups, type AgentRunOutput, type AgentRunStatus, type AgentPermissionMode, type ToolBindingIdentity, type ResourceGrantRequest, type ResourceGrantSnapshot, type ResourceGrantRef} from '@momoki/agent-core';
import {appendResponseToolResult} from '@momoki/agent-providers';
import {RolledBackError, UnknownOutcomeError, type Faults, type Scenario, type TodoRun, type TodoCall, type TodoSummary, type TodoAuthority, type TodoResourceFact, type TodoAction} from './types.js';
import {CREATE_CAPABILITY, CREATE_VERSION, actionOf, createTodoToolset, previewTitle, registry, validate} from './tools.js';

export function encode(value: unknown): string {
    const json = JSON.stringify(value);
    if (json === undefined || json.length > 65_536) throw new Error('Invalid or oversized result');
    return json;
}
function decode<T>(value: unknown): T {
    if (typeof value !== 'string') throw new Error('Missing durable JSON');
    return JSON.parse(value) as T;
}
const groups = [
    {id: 'read', name: 'Read todos', description: 'Read this list', instructions: 'Read only.', toolNames: ['list_todos']},
    {id: 'write', name: 'Change todos', description: 'Create or finish todos', instructions: 'Use approved changes.', toolNames: ['create_todo', 'complete_todo']},
];
const allowed = ['list_todos', 'create_todo', 'complete_todo', 'load_tools', 'external_notice'];
const sameBinding = (a: ToolBindingIdentity | undefined, b: ToolBindingIdentity | undefined) => !!a && !!b && a.capabilityId === b.capabilityId && a.version === b.version && a.registrationId === b.registrationId;
const ACTIONS: readonly TodoAction[] = ['create', 'complete', 'list'];
const factFor = (run: TodoRun, action: TodoAction = 'create'): TodoResourceFact => ({kind: 'todo-list', listId: run.scope, action});
const sameFacts = (facts: readonly TodoResourceFact[], run: TodoRun, action: TodoAction) => facts.length === 1 && encode(facts[0]) === encode(factFor(run, action));
const grantsAction = (facts: readonly TodoResourceFact[], run: TodoRun, action: TodoAction) => facts.some(fact => encode(fact) === encode(factFor(run, action)));
const callIdentity = (call: TodoCall) => encode({...call, status: undefined, result: undefined, error: undefined, appended: undefined});

/** A sidecar lifetime lock excludes actual live processes while business commits stay short. */
export class TodoStore {
    readonly ownerId = randomUUID();
    readonly db: DatabaseSync;
    private readonly coordinator: DatabaseSync;
    private held = true;
    private executing = false;
    private readonly toolsets = new Map<string, ReturnType<typeof createTodoToolset>>();
    readonly faults: Faults;
    constructor(readonly file: string, faults: Faults = {}) {
        mkdirSync(dirname(file), {recursive: true});
        this.faults = faults;
        this.coordinator = new DatabaseSync(`${file}.ownership`);
        try {this.coordinator.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');}
        catch (cause) {this.coordinator.close(); throw new Error('Scope has a live owner', {cause});}
        try {this.db = new DatabaseSync(file);
        this.db.exec(`PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS todo_runs(id TEXT PRIMARY KEY, scope TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS todo_calls(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS todo_outputs(run_id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS todos(id TEXT PRIMARY KEY, scope TEXT NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS todo_evidence(call_id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS todo_intents(call_id TEXT PRIMARY KEY, dispatches INTEGER NOT NULL, status TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS todo_summaries(id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS todo_installations(id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS todo_authorities(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL);`);
        } catch (cause) {this.coordinator.exec('ROLLBACK'); this.coordinator.close(); this.held = false; throw cause;}
    }
    assertHeld(): void {if (!this.held) throw new Error('Ownership expired');}
    async withExecution<T>(id: string, operation: () => Promise<T>): Promise<T> {
        this.current(id); if (this.executing) throw new Error('Execution already active'); this.executing = true;
        try {return await operation();} finally {this.executing = false;}
    }
    close(): void {this.assertHeld(); if (this.executing) throw new Error('Execution still active'); this.held = false; this.db.close(); this.coordinator.exec('ROLLBACK'); this.coordinator.close();}
    transaction<T>(operation: () => T): T {
        this.assertHeld(); this.db.exec('BEGIN IMMEDIATE');
        try {const result = operation(); this.assertHeld(); this.db.exec('COMMIT'); return result;}
        catch (cause) {this.db.exec('ROLLBACK'); throw cause;}
    }
    readRun(id: string): TodoRun | undefined {
        const row = this.db.prepare('SELECT data FROM todo_runs WHERE id=?').get(id);
        return row ? decode<TodoRun>(row.data) : undefined;
    }
    current(id: string): TodoRun {
        this.assertHeld(); const run = this.readRun(id);
        if (!run || run.ownerId !== this.ownerId) throw new Error('Stale owner or missing run');
        return run;
    }
    saveRun(run: TodoRun, expectedOwner: string = this.ownerId): void {
        this.assertHeld(); const next = {...run, revision: run.revision + 1};
        const saved = this.db.prepare("UPDATE todo_runs SET data=? WHERE id=? AND json_extract(data,'$.revision')=? AND json_extract(data,'$.ownerId')=?").run(JSON.stringify(next), run.id, run.revision, expectedOwner);
        if (saved.changes !== 1) throw new Error('Stale run revision or owner');
        run.revision = next.revision;
    }
    attach(id: string): TodoRun {
        return this.transaction(() => {const run = this.readRun(id); if (!run) throw new Error('Missing run'); const priorOwner = run.ownerId; run.ownerId = this.ownerId; this.saveRun(run, priorOwner); return run;});
    }
    /** Explicit trusted setup; neither begin, permissions nor prepare calls this. */
    installCreateCapability(): ToolBindingIdentity {
        return this.transaction(() => {
            for (const row of this.db.prepare('SELECT data FROM todo_installations').all()) {
                const installation = decode<{identity: ToolBindingIdentity; active: boolean}>(row.data);
                installation.active = false;
                this.db.prepare('UPDATE todo_installations SET data=? WHERE id=?').run(encode(installation), installation.identity.registrationId);
                this.toolsets.get(installation.identity.registrationId)?.dispose();
            }
            const identity: ToolBindingIdentity = {capabilityId: CREATE_CAPABILITY, version: CREATE_VERSION, registrationId: randomUUID()};
            this.db.prepare('INSERT INTO todo_installations VALUES(?,?)').run(identity.registrationId, encode({identity, active: true}));
            return Object.freeze(identity);
        });
    }
    currentInstallation(): ToolBindingIdentity | undefined {
        this.assertHeld();
        return this.db.prepare('SELECT data FROM todo_installations').all().map(row => decode<{identity: ToolBindingIdentity; active: boolean}>(row.data)).find(row => row.active)?.identity;
    }
    disposeCreateCapability(expected: ToolBindingIdentity): void {
        this.transaction(() => {
            const row = this.db.prepare('SELECT data FROM todo_installations WHERE id=?').get(expected.registrationId);
            if (!row) return;
            const installation = decode<{identity: ToolBindingIdentity; active: boolean}>(row.data);
            if (!sameBinding(installation.identity, expected)) throw new Error('Foreign installation');
            installation.active = false;
            this.db.prepare('UPDATE todo_installations SET data=? WHERE id=?').run(encode(installation), expected.registrationId);
            this.toolsets.get(expected.registrationId)?.dispose();
        });
    }
    toolsFor(run: TodoRun) {
        if (!run.createBinding) return registry;
        let set = this.toolsets.get(run.createBinding.registrationId);
        if (!set) {set = createTodoToolset(run.createBinding); this.toolsets.set(run.createBinding.registrationId, set);}
        return set.definitions;
    }
    assertInstallation(expected: ToolBindingIdentity): void {
        const row = this.db.prepare('SELECT data FROM todo_installations WHERE id=?').get(expected.registrationId);
        const installation = row ? decode<{identity: ToolBindingIdentity; active: boolean}>(row.data) : undefined;
        if (!installation?.active || !sameBinding(installation.identity, expected) || expected.capabilityId !== CREATE_CAPABILITY || expected.version !== CREATE_VERSION) throw new Error('Todo installation revoked or replaced');
        this.toolsets.get(expected.registrationId)?.assertCurrent();
    }
    /** Root issuance belongs to a trusted host, for this exact durable run/list/action. */
    issueCreateAuthority(runId: string, actions: readonly TodoAction[] = ACTIONS): TodoAuthority {
        return this.transaction(() => {
            const run = this.current(runId); if (!run.createBinding) throw new Error('Missing Todo installation');
            this.assertInstallation(run.createBinding);
            const authority: TodoAuthority = {id: randomUUID(), revision: 1, runId, scopeId: run.scope, binding: {...run.createBinding}, facts: actions.map(action => factFor(run, action)), revoked: false};
            this.db.prepare('INSERT INTO todo_authorities VALUES(?,?,?)').run(authority.id, runId, encode(authority)); return authority;
        });
    }
    authority(id: string): TodoAuthority | undefined {
        const row = this.db.prepare('SELECT data FROM todo_authorities WHERE id=?').get(id);
        return row ? decode<TodoAuthority>(row.data) : undefined;
    }
    private ancestry(leaf: TodoAuthority): TodoAuthority[] {
        const chain = [leaf], seen = new Set([leaf.id]);
        let child = leaf;
        while (true) {
            if (child.revoked || !Number.isSafeInteger(child.revision) || child.revision < 1) throw new Error('Todo authority revoked');
            if (!child.parent) return chain;
            const parent = this.authority(child.parent.id);
            if (!parent || parent.revision !== child.parent.revision || seen.has(parent.id) || chain.length >= 32 || !sameBinding(child.binding, parent.binding) || child.scopeId !== parent.scopeId || child.facts.some(fact => !parent.facts.some(allowed => encode(allowed) === encode(fact)))) throw new Error('Stale or widened Todo ancestry');
            seen.add(parent.id); chain.push(parent); child = parent;
        }
    }
    deriveCreateAuthority(parent: ResourceGrantRef, childRunId: string, facts?: readonly TodoResourceFact[]): TodoAuthority {
        return this.transaction(() => {
            const run = this.current(childRunId), source = this.authority(parent.id);
            if (!source || source.revision !== parent.revision || !run.createBinding || !sameBinding(run.createBinding, source.binding)) throw new Error('Foreign Todo parent authority');
            this.assertInstallation(run.createBinding); this.ancestry(source);
            const selected = facts ?? source.facts;
            if (selected.length > ACTIONS.length || selected.some(fact => !ACTIONS.some(action => encode(fact) === encode(factFor(run, action))) || !source.facts.some(allowed => encode(allowed) === encode(fact)))) throw new Error('Child Todo authority cannot widen its parent');
            const child: TodoAuthority = {id: randomUUID(), revision: 1, runId: childRunId, scopeId: run.scope, binding: {...run.createBinding}, facts: structuredClone(selected), parent: {...parent}, revoked: false};
            this.db.prepare('INSERT INTO todo_authorities VALUES(?,?,?)').run(child.id, childRunId, encode(child)); return child;
        });
    }
    revokeAuthority(id: string): void {
        this.transaction(() => {
            const authority = this.authority(id); if (!authority) throw new Error('Missing Todo authority');
            authority.revoked = true; authority.revision++;
            this.db.prepare('UPDATE todo_authorities SET data=? WHERE id=?').run(encode(authority), id);
        });
    }
    private assertCreateIdentity(run: TodoRun, call: TodoCall): void {
        if (call.runId !== run.id || !actionOf(call.name) || !run.createBinding || !sameBinding(call.binding, run.createBinding)) throw new Error('Foreign Todo call binding');
        this.assertInstallation(run.createBinding);
        const {tool, args} = validate(call.name, call.arguments, offeredToolNamesForCall(run, call.step), this.toolsFor(run));
        if (!toolMetadataMatches(tool, args, call)) throw new Error('Todo metadata changed');
    }
    prepareCreateAuthority(request: ResourceGrantRequest<TodoResourceFact>): ResourceGrantSnapshot<TodoResourceFact> {
        return this.transaction(() => {
            request.signal.throwIfAborted(); const run = this.current(request.subject.runId), call = this.call(request.subject.callId);
            const action = call && actionOf(call.name);
            if (!call || !action || run.status !== 'running' || call.status !== 'pending' || request.subject.scopeId !== run.scope || !sameBinding(request.binding, run.createBinding) || !sameFacts(request.facts, run, action)) throw new Error('Foreign or unsupported Todo resource');
            this.assertCreateIdentity(run, call);
            const candidates = this.db.prepare('SELECT data FROM todo_authorities WHERE run_id=?').all(run.id).map(row => decode<TodoAuthority>(row.data));
            let chain: TodoAuthority[] | undefined;
            for (const row of candidates) {
                if (row.revoked || row.scopeId !== run.scope || !sameBinding(row.binding, request.binding) || !grantsAction(row.facts, run, action)) continue;
                // A stale child cannot shadow a later explicit host issuance for
                // a new call. Existing prepared references never use this lookup.
                try {chain = this.ancestry(row); break;} catch {continue;}
            }
            if (!chain) throw new Error('Missing host-issued Todo create authority');
            return Object.freeze({version: 1 as const, subject: Object.freeze({...request.subject}), binding: Object.freeze({...request.binding}),
                facts: Object.freeze([Object.freeze(factFor(run, action))]), grants: Object.freeze(chain.map(row => Object.freeze({id: row.id, revision: row.revision})))});
        });
    }
    assertCreateAuthority(run: TodoRun, call: TodoCall, expected: ResourceGrantSnapshot<TodoResourceFact>): void {
        this.assertCreateIdentity(run, call);
        const action = actionOf(call.name)!;
        if (expected.version !== 1 || expected.subject.runId !== run.id || expected.subject.callId !== call.id || expected.subject.scopeId !== run.scope || !sameBinding(expected.binding, run.createBinding) || !sameFacts(expected.facts, run, action) || expected.grants.length < 1) throw new Error('Foreign Todo prepared resource');
        const leaf = this.authority(expected.grants[0].id);
        if (!leaf || leaf.runId !== run.id || leaf.scopeId !== run.scope || !sameBinding(leaf.binding, expected.binding) || !grantsAction(leaf.facts, run, action)) throw new Error('Foreign Todo grant reference');
        const chain = this.ancestry(leaf);
        if (encode(chain.map(row => ({id: row.id, revision: row.revision}))) !== encode(expected.grants)) throw new Error('Stale Todo grant revision');
        if (call.preview?.authority && encode(call.preview.authority) !== encode(expected)) throw new Error('Todo preview resource changed');
        const args = validate(call.name, call.arguments, offeredToolNamesForCall(run, call.step), this.toolsFor(run)).args;
        if (call.preview && call.preview.title !== previewTitle(call.name, args)) throw new Error('Todo preview arguments changed');
    }
    begin(scope: string, scenario: Scenario, permissionMode: AgentPermissionMode = 'ask', enabled = allowed): TodoRun {
        return this.transaction(() => {
            const active = this.db.prepare('SELECT data FROM todo_runs WHERE scope=?').all(scope).map(row => decode<TodoRun>(row.data)).some(run => ['running', 'waiting_approval', 'interrupted'].includes(run.status));
            if (active) throw new Error('An unfinished run already exists');
            const id = randomUUID();
            const run: TodoRun = {id, threadId: scope, scope, ownerId: this.ownerId, revision: 0, scenario, checkpoint: 0, status: 'running', permissionMode, modelStep: 0, modelStepSegmentStart: 0, enabledToolNames: [...enabled], offeredTools: [], responseItems: [], history: [], requestCount: 0, summaryRequests: 0, createBinding: this.currentInstallation()};
            if (scenario === 'load') run.toolLoading = createCapabilityLoading(groups, enabled, name => name === 'load_tools', 'load_tools', 'read');
            if (scenario === 'summary') run.history = [{id: 'old-user', role: 'user', content: 'old request '.repeat(100)}, {id: 'old-answer', role: 'assistant', content: 'old answer '.repeat(100)}, {id: 'current', role: 'user', content: 'current request'}];
            this.db.prepare('INSERT INTO todo_runs VALUES(?,?,?)').run(id, scope, JSON.stringify(run));
            this.db.prepare('INSERT INTO todo_outputs VALUES(?,?)').run(id, JSON.stringify({content: ''}));
            return run;
        });
    }
    output(id: string): AgentRunOutput {return decode<AgentRunOutput>(this.db.prepare('SELECT data FROM todo_outputs WHERE run_id=?').get(id)?.data);}
    checkpoint(id: string, sequence: number, output: AgentRunOutput): boolean {
        return this.transaction(() => {const run = this.current(id); if (run.status !== 'running' || sequence <= run.checkpoint) return false; run.checkpoint = sequence; this.saveRun(run); this.db.prepare('UPDATE todo_outputs SET data=? WHERE run_id=?').run(encode(output), id); return true;});
    }
    settle(id: string, status: Exclude<AgentRunStatus, 'running' | 'waiting_approval'>, output: AgentRunOutput, error?: string): AgentRunStatus {
        return this.transaction(() => {
            const run = this.current(id); if (!canSettleRun(run.status)) return run.status;
            run.status = status; run.error = error; this.saveRun(run);
            const prior = this.output(id);
            this.db.prepare('UPDATE todo_outputs SET data=? WHERE run_id=?').run(encode(output.content ? output : prior), id);
            return run.status;
        });
    }
    recover(id: string): TodoRun {
        const run = this.attach(id);
        this.markUnknown(id);
        this.transaction(() => {this.current(id); for (const summary of this.summaries(id)) if (summary.status === 'running') this.saveSummary({...summary, status: 'interrupted'});});
        if (run.status === 'running') this.settle(id, 'interrupted', this.output(id), 'Previous process stopped; explicit resume required');
        return this.current(id);
    }
    resume(id: string, grantSegment = false): TodoRun {
        return this.transaction(() => {
            const run = this.current(id);
            if (!['waiting_approval', 'interrupted'].includes(run.status)) throw new Error('Run is not resumable');
            if (this.calls(id).some(call => ['unknown', 'running', 'awaiting_approval'].includes(call.status))) throw new Error('Unresolved tool outcome or approval');
            if (modelStepLimitReached(run) && !grantSegment) throw new Error('Explicit next segment required');
            if (grantSegment) run.modelStepSegmentStart = run.modelStep;
            run.status = 'running'; this.saveRun(run); return run;
        });
    }
    calls(id: string): TodoCall[] {return this.db.prepare('SELECT data FROM todo_calls WHERE run_id=?').all(id).map(row => decode<TodoCall>(row.data)).sort((a, b) => a.step - b.step || a.order - b.order);}
    call(id: string): TodoCall | undefined {const row = this.db.prepare('SELECT data FROM todo_calls WHERE id=?').get(id); return row ? decode<TodoCall>(row.data) : undefined;}
    saveCall(call: TodoCall): void {this.db.prepare('UPDATE todo_calls SET data=? WHERE id=?').run(encode(call), call.id);}
    decide(id: string, callId: string, expected: string, approve: boolean): void {
        this.transaction(() => {const run = this.current(id), call = this.call(callId); if (run.status !== 'waiting_approval' || !call || call.runId !== id || call.status !== 'awaiting_approval' || encode(call) !== expected) throw new Error('Stale approval');
            if (approve && actionOf(call.name)) {if (!call.preview?.authority) throw new Error('Missing Todo resource preview'); this.assertCreateAuthority(run, call, call.preview.authority);}
            call.decision = approve ? 'approved' : 'rejected'; call.status = call.decision; if (!approve) call.result = encode({rejected: true}); this.saveCall(call);});
    }
    append(id: string): void {
        this.transaction(() => {const run = this.current(id); for (const call of this.calls(id)) {
            if (!['completed', 'failed', 'rejected'].includes(call.status) || call.result === undefined) throw new Error('Unresolved result');
            appendResponseToolResult(run.responseItems, call.id, call.result); call.appended = true; this.saveCall(call);
        } this.saveRun(run);});
    }
    markUnknown(id: string): void {
        this.transaction(() => {this.current(id); for (const call of this.calls(id)) if (call.status === 'running') {call.status = 'unknown'; this.saveCall(call);}});
    }
    list(scope: string): Array<{id: string; title: string; done: boolean}> {
        return this.db.prepare('SELECT id,title,done FROM todos WHERE scope=? ORDER BY id').all(scope).map(row => ({id: String(row.id), title: String(row.title), done: row.done === 1}));
    }
    atomic(id: string, callId: string, signal: AbortSignal, mutate: (run: TodoRun) => unknown, expected?: {call: TodoCall; authority: ResourceGrantSnapshot<TodoResourceFact>}): unknown {
        let result: unknown;
        try {result = this.transaction(() => {
            const run = this.current(id), call = this.call(callId);
            if (run.status !== 'running' || !call || call.runId !== id || call.status !== 'running') throw new Error('Stale local commit');
            if (expected || actionOf(call.name)) {
                if (!actionOf(call.name) || !expected || callIdentity(call) !== callIdentity(expected.call) || !call.preview?.authority) throw new Error('Stale Todo atomic identity');
                this.assertCreateAuthority(run, call, expected.authority);
                const {tool, args} = validate(call.name, call.arguments, offeredToolNamesForCall(run, call.step), this.toolsFor(run));
                if (requiresToolApproval(run.permissionMode ?? 'ask', tool, args) && call.decision !== 'approved') throw new Error('Todo approval missing');
            }
            signal.throwIfAborted(); const value = mutate(run);
            if (this.faults.receipt) throw new Error('Receipt rejected');
            this.db.prepare('INSERT INTO todo_evidence VALUES(?,?)').run(callId, encode({callId, scope: run.scope, changed: true, ...(expected ? {binding: call.binding, authority: expected.authority} : {})}));
            const output = this.faults.result === 'oversize' ? 'x'.repeat(65_537) : this.faults.result === 'nonserializable' ? 1n : value;
            call.result = encode(output); call.status = 'completed'; this.saveCall(call);
            this.faults.abortBeforeCommit?.(); signal.throwIfAborted(); return value;
        });} catch (cause) {throw new RolledBackError('Local transaction rolled back', {cause});}
        if (this.faults.afterCommit) throw new UnknownOutcomeError('Commit acknowledgement lost');
        return result;
    }
    mutate(id: string, callId: string, signal: AbortSignal, operation: {kind: 'create'; title: string} | {kind: 'complete'; id: string}, authority?: ResourceGrantSnapshot<TodoResourceFact>, expectedCall?: TodoCall): unknown {
        return this.atomic(id, callId, signal, run => {
            if (operation.kind === 'create') {
                const args: unknown = expectedCall ? JSON.parse(expectedCall.arguments) : undefined;
                if (!expectedCall || expectedCall.name !== 'create_todo' || !args || typeof args !== 'object' || !('title' in args) || args.title !== operation.title) throw new Error('Todo effect arguments changed');
                const todoId = callId; this.db.prepare('INSERT INTO todos VALUES(?,?,?,0)').run(todoId, run.scope, operation.title); return {id: todoId, title: operation.title, done: false};}
            const saved = this.call(callId);
            if (!expectedCall || !saved || saved.name !== 'complete_todo' || expectedCall.name !== 'complete_todo' || (JSON.parse(expectedCall.arguments) as {id?: unknown}).id !== operation.id) throw new Error('Todo effect operation changed');
            const changed = this.db.prepare('UPDATE todos SET done=1 WHERE id=? AND scope=?').run(operation.id, run.scope).changes;
            if (!changed) throw new Error('Todo outside this scope or missing'); return {id: operation.id, done: true};
        }, authority && expectedCall ? {authority, call: expectedCall} : undefined);
    }
    load(id: string, callId: string, names: string[], signal: AbortSignal): unknown {
        return this.atomic(id, callId, signal, run => {if (!run.toolLoading) throw new Error('No loading catalogue'); run.toolLoading = selectCapabilityGroups(run.toolLoading, names, this.calls(id), run.enabledToolNames); this.saveRun(run); return {loaded: offeredToolNames(run)};});
    }
    external(id: string, callId: string, signal: AbortSignal): never {
        this.transaction(() => {this.current(id); signal.throwIfAborted(); this.db.prepare('INSERT INTO todo_intents VALUES(?,0,?)').run(callId, 'intent');});
        this.transaction(() => {this.current(id); this.db.prepare('UPDATE todo_intents SET dispatches=1,status=? WHERE call_id=?').run('unknown', callId);});
        throw new UnknownOutcomeError('External dispatch acknowledgement unavailable');
    }
    summaries(id: string): TodoSummary[] {return this.db.prepare('SELECT data FROM todo_summaries').all().map(row => decode<TodoSummary>(row.data)).filter(row => row.runId === id);}
    saveSummary(summary: TodoSummary): void {this.current(summary.runId); const saved = this.summaries(summary.runId).find(item => item.id === summary.id); if (saved?.status === 'completed') throw new Error('Summary already completed'); this.db.prepare('INSERT INTO todo_summaries VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(summary.id, JSON.stringify(summary));}
}
