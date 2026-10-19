import { describe, expect, it, vi } from 'vitest';
import {createCapabilityRegistry, executeRun, type RuntimeHost, type RuntimeRun, type RuntimeCall, type ModelResult, type RuntimeEvent } from '@cuepoint/agent-core';
import type { ToolContext, ToolDefinition } from '@cuepoint/agent-core';
import type { AgentRunOutput } from '@cuepoint/agent-core';
type Run = RuntimeRun & {
    opaque?: string;
};
type Call = RuntimeCall<number>;
type Context = ToolContext<number>;
const wire = (name: string, id = name) => ({ id, type: 'function' as const, function: { name, arguments: '{}' } });
function fixture() {
    let run: Run = { id: 'run', threadId: 'thread', status: 'running', checkpoint: 0, permissionMode: 'full' };
    let output: AgentRunOutput = { content: '' };
    const calls = new Map<string, Call>(), events: RuntimeEvent[] = [], transitions: string[] = [];
    const requests: ModelResult<string>[] = [{ ok: true, content: 'done' }];
    const registry: ToolDefinition<unknown, Context, number, unknown>[] = [];
    const reads: string[] = [], contexts: string[] = [];
    let effects = 0, held = true, forcedUnknown = false;
    const host: RuntimeHost<Run, Call, Context, number, string> = {
        executionId: 'invocation-1', ownership: { assertHeld() { if (!held)
                throw new Error('lease expired'); } }, clock: () => 10, observe: event => events.push(event),
        readRun: () => Promise.resolve(({ ...run })), readOutput: () => Promise.resolve(output),
        checkpoint: (_run, sequence, value) => {
            run.checkpoint = sequence;
            output = value;
            return Promise.resolve(true);
        },
        pauseAtLimit: () => Promise.resolve(false), prepareContext: (value) => {
            contexts.push('prepare');
            return Promise.resolve(value);
        },
        admitModelStep: () => Promise.resolve(run = { ...run, modelStep: (run.modelStep ?? 0) + 1 }),
        request: (_run, _signal, onDelta) => {
            const result = requests.shift()!;
            if (result.ok)
                onDelta({ content: result.content });
            return Promise.resolve(result);
        },
        recordMetrics: () => Promise.resolve(undefined), finishingCheck: () => Promise.resolve(false),
        commitRound: (_run, result, details) => {
            run.hasToolCalls = true;
            run.opaque = result.continuation;
            result.toolCalls!.forEach((item, i) => calls.set(item.id, { id: item.id, name: item.function.name, arguments: item.function.arguments, status: details[i].failure ? 'failed' : 'pending', step: run.modelStep!, order: i, ...details[i] }));
            return Promise.resolve(undefined);
        },
        offeredNames: () => registry.map(tool => tool.name),
        settle: (_run, status, value) => {
            run.status = status;
            output = value;
            return Promise.resolve(status);
        },
        tools: {
            registry, readRound: () => Promise.resolve([...calls.values()].map(call => ({ ...call }))), validateEnvelope: () => undefined,
            readCall: (_run, id) => {
                reads.push(id);
                return Promise.resolve(calls.get(id));
            }, assertScope: () => Promise.resolve(undefined),
            input: call => call,
            validate: (name, raw) => ({ tool: registry.find(tool => tool.name === name)!, args: JSON.parse(raw) }),
            context: (_run, call, signal, preview) => ({ runId: 'run', threadId: 'thread', callId: call.id, signal, preview }),
            approval: (mode, tool, args) => !!tool.requiresConfirmation || mode !== 'full' && tool.highRisk(args),
            preview: (_run, call, preview) => {
                calls.get(call.id)!.preview = preview;
                return Promise.resolve(undefined);
            },
            transition: (_run, call, from, to, extra) => {
                const current = calls.get(call.id)!;
                if (!from.includes(current.status))
                    return Promise.resolve(false);
                current.status = to;
                Object.assign(current, extra);
                transitions.push(`${call.id}:${to}`);
                return Promise.resolve(true);
            },
            park: () => {
                run.status = 'waiting_approval';
                return Promise.resolve(undefined);
            }, appendResults: () => Promise.resolve(undefined),
            markUnknown: (_run, force) => {
                forcedUnknown ||= force;
                for (const call of calls.values())
                    if (call.status === 'running')
                        call.status = 'unknown';
                return Promise.resolve(undefined);
            }
        },
        errors: { failure: () => undefined, unavailable: () => new Error('unavailable'), pending: () => false, pendingError: () => new Error('pending'), rolledBack: () => false, unknown: () => false, publicMessage: error => String(error) }
    };
    const tool = (name: string, atomic = false): ToolDefinition<unknown, Context, number, unknown> => ({ name, title: name, description: name, parameters: {}, effect: 'write', atomic, parseArguments: value => value, highRisk: () => false, execute: () => {
            effects++;
            return Promise.resolve({ changed: true });
        } });
    return { host, run: () => run, calls, events, transitions, requests, registry, reads, contexts, tool, effects: () => effects, forcedUnknown: () => forcedUnknown, expire: () => { held = false; }, output: () => output };
}
describe('actual reusable execution loop', () => {
    it('freezes actual offered schema and callbacks before a pending model request', async () => {
        const f = fixture(), old = f.tool('write');
        old.parameters = {type: 'object', properties: {title: {type: 'string'}}};
        const oldExecute = vi.fn(old.execute), replacement = vi.fn(() => Promise.resolve('replacement'));
        old.execute = oldExecute; f.registry.push(old);
        let release!: (result: ModelResult<string>) => void;
        let started!: () => void;
        const ready = new Promise<void>(resolve => {started = resolve;});
        let modelOffer: unknown;
        const request = f.host.request;
        f.host.request = (run, signal, delta, definitions) => {
            if (run.modelStep !== 1) return request(run, signal, delta, definitions);
            modelOffer = definitions.map(tool => ({name: tool.name, parameters: tool.parameters}));
            started(); return new Promise(resolve => {release = resolve;});
        };
        const executing = executeRun(f.run(), new AbortController(), f.host);
        await ready;
        (old.parameters.properties as Record<string, unknown>).title = {type: 'number'};
        f.registry.splice(0, 1, {...old, execute: replacement});
        release({ok: true, content: '', toolCalls: [wire('write')]});
        await executing;
        expect(modelOffer).toEqual([{name: 'write', parameters: {type: 'object', properties: {title: {type: 'string'}}}}]);
        expect(oldExecute).toHaveBeenCalledOnce(); expect(replacement).not.toHaveBeenCalled();
    });
    it('fails closed for a bound call when the host has no binding check, and revokes through assertBinding alone', async () => {
        for (const checked of [false, true]) {
            const f = fixture(), registry = createCapabilityRegistry<Context, number>();
            const binding = {capabilityId: 'example/write', version: '1', registrationId: 'first'};
            const installation = registry.register({identity: binding, tools: [f.tool('write')]});
            f.registry.push(...registry.snapshot());
            if (checked) {f.host.tools.assertBinding = current => {registry.assertCurrent(current); return Promise.resolve();}; installation.dispose();}
            f.requests.unshift({ok: true, content: '', toolCalls: [wire('write')]});
            await executeRun(f.run(), new AbortController(), f.host);
            expect(f.calls.get('write')).toMatchObject({status: 'failed', binding});
            expect(f.effects()).toBe(0); expect(f.transitions).not.toContain('write:running');
        }
    });
    it('does not retarget a bound response when its installation changes while awaiting the model', async () => {
        const f = fixture(), registry = createCapabilityRegistry<Context, number>();
        const oldBinding = {capabilityId: 'example/write', version: '1', registrationId: 'old'};
        const old = registry.register({identity: oldBinding, tools: [f.tool('write')]});
        f.registry.push(...registry.snapshot());
        f.host.tools.assertBinding = binding => {registry.assertCurrent(binding); return Promise.resolve();};
        let release!: (result: ModelResult<string>) => void, started!: () => void;
        const ready = new Promise<void>(resolve => {started = resolve;});
        const request = f.host.request;
        f.host.request = (run, signal, delta, definitions) => {
            if (run.modelStep !== 1) return request(run, signal, delta, definitions);
            expect(definitions[0].binding).toEqual(oldBinding);
            started(); return new Promise(resolve => {release = resolve;});
        };
        const executing = executeRun(f.run(), new AbortController(), f.host); await ready;
        old.dispose(); registry.register({identity: {...oldBinding, registrationId: 'new'}, tools: [f.tool('write')]});
        f.registry.splice(0, f.registry.length, ...registry.snapshot());
        release({ok: true, content: '', toolCalls: [wire('write')]}); await executing;
        expect(f.calls.get('write')).toMatchObject({status: 'failed', binding: oldBinding, arguments: '{}'});
        expect(f.effects()).toBe(0); expect(f.transitions).not.toContain('write:running');
    });
    it('keeps a parked approval pinned and denies a new generation on explicit resume', async () => {
        const f = fixture(), registry = createCapabilityRegistry<Context, number>();
        const binding = {capabilityId: 'example/write', version: '1', registrationId: 'first'};
        const tool = {...f.tool('write'), requiresConfirmation: true, prepare: () => Promise.resolve(7)};
        const installation = registry.register({identity: binding, tools: [tool]});
        f.registry.push(...registry.snapshot());
        f.host.tools.assertBinding = binding => {registry.assertCurrent(binding); return Promise.resolve();};
        f.requests.unshift({ok: true, content: '', toolCalls: [wire('write')]});
        await executeRun(f.run(), new AbortController(), f.host);
        expect(f.run().status).toBe('waiting_approval'); expect(f.calls.get('write')?.preview).toBe(7);
        const approved = {...f.calls.get('write')!, status: 'approved' as const};
        installation.dispose(); registry.register({identity: {...binding, registrationId: 'second'}, tools: [tool]});
        f.registry.splice(0, f.registry.length, ...registry.snapshot());
        f.calls.set('write', approved); f.run().status = 'running';
        await executeRun(f.run(), new AbortController(), f.host);
        expect(f.calls.get('write')).toMatchObject({status: 'failed', binding, preview: 7, arguments: '{}'});
        expect(f.effects()).toBe(0);
    });
    it('rechecks installation after held preparation and before admitting any preview', async () => {
        const f = fixture(), registry = createCapabilityRegistry<Context, number>();
        const binding = {capabilityId: 'example/write', version: '1', registrationId: 'first'};
        let release!: () => void, prepared!: () => void;
        const started = new Promise<void>(resolve => {prepared = resolve;});
        const gate = new Promise<void>(resolve => {release = resolve;});
        const installation = registry.register({identity: binding, tools: [{...f.tool('write'), requiresConfirmation: true,
            prepare: async () => {prepared(); await gate; return 7;}}]});
        f.registry.push(...registry.snapshot());
        f.host.tools.assertBinding = binding => {registry.assertCurrent(binding); return Promise.resolve();};
        f.requests.unshift({ok: true, content: '', toolCalls: [wire('write')]});
        const executing = executeRun(f.run(), new AbortController(), f.host); await started;
        installation.dispose(); release(); await executing;
        expect(f.calls.get('write')).toMatchObject({status: 'failed', binding});
        expect(f.calls.get('write')?.preview).toBeUndefined(); expect(f.effects()).toBe(0);
        expect(f.events.some(event => event.type === 'approval')).toBe(false);
    });
    it('checks fresh scope immediately before host execution claim and rechecks awaiting approvals', async () => {
        for (const status of ['pending', 'awaiting_approval'] as const) {
            const f = fixture(); let available = true;
            f.registry.push(f.tool('write')); f.run().hasToolCalls = true;
            f.calls.set('write', {id: 'write', name: 'write', arguments: '{}', status, step: 0, order: 0, effect: 'write', highRisk: false});
            f.host.tools.assertScope = () => {if (!available) throw new Error('authority revoked'); return Promise.resolve();};
            const read = f.host.tools.readCall;
            f.host.tools.readCall = (run, id) => {available = false; return read(run, id);};
            if (status === 'awaiting_approval') available = false;
            await executeRun(f.run(), new AbortController(), f.host);
            expect(f.effects()).toBe(0); expect(f.transitions).not.toContain('write:running');
            expect(f.calls.get('write')?.status).toBe(status === 'pending' ? 'pending' : 'failed');
        }
    });
    it('parks the entire round before any effect, including an earlier low-risk tool', async () => {
        const f = fixture();
        f.run().permissionMode = 'ask';
        const first = f.tool('first');
        first.effect = 'read';
        const second = f.tool('second');
        second.requiresConfirmation = true;
        second.prepare = () => Promise.resolve(0);
        f.registry.push(first, second);
        f.requests.unshift({ ok: true, content: '', toolCalls: [wire('first'), wire('second')] });
        await executeRun(f.run(), new AbortController(), f.host);
        expect(f.run().status).toBe('waiting_approval');
        expect(f.effects()).toBe(0);
        expect(f.calls.get('second')?.preview).toBe(0);
        expect(f.events.at(-1)?.type).toBe('approval');
    });
    it('requires durable completion from an atomic tool and never invents a second completion', async () => {
        const f = fixture();
        f.registry.push(f.tool('atomic', true));
        f.requests.unshift({ ok: true, content: '', toolCalls: [wire('atomic')] });
        await executeRun(f.run(), new AbortController(), f.host);
        expect(f.calls.get('atomic')?.status).toBe('unknown');
        expect(f.transitions).not.toContain('atomic:completed');
        expect(f.run().status).toBe('failed');
    });
    it('preserves committed atomic results after a late throw', async () => {
        const f = fixture(), tool = f.tool('atomic', true);
        tool.execute = (_args, context) => {
            Object.assign(f.calls.get(context.callId)!, { status: 'completed', result: 'original result' });
            return Promise.reject(new Error('after commit'));
        };
        f.registry.push(tool);
        f.requests.unshift({ ok: true, content: '', toolCalls: [wire('atomic')] });
        await executeRun(f.run(), new AbortController(), f.host);
        expect(f.calls.get('atomic')).toMatchObject({ status: 'completed', result: 'original result' });
        expect(f.transitions).not.toContain('atomic:completed');
        expect(f.run().status).toBe('completed');
    });
    it('keeps an unacknowledged atomic effect unknown if durable confirmation cannot be read', async () => {
        const f = fixture();
        f.registry.push(f.tool('atomic', true));
        f.requests.unshift({ ok: true, content: '', toolCalls: [wire('atomic')] });
        let reads = 0;
        const read = f.host.tools.readCall;
        f.host.tools.readCall = (run, id) => {
            if (++reads > 1)
                return Promise.reject(new Error('lost acknowledgement'));
            return Promise.resolve(read(run, id));
        };
        await executeRun(f.run(), new AbortController(), f.host);
        expect(f.calls.get('atomic')?.status).toBe('unknown');
        expect(f.forcedUnknown()).toBe(true);
        expect(f.transitions).not.toContain('atomic:completed');
    });
    it('accepts a previously approved primitive preview without preparing again', async () => {
        const f = fixture(), tool = f.tool('saved');
        let prepared = 0;
        tool.prepare = () => {
            prepared++;
            return Promise.resolve(1);
        };
        tool.requiresConfirmation = true;
        f.registry.push(tool);
        f.run().hasToolCalls = true;
        f.calls.set('saved', { id: 'saved', name: 'saved', arguments: '{}', status: 'approved', step: 0, order: 0, effect: 'write', highRisk: false, requiresConfirmation: true, preview: 0 });
        await executeRun(f.run(), new AbortController(), f.host);
        expect(prepared).toBe(0);
        expect(f.effects()).toBe(1);
    });
    it('skips settled history without point reads and keeps opaque continuation out of ordered public events', async () => {
        const f = fixture();
        f.registry.push(f.tool('active'));
        f.run().hasToolCalls = true;
        f.calls.set('old', { id: 'old', name: 'active', arguments: '{}', status: 'completed', step: 0, order: 0, effect: 'write', highRisk: false });
        f.requests.unshift({ ok: true, content: '', toolCalls: [wire('active')], continuation: 'encrypted exact bytes' });
        await executeRun(f.run(), new AbortController(), f.host);
        expect(f.reads).not.toContain('old');
        expect(f.run().opaque).toBe('encrypted exact bytes');
        expect(JSON.stringify(f.events)).not.toContain('encrypted exact bytes');
        expect(f.events.map(event => event.sequence)).toEqual(f.events.map((_event, i) => i + 1));
        const provisional = f.events.findIndex(event => event.type === 'output');
        const checkpoint = f.events.findIndex(event => event.type === 'checkpoint');
        expect(provisional).toBeLessThan(checkpoint);
        expect(f.events.at(-1)).toMatchObject({ type: 'settled', confirmed: true, status: 'completed' });
    });
    it('emits no confirmed checkpoint for a late or stale persistence no-op', async () => {
        const f = fixture();
        f.host.checkpoint = () => Promise.resolve(false);
        await executeRun(f.run(), new AbortController(), f.host);
        expect(f.events.some(event => event.type === 'output')).toBe(true);
        expect(f.events.some(event => event.type === 'checkpoint')).toBe(false);
    });
    it('does not confirm a rejected non-atomic completion write', async () => {
        const f = fixture();
        f.registry.push(f.tool('read'));
        f.requests.unshift({ ok: true, content: '', toolCalls: [wire('read')] });
        const transition = f.host.tools.transition;
        f.host.tools.transition = (run, call, from, to, extra) => to === 'completed' ? Promise.resolve(false) : transition(run, call, from, to, extra);
        await executeRun(f.run(), new AbortController(), f.host);
        expect(f.events.some(event => event.type === 'tool_completed')).toBe(false);
        expect(f.run().status).toBe('failed');
    });
    it('checks segment admission before context preparation and rejects a lost lease before dispatch', async () => {
        const f = fixture();
        f.host.pauseAtLimit = () => Promise.resolve(true);
        await executeRun(f.run(), new AbortController(), f.host);
        expect(f.contexts).toEqual([]);
        expect(f.requests).toHaveLength(1);
        f.expire();
        await expect(executeRun(f.run(), new AbortController(), f.host)).rejects.toThrow('lease expired');
    });
    it('calls the optional pending-input hook after pause/limit checks, before context preparation, and feeds its run onward', async () => {
        const f = fixture();
        const order: string[] = [], signals: AbortSignal[] = [];
        const controller = new AbortController();
        const pause = f.host.pauseAtLimit, prepare = f.host.prepareContext;
        f.host.pauseAtLimit = value => { order.push('pause'); return pause(value); };
        f.host.admitPendingInput = (value, signal) => { order.push('admit'); signals.push(signal); return Promise.resolve({ ...value, opaque: 'steered' }); };
        f.host.prepareContext = (value, signal) => { order.push('prepare'); expect(value.opaque).toBe('steered'); return prepare(value, signal); };
        await executeRun(f.run(), controller, f.host);
        expect(order).toEqual(['pause', 'admit', 'prepare']);
        expect(signals[0]).toBe(controller.signal);
        expect(f.run().status).toBe('completed');
    });
    it('runs unchanged when the host omits the pending-input hook and never calls it after a limit pause', async () => {
        const plain = fixture();
        expect(plain.host.admitPendingInput).toBeUndefined();
        await executeRun(plain.run(), new AbortController(), plain.host);
        expect(plain.run().status).toBe('completed');
        const paused = fixture();
        const admit = vi.fn((value: Run) => Promise.resolve(value));
        paused.host.admitPendingInput = admit;
        paused.host.pauseAtLimit = () => Promise.resolve(true);
        await executeRun(paused.run(), new AbortController(), paused.host);
        expect(admit).not.toHaveBeenCalled();
        expect(paused.requests).toHaveLength(1);
    });
    it('stops cleanup for a confirmed deleted run without a confirmed settlement event', async () => {
        const f = fixture();
        let deleted = false, cleanup = 0;
        const readRun = f.host.readRun;
        f.host.readRun = id => deleted ? Promise.resolve(undefined) : readRun(id);
        f.host.request = () => {deleted = true; return Promise.reject(new Error('late delivery'));};
        f.host.tools.markUnknown = () => {cleanup++; return Promise.resolve();};
        f.host.settle = () => {throw new Error('must not settle a deleted run');};
        await executeRun(f.run(), new AbortController(), f.host);
        expect(cleanup).toBe(0);
        expect(f.events.some(event => event.confirmed)).toBe(false);
    });
    it('keeps an unreadable cleanup target as a failure instead of treating it as deleted', async () => {
        const f = fixture();
        let unreadable = false;
        const readRun = f.host.readRun;
        f.host.readRun = id => unreadable ? Promise.reject(new Error('confirmation unreadable')) : readRun(id);
        f.host.request = () => {unreadable = true; return Promise.reject(new Error('late delivery'));};
        await expect(executeRun(f.run(), new AbortController(), f.host)).rejects.toThrow('confirmation unreadable');
        expect(f.events.some(event => event.confirmed)).toBe(false);
    });

});
