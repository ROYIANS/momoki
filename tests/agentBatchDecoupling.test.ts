import {describe, expect, it} from "vitest";
import {saveFixtureToolRound} from "./helpers/toolDispatch";
import {db} from "@/platform/product/store";
import {beginAgentRun} from "@/features/agent/commands/agentRuns";
import {transitionToolCall} from "@/features/agent/commands/agentTools";
import {createProject} from "@/features/projects/commands/projects";
import {addShot} from "@/features/video/commands/shots";
import {createChatThread} from "@/features/agent/commands/chat";
import {prepareGenerationBatch, readGenerationBatch} from "@/features/agent/commands/agentGenerationBatches";
import {batchUserAction, stopGenerationBatch} from "@/features/video/agent/generationBatchRuntime";
import {generationBatchLockName, recoverAbandonedRuns, type ThreadLockManager, withThreadRunLock} from "@/features/agent/runtime/runOwnership";
import {currentAgentBatchWorks, currentAgentThreadWork, reserveAgentBatchWork, reserveAgentThreadWork, shutdownAgentThreadWork} from "@/features/agent/runtime/threadWork";
import type {GenerationSubmitArgs} from "@/features/video/agent/generationProfiles";
import type {ConnectorConfig} from "@/features/settings/models/connector";
import type {AgentToolContext} from "@/features/agent/runtime/tools";

/** One mutually exclusive lock per name, like the browser: a held name is refused, any other is free. */
function namedLocks() {
    const held = new Set<string>();
    const manager: ThreadLockManager = {
        async request(name, _options, callback) {
            if (held.has(name)) return callback(null);
            held.add(name);
            try {return await callback({});} finally {held.delete(name);}
        }
    };
    return {manager, held};
}

async function fixture() {
    const config: ConnectorConfig = {id: "decouple-connector", name: "Generation", definitionId: "apimart",
        baseUrl: "https://apimart.test/v1", apiKey: "private-batch-key", updatedAt: "now"};
    await db.connectors.put(config);
    const project = await createProject("批量与对话");
    const episode = (await db.episodes.where("projectId").equals(project.id).first())!;
    const shot = await addShot(project.id, episode.id), thread = await createChatThread();
    const run = await beginAgentRun({threadId: thread.id, connector: config, model: "chat", content: "准备候选"});
    const draft: GenerationSubmitArgs = {connectorId: config.id, model: "gpt-image-2", prompt: "雨夜车站", parameters: {}, inputs: [],
        target: {kind: "shot", projectId: project.id, episodeId: episode.id, entityId: shot.id, slot: "firstFrame"}};
    await saveFixtureToolRound(run.id, "", [{id: "batch-source", type: "function",
        function: {name: "prepare_generation_batch", arguments: JSON.stringify({title: "候选批次", candidates: [draft]})}}],
        [{title: "准备批量生成", effect: "bookkeeping", highRisk: false, atomic: true}]);
    const call = (await db.agentToolCalls.where("runId").equals(run.id).first())!;
    await transitionToolCall(run.id, call.id, ["pending"], "running");
    const context: AgentToolContext = {runId: run.id, threadId: thread.id, callId: call.id, signal: new AbortController().signal};
    const result = await prepareGenerationBatch("候选批次", [draft], context) as {batchId: string};
    return {thread, run, id: result.batchId};
}

const status = async (id: string, threadId: string) => (await readGenerationBatch(id, threadId)).batch.status;

describe("generation batches run beside the conversation", () => {
    it("a live batch worker does not occupy the conversation's execution slot", async () => {
        const f = await fixture(), batch = new AbortController(), chat = new AbortController();
        const worker = reserveAgentBatchWork(db, {kind: "videoBatch", threadId: f.thread.id, batchId: f.id}, batch);
        expect(currentAgentThreadWork(db, f.thread.id)).toBeUndefined();
        // Sending a message reserves the slot; the batch being alive no longer refuses it.
        const model = reserveAgentThreadWork(db, {kind: "model", threadId: f.thread.id, invocationId: "turn"}, chat);
        expect(currentAgentBatchWorks(db, f.thread.id)).toHaveLength(1);
        // The same batch is still refused twice.
        expect(() => reserveAgentBatchWork(db, {kind: "videoBatch", threadId: f.thread.id, batchId: f.id}, new AbortController())).toThrow("此批次已在当前页面执行");
        model.follow(Promise.resolve()); worker.follow(Promise.resolve());
        await Promise.all([model.work.done, worker.work.done]);
        expect(currentAgentBatchWorks(db, f.thread.id)).toHaveLength(0);
    });

    it("shutdown stops batch workers as well as conversations", async () => {
        const f = await fixture(), batch = new AbortController();
        const worker = reserveAgentBatchWork(db, {kind: "videoBatch", threadId: f.thread.id, batchId: f.id}, batch);
        worker.follow(new Promise<void>(resolve => batch.signal.addEventListener("abort", () => resolve(), {once: true})));
        await shutdownAgentThreadWork(db);
        expect(batch.signal.aborted).toBe(true);
    });

    it("starting a turn leaves a live batch untouched, because its own lock is held", async () => {
        const f = await fixture(), {manager, held} = namedLocks();
        await db.agentGenerationBatches.update(f.id, {status: "running"});
        held.add(generationBatchLockName(f.id)); // a live worker, here or in another tab
        let entered = false;
        await withThreadRunLock(f.thread.id, async () => {entered = true;}, manager, db);
        expect(entered).toBe(true);
        expect(await status(f.id, f.thread.id)).toBe("running");
    });

    it("pause and edits still work while a turn holds the conversation lock", async () => {
        const f = await fixture(), {manager, held} = namedLocks();
        await db.agentGenerationBatches.update(f.id, {status: "running"});
        held.add(`cuepoint:agent:${f.thread.id}`); // a chat run owns the conversation
        await stopGenerationBatch(f.id, f.thread.id, "pause", manager);
        expect(await status(f.id, f.thread.id)).toBe("paused");
        let wrote = false;
        await batchUserAction(f.id, async () => {wrote = true;}, manager);
        expect(wrote).toBe(true);
    });

    it("a batch locked by another page refuses a user write instead of racing it", async () => {
        const f = await fixture(), {manager, held} = namedLocks();
        held.add(generationBatchLockName(f.id));
        let wrote = false;
        await expect(batchUserAction(f.id, async () => {wrote = true;}, manager)).rejects.toThrow("此批次正在另一个页面执行");
        expect(wrote).toBe(false);
    });

    it("a batch whose lock is free is recovered as abandoned, when a turn starts and at startup", async () => {
        const f = await fixture(), {manager} = namedLocks();
        await db.agentGenerationBatches.update(f.id, {status: "running"});
        await withThreadRunLock(f.thread.id, async () => undefined, manager, db);
        expect(await status(f.id, f.thread.id)).toBe("paused");
        await db.agentGenerationBatches.update(f.id, {status: "running"});
        await recoverAbandonedRuns(manager, db);
        expect(await status(f.id, f.thread.id)).toBe("paused");
    });
});
