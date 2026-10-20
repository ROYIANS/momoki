import {createCapabilityRegistry, createToolFactory, validateToolInput, type ToolBindingIdentity, type ToolDefinition, type ToolSpec} from '@momoki/agent-core';
import type {Preview, TodoAction, TodoContext} from './types.js';

function object(raw: unknown): Record<string, unknown> {if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected object'); return raw as Record<string, unknown>;}
function text(raw: unknown): string {if (typeof raw !== 'string' || !raw.trim() || raw.length > 200) throw new Error('Expected bounded text'); return raw;}
const define = createToolFactory<TodoContext, Preview>();
const empty: ToolSpec<Record<string, never>> = {json: {type: 'object', properties: {}}, schema: {parse(raw) {object(raw); return {};}}};
const create: ToolSpec<{title: string}> = {json: {type: 'object', properties: {title: {type: 'string'}}, required: ['title']}, schema: {parse: raw => ({title: text(object(raw).title)})}};
const complete: ToolSpec<{id: string}> = {json: {type: 'object', properties: {id: {type: 'string'}}, required: ['id']}, schema: {parse: raw => ({id: text(object(raw).id)})}};
const loading: ToolSpec<{groups: string[]}> = {json: {type: 'object', properties: {groups: {type: 'array', items: {type: 'string'}}}}, schema: {parse(raw) {const value = object(raw).groups; if (!Array.isArray(value)) throw new Error('Expected groups'); return {groups: value.map(text)};}}};

export const registry = [
    define(empty, {name: 'list_todos', title: 'List todos', description: 'Read this list', effect: 'read', highRisk: () => false,
        prepare: async (_args, context) => ({title: 'list', authority: await context.services.prepare('list')}),
        execute: (_args, context) => Promise.resolve(context.services.list())}),
    define(create, {name: 'create_todo', title: 'Create todo', description: 'Create one todo', effect: 'write', atomic: true, highRisk: () => false,
        prepare: async (args, context) => ({title: args.title, authority: await context.services.prepare('create')}),
        execute: (args, context) => Promise.resolve(context.services.mutate(context.callId, context.signal, {kind: 'create', ...args}, context.preview?.authority))}),
    define(complete, {name: 'complete_todo', title: 'Finish todo', description: 'Finish an existing todo', effect: 'write', atomic: true, highRisk: () => false,
        prepare: async (args, context) => ({title: args.id, authority: await context.services.prepare('complete')}),
        execute: (args, context) => Promise.resolve(context.services.mutate(context.callId, context.signal, {kind: 'complete', ...args}, context.preview?.authority))}),
    define(loading, {name: 'load_tools', title: 'Load capabilities', description: 'Select enabled groups', effect: 'bookkeeping', atomic: true, highRisk: () => false, execute: (args, context) => Promise.resolve(context.services.load(context.callId, args.groups, context.signal))}),
    define(empty, {name: 'external_notice', title: 'External notice', description: 'Demonstrate uncertain external acknowledgement', effect: 'network', recovery: 'manual-confirmation', highRisk: () => true, execute: (_args, context) => Promise.resolve(context.services.external(context.callId, context.signal))}),
] as unknown as ToolDefinition<unknown, TodoContext, Preview, unknown>[];

/** Tools whose every use needs a host-issued resource grant for exactly this action. */
const GRANTED_ACTIONS: Readonly<Record<string, TodoAction>> = Object.freeze({list_todos: 'list', create_todo: 'create', complete_todo: 'complete'});
export const actionOf = (name: string): TodoAction | undefined => Object.hasOwn(GRANTED_ACTIONS, name) ? GRANTED_ACTIONS[name] : undefined;
/** The preview title is the exact argument identity a grant was prepared for. */
export const previewTitle = (name: string, args: unknown): string | undefined => {
    if (name === 'list_todos') return 'list';
    if (!args || typeof args !== 'object') return undefined;
    const value = name === 'create_todo' ? (args as {title?: unknown}).title : name === 'complete_todo' ? (args as {id?: unknown}).id : undefined;
    return typeof value === 'string' ? value : undefined;
};
// Historical identifiers: the single installation now covers list/create/complete.
export const CREATE_CAPABILITY = 'todo.create';
export const CREATE_VERSION = '1';

/** Trusted host pairs this reviewed implementation with its durable installation. */
export function createTodoToolset(identity: ToolBindingIdentity) {
    if (identity.capabilityId !== CREATE_CAPABILITY || identity.version !== CREATE_VERSION) throw new Error('Unreviewed Todo installation');
    const capabilities = createCapabilityRegistry<TodoContext, Preview>();
    const registration = capabilities.register({identity, tools: registry.filter(tool => actionOf(tool.name) !== undefined)});
    return {definitions: Object.freeze([...registry.filter(tool => actionOf(tool.name) === undefined), ...capabilities.snapshot()]),
        assertCurrent: () => capabilities.assertCurrent(identity), dispose: () => registration.dispose()};
}

export function validate(name: string, raw: string, offered: readonly string[], definitions: readonly ToolDefinition<unknown, TodoContext, Preview, unknown>[] = registry) {
    return validateToolInput(name, raw, offered, definitions, {
        unavailable: name => new Error(`Unavailable tool: ${name}`),
        tooLarge: () => new Error('Arguments exceed limit'),
        invalid: (_tool, _parsed, cause) => new Error('Invalid arguments', {cause}),
    });
}
