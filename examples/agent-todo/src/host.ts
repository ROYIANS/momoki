import {randomUUID} from 'node:crypto';
import {executeRun, modelStepLimitReached, offeredToolNames, offeredToolNamesForCall, requiresToolApproval, toolMetadataMatches, type RuntimeHost, type RuntimeEvent, type AgentWireToolCall, type ResourceGrantPort} from '@momoki/agent-core';
import {responseRoundMatches, type ResponseItem} from '@momoki/agent-providers';
import {TodoStore, encode} from './store.js';
import {actionOf, validate} from './tools.js';
import {prepareContext} from './summary.js';
import {RolledBackError, UnknownOutcomeError, type Preview, type TodoContext, type TodoRun, type TodoCall, type TodoResourceFact} from './types.js';

type Host = RuntimeHost<TodoRun, TodoCall, TodoContext, Preview, ResponseItem[]>;
export interface ExecutionOptions {observe?: (event: RuntimeEvent) => void; onRequest?: (step: number) => void; hold?: (kind: 'checkpoint' | 'summary') => Promise<void>}
const clone = <T>(value: T): T => structuredClone(value);
const callWire = (name: string, id: string, args: unknown): AgentWireToolCall => ({id, type: 'function', function: {name, arguments: JSON.stringify(args)}});
function fingerprint(call: TodoCall): string {return encode({...call, result: undefined, error: undefined, appended: undefined});}

export function createHost(store: TodoStore, initial: TodoRun, options: ExecutionOptions = {}): Host {
    const registry = store.toolsFor(initial);
    const validateBound = (name: string, raw: string, offered: readonly string[]) => validate(name, raw, offered, registry);
    const update = <T>(operation: (run: TodoRun) => T) => store.transaction(() => operation(store.current(initial.id)));
    const current = () => store.current(initial.id);
    const resources: ResourceGrantPort<TodoResourceFact> = {
        prepare: request => Promise.resolve(store.prepareCreateAuthority(request)),
        assertCurrent: (expected, signal) => {store.transaction(() => {
            signal.throwIfAborted(); const run = current(), call = store.call(expected.subject.callId);
            if (!call || expected.subject.runId !== run.id) throw new Error('Foreign Todo resource subject');
            store.assertCreateAuthority(run, call, expected);
        }); return Promise.resolve();},
    };
    const context = (run: TodoRun, call: TodoCall, signal: AbortSignal, preview?: Preview): TodoContext => ({runId: run.id, threadId: run.scope, callId: call.id, signal, preview, services: {
        list: () => store.list(run.scope),
        prepare: action => {
            if (!call.binding) throw new Error('Missing Todo installation');
            return resources.prepare({subject: {runId: run.id, callId: call.id, scopeId: run.scope}, binding: call.binding,
                facts: [{kind: 'todo-list', listId: run.scope, action}], signal});
        },
        mutate: (id, signal, operation, expected) => store.mutate(run.id, id, signal, operation, expected, call),
        load: (id, groups, signal) => store.load(run.id, id, groups, signal), external: (id, signal) => store.external(run.id, id, signal),
    }});
    const host: Host = {
        executionId: randomUUID(), ownership: {assertHeld: () => {store.assertHeld(); current();}}, clock: Date.now, observe: options.observe,
        readRun: id => Promise.resolve(store.readRun(id)), readOutput: run => Promise.resolve(store.output(run.id)),
        checkpoint: (run, sequence, output) => Promise.resolve(store.checkpoint(run.id, sequence, output)),
        pauseAtLimit: run => {if (!modelStepLimitReached(current())) return Promise.resolve(false); store.settle(run.id, 'interrupted', store.output(run.id), 'Explicit next segment required'); return Promise.resolve(true);},
        prepareContext: (run, signal) => prepareContext(store, run, signal, options.hold),
        admitModelStep: (_run, limit) => Promise.resolve(update(run => {
            if (run.status !== 'running' || modelStepLimitReached(run, limit)) throw new Error('Admission denied');
            run.modelStep = (run.modelStep ?? 0) + 1; run.offeredTools.push({step: run.modelStep, names: offeredToolNames(run)}); store.saveRun(run); return clone(run);
        })),
        request: async (run, signal, delta, offeredDefinitions) => {
            // This deterministic model adapter consumes the exact core-frozen offer.
            const modelTools = offeredDefinitions.map(tool => ({type: 'function' as const, function: {name: tool.name, description: tool.description, parameters: tool.parameters}}));
            update(value => {value.requestCount++; store.saveRun(value);}); options.onRequest?.(run.modelStep!); signal.throwIfAborted();
            if (run.scenario === 'stream' || run.scenario === 'restart' || run.scenario === 'committed' && store.calls(run.id).some(call => call.status === 'completed')) {
                delta({content: 'durable partial answer'});
                // This handshake is reached only after the actual core writer saved the checkpoint.
                if (options.hold) {await options.hold('checkpoint'); signal.throwIfAborted();}
            }
            const calls = store.calls(run.id), first = calls.length === 0;
            const wire = (name: string, label: string, args: unknown) => callWire(name, `${run.id}:${label}`, args);
            let wires: AgentWireToolCall[] = [];
            if (run.scenario === 'budget') wires = [wire('list_todos', `list-${run.modelStep}`, {})];
            else if (run.scenario === 'external' && first) wires = [wire('external_notice', 'external', {})];
            else if (run.scenario === 'load') {
                if (first) wires = [wire('load_tools', 'load-write', {groups: ['write']})];
                else if (!calls.some(call => call.name === 'create_todo')) wires = [wire('create_todo', 'created', {title: 'Independent todo'})];
            } else if (first && run.scenario !== 'summary' && run.scenario !== 'stream') {
                wires = [wire('create_todo', 'created', {title: 'Independent todo'})];
                if (run.scenario === 'pair') wires.push(wire('create_todo', 'second', {title: 'Second todo'}));
            }
            if (run.scenario === 'update' && !first && !calls.some(call => call.name === 'complete_todo')) {
                const todo = store.list(run.scope)[0]; if (todo) wires = [wire('complete_todo', 'finished', {id: todo.id})];
            }
            if (!wires.length) {delta({content: 'Done'}); return {ok: true, content: 'Done'};}
            if (wires.some(call => !modelTools.some(tool => tool.function.name === call.function.name))) throw new Error('Scenario requested an unoffered tool');
            const continuation: ResponseItem[] = [{type: 'reasoning', encrypted_content: `opaque exact ${run.modelStep}\n=+`, summary: []}, ...wires.map(call => ({type: 'function_call' as const, call_id: call.id, name: call.function.name, arguments: call.function.arguments}))];
            return {ok: true, content: '', toolCalls: wires, continuation};
        },
        recordMetrics: () => Promise.resolve(), finishingCheck: () => Promise.resolve(false),
        commitRound: (run, result, details, output) => {update(value => {
            if (value.status !== 'running' || value.modelStep !== run.modelStep || !result.toolCalls || !result.continuation || !responseRoundMatches(result.continuation, result.toolCalls, true)) throw new Error('Round mismatch');
            result.toolCalls.forEach((call, i) => {
                const detail = details[i], saved: TodoCall = {id: call.id, runId: run.id, name: call.function.name, arguments: call.function.arguments, status: detail.failure ? 'failed' : 'pending', step: run.modelStep!, order: i, ...detail, ...(detail.failure ? {result: detail.failure.result, error: detail.failure.error} : {})};
                store.db.prepare('INSERT INTO todo_calls VALUES(?,?,?)').run(saved.id, run.id, encode(saved));
            });
            value.responseItems.push(...result.continuation); value.hasToolCalls = true; store.saveRun(value);
            store.db.prepare('UPDATE todo_outputs SET data=? WHERE run_id=?').run(encode(output), run.id);
        }); return Promise.resolve();},
        offeredNames: (run, step) => step === undefined ? offeredToolNames(run) : offeredToolNamesForCall(run, step),
        settle: (run, status, output, error) => Promise.resolve(store.settle(run.id, status, output, error)),
        tools: {
            registry, readRound: run => Promise.resolve(store.calls(run.id)),
            validateEnvelope: (run, calls) => {if (!responseRoundMatches(run.responseItems, calls.map(call => ({id: call.id, type: 'function' as const, function: {name: call.name, arguments: call.arguments}})), false)) throw new Error('Envelope mismatch');},
            readCall: (_run, id) => {const call = store.call(id); if (store.faults.unreadableConfirmation && call?.status === 'completed') throw new Error('Confirmation unavailable'); return Promise.resolve(call);},
            assertScope: async (run, call, signal) => {
                signal.throwIfAborted(); if (run.scope !== initial.scope || call.runId !== run.id) throw new Error('Foreign scope');
                if (actionOf(call.name)) {
                    if (!call.binding) throw new Error('Missing Todo installation');
                    store.assertInstallation(call.binding);
                    const saved = store.call(call.id);
                    if (saved?.preview?.authority) await resources.assertCurrent(saved.preview.authority, signal);
                }
            },
            assertBinding: (binding, signal) => {signal.throwIfAborted(); store.assertInstallation(binding); return Promise.resolve();},
            input: call => call, validate: validateBound, context, approval: requiresToolApproval,
            preview: (run, call, preview) => {update(value => {const saved = store.call(call.id); if (value.id !== run.id || !saved || saved.status !== 'pending' || fingerprint(saved) !== fingerprint(call)) throw new Error('Stale preview'); encode(preview);
                if (actionOf(saved.name)) {if (!preview.authority) throw new Error('Missing Todo resource preview'); store.assertCreateAuthority(value, {...saved, preview}, preview.authority);}
                saved.preview = preview; store.saveCall(saved);}); return Promise.resolve();},
            transition: (_run, call, from, to, extra) => Promise.resolve(update(run => {
                const saved = store.call(call.id); if (run.status !== 'running' || !saved || saved.runId !== run.id || !from.includes(saved.status)) return false;
                if (to === 'running') {
                    if (fingerprint(saved) !== fingerprint(call)) return false;
                    const {tool, args} = validateBound(saved.name, saved.arguments, offeredToolNamesForCall(run, saved.step));
                    if (!toolMetadataMatches(tool, args, saved) || requiresToolApproval(run.permissionMode ?? 'ask', tool, args) && saved.status !== 'approved') return false;
                    if (actionOf(saved.name)) {
                        if (!saved.preview?.authority || requiresToolApproval(run.permissionMode ?? 'ask', tool, args) && saved.decision !== 'approved') return false;
                        store.assertCreateAuthority(run, saved, saved.preview.authority);
                    }
                }
                Object.assign(saved, extra, {status: to}); store.saveCall(saved); return true;
            })),
            park: _run => {update(value => {if (value.status !== 'running') throw new Error('Cannot park terminal'); value.status = 'waiting_approval'; store.saveRun(value);}); return Promise.resolve();},
            appendResults: run => {store.append(run.id); return Promise.resolve();}, markUnknown: run => {store.markUnknown(run.id); return Promise.resolve();},
        },
        errors: {failure: (cause, certainty) => ({error: cause instanceof Error ? cause.message : 'Tool failed', certainty}), unavailable: name => new Error(`Unavailable: ${name}`), pending: cause => cause instanceof UnknownOutcomeError, pendingError: () => new UnknownOutcomeError('Pending'), rolledBack: cause => cause instanceof RolledBackError, unknown: cause => cause instanceof UnknownOutcomeError, publicMessage: cause => cause instanceof Error ? cause.message : 'Execution failed'},
    };
    return host;
}

export async function execute(store: TodoStore, run: TodoRun, controller = new AbortController(), options: ExecutionOptions = {}): Promise<void> {
    await store.withExecution(run.id, () => executeRun(run, controller, createHost(store, run, options)));
}
export function snapshot(store: TodoStore, id: string) {return {run: store.current(id), calls: store.calls(id), output: store.output(id), todos: store.list(store.current(id).scope), evidence: store.db.prepare('SELECT * FROM todo_evidence').all(), intents: store.db.prepare('SELECT * FROM todo_intents').all(), summaries: store.summaries(id)};}
