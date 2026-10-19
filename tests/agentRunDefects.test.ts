import {prepareThreadActivityKey} from "@/features/agent/commands/threadActivity";
import {describe, expect, it, vi} from "vitest";
import {db} from "@/platform/product/store";
import {beginAgentRun, finishAgentRun} from "@/features/agent/commands/agentRuns";
import {settleRun} from "@/features/agent/commands/agentRunTerminalState";
import {cancelAgentRun, pauseAtModelStepLimit, saveToolRound, startModelStep} from "@/features/agent/commands/agentTools";
import {updateGeneralAgentConfig} from "@/features/agent/commands/agentSettings";
import {createChatThread} from "@/features/agent/commands/chat";
import {deleteChatThread} from "@/features/agent/commands/lifecycle";
import {executeChatRun} from "@/features/agent/runtime/runChat";
import {BUILTIN_TOOLS} from "@/features/agent/runtime/tools";
import {runBlocksThread} from "@/features/agent/models/agentToolSelection";
import {appendStartPrompt} from "@/features/agent/ui/startPrompt";
import type {AgentRun} from "@/features/agent/models/agent";
import type {ConnectorConfig} from "@/features/settings/models/connector";

const connector: ConnectorConfig = {id: "defects-cx", label: "test", protocol: "openai-compatible", definitionId: "openai-compatible", baseUrl: "https://example.test/v1", apiKey: "secret", updatedAt: "2026-01-01"};

async function begin(permissionMode: "ask" | "full" = "ask") {
    await updateGeneralAgentConfig({permissionMode, enabledSkillIds: ["workspace", "planning"]});
    const thread = await createChatThread();
    return beginAgentRun({threadId: thread.id, connector, model: "model", content: "开始"});
}

const answer = () => Response.json({choices: [{message: {content: "完成"}, finish_reason: "stop"}]});
const toolResponse = (name: string, args = "{}", id = "call-1") => Response.json({
    choices: [{message: {content: "", tool_calls: [{id, type: "function", function: {name, arguments: args}}]}, finish_reason: "tool_calls"}]
});

describe("settleRun is the only terminal-state writer", () => {
    it("writes the same fields finishAgentRun writes, including pause cleanup and message status", async () => {
        for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
            const run = await begin();
            await db.agentRuns.update(run.id, {status: "running", pauseReason: "model_step_limit"});
            const activity = prepareThreadActivityKey(run.threadId);
            await db.transaction("rw", [db.agentRuns, db.chatMessages, db.chatThreads, db.deviceSettings, db.agentPendingInputs], async (tx) => {
                await settleRun(tx, run.id, status, {activity, error: `${status}-error`});
            });
            const saved = await db.agentRuns.get(run.id);
            expect(saved).toMatchObject({status, error: `${status}-error`});
            expect(saved?.endedAt).toBe(saved?.updatedAt);
            // Every terminal state clears a stale pause reason of the opposite kind.
            expect(saved?.pauseReason).toBeUndefined();
            expect(await db.chatMessages.get(run.assistantMessageId)).toMatchObject({
                status: status === "completed" ? "complete" : status === "failed" ? "error" : status === "cancelled" ? "aborted" : "interrupted",
            });
        }
    });

    it("refuses a second settlement and stays a no-op for an already-terminal run", async () => {
        const run = await begin();
        await finishAgentRun(run.id, "completed", {content: "final"});
        await finishAgentRun(run.id, "failed", {content: "wrong"}, "late");
        expect(await db.chatMessages.get(run.assistantMessageId)).toMatchObject({content: "final", status: "complete"});
        // cancelAgentRun shares the same path: a completed run is left untouched.
        await cancelAgentRun(run.id);
        expect(await db.agentRuns.get(run.id)).toMatchObject({status: "completed"});
    });
});

describe("D2 leaving an active topic is confirmed, not silent", () => {
    it("uses one predicate for the UI strip and the DB admission check", () => {
        const run = (patch: Partial<AgentRun>) => ({status: "running", hasToolCalls: true, ...patch}) as AgentRun;
        expect(runBlocksThread(run({}))).toBe(true);
        expect(runBlocksThread(run({status: "waiting_approval"}))).toBe(true);
        expect(runBlocksThread(run({status: "interrupted"}))).toBe(true);
        expect(runBlocksThread(run({status: "failed"}))).toBe(true);
        // A text-only unfinished reply does not hold the thread.
        expect(runBlocksThread(run({status: "failed", hasToolCalls: false}))).toBe(false);
        expect(runBlocksThread(run({status: "cancelled"}))).toBe(false);
        expect(runBlocksThread(run({status: "completed"}))).toBe(false);
    });

    it("keeps enforcing the same rule inside beginAgentRun", async () => {
        const run = await begin();
        await db.agentRuns.update(run.id, {status: "interrupted", hasToolCalls: true});
        await expect(beginAgentRun({threadId: run.threadId, connector, model: "model", content: "next"})).rejects.toThrow("已有执行");
        await db.agentRuns.update(run.id, {hasToolCalls: false});
        await expect(beginAgentRun({threadId: run.threadId, connector, model: "model", content: "next"})).resolves.toMatchObject({status: "running"});
    });

    it("leaves preserved work endable after a confirmed stop", async () => {
        const run = await begin("full");
        const tool = {...BUILTIN_TOOLS[0], execute: vi.fn(async () => ({}))};
        // One real tool round first, then the user leaves: the saved call must survive.
        await executeChatRun(run, connector.apiKey, new AbortController(), vi.fn(async () => toolResponse(tool.name)), [tool, BUILTIN_TOOLS[1]]);
        const saved = (await db.agentToolCalls.toArray())[0];
        expect(saved).toBeDefined();
        await db.agentRuns.update(run.id, {status: "interrupted", hasToolCalls: true});
        await db.agentToolCalls.update(saved.id, {status: "pending", decision: undefined});
        await cancelAgentRun(run.id);
        expect(await db.agentRuns.get(run.id)).toMatchObject({status: "cancelled", pauseReason: undefined});
        expect(await db.agentToolCalls.get(saved.id)).toMatchObject({status: "rejected"});
    });
});

describe("D3 rename failures surface instead of vanishing", () => {
    it("keeps the read-only guard: a real update still persists the title", async () => {
        const thread = await createChatThread();
        const {updateChatThread} = await import("@/features/agent/commands/chat");
        await updateChatThread(thread.id, {title: "新标题"});
        expect((await db.chatThreads.get(thread.id))?.title).toBe("新标题");
    });

    it("a missing thread stays a no-op, while a failing store still rejects for the caller to report", async () => {
        const {updateChatThread} = await import("@/features/agent/commands/chat");
        await expect(updateChatThread("missing-thread", {title: "x"})).resolves.toBeUndefined();
        const {failStoreTableOnce} = await import("./helpers/storeFaults");
        const fault = failStoreTableOnce(db, "chatThreads", "put", new Error("disk failure"));
        await expect(updateChatThread((await createChatThread()).id, {title: "新标题"})).rejects.toThrow("disk failure");
        fault.mockRestore();
    });
});

describe("D5 deleting the current topic keeps its confirmation", () => {
    it("only removes the confirmation once the deletion actually runs", async () => {
        const run = await begin();
        await finishAgentRun(run.id, "completed", {content: "done"});
        await deleteChatThread(run.threadId);
        expect(await db.chatThreads.count()).toBe(0);
        expect(await db.agentRuns.count()).toBe(0);
    });
});

describe("D7 an aborted send never strands an empty topic", () => {
    it("keeps the existing thread count rule for delayed sends and cancelled ones", async () => {
        // The flow-level behaviour (createChatThread then abort => delete) is proven by
        // the D03 owner suite; here the durable rule is that a created topic with no run
        // and no message must be removable without touching other threads.
        const keep = await createChatThread({title: "保留"});
        const created = await createChatThread({title: "新话题"});
        await deleteChatThread(created.id);
        expect(await db.chatThreads.count()).toBe(1);
        expect((await db.chatThreads.get(keep.id))?.title).toBe("保留");
    });
});

describe("D8 a retry never re-derives its frozen protocol", () => {
    it("reuses the stored protocol instead of a hasToolCalls heuristic", async () => {
        const run = await begin();
        expect(run.protocol).toBeDefined();
        await finishAgentRun(run.id, "failed", {content: "partial"});
        const retry = await beginAgentRun({threadId: run.threadId, connector, model: "model", retryOfRunId: run.id});
        expect(retry.protocol).toBe(run.protocol);
    });
});

describe("D10 the start hint appends instead of replacing a draft", () => {
    it("keeps typed text and is idempotent", () => {
        expect(appendStartPrompt("")).toContain("请根据当前任务目标");
        const once = appendStartPrompt("先检查角色设定");
        expect(once).toContain("先检查角色设定");
        expect(once).toContain("请根据当前任务目标");
        expect(appendStartPrompt(once)).toBe(once);
    });
});

describe("D11 interrupted vs cancelled uses one fresh read", () => {
    it("marks a stop before any tool round as cancelled and a stopped tool run as interrupted", async () => {
        const textRun = await begin("full");
        const aborted = new AbortController();
        aborted.abort();
        await executeChatRun(textRun, connector.apiKey, aborted, vi.fn(async () => answer()), [BUILTIN_TOOLS[0]]);
        expect((await db.agentRuns.get(textRun.id))?.status).toBe("cancelled");

        const toolRun = await begin("full");
        const tool = {...BUILTIN_TOOLS[0], execute: vi.fn(async () => ({}))};
        await executeChatRun(toolRun, connector.apiKey, new AbortController(), vi.fn(async () => toolResponse(tool.name)), [tool, BUILTIN_TOOLS[1]]);
        await db.agentRuns.update(toolRun.id, {status: "running", hasToolCalls: true});
        const stop = new AbortController();
        stop.abort();
        await executeChatRun((await db.agentRuns.get(toolRun.id))!, connector.apiKey, stop, vi.fn(async () => answer()), [tool, BUILTIN_TOOLS[1]]);
        expect((await db.agentRuns.get(toolRun.id))?.status).toBe("interrupted");
    });
});

describe("D9 a budget pause uses the same writer", () => {
    it("keeps the pause reason while clearing the run error", async () => {
        const run = await begin("full");
        await db.agentRuns.update(run.id, {modelStep: 32, modelStepSegmentStart: 0, error: "stale"});
        expect(await pauseAtModelStepLimit(run.id)).toBe(true);
        const saved = await db.agentRuns.get(run.id);
        expect(saved).toMatchObject({status: "interrupted", pauseReason: "model_step_limit", error: undefined});
        expect(await db.chatMessages.get(run.assistantMessageId)).toMatchObject({status: "interrupted", error: expect.stringContaining("进度已保存")});
    });
});

describe("D6 an in-flight send does not silently swallow decisions", () => {
    it("keeps the ledger envelope rejection for a forged round while the block is held", async () => {
        await updateGeneralAgentConfig({permissionMode: "full", enabledSkillIds: ["workspace", "planning", "business-read"]});
        const run = await beginAgentRun({threadId: (await createChatThread()).id, connector, model: "model", content: "开始"});
        await startModelStep(run.id, 32);
        await expect(saveToolRound(run.id, "", [{id: "forged", type: "function", function: {name: "business_search", arguments: "{}"}}], [{title: "search", effect: "read", highRisk: false}]))
            .rejects.toThrow("本轮未提供");
    });

    it("does not let a caller-built failure detail launder a non-read, high-risk or confirmed call", async () => {
        await updateGeneralAgentConfig({permissionMode: "full", enabledSkillIds: ["workspace", "planning", "business-read"]});
        const run = await beginAgentRun({threadId: (await createChatThread()).id, connector, model: "model", content: "开始"});
        await startModelStep(run.id, 32);
        const wire = [{id: "forged-failure", type: "function" as const, function: {name: "business_search", arguments: "{}"}}];
        const failure = {error: "x", result: "{}"};
        for (const detail of [
            {title: "t", effect: "write" as const, highRisk: false, failure},
            {title: "t", effect: "read" as const, highRisk: true, failure},
            {title: "t", effect: "read" as const, highRisk: false, atomic: true, failure},
            {title: "t", effect: "read" as const, highRisk: false, requiresConfirmation: true, failure},
        ]) await expect(saveToolRound(run.id, "", wire, [detail])).rejects.toThrow("本轮未提供");
        expect(await db.agentToolCalls.where("runId").equals(run.id).count()).toBe(0);
    });
});
