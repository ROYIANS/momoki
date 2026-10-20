import {afterEach, describe, expect, it, vi} from "vitest";
import {replaceContinuationBase} from "@momoki/agent-core";
import {db} from "@/platform/product/store";
import {createChatThread} from "@/features/agent/commands/chat";
import {beginAgentRun} from "@/features/agent/commands/agentRuns";
import {executeChatRun} from "@/features/agent/runtime/runChat";
import {injectSteerInputs} from "@/features/agent/commands/agentSteer";
import {enqueueUserInput, listPendingInputs, setPendingMode} from "@/features/agent/commands/agentPendingInputs";
import {resolveAgentToolApproval} from "@/features/agent/commands/agentTools";
import {nowIso} from "@/platform/identity";
import type {AgentRun, AgentToolCall, AgentWireToolCall} from "@/features/agent/models/agent";
import type {AgentPendingInput, AgentPendingInputSubmit} from "@/features/agent/models/agentPendingInput";
import type {ConnectorConfig} from "@/features/settings/models/connector";

const connector: ConnectorConfig = {protocol: "openai-compatible", id: "local", definitionId: "openai-compatible", baseUrl: "https://model.test/v1", apiKey: "test-secret", updatedAt: "2026-09-22"};
const submit: AgentPendingInputSubmit = {connector: {id: "local", definitionId: "openai-compatible", baseUrl: "https://model.test/v1"}, model: "fixture", interactionMode: "smart", taskMode: false};
const wire = (name: string, args: unknown, id = name): AgentWireToolCall => ({id, type: "function", function: {name, arguments: JSON.stringify(args)}});
let seq = 0;
const admission = () => {seq += 1; return {runId: `qrun-${seq}`, userMessageId: `qu-${seq}`, assistantMessageId: `qa-${seq}`};};

function reply(protocol: AgentRun["protocol"], content: string, calls: AgentWireToolCall[] = []) {
    return protocol === "responses"
        ? Response.json({id: "reply", status: "completed", output: [
            ...(content ? [{type: "message", role: "assistant", status: "completed", content: [{type: "output_text", text: content, annotations: []}]}] : []),
            ...calls.map(call => ({type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments, status: "completed"})),
        ]})
        : Response.json({choices: [{message: {content, ...(calls.length ? {tool_calls: calls} : {})}, finish_reason: calls.length ? "tool_calls" : "stop"}]});
}

async function begin(protocol: AgentRun["protocol"] = "chat-completions", patch: Partial<AgentRun> = {}) {
    const thread = await createChatThread();
    const initial = await beginAgentRun({threadId: thread.id, connector, model: protocol === "responses" ? "gpt-5.6-luna" : "fixture", content: "先看一下工作区"});
    expect(initial.protocol).toBe(protocol);
    const run: AgentRun = {...initial, permissionMode: "full", enabledToolNames: ["workspace_overview"], toolLoading: undefined, ...patch};
    await db.agentRuns.put(run);
    return run;
}

async function steer(threadId: string, content: string, mode: "next-turn" | "next-step" = "next-step") {
    const row = await enqueueUserInput({threadId, content, admission: admission(), submit});
    return mode === "next-step" ? setPendingMode(row.id, row.revision, "next-step") : row;
}

function messageTexts(body: string) {
    return JSON.parse(body).messages as {role: string; content?: string; tool_call_id?: string}[];
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("next-step injection at the model loop boundary", () => {
    it.each(["chat-completions", "responses"] as const)("delivers a steered message after the tool results and before the next request under %s", async protocol => {
        const run = await begin(protocol);
        const bodies: string[] = [];
        let count = 0;
        let queued!: AgentPendingInput;
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
            bodies.push(String(init?.body)); count++;
            // The user steers while the first request is still in flight.
            if (count === 1) queued = await steer(run.threadId, "顺便看看 IP 列表");
            if (count === 1) return reply(protocol, "", [wire("workspace_overview", {})]);
            return reply(protocol, count === 2 ? "已经看过工作区。" : "完成。");
        });
        await executeChatRun(run, connector.apiKey, new AbortController(), fetchImpl);
        const saved = (await db.agentRuns.get(run.id))!;
        expect(saved.status, saved.error).toBe("completed");
        // The steered row did not make the run stale: the finishing check still ran on the following step.
        expect(saved.finishingCheck).toMatchObject({step: 2});
        expect(bodies.length).toBeGreaterThanOrEqual(2);
        const second = JSON.parse(bodies[1]);
        if (protocol === "responses") {
            const input = second.input as {type: string; role?: string; content?: unknown}[];
            const call = input.findIndex(item => item.type === "function_call");
            const output = input.findIndex(item => item.type === "function_call_output");
            const steered = input.findIndex(item => item.type === "message" && item.role === "user" && JSON.stringify(item.content).includes("顺便看看 IP 列表"));
            expect([call, output, steered]).toSatisfy(([a, b, c]: number[]) => a >= 0 && b > a && c > b);
        } else {
            const messages = messageTexts(bodies[1]);
            const assistant = messages.findIndex(item => item.role === "assistant" && !!item.tool_call_id === false && JSON.stringify(item).includes("tool_calls"));
            const tool = messages.findIndex(item => item.role === "tool");
            const steered = messages.findIndex(item => item.role === "user" && item.content === "顺便看看 IP 列表");
            expect([assistant, tool, steered]).toSatisfy(([a, b, c]: number[]) => a >= 0 && b > a && c > b);
        }
        for (const body of bodies) expect(body).not.toContain("sourceQueueItemId");
        expect(await db.agentPendingInputs.get(queued.id)).toBeUndefined();
        const steeredRow = await db.chatMessages.get(queued.userMessageId);
        expect(steeredRow).toMatchObject({role: "user", content: "顺便看看 IP 列表", status: "complete", steeredIntoRunId: run.id});
        expect(Date.parse(steeredRow!.createdAt)).toBeGreaterThan(Date.parse(saved.createdAt));
        // The frozen request snapshot (base prefix) is untouched by steering.
        expect(saved.requestMessages).toEqual(run.requestMessages);
    });

    it("keeps the injected suffix when the continuation base is replaced by compaction", () => {
        const base = [{role: "user" as const, content: "原始提问"}];
        const current = [...base, {role: "assistant" as const, content: "半程"}, {role: "user" as const, content: "插队", sourceQueueItemId: "pin-1"}];
        expect(replaceContinuationBase(current, base, [{role: "user" as const, content: "摘要"}])).toEqual([{role: "user", content: "摘要"}, current[1], current[2]]);
    });

    it("pauses at the segment limit before admitting any pending input", async () => {
        const run = await begin("chat-completions", {modelStep: 32});
        const queued = await steer(run.threadId, "这条不该送达");
        const fetchImpl = vi.fn<typeof fetch>(async () => reply("chat-completions", "不应请求"));
        await executeChatRun({...run}, connector.apiKey, new AbortController(), fetchImpl);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect((await db.agentRuns.get(run.id))?.status).toBe("interrupted");
        expect(await db.agentPendingInputs.get(queued.id)).toMatchObject({status: "held", mode: "next-step"});
    });

    it("is idempotent and ignores system, attached and non-queued items", async () => {
        const run = await begin();
        const at = nowIso();
        const row = (id: string, patch: Partial<AgentPendingInput>): AgentPendingInput => ({
            id, threadId: run.threadId, position: 1, source: "user", mode: "next-step", status: "queued", content: id,
            runId: `r-${id}`, userMessageId: `u-${id}`, assistantMessageId: `a-${id}`, submit, revision: 1, createdAt: at, updatedAt: at, ...patch,
        });
        await db.agentPendingInputs.bulkPut([
            row("sys", {source: "system", system: {kind: "batch-adopted", batchId: "b", adoptionId: "a", applied: []}}),
            row("att", {attachments: [{id: "x", kind: "image", mediaId: "m"} as never]}),
            row("held", {status: "held"}),
            row("turn", {mode: "next-turn"}),
        ]);
        let injected = await injectSteerInputs(run.id, db);
        expect(injected.continuationMessages ?? run.requestMessages).toHaveLength(run.requestMessages.length);
        expect(await db.agentPendingInputs.count()).toBe(4);
        // A row already mirrored in the envelope and the visible history is only cleaned up, never appended twice.
        await db.agentPendingInputs.put(row("done", {content: "重复"}));
        await db.agentRuns.update(run.id, {continuationMessages: [...run.requestMessages, {role: "user", content: "重复", sourceQueueItemId: "done"}]});
        await db.chatMessages.add({id: "u-done", threadId: run.threadId, role: "user", content: "重复", status: "complete", steeredIntoRunId: run.id, createdAt: at});
        injected = await injectSteerInputs(run.id, db);
        expect((injected.continuationMessages ?? []).filter(message => message.role === "user" && message.content === "重复")).toHaveLength(1);
        expect(await db.agentPendingInputs.get("done")).toBeUndefined();
        expect(await db.chatMessages.where("threadId").equals(run.threadId).filter(message => message.content === "重复").count()).toBe(1);
        // Repeating the call with no queued items changes nothing.
        const again = await injectSteerInputs(run.id, db);
        expect(again.updatedAt).toBe(injected.updatedAt);
    });

    it("does not touch the queue when the run is no longer running", async () => {
        const run = await begin("chat-completions", {status: "waiting_approval"});
        const queued = await steer(run.threadId, "晚点再说");
        const same = await injectSteerInputs(run.id, db);
        expect(same.continuationMessages).toBeUndefined();
        expect(await db.agentPendingInputs.get(queued.id)).toMatchObject({status: "queued"});
        expect(await db.chatMessages.get(queued.userMessageId)).toBeUndefined();
    });

    it("leaves the earlier run approvable after a steered row appeared in its thread", async () => {
        const run = await begin("chat-completions", {status: "waiting_approval", permissionMode: "ask", enabledToolNames: ["project_create"], hasToolCalls: true});
        const call: AgentToolCall = {id: "call-1", providerCallId: "wire-1", runId: run.id, threadId: run.threadId, step: 1, order: 0, name: "project_create", title: "创建项目", effect: "write", highRisk: false, arguments: JSON.stringify({name: "x", continueInProject: false}), status: "awaiting_approval", createdAt: run.createdAt, updatedAt: run.createdAt};
        await db.agentToolCalls.add(call);
        await db.chatMessages.add({id: "steered", threadId: run.threadId, role: "user", content: "插队", status: "complete", steeredIntoRunId: run.id, createdAt: new Date(Date.now() + 1000).toISOString()});
        await expect(resolveAgentToolApproval(run.id, call.id, "approve")).resolves.toBeUndefined();
        expect((await db.agentToolCalls.get(call.id))?.status).toBe("approved");
        // Control: a genuine later user turn still makes the run stale.
        await db.chatMessages.add({id: "later", threadId: run.threadId, role: "user", content: "新的问题", status: "complete", createdAt: new Date(Date.now() + 2000).toISOString()});
        const second: AgentToolCall = {...call, id: "call-2", providerCallId: "wire-2", order: 1, status: "awaiting_approval"};
        await db.agentToolCalls.add(second);
        await db.agentRuns.update(run.id, {status: "waiting_approval"});
        await expect(resolveAgentToolApproval(run.id, "call-2", "approve")).rejects.toThrow("只能继续当前最后一次执行");
        expect((await listPendingInputs(run.threadId)).length).toBe(0);
    });
});
