import {isTauriRuntime} from "./runtimeIdentity";

type WindowChromeKind = "macos-overlay" | "native" | "browser";

declare global {
    interface Window {
        /** Frozen by native initialization; presentation is independent of the storage profile. */
        __MOMOKI_WINDOW_CHROME__?: unknown;
    }
}

export function getWindowChromeKind(): WindowChromeKind {
    if (!isTauriRuntime()) return "browser";
    const chrome = window.__MOMOKI_WINDOW_CHROME__;
    return chrome && typeof chrome === "object" &&
    "version" in chrome && chrome.version === 1 &&
    "kind" in chrome && chrome.kind === "macos-overlay"
        ? "macos-overlay" : "native";
}
