import {cancelBody, isReadAbort} from "@momoki/agent-providers/http";
import {sha256Bytes} from "../../../platform/media/sha256";
import type {ReleaseAsset} from "@momoki/distribution/releases";

// In-app installer download: one anonymous GET through the release-asset purpose,
// a bounded read, then a SHA-256 check against the digest GitHub published.
// The caller owns the system Save step; no bytes reach disk from here.

/** Hard ceiling even when a release lies about its size; only the Linux AppImage approaches it. */
export const MAX_RELEASE_ASSET_BYTES = 64 * 1024 * 1024;

export type DownloadAssetOptions = {
    asset: ReleaseAsset;
    /** Must be `runtimeFetchFor("release-asset")`; injected for tests. */
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    onProgress?: (received: number, total: number) => void;
    onVerifying?: () => void;
    maxBytes?: number;
    /** Injectable hex SHA-256 of the received bytes (tests only). */
    digest?: (bytes: Uint8Array) => Promise<string>;
};

export type DownloadAssetResult =
    | { kind: "ok"; bytes: Uint8Array; contentType: string }
    | { kind: "canceled" };

/** A digest mismatch is a discard, never a partial save: the returned bytes are dropped by the caller. */
class AssetDigestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AssetDigestError";
    }
}

async function subtleSha256(bytes: Uint8Array): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return sha256Bytes(bytes);
    const digest = new Uint8Array(await subtle.digest("SHA-256", new Uint8Array(bytes)));
    return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

function fetchOf(options: DownloadAssetOptions): typeof fetch {
    const fetchImpl = options.fetchImpl ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
    if (!fetchImpl) throw new AssetDigestError("当前环境无法下载安装包");
    return fetchImpl;
}

/** Reads the body while counting actual bytes so a dishonest content-length cannot exceed the cap. */
async function readLimited(response: Response, limit: number, options: DownloadAssetOptions): Promise<Uint8Array> {
    if (options.signal?.aborted || Number(response.headers.get("content-length")) > limit) {
        await cancelBody(response.body);
        options.signal?.throwIfAborted();
        throw new AssetDigestError("安装包超过下载上限，已停止下载");
    }
    if (!response.body) {
        if (limit < 0) throw new AssetDigestError("安装包超过下载上限，已停止下载");
        options.onProgress?.(0, limit);
        return new Uint8Array();
    }
    const reader = response.body.getReader();
    const aborts = () => void cancelBody(reader);
    options.signal?.addEventListener("abort", aborts, {once: true});
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            options.signal?.throwIfAborted();
            const next = await reader.read();
            options.signal?.throwIfAborted();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > limit) {
                await cancelBody(reader);
                throw new AssetDigestError("安装包超过下载上限，已停止下载");
            }
            chunks.push(next.value);
            options.onProgress?.(size, limit);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes;
    } finally {
        options.signal?.removeEventListener("abort", aborts);
        await cancelBody(reader);
        reader.releaseLock();
    }
}

export async function downloadAsset(options: DownloadAssetOptions): Promise<DownloadAssetResult> {
    const {asset} = options;
    if (options.signal?.aborted) return {kind: "canceled"};
    if (!asset.sha256 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new AssetDigestError("该安装包没有校验值，无法在应用内下载；请到发布页手动下载");
    if (!Number.isSafeInteger(asset.size) || asset.size < 0 || options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0))
        throw new AssetDigestError("安装包大小无效，无法在应用内下载");
    const limit = Math.min(MAX_RELEASE_ASSET_BYTES, options.maxBytes ?? MAX_RELEASE_ASSET_BYTES, asset.size);
    let response: Response;
    try {
        response = await fetchOf(options)(asset.url, {
            method: "GET",
            headers: {Accept: "application/octet-stream"},
            signal: options.signal
        });
    } catch (error) {
        if (isReadAbort(error, options.signal)) return {kind: "canceled"};
        throw error;
    }
    if (!response.ok) {
        await cancelBody(response.body);
        throw new AssetDigestError(`下载安装包失败（HTTP ${response.status}），请稍后重试`);
    }
    let bytes: Uint8Array;
    try {
        bytes = await readLimited(response, limit, options);
    } catch (error) {
        if (isReadAbort(error, options.signal)) return {kind: "canceled"};
        throw error;
    }
    if (bytes.byteLength !== asset.size) throw new AssetDigestError("下载的安装包与发布信息不一致，已丢弃；请重试或到发布页下载");
    if (options.signal?.aborted) return {kind: "canceled"};
    options.onVerifying?.();
    const actual = await (options.digest ?? subtleSha256)(bytes);
    if (options.signal?.aborted) return {kind: "canceled"};
    if (actual !== asset.sha256) throw new AssetDigestError("安装包校验失败，已丢弃下载内容；请重试或到发布页下载");
    return {kind: "ok", bytes, contentType: response.headers.get("content-type") || "application/octet-stream"};
}
