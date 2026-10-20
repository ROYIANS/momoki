// @vitest-environment jsdom
import {act, createElement as h, Fragment, useState} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {LibraryMaterial} from "@/features/library/models/materials";
import {StorageError, UnknownCommitError} from "@/platform/storage/errors";

const routing = vi.hoisted(() => ({blockers: [] as Array<{shouldBlockFn: () => boolean; enableBeforeUnload: boolean}>}));
vi.mock("@tanstack/react-router", () => ({useBlocker: (options: {shouldBlockFn: () => boolean; enableBeforeUnload: boolean}) => {
    routing.blockers.push(options); return {status: "idle", reset: vi.fn(), proceed: vi.fn()};
}}));
vi.mock("@/platform/product/queries", () => ({useProductQuery: () => ({ips: [], projects: []})}));
vi.mock("@/features/library/commands/materials", () => ({createFileMaterial: vi.fn()}));
import {createFileMaterial} from "@/features/library/commands/materials";
import {MaterialImportDialog} from "@/features/library/ui/materials/MaterialImportDialog";

const create = vi.mocked(createFileMaterial);
const files = ["A.txt", "B.txt", "C.txt"].map(name => new File([name], name, {type: "text/plain"}));
const imported = vi.fn(), closed = vi.fn();
function material(id: string): LibraryMaterial {
    return {id, name: id, kind: "document", scope: {kind: "global"}, revision: 1, archived: false, notes: "", tags: [], createdAt: "2026-10-15", updatedAt: "2026-10-15"};
}
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}
const interrupted = vi.fn();
function Owner({initialScope = "global"}: {initialScope?: string}) {
    const [open, setOpen] = useState(true);
    return h(Fragment, null, h("button", {type: "button", onClick: () => setOpen(true)}, "打开导入"),
        h(MaterialImportDialog, {open, initialScope, onClose: () => {closed(); setOpen(false);}, onImported: imported, onInterrupted: interrupted}));
}
let root: Root, container: HTMLDivElement;
function button(label: string) {
    const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent?.trim() === label);
    if (!result) throw new Error(`Missing button: ${label}`);
    return result;
}
async function click(label: string) {await act(async () => button(label).click());}
async function select(selected = files) {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", {configurable: true, value: selected});
    await act(async () => input.dispatchEvent(new Event("change", {bubbles: true})));
}
function remaining() {return [...document.querySelectorAll(".material-file-list li > span")].map(element => element.textContent);}
function progress() {return document.querySelector('[role="status"]')?.textContent?.replace(/\s+/g, " ");}
beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class {observe() {} unobserve() {} disconnect() {}});
    create.mockReset(); interrupted.mockReset(); imported.mockReset(); closed.mockReset(); routing.blockers = [];
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(h(Owner, {})));
});
afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
});

describe("E05 serial file import", () => {
    it("admits once, stops after the held current acknowledgement and resumes only remaining files in the captured scope", async () => {
        const first = deferred<LibraryMaterial>();
        create.mockImplementationOnce(() => first.promise).mockResolvedValueOnce(material("B")).mockResolvedValueOnce(material("C"));
        await select();
        await act(async () => {const send = button("导入 3 个文件"); send.click(); send.click();});
        expect(create).toHaveBeenCalledTimes(1); expect(progress()).toContain("已导入 0 / 3"); expect(progress()).toContain("A.txt");
        expect(button("取消").disabled).toBe(true);
        await click("返回工作区"); expect(document.querySelector('[data-slot="context-panel-content"]')).toBeTruthy(); expect(closed).not.toHaveBeenCalled();
        await act(async () => root.render(h(Owner, {initialScope: "project:other"})));
        await act(async () => {const stop = button("停止后续导入"); stop.click(); stop.click();});
        expect(button("停止后续导入").disabled).toBe(true); expect(progress()).toContain("当前文件完成后停止");
        await act(async () => first.resolve(material("A")));
        expect(create).toHaveBeenCalledTimes(1); expect(remaining()).toEqual(["B.txt", "C.txt"]); expect(progress()).toContain("已导入 1 / 3");
        await select([]); expect(remaining()).toEqual(["B.txt", "C.txt"]); expect(progress()).toContain("已导入 1 / 3");
        expect(imported).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled();
        await click("继续导入");
        expect(create.mock.calls.map(call => call[0])).toEqual(files);
        expect(create.mock.calls.map(call => call[1])).toEqual([{kind: "global"}, {kind: "global"}, {kind: "global"}]);
        expect(imported).toHaveBeenCalledExactlyOnceWith("C"); expect(closed).toHaveBeenCalledTimes(1);
    });

    it("retains the known rolled-back head and retries it without importing acknowledged predecessors", async () => {
        create.mockResolvedValueOnce(material("A")).mockRejectedValueOnce(new StorageError("unavailable", "B 无法保存"));
        await select(); await click("导入 3 个文件");
        expect(remaining()).toEqual(["B.txt", "C.txt"]); expect(progress()).toContain("已导入 1 / 3");
        expect(document.querySelector('[role="alert"]')?.textContent).toContain("B 无法保存");
        expect(imported).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled();
        create.mockResolvedValueOnce(material("B")).mockResolvedValueOnce(material("C"));
        await click("继续导入");
        expect(create.mock.calls.map(call => call[0].name)).toEqual(["A.txt", "B.txt", "B.txt", "C.txt"]);
        expect(imported).toHaveBeenCalledExactlyOnceWith("C"); expect(closed).toHaveBeenCalledTimes(1);
    });

    it.each([
        new UnknownCommitError("operation", "workspace"),
        new StorageError("unavailable", "lost acknowledgement", "unknown"),
    ])("quarantines typed uncertain results through hide/reopen and keeps the route guard", async cause => {
        create.mockResolvedValueOnce(material("A")).mockRejectedValueOnce(cause);
        await select(); await click("导入 3 个文件");
        expect(create).toHaveBeenCalledTimes(2); expect(remaining()).toEqual(["B.txt", "C.txt"]); expect(progress()).toContain("已导入 1 / 3");
        expect(button("继续导入").disabled).toBe(true); expect(button("选择文件").disabled).toBe(true);
        expect(document.querySelector('[role="alert"]')?.textContent).toContain("导入结果待确认");
        await click("查看素材库");
        expect(document.querySelector('[data-slot="context-panel-content"]')).toBeNull(); expect(imported).not.toHaveBeenCalled();
        expect(routing.blockers.at(-1)?.shouldBlockFn()).toBe(true); expect(routing.blockers.at(-1)?.enableBeforeUnload).toBe(true);
        await act(async () => root.render(h(Owner, {initialScope: "project:other"})));
        await click("打开导入");
        expect(remaining()).toEqual(["B.txt", "C.txt"]); expect(progress()).toContain("已导入 1 / 3");
        await click("继续导入"); expect(create).toHaveBeenCalledTimes(2);
        const input = document.querySelector<HTMLInputElement>('input[type="file"]')!; expect(input.disabled).toBe(true);
        await select([new File(["new"], "B.txt", {type: "text/plain"})]);
        expect(remaining()).toEqual(["B.txt", "C.txt"]); expect(create).toHaveBeenCalledTimes(2);
    });

    it("retains an ordinary stopped queue when discard is declined, then opens a clean session in its current scope", async () => {
        const first = deferred<LibraryMaterial>(); create.mockImplementationOnce(() => first.promise);
        await select(); await click("导入 3 个文件"); await click("停止后续导入");
        await act(async () => first.resolve(material("A")));
        await click("取消"); await click("继续编辑"); expect(remaining()).toEqual(["B.txt", "C.txt"]);
        await click("取消"); await click("放弃并离开");
        await act(async () => root.render(h(Owner, {initialScope: "project:new"})));
        await click("打开导入"); expect(remaining()).toEqual([]);
        create.mockResolvedValueOnce(material("D")); await select([new File(["D"], "D.txt", {type: "text/plain"})]);
        await click("导入 1 个文件"); expect(create.mock.calls.at(-1)?.[1]).toEqual({kind: "project", id: "new"});
        expect(imported).toHaveBeenCalledExactlyOnceWith("D");
    });

    it.each(["open", "close"])("does not reclassify a %s callback failure as a failed import to replay", async phase => {
        create.mockResolvedValueOnce(material("A"));
        (phase === "open" ? imported : closed).mockImplementationOnce(() => {throw new Error("opening failed");});
        await select([files[0]]); await click("导入 1 个文件");
        expect(create).toHaveBeenCalledTimes(1); expect(imported).toHaveBeenCalledExactlyOnceWith("A");
        expect(closed).toHaveBeenCalledTimes(phase === "open" ? 0 : 1);
        expect(document.querySelector('[role="alert"]')?.textContent).toContain("全部文件已导入");
        expect(remaining()).toEqual([]); expect(button(phase === "open" ? "继续导入" : "导入").disabled).toBe(true);
    });

    it("lets the user resolve a verified unknown file by re-importing it or skipping it", async () => {
        create.mockResolvedValueOnce(material("A")).mockRejectedValueOnce(new UnknownCommitError("operation", "workspace"));
        await select(); await click("导入 3 个文件");
        expect(button("继续导入").disabled).toBe(true);
        create.mockResolvedValueOnce(material("B")).mockResolvedValueOnce(material("C"));
        await click("已核对，重新导入此文件");
        expect(button("继续导入").disabled).toBe(false); expect(remaining()).toEqual(["B.txt", "C.txt"]);
        await click("继续导入");
        expect(create.mock.calls.map(call => call[0].name)).toEqual(["A.txt", "B.txt", "B.txt", "C.txt"]);
        expect(imported).toHaveBeenCalledExactlyOnceWith("C");
    });

    it("skips only the verified uncertain head and continues with the remaining files", async () => {
        create.mockResolvedValueOnce(material("A")).mockRejectedValueOnce(new UnknownCommitError("operation", "workspace"));
        await select(); await click("导入 3 个文件");
        await click("已核对，跳过此文件继续");
        expect(remaining()).toEqual(["C.txt"]); expect(progress()).toContain("已导入 1 / 2");
        create.mockResolvedValueOnce(material("C"));
        await click("继续导入");
        expect(create.mock.calls.map(call => call[0].name)).toEqual(["A.txt", "B.txt", "C.txt"]);
        expect(imported).toHaveBeenCalledExactlyOnceWith("C");
    });

    it("reports a mid-batch unmount with what was saved and what was dropped", async () => {
        const first = deferred<LibraryMaterial>();
        create.mockImplementationOnce(() => first.promise);
        await select(); await click("导入 3 个文件");
        await act(async () => root.render(null));
        await act(async () => first.resolve(material("A")));
        expect(create).toHaveBeenCalledTimes(1);
        expect(interrupted).toHaveBeenCalledExactlyOnceWith({completed: 1, remaining: 2, uncertain: false});
        expect(imported).not.toHaveBeenCalled();
    });

    it("keeps the route guard installed while an import is pending", async () => {
        const first = deferred<LibraryMaterial>();
        create.mockImplementationOnce(() => first.promise);
        await select(); await click("导入 3 个文件");
        expect(routing.blockers.at(-1)?.shouldBlockFn()).toBe(true); expect(routing.blockers.at(-1)?.enableBeforeUnload).toBe(true);
        await act(async () => first.reject(new Error("stop")));
    });
});
