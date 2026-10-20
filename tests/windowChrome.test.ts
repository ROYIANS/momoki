import {afterEach, describe, expect, it, vi} from "vitest";
import {getWindowChromeKind} from "@/platform/runtime/windowChrome";

afterEach(() => vi.unstubAllGlobals());

describe("runtime window presentation", () => {
    it("keeps browser layout even with an incidental macOS chrome marker", () => {
        vi.stubGlobal("window", {
            __MOMOKI_WINDOW_CHROME__: {version: 1, kind: "macos-overlay"},
            __MOMOKI_PRODUCT_PROFILE__: {version: 1, id: "native-looking", storage: "sqlite"},
        });
        expect(getWindowChromeKind()).toBe("browser");
    });

    it("works without a window or native services", () => {
        vi.stubGlobal("window", undefined);
        expect(getWindowChromeKind()).toBe("browser");
    });

    it.each(["sqlite", "indexeddb"])("reserves overlay space independent of %s storage, without IPC", storage => {
        const invoke = vi.fn(() => {throw new Error("Unexpected native request");});
        vi.stubGlobal("window", {
            __TAURI_INTERNALS__: {invoke},
            __MOMOKI_WINDOW_CHROME__: Object.freeze({version: 1, kind: "macos-overlay"}),
            __MOMOKI_PRODUCT_PROFILE__: {version: 1, id: "native", storage},
        });
        expect(getWindowChromeKind()).toBe("macos-overlay");
        expect(invoke).not.toHaveBeenCalled();
    });

    it.each([undefined, {version: 1, kind: "native"}, {version: 2, kind: "macos-overlay"}])(
        "does not reserve macOS space for ordinary or unknown native chrome (%j)", chrome => {
            const invoke = vi.fn(() => {throw new Error("Unexpected native request");});
            vi.stubGlobal("window", {__TAURI_INTERNALS__: {invoke}, __MOMOKI_WINDOW_CHROME__: chrome});
            expect(getWindowChromeKind()).toBe("native");
            expect(invoke).not.toHaveBeenCalled();
        },
    );
});
