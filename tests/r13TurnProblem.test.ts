// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createElement as h} from "react";
import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {deriveTurnProblem, describeProblemReason, type TurnProblem} from "@/features/agent/models/turnProblem";
import type {ChatSubmissionAttempt} from "@/features/agent/models/chatSubmissionAttempt";
import {ComposerNotice} from "@/features/agent/ui/ComposerNotice";
import {ComposerCards, ComposerSurface} from "@/features/agent/ui/ComposerCards";

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

function attempt(patch: Partial<ChatSubmissionAttempt> = {}): ChatSubmissionAttempt {
    return {admission: {runId: "r", userMessageId: "m1", assistantMessageId: "a"}, threadId: "t", originThreadId: "t",
        submitted: {scope: "s", text: "hi", textRevision: 1, attachments: [], imports: []}, recovery: {scope: "s", revision: 1},
        connector: {id: "c", definitionId: "d", baseUrl: "https://x.test"}, model: "m", taskMode: false, interactionMode: "agent",
        createdAt: "2026-10-16T00:00:00.000Z", phase: "failed", error: "未发送", ...patch} as ChatSubmissionAttempt;
}
const base = {attempts: [], active: false, readOnly: false};
const run = (patch = {}) => ({id: "r1", status: "interrupted" as const, hasToolCalls: false, ...patch});

describe("turn problem model", () => {
    it("maps failed sends to one unsent problem with the admission-checked retry", () => {
        expect(deriveTurnProblem({...base, attempts: [attempt()]})).toMatchObject({kind: "unsent", reason: "消息未发送",
            action: {kind: "retry-send", label: "重试"}, submissionId: "m1", dismissible: true});
    });
    it("keeps an uncertain send actionable and not closable, with the explicit not-sent exit", () => {
        expect(deriveTurnProblem({...base, attempts: [attempt({phase: "uncertain", error: "发送未确认"})]})).toMatchObject({
            reason: "发送未确认", action: {kind: "check"}, secondary: {kind: "confirm"}, dismissible: false});
        expect(deriveTurnProblem({...base, attempts: [attempt({phase: "checking"})]})).toMatchObject({pending: true, dismissible: false});
    });
    it("latest attempt wins over older ones and over the run outcome", () => {
        const older = attempt({createdAt: "2026-10-16T00:00:00.000Z", error: "未发送"});
        const newer = attempt({admission: {runId: "r2", userMessageId: "m2", assistantMessageId: "a2"}, createdAt: "2026-10-16T01:00:00.000Z"});
        expect(deriveTurnProblem({...base, attempts: [older, newer], run: run()})?.submissionId).toBe("m2");
    });
    it("derives interrupted/failed run problems: continue with tool work, retry without, none while read-only", () => {
        expect(deriveTurnProblem({...base, run: run({hasToolCalls: true})})).toMatchObject({kind: "interrupted", runId: "r1",
            action: {kind: "continue", label: "继续"}});
        expect(deriveTurnProblem({...base, run: run({status: "failed", error: "模型服务返回 500"})})).toMatchObject({kind: "failed",
            reason: "模型返回错误", action: {kind: "retry-run", label: "重试"}});
        expect(deriveTurnProblem({...base, run: run({status: "failed"}), readOnly: true})?.action).toBeUndefined();
        expect(deriveTurnProblem({...base, run: run({pauseReason: "model_step_limit", hasToolCalls: true})})).toMatchObject({reason: "已暂停"});
        expect(deriveTurnProblem({...base, run: run({status: "completed" as never})})).toBeUndefined();
        expect(deriveTurnProblem({...base, run: run({status: "cancelled" as never})})).toBeUndefined();
    });

    it("offers ending the run beside continuing it, only when tool work holds the thread and not read-only", () => {
        // One bubble carries both: continue (primary) and end (secondary), so no second surface repeats them.
        expect(deriveTurnProblem({...base, run: run({hasToolCalls: true})})).toMatchObject({
            action: {kind: "continue"}, secondary: {kind: "end", label: "结束"}});
        expect(deriveTurnProblem({...base, run: run({hasToolCalls: false})})?.secondary).toBeUndefined();
        expect(deriveTurnProblem({...base, run: run({hasToolCalls: true}), readOnly: true})?.secondary).toBeUndefined();
    });
    it("shows nothing while an invocation owns the thread, and the generic owner error never replaces the run reason", () => {
        expect(deriveTurnProblem({...base, active: true, attempts: [attempt()], run: run()})).toBeUndefined();
        expect(deriveTurnProblem({...base, run: run({status: "failed", error: "网络连接失败"}), executionError: "执行未完成", executionErrorId: "error:1"}))
            .toMatchObject({reason: "网络中断", id: "run:r1:failed"});
        expect(deriveTurnProblem({...base, executionError: "原连接已更改，请恢复原连接配置或发送新消息", executionErrorId: "error:2"}))
            .toMatchObject({id: "error:2", kind: "failed", reason: "执行未完成", detail: "原连接已更改，请恢复原连接配置或发送新消息"});
    });
    it("collapses unknown text to a generic reason and keeps the raw text for the tooltip only", () => {
        expect(describeProblemReason("socket hang up ECONNRESET", "执行失败")).toEqual({reason: "网络中断", detail: "socket hang up ECONNRESET"});
        expect(describeProblemReason("上次生成已中断，已保留收到的内容", "执行失败")).toEqual({reason: "应用重启后已中断"});
        expect(describeProblemReason("奇怪的内部状态 x7", "执行失败")).toEqual({reason: "执行失败", detail: "奇怪的内部状态 x7"});
        expect(describeProblemReason(undefined, "执行失败")).toEqual({reason: "执行失败"});
    });
    it("never uses the removed wording", () => {
        const all = [attempt(), attempt({phase: "uncertain"}), run(), run({status: "failed"})].map(item =>
            "phase" in item ? deriveTurnProblem({...base, attempts: [item]}) : deriveTurnProblem({...base, run: item}));
        for (const problem of all) for (const phrase of ["进度已保存", "需要你处理", "恢复草稿"]) expect(JSON.stringify(problem)).not.toContain(phrase);
    });
});

describe("ComposerNotice", () => {
    let root: Root, container: HTMLDivElement;
    beforeEach(() => {container = document.createElement("div"); document.body.append(container); root = createRoot(container);});
    afterEach(async () => {await act(async () => root.unmount()); container.remove();});
    const problem = (patch: Partial<TurnProblem> = {}): TurnProblem => ({id: "p1", kind: "failed", reason: "模型返回错误", detail: "HTTP 500",
        dismissible: true, runId: "r1", action: {kind: "retry-run", label: "重试"}, ...patch});

    it("renders one reason, one primary action and a close control, wired to the owner callbacks", async () => {
        const onAction = vi.fn(), onDismiss = vi.fn(), item = problem();
        await act(async () => root.render(h(ComposerNotice, {problem: item, busy: false, onAction, onDismiss})));
        const notice = container.querySelector(".agent-composer-notice")!;
        expect(notice.getAttribute("role")).toBe("alert");
        expect(notice.querySelector(".agent-composer-notice-reason")?.getAttribute("title")).toBe("HTTP 500");
        expect(notice.textContent).toContain("模型返回错误");
        const buttons = [...notice.querySelectorAll("button")];
        expect(buttons.map(button => button.textContent || button.getAttribute("aria-label"))).toEqual(["重试", "关闭提示"]);
        await act(async () => buttons[0].click()); expect(onAction).toHaveBeenCalledWith(item, "retry-run");
        await act(async () => buttons[1].click()); expect(onDismiss).toHaveBeenCalledWith(item);
    });
    it("closes from the keyboard with Escape only when closable, and uses a status role for non-urgent kinds", async () => {
        const onDismiss = vi.fn();
        await act(async () => root.render(h(ComposerNotice, {problem: problem({kind: "interrupted"}), busy: false, onAction: vi.fn(), onDismiss})));
        const notice = container.querySelector(".agent-composer-notice")!;
        expect(notice.getAttribute("role")).toBe("status");
        await act(async () => {notice.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));});
        expect(onDismiss).toHaveBeenCalledTimes(1);
        const sticky = problem({dismissible: false, kind: "unsent", action: {kind: "check", label: "检查"}, secondary: {kind: "confirm", label: "确认未发送"}});
        await act(async () => root.render(h(ComposerNotice, {problem: sticky, busy: false, onAction: vi.fn(), onDismiss})));
        expect(container.querySelector("[aria-label='关闭提示']")).toBeNull();
        await act(async () => {container.querySelector(".agent-composer-notice")!.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));});
        expect(onDismiss).toHaveBeenCalledTimes(1);
        expect([...container.querySelectorAll("button")].map(button => button.textContent)).toEqual(["确认未发送", "检查"]);
    });
    it("disables actions while the owner is busy", async () => {
        await act(async () => root.render(h(ComposerNotice, {problem: problem(), busy: true, onAction: vi.fn(), onDismiss: vi.fn()})));
        expect(container.querySelector<HTMLButtonElement>(".agent-composer-notice-action")?.disabled).toBe(true);
    });
    it("keeps the notice outside the composer frame, above it", async () => {
        const item = problem();
        await act(async () => root.render(h("div", {className: "agent-chat-root"}, h(ComposerSurface, {
            frameClassName: "agent-composer",
            above: h(ComposerCards, {
                decisions: [], problem: h(ComposerNotice, {problem: item, busy: false, onAction: vi.fn(), onDismiss: vi.fn()}),
                problemId: item.id, problemLabel: item.reason,
            }),
        }, h("textarea", {"aria-label": "消息内容"})))));
        const frame = container.querySelector(".agent-composer")!;
        const notice = container.querySelector(".agent-composer-notice")!;
        expect(frame.contains(notice)).toBe(false);
        expect(notice.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
        expect(notice.closest(".agent-composer-stack")?.firstElementChild?.contains(notice)).toBe(true);
        expect(notice.textContent).not.toContain("需要你处理");
        expect(notice.textContent).not.toContain("进度已保存");
    });
    it("shows one card and kind pills when a decision and a problem both exist", async () => {
        const item = problem({reason: "消息未发送", kind: "unsent", action: {kind: "retry-send", label: "重试"}});
        await act(async () => root.render(h(ComposerCards, {
            decisions: [{id: "d1", title: "待批准", detail: "修改镜头", action: "查看", onAction: vi.fn()}],
            problem: h(ComposerNotice, {problem: item, busy: false, onAction: vi.fn(), onDismiss: vi.fn()}),
            problemId: item.id, problemLabel: item.reason,
        })));
        expect(container.querySelectorAll(".agent-composer-card, .agent-composer-notice")).toHaveLength(1);
        expect(container.querySelector(".agent-composer-notice")).not.toBeNull();
        expect(container.textContent).not.toContain("个进行中");
        const pills = [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")];
        expect(pills.map(pill => pill.textContent)).toEqual(["待批准", "消息未发送"]);
        await act(async () => pills[0].click());
        expect(container.querySelector(".agent-composer-card-action")?.textContent).toBe("查看");
        expect(container.querySelector(".agent-composer-notice")).toBeNull();
    });
});
