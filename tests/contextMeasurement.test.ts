import {describe, expect, it, vi} from "vitest";
import {estimateTokens} from "@momoki/agent-core";
import {db} from "@/platform/product/store";
import {createChatThread} from "@/features/agent/commands/chat";
import {beginAgentRun} from "@/features/agent/commands/agentRuns";
import {updateContextPolicy} from "@/features/agent/commands/contextSettings";
import {readAgentContextPreview} from "@/features/agent/commands/agentContextPreview";
import {executeChatRun} from "@/features/agent/runtime/runChat";
import {budgetContext, runBudgetMeasure} from "@/features/agent/runtime/contextPlanner";
import {
    createContextAnchor, estimateImageTokens, estimateRequestTokens, IMAGE_TOKEN_CAP, IMAGE_TOKEN_FLOOR, measureContext,
    usableAnchor, wireMessages, wireTools,
} from "@/features/agent/runtime/contextMeasurement";
import {estimateContextUsage} from "@/features/agent/runtime/contextUsage";
import {streamChatCompletions} from "@/features/agent/providers/chatStream";
import {streamResponses} from "@/features/agent/providers/responsesStream";
import type {AgentRequestMessage, AgentToolSchema} from "@/features/agent/models/agent";
import type {ConnectorConfig} from "@/features/settings/models/connector";

const connector: ConnectorConfig = {id: "cx", name: "test", definitionId: "openai-compatible", baseUrl: "https://example.test/v1", apiKey: "secret-key", updatedAt: "2026-01-01"};
const tool = (name: string): AgentToolSchema => ({type: "function", function: {name, description: `${name} reads project data for the assistant`, parameters: {type: "object", properties: {id: {type: "string", description: "entity id"}}, required: ["id"]}}});
const image = {projectId: "p", mediaId: "m1", filename: "a.png", mimeType: "image/png", size: 300_000};
const referenceInput = {projectId: "p", references: [], images: [image], coverage: [{referenceId: "r", revision: 1, filename: "very-long-filename-that-used-to-be-serialized.txt", kind: "text", includedChunkIndices: [0, 1, 2], totalChunks: 3, includedCharacters: 900, partial: false, warnings: []}]};
const fixtures: Record<string, AgentRequestMessage[]> = {
    "ascii prose": [{role: "system", content: "You are a careful production assistant."}, {role: "user", content: "Please outline the second act of the screenplay with clear beats. ".repeat(40)}],
    "chinese prose": [{role: "system", content: "你是创作助手。"}, {role: "user", content: "请梳理第二幕的节奏，并给出每个场景的目的与冲突。".repeat(40)}],
    "json tool result": [{role: "system", content: "s"}, {role: "user", content: "q"}, {role: "assistant", content: "", tool_calls: [{id: "c1", type: "function", function: {name: "overview", arguments: '{"id":"e1"}'}}]}, {role: "tool", tool_call_id: "c1", content: JSON.stringify({items: Array.from({length: 40}, (_, i) => ({id: `shot_${i}`, title: `Shot ${i}`, status: "ready"}))})}],
};

async function capture(call: (fetchImpl: typeof fetch) => Promise<unknown>) {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({choices: [{message: {content: "ok"}, finish_reason: "stop"}], status: "completed", output: [{type: "message", role: "assistant", content: [{type: "output_text", text: "ok", annotations: []}]}]});
    });
    await call(fetchImpl);
    return body!;
}

describe("what the context figure measures", () => {
    it("matches the serialized Chat Completions payload within 2% for every fixture", async () => {
        for (const [name, messages] of Object.entries(fixtures)) {
            const tools = [tool("overview"), tool("search")];
            const body = await capture(fetchImpl => streamChatCompletions({baseUrl: connector.baseUrl, apiKey: "k", model: "m", messages: messages as never, tools}, {fetchImpl}));
            const actual = estimateTokens(JSON.stringify(body.messages)) + estimateTokens(JSON.stringify(body.tools));
            const estimate = estimateRequestTokens(messages, tools, "chat-completions");
            expect(Math.abs(estimate - actual) / actual, name).toBeLessThanOrEqual(0.02);
        }
    });
    it("matches the serialized Responses payload (flat tools, converted items) within 2%", async () => {
        const tools = [tool("overview"), tool("search")];
        const messages = fixtures["json tool result"];
        const body = await capture(fetchImpl => streamResponses({baseUrl: connector.baseUrl, apiKey: "k", model: "gpt-5.6-luna", connectorDefinitionId: "openai-compatible", messages: messages as never, tools}, {fetchImpl}));
        const actual = estimateTokens(JSON.stringify(body.input)) + estimateTokens(JSON.stringify(body.tools));
        const estimate = estimateRequestTokens(messages, tools, "responses");
        expect(Math.abs(estimate - actual) / actual).toBeLessThanOrEqual(0.02);
        expect(wireTools(tools, "responses")[0]).toMatchObject({type: "function", name: "overview", strict: false});
    });
    it("does not serialize internal reference metadata and prices images separately and boundedly", () => {
        const plain: AgentRequestMessage = {role: "user", content: "see attached\n\n[envelope text]"};
        const withInput: AgentRequestMessage = {...plain, referenceInput};
        const base = estimateRequestTokens([plain], [], "chat-completions");
        // The old envelope estimate counted referenceInput JSON on top of the already-embedded envelope.
        expect(estimateTokens(JSON.stringify([withInput]))).toBeGreaterThan(estimateTokens(JSON.stringify([plain])) + 30);
        expect(estimateRequestTokens([withInput], [], "chat-completions")).toBe(base + estimateImageTokens(image));
        expect(JSON.stringify(wireMessages([withInput], "chat-completions"))).not.toContain("referenceInput");
        expect(JSON.stringify(wireMessages([withInput], "responses"))).not.toContain("includedChunkIndices");
        expect(estimateImageTokens({size: 10})).toBe(IMAGE_TOKEN_FLOOR);
        expect(estimateImageTokens({size: 10_000_000})).toBe(IMAGE_TOKEN_CAP);
        expect(estimateImageTokens({size: 300_000})).toBeGreaterThan(IMAGE_TOKEN_FLOOR);
        expect(estimateImageTokens({size: 300_000})).toBeLessThan(IMAGE_TOKEN_CAP);
        // Category composition uses the same image price as the total.
        const usage = estimateContextUsage({instructions: "", skillInstructions: "", tools: [], messages: [withInput]});
        expect(usage.total).toBeGreaterThanOrEqual(estimateImageTokens(image));
        expect(usage.total).toBeLessThan(estimateImageTokens(image) + 40);
    });
});

describe("provider-reported baseline", () => {
    // A synthetic provider tokenizer that is 0.62 tokens per CJK/JSON-heavy character: the heuristic overshoots it.
    const providerTokens = (messages: AgentRequestMessage[]) => Math.round(JSON.stringify(wireMessages(messages, "chat-completions")).length * 0.62);
    const scope = {model: "m", definitionId: "openai-compatible", protocol: "chat-completions" as const};
    const history = fixtures["chinese prose"];
    const next = [...history, {role: "assistant" as const, content: "好的，已梳理。".repeat(30)}, {role: "user" as const, content: "继续第三幕。"}];

    it("anchors on the reported size and adds only the estimated delta, beating a pure estimate", () => {
        const anchor = createContextAnchor({step: 1, ...scope, reportedTokens: providerTokens(history), messages: history, tools: []})!;
        const truth = providerTokens(next);
        const anchored = measureContext({messages: next, tools: [], protocol: "chat-completions", anchor, scope, capacity: 8000});
        const estimated = measureContext({messages: next, tools: [], protocol: "chat-completions", capacity: 8000});
        expect(anchored.source).toBe("reported");
        expect(anchored.reportedTokens).toBe(anchor.reportedTokens);
        expect(anchored.usedTokens).toBe(anchor.reportedTokens + anchored.deltaTokens!);
        expect(estimated.source).toBe("estimated");
        expect(Math.abs(anchored.usedTokens - truth)).toBeLessThan(Math.abs(estimated.usedTokens - truth));
        // Stated tolerance: the delta stays a heuristic (CJK overshoots), the baseline is exact.
        expect(Math.abs(anchored.usedTokens - truth) / truth).toBeLessThanOrEqual(0.25);
        expect(Math.abs(estimated.usedTokens - truth) / truth).toBeGreaterThan(0.5);
        // The safety margin applies only to the estimated delta.
        expect(anchored.margin).toBe(Math.ceil(anchored.deltaTokens! * 1.25) - anchored.deltaTokens!);
    });
    it("discards an anchor that cannot describe the request", () => {
        const anchor = createContextAnchor({step: 1, ...scope, summaryId: "s1", reportedTokens: 900, messages: history, tools: []})!;
        const ok = {...scope, summaryId: "s1"};
        expect(usableAnchor(anchor, ok)).toBe(anchor);
        expect(usableAnchor(anchor, {...ok, model: "other"})).toBeUndefined();
        expect(usableAnchor(anchor, {...ok, definitionId: "aihubmix"})).toBeUndefined();
        expect(usableAnchor(anchor, {...ok, protocol: "responses"})).toBeUndefined();
        expect(usableAnchor(anchor, {...ok, summaryId: undefined})).toBeUndefined();
        expect(usableAnchor(undefined, ok)).toBeUndefined();
        expect(createContextAnchor({step: 1, ...scope, reportedTokens: undefined, messages: history, tools: []})).toBeUndefined();
        // A request that shrank (compaction/pruning) is estimated afresh, never "reported minus".
        const shrunk = measureContext({messages: history.slice(0, 1), tools: [], protocol: "chat-completions", anchor, scope: ok});
        expect(shrunk.source).toBe("estimated");
    });
    it("uses one scale for the ring and the trigger and hides the ratio when the window is unknown", () => {
        for (const filler of [10, 400, 1500, 2600, 4000]) {
            const messages: AgentRequestMessage[] = [{role: "user", content: "x".repeat(filler * 4)}];
            const budget = budgetContext(messages, [], 8192);
            expect(budget.needsCompression).toBe(budget.usedTokens >= budget.triggerTokens!);
            expect(budget.overBudget).toBe(budget.usedTokens > budget.limitTokens!);
        }
        const unknown = budgetContext([{role: "user", content: "x".repeat(100000)}], [], undefined);
        expect(unknown).toMatchObject({threshold: undefined, triggerTokens: undefined, needsCompression: false, overBudget: false});
    });
    it("records the provider-reported size with the run and shows it on the idle thread; a model switch falls back to estimation", async () => {
        const thread = await createChatThread();
        await updateContextPolicy(thread.id, {autoCompress: true, limitHistory: false, historyMessageCount: 20, customContextTokens: 16000});
        const run = await beginAgentRun({threadId: thread.id, connector, model: "unknown-model", content: "你好", interactionMode: "conversation"});
        const fetcher = vi.fn(async () => Response.json({choices: [{message: {content: "收到"}, finish_reason: "stop"}], usage: {prompt_tokens: 777, completion_tokens: 3, total_tokens: 780}}));
        await executeChatRun(run, connector.apiKey, new AbortController(), fetcher);
        const saved = (await db.agentRuns.get(run.id))!;
        expect(saved.contextAnchor).toMatchObject({step: 1, model: "unknown-model", definitionId: "openai-compatible", protocol: "chat-completions", reportedTokens: 777});
        expect(saved.contextAnchor!.estimatedTokens).toBe(estimateRequestTokens(run.requestMessages, [], "chat-completions"));
        const read = await readAgentContextPreview({threadId: thread.id, draft: "继续", attachments: [], model: "unknown-model", providerId: "openai-compatible", metadata: {source: "provider", contextWindow: 16000}});
        if (read.status !== "ready") throw new Error(read.status);
        expect(read.facts.lastRun?.id).toBe(run.id);
        const anchor = read.facts.lastRun!.contextAnchor;
        const scope = {model: "unknown-model", definitionId: "openai-compatible", protocol: "chat-completions" as const};
        const request: AgentRequestMessage[] = [...run.requestMessages, {role: "assistant", content: "收到"}, {role: "user", content: "继续"}];
        const same = budgetContext(request, read.facts.toolSchemas, 16000, false, 0, {protocol: "chat-completions", anchor, scope});
        expect(same.source).toBe("reported");
        expect(same.usedTokens).toBeGreaterThanOrEqual(777);
        const switched = budgetContext(request, read.facts.toolSchemas, 16000, false, 0, {protocol: "chat-completions", anchor, scope: {...scope, model: "other-model"}});
        expect(switched.source).toBe("estimated");
        // The in-run scope reads the same frozen facts.
        expect(runBudgetMeasure(saved).anchor).toEqual(saved.contextAnchor);
    });
});
