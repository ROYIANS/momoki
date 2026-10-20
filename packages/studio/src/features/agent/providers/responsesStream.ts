import {streamResponses as dispatchResponses, toResponseInput as convertMessages} from '@momoki/agent-providers';
import type {AgentRequestMessage, AgentResponseItem} from '../models/agent';
import type {StreamChatInput, StreamChatHandlers} from './chatStream';
import {assertReasoningEffort} from '../../settings/models/reasoningPolicy';
import {runtimeFetchFor} from '../../../platform/runtime/runtimeFetch';
import {materializeResponseItems} from './referenceWire';
export {decodeResponseOutput} from '@momoki/agent-providers';
export type {ResponsesResult} from '@momoki/agent-providers';

/** Protocol conversion is shared; provenance stays solely in the product run. */
export function toResponseInput(messages: readonly AgentRequestMessage[]): AgentResponseItem[] {
    return messages.flatMap(message => convertMessages([message]).map(item => ({...item,
        ...((item.type === 'message' || item.type === 'function_call_output') && message.referenceInput ? {referenceInput: message.referenceInput} : {}),
        ...(item.type === 'message' && message.sourceToolCallId ? {sourceToolCallId: message.sourceToolCallId} : {}),
        ...(item.type === 'message' && message.sourceQueueItemId ? {sourceQueueItemId: message.sourceQueueItemId} : {}),
    })));
}
export function streamResponses(input: StreamChatInput & {responseItems?: AgentResponseItem[]}, handlers: StreamChatHandlers = {}) {
    return dispatchResponses(input, {...handlers, fetchImpl: handlers.fetchImpl ?? runtimeFetchFor(),
        validateRequest: () => {
            if (input.connectorDefinitionId !== 'openai-compatible' && input.connectorDefinitionId !== 'aihubmix') throw new Error('当前连接尚未支持 Responses 协议');
            assertReasoningEffort({definitionId: input.connectorDefinitionId, baseUrl: input.baseUrl}, input.model.trim(), input.reasoningEffort);
        },
        materializeItems: signal => materializeResponseItems(input.responseItems ?? toResponseInput(input.messages), input, signal),
    });
}
