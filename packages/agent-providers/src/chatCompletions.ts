import type {StreamDelta, AgentModelMetrics, AgentReasoningEffort, AgentTokenUsage, AgentToolSchema, AgentWireToolCall} from '@momoki/agent-core';
import {requestOnce, normalizeBaseUrl, appendedUtf8Bytes, assertResponseBytes, isReadAbort, readErrorText, readResponseJson, utf8Bytes, readSseEvents, MAX_ERROR_BYTES, MAX_JSON_BYTES, redactCredentials} from './http/index.js';
import {authHeaders, chatCompletionsUrl} from './endpoints.js';
import type {ChatRequestMessage} from './wire.js';

export type StreamChatInput = {
    maxOutputTokens?: number;
    baseUrl: string;
    apiKey: string;
    model: string;
    reasoningEffort?: AgentReasoningEffort;
    messages: readonly ChatRequestMessage[];
    tools?: AgentToolSchema[];
};
export type StreamChatHandlers = {
    onDelta?: (text: string) => void;
    onReasoning?: (text: string) => void;
    signal?: AbortSignal;
    fetchImpl: typeof fetch;
    validateRequest?: () => void;
    materializeMessages?: (signal?: AbortSignal) => Promise<readonly ChatRequestMessage[]>;
};
export type StreamChatResult = ({metrics?: Omit<AgentModelMetrics, 'step'>; usage?: AgentTokenUsage}) & (
    | {ok: true; content: string; reasoning: string; via: 'stream' | 'json'; finishReason?: string; toolCalls?: AgentWireToolCall[]; unofferedToolNames?: string[]}
    | {ok: false; message: string; aborted?: boolean; finishReason?: string}
);

function pickReasoningText(source: {
    reasoning_content?: unknown;
    reasoning?: unknown
} | undefined): string | undefined {
    if (!source) return undefined;
    if (typeof source.reasoning_content === "string" && source.reasoning_content.length > 0) {
        return source.reasoning_content;
    }
    if (typeof source.reasoning === "string" && source.reasoning.length > 0) {
        return source.reasoning;
    }
    return undefined;
}

function pickContentText(source: { content?: unknown } | undefined): string | undefined {
    if (typeof source?.content === "string" && source.content.length > 0) {
        return source.content;
    }
    return undefined;
}

function formatHttpError(status: number, body: string): string {
    const trimmed = body.trim().slice(0, 200);
    if (status === 401 || status === 403) {
        return trimmed ? `鉴权失败（${status}）：${trimmed}` : `鉴权失败（${status}）`;
    }
    return trimmed ? `请求失败（${status}）：${trimmed}` : `请求失败（${status}）`;
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redactError(message: string, apiKey: string): string {
    return redactCredentials(message, apiKey).slice(0, 300);
}

function streamErrorMessage(data: string): string {
    try {
        const value: unknown = JSON.parse(data);
        if (record(value)) {
            const error = record(value.error) ? value.error : value;
            if (typeof error.message === "string") return error.message;
        }
    } catch { /* Providers may use plain-text error events. */
    }
    return data || "模型服务返回错误";
}

function readUsage(data: unknown): AgentTokenUsage | undefined {
    if (!record(data) || !record(data.usage)) return undefined;
    const usage: AgentTokenUsage = {};
    for (const [wire, name] of [["prompt_tokens", "inputTokens"], ["completion_tokens", "outputTokens"], ["total_tokens", "totalTokens"]] as const) {
        const value = data.usage[wire];
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) usage[name] = value;
    }
    const details = data.usage.prompt_tokens_details;
    const cached = record(details) ? details.cached_tokens : undefined;
    if (typeof cached === "number" && Number.isSafeInteger(cached) && cached >= 0 && (usage.inputTokens === undefined || cached <= usage.inputTokens)) usage.cachedInputTokens = cached;
    return Object.keys(usage).length ? usage : undefined;
}

function decodeCompletion(data: unknown, stream: boolean): {
    delta: StreamDelta;
    finishReason?: string;
    toolFragments?: unknown[];
} {
    if (!record(data)) throw new Error("模型返回了无效的响应格式");
    if (data.error != null) {
        const error = data.error;
        throw new Error(record(error) && typeof error.message === "string"
            ? error.message : typeof error === "string" ? error : "模型服务返回错误");
    }
    if (!Array.isArray(data.choices)) throw new Error("模型响应缺少 choices");
    if (stream && data.choices.length === 0 && record(data.usage)) return {delta: {}};
    const choice: unknown = data.choices[0];
    if (!record(choice)) throw new Error("模型响应缺少有效的回复");
    const source = stream ? (choice.delta ?? choice.message) : choice.message;
    if (!record(source)) throw new Error("模型回复格式无效");
    for (const name of ["content", "reasoning_content", "reasoning"]) {
        if (source[name] != null && typeof source[name] !== "string") {
            throw new Error("当前聊天仅支持文本回复");
        }
    }
    if (source.function_call != null) {
        throw new Error("模型请求了工具调用，当前执行尚未启用工具能力");
    }
    if (source.tool_calls != null && !Array.isArray(source.tool_calls)) throw new Error("工具调用格式无效");
    const finishReason = choice.finish_reason;
    if (finishReason != null && (typeof finishReason !== "string" || !finishReason)) {
        throw new Error("模型返回了无效的结束状态");
    }
    return {
        ...(Array.isArray(source.tool_calls) ? {toolFragments: source.tool_calls} : {}),
        delta: {
            ...(pickContentText(source) ? {content: pickContentText(source)} : {}),
            ...(pickReasoningText(source) ? {reasoning: pickReasoningText(source)} : {}),
        },
        ...(typeof finishReason === "string" ? {finishReason} : {}),
    };
}

/** Assemble bounded provider fragments; execution still validates strict tool arguments. */
function createToolAccumulator(tools?: AgentToolSchema[]) {
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    const unofferedByIndex = new Map<number, string>();
    let retainedBytes = 0;
    const callBytes = (call: {
        id: string;
        name: string;
        arguments: string
    }) => utf8Bytes(call.id) + utf8Bytes(call.name) + utf8Bytes(call.arguments);
    return {
        push(fragments: unknown[] | undefined, streaming: boolean) {
            if (!fragments?.length) return;
            if (!tools?.length) throw new Error("模型请求了工具调用，当前执行尚未启用工具能力");
            for (const [position, fragment] of fragments.entries()) {
                if (!record(fragment)) throw new Error("工具调用格式无效");
                const index = streaming ? fragment.index : position;
                if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= 16) throw new Error("工具调用索引无效或超过限制");
                const call = {...(calls.get(index) ?? {id: "", name: "", arguments: ""})};
                const beforeBytes = callBytes(call);
                if (fragment.type != null && fragment.type !== "function") throw new Error("不支持的工具调用类型");
                if (fragment.id != null) {
                    if (typeof fragment.id !== "string" || (call.id && call.id !== fragment.id)) throw new Error("工具调用标识冲突");
                    call.id = fragment.id;
                }
                if (fragment.function != null) {
                    if (!record(fragment.function)) throw new Error("工具调用函数格式无效");
                    for (const field of ["name", "arguments"] as const) {
                        const value = fragment.function[field];
                        if (value != null && typeof value !== "string") throw new Error("工具调用参数格式无效");
                        if (typeof value === "string") call[field] += value;
                    }
                }
                if (call.arguments.length > 32768 || call.name.length > 128 || call.id.length > 256) throw new Error("工具调用超过大小限制");
                retainedBytes += callBytes(call) - beforeBytes;
                calls.set(index, call);
                // A frame naming a tool this request never offered is not a wire
                // violation: it is recorded as a failed call and fed back to the model.
                if (call.name && call.id && tools && !tools.some((tool) => tool.function.name === call.name)) unofferedByIndex.set(index, call.name);
            }
        },
        retainedBytes(): number {
            return retainedBytes;
        },
        finish(): AgentWireToolCall[] | undefined {
            if (!calls.size) return undefined;
            const seen = new Set<string>();
            return [...calls.entries()].sort(([a], [b]) => a - b).map(([index, call], position) => {
                if (index !== position || !call.id || seen.has(call.id)) throw new Error("工具调用缺少标识或重复");
                seen.add(call.id);
                let args: unknown;
                try {
                    args = JSON.parse(call.arguments);
                } catch {
                    throw new Error("工具调用参数不是完整 JSON");
                }
                if (!record(args)) throw new Error("工具参数必须是对象");
                return {id: call.id, type: "function", function: {name: call.name, arguments: call.arguments}};
            });
        },
        /** Names the model called that this request never offered, in call order. */
        unofferedNames(): string[] {
            return [...unofferedByIndex.entries()].sort(([a], [b]) => a - b).map(([, name]) => name);
        },
    };
}

function completionResult(
    content: string,
    reasoning: string,
    via: "stream" | "json",
    finishReason?: string,
    toolCalls?: AgentWireToolCall[],
    unofferedToolNames?: string[],
): StreamChatResult {
    const metadata = finishReason ? {finishReason} : {};
    if (toolCalls?.length) {
        if (finishReason !== "tool_calls") return {ok: false, message: "工具调用缺少完整结束状态", ...metadata};
        return {
            ok: true,
            content,
            reasoning,
            via,
            toolCalls, ...(unofferedToolNames?.length ? {unofferedToolNames} : {}), ...metadata
        };
    }
    if (finishReason && finishReason !== "stop") {
        const message = finishReason === "length" ? "回复达到模型长度上限，内容未完成"
            : finishReason === "content_filter" ? "回复被模型内容过滤中断"
                : finishReason === "tool_calls" || finishReason === "function_call"
                    ? "模型请求了工具调用，当前执行尚未启用工具能力"
                    : "模型返回了未支持的结束状态";
        return {ok: false, message, ...metadata};
    }
    if (!content.trim()) return {ok: false, message: "模型未返回有效的回答内容", ...metadata};
    return {ok: true, content, reasoning, via, ...metadata};
}

function applyDeltaHandlers(
    handlers: StreamChatHandlers,
    delta: StreamDelta,
    acc: { content: string; reasoning: string },
): void {
    handlers.signal?.throwIfAborted();
    if (delta.reasoning) {
        acc.reasoning += delta.reasoning;
        handlers.onReasoning?.(delta.reasoning);
    }
    handlers.signal?.throwIfAborted();
    if (delta.content) {
        acc.content += delta.content;
        handlers.onDelta?.(delta.content);
    }
}

/** One POST per attempt. A JSON response to that same request is supported. */
export async function streamChatCompletions(
    input: StreamChatInput,
    handlers: StreamChatHandlers,
): Promise<StreamChatResult> {
    const base = normalizeBaseUrl(input.baseUrl);
    const apiKey = input.apiKey.trim();
    const model = input.model.trim();
    if (!base) return {ok: false, message: "请填写 Base URL"};
    if (!apiKey) return {ok: false, message: "请填写 API Key"};
    if (!model) return {ok: false, message: "请选择模型"};
    if (input.messages.length === 0) return {ok: false, message: "消息不能为空"};

    const fetchImpl = handlers.fetchImpl;
    const signal = handlers.signal;
    const startedAt = Date.now();
    let firstTokenAt: number | undefined;
    let usage: AgentTokenUsage | undefined;
    const observe = (delta: StreamDelta, tools?: unknown[]) => {
        if (firstTokenAt === undefined && (delta.content || delta.reasoning || tools?.length)) firstTokenAt = Date.now();
    };
    const withMetrics = (result: StreamChatResult): StreamChatResult => ({
        ...result, ...(usage ? {usage} : {}),
        metrics: {
            startedAt, ...(firstTokenAt !== undefined ? {firstTokenAt} : {}),
            endedAt: Date.now(), ...(usage ? {usage} : {})
        },
    });

    try {
        signal?.throwIfAborted();
        handlers.validateRequest?.();
        const res = await requestOnce(chatCompletionsUrl(base), {
            method: "POST",
            headers: authHeaders(apiKey),
            body: JSON.stringify({
                model, ...(input.maxOutputTokens ? (/^(gpt-|o[1-9])/.test(model) ? {max_completion_tokens: input.maxOutputTokens} : {max_tokens: input.maxOutputTokens}) : {}),
                messages: await (handlers.materializeMessages?.(signal) ?? input.messages),
                stream: true, ...(input.reasoningEffort !== undefined ? {reasoning_effort: input.reasoningEffort} : {}), ...(input.tools?.length ? {tools: input.tools} : {})
            }),
        }, {fetchImpl, signal, credentials: "same-origin", redirect: "follow"});
        signal?.throwIfAborted();
        if (!res.ok) {
            const body = await readErrorText(res, MAX_ERROR_BYTES, signal);
            signal?.throwIfAborted();
            return withMetrics({ok: false, message: formatHttpError(res.status, redactError(body, apiKey))});
        }

        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("text/event-stream")) {
            const data = await readResponseJson(res, MAX_JSON_BYTES, signal);
            signal?.throwIfAborted();
            usage = readUsage(data);
            const {delta, finishReason, toolFragments} = decodeCompletion(data, false);
            const calls = createToolAccumulator(input.tools);
            calls.push(toolFragments, false);
            const acc = {content: "", reasoning: ""};
            assertResponseBytes(utf8Bytes(delta.content ?? "") + utf8Bytes(delta.reasoning ?? "") + calls.retainedBytes(), MAX_JSON_BYTES);
            applyDeltaHandlers(handlers, delta, acc);
            signal?.throwIfAborted();
            return withMetrics(completionResult(acc.content, acc.reasoning, "json", finishReason ? redactError(finishReason, apiKey) : undefined, calls.finish(), calls.unofferedNames()));
        }
        if (!res.body) throw new Error("模型返回了空的响应流");

        const calls = createToolAccumulator(input.tools);
        let completed = false;
        let finishReason: string | undefined;
        let outputBytes = 0;
        const acc = {content: "", reasoning: ""};
        const dispatchEvent = (data: string, type: string) => {
            if (!data && type !== "error") return;
            if (type === "error") throw new Error(streamErrorMessage(data));
            if (data.trim() === "[DONE]") {
                completed = true;
                return;
            }
            let value: unknown;
            try {
                value = JSON.parse(data);
            } catch {
                throw new Error("模型返回了无效的流事件");
            }
            usage = readUsage(value) ?? usage;
            const frame = decodeCompletion(value, true);
            observe(frame.delta, frame.toolFragments);
            if (finishReason && (frame.delta.content || frame.delta.reasoning || frame.finishReason || frame.toolFragments?.length)) {
                throw new Error("模型在结束状态后继续返回内容");
            }
            calls.push(frame.toolFragments, true);
            const nextBytes = outputBytes + appendedUtf8Bytes(acc.content, frame.delta.content ?? "") + appendedUtf8Bytes(acc.reasoning, frame.delta.reasoning ?? "");
            assertResponseBytes(nextBytes + calls.retainedBytes(), MAX_JSON_BYTES);
            outputBytes = nextBytes;
            applyDeltaHandlers(handlers, frame.delta, acc);
            if (frame.finishReason) finishReason = redactError(frame.finishReason, apiKey);
        };
        for await (const event of readSseEvents(res, signal)) {
            dispatchEvent(event.data, event.event);
            if (completed) break;
        }
        signal?.throwIfAborted();
        if (!completed && !finishReason) throw new Error("回复流意外中断，已保留收到的内容");
        return withMetrics(completionResult(acc.content, acc.reasoning, "stream", finishReason, calls.finish(), calls.unofferedNames()));
    } catch (err) {
        if (isReadAbort(err, signal)) {
            return withMetrics({ok: false, message: "已停止", aborted: true});
        }
        return withMetrics({ok: false, message: redactError(err instanceof Error ? err.message : "网络错误", apiKey)});
    }
}
