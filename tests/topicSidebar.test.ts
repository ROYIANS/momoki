// @vitest-environment jsdom
import {act, createElement as h, type ReactNode} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {ChatThread} from "@/features/agent/models/chat";
import type {Project} from "@/features/projects/models/project";

vi.mock("@lobehub/ui", () => ({
    Flexbox: ({children, className}: {children?: ReactNode; className?: string}) => h("div", {className}, children),
    Text: ({children}: {children?: ReactNode}) => h("span", null, children),
}));
const {TopicSidebar} = await import("@/features/agent/ui/TopicSidebar");

const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();
const older = new Date(Date.now() - 5 * 86_400_000).toISOString();
const threads: ChatThread[] = [
    {id: "t1", title: "甲话题", createdAt: recent, updatedAt: recent, projectId: "p1"},
    {id: "t2", title: "乙话题", createdAt: older, updatedAt: older, projectId: "p2"},
    {id: "t3", title: "散话题", createdAt: older, updatedAt: older},
];
const projects = [{id: "p1", name: "项目甲"}, {id: "p2", name: "项目乙"}] as Project[];
const noop = () => undefined;

let root: Root, container: HTMLDivElement;
beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});
const render = (props: Partial<Parameters<typeof TopicSidebar>[0]> = {}) => act(async () => root.render(
    h(TopicSidebar, {threads, projects, onSelect: noop, onNewTopic: noop, onOpenTasks: noop, onRename: noop, onDelete: noop, ...props})));
const groupLabels = () => [...container.querySelectorAll(".agent-sidebar-group-label")].map(e => e.textContent);
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const click = (el: Element) => act(async () => (el as HTMLElement).click());

describe("TopicSidebar", () => {
    it("renders project sections, no settings entry and no legacy 话题 N heading", async () => {
        await render();
        expect(groupLabels()).toEqual(["项目甲", "项目乙", "未关联项目"]);
        const text = container.textContent ?? "";
        expect(text).not.toMatch(/话题 \d/);
        expect(text).not.toContain("设置");
        expect(text).toContain("开启新话题");
        expect(text).toContain("任务");
    });

    it("folds a section and honours a stored time-grouping preference on mount", async () => {
        await render();
        const first = container.querySelector<HTMLButtonElement>(".agent-sidebar-group")!;
        await click(first);
        expect(first.getAttribute("aria-expanded")).toBe("false");
        expect(container.textContent).not.toContain("甲话题");
        await act(async () => root.unmount());
        localStorage.setItem("momoki.agent.topicGrouping", "time");
        root = createRoot(container);
        await render();
        expect(groupLabels()).not.toContain("项目甲");
    });

    it("opens folded sections that match a search and restores folding afterwards", async () => {
        await render();
        await click(container.querySelector(".agent-sidebar-group")!);
        await click([...container.querySelectorAll("button")].find(b => b.textContent === "搜索")!);
        const input = container.querySelector<HTMLInputElement>("input[type=search]")!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "甲");
            input.dispatchEvent(new Event("input", {bubbles: true}));
        });
        expect(container.textContent).toContain("甲话题");
        await click(button("关闭搜索"));
        expect(container.textContent).not.toContain("甲话题");
    });

    it("keeps relative time and sibling rename/delete actions in each row", async () => {
        await render();
        const row = container.querySelector(".agent-topic-row")!;
        expect(row.querySelector("time")?.textContent).toBe("3 天");
        const actions = row.querySelector(".agent-topic-row-actions")!;
        expect([...actions.querySelectorAll("button")].map(b => b.getAttribute("aria-label"))).toEqual(["重命名", "删除"]);
        expect(row.querySelector(".agent-topic-row-title")!.querySelector("button")).toBeNull();
    });

    it("adds a project icon and plus button per project, none for 未关联项目, without selecting a row", async () => {
        const onSelect = vi.fn();
        const onNewTopicInProject = vi.fn();
        await render({onSelect, onNewTopicInProject});
        expect(container.querySelectorAll(".agent-sidebar-group-icon").length).toBe(3);
        await click(button("在 项目乙 中新建话题"));
        expect(onNewTopicInProject).toHaveBeenCalledWith("p2");
        expect(onSelect).not.toHaveBeenCalled();
        expect(container.querySelector('button[aria-label$="未关联项目 中新建话题"]')).toBeNull();
        expect(container.querySelectorAll('button[aria-label$="中新建话题"]').length).toBe(2);
    });

    it("offers grouping as a radio menu linked to the stored preference", async () => {
        await render();
        const trigger = button("列表分组与排序");
        expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
        await act(async () => {
            trigger.dispatchEvent(new MouseEvent("pointerdown", {bubbles: true, button: 0}));
        });
        const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
        expect(items.map(i => i.textContent)).toEqual(["按项目", "按时间"]);
        expect(items.map(i => i.getAttribute("aria-checked"))).toEqual(["true", "false"]);
        await act(async () => {
            items[1]!.click();
        });
        expect(localStorage.getItem("momoki.agent.topicGrouping")).toBe("time");
        expect(groupLabels()).not.toContain("项目甲");
    });

    it("renders time groups while projects are still loading", async () => {
        await render({projects: undefined});
        expect(groupLabels()).not.toContain("未关联项目");
        expect(groupLabels().length).toBeGreaterThan(0);
    });
});
