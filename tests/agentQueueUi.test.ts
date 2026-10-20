// @vitest-environment jsdom
import {act, createElement as h, type ReactNode} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {db} from "@/platform/product/store";
import {createChatThread} from "@/features/agent/commands/chat";
import {editPendingInput, enqueueSystemInput, enqueueUserInput, holdPendingInput, listPendingInputs, movePendingInput} from "@/features/agent/commands/agentPendingInputs";
import type {AgentRun} from "@/features/agent/models/agent";
import type {AgentPendingInputSubmit} from "@/features/agent/models/agentPendingInput";
import type {ChatMessage} from "@/features/agent/models/chat";

vi.mock("@lobehub/ui", () => ({
    Markdown: ({children}: {children?: ReactNode}) => h("div", {"data-md": ""}, children),
    CopyButton: () => null,
    Text: ({children}: {children?: ReactNode}) => h("span", null, children),
}));
vi.mock("@/features/agent/ui/AgentMarkdown", () => ({AgentMarkdown: ({children}: {children?: ReactNode}) => h("p", null, children)}));
vi.mock("@/features/agent/ui/ModelIcons", () => ({ModelIcon: () => null}));
vi.mock("@/features/agent/ui/ReferenceAttachments", () => ({ReferenceMessageSources: () => null}));
vi.mock("@/features/agent/ui/MemoryContextDetails", () => ({MemoryRunHistory: () => null}));
vi.mock("@/features/agent/ui/ThinkingMatrix", () => ({ThinkingMatrix: () => null}));
vi.mock("@/features/agent/ui/ThinkingPanel", () => ({ThinkingPanel: () => null}));
vi.mock("@/features/agent/ui/AgentRunDetails", () => ({AgentRunDetails: () => null}));
vi.mock("@/features/agent/ui/ExecutionFeedback", async original => ({
    ...await original<typeof import("@/features/agent/ui/ExecutionFeedback")>(),
    PublicOutputCommit: ({children}: {children?: ReactNode}) => h("div", null, children),
}));
vi.mock("@/features/agent/ui/AgentGenerationResults", () => ({AgentGenerationResults: () => null}));
vi.mock("@/features/agent/ui/GenerationReview", () => ({GenerationReview: () => null}));
vi.mock("@/features/agent/ui/MusicGenerationReview", () => ({MusicGenerationReview: () => null}));
vi.mock("@/features/agent/ui/WebResearchSources", () => ({WebResearchSources: () => null}));
vi.mock("@/features/agent/ui/ProjectImageSources", () => ({ProjectImageSources: () => null}));
vi.mock("@/features/agent/ui/CreatedEntityLinks", () => ({CreatedEntityLinks: () => null}));
vi.mock("@tanstack/react-router", () => ({Link: ({children}: {children?: ReactNode}) => h("a", null, children)}));

const {ComposerQueue} = await import("@/features/agent/ui/ComposerQueue");
const {MessageList} = await import("@/features/agent/ui/MessageList");

const at = "2026-10-19T00:00:00.000Z";
const submit: AgentPendingInputSubmit = {connector: {id: "cx", definitionId: "openai-compatible", baseUrl: "https://example.test/v1"},
    model: "model", interactionMode: "smart", taskMode: false};
const network = vi.fn(() => {throw new Error("UI must not dispatch a provider request");});
let seq = 0, root: Root, container: HTMLDivElement, threadId = "";
const ids = () => {seq += 1; return {runId: `ui-run-${seq}`, userMessageId: `ui-u-${seq}`, assistantMessageId: `ui-a-${seq}`};};
const queue = (content: string, extra: {attachments?: {referenceId: string; revision: number; name: string; mimeType: string; kind: "document"}} = {}) =>
    enqueueUserInput({threadId, content, admission: ids(), submit, ...extra} as Parameters<typeof enqueueUserInput>[0]);
const attachment = {referenceId: "ref-1", revision: 1, name: "资料", mimeType: "text/plain", kind: "document"} as never;

beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class {observe() {} disconnect() {}});
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("fetch", network);
    const thread = await createChatThread({connectorId: "cx", model: "model"});
    threadId = thread.id;
    container = document.createElement("div"); container.className = "agent-chat-root";
    document.body.append(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

async function draw(active: boolean) {
    await act(async () => root.render(h(ComposerQueue, {threadId, active})));
}
const cards = () => [...container.querySelectorAll<HTMLElement>(".agent-composer-queue-card")];
const nameOf = (node: Element) => node.textContent || node.getAttribute("aria-label") || "";
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(node => nameOf(node) === label || nameOf(node).startsWith(`${label} `))!;
async function click(label: string) {
    const target = button(label);
    expect(target, label).toBeTruthy();
    await act(async () => target.click());
}

describe("composer pending-send queue", () => {
    it("shows a running turn's message as a card that offers steer/delete/more and never sends by itself", async () => {
        const card = await queue("next message");
        await draw(true);
        await vi.waitFor(() => expect(cards()).toHaveLength(1));
        expect(container.textContent).toContain("next message");
        expect(button("引导").getAttribute("title")).toBe("提交，但不中断模型运行");
        expect(button("删除")).toBeTruthy();
        expect(button("更多")).toBeTruthy();
        expect(button("立即发送")).toBeUndefined();
        expect(cards()[0].dataset.mode).toBe("running");
        expect(network).not.toHaveBeenCalled();
        await click("引导");
        await vi.waitFor(async () => expect((await db.agentPendingInputs.get(card.id))?.mode).toBe("next-step"));
        await vi.waitFor(() => expect(container.textContent).toContain("将在下一个 tool call 之后送达"));
        expect(network).not.toHaveBeenCalled();
    });

    it("keeps an attachment card un-steerable with the reason, and edits through a revision-checked save", async () => {
        const card = await queue("with attachment", {attachments: [attachment]});
        await draw(true);
        await vi.waitFor(() => expect(cards()).toHaveLength(1));
        const steer = button("引导");
        expect(steer.disabled).toBe(true);
        expect(steer.getAttribute("title")).toBe("带资料的消息只能排队");
        await click("更多");
        await click("编辑");
        const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="编辑待发送消息"]')!;
        expect(editor.value).toBe("with attachment");
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
            setter.call(editor, "edited text");
            editor.dispatchEvent(new Event("input", {bubbles: true}));
        });
        await click("保存");
        await vi.waitFor(async () => expect(await db.agentPendingInputs.get(card.id)).toMatchObject({content: "edited text", revision: 2}));
        // A card delivered (or removed) between claim and save reports itself gone instead of resurrecting.
        await db.agentPendingInputs.delete(card.id);
        await click("更多");
        await click("编辑");
        await click("保存");
        await vi.waitFor(() => expect(container.textContent).toContain("该消息已送出或被删除"));
        expect(await db.agentPendingInputs.get(card.id)).toBeUndefined();
        expect(network).not.toHaveBeenCalled();
    });

    it("reorders and removes cards without dispatching", async () => {
        const first = await queue("first"), second = await queue("second");
        await draw(true);
        await vi.waitFor(() => expect(cards()).toHaveLength(2));
        expect(cards().map(card => card.textContent)).toEqual([expect.stringContaining("first"), expect.stringContaining("second")]);
        await act(async () => cards()[1].querySelector<HTMLButtonElement>('button[aria-label="更多"]')!.click());
        await click("上移");
        await vi.waitFor(async () => expect((await listPendingInputs(threadId)).map(row => row.content)).toEqual(["second", "first"]));
        await act(async () => {await movePendingInput(first.id, "up"); await movePendingInput(first.id, "up");});
        expect((await listPendingInputs(threadId)).map(row => row.content)).toEqual(["first", "second"]);
        // Reordering writes the DB; the list re-reads asynchronously, so wait for the rendered order too.
        await vi.waitFor(() => expect(cards()[0]?.textContent).toContain("first"));
        await act(async () => cards()[0].querySelector<HTMLButtonElement>('button[aria-label="删除 first"]')!.click());
        await vi.waitFor(async () => expect((await listPendingInputs(threadId)).map(row => row.id)).toEqual([second.id]));
        // Nothing runs and nothing holds the thread: the row is waiting for the automatic drain, and stays editable.
        await draw(false);
        await vi.waitFor(() => expect(cards()[0].dataset.mode).toBe("idle"));
        expect(button("立即发送")).toBeTruthy();
        expect(button("删除")).toBeTruthy();
        // The list re-reads asynchronously after the delete, and a late re-render can reset the row menu between
        // the click and the check on a loaded machine. Open it until it is open; the menu itself is what we check.
        await vi.waitFor(async () => {
            if (!button("编辑")) await click("更多");
            expect(button("编辑")).toBeTruthy();
        });
        expect(network).not.toHaveBeenCalled();
    });

    it("keeps held cards visible with an explicit send-now and never auto-sends them", async () => {
        const card = await queue("stopped message");
        await holdPendingInput(card.id, "stopped");
        await draw(false);
        await vi.waitFor(() => expect(cards()).toHaveLength(1));
        expect(cards()[0].dataset.mode).toBe("paused");
        expect(container.textContent).toContain("已停止，未自动发送");
        expect(button("立即发送")).toBeTruthy();
        expect(button("删除")).toBeTruthy();
        await click("更多");
        expect(button("编辑")).toBeTruthy();
        expect(button("引导")).toBeUndefined();
        expect(network).not.toHaveBeenCalled();
    });

    it("reports an approval wait or unfinished earlier execution instead of offering a send-now", async () => {
        await queue("waiting card");
        const run: AgentRun = {id: "blocking", threadId, userMessageId: "u", assistantMessageId: "a", agentId: "agent",
            agentSnapshot: {name: "Agent", instructions: ""}, connector: {id: "cx", definitionId: "openai-compatible", baseUrl: "https://example.test/v1"},
            model: "model", status: "waiting_approval", requestMessages: [], enabledToolNames: [], offeredTools: [], checkpoint: 0,
            createdAt: at, updatedAt: at};
        await db.agentRuns.add(run);
        await draw(false);
        await vi.waitFor(() => expect(container.textContent).toContain("等待审批，处理完成后再发送"));
        expect(button("立即发送")).toBeUndefined();
        await db.agentRuns.update(run.id, {status: "interrupted", hasToolCalls: true});
        await vi.waitFor(() => expect(container.textContent).toContain("上次执行未结束，发送前会先结束它"));
        expect(button("结束上次执行并发送")).toBeTruthy();
        expect(network).not.toHaveBeenCalled();
    });

    it("renders a system item faint and read-only, with only send-now and cancel", async () => {
        await queue("mine");
        await enqueueSystemInput(db, {threadId, dedupeKey: "adopt:ui", compose: () => ({content: "[系统事件] 已采纳", display: "已采纳 3 张图，继续"}),
            system: {kind: "batch-adopted", batchId: "b", adoptionId: "ui", applied: []}});
        await draw(true);
        await vi.waitFor(() => expect(cards()).toHaveLength(2));
        const system = cards().find(card => card.dataset.source === "system")!;
        expect(system.textContent).toContain("已采纳 3 张图，继续");
        expect(system.textContent).toContain("系统事件");
        expect(system.querySelectorAll("button")).toHaveLength(2);
        expect([...system.querySelectorAll("button")].map(nameOf)).toEqual(["立即发送", "取消继续"]);
        expect(system.querySelector('button[aria-label="更多"]')).toBeNull();
        // While this page runs, the drain continues it after the turn, so the card only offers cancelling.
        const sendNow = [...system.querySelectorAll<HTMLButtonElement>("button")].find(node => nameOf(node) === "立即发送")!;
        expect(sendNow.disabled).toBe(true);
        expect(sendNow.getAttribute("title")).toBe("本轮结束后会自动继续");
        await act(async () => [...system.querySelectorAll<HTMLButtonElement>("button")].find(node => nameOf(node) === "取消继续")!.click());
        await vi.waitFor(async () => expect(await db.agentPendingInputs.where("threadId").equals(threadId).toArray()).toHaveLength(1));
        await vi.waitFor(() => expect(container.textContent).not.toContain("已采纳 3 张图，继续"));
        expect(button("更多")).toBeTruthy();
        expect(network).not.toHaveBeenCalled();
    });
});

describe("system rows in the transcript", () => {
    const message = (id: string, role: ChatMessage["role"], patch: Partial<ChatMessage> = {}): ChatMessage =>
        ({id, threadId, role, content: `${role} ${id}`, createdAt: new Date(Date.parse(at) + Number(id.replace(/\D/g, "")) || 0).toISOString(), status: "complete", ...patch});
    async function drawMessages(messages: ChatMessage[]) {
        await act(async () => root.render(h("div", {className: "agent-chat-column"},
            h(MessageList, {threadId, messages, runs: [], calls: [], busy: false, onRunAction: vi.fn()}))));
    }

    it("draws an adopted system row as one faint line, not a user bubble, and excludes it from turn navigation", async () => {
        await drawMessages([
            message("u1", "user"), message("a1", "assistant"),
            message("u2", "user"), message("a2", "assistant"),
            message("u3", "user", {origin: "system", display: "已采纳 3 张图，继续", content: "[系统事件] 已采纳 3 张图"}), message("a3", "assistant"),
            message("u4", "user"), message("a4", "assistant"),
        ]);
        const note = container.querySelector(".agent-system-note")!;
        expect(note.textContent).toBe("已采纳 3 张图，继续");
        expect(note.closest(".agent-user-bubble")).toBeNull();
        expect(container.querySelectorAll(".agent-user-bubble")).toHaveLength(3);
        // Four real user turns stay below the rail threshold even though five user rows exist.
        expect(container.querySelector(".agent-message-navigation-shell")!.className).not.toContain("has-turn-navigation");
        await drawMessages([...Array.from({length: 5}, (_, index) => message(`u${index + 1}`, "user")),
            message("system9", "user", {origin: "system", display: "已采纳 1 张图，继续"})]);
        expect(container.querySelector(".agent-message-navigation-shell")!.className).toContain("has-turn-navigation");
    });

    it("does not stack a steered message at the bottom: the run that took it in owns it, and no badge is drawn", async () => {
        // AgentRunDetails is stubbed in this file, so a hosted row is simply absent from the list itself.
        const run = {id: "run-1", threadId, status: "completed", hasToolCalls: true, createdAt: at, updatedAt: at, model: "model"} as unknown as AgentRun;
        await act(async () => root.render(h("div", {className: "agent-chat-column"},
            h(MessageList, {threadId, messages: [message("u1", "user"), message("a1", "assistant", {runId: "run-1"}),
                message("u2", "user", {steeredIntoRunId: "run-1", steeredAfterStep: 1, content: "顺便看看 IP 列表"})],
                runs: [run], calls: [], busy: false, onRunAction: vi.fn()}))));
        expect(container.querySelector(".agent-steered-mark")).toBeNull();
        expect(container.textContent).not.toContain("顺便看看 IP 列表");
        expect(container.querySelectorAll(".agent-user-bubble")).toHaveLength(1);
    });

    it("draws a steered row as a normal bubble when its run is not loaded, so it never disappears", async () => {
        await drawMessages([message("u1", "user"), message("a1", "assistant", {runId: "run-9"}),
            message("u2", "user", {steeredIntoRunId: "run-9", content: "顺便看看 IP 列表"})]);
        expect(container.textContent).toContain("顺便看看 IP 列表");
        expect(container.querySelector(".agent-steered-mark")).toBeNull();
    });

    it("falls back to the queue text when a system row has no display line", async () => {
        await drawMessages([message("u1", "user", {origin: "system", content: "[系统事件] 已采纳 2 张图，继续"})]);
        expect(container.querySelector(".agent-system-note")?.textContent).toBe("[系统事件] 已采纳 2 张图，继续");
    });
});
