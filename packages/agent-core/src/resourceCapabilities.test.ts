import {describe, expect, it, vi} from 'vitest';
import {createCapabilityRegistry, createToolFactory, requiresToolApproval, toolMetadataMatches, type ToolBindingIdentity,
    type ToolContext, type ToolDefinition, type ToolSpec} from '@momoki/agent-core';

type Context = ToolContext<{title: string}>;
const identity = (registrationId = 'install-1'): ToolBindingIdentity => ({capabilityId: 'example/todo-create', version: '1.0.0', registrationId});
const define = createToolFactory<Context, {title: string}>();
function definition(name = 'create') {
    const parse = vi.fn((raw: unknown) => {
        if (!raw || typeof raw !== 'object' || !('title' in raw) || typeof raw.title !== 'string') throw new Error('title required');
        return {title: raw.title};
    });
    const spec: ToolSpec<{title: string}> = {json: {type: 'object', properties: {title: {type: 'string'}}, required: ['title']}, schema: {parse}};
    const tool = define(spec, {name, title: 'Create', description: 'Create one item', effect: 'write', atomic: true,
        highRisk: args => args.title === 'sensitive', prepare: args => Promise.resolve({title: args.title}), execute: args => Promise.resolve({created: args.title})});
    // The sole heterogeneous boundary follows parser-linked definition construction.
    return {spec, parse, tool, dispatched: tool as unknown as ToolDefinition<unknown, Context, {title: string}, unknown>};
}

describe('neutral capability registration and immutable identity', () => {
    it('rejects active capability/name/generation collisions without consuming a rejected generation', () => {
        const registry = createCapabilityRegistry<Context, {title: string}>(), a = definition(), b = definition('other');
        registry.register({identity: identity(), tools: [a.dispatched]});
        expect(() => registry.register({identity: identity('install-2'), tools: [b.dispatched]})).toThrow('已经注册');
        expect(() => registry.register({identity: {...identity('install-2'), capabilityId: 'other'}, tools: [a.dispatched]})).toThrow('名称重复');
        expect(() => registry.register({identity: {...identity(), capabilityId: 'other'}, tools: [b.dispatched]})).toThrow('不可复用');
        registry.register({identity: {...identity('install-2'), capabilityId: 'other'}, tools: [b.dispatched]});
        expect(registry.snapshot().map(tool => tool.name)).toEqual(['create', 'other']);
    });
    it('retires only its own generation and refuses reusing it, including after disposal', () => {
        const registry = createCapabilityRegistry<Context, {title: string}>(), {dispatched} = definition();
        const old = registry.register({identity: identity(), tools: [dispatched]});
        old.dispose(); old.dispose(); expect(registry.snapshot()).toEqual([]);
        expect(() => registry.assertCurrent(identity())).toThrow('失效');
        expect(() => registry.register({identity: identity(), tools: [dispatched]})).toThrow('不可复用');
        registry.register({identity: identity('install-2'), tools: [dispatched]});
        old.dispose(); registry.assertCurrent(identity('install-2'));
        expect(registry.snapshot()).toHaveLength(1);
        expect(() => registry.assertCurrent({...identity('install-2'), version: '2'})).toThrow('失效');
    });
    it('copies and freezes schema, envelope, callback identity and binding without freezing host inputs', async () => {
        const registry = createCapabilityRegistry<Context, {title: string}>(), original = definition();
        const inputIdentity = {...identity()};
        registry.register({identity: inputIdentity, tools: [original.dispatched]});
        const snapshot = registry.snapshot(), bound = snapshot[0];
        (original.spec.json.properties as Record<string, unknown>).title = {type: 'number'};
        (original.spec.json.required as string[]).push('later');
        original.spec.schema.parse = () => ({title: 'changed parser'});
        original.tool.execute = () => Promise.resolve({created: 'changed callback'});
        original.tool.title = 'Changed title'; inputIdentity.version = 'changed version';
        expect(bound.parameters).toEqual({type: 'object', properties: {title: {type: 'string'}}, required: ['title']});
        expect(bound.title).toBe('Create'); expect(bound.binding).toEqual(identity());
        expect(bound.parseArguments({title: 'original'})).toEqual({title: 'original'});
        await expect(bound.execute({title: 'original'}, {runId: 'run', threadId: 'thread', callId: 'call', signal: new AbortController().signal})).resolves.toEqual({created: 'original'});
        expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(bound)).toBe(true);
        expect(Object.isFrozen(bound.parameters.properties)).toBe(true); expect(Object.isFrozen(bound.parameters.required)).toBe(true);
        expect(Object.isFrozen(bound.binding)).toBe(true); expect(Object.isFrozen(original.spec.json)).toBe(false);
        expect(() => {bound.parameters.extra = true;}).toThrow(TypeError);
    });
    it.each(['', ' space', 'a b', '../bad?', 'a#b', 'x'.repeat(129)])('rejects invalid host identity %j', value => {
        for (const field of ['capabilityId', 'version', 'registrationId'] as const) {
            const registry = createCapabilityRegistry<Context, {title: string}>();
            expect(() => registry.register({identity: {...identity(), [field]: value}, tools: [definition().dispatched]})).toThrow('标识无效');
        }
    });
    it('rejects cyclic/non-JSON schemas and duplicate local names before installation', () => {
        const registry = createCapabilityRegistry<Context, {title: string}>(), {dispatched} = definition();
        expect(() => registry.register({identity: identity(), tools: [dispatched, dispatched]})).toThrow('名称重复');
        const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
        expect(() => registry.register({identity: identity(), tools: [{...dispatched, parameters: cyclic}]})).toThrow('JSON');
        expect(() => registry.register({identity: identity(), tools: []})).toThrow('至少');
        registry.register({identity: identity(), tools: [dispatched]});
        expect(registry.snapshot()).toHaveLength(1);
    });
    it('matches exact binding presence and all three fields while static definitions remain static', () => {
        const {tool} = definition();
        const args = {title: 'ordinary'}, metadata = {effect: 'write' as const, highRisk: false, atomic: true};
        expect(toolMetadataMatches(tool, args, metadata)).toBe(true);
        expect(toolMetadataMatches({...tool, binding: identity()}, args, metadata)).toBe(false);
        expect(toolMetadataMatches(tool, args, {...metadata, binding: identity()})).toBe(false);
        expect(toolMetadataMatches({...tool, binding: identity()}, args, {...metadata, binding: {...identity()}})).toBe(true);
        for (const field of ['capabilityId', 'version', 'registrationId'] as const) {
            expect(toolMetadataMatches({...tool, binding: identity()}, args, {...metadata, binding: {...identity(), [field]: 'different'}})).toBe(false);
        }
    });
    it.each(['ask', 'assist', 'full'] as const)('keeps mandatory confirmation ahead of %s permission', mode => {
        const {tool} = definition();
        expect(requiresToolApproval(mode, {...tool, requiresConfirmation: true}, {title: 'ordinary'})).toBe(true);
    });
});
