import {requestOnce, normalizeBaseUrl, appendedUtf8Bytes, assertResponseBytes, isReadAbort, readErrorText, readResponseJson, utf8Bytes, readSseEvents, MAX_ERROR_BYTES, MAX_JSON_BYTES, redactCredentials} from './http/index.js';
import type {AgentTokenUsage, AgentWireToolCall} from '@momoki/agent-core';
import type {StreamChatInput, StreamChatHandlers, StreamChatResult} from './chatCompletions.js';
import type {ChatMessage, ResponseItem, ResponseRequestItem} from './wire.js';
import {authHeaders} from './endpoints.js';

export type ResponsesResult = StreamChatResult & {responseOutput?: ResponseItem[]};
export type ResponsesInput = Omit<StreamChatInput, 'messages'> & {messages: readonly ChatMessage[]; responseItems?: readonly ResponseItem[]};
export type ResponsesHandlers = Omit<StreamChatHandlers, 'materializeMessages'> & {
    materializeItems?: (signal?: AbortSignal) => Promise<readonly ResponseRequestItem[]>;
};
const MAX_ENVELOPE_SIZE = MAX_JSON_BYTES;
const RESPONSE_STATUSES = new Set(["completed", "failed", "incomplete", "in_progress", "queued", "cancelled"]);

function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max = MAX_ENVELOPE_SIZE): string {
    if (typeof value !== "string" || value.length > max) throw new Error("Responses 返回了无效或过大的字段");
    return value;
}

function id(value: unknown): string {
    const result = text(value, 256);
    if (!result) throw new Error("Responses 缺少调用标识");
    return result;
}

function usageOf(value: unknown): AgentTokenUsage | undefined {
    if (!record(value)) return;
    const usage: AgentTokenUsage = {};
    for (const [wire, name] of [["input_tokens", "inputTokens"], ["output_tokens", "outputTokens"], ["total_tokens", "totalTokens"]] as const) {
        const count = value[wire];
        if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) usage[name] = count;
    }
    const details = value.input_tokens_details;
    const cached = record(details) ? details.cached_tokens : undefined;
    if (typeof cached === "number" && Number.isSafeInteger(cached) && cached >= 0 && (usage.inputTokens === undefined || cached <= usage.inputTokens)) usage.cachedInputTokens = cached;
    return Object.keys(usage).length ? usage : undefined;
}

export function toResponseInput(messages: readonly ChatMessage[]): ResponseItem[] {
    return messages.flatMap((message): ResponseItem[] => {
        if (message.role === "tool") return [{
            type: "function_call_output",
            call_id: message.tool_call_id,
            output: message.content
        }];
        const items: ResponseItem[] = message.content ? [{
            type: "message",
            role: message.role,
            content: message.content
        }] : [];
        if (message.role === "assistant") for (const call of message.tool_calls ?? []) items.push({
            type: "function_call",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments
        });
        return items;
    });
}

/** Final output is authoritative. Incomplete argument deltas never dispatch a tool. */
export function decodeResponseOutput(output: unknown, tools: ResponsesInput["tools"]): {
    items: ResponseItem[];
    content: string;
    reasoning: string;
    calls: AgentWireToolCall[];
    unofferedToolNames: string[]
} {
    if (!Array.isArray(output) || output.length > 256 || JSON.stringify(output).length > MAX_ENVELOPE_SIZE) throw new Error("Responses 输出信封无效或超过限制");
    let content = "", reasoning = "";
    const calls: AgentWireToolCall[] = [];
    const unofferedToolNames: string[] = [];
    const ids = new Set<string>();
    const items = output.map((item): ResponseItem => {
        if (!record(item)) throw new Error("Responses 输出项无效");
        if (item.status != null && item.status !== "completed") throw new Error("Responses 输出项尚未完成");
        const itemId = item.id === undefined ? undefined : id(item.id);
        if (itemId && ids.has(itemId)) throw new Error("Responses 输出标识重复");
        if (itemId) ids.add(itemId);
        if (item.type === "reasoning") {
            if (!Array.isArray(item.summary)) throw new Error("Responses 推理摘要格式无效");
            const summary = item.summary.map((part) => {
                if (!record(part) || part.type !== "summary_text") throw new Error("Responses 推理摘要格式无效");
                const value = text(part.text);
                reasoning += value;
                return {type: "summary_text" as const, text: value};
            });
            const encrypted = item.encrypted_content == null ? undefined : text(item.encrypted_content);
            // LobeHub drops id-only reasoning in stateless replay: it cannot be looked up.
            return {
                type: "reasoning", ...(encrypted && itemId ? {id: itemId} : {}),
                summary, ...(encrypted ? {encrypted_content: encrypted} : {})
            };
        }
        if (item.type === "message") {
            if (item.role !== "assistant" || !Array.isArray(item.content)) throw new Error("Responses 回复格式无效");
            const parts = item.content.map((part) => {
                if (!record(part) || part.type !== "output_text") throw new Error("模型拒绝回复或返回了不支持的非文本内容");
                const value = text(part.text);
                content += value;
                return {type: "output_text" as const, text: value, annotations: []};
            });
            return {
                type: "message",
                role: "assistant",
                content: parts, ...(itemId ? {id: itemId} : {}),
                status: "completed", ...(typeof item.phase === "string" ? {phase: text(item.phase, 64)} : {})
            };
        }
        if (item.type === "function_call") {
            const callId = id(item.call_id), name = text(item.name, 128), args = text(item.arguments, 32768);
            // A name this request never offered is recorded as a failed call, not a
            // whole-run wire failure; duplicate, missing and oversized ids still reject.
            if (calls.length >= 16 || calls.some((call) => call.id === callId)) throw new Error("Responses 请求了重复或过多的工具");
            let parsed: unknown;
            try {
                parsed = JSON.parse(args);
            } catch {
                throw new Error("工具调用参数不是完整 JSON");
            }
            if (!record(parsed)) throw new Error("工具参数必须是对象");
            if (tools && !tools.some((tool) => tool.function.name === name)) unofferedToolNames.push(name);
            calls.push({id: callId, type: "function", function: {name, arguments: args}});
            return {
                type: "function_call",
                call_id: callId,
                name,
                arguments: args, ...(itemId ? {id: itemId} : {}),
                status: "completed"
            };
        }
        throw new Error("Responses 返回了未启用的输出类型");
    });
    return {items, content, reasoning, calls, unofferedToolNames};
}

/** Stateless Responses adapter: one POST, local continuation, no automatic fallback. */
export async function streamResponses(input: ResponsesInput, handlers: ResponsesHandlers): Promise<ResponsesResult> {
    const base = normalizeBaseUrl(input.baseUrl), apiKey = input.apiKey.trim(), model = input.model.trim();
    const signal = handlers.signal;
    const startedAt = Date.now();
    let firstTokenAt: number | undefined, usage: AgentTokenUsage | undefined;
    let content = "", reasoning = "", outputBytes = 0;
    const redact = (value: string) => redactCredentials(value, apiKey).slice(0, 300);
    const result = (value: ResponsesResult): ResponsesResult => ({
        ...value, ...(usage ? {usage} : {}),
        metrics: {
            startedAt,
            endedAt: Date.now(), ...(firstTokenAt === undefined ? {} : {firstTokenAt}), ...(usage ? {usage} : {})
        }
    });
    const emit = (kind: "content" | "reasoning", value: string, streaming = true) => {
        signal?.throwIfAborted();
        if (!value) return;
        const nextBytes = outputBytes + appendedUtf8Bytes(kind === "content" ? content : reasoning, value);
        assertResponseBytes(nextBytes, MAX_ENVELOPE_SIZE);
        if (content.length + reasoning.length + value.length > MAX_ENVELOPE_SIZE) throw new Error("Responses 输出超过限制");
        outputBytes = nextBytes;
        if (streaming && firstTokenAt === undefined) firstTokenAt = Date.now();
        if (kind === "content") {
            content += value;
            handlers.onDelta?.(value);
        } else {
            reasoning += value;
            handlers.onReasoning?.(value);
        }
        signal?.throwIfAborted();
    };
    const finish = (response: unknown, via: "json" | "stream"): ResponsesResult => {
        if (!record(response)) throw new Error("Responses 缺少完整结果");
        usage = usageOf(response.usage) ?? usage;
        if (response.status !== "completed" || response.error != null) {
            const detail = record(response.error) && typeof response.error.message === "string" ? response.error.message : response.status === "incomplete" ? "回复达到限制或被过滤，内容未完成" : "Responses 执行失败或尚未完成";
            return result({
                ok: false,
                message: redact(detail),
                // Status is diagnostic metadata: never copy arbitrary provider text into saved runs.
                finishReason: typeof response.status === "string" && RESPONSE_STATUSES.has(response.status) ? response.status : undefined
            });
        }
        const parsed = decodeResponseOutput(response.output, input.tools);
        assertResponseBytes(utf8Bytes(JSON.stringify(response.output)), MAX_ENVELOPE_SIZE);
        if (!parsed.content.startsWith(content) || !parsed.reasoning.startsWith(reasoning)) throw new Error("Responses 最终内容与流事件不一致");
        // A terminal envelope is a complete payload, not evidence of first-token
        // latency. Only actual delta events establish streaming throughput timing.
        emit("reasoning", parsed.reasoning.slice(reasoning.length), false);
        emit("content", parsed.content.slice(content.length), false);
        if (!parsed.calls.length && !parsed.content.trim()) throw new Error("模型未返回有效的回答内容");
        return result({
            ok: true,
            content,
            reasoning,
            via,
            finishReason: parsed.calls.length ? "tool_calls" : "stop", ...(parsed.calls.length ? {toolCalls: parsed.calls} : {}),
            ...(parsed.unofferedToolNames.length ? {unofferedToolNames: parsed.unofferedToolNames} : {}),
            responseOutput: parsed.items
        });
    };
    try {
        signal?.throwIfAborted();
        if (!base || !apiKey || !model) throw new Error("请配置连接、API Key 和模型");
        if (!input.messages.length && !input.responseItems?.length) throw new Error("消息不能为空");
        handlers.validateRequest?.();
        const res = await requestOnce(`${base}/responses`, {
            method: "POST", headers: authHeaders(apiKey),
            body: JSON.stringify({
                model, ...(input.maxOutputTokens ? {max_output_tokens: input.maxOutputTokens} : {}),
                input: await (handlers.materializeItems?.(signal) ?? input.responseItems ?? toResponseInput(input.messages)),
                stream: true,
                store: false,
                include: ["reasoning.encrypted_content"],
                ...(input.reasoningEffort !== undefined ? {
                    reasoning: {
                        effort: input.reasoningEffort,
                        summary: "auto"
                    }
                } : {reasoning: {summary: "auto"}}),
                ...(input.tools?.length ? {
                    tools: input.tools.map((tool) => ({
                        type: "function", ...tool.function,
                        strict: false
                    }))
                } : {}),
            }),
        }, {fetchImpl: handlers.fetchImpl, signal, credentials: "same-origin", redirect: "follow"});
        if (signal?.aborted) {
            await res.body?.cancel().catch(() => undefined);
            signal.throwIfAborted();
        }
        if (!res.ok) return result({
            ok: false,
            message: `请求失败（${res.status}）：${redact(await readErrorText(res, MAX_ERROR_BYTES, signal))}`
        });
        if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) return finish(await readResponseJson(res, MAX_JSON_BYTES, signal), "json");
        if (!res.body) throw new Error("Responses 返回了空的响应流");
        let terminal: ResponsesResult | undefined;
        const dispatch = (data: string, name: string) => {
            if (!data || data.trim() === "[DONE]") return;
            const value: unknown = JSON.parse(data);
            if (!record(value) || typeof value.type !== "string") throw new Error("Responses 流事件无效");
            if (name && name !== value.type) throw new Error("Responses 流事件类型不一致");
            if (value.type === "error") throw new Error(typeof value.message === "string" ? value.message : "Responses 返回错误");
            if (["response.completed", "response.failed", "response.incomplete"].includes(value.type)) {
                if (!record(value.response) || typeof value.response.status !== "string" || value.type !== `response.${value.response.status}`) throw new Error("Responses 结束事件状态不一致");
                terminal = finish(value.response, "stream");
                return;
            }
            if (value.type === "response.output_text.delta") emit("content", text(value.delta));
            if (value.type === "response.reasoning_summary_text.delta") emit("reasoning", text(value.delta));
            // Never render raw reasoning_text or encrypted_content. Tool argument
            // fragments are accepted only via the complete terminal output envelope.
            if (content.length + reasoning.length > MAX_ENVELOPE_SIZE) throw new Error("Responses 输出超过限制");
        };
        for await (const event of readSseEvents(res, signal)) {
            dispatch(event.data, event.event);
            if (terminal) break;
        }
        signal?.throwIfAborted();
        if (!terminal) throw new Error("Responses 回复流意外中断，已保留收到的内容");
        return terminal;
    } catch (error) {
        return result(isReadAbort(error, signal) ? {
            ok: false,
            message: "已停止",
            aborted: true
        } : {ok: false, message: redact(error instanceof Error ? error.message : "Responses 请求失败")});
    }
}
