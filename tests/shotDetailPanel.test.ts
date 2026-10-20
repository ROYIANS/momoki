// @vitest-environment jsdom
import {act, createElement as h, type ReactNode, useRef, useState} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {db} from "@/platform/product/store";
import {createProject} from "@/features/projects/commands/projects";
import {addShot, patchShot, deleteShots} from "@/features/video/commands/shots";
import {ContextPanelHostProvider} from "@/app/layout/ContextPanelHost";
import {ShotDetailPanel} from "@/features/video/ui/ShotDetailPanel";
import type {ShotDetailTarget} from "@/features/video/models/shotDetailTarget";
import {getVideoWorkspaceRepository} from "@/features/video/services/workspaceRepository";
import {DraftConflictError} from "@/platform/product/draftConflict";

const blockers = vi.hoisted(() => new Set<{shouldBlockFn: (locations: {current: {pathname: string}; next: {pathname: string}}) => boolean}>());
const routeResolution = vi.hoisted(() => ({status: "idle", proceed: vi.fn(), reset: vi.fn(), assigned: false}));
vi.mock("@tanstack/react-router", () => ({
    useBlocker: (options: {shouldBlockFn: (locations: {current: {pathname: string}; next: {pathname: string}}) => boolean}) => {
        const resolver = useRef<Pick<typeof routeResolution, "status" | "proceed" | "reset"> | undefined>(undefined);
        if (!resolver.current) {
            resolver.current = routeResolution.assigned ? {status: "idle", proceed: vi.fn(), reset: vi.fn()} : routeResolution;
            routeResolution.assigned = true;
        }
        blockers.add(options);
        return resolver.current;
    },
    Link: ({to, children, ...props}: {to: string; children?: ReactNode}) => h("a", {href: to, ...props}, children),
}));

let root: Root, container: HTMLDivElement, portal: HTMLDivElement;
let target: ShotDetailTarget, second: ShotDetailTarget, third: ShotDetailTarget;
const closed = vi.fn(), outcomes = vi.fn();
function Fixture() {
    const [requested, setRequested] = useState({id: "a", target});
    const sequence = useRef(0);
    return h(ContextPanelHostProvider, {target: portal, surfaceWidth: 1440, navigationWidth: 260},
        h("button", {onClick: () => setRequested({id: `b-${++sequence.current}`, target: second})}, "Inspect B"),
        h("button", {onClick: () => setRequested({id: `c-${++sequence.current}`, target: third})}, "Inspect C"),
        h(ShotDetailPanel, {request: requested, onRequestOutcome: outcomes, onClosed: closed}));
}
async function settle(check: () => void) {await vi.waitFor(async () => {await act(async () => {}); check();});}
async function click(label: string) {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label || node.getAttribute("aria-label") === label);
    expect(button, label).toBeTruthy();
    await act(async () => button!.click());
}
async function input(label: string, value: string) {
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
    expect(element).toBeTruthy();
    await act(async () => {
        Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value);
        element.dispatchEvent(new Event("input", {bubbles: true}));
    });
    return element;
}
beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class {observe() {} unobserve() {} disconnect() {}});
    container = document.createElement("div"); portal = document.createElement("div");
    document.body.append(container, portal); root = createRoot(container); closed.mockClear(); outcomes.mockClear();
    blockers.clear();
    routeResolution.status = "idle";
    routeResolution.assigned = false;
    routeResolution.proceed.mockClear(); routeResolution.reset.mockClear();
    const project = await createProject("Single shot");
    const episode = await db.episodes.where("projectId").equals(project.id).first();
    if (!episode) throw new Error("missing episode");
    const shots = await Promise.all([addShot(project.id, episode.id), addShot(project.id, episode.id), addShot(project.id, episode.id)]);
    [target, second, third] = shots.map(shot => ({projectId: project.id, episodeId: episode.id, shotId: shot.id}));
    await patchShot(target.shotId, {content: "opening content"});
    await act(async () => root.render(h(Fixture)));
    await settle(() => expect(portal.querySelector("[data-shot-editor]")).not.toBeNull());
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); portal.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe("single-shot real DOM and product commands", () => {
    it("refreshes a route confirmation when inline pending settles under an open media editor", async () => {
        const repository = getVideoWorkspaceRepository();
        let reject!: (cause: Error) => void;
        const write = vi.spyOn(repository, "patchShot").mockImplementation(() => new Promise<void>((_resolve, fail) => {reject = fail;}));
        const tile = portal.querySelector<HTMLButtonElement>(`[aria-label^="镜头 "][aria-label$="首帧"]`)!;
        await act(async () => tile.click());
        routeResolution.status = "blocked";
        await input("镜头内容", "Pending inline draft");
        await settle(() => expect(write).toHaveBeenCalledOnce());
        expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("正在处理修改");
        await act(async () => reject(new DraftConflictError()));
        await settle(() => expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("放弃并离开"));
        expect(portal.querySelector("[data-shot-detail]")?.getAttribute("aria-busy")).toBe("true");
        await click("继续编辑");
        routeResolution.status = "idle";
        await click("采用最新内容");
        await click("取消");
    });
    it("retains an open media session locally while delegating real route dirtiness to that editor", async () => {
        const locations = {current: {pathname: "/agent/current"}, next: {pathname: "/settings"}};
        const originalGuards = [...blockers];
        expect(originalGuards.every(guard => !guard.shouldBlockFn(locations))).toBe(true);
        const tile = portal.querySelector<HTMLButtonElement>(`[aria-label^="镜头 "][aria-label$="首帧"]`)!;
        expect(tile).not.toBeNull();
        await act(async () => tile.click());
        await settle(() => expect(document.querySelector('.side-panel-sheet')).not.toBeNull());
        // Opening a clean media dialog is not unsaved work for either route owner.
        expect(originalGuards.every(guard => !guard.shouldBlockFn(locations))).toBe(true);
        const prompt = document.querySelector<HTMLTextAreaElement>('.side-panel-sheet textarea')!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "media draft");
            prompt.dispatchEvent(new Event("input", {bubbles: true}));
        });
        expect(originalGuards.every(guard => !guard.shouldBlockFn(locations))).toBe(true);
        expect([...blockers].some(guard => guard.shouldBlockFn(locations))).toBe(true);
        expect(portal.querySelector('[data-shot-detail]')?.getAttribute("aria-busy")).toBe("true");
        await click("取消");
        await settle(() => expect(portal.querySelector('[data-shot-detail]')?.getAttribute("aria-busy")).toBe("false"));
    });
    it("adopting latest after a failed numeric save also clears later invalid raw punctuation", async () => {
        const repository = getVideoWorkspaceRepository();
        let reject!: (cause: Error) => void;
        const write = vi.spyOn(repository, "patchShot").mockImplementation(() => new Promise<void>((_resolve, fail) => {reject = fail;}));
        await input("时长（秒）", "7.5");
        await settle(() => expect(write).toHaveBeenCalledOnce());
        const duration = await input("时长（秒）", "invalid");
        await act(async () => reject(new DraftConflictError()));
        await settle(() => expect(portal.textContent).toContain("采用最新内容"));
        await click("采用最新内容");
        await settle(() => expect(duration.getAttribute("aria-invalid")).toBe("false"));
        expect(duration.value).toBe(String((await db.shots.get(target.shotId))?.durationSec ?? 0));
        await click("关闭");
        expect(closed).toHaveBeenCalledOnce();
    });
    it("rejects foreign and missing owner envelopes without showing or editing the prior shot", async () => {
        const foreign = await createProject("Foreign project");
        second = {...second, projectId: foreign.id};
        await click("Inspect B");
        await settle(() => expect(portal.textContent).toContain("找不到这个镜头"));
        expect(portal.querySelector("[data-shot-editor]")).toBeNull();
        expect(portal.textContent).not.toContain("opening content");
        third = {...third, shotId: "missing-shot"};
        await click("Inspect C");
        await settle(() => expect(portal.querySelector("[data-shot-detail]")?.getAttribute("data-shot-detail")).toBe("missing-shot"));
        expect(portal.querySelector("[data-shot-editor]")).toBeNull();
        expect((await db.shots.get(target.shotId))?.content).toBe("opening content");
    });
    it("keeps a pending numeric write on its frozen shot until the command settles", async () => {
        const repository = getVideoWorkspaceRepository();
        const original = repository.patchShot.bind(repository);
        let release!: () => void;
        const gate = new Promise<void>(resolve => {release = resolve;});
        const write = vi.spyOn(repository, "patchShot").mockImplementation(async (...args) => {await gate; await original(...args);});
        const duration = await input("时长（秒）", "4.25");
        await settle(() => expect(write).toHaveBeenCalledOnce());
        await click("Inspect B");
        expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("正在处理修改");
        expect([...document.querySelectorAll("button")].some(button => button.textContent === "放弃并离开")).toBe(false);
        expect(portal.querySelector('[aria-label="时长（秒）"]')).toBe(duration);
        await act(async () => {release();});
        await settle(() => expect(portal.querySelector("[data-shot-detail]")?.getAttribute("aria-busy")).toBe("false"));
        expect((await db.shots.get(target.shotId))?.durationSec).toBe(4.25);
        expect((await db.shots.get(second.shotId))?.durationSec).not.toBe(4.25);
        await click("继续编辑");
        await click("Inspect B");
        await settle(() => expect(portal.querySelector("[data-shot-editor]")?.getAttribute("data-shot-editor")).toBe(second.shotId));
    });
    it("keeps invalid duration and the original identity on cancel; a competing selection is refused while the frozen B request waits for discard", async () => {
        const duration = await input("时长（秒）", "invalid");
        expect(duration.getAttribute("aria-invalid")).toBe("true");
        await click("Inspect B");
        expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("保留未保存");
        expect(portal.querySelector("[data-shot-editor]")?.getAttribute("data-shot-editor")).toBe(target.shotId);
        await click("继续编辑");
        expect(document.querySelector('[aria-label="时长（秒）"]')).toBe(duration);
        expect(duration.value).toBe("invalid");
        await click("Inspect B");
        // Programmatic request represents a competing owner callback while the modal is active.
        await click("Inspect C");
        await click("放弃并离开");
        await settle(() => expect(portal.querySelector("[data-shot-editor]")?.getAttribute("data-shot-editor")).toBe(second.shotId));
        expect(outcomes).toHaveBeenCalledWith(expect.objectContaining({status: "refused", reason: "busy"}));
        expect((await db.shots.get(target.shotId))?.durationSec).not.toBeNaN();
    });
    it("merges independent Agent writes and preserves a conflicting manual draft with explicit latest recovery", async () => {
        const content = await input("镜头内容", "manual content");
        expect(content.value).toBe("manual content");
        await act(async () => patchShot(target.shotId, {notes: "Agent notes"}));
        await settle(() => expect(portal.querySelector('[data-text-draft$=":content"] [role=status]')?.textContent).toBe("已保存"));
        expect(await db.shots.get(target.shotId)).toMatchObject({content: "manual content", notes: "Agent notes"});
        await input("镜头内容", "conflicting manual");
        await act(async () => patchShot(target.shotId, {content: "Agent wins current row"}));
        await settle(() => expect(portal.querySelector('[data-text-draft$=":content"] [role=alert]')).not.toBeNull());
        expect(content.value).toBe("conflicting manual");
        expect((await db.shots.get(target.shotId))?.content).toBe("Agent wins current row");
        await click("关闭");
        expect(closed).not.toHaveBeenCalled();
        await click("继续编辑");
        await click("采用最新内容");
        await settle(() => expect(content.value).toBe("Agent wins current row"));
        await click("关闭");
        expect(closed).toHaveBeenCalledOnce();
    });
    it("retains a deleted dirty target for reading and disables manual retry writes", async () => {
        const content = await input("镜头内容", "retained after deletion");
        await act(async () => deleteShots([target.shotId]));
        await settle(() => expect(portal.textContent).toContain("找不到这个镜头"));
        expect(content.value).toBe("retained after deletion");
        expect(content.readOnly).toBe(true);
        await settle(() => expect(portal.querySelector('[data-text-draft$=":content"] [role=alert]')).not.toBeNull());
        await click("重试");
        expect(await db.shots.get(target.shotId)).toBeUndefined();
        await click("关闭"); await click("放弃并离开");
        expect(closed).toHaveBeenCalledOnce();
    });
});
