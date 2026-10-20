import {streamChatCompletions as dispatchChat} from '@momoki/agent-providers';
import type {StreamChatInput as ProviderChatInput, StreamChatHandlers as ProviderChatHandlers} from '@momoki/agent-providers';
import type {AgentRequestMessage} from '../models/agent';
import type {AgentVisionCapability} from '../../references/models/referenceInput';
import type {ConnectorDefinitionId} from '../../settings/models/connector';
import {assertReasoningEffort} from '../../settings/models/reasoningPolicy';
import {runtimeFetchFor} from '../../../platform/runtime/runtimeFetch';
import {materializeChatMessages} from './referenceWire';
export type {StreamChatResult} from '@momoki/agent-providers';
export type ChatCompletionMessage = AgentRequestMessage;

export type StreamChatInput = Omit<ProviderChatInput, 'messages'> & {
    projectId?: string;
    runId?: string;
    visionCapability?: AgentVisionCapability;
    connectorDefinitionId?: ConnectorDefinitionId;
    messages: ChatCompletionMessage[];
};

export type StreamChatHandlers = Omit<ProviderChatHandlers, 'fetchImpl' | 'validateRequest' | 'materializeMessages'> & {
    fetchImpl?: typeof fetch;
};


/** Product policy and reference materialization are supplied anew for each request. */
export function streamChatCompletions(input: StreamChatInput, handlers: StreamChatHandlers = {}) {
    return dispatchChat(input, {...handlers, fetchImpl: handlers.fetchImpl ?? runtimeFetchFor(),
        validateRequest: () => assertReasoningEffort(input.connectorDefinitionId ? {definitionId: input.connectorDefinitionId, baseUrl: input.baseUrl} : undefined, input.model.trim(), input.reasoningEffort),
        materializeMessages: signal => materializeChatMessages(input.messages, input, signal),
    });
}
