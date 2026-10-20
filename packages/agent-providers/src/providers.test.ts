import {afterEach, describe, expect, it, vi} from 'vitest';
import {streamChatCompletions, streamResponses, decodeResponseOutput, responseRoundMatches, appendResponseToolResult, responseContinuationTokens, type ResponsesInput, type ResponsesHandlers} from '@momoki/agent-providers';
import {requestOnce, ResponseLimitError, readResponseBytes} from '@momoki/agent-providers/http';

const input: ResponsesInput = {baseUrl: 'https://example.test/v1', apiKey: 'secret', model: 'model', messages: [{role: 'user', content: 'hello'}]};
const response = (output: unknown[]) => Response.json({status: 'completed', output});
afterEach(() => vi.unstubAllGlobals());

describe('emitted reusable provider exports', () => {
    it('runs request-time host preparation inside one dispatch boundary and never falls back to global fetch', async () => {
        const order: string[] = [];
        const fetchImpl = vi.fn<typeof fetch>(() => {
            order.push('fetch');
            return Promise.resolve(Response.json({choices: [{message: {content: 'done'}, finish_reason: 'stop'}]}));
        });
        const result = await streamChatCompletions(input, {fetchImpl,
            validateRequest: () => {order.push('validate');},
            materializeMessages: () => {order.push('materialize');return Promise.resolve([{role: 'user', content: [{type: 'text', text: 'prepared'}]}]);},
        });
        expect(result).toMatchObject({ok: true, content: 'done'});
        expect(order).toEqual(['validate', 'materialize', 'fetch']);
        const body = fetchImpl.mock.calls[0][1]?.body;
        if (typeof body !== 'string') throw new Error('expected JSON request body');
        const request: unknown = JSON.parse(body);
        expect(request).toMatchObject({messages: [{content: [{type: 'text', text: 'prepared'}]}]});
        const globalFetch = vi.fn();vi.stubGlobal('fetch', globalFetch);
        const missing = {fetchImpl: undefined} as unknown as ResponsesHandlers;
        expect((await streamChatCompletions(input, missing)).ok).toBe(false);
        await expect(requestOnce('https://example.test', {}, {...missing, credentials: 'omit', redirect: 'error'})).rejects.toBeInstanceOf(TypeError);
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it('retains the exact opaque round and appends its original call result on the next Responses dispatch', async () => {
        const opaque = {type: 'reasoning' as const, id: 'rs', summary: [{type: 'summary_text' as const, text: 'public summary'}], encrypted_content: ' exact\u0000cipher\nbytes '};
        const call = {type: 'function_call' as const, id: 'fc', call_id: 'call', name: 'write', arguments: '{"value":1}', status: 'completed' as const};
        const tools = [{type: 'function' as const, function: {name: 'write', description: 'write', parameters: {type: 'object'}}}];
        const onReasoning = vi.fn();
        const first = await streamResponses({...input, tools}, {fetchImpl: () => Promise.resolve(response([opaque, call])), onReasoning});
        expect(first).toMatchObject({ok: true, responseOutput: [opaque, call], toolCalls: [{id: 'call'}]});
        expect(onReasoning).toHaveBeenCalledExactlyOnceWith('public summary');
        expect(JSON.stringify(onReasoning.mock.calls)).not.toContain('cipher');
        if (!first.ok || !first.responseOutput) throw new Error('expected completed round');
        const items = [...first.responseOutput, {type: 'function_call_output' as const, call_id: 'call', output: '{"committed":true}'}];
        const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(response([{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'done'}]}])));
        const handlers: ResponsesHandlers = {fetchImpl};
        expect((await streamResponses({...input, responseItems: items}, handlers)).ok).toBe(true);
        const body = fetchImpl.mock.calls[0][1]?.body;
        if (typeof body !== 'string') throw new Error('expected JSON request body');
        const request: unknown = JSON.parse(body);
        expect(request).toMatchObject({input: items});
        expect(decodeResponseOutput([opaque, call], tools).items).toEqual([opaque, call]);
        expect(responseRoundMatches(first.responseOutput, first.toolCalls!, true)).toBe(true);
        expect(responseRoundMatches(first.responseOutput, [{...first.toolCalls![0], function: {...first.toolCalls![0].function, arguments: 'changed'}}], false)).toBe(false);
        expect(responseContinuationTokens(first.responseOutput)).toBeGreaterThan(0);
        const durable = [...first.responseOutput];
        appendResponseToolResult(durable, 'call', '{"committed":true}');
        appendResponseToolResult(durable, 'call', '{"committed":true}');
        expect(durable).toEqual(items);
        expect(() => appendResponseToolResult(durable, 'call', 'changed')).toThrow('不匹配');
        expect(() => appendResponseToolResult(durable, 'absent', 'result')).toThrow('缺少对应');
        expect(durable[0]).toBe(first.responseOutput[0]);
    });

    it('stops before transport on cancelled preparation or policy failure and redacts host errors', async () => {
        const fetchImpl = vi.fn<typeof fetch>(), controller = new AbortController();
        const aborted = await streamChatCompletions(input, {fetchImpl, signal: controller.signal,
            materializeMessages: () => {controller.abort();return Promise.resolve(input.messages);},
        });
        expect(aborted).toMatchObject({ok: false, aborted: true});expect(fetchImpl).not.toHaveBeenCalled();
        const failure = await streamResponses(input, {fetchImpl, validateRequest: () => {throw new Error('secret Bearer other-key');}});
        expect(failure).toMatchObject({ok: false, message: '[已隐藏] Bearer [已隐藏]'});
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('uses the one public limit-error identity and cancels an overflowing body', async () => {
        const cancel = vi.fn();
        const stream = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new Uint8Array(4));}, cancel});
        await expect(readResponseBytes(new Response(stream), 3)).rejects.toBeInstanceOf(ResponseLimitError);
        expect(cancel).toHaveBeenCalledOnce();expect(stream.locked).toBe(false);
    });
});
