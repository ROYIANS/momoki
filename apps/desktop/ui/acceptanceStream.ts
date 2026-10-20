import {readSseEvents} from "@momoki/agent-providers/http";
import {streamChatCompletions, type StreamChatInput, type StreamChatResult} from '@momoki/studio/reference/lib/ai/chatStream';
import {streamResponses} from '@momoki/studio/reference/lib/ai/responsesStream';
import {MAX_JSON_BYTES} from '@momoki/studio/reference/lib/resource/limits';
import {assert, type Evidence} from './acceptanceEvidence';

export async function checkStreaming(evidence: Evidence) {
    assert(/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(__STREAM_ENDPOINT__), '没有固定本机流端点');
    for (const mode of ['crlf', 'multibyte', 'event-overflow', 'abort'] as const) {
        await evidence.check(`真实 fetch／boundedSse：${mode}`, async () => {
            const controller = new AbortController();
            const reason = new DOMException('fixture SSE abort', 'AbortError');
            const response = await fetch(`${__STREAM_ENDPOINT__}/events?case=${mode}`, {
                headers: {Authorization: `Bearer ${__STREAM_TOKEN__}`},
                signal: controller.signal,
                credentials: 'omit',
                redirect: 'error'
            });
            assert(response.ok, `流端点 HTTP ${response.status}`);
            const events: { data: string; event: string; atEpochMs: number }[] = [];
            let failure: unknown;
            try {
                for await(const event of readSseEvents(response, controller.signal)) {
                    events.push({...event, atEpochMs: Date.now()});
                    if (mode === 'abort') controller.abort(reason);
                }
            } catch (error) {
                failure = error;
            }
            if (mode === 'event-overflow') assert(failure instanceof Error && /超过|限制|过大/.test(failure.message), 'SSE 单事件上限没有拒绝');
            else if (mode === 'abort') assert(failure === reason && events.length === 1, 'SSE 中断原因或已收到事件错误');
            else {
                assert(failure === undefined && events.length === 1, 'SSE 事件解析失败');
                assert(events[0].data === (mode === 'crlf' ? 'first\nsecond' : '雨🌹'), 'CRLF／UTF8 多字节解析错误');
                assert(mode !== 'crlf' || events[0].event === 'fixture', 'SSE event 字段错误');
            }
            return {
                events,
                aborted: controller.signal.aborted,
                error: failure instanceof Error ? failure.message : null,
                finishedEpochMs: Date.now()
            };
        }, value => value);
    }
    for (const [protocol, adapter] of [['Chat', streamChatCompletions], ['Responses', streamResponses]] as const) {
        for (const model of ['success', 'terminal-error', 'event-overflow', 'output-overflow', 'abort'] as const) {
            await evidence.check(`真实 ${protocol} 流适配器：${model}`, async () => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(new DOMException('fixture stream timeout', 'TimeoutError')), 12000);
                const callbacks: { atEpochMs: number; bytes: number; prefix: string }[] = [];
                let retainedBytes = 0;
                const input: StreamChatInput = {
                    baseUrl: __STREAM_ENDPOINT__,
                    apiKey: __STREAM_TOKEN__,
                    model,
                    connectorDefinitionId: 'aihubmix',
                    messages: [{role: 'user', content: '仅本机免费流测试'}]
                };
                let result: StreamChatResult;
                const startedEpochMs = Date.now();
                try {
                    result = await adapter(input, {
                        signal: controller.signal, onDelta: text => {
                            const bytes = new TextEncoder().encode(text).byteLength;
                            retainedBytes += bytes;
                            callbacks.push({atEpochMs: Date.now(), bytes, prefix: text.slice(0, 20)});
                            if (model === 'abort') controller.abort(new DOMException('fixture adapter abort', 'AbortError'));
                        }
                    });
                } finally {
                    clearTimeout(timer);
                }
                const finishedEpochMs = Date.now();
                if (model === 'success') {
                    assert(result.ok && result.via === 'stream' && result.content === '雨🌹', '适配器没有返回正确流文本');
                    assert(callbacks.length === 2 && callbacks[1].atEpochMs - callbacks[0].atEpochMs >= 100, '没有实际分时增量回调');
                    assert(finishedEpochMs - callbacks[0].atEpochMs >= 250, '增量直到终态才出现');
                } else if (model === 'terminal-error') assert(!result.ok && result.message.includes('fixture terminal failure') && callbacks.length === 2, '终态错误或部分输出处理失败');
                else if (model === 'abort') assert(!result.ok && result.aborted === true && callbacks.length === 1, '适配器没有实际中断或丢失首次增量');
                else assert(!result.ok && /超过|限制|过大/.test(result.message) && retainedBytes <= MAX_JSON_BYTES, '事件／累积输出上限没有在回调前拒绝');
                return {
                    startedEpochMs, finishedEpochMs, callbacks, retainedBytes, ok: result.ok,
                    error: result.ok ? null : result.message, aborted: !result.ok && result.aborted === true,
                    serverDisconnectEvidence: 'correlate run/server-events.json; native completion alone is not disconnect proof'
                };
            }, value => value);
        }
    }
}
