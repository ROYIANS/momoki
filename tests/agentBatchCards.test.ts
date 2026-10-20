// @vitest-environment jsdom
import {act, createElement as h, type ReactNode} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {saveFixtureToolRound} from "./helpers/toolDispatch";
import {db} from "@/platform/product/store";
import {beginAgentRun} from "@/features/agent/commands/agentRuns";
import {transitionToolCall} from "@/features/agent/commands/agentTools";
import {createProject} from "@/features/projects/commands/projects";
import {addShot} from "@/features/video/commands/shots";
import {createChatThread} from "@/features/agent/commands/chat";
import {prepareGenerationBatch} from "@/features/agent/commands/agentGenerationBatches";
import {createAgentTaskForThread} from "@/features/agent/commands/agentTasks";
import type {GenerationSubmitArgs} from "@/features/video/agent/generationProfiles";
import type {ConnectorConfig} from "@/features/settings/models/connector";
import type {AgentToolContext} from "@/features/agent/runtime/tools";

vi.mock("@tanstack/react-router", () => ({Link: ({children}: {children?: ReactNode}) => h("a", null, children)}));

const {ComposerActionCards} = await import("@/features/agent/ui/ComposerActionCards");
const {AgentActivityNavigationProvider, useAgentActivityNavigation} = await import("@/features/agent/ui/AgentActivityNavigation");

let root: Root, container: HTMLDivElement, threadId = "", batchId = "", runId = "";
const revealed = vi.fn();

/** Reports every reveal request so a card's "review" action can be asserted without the dialog. */
function RevealProbe() {
    const {request} = useAgentActivityNavigation();
    if (request) revealed({runId: request.runId, batchId: request.batchId});
    return null;
}

async function fixture() {
    const config: ConnectorConfig = {id: "batch-card-connector", name: "Generation", definitionId: "apimart",
        baseUrl: "https://apimart.test/v1", apiKey: "private-batch-key", updatedAt: "now"};
    await db.connectors.put(config);
    const project = await createProject("批量卡片");
    const episode = (await db.episodes.where("projectId").equals(project.id).first())!;
    const shot = await addShot(project.id, episode.id), thread = await createChatThread();
    const run = await beginAgentRun({threadId: thread.id, connector: config, model: "chat", content: "准备候选"});
    const draft: GenerationSubmitArgs = {connectorId: config.id, model: "gpt-image-2", prompt: "雨夜车站", parameters: {}, inputs: [],
        target: {kind: "shot", projectId: project.id, episodeId: episode.id, entityId: shot.id, slot: "firstFrame"}};
    const candidates = [draft, {...draft, target: {...draft.target, slot: "lastFrame" as const}}];
    await saveFixtureToolRound(run.id, "", [{id: "batch-source", type: "function",
        function: {name: "prepare_generation_batch", arguments: JSON.stringify({title: "候选批次", candidates})}}],
        [{title: "准备批量生成", effect: "bookkeeping", highRisk: false, atomic: true}]);
    const call = (await db.agentToolCalls.where("runId").equals(run.id).first())!;
    await transitionToolCall(run.id, call.id, ["pending"], "running");
    const context: AgentToolContext = {runId: run.id, threadId: thread.id, callId: call.id, signal: new AbortController().signal};
    const result = await prepareGenerationBatch("候选批次", candidates, context) as {batchId: string};
    return {threadId: thread.id, runId: run.id, batchId: result.batchId};
}

const nameOf = (node: Element) => node.getAttribute("title") || node.textContent || "";
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(node => node.textContent === label || nameOf(node) === label);
const draw = () => act(async () => root.render(h(AgentActivityNavigationProvider, {threadId},
    h(ComposerActionCards, {threadId, busy: false, readOnly: false, onRunAction: vi.fn()}), h(RevealProbe))));
const batchRow = () => container.querySelector<HTMLElement>('[data-kind="batch"]');

beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    revealed.mockClear();
    ({threadId, batchId, runId} = await fixture());
    container = document.createElement("div"); container.className = "agent-chat-root";
    document.body.append(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();});

describe("batch rows above the composer", () => {
    it("shows an unconfirmed batch as a row whose primary action reviews it, never submits it", async () => {
        const fetchSpy = vi.fn(() => {throw new Error("A card must not reach a provider");});
        vi.stubGlobal("fetch", fetchSpy);
        await draw();
        await vi.waitFor(() => expect(batchRow()).toBeTruthy());
        expect(batchRow()!.textContent).toContain("候选批次");
        expect(batchRow()!.textContent).toContain("待确认");
        // Confirming costs money and edits the draft, so the row only opens the review.
        expect(button("审阅并确认")).toBeTruthy();
        expect(button("写入")).toBeUndefined();
        await act(async () => button("审阅并确认")!.click());
        expect(revealed).toHaveBeenCalledWith({runId, batchId});
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("offers pause while running, and resume with cancel-rest once paused with queued work", async () => {
        const items = await db.agentGenerationBatchItems.where("batchId").equals(batchId).toArray();
        await db.agentGenerationBatches.update(batchId, {status: "running", confirmedItemIds: items.map(item => item.id), confirmedAt: "2026-10-19T00:00:00.000Z"});
        await db.agentGenerationBatchItems.where("batchId").equals(batchId).modify({state: "queued"});
        await draw();
        await vi.waitFor(() => expect(button("暂停队列")).toBeTruthy());
        expect(batchRow()!.textContent).toContain("生成中");
        await db.agentGenerationBatches.update(batchId, {status: "paused"});
        await vi.waitFor(() => expect(button("继续")).toBeTruthy());
        expect(batchRow()!.textContent).toContain("已暂停");
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="更多"]')!.click());
        expect(button("取消剩余 2 份")).toBeTruthy();
        expect(button("审阅")).toBeTruthy();
    });

    it("keeps a read-only batch to review only", async () => {
        const items = await db.agentGenerationBatchItems.where("batchId").equals(batchId).toArray();
        await db.agentGenerationBatches.update(batchId, {status: "paused", confirmedItemIds: items.map(item => item.id)});
        await db.agentGenerationBatchItems.where("batchId").equals(batchId).modify({state: "queued"});
        const batch = (await db.agentGenerationBatches.get(batchId))!;
        await db.chatThreads.update(threadId, {projectId: batch.projectId});
        await db.agentRuns.update(runId, {status: "completed", projectId: batch.projectId});
        const task = await createAgentTaskForThread(threadId, {title: "已结束的任务", goal: "只读", projectId: batch.projectId});
        await db.agentRuns.update(runId, {taskId: task.id});
        await db.agentGenerationBatches.update(batchId, {taskId: task.id});
        // A task that is no longer open makes its batches read-only: review stays, every state change goes.
        await db.agentTasks.update(task.id, {lifecycle: "completed"});
        await draw();
        await vi.waitFor(() => expect(batchRow()).toBeTruthy());
        expect(button("继续")).toBeUndefined();
        expect(button("暂停队列")).toBeUndefined();
        expect(button("审阅")).toBeTruthy();
    });
});
