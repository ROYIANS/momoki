import {createToolFactory, type ToolContext, type ToolDefinition} from "@momoki/agent-core";
import type {AgentToolPreview} from '../models/agent';
import type {Spec} from './businessSchemas';
import type {ProductStore} from "../../../platform/storage/types";

export interface AgentToolContext extends ToolContext<AgentToolPreview> {
    /** Explicit local storage context; copied for each root, never global ambient state. */
    store?: ProductStore;
    projectId?: string;
    runId: string;
    threadId: string;
    callId: string;
    signal: AbortSignal;
    preview?: AgentToolPreview;
}

/** Product context is supplied only by Studio; the generic parser/callback relationship lives in core. */
export type TypedToolDefinition<Args, Name extends string = string> = Omit<ToolDefinition<Args, AgentToolContext, AgentToolPreview, unknown, Name>, "recovery"> & {recovery?: "generation" | "repeatable"};
export type AgentToolDefinition = TypedToolDefinition<unknown>;
export type ToolBody<Args, Name extends string> = Omit<TypedToolDefinition<Args, Name>, 'parameters' | 'parseArguments'>;

const defineHostTool = createToolFactory<AgentToolContext, AgentToolPreview>();
export function defineTool<Args, const Name extends string>(spec: Spec<Args>, body: ToolBody<NoInfer<Args>, Name>): TypedToolDefinition<Args, Name> {
    return {...defineHostTool(spec, body), recovery: body.recovery};
}
export {assertUniqueToolNames, toolMetadataMatches} from "@momoki/agent-core";
