import {useCallback, useEffect, useRef, useState} from "react";
import {appVersion} from "../../../platform/runtime/appVersion";
import {downloadAsset} from "../updates/download";
import {type AssetChoice, detectPlatform, type NavigatorInfo, pickAssets} from "@momoki/distribution/platform";
import {fetchLatestDesktopRelease, type LatestDesktopRelease} from "@momoki/distribution/releases";
import {classifyUpdate, type UpdateClass} from "@momoki/distribution/version";
import {runtimeFetchFor} from "../../../platform/runtime/runtimeFetch";
import {downloadBlob, isPublishedSaveError} from "../../../platform/runtime/runtimeSave";
import {writeLastUpdateCheckAt} from "./settingsStore";

export type UpdateState =
    | { kind: "idle" }
    | { kind: "checking" }
    | {
    kind: "ready";
    release: LatestDesktopRelease;
    verdict: UpdateClass;
    asset?: AssetChoice;
    alternatives?: AssetChoice[];
    ambiguous?: boolean;
    unsupportedReason?: string
}
    | { kind: "failed"; reason: string };

export type DownloadState =
    | { kind: "idle" }
    | { kind: "downloading"; loaded: number; total: number }
    | { kind: "verifying" }
    | { kind: "saving" }
    | { kind: "canceled" }
    | { kind: "saved"; name: string; format?: AssetChoice["format"]; warning?: string }
    | { kind: "failed"; message: string };

const FAILURE_COPY: Record<string, string> = {
    network: "网络请求失败，请检查网络或稍后重试。",
    "rate-limit": "GitHub 请求过于频繁，请稍后再试。",
    "no-release": "还没有可供下载的桌面版本。",
    invalid: "返回内容异常，请稍后再试或前往发布页查看。",
};

/** One check and one download at a time; leaving the page aborts both. */
export function useUpdateCheck() {
    const [state, setState] = useState<UpdateState>({kind: "idle"});
    const [download, setDownload] = useState<DownloadState>({kind: "idle"});
    const checkAbort = useRef<AbortController | null>(null);
    const downloadAbort = useRef<AbortController | null>(null);
    const mounted = useRef(true);

    const runCheck = useCallback(async (silent = false): Promise<void> => {
        if (checkAbort.current && !checkAbort.current.signal.aborted) return;
        const controller = new AbortController();
        checkAbort.current = controller;
        if (!silent) setState({kind: "checking"});
        try {
            const result = await fetchLatestDesktopRelease({
                fetchImpl: runtimeFetchFor("release-check"),
                signal: controller.signal
            });
            if (controller.signal.aborted || !mounted.current) return;
            if (result.kind !== "ok") {
                if (!silent) setState({kind: "failed", reason: FAILURE_COPY[result.reason] ?? FAILURE_COPY.invalid});
                return;
            }
            const release = result.release;
            const platform = await detectPlatform({
                userAgent: navigator.userAgent,
                userAgentData: (navigator as Navigator & {
                    userAgentData?: NavigatorInfo["userAgentData"]
                }).userAgentData,
                platform: navigator.platform,
                maxTouchPoints: navigator.maxTouchPoints,
            });
            if (controller.signal.aborted || !mounted.current) return;
            const pick = pickAssets(release, platform);
            const alternatives = pick.alternatives.filter(choice => choice.os === platform.os && (platform.arch === "unknown" || choice.arch === platform.arch));
            if (!silent) setState({
                kind: "ready",
                release,
                verdict: classifyUpdate(appVersion(), release.version),
                asset: pick.primary,
                alternatives,
                ambiguous: pick.ambiguous,
                unsupportedReason: pick.unsupportedReason
            });
            await writeLastUpdateCheckAt(Date.now()).catch(() => undefined);
        } catch {
            if (!controller.signal.aborted && mounted.current && !silent) setState({
                kind: "failed",
                reason: FAILURE_COPY.network
            });
        } finally {
            if (checkAbort.current === controller) checkAbort.current = null;
        }
    }, []);

    const startDownload = useCallback(async (asset: AssetChoice): Promise<void> => {
        if (downloadAbort.current) return;
        const controller = new AbortController();
        downloadAbort.current = controller;
        setDownload({kind: "downloading", loaded: 0, total: asset.asset.size});
        let savingStarted = false;
        try {
            const result = await downloadAsset({
                asset: asset.asset,
                fetchImpl: runtimeFetchFor("release-asset"),
                signal: controller.signal,
                onProgress: (received, total) => {
                    if (mounted.current && !controller.signal.aborted) setDownload({
                        kind: "downloading",
                        loaded: received,
                        total
                    });
                },
                onVerifying: () => {
                    if (mounted.current && !controller.signal.aborted) setDownload({kind: "verifying"});
                },
            });
            if (!mounted.current) return;
            if (result.kind === "canceled" || controller.signal.aborted) {
                setDownload({kind: "canceled"});
                return;
            }
            setDownload({kind: "saving"});
            savingStarted = true;
            const outcome = await downloadBlob(new Blob([new Uint8Array(result.bytes)], {type: result.contentType}), asset.asset.name, controller.signal);
            if (mounted.current) setDownload(outcome === "saved" ? {
                kind: "saved",
                name: asset.asset.name,
                format: asset.format
            } : {kind: "canceled"});
        } catch (error) {
            if (!mounted.current) return;
            if (isPublishedSaveError(error)) setDownload({
                kind: "saved",
                name: asset.asset.name,
                format: asset.format,
                warning: error.message
            });
            else if (controller.signal.aborted && !savingStarted) setDownload({kind: "canceled"});
            else setDownload({kind: "failed", message: error instanceof Error ? error.message : "下载失败，请重试。"});
        } finally {
            if (downloadAbort.current === controller) downloadAbort.current = null;
        }
    }, []);

    const cancelDownload = useCallback(() => downloadAbort.current?.abort(), []);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            checkAbort.current?.abort();
            downloadAbort.current?.abort();
        };
    }, []);

    return {state, download, runCheck, startDownload, cancelDownload};
}
