import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {DownloadAssetResult} from "@/features/settings/updates/download";
import type {LatestDesktopRelease, ReleaseResult} from "@momoki/distribution/releases";
import type {AssetChoice} from "@momoki/distribution/platform";

type Effect = {deps?: unknown[]; setup: () => void | (() => void); cleanup?: () => void};
type Host = {cells: unknown[]; cursor: number; effects: Array<() => void>; mounted: boolean; lateWrites: number};
const boundary = vi.hoisted(() => ({
    active: undefined as Host | undefined,
    fetchRelease: vi.fn(), downloadAsset: vi.fn(), save: vi.fn(), transport: vi.fn(),
    readEnabled: vi.fn(), readLastCheck: vi.fn(), writeLastCheck: vi.fn(),
}));

// Run the real hooks and their effects/callbacks with deterministic ownership.
// Transport and native save are injected; this is not native-dialog or browser
// ReactDOM scheduling evidence.
vi.mock("react", async original => {
    const actual = await original<typeof import("react")>();
    return {...actual,
        useState: (initial: unknown) => {
            const host = boundary.active!;
            const index = host.cursor++;
            if (!(index in host.cells)) host.cells[index] = typeof initial === "function" ? initial() : initial;
            return [host.cells[index], (next: unknown) => {
                if (!host.mounted) host.lateWrites++;
                host.cells[index] = typeof next === "function" ? next(host.cells[index]) : next;
            }];
        },
        useRef: (initial: unknown) => {
            const host = boundary.active!;
            const index = host.cursor++;
            if (!(index in host.cells)) host.cells[index] = {current: initial};
            return host.cells[index];
        },
        useEffect: (setup: Effect["setup"], deps?: unknown[]) => {
            const host = boundary.active!;
            const index = host.cursor++;
            const previous = host.cells[index] as Effect | undefined;
            if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
                const cell: Effect = {deps, setup};
                host.cells[index] = cell;
                host.effects.push(() => {previous?.cleanup?.(); cell.cleanup = setup() || undefined;});
            }
        },
        useCallback: (callback: unknown, deps: unknown[]) => {
            const host = boundary.active!;
            const index = host.cursor++;
            const previous = host.cells[index] as {deps: unknown[]; callback: unknown} | undefined;
            if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) host.cells[index] = {deps, callback};
            return (host.cells[index] as {callback: unknown}).callback;
        },
    };
});
vi.mock("@momoki/distribution/releases", async original => ({...await original<typeof import("@momoki/distribution/releases")>(), fetchLatestDesktopRelease: boundary.fetchRelease}));
vi.mock("@/features/settings/updates/download", () => ({downloadAsset: boundary.downloadAsset, MAX_RELEASE_ASSET_BYTES: 64 * 1024 * 1024}));
vi.mock("@/platform/runtime/runtimeFetch", () => ({runtimeFetchFor: (purpose: string) => {boundary.transport(purpose); return fetch;}}));
vi.mock("@/platform/runtime/runtimeSave", async original => ({...await original<typeof import("@/platform/runtime/runtimeSave")>(), downloadBlob: boundary.save}));
vi.mock("@/platform/runtime/appVersion", () => ({appVersion: () => "0.1.3"}));
vi.mock("@/features/settings/ui/settingsStore", async original => ({
    ...await original<typeof import("@/features/settings/ui/settingsStore")>(),
    readAutoCheckUpdates: boundary.readEnabled, readLastUpdateCheckAt: boundary.readLastCheck, writeLastUpdateCheckAt: boundary.writeLastCheck,
}));

import {useUpdateCheck} from "@/features/settings/ui/useUpdateCheck";
import {useAutoUpdateCheck} from "@/features/settings/ui/useAutoUpdateCheck";
import {UpdateSection} from "@/features/settings/ui/sections/UpdateSection";

const release: LatestDesktopRelease = {
    version: "0.1.4", tag: "desktop-v0.1.4", prerelease: false,
    htmlUrl: "https://github.com/ROYIANS/momoki/releases/tag/desktop-v0.1.4", assets: [],
};
const asset: AssetChoice = {
    os: "windows", arch: "x64", format: "exe", label: "Windows", event: "download-windows-x64",
    asset: {name: "Momoki_0.1.4_windows_x64_setup.exe", size: 3, sha256: "a".repeat(64),
        url: "https://github.com/ROYIANS/momoki/releases/download/desktop-v0.1.4/Momoki_0.1.4_windows_x64_setup.exe"},
};
const payload: DownloadAssetResult = {kind: "ok", bytes: new Uint8Array([1, 2, 3]), contentType: "application/octet-stream"};
const hosts: Host[] = [];
function mount(): Host {
    const host = {cells: [], cursor: 0, effects: [], mounted: true, lateWrites: 0};
    hosts.push(host);
    return host;
}
function draw<T>(host: Host, run: () => T): T {
    boundary.active = host;
    host.cursor = 0;
    const value = run();
    host.effects.splice(0).forEach(effect => effect());
    return value;
}
function effects(host: Host): Effect[] {
    return host.cells.filter((cell): cell is Effect => Boolean(cell) && typeof cell === "object" && "setup" in cell!);
}
function unmount(host: Host) {
    host.mounted = false;
    effects(host).forEach(effect => effect.cleanup?.());
}
function replay(host: Host) {
    effects(host).forEach(effect => effect.cleanup?.());
    effects(host).forEach(effect => {effect.cleanup = effect.setup() || undefined;});
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}
const flush = async () => {for (let index = 0; index < 8; index++) await Promise.resolve();};

beforeEach(() => {
    boundary.fetchRelease.mockReset().mockResolvedValue({kind: "ok", release});
    boundary.downloadAsset.mockReset().mockResolvedValue(payload);
    boundary.save.mockReset().mockResolvedValue("saved");
    boundary.readEnabled.mockReset().mockResolvedValue(false);
    boundary.readLastCheck.mockReset().mockResolvedValue(undefined);
    boundary.writeLastCheck.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {userAgent: "Windows NT 10.0; Win64; x64", platform: "Win32", maxTouchPoints: 0});
    vi.stubGlobal("window", {setTimeout, clearTimeout});
});
afterEach(() => {
    hosts.splice(0).forEach(host => {if (host.mounted) unmount(host);});
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("settings update check ownership", () => {
    it("serializes immediate repeated clicks and releases the lock for a later check", async () => {
        const pending = deferred<ReleaseResult>();
        boundary.fetchRelease.mockReturnValueOnce(pending.promise);
        const host = mount();
        const read = () => draw(host, useUpdateCheck);
        const check = read().runCheck();
        await read().runCheck();
        expect(boundary.fetchRelease).toHaveBeenCalledTimes(1);
        expect(read().state.kind).toBe("checking");
        pending.resolve({kind: "ok", release});
        await check;
        expect(read().state).toMatchObject({kind: "ready", verdict: "update-available", release});
        expect(boundary.transport).toHaveBeenCalledWith("release-check");
        expect(boundary.writeLastCheck).toHaveBeenCalledWith(expect.any(Number));
        await read().runCheck();
        expect(boundary.fetchRelease).toHaveBeenCalledTimes(2);
    });

    it.each([
        ["network", "网络请求失败"], ["rate-limit", "GitHub 请求过于频繁"],
        ["no-release", "还没有可供下载的桌面版本"], ["invalid", "返回内容异常"],
    ] as const)("maps the %s failure to visible copy and does not record success", async (reason, copy) => {
        boundary.fetchRelease.mockResolvedValue({kind: "fallback", reason});
        const host = mount();
        const read = () => draw(host, useUpdateCheck);
        await read().runCheck();
        expect(read().state).toEqual({kind: "failed", reason: expect.stringContaining(copy)});
        expect(boundary.writeLastCheck).not.toHaveBeenCalled();
    });

    it("handles unexpected request rejection and can retry", async () => {
        boundary.fetchRelease.mockRejectedValueOnce(new Error("unexpected transport failure"));
        const host = mount();
        const read = () => draw(host, useUpdateCheck);
        await expect(read().runCheck()).resolves.toBeUndefined();
        expect(read().state).toMatchObject({kind: "failed"});
        await read().runCheck();
        expect(read().state).toMatchObject({kind: "ready"});
    });

    it("aborts a pending check on unmount and prevents stale state or success writes", async () => {
        const pending = deferred<ReleaseResult>();
        boundary.fetchRelease.mockReturnValueOnce(pending.promise);
        const host = mount();
        const check = draw(host, useUpdateCheck).runCheck();
        const options = boundary.fetchRelease.mock.calls[0][0] as {signal: AbortSignal};
        unmount(host);
        expect(options.signal.aborted).toBe(true);
        pending.resolve({kind: "ok", release});
        await check;
        expect(host.lateWrites).toBe(0);
        expect(boundary.writeLastCheck).not.toHaveBeenCalled();
    });

    it("keeps automatic checks silent and still persists successful check time", async () => {
        const host = mount();
        const read = () => draw(host, useUpdateCheck);
        await read().runCheck(true);
        expect(read().state).toEqual({kind: "idle"});
        expect(boundary.fetchRelease).toHaveBeenCalledTimes(1);
        expect(boundary.writeLastCheck).toHaveBeenCalledTimes(1);
    });

    it("starts only the surviving page check during effect setup/cleanup replay", async () => {
        const host = mount();
        draw(host, () => UpdateSection({visibleRowIds: ["check"]}));
        replay(host);
        await flush();
        expect(boundary.fetchRelease).toHaveBeenCalledTimes(1);
        expect(host.lateWrites).toBe(0);
    });
});

describe("installer download and save ownership", () => {
    it("serializes download and save, publishes progress, and releases the lock after saving", async () => {
        const download = deferred<DownloadAssetResult>();
        const save = deferred<"saved">();
        boundary.downloadAsset.mockReturnValueOnce(download.promise);
        boundary.save.mockReturnValueOnce(save.promise);
        const host = mount();
        const read = () => draw(host, useUpdateCheck);
        const operation = read().startDownload(asset);
        await read().startDownload(asset);
        expect(boundary.downloadAsset).toHaveBeenCalledTimes(1);
        const options = boundary.downloadAsset.mock.calls[0][0] as {onProgress: (received: number, total: number) => void; onVerifying: () => void; signal: AbortSignal};
        options.onProgress(2, 3);
        expect(read().download).toEqual({kind: "downloading", loaded: 2, total: 3});
        options.onVerifying();
        expect(read().download).toEqual({kind: "verifying"});
        download.resolve(payload);
        await flush();
        expect(read().download).toEqual({kind: "saving"});
        await read().startDownload(asset);
        expect(boundary.downloadAsset).toHaveBeenCalledTimes(1);
        expect(boundary.save).toHaveBeenCalledWith(expect.any(Blob), asset.asset.name, options.signal);
        save.resolve("saved");
        await operation;
        expect(read().download).toEqual({kind: "saved", name: asset.asset.name, format: "exe"});
        await read().startDownload(asset);
        expect(boundary.downloadAsset).toHaveBeenCalledTimes(2);
        expect(boundary.transport).toHaveBeenCalledWith("release-asset");
    });

    it("reports a canceled system save instead of success or failure, then permits retry", async () => {
        boundary.save.mockResolvedValueOnce("canceled");
        const host = mount();
        const read = () => draw(host, useUpdateCheck);
        await read().startDownload(asset);
        expect(read().download).toEqual({kind: "canceled"});
        await read().startDownload(asset);
        expect(read().download).toMatchObject({kind: "saved"});
    });

    it("cancels before saving and ignores progress arriving after unmount", async () => {
        const pending = deferred<DownloadAssetResult>();
        boundary.downloadAsset.mockReturnValueOnce(pending.promise);
        const host = mount();
        const read = () => draw(host, useUpdateCheck);
        const operation = read().startDownload(asset);
        const options = boundary.downloadAsset.mock.calls[0][0] as {signal: AbortSignal; onProgress: (received: number, total: number) => void};
        read().cancelDownload();
        expect(options.signal.aborted).toBe(true);
        pending.resolve(payload);
        await operation;
        expect(read().download).toEqual({kind: "canceled"});
        expect(boundary.save).not.toHaveBeenCalled();
        unmount(host);
        options.onProgress(3, 3);
        expect(host.lateWrites).toBe(0);
    });

    it("retains a published-file warning even when cancellation races finalization", async () => {
        const save = deferred<"saved">();
        boundary.save.mockReturnValueOnce(save.promise);
        const host = mount();
        const read = () => draw(host, useUpdateCheck);
        const operation = read().startDownload(asset);
        await flush();
        read().cancelDownload();
        save.reject(Object.assign(new Error("file published; finalization warning"), {published: true}));
        await operation;
        expect(read().download).toEqual({kind: "saved", name: asset.asset.name, format: "exe", warning: "file published; finalization warning"});
    });

    it("reports an unresolved save failure rather than claiming cancellation or success", async () => {
        const save = deferred<"saved">();
        boundary.save.mockReturnValueOnce(save.promise);
        const host = mount();
        const read = () => draw(host, useUpdateCheck);
        const operation = read().startDownload(asset);
        await flush();
        read().cancelDownload();
        save.reject(new Error("save outcome could not be confirmed"));
        await operation;
        expect(read().download).toEqual({kind: "failed", message: "save outcome could not be confirmed"});
    });

    it("aborts download on unmount without saving or publishing late progress", async () => {
        const pending = deferred<DownloadAssetResult>();
        boundary.downloadAsset.mockReturnValueOnce(pending.promise);
        const host = mount();
        const operation = draw(host, useUpdateCheck).startDownload(asset);
        const options = boundary.downloadAsset.mock.calls[0][0] as {signal: AbortSignal; onProgress: (received: number, total: number) => void};
        unmount(host);
        expect(options.signal.aborted).toBe(true);
        options.onProgress(3, 3);
        pending.resolve(payload);
        await operation;
        expect(boundary.save).not.toHaveBeenCalled();
        expect(host.lateWrites).toBe(0);
    });
});

describe("automatic startup update checks", () => {
    const now = Date.UTC(2026, 9, 14, 8);
    const day = 24 * 60 * 60 * 1000;
    function startup() {
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
        vi.setSystemTime(now);
        vi.stubGlobal("window", {setTimeout, clearTimeout});
        const host = mount();
        draw(host, useAutoUpdateCheck);
        return host;
    }

    it("performs no release request when the preference is disabled", async () => {
        startup();
        await vi.advanceTimersByTimeAsync(3000);
        expect(boundary.readEnabled).toHaveBeenCalledTimes(1);
        expect(boundary.readLastCheck).not.toHaveBeenCalled();
        expect(boundary.fetchRelease).not.toHaveBeenCalled();
    });

    it.each([now, now - day + 3001])("does not check before 24 hours since %s", async last => {
        boundary.readEnabled.mockResolvedValue(true);
        boundary.readLastCheck.mockResolvedValue(last);
        startup();
        await vi.advanceTimersByTimeAsync(3000);
        expect(boundary.fetchRelease).not.toHaveBeenCalled();
    });

    it.each([undefined, now - day + 3000])("checks once when the last check is %s and records success", async last => {
        boundary.readEnabled.mockResolvedValue(true);
        boundary.readLastCheck.mockResolvedValue(last);
        const host = startup();
        replay(host);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(3000);
        expect(boundary.fetchRelease).toHaveBeenCalledTimes(1);
        expect(boundary.writeLastCheck).toHaveBeenCalledExactlyOnceWith(now + 3000);
        draw(host, useAutoUpdateCheck);
        await vi.advanceTimersByTimeAsync(day);
        expect(boundary.fetchRelease).toHaveBeenCalledTimes(1);
        expect(host.lateWrites).toBe(0);
    });

    it("retires a settings read when the startup owner unmounts", async () => {
        const enabled = deferred<boolean>();
        boundary.readEnabled.mockReturnValueOnce(enabled.promise);
        const host = startup();
        await vi.advanceTimersByTimeAsync(3000);
        unmount(host);
        enabled.resolve(true);
        await flush();
        expect(boundary.readLastCheck).not.toHaveBeenCalled();
        expect(boundary.fetchRelease).not.toHaveBeenCalled();
    });

    it("rechecks ownership after the last-check timestamp read completes", async () => {
        const timestamp = deferred<number | undefined>();
        boundary.readEnabled.mockResolvedValue(true);
        boundary.readLastCheck.mockReturnValueOnce(timestamp.promise);
        const host = startup();
        await vi.advanceTimersByTimeAsync(3000);
        unmount(host);
        timestamp.resolve(undefined);
        await flush();
        expect(boundary.fetchRelease).not.toHaveBeenCalled();
    });
});
