import {createCapabilityRegistry, createToolFactory, type ToolBindingIdentity, type ToolContext, type ToolDefinition,
    type ToolSpec, type ResourceGrantPort, type ResourceGrantRequest, type ResourceGrantSnapshot} from '@momoki/agent-core';

type Fact = {kind: 'list'; listId: string; action: 'create'};
type Preview = {title: string; authority: ResourceGrantSnapshot<Fact>};
interface Context extends ToolContext<Preview> {grants: ResourceGrantPort<Fact>}
const spec: ToolSpec<{title: string}> = {json: {type: 'object'}, schema: {parse(raw) {
    if (!raw || typeof raw !== 'object' || !('title' in raw) || typeof raw.title !== 'string') throw new Error('invalid');
    return {title: raw.title};
}}};
const define = createToolFactory<Context, Preview>();
const binding: ToolBindingIdentity = {capabilityId: 'example/create', version: '1', registrationId: 'install-1'};
const tool = define(spec, {name: 'create', title: 'Create', description: 'Create', effect: 'write', highRisk: args => {
    // @ts-expect-error parser arguments do not acquire another field
    args.path.toUpperCase();
    return args.title.length > 2;
}, prepare: async (args, context) => ({title: args.title, authority: await context.grants.prepare({
    subject: {runId: context.runId, callId: context.callId, scopeId: 'list-a'}, binding,
    facts: [{kind: 'list', listId: 'list-a', action: 'create'}], signal: context.signal,
})}), execute: async (args, context) => {
    if (context.preview) {
        // @ts-expect-error preview remains host typed
        context.preview.approved = true;
        await context.grants.assertCurrent(context.preview.authority, context.signal);
    }
    return {created: args.title};
}});
declare const context: Context;
// @ts-expect-error callback receives parser-derived arguments
tool.execute({path: '/tmp'}, context);
const result: Promise<{created: string}> = tool.execute({title: 'a'}, context);
void result;
const literal: 'create' = tool.name; void literal;
define(spec, {...tool,
    // @ts-expect-error prepare must return the host's complete typed preview
    prepare: args => Promise.resolve({title: args.title}),
});
const registry = createCapabilityRegistry<Context, Preview>();
// One intentional heterogeneous dispatch erasure, after definition inference.
registry.register({identity: binding, tools: [tool as unknown as ToolDefinition<unknown, Context, Preview, unknown>]});
function contracts(request: ResourceGrantRequest<Fact>, snapshot: ResourceGrantSnapshot<Fact>) {
    // @ts-expect-error resource facts do not accept filesystem targets
    request.facts[0].path;
    // @ts-expect-error readonly grant snapshot cannot replace authority lineage
    snapshot.grants = [];
    // @ts-expect-error list create does not grant delete
    const widened: Fact = {kind: 'list', listId: 'list-a', action: 'delete'};
    // @ts-expect-error exact binding generation cannot be reassigned
    snapshot.binding.registrationId = 'replacement';
    return widened;
}
void contracts;
