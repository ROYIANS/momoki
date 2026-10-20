import {beforeEach, describe, expect, it, vi} from "vitest";
import {createElement, type ReactNode} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {UpdateState, DownloadState} from "@/features/settings/ui/useUpdateCheck";

const host = vi.hoisted(() => ({
    state: {kind: "idle"} as UpdateState,
    download: {kind: "idle"} as DownloadState,
    native: true,
    runCheck: vi.fn(),
    startDownload: vi.fn(),
    cancelDownload: vi.fn(),
}));
vi.mock("@/features/settings/ui/useUpdateCheck", () => ({useUpdateCheck: () => host}));
vi.mock("@/platform/runtime/runtimeIdentity", () => ({isTauriRuntime: () => host.native}));
vi.mock("@/platform/runtime/appVersion", () => ({appVersion: () => "0.1.3"}));
vi.mock("@tanstack/react-router", () => ({Link: ({to, children}: {to: string; children: ReactNode}) => createElement("a", {href: to}, children)}));

import {UpdateSection} from "@/features/settings/ui/sections/UpdateSection";
import {classifyUpdate} from "@momoki/distribution/version";
import type {LatestDesktopRelease} from "@momoki/distribution/releases";
import type {AssetChoice} from "@momoki/distribution/platform";

function release(version: string): LatestDesktopRelease {
    return {version, tag: `desktop-v${version}`, htmlUrl: `https://github.com/ROYIANS/momoki/releases/tag/desktop-v${version}`,
        publishedAt: "2026-10-14T06:00:00Z", prerelease: false, assets: []};
}
const asset: AssetChoice = {
    os: "windows", arch: "x64", format: "exe", label: "Windows", event: "download-windows-x64",
    asset: {name: "Momoki_0.1.4_windows_x64_setup.exe", size: 12 * 1024 * 1024,
        url: "https://github.com/ROYIANS/momoki/releases/download/desktop-v0.1.4/Momoki_0.1.4_windows_x64_setup.exe",
        sha256: "a".repeat(64)},
};
const render = () => renderToStaticMarkup(createElement(UpdateSection));

beforeEach(() => {
    host.state = {kind: "idle"};
    host.download = {kind: "idle"};
    host.native = true;
});

describe("update verdict presentation", () => {
    it.each([
        ["0.1.3", "0.1.4", "发现新版本 0.1.4", "升级前请先导出备份"],
        ["0.1.3", "0.1.3", "已是最新版本", undefined],
        ["0.1.3", "0.1.2", "当前版本高于线上", undefined],
        ["dev", "0.1.4", "无法比较版本", "请前往发布页查看"],
    ])("renders the real %s versus %s classification as %s", (current, latest, title, explanation) => {
        host.state = {kind: "ready", release: release(latest), verdict: classifyUpdate(current, latest), asset};
        const html = render();
        expect(html).toContain(title);
        if (explanation) expect(html).toContain(explanation);
        else expect(html).not.toContain("线上最新版本一致");
        const verdictTitles = ["发现新版本", "已是最新版本", "当前版本高于线上", "无法比较版本"];
        verdictTitles.filter(value => !title.includes(value)).forEach(value => expect(html).not.toContain(value));
        if (current === "0.1.3" && latest === "0.1.4") expect(html).toContain("下载（12.0 MB）");
        else expect(html).not.toContain("下载（12.0 MB）");
    });

    it("provides a release-page explanation when an update has no matching platform package", () => {
        host.state = {kind: "ready", release: release("0.1.4"), verdict: "update-available"};
        const html = render();
        expect(html).toContain("当前平台没有可直接下载的安装包");
        expect(html).toContain("打开发布页");
        expect(html).not.toContain("下载（12.0 MB）");
    });

    it("renders failure feedback together with a release-page fallback", () => {
        host.state = {kind: "failed", reason: "GitHub 请求过于频繁，请稍后再试。"};
        const html = render();
        expect(html).toContain("检查失败");
        expect(html).toContain("GitHub 请求过于频繁");
        expect(html).toContain("打开发布页");
    });

    it("disables the check control while checking", () => {
        host.state = {kind: "checking"};
        const html = render();
        expect(html).toContain("正在检查…");
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*>/);
    });

    it("links to the actual release and retains a separate installation guide", () => {
        host.state = {kind: "ready", release: release("0.1.4"), verdict: "update-available", asset};
        host.download = {kind: "saved", name: asset.asset.name, format: "exe"};
        const html = render();
        expect(html).toContain('href="https://github.com/ROYIANS/momoki/releases/tag/desktop-v0.1.4"');
        expect(html).toContain('href="https://github.com/ROYIANS/momoki/blob/main/docs/desktop-installation.md"');
        expect(html).toContain('href="/about"');
    });

    it.each(["missing-digest", "oversize", "browser"])("offers browser download for %s packages", mode => {
        const choice = {...asset, asset: {...asset.asset}};
        if (mode === "missing-digest") choice.asset.sha256 = undefined;
        if (mode === "oversize") choice.asset.size = 64 * 1024 * 1024 + 1;
        if (mode === "browser") host.native = false;
        host.state = {kind: "ready", release: release("0.1.4"), verdict: "update-available", asset: choice};
        const html = render();
        expect(html).toContain("浏览器下载（");
        expect(html).toContain(`href="${asset.asset.url}"`);
        expect(html).toContain("通过系统浏览器下载");
    });

    it("reports system-save cancellation with retry guidance and no success claim", () => {
        host.download = {kind: "canceled"};
        const html = render();
        expect(html).toContain("已取消下载或保存");
        expect(html).toContain("没有保存安装包，可以重新下载");
        expect(html).toContain('role="status"');
        expect(html).not.toContain("安装包已保存");
        expect(html).not.toContain("下载失败");
        expect(html).not.toContain("NaN");
    });

    it("shows a distinct waiting message while the native save dialog is open", () => {
        host.download = {kind: "saving"};
        const html = render();
        expect(html).toContain("请选择保存位置，正在等待系统保存完成");
        expect(html).toContain("取消");
        expect(html).not.toContain("NaN");
    });

    it.each([
        ["dmg", "打开 dmg 后将默默拖入应用程序文件夹"],
        ["exe", "先退出默默，再运行 setup.exe 安装"],
        ["appimage", "先给 AppImage 文件添加执行权限"],
        ["deb", "用系统的软件安装器打开 .deb 文件"],
    ] as const)("shows installation steps for saved %s packages", (format, instructions) => {
        host.download = {kind: "saved", name: "Momoki-install-package", format};
        const html = render();
        expect(html).toContain("安装包已保存");
        expect(html).toContain("Momoki-install-package");
        expect(html).toContain(instructions);
        expect(html).toContain("覆盖安装前先导出备份");
    });

    it("retains a published-file warning without treating the saved file as an ordinary failure", () => {
        host.download = {kind: "saved", name: asset.asset.name, format: "exe", warning: "保存后的文件状态需要确认"};
        const html = render();
        expect(html).toContain("安装包已保存，请检查文件");
        expect(html).toContain("保存后的文件状态需要确认");
        expect(html).not.toContain("下载失败");
    });
});
