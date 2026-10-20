import {describe, expect, it} from "vitest";
import {detectPlatform, pickAssets, type DetectedPlatform, type NavigatorInfo} from "@momoki/distribution/platform";
import type {LatestDesktopRelease} from "@momoki/distribution/releases";

const BASE = "https://github.com/ROYIANS/momoki/releases/download/desktop-v0.1.1/";
const NAMES = [
    "Momoki_0.1.1_macos_arm64.dmg", "Momoki_0.1.1_macos_x64.dmg", "Momoki_0.1.1_windows_x64_setup.exe",
    "Momoki_0.1.1_linux_x64.deb", "Momoki_0.1.1_linux_x64.AppImage", "SHA256SUMS", "release-manifest.json",
];
const release = (names = NAMES, version = "0.1.1"): LatestDesktopRelease => ({
    tag: `desktop-v${version}`, version, prerelease: true, htmlUrl: `https://github.com/ROYIANS/momoki/releases/tag/desktop-v${version}`,
    assets: names.map(name => ({name, size: 10, url: BASE + name})),
});
const plat = (os: DetectedPlatform["os"], arch: DetectedPlatform["arch"], mobile = false): DetectedPlatform => ({os, arch, mobile});
const names = (list: {asset: {name: string}}[]) => list.map(item => item.asset.name);

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0";

describe("detectPlatform", () => {
    it("reads macOS chip only from high-entropy client hints", async () => {
        const hints = (architecture: unknown): NavigatorInfo => ({userAgent: MAC_UA, platform: "MacIntel", userAgentData: {platform: "macOS", getHighEntropyValues: async () => ({architecture})}});
        expect(await detectPlatform(hints("arm"))).toEqual(plat("macos", "arm64"));
        expect(await detectPlatform(hints("x86"))).toEqual(plat("macos", "x64"));
        expect(await detectPlatform(hints("riscv"))).toEqual(plat("macos", "unknown"));
        expect(await detectPlatform({userAgent: MAC_UA, platform: "MacIntel"})).toEqual(plat("macos", "unknown"));
    });

    it("tolerates a throwing or missing high-entropy API", async () => {
        const failing: NavigatorInfo = {userAgent: MAC_UA, userAgentData: {platform: "macOS", getHighEntropyValues: () => Promise.reject(new Error("denied"))}};
        expect(await detectPlatform(failing)).toEqual(plat("macos", "unknown"));
        const throwing: NavigatorInfo = {userAgent: WIN_UA, userAgentData: {platform: "Windows", getHighEntropyValues: () => {throw new Error("sync");}}};
        await expect(detectPlatform(throwing)).resolves.toEqual(plat("windows", "x64"));
        expect(await detectPlatform({userAgent: WIN_UA, userAgentData: {platform: "Windows"}})).toEqual(plat("windows", "x64"));
    });

    it("defaults Windows and Linux to x64 and detects ARM", async () => {
        expect(await detectPlatform({userAgent: WIN_UA, platform: "Win32"})).toEqual(plat("windows", "x64"));
        expect(await detectPlatform({userAgent: WIN_UA, userAgentData: {platform: "Windows", getHighEntropyValues: async () => ({architecture: "arm"})}})).toEqual(plat("windows", "arm64"));
        expect(await detectPlatform({userAgent: LINUX_UA, platform: "Linux x86_64"})).toEqual(plat("linux", "x64"));
        expect(await detectPlatform({userAgent: LINUX_UA.replace("x86_64", "aarch64"), platform: "Linux aarch64"})).toEqual(plat("linux", "arm64"));
        expect(await detectPlatform({userAgent: LINUX_UA, userAgentData: {platform: "Linux", getHighEntropyValues: async () => ({architecture: "arm"})}})).toEqual(plat("linux", "arm64"));
    });

    it("marks phones and tablets as mobile with no architecture", async () => {
        expect(await detectPlatform({userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", platform: "iPhone"})).toEqual(plat("ios", "unknown", true));
        expect(await detectPlatform({userAgent: MAC_UA, platform: "MacIntel", maxTouchPoints: 5})).toEqual(plat("ios", "unknown", true));
        expect(await detectPlatform({userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile", platform: "Linux armv81"})).toEqual(plat("android", "unknown", true));
        expect(await detectPlatform({userAgent: "x", userAgentData: {platform: "Android", mobile: true}})).toEqual(plat("android", "unknown", true));
    });

    it("prefers userAgentData.platform, then navigator.platform, then the user agent; unknown stays unknown", async () => {
        expect((await detectPlatform({userAgent: WIN_UA, platform: "Linux x86_64", userAgentData: {platform: "macOS"}})).os).toBe("macos");
        expect((await detectPlatform({userAgent: WIN_UA, platform: "Linux x86_64"})).os).toBe("linux");
        expect((await detectPlatform({userAgent: WIN_UA, platform: ""})).os).toBe("windows");
        expect(await detectPlatform({userAgent: "curl/8"})).toEqual(plat("unknown", "unknown"));
        expect((await detectPlatform({userAgent: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)", platform: "Linux x86_64", userAgentData: {platform: "Chrome OS"}})).os).toBe("unknown");
    });
});

describe("pickAssets", () => {
    it("recommends the exact installer per platform", () => {
        expect(pickAssets(release(), plat("macos", "arm64")).primary?.asset.name).toBe("Momoki_0.1.1_macos_arm64.dmg");
        expect(pickAssets(release(), plat("macos", "x64")).primary?.asset.name).toBe("Momoki_0.1.1_macos_x64.dmg");
        expect(pickAssets(release(), plat("windows", "x64")).primary?.asset.name).toBe("Momoki_0.1.1_windows_x64_setup.exe");
        const linux = pickAssets(release(), plat("linux", "x64"));
        expect(linux.primary?.asset.name).toBe("Momoki_0.1.1_linux_x64.AppImage");
        expect(names(linux.alternatives)).toContain("Momoki_0.1.1_linux_x64.deb");
        expect(linux.primary?.event).toBe("download-linux-x64-appimage");
    });

    it("never treats SHA256SUMS or the manifest as installers", () => {
        const all = [...names([...pickAssets(release(), plat("windows", "x64")).alternatives]), "Momoki_0.1.1_windows_x64_setup.exe"];
        expect(all).not.toContain("SHA256SUMS");
        expect(all).not.toContain("release-manifest.json");
    });

    it("matches names strictly: version must equal the tag, no extra prefix/suffix, case-sensitive", () => {
        const bad = release([
            "Momoki_0.1.0_macos_arm64.dmg", "xMomoki_0.1.1_macos_x64.dmg", "Momoki_0.1.1_windows_x64_setup.exe.sig",
            "momoki_0.1.1_linux_x64.deb", "Momoki_0.1.1_linux_x64.appimage", "Momoki_0.1.1_macos_arm64.dmg.zip",
        ]);
        for (const p of [plat("macos", "arm64"), plat("macos", "x64"), plat("windows", "x64"), plat("linux", "x64")]) {
            const pick = pickAssets(bad, p);
            expect(pick.primary).toBeUndefined();
            expect(pick.alternatives).toEqual([]);
        }
        expect(pickAssets(release(["Momoki_0.1.1_macos_arm64.dmg"], "0.1.2"), plat("macos", "arm64")).primary).toBeUndefined();
    });

    it("offers both dmg files when the Mac chip is unknown", () => {
        const pick = pickAssets(release(), plat("macos", "unknown"));
        expect(pick.ambiguous).toBe(true);
        expect(pick.primary).toBeUndefined();
        expect(names(pick.alternatives).slice(0, 2)).toEqual(["Momoki_0.1.1_macos_arm64.dmg", "Momoki_0.1.1_macos_x64.dmg"]);
    });

    it("does not recommend x64 packages to ARM Windows or Linux", () => {
        for (const os of ["windows", "linux"] as const) {
            const pick = pickAssets(release(), plat(os, "arm64"));
            expect(pick.primary).toBeUndefined();
            expect(pick.unsupportedReason).toBe("暂无该架构的安装包");
            expect(names(pick.alternatives).some(name => name.includes(os === "windows" ? "windows" : "linux"))).toBe(false);
        }
    });

    it("lists every package without a recommendation for mobile and unknown systems", () => {
        for (const p of [plat("ios", "unknown", true), plat("android", "unknown", true), plat("unknown", "unknown")]) {
            const pick = pickAssets(release(), p);
            expect(pick.primary).toBeUndefined();
            expect(pick.ambiguous).toBeUndefined();
            expect(pick.alternatives).toHaveLength(5);
        }
    });

    it("leaves primary empty when that platform's file is missing", () => {
        const pick = pickAssets(release(["Momoki_0.1.1_macos_arm64.dmg"]), plat("windows", "x64"));
        expect(pick.primary).toBeUndefined();
        expect(pick.unsupportedReason).toBeUndefined();
        expect(names(pick.alternatives)).toEqual(["Momoki_0.1.1_macos_arm64.dmg"]);
    });
});
