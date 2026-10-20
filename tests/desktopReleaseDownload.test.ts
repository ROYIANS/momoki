import {describe, expect, it, vi} from "vitest";
import {MAX_RELEASE_ASSET_BYTES, downloadAsset} from "@/features/settings/updates/download";
import {sha256Bytes} from "@/platform/media/sha256";
import type {ReleaseAsset} from "@momoki/distribution/releases";

const URL_OK = "https://github.com/ROYIANS/momoki/releases/download/desktop-v0.1.3/Momoki_0.1.3_windows_x64_setup.exe";
const BODY = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const DIGEST = sha256Bytes(BODY);

const asset = (patch: Partial<ReleaseAsset> = {}): ReleaseAsset => ({name: "Momoki_0.1.3_windows_x64_setup.exe", size: BODY.byteLength, url: URL_OK, sha256: DIGEST, ...patch});
const respond = (body: Uint8Array, init: ResponseInit = {}) => new Response(new Uint8Array(body), {status: 200, ...init});
const fetchOf = (impl: () => Promise<Response>) => vi.fn(impl as unknown as typeof fetch);

describe("downloadAsset", () => {
    it("returns the bytes when the SHA-256 matches the published digest", async () => {
        const fetchImpl = fetchOf(async () => respond(BODY));
        const result = await downloadAsset({asset: asset(), fetchImpl});
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") return;
        expect([...result.bytes]).toEqual([...BODY]);
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(URL_OK);
        expect(init.method).toBe("GET");
    });

    it("reports progress against the smaller of the declared size and the cap", async () => {
        const seen: number[] = [];
        await downloadAsset({asset: asset(), fetchImpl: fetchOf(async () => respond(BODY)), onProgress: received => seen.push(received)});
        expect(seen.at(-1)).toBe(BODY.byteLength);
    });

    it("discards the bytes when the digest does not match", async () => {
        const wrong = "0".repeat(64);
        const fetchImpl = fetchOf(async () => respond(BODY));
        await expect(downloadAsset({asset: asset({sha256: wrong}), fetchImpl})).rejects.toThrow("校验失败");
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it("rejects before any request when the release has no digest (legacy release)", async () => {
        const fetchImpl = fetchOf(async () => respond(BODY));
        await expect(downloadAsset({asset: asset({sha256: undefined}), fetchImpl})).rejects.toThrow("没有校验值");
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each(["bad", "A".repeat(64)])("rejects malformed digest %s before requesting", async sha256 => {
        const fetchImpl = fetchOf(async () => respond(BODY));
        await expect(downloadAsset({asset: asset({sha256}), fetchImpl})).rejects.toThrow("校验值");
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each([-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid size %s before requesting", async size => {
        const fetchImpl = fetchOf(async () => respond(BODY));
        await expect(downloadAsset({asset: asset({size}), fetchImpl})).rejects.toThrow("大小无效");
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("suppresses verified bytes if canceled while digest computation is pending", async () => {
        const controller = new AbortController();
        let finish!: (value: string) => void;
        const digest = vi.fn(() => new Promise<string>(resolve => {finish = resolve;}));
        const verifying = vi.fn();
        const pending = downloadAsset({asset: asset(), fetchImpl: fetchOf(async () => respond(BODY)), signal: controller.signal, digest, onVerifying: verifying});
        await vi.waitFor(() => expect(digest).toHaveBeenCalledOnce());
        expect(verifying).toHaveBeenCalledOnce();
        controller.abort();
        finish(DIGEST);
        expect(await pending).toEqual({kind: "canceled"});
    });

    it("cancels the body and rejects when the declared size is exceeded", async () => {
        const cancel = vi.fn();
        const big = new Uint8Array(64);
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(big);
                controller.enqueue(big);
                controller.close();
            },
            cancel,
        }, {highWaterMark: 0});
        await expect(downloadAsset({asset: asset({size: 32, sha256: DIGEST}), fetchImpl: fetchOf(async () => new Response(stream, {status: 200}))}))
            .rejects.toThrow("下载上限");
        expect(cancel).toHaveBeenCalled();
    });

    it("caps the read at the smaller of the configured limit and the declared size", async () => {
        expect(MAX_RELEASE_ASSET_BYTES).toBe(64 * 1024 * 1024);
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (let i = 0; i < 40; i += 1) controller.enqueue(new Uint8Array(32));
                controller.close();
            },
        }, {highWaterMark: 0});
        const seen: number[] = [];
        // A release claiming 1 GB must not raise the ceiling above the cap.
        await expect(downloadAsset({
            asset: asset({size: 1_000_000_000, sha256: DIGEST}), fetchImpl: fetchOf(async () => new Response(stream, {status: 200})),
            maxBytes: 1024, onProgress: received => seen.push(received),
        })).rejects.toThrow("下载上限");
        expect(Math.max(...seen)).toBeLessThanOrEqual(1024);
    });

    it("rejects when the received length differs from the declared size", async () => {
        await expect(downloadAsset({asset: asset({size: BODY.byteLength + 1}), fetchImpl: fetchOf(async () => respond(BODY))})).rejects.toThrow("发布信息不一致");
        await expect(downloadAsset({asset: asset({size: BODY.byteLength - 1}), fetchImpl: fetchOf(async () => respond(BODY))})).rejects.toThrow();
    });

    it("rejects a content-length above the limit before reading the body", async () => {
        const fetchImpl = fetchOf(async () => respond(BODY, {headers: {"content-length": String(BODY.byteLength)}}));
        await expect(downloadAsset({asset: asset({size: 2, sha256: DIGEST}), fetchImpl})).rejects.toThrow("下载上限");
    });

    it("keeps the hard ceiling even when a caller requests a larger custom cap", async () => {
        const cancel = vi.fn();
        const stream = new ReadableStream<Uint8Array>({cancel}, {highWaterMark: 0});
        const fetchImpl = fetchOf(async () => new Response(stream, {headers: {"content-length": String(MAX_RELEASE_ASSET_BYTES + 1)}}));
        await expect(downloadAsset({asset: asset({size: MAX_RELEASE_ASSET_BYTES + 1}), maxBytes: MAX_RELEASE_ASSET_BYTES * 2, fetchImpl})).rejects.toThrow("下载上限");
        expect(cancel).toHaveBeenCalledOnce();
    });

    it("maps a non-2xx response to an explicit failure without saving", async () => {
        await expect(downloadAsset({asset: asset(), fetchImpl: fetchOf(async () => new Response(null, {status: 404}))})).rejects.toThrow("HTTP 404");
        await expect(downloadAsset({asset: asset(), fetchImpl: fetchOf(async () => new Response(null, {status: 502}))})).rejects.toThrow();
    });

    it("returns canceled for a caller abort before and during the read", async () => {
        const early = new AbortController();
        early.abort(new DOMException("stop", "AbortError"));
        const fetchImpl = fetchOf(async () => respond(BODY));
        expect(await downloadAsset({asset: asset(), fetchImpl, signal: early.signal})).toEqual({kind: "canceled"});
        expect(fetchImpl).not.toHaveBeenCalled();

        const during = new AbortController();
        const pending = downloadAsset({
            asset: asset(),
            fetchImpl: fetchOf(async () => new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    during.signal.addEventListener("abort", () => controller.error(new DOMException("stop", "AbortError")));
                },
            }, {highWaterMark: 0}), {status: 200})),
            signal: during.signal,
        });
        during.abort(new DOMException("stop", "AbortError"));
        expect(await pending).toEqual({kind: "canceled"});
    });

    it("propagates a transport failure instead of reporting a saved file", async () => {
        const failure = new TypeError("offline");
        await expect(downloadAsset({asset: asset(), fetchImpl: fetchOf(async () => {throw failure;})})).rejects.toBe(failure);
    });
});
