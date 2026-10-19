import {afterEach, expect, it, vi} from "vitest";
import {db} from "@/platform/product/store";
import {createAgentExecutionService} from "@/features/agent/runtime/agentExecutionService";
import {createChatThread} from "@/features/agent/commands/chat";
import * as pendingCommands from "@/features/agent/commands/agentPendingInputs";
import * as runCommands from "@/features/agent/commands/agentRuns";
import {editPendingInput, enqueueSystemInput, holdPendingInput, listPendingInputs, removePendingInput} from "@/features/agent/commands/agentPendingInputs";
import {saveToolRound, pauseForApproval, transitionToolCall} from "@/features/agent/commands/agentTools";
import {upsertConnector} from "@/features/settings/commands/connectors";
import {updateGeneralAgentConfig} from "@/features/agent/commands/agentSettings";
import {ThreadLockBusyError, withExecutionOwnership} from "@/features/agent/runtime/runOwnership";
import {BUILTIN_TOOLS} from "@/features/agent/runtime/tools";
import {createSubmissionAttempt} from "@/features/agent/models/chatSubmissionAttempt";
import type {ConnectorConfig} from "@/features/settings/models/connector";

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => {resolve = done;});
    return {promise, resolve};
}
const answer = (content = "answer") => Response.json({choices: [{message: {content}, finish_reason: "stop"}]});
const connector = () => upsertConnector({definitionId: "openai-compatible", protocol: "openai-compatible", baseUrl: "https://example.test/v1", apiKey: "secret"});
let seq = 0;
const ids = () => {seq += 1; return {runId: `qrun-${seq}`, userMessageId: `qu-${seq}`, assistantMessageId: `qa-${seq}`};};
const submitSettings = (config: ConnectorConfig) => ({connector: {id: config.id, definitionId: config.definitionId, baseUrl: config.baseUrl},
    model: "test", interactionMode: "conversation" as const, taskMode: false});
async function attempt(config: ConnectorConfig, threadId: string) {
    return createSubmissionAttempt({originThreadId: threadId, submitted: {scope: threadId, text: "hello", textRevision: 1, attachments: [], imports: []},
        recovery: {scope: threadId, revision: 2}, connector: submitSettings(config).connector,
        model: "test", taskMode: false, interactionMode: "conversation"});
}
const tracked: ReturnType<typeof createAgentExecutionService>[] = [];
function service(fetchImpl: typeof fetch) {
    const owner = createAgentExecutionService({store: new Proxy(db, {}), fetchImpl}); tracked.push(owner); return owner;
}
const queue = (owner: ReturnType<typeof service>, config: ConnectorConfig, threadId: string, content: string) =>
    owner.enqueue({threadId, content, admission: ids(), submit: submitSettings(config)});
const runsOf = async (threadId: string) => (await db.agentRuns.where("threadId").equals(threadId).toArray()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const quiet = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
const userTexts = async (threadId: string) => (await db.chatMessages.where("threadId").equals(threadId).sortBy("createdAt")).filter(m => m.role === "user").map(m => m.content);

afterEach(async () => {for (const owner of tracked.splice(0)) await owner.shutdown(); vi.restoreAllMocks();});

it("delivers queued items one turn each, in order, after a clean end, without interrupting the running turn", async () => {
    const config = await connector(), thread = await createChatThread({connectorId: config.id, model: "test"});
    const hold = deferred(); let requests = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {if (++requests === 1) await hold.promise; return answer(`reply ${requests}`);});
    const owner = service(fetcher);
    const first = owner.submit({attempt: await attempt(config, thread.id)});
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const second = await queue(owner, config, thread.id, "second"), third = await queue(owner, config, thread.id, "third");
    expect((await runsOf(thread.id))[0].status).toBe("running");
    hold.resolve(); await first.done;
    await vi.waitFor(async () => expect((await runsOf(thread.id)).filter(run => run.status === "completed")).toHaveLength(3));
    const runs = await runsOf(thread.id);
    expect(runs.slice(1).map(run => run.id)).toEqual([second.runId, third.runId]);
    expect(await userTexts(thread.id)).toEqual(["hello", "second", "third"]);
    expect(new Set(runs.map(run => run.userMessageId)).size).toBe(3);
    expect(await listPendingInputs(thread.id)).toEqual([]);
    // One card, one request: the second request never carries the third message.
    const bodies = fetcher.mock.calls.map(([, init]) => String(init?.body));
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toContain("second"); expect(bodies[1]).not.toContain("third");
    expect(bodies[2]).toContain("third");
});

it("holds the queue on Stop and sends nothing until the user sends a card", async () => {
    const config = await connector(), thread = await createChatThread({connectorId: config.id, model: "test"});
    let requests = 0;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        if (++requests === 1) await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")), {once: true}));
        return answer("sent now");
    });
    const owner = service(fetcher);
    const first = owner.submit({attempt: await attempt(config, thread.id)});
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const card = await queue(owner, config, thread.id, "later");
    expect(owner.requestStop(first)).toBe(true);
    await first.done;
    await quiet();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(owner.snapshot(thread.id).active).toBe(false);
    expect((await listPendingInputs(thread.id))[0]).toMatchObject({id: card.id, status: "held", heldReason: "stopped"});
    expect(await owner.drainQueue(thread.id)).toBeUndefined();
    await owner.dispatchPending({threadId: thread.id, id: card.id}).done;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await listPendingInputs(thread.id)).toEqual([]);
    expect(await userTexts(thread.id)).toEqual(["hello", "later"]);
});

it("holds the queue when the run fails, with zero further requests", async () => {
    const config = await connector(), thread = await createChatThread({connectorId: config.id, model: "test"});
    const fetcher = vi.fn<typeof fetch>(async () => new Response("boom", {status: 500}));
    const owner = service(fetcher);
    const hold = deferred();
    fetcher.mockImplementationOnce(async () => {await hold.promise; return new Response("boom", {status: 500});});
    const first = owner.submit({attempt: await attempt(config, thread.id)});
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await queue(owner, config, thread.id, "after failure");
    hold.resolve(); await first.done.catch(() => undefined);
    await quiet();
    expect((await runsOf(thread.id))[0].status).toBe("failed");
    expect((await listPendingInputs(thread.id))[0]).toMatchObject({status: "held", heldReason: "failed"});
    expect(fetcher).toHaveBeenCalledTimes(1);
});

it("holds queued items of an abandoned run on startup with zero requests, then sends only on explicit request", async () => {
    const config = await connector(), thread = await createChatThread({connectorId: config.id, model: "test"});
    const abandoned = await runCommands.beginAgentRun({threadId: thread.id, connector: config, model: "test", content: "was running", interactionMode: "conversation"});
    const fetcher = vi.fn<typeof fetch>(async () => answer("explicit"));
    const owner = service(fetcher);
    const card = await queue(owner, config, thread.id, "queued behind it");
    await owner.initialize();
    await quiet();
    expect((await db.agentRuns.get(abandoned.id))?.status).toBe("interrupted");
    expect((await listPendingInputs(thread.id))[0]).toMatchObject({id: card.id, status: "held", heldReason: "interrupted"});
    expect(fetcher).not.toHaveBeenCalled();
    await owner.dispatchPending({threadId: thread.id, id: card.id}).done;
    expect(fetcher).toHaveBeenCalledTimes(1);
});

it("on startup delivers only system items and keeps user items queued, including in the continuation chain", async () => {
    const config = await connector(), thread = await createChatThread({connectorId: config.id, model: "test"});
    const fetcher = vi.fn<typeof fetch>(async () => answer("continued"));
    const owner = service(fetcher);
    const userCard = await queue(owner, config, thread.id, "typed by the user");
    await enqueueSystemInput(db, {threadId: thread.id, dedupeKey: "adopt:1", system: {kind: "batch-adopted", batchId: "b", adoptionId: "1",
        applied: [{targetKey: "t", label: "L", kind: "image", jobId: "j"}]}, compose: () => ({content: "[system] adopted", display: "已采纳 1 张图，继续"})});
    await owner.initialize();
    await vi.waitFor(async () => expect((await runsOf(thread.id)).map(run => run.status)).toEqual(["completed"]));
    await quiet();
    const messages = (await db.chatMessages.where("threadId").equals(thread.id).toArray()).filter(m => m.role === "user");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({content: "[system] adopted", origin: "system", display: "已采纳 1 张图，继续"});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await listPendingInputs(thread.id)).map(row => [row.id, row.status])).toEqual([[userCard.id, "queued"]]);
});

it("abandons a drain quietly while another page owns the thread lock, and delivers once the lock is free", async () => {
    const config = await connector(), thread = await createChatThread({connectorId: config.id, model: "test"});
    const fetcher = vi.fn<typeof fetch>(async () => answer("after lock"));
    const owner = service(fetcher);
    await owner.initialize();
    const card = await queue(owner, config, thread.id, "waits for lock");
    await withExecutionOwnership(thread.id, async () => {
        const handle = await owner.drainQueue(thread.id);
        await expect(handle?.done).rejects.toBeInstanceOf(ThreadLockBusyError);
    });
    // Another page owning the thread is not a failure of this page: no user-visible execution error.
    expect(owner.snapshot(thread.id).error).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect((await listPendingInputs(thread.id))[0]).toMatchObject({id: card.id, status: "queued", revision: 1});
    await (await owner.drainQueue(thread.id))?.done;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await listPendingInputs(thread.id)).toEqual([]);
});

it("does not deliver while a run waits for approval, then delivers after it completes", async () => {
    const config = await connector(), thread = await createChatThread({connectorId: config.id, model: "test"});
    await updateGeneralAgentConfig({permissionMode: "ask", enabledSkillIds: ["workspace"]});
    const run = await runCommands.beginAgentRun({threadId: thread.id, connector: config, model: "test", content: "needs approval"});
    const call = {id: "approval", type: "function" as const, function: {name: BUILTIN_TOOLS[0].name, arguments: "{}"}};
    await saveToolRound(run.id, "", [call], [{title: "approval", effect: "write", highRisk: false}]);
    const toolCall = (await db.agentToolCalls.where("runId").equals(run.id).toArray())[0];
    await transitionToolCall(run.id, toolCall.id, ["pending"], "awaiting_approval");
    await pauseForApproval(run.id);
    const fetcher = vi.fn<typeof fetch>(async () => answer("done"));
    const owner = service(fetcher);
    const card = await queue(owner, config, thread.id, "after approval");
    expect(await owner.drainQueue(thread.id)).toBeUndefined();
    const sendNow = owner.dispatchPending({threadId: thread.id, id: card.id});
    await sendNow.done;
    expect(owner.snapshot(thread.id).error).toContain("等待审批");
    expect((await listPendingInputs(thread.id))[0]).toMatchObject({status: "queued", revision: 1});
    expect(fetcher).not.toHaveBeenCalled();
    await owner.resolveApproval({threadId: thread.id, runId: run.id, callId: toolCall.id, decision: "reject"}).done;
    await vi.waitFor(async () => expect((await runsOf(thread.id)).map(item => item.status)).toEqual(["completed", "completed"]));
    expect(await listPendingInputs(thread.id)).toEqual([]);
    expect(await userTexts(thread.id)).toEqual(["needs approval", "after approval"]);
});

it("ends an interrupted run with saved tool steps before sending a card (D3) without holding the rest of the queue", async () => {
    const config = await connector(), thread = await createChatThread({connectorId: config.id, model: "test"});
    await updateGeneralAgentConfig({permissionMode: "ask", enabledSkillIds: ["workspace"]});
    const old = await runCommands.beginAgentRun({threadId: thread.id, connector: config, model: "test", content: "tooling"});
    const call = {id: "c1", type: "function" as const, function: {name: BUILTIN_TOOLS[0].name, arguments: "{}"}};
    await saveToolRound(old.id, "", [call], [{title: "t", effect: "write", highRisk: false}]);
    await runCommands.finishAgentRun(old.id, "interrupted", undefined, "执行已中断");
    const fetcher = vi.fn<typeof fetch>(async () => answer("fresh"));
    const owner = service(fetcher);
    const a = await queue(owner, config, thread.id, "first card"), b = await queue(owner, config, thread.id, "second card");
    expect(await owner.drainQueue(thread.id)).toBeUndefined();
    await owner.dispatchPending({threadId: thread.id, id: a.id}).done;
    await vi.waitFor(async () => expect((await runsOf(thread.id)).map(run => run.status)).toEqual(["cancelled", "completed", "completed"]));
    expect(await userTexts(thread.id)).toEqual(["tooling", "first card", "second card"]);
    expect((await listPendingInputs(thread.id))).toEqual([]);
    expect(b.id).toBeTruthy();
});

it("loses no delivery when a card is edited between claim and begin, and delivers nothing when it is deleted", async () => {
    const config = await connector(), thread = await createChatThread({connectorId: config.id, model: "test"});
    const fetcher = vi.fn<typeof fetch>(async () => answer("ok"));
    const owner = service(fetcher);
    const begin = runCommands.beginAgentRun;
    let phase = "edit";
    let target = "";
    vi.spyOn(runCommands, "beginAgentRun").mockImplementation(async (...args) => {
        if (phase === "edit") {phase = "pass"; await editPendingInput(target, 1, {content: "edited text"});}
        else if (phase === "delete") {phase = "pass"; await removePendingInput(target);}
        return begin(...args);
    });
    const card = await queue(owner, config, thread.id, "original text");
    target = card.id;
    await (await owner.drainQueue(thread.id))?.done;
    await vi.waitFor(async () => expect(await listPendingInputs(thread.id)).toEqual([]));
    await vi.waitFor(async () => expect((await runsOf(thread.id)).map(run => run.status)).toEqual(["completed"]));
    expect(await userTexts(thread.id)).toEqual(["edited text"]);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const doomed = await queue(owner, config, thread.id, "will be deleted");
    target = doomed.id; phase = "delete";
    await (await owner.drainQueue(thread.id))?.done;
    await quiet();
    expect(await listPendingInputs(thread.id)).toEqual([]);
    expect(await userTexts(thread.id)).toEqual(["edited text"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
});

it("holds a card that cannot be dispatched (missing connector) with the reason, and never retries it on its own", async () => {
    const config = await connector(), thread = await createChatThread({connectorId: config.id, model: "test"});
    const fetcher = vi.fn<typeof fetch>(async () => answer());
    const owner = service(fetcher);
    const card = await queue(owner, config, thread.id, "orphan");
    await db.connectors.clear();
    await expect((await owner.drainQueue(thread.id))?.done).rejects.toThrow("原连接已删除");
    expect((await listPendingInputs(thread.id))[0]).toMatchObject({id: card.id, status: "held", heldReason: "dispatch_failed"});
    expect((await listPendingInputs(thread.id))[0].lastError).toContain("原连接已删除");
    await quiet();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await holdPendingInput(card.id, "uncertain")).toBe(false);
});

it("settles the run and holds the queue in one transaction: a failing hold rolls the terminal write back", async () => {
    const config = await connector(), thread = await createChatThread({connectorId: config.id, model: "test"});
    const run = await runCommands.beginAgentRun({threadId: thread.id, connector: config, model: "test", content: "running", interactionMode: "conversation"});
    const owner = service(vi.fn<typeof fetch>(async () => answer()));
    const card = await queue(owner, config, thread.id, "behind");
    vi.spyOn(pendingCommands, "holdPendingInputs").mockRejectedValueOnce(new Error("hold failed"));
    await expect(runCommands.finishAgentRun(run.id, "failed", undefined, "boom")).rejects.toThrow("hold failed");
    expect((await db.agentRuns.get(run.id))?.status).toBe("running");
    expect((await listPendingInputs(thread.id))[0]).toMatchObject({id: card.id, status: "queued", revision: 1});
    await runCommands.finishAgentRun(run.id, "failed", undefined, "boom");
    expect((await listPendingInputs(thread.id))[0]).toMatchObject({status: "held", heldReason: "failed"});
});
