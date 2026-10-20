// @vitest-environment jsdom
import {act, createElement} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {DownloadCard} from "../apps/site/src/download/DownloadCard";
import {STAR_DISPLAY_THRESHOLD, StarPrompt} from "../apps/site/src/download/StarPrompt";
import type {DetectedPlatform} from "@momoki/distribution/platform";
import type {LatestDesktopRelease, ReleaseResult} from "@momoki/distribution/releases";

const BASE = "https://github.com/ROYIANS/momoki/releases/download/desktop-v0.1.1/";
const NAMES = ["Momoki_0.1.1_macos_arm64.dmg", "Momoki_0.1.1_macos_x64.dmg", "Momoki_0.1.1_windows_x64_setup.exe", "Momoki_0.1.1_linux_x64.deb", "Momoki_0.1.1_linux_x64.AppImage"];
const release: LatestDesktopRelease = {
    tag: "desktop-v0.1.1", version: "0.1.1", prerelease: true, htmlUrl: "https://github.com/ROYIANS/momoki/releases/tag/desktop-v0.1.1", publishedAt: "2026-10-13T09:08:10Z",
    assets: NAMES.map(name => ({name, size: 16_198_950, url: BASE + name, sha256: "b".repeat(64)})),
};
const ok: ReleaseResult = {kind: "ok", release};
const plat = (os: DetectedPlatform["os"], arch: DetectedPlatform["arch"], mobile = false): DetectedPlatform => ({os, arch, mobile});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

async function render(element: ReturnType<typeof createElement>) {
    await act(async () => root.render(element));
}
const card = (result?: ReleaseResult, platform?: DetectedPlatform) => render(createElement(DownloadCard, {release: result, platform}));
const anchors = () => [...container.querySelectorAll("a")];
const byText = (text: string) => anchors().find(a => a.textContent?.includes(text));

describe("DownloadCard", () => {
    it("reserves its layout while loading and always offers the releases page", async () => {
        await card();
        expect(container.querySelector(".lp-download")?.getAttribute("aria-busy")).toBe("true");
        expect(container.textContent).toContain("正在查找最新版本");
        expect(byText("在 GitHub 查看所有版本")?.getAttribute("href")).toBe("https://github.com/ROYIANS/momoki/releases");
        await card(ok, undefined); // release ready but platform not yet detected
        expect(container.textContent).toContain("正在查找最新版本");
    });

    it("recommends the matching installer with version, prerelease and unsigned notes", async () => {
        await card(ok, plat("windows", "x64"));
        const primary = byText("下载 Windows 版")!;
        expect(primary.getAttribute("href")).toBe(BASE + "Momoki_0.1.1_windows_x64_setup.exe");
        expect(primary.getAttribute("data-umami-event")).toBe("download-windows-x64");
        expect(primary.getAttribute("rel")).toBe("noopener noreferrer");
        expect(container.textContent).toContain("v0.1.1");
        expect(container.textContent).toContain("预发布");
        expect(container.textContent).toContain("2026年10月13日");
        expect(container.textContent).toContain("Momoki_0.1.1_windows_x64_setup.exe · 15.4 MB");
        expect(container.textContent).toContain("未签名");
        expect(byText("查看安装指南")?.getAttribute("href")).toBe("https://github.com/ROYIANS/momoki/blob/main/docs/desktop-installation.md");
    });

    it("shows both dmg files when the Mac chip is unknown, with a how-to-check hint", async () => {
        await card(ok, plat("macos", "unknown"));
        expect(byText("下载 ")).toBeUndefined();
        const apple = container.querySelector<HTMLAnchorElement>("a[data-umami-event='download-macos-arm64']")!;
        const intel = container.querySelector<HTMLAnchorElement>("a[data-umami-event='download-macos-x64']")!;
        expect(apple.getAttribute("href")).toBe(BASE + "Momoki_0.1.1_macos_arm64.dmg");
        expect(intel.getAttribute("href")).toBe(BASE + "Momoki_0.1.1_macos_x64.dmg");
        expect(container.textContent).toContain("关于本机");
    });

    it("does not offer an x64 package to ARM Windows", async () => {
        await card(ok, plat("windows", "arm64"));
        expect(container.textContent).toContain("暂无该架构的安装包");
        expect(container.querySelector(".lp-dl-buttons")).toBeNull();
        expect(anchors().some(a => a.getAttribute("href")!.includes("windows_x64"))).toBe(false);
        expect(container.textContent).not.toContain("未签名");
        expect(byText("在 GitHub 查看所有版本")).toBeTruthy();
    });

    it("tells phone visitors to use a computer and links the releases page", async () => {
        await card(ok, plat("ios", "unknown", true));
        expect(container.textContent).toContain("电脑");
        expect(container.querySelector(".lp-dl-buttons")).toBeNull();
        expect(byText("在 GitHub 查看所有版本")).toBeTruthy();
    });

    it("degrades to a releases link for each failure reason", async () => {
        for (const reason of ["network", "rate-limit", "no-release", "invalid"] as const) {
            await card({kind: "fallback", reason}, plat("windows", "x64"));
            expect(container.querySelector(".lp-download")?.getAttribute("aria-busy")).toBe("false");
            expect(container.querySelector(".lp-dl-buttons")).toBeNull();
            expect(byText("在 GitHub 查看所有版本")?.getAttribute("href")).toBe("https://github.com/ROYIANS/momoki/releases");
        }
        await card({kind: "fallback", reason: "rate-limit"}, undefined);
        expect(container.textContent).toContain("限流");
    });

    it("collects other packages and SHA256 digests in collapsed details", async () => {
        await card(ok, plat("linux", "x64"));
        expect(byText("下载 Linux（AppImage） 版")?.getAttribute("href")).toBe(BASE + "Momoki_0.1.1_linux_x64.AppImage");
        const [others, sums] = [...container.querySelectorAll("details")];
        expect(others.open).toBe(false);
        expect(others.textContent).toContain("Linux（.deb）");
        expect(others.querySelector("a[data-umami-event='download-linux-x64-deb']")).toBeTruthy();
        expect(sums.textContent).toContain("b".repeat(64));
        expect(sums.textContent).toContain("SHA256SUMS");
    });

    it("links only to github.com in every state", async () => {
        const states: Array<[ReleaseResult | undefined, DetectedPlatform | undefined]> = [
            [undefined, undefined], [ok, plat("macos", "unknown")], [ok, plat("macos", "arm64")], [ok, plat("windows", "arm64")],
            [ok, plat("linux", "x64")], [ok, plat("android", "unknown", true)], [{kind: "fallback", reason: "network"}, plat("unknown", "unknown")],
        ];
        for (const [result, platform] of states) {
            await card(result, platform);
            for (const a of anchors()) {
                const href = a.getAttribute("href")!;
                if (href.startsWith("#") || href.startsWith("/") || href.startsWith("mailto:")) continue;
                expect(new URL(href).hostname, href).toBe("github.com");
                expect(a.getAttribute("rel")).toContain("noopener");
            }
        }
    });
});

describe("StarPrompt", () => {
    it("links to the repository with a formatted count from the display threshold on, and tracks the click", async () => {
        await render(createElement(StarPrompt, {stars: 1234}));
        const link = container.querySelector("a")!;
        expect(link.getAttribute("href")).toBe("https://github.com/ROYIANS/momoki");
        expect(link.getAttribute("data-umami-event")).toBe("star");
        expect(link.getAttribute("rel")).toBe("noopener noreferrer");
        expect(container.textContent).toContain("1.2k");
        expect(container.querySelector("img")).toBeNull();
        await render(createElement(StarPrompt, {stars: STAR_DISPLAY_THRESHOLD}));
        expect(container.querySelector(".lp-star-count")?.textContent).toBe("（50）");
    });

    it("renders no number or brackets when the count is unavailable or below the threshold", async () => {
        expect(STAR_DISPLAY_THRESHOLD).toBe(50);
        for (const stars of [undefined, 0, 3, STAR_DISPLAY_THRESHOLD - 1]) {
            await render(createElement(StarPrompt, {stars}));
            expect(container.textContent).not.toMatch(/[0-9（）()]/);
            expect(container.querySelector(".lp-star-count")).toBeNull();
            expect(container.textContent).toContain("点一颗 star");
        }
    });
});
