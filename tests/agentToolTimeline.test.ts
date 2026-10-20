// @vitest-environment jsdom
import {act, createElement as h, type ReactNode} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {AgentRun, AgentToolCall} from "@/features/agent/models/agent";
import {createExecutionFeedbackController, type ExecutionFeedbackSnapshot} from "@/features/agent/runtime/executionFeedback";
import {ExecutionFeedbackContext} from "@/features/agent/ui/ExecutionFeedback";

let attentionCalls: AgentToolCall[] = [];
vi.mock("@/platform/product/queries", () => ({
    useProductQuery: () => ({threadId: "t1", calls: attentionCalls, batches: [], items: [], jobs: [], tasks: [], runs: [run({status: "waiting_approval"})], messages: []}),
}));
vi.mock("@lobehub/ui", () => ({Markdown: ({children}: {children?: ReactNode}) => h("div", null, children)}));
vi.mock("@/features/agent/ui/ThinkingPanel", () => ({ThinkingPanel: () => null}));
vi.mock("@/features/agent/ui/AgentGenerationResults", () => ({AgentGenerationResults: () => h("div", {"data-testid": "results"})}));
vi.mock("@/features/agent/ui/GenerationReview", () => ({GenerationReview: () => h("div", {"data-testid": "generation-review"})}));
vi.mock("@/features/agent/ui/MusicGenerationReview", () => ({MusicGenerationReview: () => null}));
vi.mock("@/features/agent/ui/WebResearchSources", () => ({WebResearchSources: () => null}));
vi.mock("@/features/agent/ui/ProjectImageSources", () => ({ProjectImageSources: () => null}));
vi.mock("@/features/agent/ui/CreatedEntityLinks", () => ({CreatedEntityLinks: () => null}));
vi.mock("@/features/agent/ui/AgentWriteOutcomes", () => ({AgentWriteOutcomes: () => null}));
vi.mock("@tanstack/react-router", () => ({Link: ({children}: {children?: ReactNode}) => h("a", null, children)}));

const {AgentRunDetails} = await import("@/features/agent/ui/AgentRunDetails");
const {AgentComposerAttention} = await import("@/features/agent/ui/AgentComposerAttention");
const {AgentActivityNavigationProvider, useAgentActivityNavigation} = await import("@/features/agent/ui/AgentActivityNavigation");

const now = "2026-10-13T00:00:00.000Z";
function run(patch: Partial<AgentRun> = {}): AgentRun {
    return {
        id: "r1", threadId: "t1", agentId: "g", agentSnapshot: {name: "a", instructions: ""}, userMessageId: "u1", assistantMessageId: "a1",
        model: "m", connector: {id: "c", definitionId: "d", baseUrl: "https://example.test"}, requestMessages: [],
        status: "completed", checkpoint: 1, createdAt: now, updatedAt: now, hasToolCalls: true, ...patch,
    } as AgentRun;
}
function call(id: string, patch: Partial<AgentToolCall> = {}): AgentToolCall {
    return {
        id, runId: "r1", threadId: "t1", providerCallId: id, step: 1, order: 0, name: "business_read", title: "读取镜头",
        arguments: "{}", effect: "read", highRisk: false, status: "completed", createdAt: now, updatedAt: now, ...patch,
    };
}
const message = {id: "a1", threadId: "t1", role: "assistant" as const, content: "", createdAt: now, status: "complete" as const};

let root: Root, container: HTMLDivElement;
const text = () => container.textContent ?? "";
async function renderDetails(calls: AgentToolCall[], runPatch: Partial<AgentRun> = {}, onAction = vi.fn()) {
    await act(async () => {
        root.render(h(AgentActivityNavigationProvider, {threadId: "t1"},
            h(AgentRunDetails, {run: run(runPatch), message, calls, busy: false, onAction})));
    });
    return onAction;
}
const buttons = (label: string) => [...container.querySelectorAll("button")].filter(b => (label.includes(" ") ? b.textContent?.includes(label) : b.textContent === label));

beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    attentionCalls = [];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

describe("tool timeline", () => {
    it("does not count matching historical prose before the current invocation's output is observed", async () => {
        const rects = vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{width: 10, height: 10}] as unknown as DOMRectList);
        const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
        const mark = vi.fn();
        let snapshot: ExecutionFeedbackSnapshot | undefined;
        const controller = createExecutionFeedbackController({timing: {mark, measure: vi.fn(), clearMarks: vi.fn(), clearMeasures: vi.fn()},
            onChange: next => {snapshot = next;}});
        const invocation = controller.begin("resumed", "t1");
        const identity = {runId: "r1", executionId: "current"};
        invocation.runtime({...identity, type: "started", threadId: "t1", assistantMessageId: "a1"});
        invocation.runtime({...identity, type: "baseline", output: {content: "previous partial answer"}});
        invocation.runtime({...identity, type: "requestInvoked"});
        invocation.runtime({...identity, type: "publicReceived", kind: "content"});
        invocation.runtime({...identity, type: "checkpoint", confirmed: true, sequence: 1, checkpoint: 2, output: {content: "repeated answer"}});
        const current = run({status: "running", activitySteps: [{step: 1, content: "repeated answer"}, {step: 2, content: "another saved round"}]});
        const render = async (content: string) => act(async () => root.render(h(ExecutionFeedbackContext, {value: {invocation, snapshot}},
            h(AgentActivityNavigationProvider, {threadId: "t1"}, h(AgentRunDetails,
                {run: current, message: {...message, status: "streaming", content}, calls: [], busy: true, onAction: vi.fn()})))));
        const displayed = () => mark.mock.calls.some(([name]) => String(name).endsWith(".firstPublicCommitted"));
        try {
            await render("previous partial answer");
            expect(container.querySelector(".agent-execution-timeline")?.textContent).toContain("repeated answer");
            expect(container.querySelector(".agent-execution-timeline")?.textContent).toContain("previous partial answer");
            expect(displayed()).toBe(false);
            await render("repeated answer");
            expect(displayed()).toBe(true);
        } finally {controller.dispose(); rects.mockRestore(); visibility.mockRestore();}
    });

    it("renders one row per call without success wording or effect/badge lines", async () => {
        await renderDetails([call("c1", {title: "读取镜头"}), call("c2", {title: "读取角色", name: "character_read"}), call("c3", {title: "编辑镜头", name: "shot_update", effect: "write"})], {status: "running"});
        expect(container.querySelectorAll("[data-activity-call]")).toHaveLength(3);
        for (const phrase of ["已完成", "读取本地数据", "编辑数据", "待处理", "项失败"]) expect(text()).not.toContain(phrase);
    });

    it("shows the previewed object after the title, and only the title without one", async () => {
        const preview = (target?: {label: string; href: string}, summary = "摘要") => ({summary, changes: [], target});
        await renderDetails([
            call("c1", {title: "编辑镜头", preview: preview({label: "镜头 3", href: "/p/a"})}),
            call("c2", {title: "读取角色", name: "character_read"}),
            call("c3", {title: "写入长文", name: "long_write", preview: preview({label: "很".repeat(60), href: "/p/a"})}),
        ], {status: "running"});
        const rows = [...container.querySelectorAll("[data-activity-call]")];
        expect(rows[0].querySelector(".agent-tool-verb")?.textContent).toBe("编辑镜头 · 镜头 3");
        expect(rows[1].querySelector(".agent-tool-verb")?.textContent).toBe("读取角色");
        expect(rows[1].querySelector(".agent-tool-object")).toBeNull();
        const long = rows[2].querySelector(".agent-tool-object")?.textContent ?? "";
        expect([...long.replace(" · ", "")].length).toBe(40);
        expect(long.endsWith("…")).toBe(true);
    });

    it("does not repeat the object when it equals or is contained in the title", async () => {
        const preview = (label: string) => ({summary: "摘要", changes: [], target: {label, href: "/p/a"}});
        await renderDetails([
            call("c1", {title: "创建镜头", preview: preview("创建镜头")}),
            call("c2", {title: "读取镜头 3", name: "x", preview: preview("镜头 3")}),
        ], {status: "running"});
        for (const row of container.querySelectorAll("[data-activity-call]")) expect(row.querySelector(".agent-tool-object")).toBeNull();
        expect(text()).not.toContain("创建镜头 · 创建镜头");
    });

    it("shows a validation failure as a muted single line, a real failure as a failure", async () => {
        await renderDetails([
            call("c1", {status: "failed", error: "工具 创建镜头 的参数无效，未执行。时长必须为数字"}),
            call("c2", {status: "failed", name: "other", title: "写入", error: "网络错误"}),
        ], {status: "running"});
        const errors = [...container.querySelectorAll<HTMLElement>(".agent-call-error")];
        expect(errors[0].dataset.kind).toBe("validation");
        expect(errors[0].textContent).toContain("工具 创建镜头 的参数无效");
        expect(errors[1].dataset.kind).toBe("failure");
        const toggles = container.querySelectorAll<HTMLElement>(".agent-tool-call-toggle");
        expect(toggles[0].dataset.soft).toBe("true");
        expect(toggles[1].dataset.soft).toBeUndefined();
    });

    it("folds parameters and results behind a collapsed disclosure inside the expanded call", async () => {
        await renderDetails([call("c1", {result: '{"ok":true}'})], {status: "running"});
        const toggle = buttons("参数与返回结果")[0];
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
        const body = document.getElementById(toggle.getAttribute("aria-controls")!)!;
        expect(body.hidden).toBe(true);
        await act(async () => toggle.click());
        expect(toggle.getAttribute("aria-expanded")).toBe("true");
        expect(body.hidden).toBe(false);
        expect(body.textContent).toContain('{"ok":true}');
    });

    it("writes plan status only for unfinished items", async () => {
        await renderDetails([call("c1")], {
            status: "completed",
            plan: [{id: "a", title: "第一步", status: "completed"}, {id: "b", title: "第二步", status: "in_progress"}, {id: "c", title: "第三步", status: "pending"}],
        } as Partial<AgentRun>);
        await act(async () => container.querySelector<HTMLElement>(".agent-run-summary")!.click());
        const items = [...container.querySelectorAll(".agent-run-plan li")].map(li => li.textContent);
        expect(items).toEqual(["第一步", "第二步进行中", "第三步待办"]);
    });

    it("keeps aria-expanded in step with the disclosure so the hover-only chevron stays accessible", async () => {
        await renderDetails([call("c1")], {status: "completed"});
        const summary = container.querySelector<HTMLElement>(".agent-run-summary")!;
        expect(summary.tagName).toBe("BUTTON");
        expect(summary.getAttribute("aria-expanded")).toBe("false");
        await act(async () => summary.click());
        expect(summary.getAttribute("aria-expanded")).toBe("true");
        const row = container.querySelector<HTMLElement>(".agent-tool-call-toggle")!;
        expect(row.getAttribute("aria-expanded")).toBe("false");
        await act(async () => row.click());
        expect(row.getAttribute("aria-expanded")).toBe("true");
    });

    it("merges consecutive successful calls of one kind and expands to the individual rows", async () => {
        await renderDetails([call("c1"), call("c2"), call("c3"), call("c4", {title: "读取角色", name: "character_read"})], {status: "running"});
        expect(buttons("读取镜头 · 3 项")).toHaveLength(1);
        expect(container.querySelectorAll("[data-activity-call]")).toHaveLength(4);
        const merged = container.querySelector<HTMLElement>(".agent-tool-merged > [id]");
        expect(merged?.hidden).toBe(true);
        await act(async () => buttons("读取镜头 · 3 项")[0].click());
        expect(merged?.hidden).toBe(false);
        expect(text()).toContain("读取角色");
        expect(text()).not.toContain("读取角色 · ");
    });

    it("does not merge a single call or calls separated by another kind", async () => {
        await renderDetails([call("c1"), call("c2", {title: "读取角色", name: "character_read"}), call("c3")], {status: "running"});
        expect(container.querySelector(".agent-tool-merged")).toBeNull();
    });

    it("shows a failed call's reason directly, without expanding", async () => {
        await renderDetails([call("c1", {status: "failed", error: "镜头不存在"})], {status: "running"});
        const row = container.querySelector<HTMLElement>("[data-activity-call]")!;
        expect(row.querySelector("[id]")?.hasAttribute("hidden")).toBe(true);
        expect(row.querySelector(".agent-call-error")?.textContent).toBe("镜头不存在");
    });

    it("auto-expands a pending approval with its preview and points to the composer card instead of buttons", async () => {
        const pending = call("c1", {
            name: "shot_update", effect: "write", status: "awaiting_approval", highRisk: true, title: "修改镜头",
            preview: {summary: "把镜头 3 改为特写", changes: ["时长 3s → 5s"]},
        } as Partial<AgentToolCall>);
        await renderDetails([pending], {status: "waiting_approval"});
        expect(container.querySelector<HTMLElement>("[data-activity-call] > [id]")?.hidden).toBe(false);
        expect(text()).toContain("把镜头 3 改为特写");
        expect(text()).toContain("等待你在输入框上方批准");
        expect(text()).toContain("高风险操作");
        // The decision itself lives on the composer action card (tests/agentActionCards.test.ts).
        expect(buttons("批准")).toHaveLength(0);
        expect(buttons("拒绝")).toHaveLength(0);
    });

    it("keeps the approval hint visible even when the row is folded, without buttons", async () => {
        await renderDetails([call("c1", {status: "awaiting_approval", effect: "write", name: "shot_update"})], {status: "waiting_approval"});
        await act(async () => container.querySelector<HTMLButtonElement>(".agent-tool-call-toggle")!.click());
        expect(container.querySelector<HTMLElement>("[data-activity-call] > [id]")?.hidden).toBe(true);
        expect(text()).toContain("等待你在输入框上方批准");
        expect(buttons("批准")).toHaveLength(0);
    });

    it("keeps the paid-submission review out of the message: the row says it waits, the form lives in the side panel", async () => {
        await renderDetails([call("c1", {name: "submit_generation", effect: "network", status: "awaiting_approval"})], {status: "waiting_approval"});
        expect(text()).toContain("生成提案待确认，在右侧栏审阅");
        // No form in the stream; the side panel renders it once it is open.
        expect(container.querySelector("[data-testid=generation-review]")).toBeNull();
        expect(container.querySelector("[data-testid=results]")).not.toBeNull();
        expect(buttons("批准")).toHaveLength(0);
    });

    it("shows an unknown result once, on the call row, without a second banner", async () => {
        await renderDetails([call("c1", {status: "unknown"})], {status: "running"});
        expect(text().match(/未确认/g)).toHaveLength(1);
        expect(text()).not.toContain("已暂停自动接续");
    });
});

describe("composer attention", () => {
    it("adds no pill for a proposal waiting for confirmation: its own row above the composer brings it back", async () => {
        const pending = call("c1", {status: "awaiting_approval", effect: "network", name: "submit_generation", title: "修改镜头"});
        attentionCalls = [pending];
        await act(async () => {
            root.render(h(AgentActivityNavigationProvider, {threadId: "t1"}, h(AgentComposerAttention, {
                threadId: "t1", runs: [run({status: "waiting_approval"})], messages: [], projectUnavailable: false, onOpenTask: vi.fn(),
            })));
        });
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(text()).not.toContain("待批准");
        expect(container.querySelector(".agent-composer-card")).toBeNull();
        expect(buttons("批准")).toHaveLength(0);
        expect(buttons("拒绝")).toHaveLength(0);
    });

    it("shows no decision pill for several proposals either", async () => {
        attentionCalls = [
            call("c1", {status: "awaiting_approval", effect: "network", name: "submit_generation", title: "修改镜头"}),
            call("c2", {status: "awaiting_approval", effect: "network", name: "submit_generation", title: "修改角色"}),
        ];
        await act(async () => {
            root.render(h(AgentActivityNavigationProvider, {threadId: "t1"}, h(AgentComposerAttention, {
                threadId: "t1", projectUnavailable: false, onOpenTask: vi.fn(),
            })));
        });
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(container.querySelectorAll(".agent-composer-card")).toHaveLength(0);
    });
});
