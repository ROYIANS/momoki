import {GITHUB_URL} from "./brand";

// Release and star data from the public GitHub API (unauthenticated, CORS-enabled).
// Everything is injectable and nothing touches the network at module load.
// Shared by the standalone landing entry and the desktop settings update check.

export const RELEASES_URL = `${GITHUB_URL}/releases`;
export const INSTALL_GUIDE_URL = `${GITHUB_URL}/blob/main/docs/desktop-installation.md`;

const API_BASE = "https://api.github.com/repos/ROYIANS/momoki";
// Download links are accepted only when they point at this release path (anti-tamper).
const DOWNLOAD_PREFIX = `${GITHUB_URL}/releases/download/`;
const TAG_PATTERN = /^desktop-v(\d+)\.(\d+)\.(\d+)$/;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RELEASE_RESPONSE_BYTES = 1024 * 1024;
const RELEASE_CACHE_KEY = "momoki.landing.release";
const STARS_CACHE_KEY = "momoki.landing.stars";

export type ReleaseAsset = { name: string; size: number; url: string; sha256?: string };
export type LatestDesktopRelease = {
    tag: string;
    version: string;
    prerelease: boolean;
    htmlUrl: string;
    publishedAt?: string;
    assets: ReleaseAsset[];
};
export type FallbackReason = "network" | "rate-limit" | "no-release" | "invalid";
// Stars are fetched independently (see fetchStars) so a slow or failed one never delays downloads.
export type ReleaseResult = { kind: "ok"; release: LatestDesktopRelease } | {
    kind: "fallback";
    reason: FallbackReason
};

export type StorageLike = Pick<Storage, "getItem" | "setItem">;
export type FetchDeps = {
    fetchImpl?: typeof fetch;
    now?: () => number;
    /** `null` disables caching; omitted uses localStorage when available. */
    storage?: StorageLike | null;
    signal?: AbortSignal;
};

// Prefix check on the normalized address: "…/releases/download/../../x" would otherwise pass a
// plain startsWith and resolve to another path on the same host.
function isUnder(url: string, prefix: string): boolean {
    try {
        return new URL(url).href.startsWith(prefix);
    } catch {
        return false;
    }
}

function resolveStorage(deps: FetchDeps): StorageLike | null {
    if (deps.storage !== undefined) return deps.storage;
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

function readCache<T>(storage: StorageLike | null, key: string, now: number, pick: (raw: Record<string, unknown>) => T | undefined): T | undefined {
    if (!storage) return undefined;
    try {
        const text = storage.getItem(key);
        if (!text) return undefined;
        const raw: unknown = JSON.parse(text);
        if (!isRecord(raw) || raw.v !== 1 || typeof raw.at !== "number" || !Number.isFinite(raw.at)) return undefined;
        if (raw.at > now || now - raw.at >= CACHE_TTL_MS) return undefined;
        return pick(raw);
    } catch {
        return undefined;
    }
}

function writeCache(storage: StorageLike | null, key: string, now: number, payload: Record<string, unknown>): void {
    if (!storage) return;
    try {
        storage.setItem(key, JSON.stringify({v: 1, at: now, ...payload}));
    } catch {
        // Storage may be full or blocked; the page works without a cache.
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidAsset(asset: unknown): asset is ReleaseAsset {
    if (!isRecord(asset)) return false;
    const {name, size, url, sha256} = asset;
    return typeof name === "string" && name.length > 0
        && typeof size === "number" && Number.isSafeInteger(size) && size >= 0
        && typeof url === "string" && isUnder(url, DOWNLOAD_PREFIX)
        && (sha256 === undefined || (typeof sha256 === "string" && /^[a-f0-9]{64}$/.test(sha256)));
}

function parseCachedRelease(raw: Record<string, unknown>): LatestDesktopRelease | undefined {
    const release = raw.release;
    if (!isRecord(release)) return undefined;
    const {tag, version, prerelease, htmlUrl, publishedAt, assets} = release;
    if (typeof tag !== "string" || !TAG_PATTERN.test(tag) || version !== tag.slice("desktop-v".length)) return undefined;
    if (typeof prerelease !== "boolean" || typeof htmlUrl !== "string" || !isUnder(htmlUrl, `${RELEASES_URL}/`)) return undefined;
    if (publishedAt !== undefined && typeof publishedAt !== "string") return undefined;
    if (!Array.isArray(assets) || !assets.every(isValidAsset)) return undefined;
    return {
        tag,
        version,
        prerelease,
        htmlUrl, ...(publishedAt !== undefined ? {publishedAt} : {}),
        assets: assets.map(a => ({...a}))
    };
}

function semverOf(tag: string): [number, number, number] {
    const match = TAG_PATTERN.exec(tag)!;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemverDesc(a: string, b: string): number {
    const [x, y] = [semverOf(a), semverOf(b)];
    for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
}

function normalizeRelease(raw: Record<string, unknown>): LatestDesktopRelease {
    const tag = raw.tag_name as string;
    const rawAssets = Array.isArray(raw.assets) ? raw.assets : [];
    const assets: ReleaseAsset[] = [];
    for (const item of rawAssets) {
        if (!isRecord(item)) continue;
        const digest = typeof item.digest === "string" ? /^sha256:([a-f0-9]{64})$/.exec(item.digest)?.[1] : undefined;
        const asset = {
            name: item.name,
            size: item.size,
            url: item.browser_download_url, ...(digest ? {sha256: digest} : {})
        };
        if (isValidAsset(asset)) assets.push(asset);
    }
    const htmlUrl = typeof raw.html_url === "string" && isUnder(raw.html_url, `${RELEASES_URL}/`) ? raw.html_url : `${RELEASES_URL}/tag/${tag}`;
    return {
        tag,
        version: tag.slice("desktop-v".length),
        prerelease: raw.prerelease === true,
        htmlUrl,
        ...(typeof raw.published_at === "string" ? {publishedAt: raw.published_at} : {}),
        assets,
    };
}

type Reply =
    | { kind: "error" }
    | { kind: "http"; status: number; rateLimited: boolean }
    | { kind: "invalid" }
    | { kind: "json"; value: unknown };

/** Standalone landing closure stays dependency-free; bound bytes before decoding JSON. */
async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
    if (Number(response.headers.get("content-length")) > MAX_RELEASE_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("release response too large");
    }
    if (!response.body) throw new Error("empty release response");
    const reader = response.body.getReader();
    const cancel = () => {
        void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, {once: true});
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const next = await reader.read();
            signal.throwIfAborted();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > MAX_RELEASE_RESPONSE_BYTES) throw new Error("release response too large");
            chunks.push(next.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)) as unknown;
    } finally {
        signal.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}

async function request(url: string, deps: FetchDeps): Promise<Reply> {
    if (deps.signal?.aborted) return {kind: "error"};
    const fetchImpl = deps.fetchImpl ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
    if (!fetchImpl) return {kind: "error"};
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
    deps.signal?.addEventListener("abort", abort, {once: true});
    if (deps.signal?.aborted) abort();
    // Raced so that a fetch implementation which ignores the signal cannot hang the page.
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("aborted")), {once: true}));
    aborted.catch(() => undefined);
    try {
        const response = await Promise.race([fetchImpl(url, {
            headers: {Accept: "application/vnd.github+json"},
            signal: controller.signal
        }), aborted]);
        if (response.status !== 200) {
            const exhausted = response.headers?.get?.("x-ratelimit-remaining") === "0";
            await response.body?.cancel().catch(() => undefined);
            return {
                kind: "http",
                status: response.status,
                rateLimited: response.status === 429 || (response.status === 403 && exhausted)
            };
        }
        try {
            return {kind: "json", value: await Promise.race([readBoundedJson(response, controller.signal), aborted])};
        } catch {
            return controller.signal.aborted ? {kind: "error"} : {kind: "invalid"};
        }
    } catch {
        return {kind: "error"};
    } finally {
        clearTimeout(timer);
        deps.signal?.removeEventListener("abort", abort);
    }
}

export async function fetchLatestDesktopRelease(deps: FetchDeps = {}): Promise<ReleaseResult> {
    const now = (deps.now ?? Date.now)();
    const storage = resolveStorage(deps);
    const cached = readCache(storage, RELEASE_CACHE_KEY, now, parseCachedRelease);
    if (cached) return {kind: "ok", release: cached};

    const reply = await request(`${API_BASE}/releases?per_page=30`, deps);
    if (reply.kind === "error") return {kind: "fallback", reason: "network"};
    if (reply.kind === "invalid") return {kind: "fallback", reason: "invalid"};
    if (reply.kind === "http") {
        if (reply.rateLimited) return {kind: "fallback", reason: "rate-limit"};
        return {kind: "fallback", reason: reply.status === 404 ? "no-release" : "network"};
    }
    if (!Array.isArray(reply.value)) return {kind: "fallback", reason: "invalid"};

    const candidates = reply.value
        .filter((item): item is Record<string, unknown> => isRecord(item) && !item.draft && typeof item.tag_name === "string" && TAG_PATTERN.test(item.tag_name))
        .sort((a, b) => compareSemverDesc(a.tag_name as string, b.tag_name as string));
    if (candidates.length === 0) return {kind: "fallback", reason: "no-release"};
    const release = normalizeRelease(candidates[0]);
    writeCache(storage, RELEASE_CACHE_KEY, now, {release});
    return {kind: "ok", release};
}

export async function fetchStars(deps: FetchDeps = {}): Promise<number | undefined> {
    const now = (deps.now ?? Date.now)();
    const storage = resolveStorage(deps);
    const valid = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
    const cached = readCache(storage, STARS_CACHE_KEY, now, raw => (valid(raw.stars) ? raw.stars : undefined));
    if (cached !== undefined) return cached;

    const reply = await request(API_BASE, deps);
    if (reply.kind !== "json" || !isRecord(reply.value)) return undefined;
    const stars = reply.value.stargazers_count;
    if (!valid(stars)) return undefined;
    writeCache(storage, STARS_CACHE_KEY, now, {stars});
    return stars;
}
