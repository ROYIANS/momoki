// @vitest-environment jsdom
import {act, createElement as h, type ReactNode, useState} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {db} from "@/platform/product/store";
import {createProject} from "@/features/projects/commands/projects";
import * as assets from "@/features/library/commands/assets";
import {ContextPanelHostProvider} from "@/app/layout/ContextPanelHost";
import {AssetDetailPanel} from "@/features/library/ui/AssetDetailPanel";
import type {AssetDetailTarget} from "@/features/library/models/assetDetailTarget";
import type {DetailPanelCloseRequest, DetailPanelRequest} from "@/app/layout/detailPanelSession";
import {DraftConflictError} from "@/platform/product/draftConflict";
import {UnknownCommitError} from "@/platform/storage/errors";
import {flushPendingDrafts} from "@/platform/product/drafts";

type Guard = {shouldBlockFn: (locations: {current: {pathname: string}; next: {pathname: string}}) => boolean};
const blockers = vi.hoisted(() => new Set<Guard>());
vi.mock("@tanstack/react-router", () => ({
    useNavigate: () => vi.fn(),
    useBlocker: (options: Guard) => {blockers.add(options); return {status: "idle", proceed: vi.fn(), reset: vi.fn()};},
    Link: ({to, children, ...props}: {to: string; children?: ReactNode}) => h("a", {href: to, ...props}, children),
}));

let root: Root, container: HTMLDivElement, portal: HTMLDivElement;
let target: AssetDetailTarget, second: AssetDetailTarget, third: AssetDetailTarget;
const closed = vi.fn(), outcomes = vi.fn(), closeRefused = vi.fn();
let drive: {request: (request: DetailPanelRequest<AssetDetailTarget>) => void; width: (width: number) => void; close: (request: DetailPanelCloseRequest) => void};
function Fixture() {
    const [request, setRequest] = useState({id: "a", target});
    const [width, setWidth] = useState(1440);
    const [closeRequest, setCloseRequest] = useState<DetailPanelCloseRequest>();
    drive = {request: setRequest, width: setWidth, close: setCloseRequest};
    return h(ContextPanelHostProvider, {target: portal, surfaceWidth: width, navigationWidth: 260},
        h(AssetDetailPanel, {request, closeRequest, onCloseRefused: closeRefused, onRequestOutcome: outcomes, onClosed: closed, returnLabel: "返回批量审阅"}));
}
async function settle(check: () => void) {await vi.waitFor(async () => {await act(async () => {}); check();});}
function button(label: string) {
    const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label || node.getAttribute("aria-label") === label);
    expect(element, label).toBeTruthy(); return element!;
}
async function click(label: string) {await act(async () => button(label).click());}
function nameInput() {return portal.querySelector<HTMLInputElement>('[data-asset-text$=":name"] input')!;}
function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
    Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", {bubbles: true}));
}
async function select(target: AssetDetailTarget, id: string) {await act(async () => drive.request({id, target}));}
beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class {observe() {} unobserve() {} disconnect() {}});
    container = document.createElement("div"); portal = document.createElement("div");
    document.body.append(container, portal); root = createRoot(container);
    closed.mockClear(); outcomes.mockClear(); closeRefused.mockClear(); blockers.clear();
    const project = await createProject("Retained asset pane");
    const a = await assets.addCharacter(project.id), b = await assets.addCharacter(project.id), c = await assets.addProp(project.id);
    await assets.patchCharacter(a.id, {name: "Opening name"});
    target = {kind: "character", owner: {kind: "project", projectId: project.id}, entityId: a.id};
    second = {...target, entityId: b.id}; third = {...target, kind: "prop", entityId: c.id};
    await act(async () => root.render(h(Fixture)));
    await settle(() => expect(nameInput()?.value).toBe("Opening name"));
});
afterEach(async () => {
    await act(async () => root.unmount());
    if (target.owner.kind === "project") await flushPendingDrafts(target.owner.projectId);
    container.remove(); portal.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("asset detail real DOM and existing commands", () => {
    it("reports input synchronously before an immediate close and keeps its frozen command target through a delayed save", async () => {
        const original = assets.patchCharacter; let release!: () => void;
        const gate = new Promise<void>(resolve => {release = resolve;});
        const write = vi.spyOn(assets, "patchCharacter").mockImplementation(async (...args) => {await gate; await original(...args);});
        const input = nameInput(), close = button("关闭");
        await act(async () => {type(input, "Frozen manual name"); close.click();});
        expect(closed).not.toHaveBeenCalled();
        expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("正在处理修改");
        expect([...document.querySelectorAll("button")].some(node => node.textContent === "放弃并离开")).toBe(false);
        await settle(() => expect(write).toHaveBeenCalledOnce());
        expect(write).toHaveBeenCalledWith(target.entityId, {name: "Frozen manual name"}, {name: "Opening name"});
        expect(nameInput()).toBe(input); await click("继续编辑");
        await select(second, "b");
        expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("正在处理修改");
        await act(async () => release());
        await settle(() => expect(portal.querySelector('[data-asset-detail]')?.getAttribute("aria-busy")).toBe("false"));
        expect((await db.characters.get(target.entityId))?.name).toBe("Frozen manual name");
        expect((await db.characters.get(second.entityId))?.name).not.toBe("Frozen manual name");
        await click("继续编辑"); await select(second, "b-after-save");
        await settle(() => expect(portal.querySelector('[data-asset-editor]')?.getAttribute("data-asset-editor")).toBe(second.entityId));
    });
    it("protects input→immediate replacement, reports the refused incoming ID, and accepts only the frozen candidate under competition", async () => {
        const write = vi.spyOn(assets, "patchCharacter").mockRejectedValue(new DraftConflictError());
        const input = nameInput();
        await act(async () => {type(input, "Conflicting draft"); drive.request({id: "b-cancel", target: second});});
        expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("正在处理修改");
        expect(nameInput()).toBe(input); await click("继续编辑");
        expect(outcomes).toHaveBeenCalledWith({requestId: "b-cancel", status: "refused", reason: "guard"});
        await settle(() => expect(portal.querySelector('[data-asset-text$=":name"] [role=alert]')).not.toBeNull());
        await select(second, "b-frozen"); await select(third, "c-competing");
        expect(outcomes).toHaveBeenCalledWith({requestId: "c-competing", status: "refused", reason: "busy"});
        await click("放弃并离开");
        await settle(() => expect(portal.querySelector('[data-asset-editor]')?.getAttribute("data-asset-editor")).toBe(second.entityId));
        expect(outcomes).toHaveBeenCalledWith({requestId: "b-frozen", status: "presented"});
        expect(portal.querySelector('[data-asset-editor]')?.getAttribute("data-asset-editor")).not.toBe(third.entityId);
        expect(write).toHaveBeenCalledOnce();
    });
    it("keeps the exact editor DOM across width and same-target new request IDs, with guarded return in both presentations", async () => {
        const input = nameInput(); input.focus(); input.setSelectionRange(2, 5);
        await select({...target, owner: {...target.owner}}, "a-new-origin");
        expect(nameInput()).toBe(input);
        expect(outcomes).toHaveBeenCalledWith({requestId: "a-new-origin", status: "presented"});
        expect(portal.textContent).toContain("返回批量审阅");
        await act(async () => drive.width(760)); expect(nameInput()).toBe(input);
        await act(async () => drive.width(1440)); expect(nameInput()).toBe(input);
        expect(outcomes.mock.calls.filter(([value]) => value.requestId === "a-new-origin" && value.status === "presented")).toHaveLength(1);
        await act(async () => drive.close({id: "stale-return", requestId: "a", reason: "return"}));
        expect(closeRefused).toHaveBeenCalledWith("stale-return"); expect(closed).not.toHaveBeenCalled();
        await click("返回批量审阅");
        expect(closed).toHaveBeenCalledWith({requestId: "a-new-origin", reason: "return"});
    });
    it("preserves field CAS conflicts and merges an independent Agent edit with a known-rollback retry", async () => {
        const input = nameInput();
        await act(async () => {type(input, "Manual name");});
        await assets.patchCharacter(target.entityId, {notes: "Independent Agent notes"});
        await settle(() => expect(portal.querySelector('[data-asset-text$=":name"] [role=status]')?.textContent).toBe("已保存"));
        expect(await db.characters.get(target.entityId)).toMatchObject({name: "Manual name", notes: "Independent Agent notes"});
        await act(async () => type(input, "Conflicting manual"));
        await assets.patchCharacter(target.entityId, {name: "Agent current name"});
        await settle(() => expect(portal.querySelector('[data-asset-text$=":name"] [role=alert]')).not.toBeNull());
        expect(input.value).toBe("Conflicting manual");
        await click("采用最新内容"); expect(input.value).toBe("Agent current name");
        const original = assets.patchCharacter;
        const retry = vi.spyOn(assets, "patchCharacter").mockRejectedValueOnce(new Error("Known rollback"));
        await act(async () => type(input, "Retry exactly this name"));
        await settle(() => expect(portal.querySelector('[data-asset-text$=":name"] [role=alert]')).not.toBeNull());
        retry.mockImplementation(original); await click("重试");
        await settle(() => expect(portal.querySelector('[data-asset-text$=":name"] [role=status]')?.textContent).toBe("已保存"));
        expect(retry).toHaveBeenCalledTimes(2);
        expect(retry.mock.calls[1]).toEqual([target.entityId, {name: "Retry exactly this name"}, {name: "Agent current name"}]);
        expect((await db.characters.get(target.entityId))?.name).toBe("Retry exactly this name");
    });
    it("quarantines an unknown text commit across flush and resume until only that intent is explicitly discarded", async () => {
        const uncertain = new UnknownCommitError("asset-name-op", "workspace");
        const write = vi.spyOn(assets, "patchCharacter").mockRejectedValue(uncertain);
        const input = nameInput(); await act(async () => type(input, "Unknown name result"));
        await settle(() => expect(portal.textContent).toContain("未确认是否已保存"));
        expect(input.value).toBe("Unknown name result"); expect(input.readOnly).toBe(true);
        expect([...portal.querySelectorAll("button")].some(node => node.textContent === "重试")).toBe(false);
        if (target.owner.kind !== "project") throw new Error("Expected project owner");
        const owner = target.owner.projectId;
        await act(async () => {await expect(flushPendingDrafts(owner)).rejects.toBe(uncertain);});
        expect(write).toHaveBeenCalledOnce();
        // External teardown can resume a retained failed controller; it must keep quarantine.
        await act(async () => root.render(null)); await act(async () => root.render(h(Fixture)));
        await settle(() => expect(nameInput()?.value).toBe("Unknown name result"));
        await act(async () => {await expect(flushPendingDrafts(owner)).rejects.toBe(uncertain);});
        expect(write).toHaveBeenCalledOnce(); expect(nameInput().readOnly).toBe(true);
        await click("关闭"); expect(closed).not.toHaveBeenCalled();
        await click("放弃并离开"); expect(closed).toHaveBeenCalledWith({requestId: "a", reason: "close"});
        await act(async () => flushPendingDrafts(owner)); expect(write).toHaveBeenCalledOnce();
        write.mockRestore(); await act(async () => type(nameInput(), "A new explicit intent"));
        await act(async () => flushPendingDrafts(owner));
        expect((await db.characters.get(target.entityId))?.name).toBe("A new explicit intent");
    });
    it("retains real slot session and its own route guard while aggregating local panel departure", async () => {
        const locations = {current: {pathname: "/agent/current"}, next: {pathname: "/settings"}};
        const originalGuards = [...blockers];
        const tile = portal.querySelector<HTMLButtonElement>('[aria-label^="角色 · "]')!;
        await act(async () => tile.click());
        const prompt = document.querySelector<HTMLTextAreaElement>('.side-panel-sheet textarea')!;
        expect(prompt).toBeTruthy(); await act(async () => type(prompt, "Existing slot draft"));
        expect(originalGuards.every(guard => !guard.shouldBlockFn(locations))).toBe(true);
        expect([...blockers].some(guard => guard.shouldBlockFn(locations))).toBe(true);
        await select(second, "b-slot");
        expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("正在处理修改");
        await click("继续编辑"); expect(document.querySelector('.side-panel-sheet textarea')).toBe(prompt);
        await click("保存");
        await settle(() => expect(document.querySelector('.side-panel-sheet')).toBeNull());
        const row = await db.characters.get(target.entityId);
        expect(Object.values(row!.slots).some(slot => slot.prompt === "Existing slot draft")).toBe(true);
        expect(portal.querySelector('[data-asset-detail]')?.getAttribute("aria-busy")).toBe("false");
    });
});
