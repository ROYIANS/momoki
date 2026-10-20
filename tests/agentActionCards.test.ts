// @vitest-environment jsdom
import {act, createElement as h, type ReactNode} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {db} from "@/platform/product/store";
import {createChatThread} from "@/features/agent/commands/chat";
import type {AgentRun, AgentToolCall} from "@/features/agent/models/agent";

vi.mock("@lobehub/ui", () => ({
    Markdown: ({children}: {children?: ReactNode}) => h("div", null, children),
    CopyButton: () => null,
    Text: ({children}: {children?: ReactNode}) => h("span", null, children),
}));
vi.mock("@/features/agent/ui/ThinkingPanel", () => ({ThinkingPanel: () => null}));
vi.mock("@/features/agent/ui/AgentGenerationResults", () => ({AgentGenerationResults: () => null}));
vi.mock("@/features/agent/ui/GenerationReview", () => ({GenerationReview: () => null}));
vi.mock("@/features/agent/ui/MusicGenerationReview", () => ({MusicGenerationReview: () => null}));
vi.mock("@/features/agent/ui/WebResearchSources", () => ({WebResearchSources: () => null}));
vi.mock("@/features/agent/ui/ProjectImageSources", () => ({ProjectImageSources: () => null}));
vi.mock("@/features/agent/ui/CreatedEntityLinks", () => ({CreatedEntityLinks: () => null}));
vi.mock("@/features/agent/ui/AgentWriteOutcomes", () => ({AgentWriteOutcomes: () => null}));
vi.mock("@tanstack/react-router", () => ({Link: ({children}: {children?: ReactNode}) => h("a", null, children)}));

const {ComposerActionCards} = await import("@/features/agent/ui/ComposerActionCards");
const {AgentComposerAttention} = await import("@/features/agent/ui/AgentComposerAttention");
const {AgentRunDetails} = await import("@/features/agent/ui/AgentRunDetails");
const {AgentActivityNavigationProvider, useAgentActivityNavigation} = await import("@/features/agent/ui/AgentActivityNavigation");

const at = "2026-10-19T00:00:00.000Z";
let root: Root, container: HTMLDivElement, threadId = "";
const onRunAction = vi.fn();

function makeRun(patch: Partial<AgentRun> = {}): AgentRun {
    return {id: "run-1", threadId, userMessageId: "u", assistantMessageId: "a", agentId: "agent",
        agentSnapshot: {name: "Agent", instructions: ""}, connector: {id: "cx", definitionId: "openai-compatible", baseUrl: "https://example.test/v1"},
        model: "model", status: "waiting_approval", requestMessages: [], enabledToolNames: [], offeredTools: [], checkpoint: 0,
        createdAt: at, updatedAt: at, hasToolCalls: true, ...patch} as AgentRun;
}
function makeCall(id: string, patch: Partial<AgentToolCall> = {}): AgentToolCall {
    return {id, runId: "run-1", threadId, providerCallId: id, step: 1, order: 0, name: "shot_update", title: "修改镜头",
        arguments: "{}", effect: "write", highRisk: false, status: "awaiting_approval", createdAt: at, updatedAt: at,
        preview: {summary: "把镜头 3 改为特写", changes: ["时长 3s → 5s"]}, ...patch} as AgentToolCall;
}
// A row action is an icon with a short label; its full wording lives in the title.
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(node => node.textContent === label || node.getAttribute("title") === label);
const draw = (readOnly = false, busy = false) => act(async () => root.render(
    h(ComposerActionCards, {threadId, busy, readOnly, onRunAction})));

beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    onRunAction.mockClear();
    threadId = (await createChatThread({connectorId: "cx", model: "model"})).id;
    container = document.createElement("div"); container.className = "agent-chat-root";
    document.body.append(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();});

describe("composer action cards", () => {
    it("shows the approval card with preview and high-risk mark, and approves/rejects through the run-action handler", async () => {
        await db.agentRuns.add(makeRun());
        await db.agentToolCalls.add(makeCall("c1", {highRisk: true}));
        await draw();
        await vi.waitFor(() => expect(button("批准")).toBeTruthy());
        expect(container.textContent).toContain("等待批准 · 修改镜头");
        expect(container.textContent).toContain("把镜头 3 改为特写");
        expect(container.textContent).toContain("高风险操作");
        await act(async () => button("批准")!.click());
        expect(onRunAction).toHaveBeenCalledWith("run-1", "approve", "c1");
        await act(async () => button("拒绝")!.click());
        expect(onRunAction).toHaveBeenCalledWith("run-1", "reject", "c1");
    });

    it("shows one approval at a time with its position and offers ending the run from more", async () => {
        await db.agentRuns.add(makeRun());
        await db.agentToolCalls.bulkAdd([makeCall("c1"), makeCall("c2", {order: 1, title: "修改角色"})]);
        await draw();
        await vi.waitFor(() => expect(container.querySelectorAll(".agent-composer-action-card")).toHaveLength(1));
        expect(container.textContent).toContain("1/2");
        expect(container.textContent).not.toContain("修改角色");
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="更多"]')!.click());
        await act(async () => button("结束本次执行")!.click());
        expect(onRunAction).toHaveBeenCalledWith("run-1", "cancel");
    });

    it("draws no row for an interrupted run: the one problem bubble above the composer owns continue and end", async () => {
        await db.agentRuns.add(makeRun({status: "interrupted"}));
        await draw();
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(container.querySelector('[data-kind="recovery"]')).toBeNull();
        expect(button("继续")).toBeUndefined();
    });

    it("renders nothing for a read-only thread, a stale run or a plain finished run", async () => {
        await db.agentRuns.add(makeRun());
        await db.agentToolCalls.add(makeCall("c1"));
        await draw(true);
        expect(container.querySelector(".agent-composer-action-card")).toBeNull();
        await draw(false);
        await vi.waitFor(() => expect(button("批准")).toBeTruthy());
        await db.agentRuns.add(makeRun({id: "run-2", createdAt: "2026-10-19T01:00:00.000Z", status: "completed"}));
        await vi.waitFor(() => expect(button("批准")).toBeUndefined());
    });

    it("leaves reviewed forms (paid generation) to their own surface", async () => {
        await db.agentRuns.add(makeRun());
        await db.agentToolCalls.add(makeCall("c1", {name: "submit_generation", effect: "network"}));
        await draw();
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(button("批准")).toBeUndefined();
    });

    it("disables the actions while the thread is busy", async () => {
        await db.agentRuns.add(makeRun());
        await db.agentToolCalls.add(makeCall("c1"));
        await draw(false, true);
        await vi.waitFor(() => expect(button("批准")).toBeTruthy());
        expect(button("批准")!.disabled).toBe(true);
    });
});

describe("message area and navigation no longer duplicate the cards", () => {
    it("AgentRunDetails renders status text only, with no approve/reject/resume/end buttons", async () => {
        const message = {id: "a", threadId, role: "assistant" as const, content: "", createdAt: at, status: "complete" as const};
        const render = (run: AgentRun, calls: AgentToolCall[]) => act(async () => root.render(h(AgentActivityNavigationProvider, {threadId},
            h(AgentRunDetails, {run, message, calls, busy: false, onAction: onRunAction}))));
        await render(makeRun(), [makeCall("c1")]);
        expect(container.textContent).toContain("等待你在输入框上方批准");
        await render(makeRun({status: "interrupted"}), []);
        expect(container.textContent).toContain("可在输入框上方继续");
        const labels = [...container.querySelectorAll("button")].map(node => node.textContent ?? "");
        for (const word of ["批准", "拒绝", "从已保存的步骤继续", "结束本次执行", "继续执行"]) {
            expect(labels.some(label => label.includes(word)), word).toBe(false);
        }
    });

    it("the navigation queue drops both a plain approval and a proposal: their rows above the composer own them", async () => {
        await db.agentRuns.add(makeRun());
        await db.agentToolCalls.add(makeCall("c1"));
        const draw2 = () => act(async () => root.render(h(AgentActivityNavigationProvider, {threadId},
            h(AgentComposerAttention, {threadId, projectUnavailable: false, onOpenTask: vi.fn()}))));
        await draw2();
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(container.querySelector(".agent-composer-card")).toBeNull();
        await db.agentToolCalls.update("c1", {name: "submit_generation"});
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(container.querySelector(".agent-composer-card")).toBeNull();
    });

    it("a proposal waiting for confirmation gets a review row that opens its panel, and can be cancelled from there", async () => {
        await db.agentRuns.add(makeRun());
        await db.agentToolCalls.add(makeCall("c1", {name: "submit_generation", title: "生成首帧"}));
        const requests: unknown[] = [];
        function Probe() {requests.push(useAgentActivityNavigation().request); return null;}
        await act(async () => root.render(h(AgentActivityNavigationProvider, {threadId}, h(Probe),
            h(ComposerActionCards, {threadId, busy: false, readOnly: false, onRunAction}))));
        await vi.waitFor(() => expect(container.querySelector('[data-kind="review"]')).toBeTruthy());
        expect(container.querySelector('[data-kind="review"]')!.textContent).toContain("等待确认 · 生成首帧");
        // Confirming costs money and edits the proposal, so the row never approves it itself.
        expect(button("批准")).toBeUndefined();
        await act(async () => button("打开生成提案：生成首帧")!.click());
        expect(requests.at(-1)).toMatchObject({runId: "run-1", callId: "c1"});
        await act(async () => button("取消本次生成")!.click());
        expect(onRunAction).toHaveBeenCalledWith("run-1", "reject", "c1");
    });

    it("AgentRunDetails shows a steered message where the run took it in, expanded or collapsed", async () => {
        const run = makeRun({status: "completed", hasToolCalls: true});
        const call = makeCall("c1", {status: "completed", step: 1, order: 0});
        const steered = {id: "u2", threadId, role: "user", content: "顺便看看 IP 列表", createdAt: at, status: "complete",
            steeredIntoRunId: "run-1", steeredAfterStep: 1} as import("@/features/agent/models/chat").ChatMessage;
        const message = {id: "a", threadId, role: "assistant", content: "", createdAt: at, status: "complete", runId: "run-1"} as import("@/features/agent/models/chat").ChatMessage;
        await act(async () => root.render(h(AgentActivityNavigationProvider, {threadId},
            h(AgentRunDetails, {run, message, calls: [call], steered: [steered], busy: false, onAction: onRunAction}))));
        // Finished runs are collapsed: what the user said must still be visible, once, with no badge.
        expect(container.querySelectorAll(".agent-steered-message")).toHaveLength(1);
        expect(container.textContent).toContain("顺便看看 IP 列表");
        expect(container.querySelector(".agent-steered-mark")).toBeNull();
        await act(async () => container.querySelector<HTMLButtonElement>(".agent-execution-summary")!.click());
        // Expanded, it moves into the timeline instead of being drawn twice.
        expect(container.querySelectorAll(".agent-steered-message")).toHaveLength(1);
        expect(container.querySelector(".agent-execution-timeline .agent-steered-message")).toBeTruthy();
    });
});
