import {afterEach, describe, expect, it, vi} from "vitest";
import {fetchLatestDesktopRelease, fetchStars, type StorageLike} from "@momoki/distribution/releases";
import {formatBytes, formatPublished, formatStars} from "../apps/site/src/download/format";

const PREFIX = "https://github.com/ROYIANS/momoki/releases/download/";
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const sha = "a".repeat(64);

const asset = (tag: string, name: string, extra: Record<string, unknown> = {}) => ({name, size: 100, browser_download_url: `${PREFIX}${tag}/${name}`, digest: `sha256:${sha}`, ...extra});
const item = (tag: string, extra: Record<string, unknown> = {}) => ({
    tag_name: tag, draft: false, prerelease: true, html_url: `https://github.com/ROYIANS/momoki/releases/tag/${tag}`, published_at: "2026-10-13T09:08:10Z",
    assets: [asset(tag, `Momoki_${tag.slice(9)}_windows_x64_setup.exe`)], ...extra,
});
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), {status: 200, ...init});
const memory = (seed: Record<string, string> = {}) => {
    const data = new Map(Object.entries(seed));
    const storage: StorageLike & {data: Map<string, string>} = {data, getItem: key => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value)};
    return storage;
};
const deps = (fetchImpl: typeof fetch, storage: StorageLike | null = memory()) => ({fetchImpl, now: () => NOW, storage});

afterEach(() => vi.useRealTimers());

describe("fetchLatestDesktopRelease", () => {
    it("filters drafts and non-desktop tags, keeps prereleases and sorts by numeric semver", async () => {
        const fetchImpl = vi.fn(async () => json([
            item("desktop-v0.1.9"), item("desktop-v0.1.10"), item("desktop-v0.2.0", {draft: true}), item("v9.9.9"), item("desktop-v1.0.0-beta.1"), item("desktop-v0.1.2"),
        ]));
        const result = await fetchLatestDesktopRelease(deps(fetchImpl as unknown as typeof fetch));
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") return;
        expect(result.release).toMatchObject({tag: "desktop-v0.1.10", version: "0.1.10", prerelease: true, publishedAt: "2026-10-13T09:08:10Z"});
        expect(result.release.assets[0]).toEqual({name: "Momoki_0.1.10_windows_x64_setup.exe", size: 100, url: `${PREFIX}desktop-v0.1.10/Momoki_0.1.10_windows_x64_setup.exe`, sha256: sha});
    });

    it("requests the documented URL without credentials or cache options", async () => {
        const fetchImpl = vi.fn(async () => json([item("desktop-v0.1.1")]));
        await fetchLatestDesktopRelease(deps(fetchImpl as unknown as typeof fetch));
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("https://api.github.com/repos/ROYIANS/momoki/releases?per_page=30");
        expect(Object.keys(init).sort()).toEqual(["headers", "signal"]);
        expect(init.headers).toEqual({Accept: "application/vnd.github+json"});
    });

    it("drops assets whose address is not on the repository's release download path", async () => {
        const tag = "desktop-v0.1.1";
        const tampered = item(tag, {assets: [
            asset(tag, "Momoki_0.1.1_macos_arm64.dmg", {browser_download_url: "https://evil.example/Momoki_0.1.1_macos_arm64.dmg"}),
            asset(tag, "Momoki_0.1.1_macos_x64.dmg", {browser_download_url: "https://github.com.evil.example/ROYIANS/momoki/releases/download/x/a.dmg"}),
            asset(tag, "Momoki_0.1.1_linux_x64.deb", {browser_download_url: "http://github.com/ROYIANS/momoki/releases/download/desktop-v0.1.1/a.deb"}),
            asset(tag, "Momoki_0.1.1_windows_x64_setup.exe", {digest: "md5:zz"}),
        ]});
        const result = await fetchLatestDesktopRelease(deps((async () => json([tampered])) as unknown as typeof fetch));
        if (result.kind !== "ok") throw new Error("expected ok");
        expect(result.release.assets.map(a => a.name)).toEqual(["Momoki_0.1.1_windows_x64_setup.exe"]);
        expect(result.release.assets[0].sha256).toBeUndefined();
    });

    it("falls back to a constructed release page when html_url is foreign", async () => {
        const result = await fetchLatestDesktopRelease(deps((async () => json([item("desktop-v0.1.1", {html_url: "https://evil.example/x"})])) as unknown as typeof fetch));
        if (result.kind !== "ok") throw new Error("expected ok");
        expect(result.release.htmlUrl).toBe("https://github.com/ROYIANS/momoki/releases/tag/desktop-v0.1.1");
    });

    it("maps failures to fallback reasons", async () => {
        const run = (fetchImpl: () => Promise<Response>) => fetchLatestDesktopRelease(deps(fetchImpl as unknown as typeof fetch));
        expect(await run(async () => new Response("{}", {status: 429}))).toEqual({kind: "fallback", reason: "rate-limit"});
        expect(await run(async () => new Response("{}", {status: 403, headers: {"x-ratelimit-remaining": "0"}}))).toEqual({kind: "fallback", reason: "rate-limit"});
        expect(await run(async () => new Response("{}", {status: 403, headers: {"x-ratelimit-remaining": "12"}}))).toEqual({kind: "fallback", reason: "network"});
        expect(await run(async () => new Response("{}", {status: 500}))).toEqual({kind: "fallback", reason: "network"});
        expect(await run(async () => new Response("{}", {status: 404}))).toEqual({kind: "fallback", reason: "no-release"});
        expect(await run(async () => {throw new TypeError("offline");})).toEqual({kind: "fallback", reason: "network"});
        expect(await run(async () => json({message: "not an array"}))).toEqual({kind: "fallback", reason: "invalid"});
        expect(await run(async () => new Response("<html>", {status: 200}))).toEqual({kind: "fallback", reason: "invalid"});
        expect(await run(async () => json([item("desktop-v0.1.1", {draft: true}), item("other-1.0.0")]))).toEqual({kind: "fallback", reason: "no-release"});
        expect(await run(async () => json([]))).toEqual({kind: "fallback", reason: "no-release"});
    });

    it("aborts after the timeout, even for a fetch that ignores the signal", async () => {
        vi.useFakeTimers();
        const pending = fetchLatestDesktopRelease(deps((() => new Promise<Response>(() => undefined)) as unknown as typeof fetch));
        await vi.advanceTimersByTimeAsync(8000);
        expect(await pending).toEqual({kind: "fallback", reason: "network"});
    });

    it("cancels through the caller's signal", async () => {
        const controller = new AbortController();
        const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))));
        const pending = fetchLatestDesktopRelease({...deps(fetchImpl as unknown as typeof fetch), signal: controller.signal});
        controller.abort();
        expect(await pending).toEqual({kind: "fallback", reason: "network"});
    });

    it("does not send an already-aborted check", async () => {
        const controller = new AbortController();
        controller.abort();
        const fetchImpl = vi.fn(async () => json([]));
        expect(await fetchLatestDesktopRelease({...deps(fetchImpl), signal: controller.signal})).toEqual({kind: "fallback", reason: "network"});
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("bounds actual release JSON bytes and cancels an oversized stream even without a length header", async () => {
        const cancel = vi.fn();
        const stream = new ReadableStream<Uint8Array>({start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
            controller.enqueue(new Uint8Array(1));
        }, cancel}, {highWaterMark: 0});
        const fetchImpl = vi.fn(async () => new Response(stream));
        expect(await fetchLatestDesktopRelease(deps(fetchImpl))).toEqual({kind: "fallback", reason: "invalid"});
        expect(cancel).toHaveBeenCalledOnce();
    });

    it("cancels oversized declared responses before consuming and non-success response bodies", async () => {
        for (const init of [{headers: {"content-length": String(1024 * 1024 + 1)}}, {status: 429}]) {
            const cancel = vi.fn();
            const stream = new ReadableStream<Uint8Array>({cancel}, {highWaterMark: 0});
            const result = await fetchLatestDesktopRelease(deps(vi.fn(async () => new Response(stream, init))));
            expect(result).toEqual({kind: "fallback", reason: init.status === 429 ? "rate-limit" : "invalid"});
            expect(cancel).toHaveBeenCalledOnce();
        }
    });

    it("rejects fractional and unsafe declared asset lengths", async () => {
        const result = await fetchLatestDesktopRelease(deps(vi.fn(async () => json([item("desktop-v0.1.1", {assets: [
            asset("desktop-v0.1.1", "fraction", {size: 0.5}), asset("desktop-v0.1.1", "unsafe", {size: Number.MAX_SAFE_INTEGER + 1}),
        ]})]))));
        expect(result.kind === "ok" && result.release.assets).toEqual([]);
    });

    describe("cache", () => {
        const stored = (at: number, release: unknown, v = 1) => JSON.stringify({v, at, release});
        const goodRelease = {tag: "desktop-v0.1.1", version: "0.1.1", prerelease: true, htmlUrl: "https://github.com/ROYIANS/momoki/releases/tag/desktop-v0.1.1", assets: [{name: "a", size: 1, url: `${PREFIX}desktop-v0.1.1/a`}]};
        const network = () => vi.fn(async () => json([item("desktop-v0.3.0")]));

        it("returns a fresh cached release without a request, and writes after a request", async () => {
            const fetchImpl = network();
            const hit = memory({"momoki.landing.release": stored(NOW - HOUR, goodRelease)});
            const result = await fetchLatestDesktopRelease(deps(fetchImpl as unknown as typeof fetch, hit));
            expect(result).toEqual({kind: "ok", release: goodRelease});
            expect(fetchImpl).not.toHaveBeenCalled();

            const empty = memory();
            await fetchLatestDesktopRelease(deps(fetchImpl as unknown as typeof fetch, empty));
            expect(JSON.parse(empty.data.get("momoki.landing.release")!)).toMatchObject({v: 1, at: NOW, release: {tag: "desktop-v0.3.0"}});
        });

        it.each([
            ["expired", stored(NOW - 6 * HOUR, goodRelease)],
            ["future timestamp", stored(NOW + HOUR, goodRelease)],
            ["wrong envelope version", stored(NOW - HOUR, goodRelease, 2)],
            ["corrupt JSON", "{nope"],
            ["tampered asset url", stored(NOW - HOUR, {...goodRelease, assets: [{name: "a", size: 1, url: "https://evil.example/a"}]})],
            ["asset url escaping the release path", stored(NOW - HOUR, {...goodRelease, assets: [{name: "a", size: 1, url: "https://github.com/ROYIANS/momoki/releases/download/../../../evil/repo/releases/download/a"}]})],
            ["release page url escaping the releases path", stored(NOW - HOUR, {...goodRelease, htmlUrl: "https://github.com/ROYIANS/momoki/releases/%2e%2e/%2e%2e/evil"})],
            ["tampered release page url", stored(NOW - HOUR, {...goodRelease, htmlUrl: "https://evil.example/release"})],
            ["version not matching tag", stored(NOW - HOUR, {...goodRelease, version: "9.9.9"})],
            ["bad shape", stored(NOW - HOUR, {tag: 1})],
        ])("ignores a %s entry and refetches", async (_name, value) => {
            const fetchImpl = network();
            const result = await fetchLatestDesktopRelease(deps(fetchImpl as unknown as typeof fetch, memory({"momoki.landing.release": value})));
            expect(fetchImpl).toHaveBeenCalledOnce();
            expect(result.kind === "ok" && result.release.tag).toBe("desktop-v0.3.0");
        });

        it("works when storage throws on read and write, or is unavailable", async () => {
            const throwing: StorageLike = {getItem: () => {throw new Error("blocked");}, setItem: () => {throw new Error("full");}};
            const result = await fetchLatestDesktopRelease(deps(network() as unknown as typeof fetch, throwing));
            expect(result.kind).toBe("ok");
            expect((await fetchLatestDesktopRelease(deps(network() as unknown as typeof fetch, null))).kind).toBe("ok");
        });

        it("does not cache failures", async () => {
            const storage = memory();
            await fetchLatestDesktopRelease(deps((async () => new Response("{}", {status: 500})) as unknown as typeof fetch, storage));
            expect(storage.data.size).toBe(0);
        });
    });
});

describe("fetchStars", () => {
    const repo = (count: unknown) => vi.fn(async () => json({stargazers_count: count}));

    it("reads stargazers_count and caches it for six hours", async () => {
        const storage = memory();
        const fetchImpl = repo(42);
        expect(await fetchStars(deps(fetchImpl as unknown as typeof fetch, storage))).toBe(42);
        expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://api.github.com/repos/ROYIANS/momoki");
        const again = repo(1);
        expect(await fetchStars(deps(again as unknown as typeof fetch, storage))).toBe(42);
        expect(again).not.toHaveBeenCalled();
        expect(await fetchStars({fetchImpl: again as unknown as typeof fetch, now: () => NOW + 6 * HOUR, storage})).toBe(1);
    });

    it.each([[1.5], [-1], ["3"], [null], [undefined]])("returns undefined for stargazers_count %s", async value => {
        expect(await fetchStars(deps(repo(value) as unknown as typeof fetch))).toBeUndefined();
    });

    it("returns undefined for failures and an invalid cached value", async () => {
        expect(await fetchStars(deps((async () => new Response("{}", {status: 403})) as unknown as typeof fetch))).toBeUndefined();
        expect(await fetchStars(deps((async () => {throw new Error("x");}) as unknown as typeof fetch))).toBeUndefined();
        const bad = memory({"momoki.landing.stars": JSON.stringify({v: 1, at: NOW, stars: -3})});
        expect(await fetchStars(deps(repo(7) as unknown as typeof fetch, bad))).toBe(7);
    });

    it("runs in parallel with the release request and the two do not affect each other", async () => {
        const order: string[] = [];
        const fetchImpl = vi.fn(async (url: string) => {
            order.push(url.includes("releases") ? "releases" : "repo");
            if (url.includes("releases")) throw new Error("release failed");
            return json({stargazers_count: 5});
        });
        const both = Promise.all([fetchLatestDesktopRelease(deps(fetchImpl as unknown as typeof fetch)), fetchStars(deps(fetchImpl as unknown as typeof fetch))]);
        expect(fetchImpl).toHaveBeenCalledTimes(2); // both started before either finished
        const [release, stars] = await both;
        expect(release).toEqual({kind: "fallback", reason: "network"});
        expect(stars).toBe(5);
        expect(order).toEqual(["releases", "repo"]);
    });
});

describe("format", () => {
    it("formats stars, sizes and dates", () => {
        expect([0, 999, 1000, 1234, 1999, 12345].map(formatStars)).toEqual(["0", "999", "1k", "1.2k", "1.9k", "12.3k"]);
        expect(formatStars(-1)).toBe("");
        expect(formatBytes(16_198_950)).toBe("15.4 MB");
        expect(formatBytes(150_497_784)).toBe("143.5 MB");
        expect(formatBytes(490)).toBe("490 B");
        expect(formatPublished("2026-10-13T09:08:10Z")).toBe("2026年10月13日");
        expect(formatPublished("nope")).toBe("");
        expect(formatPublished(undefined)).toBe("");
    });
});
