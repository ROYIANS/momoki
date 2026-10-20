import type {AgentWireToolCall} from '@momoki/agent-core';
export type ChatContentPart = {type: 'text'; text: string} | {type: 'image_url'; image_url: {url: string; detail: 'auto'}};
export type ChatRequestMessage =
    | {role: 'user' | 'system'; content: string | ChatContentPart[]}
    | {role: 'assistant'; content: string; tool_calls?: AgentWireToolCall[]}
    | {role: 'tool'; content: string; tool_call_id: string};
export type ChatMessage = Exclude<ChatRequestMessage, {role: 'user' | 'system'}> | {role: 'user' | 'system'; content: string};
export type ResponseItem = (
    | {
    type: "message";
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "output_text"; text: string; annotations: unknown[] }>;
    id?: string;
    status?: "completed";
    phase?: string
}
    | {
    type: "reasoning";
    id?: string;
    summary: Array<{ type: "summary_text"; text: string }>;
    encrypted_content?: string
}
    | { type: "function_call"; id?: string; call_id: string; name: string; arguments: string; status?: "completed" }
    | { type: "function_call_output"; call_id: string; output: string });
export type ResponseInputPart = {type: 'input_text'; text: string} | {type: 'input_image'; image_url: string; detail: 'auto'};
export type ResponseRequestItem = Exclude<ResponseItem, {type: 'message'}> | (Omit<Extract<ResponseItem, {type: 'message'}>, 'content'> & {content: string | Extract<ResponseItem, {type: 'message'}>['content'] | ResponseInputPart[]});
