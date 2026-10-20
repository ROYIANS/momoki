import {estimateTokens, type AgentWireToolCall} from '@momoki/agent-core';
import type {ResponseItem} from './wire.js';

/** Validate either the ordered received round or the complete durable call ledger. */
export function responseRoundMatches(items: readonly ResponseItem[] | undefined, calls: readonly AgentWireToolCall[], ordered: boolean): boolean {
    const saved = items?.filter(item => item.type === 'function_call');
    if (!saved || saved.length !== calls.length) return false;
    return ordered
        ? saved.every((item, index) => item.call_id === calls[index].id && item.name === calls[index].function.name && item.arguments === calls[index].function.arguments)
        : calls.every(call => saved.some(item => item.call_id === call.id && item.name === call.function.name && item.arguments === call.function.arguments));
}

/** Caller owns its array/transaction; exact existing outputs are reused without rewriting them. */
export function appendResponseToolResult(items: ResponseItem[], callId: string, result: string): void {
    const saved = items.filter(item => item.type === 'function_call_output' && item.call_id === callId);
    if (saved.length > 1 || saved.some(item => item.type === 'function_call_output' && item.output !== result)) throw new Error('Responses 已保存的工具结果与执行记录不匹配');
    if (saved.length) return;
    if (!items.some(item => item.type === 'function_call' && item.call_id === callId)) throw new Error('Responses 缺少对应工具调用');
    items.push({type: 'function_call_output', call_id: callId, output: result});
}

/** Opaque reasoning consumes context budget even though it never enters public text. */
export function responseContinuationTokens(items: readonly ResponseItem[] | undefined): number {
    return items ? estimateTokens(JSON.stringify(items.filter(item => item.type === 'reasoning'))) : 0;
}
