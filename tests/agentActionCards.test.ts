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
const {AgentActivityNavigationProvider} = await import("@/features/agent/ui/AgentActivityNavigation");

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

    it("offers resume and end for an interrupted run, with the budget wording when paused at the limit", async () => {
        await db.agentRuns.add(makeRun({status: "interrupted"}));
        await draw();
        await vi.waitFor(() => expect(button("从已保存的步骤继续")).toBeTruthy());
        await act(async () => button("从已保存的步骤继续")!.click());
        expect(onRunAction).toHaveBeenCalledWith("run-1", "resume");
        await act(async () => button("结束本次执行")!.click());
        expect(onRunAction).toHaveBeenCalledWith("run-1", "cancel");
        await db.agentRuns.update("run-1", {pauseReason: "model_step_limit"});
        await vi.waitFor(() => expect(button("继续执行 · 最多 32 轮")).toBeTruthy());
    });

    it("hides resume while an operation result is unknown, keeping only end", async () => {
        await db.agentRuns.add(makeRun({status: "failed"}));
        await db.agentToolCalls.add(makeCall("c1", {status: "unknown"}));
        await draw();
        await vi.waitFor(() => expect(button("结束本次执行")).toBeTruthy());
        expect(button("从已保存的步骤继续")).toBeUndefined();
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

    it("the navigation queue drops a plain approval that the card owns but keeps reviewed forms", async () => {
        await db.agentRuns.add(makeRun());
        await db.agentToolCalls.add(makeCall("c1"));
        const draw2 = () => act(async () => root.render(h(AgentActivityNavigationProvider, {threadId},
            h(AgentComposerAttention, {threadId, projectUnavailable: false, onOpenTask: vi.fn()}))));
        await draw2();
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(container.querySelector(".agent-composer-card")).toBeNull();
        await db.agentToolCalls.update("c1", {name: "submit_generation"});
        await vi.waitFor(() => expect(container.textContent).toContain("待批准"));
    });
});
