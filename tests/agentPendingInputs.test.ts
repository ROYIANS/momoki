import {describe, expect, it, vi} from "vitest";
import {db} from "@/platform/product/store";
import {createChatThread} from "@/features/agent/commands/chat";
import {createProject} from "@/features/projects/commands/projects";
import {deleteChatThread} from "@/features/agent/commands/lifecycle";
import {deleteProject} from "@/features/projects/commands/lifecycle";
import {editPendingInput, enqueueSystemInput, enqueueUserInput, holdPendingInputs, listPendingInputs, movePendingInput, removePendingInput, setPendingMode} from "@/features/agent/commands/agentPendingInputs";
import {beginAgentRun, finishAgentRun} from "@/features/agent/commands/agentRuns";
import {prepareRunActivityKey} from "@/features/agent/commands/threadActivity";
import {cancelAgentRun} from "@/features/agent/commands/agentTools";
import {recoverAbandonedRuns} from "@/features/agent/runtime/runOwnership";
import {upsertConnector} from "@/features/settings/commands/connectors";
import {AGENT_PENDING_INPUT_LIMIT, type AgentPendingInputSystem, type AgentPendingInputSubmit} from "@/features/agent/models/agentPendingInput";

const submit: AgentPendingInputSubmit = {connector: {id: "cx", definitionId: "openai-compatible", baseUrl: "https://example.com/v1"}, model: "m", interactionMode: "smart", taskMode: false};
let seq = 0;
const ids = () => {seq += 1; return {runId: `run-${seq}`, userMessageId: `u-${seq}`, assistantMessageId: `a-${seq}`};};
const user = (threadId: string, content: string) => enqueueUserInput({threadId, content, admission: ids(), submit});
const system = (applied: AgentPendingInputSystem["applied"]): AgentPendingInputSystem => ({kind: "batch-adopted", batchId: "b1", adoptionId: "ad1", applied});
const compose = (s: AgentPendingInputSystem) => ({content: `adopted ${s.applied.length}`, display: `已采纳 ${s.applied.length} 张图，继续`});
const target = (n: number) => ({targetKey: `t${n}`, label: `L${n}`, kind: "image", jobId: `j${n}`});

describe("agentPendingInputs", () => {
    it("assigns increasing positions and freezes admission and submit", async () => {
        const thread = await createChatThread();
        const a = await user(thread.id, " one ");
        const b = await user(thread.id, "two");
        expect([a.position, b.position]).toEqual([1, 2]);
        expect(a).toMatchObject({content: "one", source: "user", mode: "next-turn", status: "queued", revision: 1, submit});
        await removePendingInput(a.id);
        expect((await user(thread.id, "three")).position).toBe(3);
        expect((await listPendingInputs(thread.id)).map(r => r.content)).toEqual(["two", "three"]);
        await expect(user(thread.id, "  ")).rejects.toThrow("消息不能为空");
        await expect(user("missing", "x")).rejects.toThrow();
    });

    it("enforces the per-thread capacity", async () => {
        const thread = await createChatThread();
        for (let i = 0; i < AGENT_PENDING_INPUT_LIMIT; i++) await user(thread.id, `m${i}`);
        await expect(user(thread.id, "overflow")).rejects.toThrow("待发送消息已满");
        const other = await createChatThread();
        await expect(user(other.id, "ok")).resolves.toBeTruthy();
    });

    it("upserts system items by dedupeKey and merges applied targets", async () => {
        const thread = await createChatThread();
        const first = await enqueueSystemInput(db, {threadId: thread.id, dedupeKey: "adopt:ad1", system: system([target(1)]), compose});
        const second = await enqueueSystemInput(db, {threadId: thread.id, dedupeKey: "adopt:ad1", system: system([target(2), target(1)]), compose});
        expect(second.id).toBe(first.id);
        expect(second.system?.applied.map(a => a.targetKey)).toEqual(["t1", "t2"]);
        expect(second).toMatchObject({content: "adopted 2", display: "已采纳 2 张图，继续", revision: 2, source: "system"});
        expect(await listPendingInputs(thread.id)).toHaveLength(1);
        await expect(editPendingInput(second.id, 2, {content: "x"})).rejects.toThrow("系统消息不可编辑");
        await expect(setPendingMode(second.id, 2, "next-step")).rejects.toThrow("系统消息不能引导");
    });

    it("merges a new system key into the same batch at capacity", async () => {
        const thread = await createChatThread();
        const first = await enqueueSystemInput(db, {threadId: thread.id, dedupeKey: "adopt:ad1", system: system([target(1)]), compose});
        for (let i = 1; i < AGENT_PENDING_INPUT_LIMIT; i++) await user(thread.id, `m${i}`);
        const merged = await enqueueSystemInput(db, {threadId: thread.id, dedupeKey: "adopt:ad1:n", system: system([target(2)]), compose});
        expect(merged.id).toBe(first.id);
        expect(await listPendingInputs(thread.id)).toHaveLength(AGENT_PENDING_INPUT_LIMIT);
        await expect(enqueueSystemInput(db, {threadId: thread.id, dedupeKey: "adopt:x", system: {...system([target(3)]), batchId: "other"}, compose})).rejects.toThrow("待发送消息已满");
    });

    it("uses revision CAS for edit and mode changes", async () => {
        const thread = await createChatThread();
        const row = await user(thread.id, "draft");
        const edited = await editPendingInput(row.id, 1, {content: "better"});
        expect(edited).toMatchObject({content: "better", revision: 2});
        await expect(editPendingInput(row.id, 1, {content: "stale"})).rejects.toThrow("已被修改");
        await expect(setPendingMode(row.id, 1, "next-step")).rejects.toThrow("已被修改");
        expect(await setPendingMode(row.id, 2, "next-step")).toMatchObject({mode: "next-step", revision: 3});
        await expect(removePendingInput(row.id, 2)).rejects.toThrow("已被修改");
        await expect(editPendingInput(row.id, 3, {content: " "})).rejects.toThrow("消息不能为空");
    });

    it("refuses to steer an item with attachments", async () => {
        const thread = await createChatThread();
        const row = await enqueueUserInput({threadId: thread.id, content: "see", attachments: [{referenceId: "r1", revision: 1}], admission: ids(), submit});
        await expect(setPendingMode(row.id, 1, "next-step")).rejects.toThrow("只能排队");
        await expect(enqueueUserInput({threadId: thread.id, content: "x", attachments: [{referenceId: "r1", revision: 1}], mode: "next-step", admission: ids(), submit})).rejects.toThrow("只能排队");
    });

    it("reports a deleted item on edit, mode change and removal", async () => {
        const thread = await createChatThread();
        const row = await user(thread.id, "gone");
        await removePendingInput(row.id, 1);
        await expect(editPendingInput(row.id, 1, {content: "x"})).rejects.toThrow("该消息已送出或被删除");
        await expect(setPendingMode(row.id, 1, "next-step")).rejects.toThrow("该消息已送出或被删除");
        await expect(removePendingInput(row.id)).rejects.toThrow("该消息已送出或被删除");
    });

    it("moves items by swapping positions", async () => {
        const thread = await createChatThread();
        const a = await user(thread.id, "a");
        const b = await user(thread.id, "b");
        await user(thread.id, "c");
        await movePendingInput(b.id, "up");
        expect((await listPendingInputs(thread.id)).map(r => r.content)).toEqual(["b", "a", "c"]);
        await movePendingInput(b.id, "up");
        await movePendingInput(a.id, "down");
        await movePendingInput(a.id, "down");
        expect((await listPendingInputs(thread.id)).map(r => r.content)).toEqual(["b", "c", "a"]);
    });

    it("holds only queued items of the given thread", async () => {
        const thread = await createChatThread();
        const other = await createChatThread();
        await user(thread.id, "a");
        await user(thread.id, "b");
        const foreign = await user(other.id, "x");
        expect(await holdPendingInputs(db, thread.id, "stopped")).toBe(2);
        const rows = await listPendingInputs(thread.id);
        expect(rows.map(r => [r.status, r.heldReason, r.revision])).toEqual([["held", "stopped", 2], ["held", "stopped", 2]]);
        expect(await holdPendingInputs(db, thread.id, "failed")).toBe(0);
        expect((await listPendingInputs(other.id))[0]).toMatchObject({id: foreign.id, status: "queued"});
        await user(thread.id, "later");
        expect((await listPendingInputs(thread.id)).at(-1)?.status).toBe("queued");
    });

    it("cascades on thread deletion", async () => {
        const thread = await createChatThread();
        const other = await createChatThread();
        await user(thread.id, "a");
        await enqueueSystemInput(db, {threadId: thread.id, dedupeKey: "adopt:k", system: system([target(1)]), compose});
        await user(other.id, "keep");
        await deleteChatThread(thread.id);
        expect(await listPendingInputs(thread.id)).toEqual([]);
        expect(await listPendingInputs(other.id)).toHaveLength(1);
    });

    it("deleteProject removes system items and keeps user items", async () => {
        const project = await createProject("p");
        const thread = await createChatThread({projectId: project.id});
        const kept = await user(thread.id, "mine");
        await enqueueSystemInput(db, {threadId: thread.id, dedupeKey: "adopt:k", system: system([target(1)]), compose});
        expect((await listPendingInputs(thread.id))[1].projectId).toBe(project.id);
        await deleteProject(project.id);
        expect((await listPendingInputs(thread.id)).map(r => r.id)).toEqual([kept.id]);
    });
});

describe("agentPendingInputs and the terminal writer", () => {
    const connector = () => upsertConnector({definitionId: "openai-compatible", protocol: "openai-compatible", baseUrl: "https://example.test/v1", apiKey: "secret"});
    const runningRun = async () => {
        const thread = await createChatThread();
        const run = await beginAgentRun({threadId: thread.id, connector: await connector(), model: "test", content: "go", interactionMode: "conversation"});
        return {thread, run};
    };

    it("holds queued items with the matching reason when a running run stops, fails or is interrupted", async () => {
        for (const [status, reason] of [["cancelled", "stopped"], ["failed", "failed"], ["interrupted", "interrupted"]] as const) {
            const {thread, run} = await runningRun();
            await user(thread.id, "behind");
            await finishAgentRun(run.id, status);
            expect((await listPendingInputs(thread.id))[0]).toMatchObject({status: "held", heldReason: reason});
        }
    });

    it("leaves the queue alone on normal completion and when an interrupted run is ended again", async () => {
        const {thread, run} = await runningRun();
        await user(thread.id, "behind");
        await finishAgentRun(run.id, "completed");
        expect((await listPendingInputs(thread.id))[0].status).toBe("queued");
        const second = await runningRun();
        await finishAgentRun(second.run.id, "interrupted");
        const late = await user(second.thread.id, "queued after the interruption");
        await cancelAgentRun(second.run.id); // Explicit end of an already interrupted run.
        expect((await listPendingInputs(second.thread.id)).find(row => row.id === late.id)).toMatchObject({status: "queued", revision: 1});
    });

    it("holds in the same transaction as the terminal state", async () => {
        const {thread, run} = await runningRun();
        await user(thread.id, "behind");
        const activity = await prepareRunActivityKey(run.id, db);
        await expect(db.transaction("rw", [db.agentRuns, db.chatMessages, db.chatThreads, db.deviceSettings, db.agentPendingInputs], async tx => {
            await finishAgentRun(run.id, "failed", undefined, "x", undefined, tx, activity);
            expect((await tx.agentPendingInputs.where("threadId").equals(thread.id).first())?.status).toBe("held");
            throw new Error("rollback");
        })).rejects.toThrow("rollback");
        expect((await db.agentRuns.get(run.id))?.status).toBe("running");
        expect((await listPendingInputs(thread.id))[0]).toMatchObject({status: "queued", revision: 1});
    });

    it("holds after recoverAbandonedRuns without any request", async () => {
        const {thread} = await runningRun();
        await user(thread.id, "behind");
        const fetchImpl = vi.spyOn(globalThis, "fetch");
        await recoverAbandonedRuns(undefined, db);
        expect((await listPendingInputs(thread.id))[0]).toMatchObject({status: "held", heldReason: "interrupted"});
        expect(fetchImpl).not.toHaveBeenCalled();
        fetchImpl.mockRestore();
    });
});
