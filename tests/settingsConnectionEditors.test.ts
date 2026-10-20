// @vitest-environment jsdom
import {act, createElement} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("@tanstack/react-router", async original => ({...await original<typeof import("@tanstack/react-router")>(), useBlocker: () => ({status: "idle", proceed: vi.fn(), reset: vi.fn()})}));

const boundary = vi.hoisted(() => ({save: vi.fn()}));
vi.mock("@/features/settings/commands/searchConnections", async original => ({
    ...await original<typeof import("@/features/settings/commands/searchConnections")>(), saveSearchConnection: boundary.save,
}));

// Keep the real page, connection owners, inputs and Radix dialog. This boundary
// supplies an already-read empty connector list and unconfigured search key.
vi.mock("@/platform/product/queries", () => ({
    useProductQuery: () => ({connectors: [], state: {configured: false, enabled: true}}),
    useProductQueryState: () => ({value: {autoCheck: false, lastCheck: undefined}, error: null}),
}));

import {SettingsPage} from "@/features/settings/ui/SettingsPage";

let root: Root;
let container: HTMLDivElement;
const search = () => container.querySelector<HTMLInputElement>('input[aria-label="搜索设置"]')!;
const dialog = () => document.body.querySelector<HTMLElement>('[data-slot="context-panel-content"]');
const button = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
    .find(element => element.textContent?.trim() === label)!;
const click = (element: HTMLElement) => act(async () => {element.click();});
function inputNow(element: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", {bubbles: true}));
}
const input = (element: HTMLInputElement, value: string) => act(async () => {inputNow(element, value);});
function deferredSave() {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => {resolve = yes;});
    return {promise, resolve};
}
const renderSection = (section: string) => act(async () => {
    root.render(createElement(SettingsPage, {section, onSectionChange: vi.fn()}));
});

beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    boundary.save.mockReset().mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {root.render(createElement(SettingsPage, {section: "connections", onSectionChange: vi.fn()}));});
});
afterEach(async () => {
    await act(async () => {root.unmount();});
    container.remove();
    vi.unstubAllGlobals();
});

describe("settings search while editing connection credentials", () => {
    it("preserves the real Tavily dialog and credential draft when background search receives autofill", async () => {
        await click(button("网络搜索连接"));
        await click(button("配置 Tavily"));
        const opened = dialog();
        expect(opened).not.toBeNull();
        const key = opened!.querySelector<HTMLInputElement>('input[type="password"]')!;
        expect(key).not.toBeNull();
        await input(key, "tvly-local-draft-for-regression");
        await input(search(), "browser-autofilled-login-name");
        expect(dialog()).toBe(opened);
        expect(dialog()!.querySelector('input[type="password"]')).toBe(key);
        expect(key.value).toBe("tvly-local-draft-for-regression");
        expect(search().value).toBe("");
        expect(container.querySelector("h1")?.textContent).toBe("模型");
        expect(container.textContent).not.toContain("browser-autofilled-login-name");
        expect(search().autocomplete).toBe("off");
        expect(key.autocomplete).toBe("new-password");

        const close = opened!.querySelector<HTMLButtonElement>('.context-panel-return')!;
        expect(close).not.toBeNull();
        await click(close);
        expect(dialog()).toBeNull();
        await input(search(), "界面语言");
        expect(container.querySelector("h1")?.textContent).toBe("外观");
        expect(container.textContent).toContain("界面语言");
        await input(search(), "");
        expect(container.querySelector("h1")?.textContent).toBe("模型");
    });

    it("guards the existing search handler immediately when Tavily opens in the same DOM turn", async () => {
        await click(button("网络搜索连接"));
        const background = search();
        const configure = button("配置 Tavily");
        await act(async () => {
            configure.click();
            inputNow(background, "autofill-before-page-rerender");
        });
        expect(dialog()).not.toBeNull();
        expect(dialog()!.textContent).toContain("Tavily 联网搜索");
        expect(search().value).toBe("");
        expect(container.querySelector("h1")?.textContent).toBe("模型");
    });

    it("renders the network-search subgroup with the same decorative icon structure", () => {
        const network = button("网络搜索连接");
        expect(network).toBeDefined();
        expect(network.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
        expect(button("模型连接").querySelector('svg[aria-hidden="true"]')).not.toBeNull();
        expect(button("模型目录").querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    });

    it("keeps a new editor locked when a retired Tavily save completes after navigating away and back", async () => {
        const saving = deferredSave();
        boundary.save.mockReturnValueOnce(saving.promise);
        await click(button("网络搜索连接"));
        await click(button("配置 Tavily"));
        const oldDialog = dialog()!;
        await input(oldDialog.querySelector<HTMLInputElement>('input[type="password"]')!, "tvly-old-save");
        await click(button("保存搜索连接"));
        expect(boundary.save).toHaveBeenCalledExactlyOnceWith({apiKey: "tvly-old-save", enabled: true});

        // Route props retire the actual Connections owner while preserving the
        // parent SettingsPage and its shared editor/search-lock callback.
        await renderSection("general");
        expect(dialog()).toBeNull();
        await renderSection("connections");
        await click(button("网络搜索连接"));
        await click(button("配置 Tavily"));
        const newDialog = dialog()!;
        const newKey = newDialog.querySelector<HTMLInputElement>('input[type="password"]')!;
        await input(newKey, "tvly-new-editor-draft");
        expect(search().disabled).toBe(true);

        await act(async () => {saving.resolve(); await saving.promise;});
        expect(search().disabled).toBe(true);
        expect(dialog()).toBe(newDialog);
        expect(newKey.value).toBe("tvly-new-editor-draft");
        await input(search(), "autofill-after-retired-save");
        expect(dialog()).toBe(newDialog);
        expect(dialog()!.querySelector('input[type="password"]')).toBe(newKey);
        expect(newKey.value).toBe("tvly-new-editor-draft");
        expect(search().value).toBe("");
        expect(container.querySelector("h1")?.textContent).toBe("模型");
    });

    it("does not dismiss a Tavily dialog in the same DOM turn that its save starts", async () => {
        const saving = deferredSave();
        boundary.save.mockReturnValueOnce(saving.promise);
        await click(button("网络搜索连接"));
        await click(button("配置 Tavily"));
        const opened = dialog()!;
        await input(opened.querySelector<HTMLInputElement>('input[type="password"]')!, "tvly-saving-draft");
        const save = button("保存搜索连接");
        const close = opened.querySelector<HTMLButtonElement>('.context-panel-return')!;
        await act(async () => {save.click(); close.click();});
        expect(boundary.save).toHaveBeenCalledTimes(1);
        expect(dialog()).toBe(opened);
        expect(search().disabled).toBe(true);
        await act(async () => {saving.resolve(); await saving.promise;});
        expect(dialog()).toBeNull();
        expect(search().disabled).toBe(false);
    });
});
