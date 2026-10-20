// @vitest-environment jsdom
import {act, createElement as h} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {ErrorDetailsDialog, NO_AUTO_SEND_NOTICE, diagnosticFilename} from "@/app/errors/ErrorDetailsDialog";
import {closeErrorDetails, openErrorDetails} from "@/app/errors/errorDetailsStore";
import {showError} from "@/app/errors/showError";
import {reportError, resetReportedErrorsForTests} from "@/platform/diagnostics/reportError";

vi.mock("sonner", () => ({toast: {error: vi.fn()}}));
const downloadBlob = vi.fn();
vi.mock("@/platform/runtime/runtimeSave", () => ({downloadBlob: (...args: unknown[]) => downloadBlob(...args)}));
const nativeOpen = vi.fn();
vi.mock("@/platform/runtime/nativeSystemServices", () => ({nativeOpenExternalUrl: (...args: unknown[]) => nativeOpen(...args)}));
let tauri = false;
vi.mock("@/platform/runtime/runtimeIdentity", () => ({isTauriRuntime: () => tauri}));
const {toast} = await import("sonner");

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const SECRETS = ["sk-abcdefghijklmnop1234567890", "Bearer topsecrettoken123", "/Users/alice/Library/data", "user:pass@", "token=abc123xyz"];
function secretError(): Error {
    return new Error(`请求失败 key=sk-abcdefghijklmnop1234567890 Authorization: Bearer topsecrettoken123 at /Users/alice/Library/data via https://user:pass@example.com/v1?token=abc123xyz`);
}

let root: Root, container: HTMLDivElement;
const button = (label: string) => [...document.body.querySelectorAll("button")].find(b => b.textContent === label)!;
const textarea = () => document.body.querySelector("textarea")!;
const status = () => document.body.querySelector("[role=status]")!.textContent ?? "";

beforeEach(async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    resetReportedErrorsForTests();
    downloadBlob.mockReset().mockResolvedValue("saved");
    nativeOpen.mockReset().mockResolvedValue(undefined);
    tauri = false;
    vi.spyOn(globalThis, "fetch");
    Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText: vi.fn().mockResolvedValue(undefined)}});
    reportError(secretError(), {source: "action", actionName: "send-message"});
    await act(async () => { root.render(h(ErrorDetailsDialog)); });
    await act(async () => { openErrorDetails(); });
});
afterEach(async () => {
    await act(async () => { closeErrorDetails(); });
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
});

describe("ErrorDetailsDialog", () => {
    it("shows the no-auto-send notice and a sanitized report", () => {
        expect(document.body.textContent).toContain(NO_AUTO_SEND_NOTICE);
        expect(NO_AUTO_SEND_NOTICE).toContain("不会自动发送");
        expect(textarea().readOnly).toBe(true);
        for (const secret of SECRETS) expect(textarea().value).not.toContain(secret);
        expect(textarea().value).toContain("Momoki 诊断信息");
    });
    it("copies through the clipboard", async () => {
        await act(async () => { button("复制诊断信息").click(); });
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(textarea().value);
        expect(status()).toContain("已复制");
    });
    it("falls back to selecting the textarea when copy fails", async () => {
        Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText: vi.fn().mockRejectedValue(new Error("denied"))}});
        await act(async () => { button("复制诊断信息").click(); });
        const area = textarea();
        expect(document.activeElement).toBe(area);
        expect(area.selectionStart).toBe(0);
        expect(area.selectionEnd).toBe(area.value.length);
        expect(status()).toContain("⌘/Ctrl+C");
    });
    it("falls back when the clipboard is unavailable", async () => {
        Object.defineProperty(navigator, "clipboard", {configurable: true, value: undefined});
        await act(async () => { button("复制诊断信息").click(); });
        expect(status()).toContain("手动复制");
    });
    it("saves a sanitized text file with a timestamped name", async () => {
        await act(async () => { button("保存为文件").click(); });
        const [blob, name] = downloadBlob.mock.calls[0] as [Blob, string];
        expect(name).toMatch(/^momoki-diagnostic-\d{8}-\d{6}\.txt$/);
        expect(diagnosticFilename(new Date(2026, 9, 13, 8, 5, 9))).toBe("momoki-diagnostic-20261013-080509.txt");
        const text = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
        expect(text).toBe(textarea().value);
        for (const secret of SECRETS) expect(text).not.toContain(secret);
        expect(status()).toContain("已保存");
    });
    it("reports save failure without echoing content", async () => {
        downloadBlob.mockRejectedValue(new Error("sk-abcdefghijklmnop1234567890"));
        await act(async () => { button("保存为文件").click(); });
        expect(status()).toBe("保存失败，请改用复制");
    });
    it("opens a sanitized prefilled issue in the browser", async () => {
        const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
        await act(async () => { button("在 GitHub 反馈").click(); });
        const url = open.mock.calls[0]![0] as string;
        expect(url).toContain("/issues/new?");
        const decoded = decodeURIComponent(url);
        for (const secret of SECRETS) expect(decoded).not.toContain(secret);
        expect(open.mock.calls[0]![2]).toContain("noopener");
        expect(nativeOpen).not.toHaveBeenCalled();
    });
    it("uses the native opener on desktop", async () => {
        tauri = true;
        const open = vi.spyOn(window, "open");
        await act(async () => { button("在 GitHub 反馈").click(); });
        expect(nativeOpen).toHaveBeenCalledTimes(1);
        expect(open).not.toHaveBeenCalled();
        expect(status()).toContain("GitHub");
    });
    it("tells the user when the issue cannot be opened", async () => {
        vi.spyOn(window, "open").mockReturnValue(null);
        await act(async () => { button("在 GitHub 反馈").click(); });
        expect(status()).toContain("无法打开 GitHub");
    });
    it("sends nothing automatically", async () => {
        await act(async () => { const other = new Error(`另一个失败 ${secretError().message}`); showError({cause: other, actionName: "send-message", detail: other.message}); });
        expect(fetch).not.toHaveBeenCalled();
        const [, options] = vi.mocked(toast.error).mock.calls.at(-1)!;
        for (const secret of SECRETS) expect(String(options?.description)).not.toContain(secret);
    });
});
