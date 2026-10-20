import {isTauriRuntime} from "./runtimeIdentity";
import {
    authorizeRuntimeHttp,
    remoteHttpUrl,
    type RuntimeHttpPurpose,
    type RuntimeHttpScope
} from "../product/httpPolicy";
import {cancelBody, readResponseBytes, utf8Bytes} from "@momoki/agent-providers/http";
import type {ClientOptions} from "@tauri-apps/plugin-http";

const MAX_BUFFERED_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 30_000;
const nativeControllers = new Set<AbortController>();
const lifecycleWindows = new WeakSet<Window>();
let pageClosing = false;

/** Resource-table teardown alone does not interrupt a Rust read already awaiting bytes. */
function trackNativeController(controller: AbortController): () => void {
    if (typeof window !== "undefined" && typeof window.addEventListener === "function" && !lifecycleWindows.has(window)) {
        lifecycleWindows.add(window);
        const abortPending = () => {
            for (const pending of nativeControllers) pending.abort(new DOMException("应用页面已关闭，本地网络等待已停止", "AbortError"));
        };
        window.addEventListener("pagehide", () => {
            pageClosing = true;
            abortPending();
        });
        // A dirty-draft guard may cancel beforeunload: stop requests, but allow an explicit later attempt.
        window.addEventListener("beforeunload", abortPending);
        window.addEventListener("pageshow", () => {
            pageClosing = false;
        });
    }
    nativeControllers.add(controller);
    if (pageClosing) controller.abort(new DOMException("应用页面已关闭，本地网络等待已停止", "AbortError"));
    return () => {
        nativeControllers.delete(controller);
    };
}

type NativeFetch = (input: string, init: RequestInit & ClientOptions) => Promise<Response>;
export type RuntimeFetchServices = {
    native: () => boolean;
    webFetch: typeof fetch;
    nativeFetch: NativeFetch;
    authorize: typeof authorizeRuntimeHttp;
    grant: (origin: string, allowHttp: boolean) => Promise<void>;
};

/** Queued uploads do not buffer until their slot is acquired; cancellation removes waiters. */
function uploadSlots() {
    let active = 0;
    const waiting: Array<() => void> = [];
    return async (signal?: AbortSignal): Promise<() => void> => {
        signal?.throwIfAborted();
        let canceled = false;
        if (active >= 2) await new Promise<void>(resolve => {
            const ready = () => {
                signal?.removeEventListener("abort", abort);
                resolve();
            };
            const abort = () => {
                const index = waiting.indexOf(ready);
                if (index >= 0) waiting.splice(index, 1);
                canceled = true;
                resolve();
            };
            waiting.push(ready);
            signal?.addEventListener("abort", abort, {once: true});
        });
        else active++;
        if (canceled) signal?.throwIfAborted();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            active--;
            const next = waiting.shift();
            if (next) {
                active++;
                next();
            }
        };
    };
}

const uploadGates = new WeakMap<RuntimeFetchServices, ReturnType<typeof uploadSlots>>();

function sharedUploadSlots(services: RuntimeFetchServices) {
    let gate = uploadGates.get(services);
    if (!gate) {
        gate = uploadSlots();
        uploadGates.set(services, gate);
    }
    return gate;
}

function assertUpload(body: BodyInit | null | undefined): void {
    if (body == null) return;
    // Vision requests encode up to ten reviewed images in JSON; their existing domain budgets remain authoritative.
    if (typeof body === "string" || body instanceof URLSearchParams) return;
    let size: number;
    if (body instanceof FormData) {
        size = 0;
        for (const [, value] of body) size += typeof value === "string" ? utf8Bytes(value) : value.size;
    } else if (body instanceof Blob) size = body.size;
    else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) size = body.byteLength;
    else throw new Error("原生网络请求不支持流式上传，请使用受限的文本或文件内容");
    if (size > MAX_BUFFERED_UPLOAD_BYTES) throw new Error("原生请求上传内容超过 20 MiB 限制");
}

function inputUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    return input instanceof Request ? input.url : input.href;
}

function inputSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
    return init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined;
}

async function requestParts(input: RequestInfo | URL, init?: RequestInit) {
    const source = input instanceof Request ? input : undefined;
    const signal = inputSignal(input, init);
    signal?.throwIfAborted();
    const headers = new Headers(init?.headers ?? source?.headers);
    let body = init?.body;
    if (body === undefined && source?.body) body = await readResponseBytes(new Response(source.clone().body), MAX_BUFFERED_UPLOAD_BYTES, signal ?? undefined);
    assertUpload(body);
    const defaults: RequestInit = source ? {
        method: source.method, credentials: source.credentials, redirect: source.redirect,
        cache: source.cache, mode: source.mode, referrer: source.referrer,
        referrerPolicy: source.referrerPolicy, integrity: source.integrity, keepalive: source.keepalive,
    } : {method: "GET", credentials: "same-origin", redirect: "follow"};
    const wire = {...defaults, ...init, headers, body};
    return {
        url: remoteHttpUrl(inputUrl(input)), signal,
        init: {...wire, method: (wire.method ?? "GET").toUpperCase()},
    };
}

type RuntimeWire = Awaited<ReturnType<typeof requestParts>>["init"];

/** Plugin errors can contain full signed URLs; keep only safe transport classification. */
function nativeTransportError(error: unknown): Error {
    const message = "原生网络请求失败，请检查网络和连接设置";
    return error instanceof TypeError ? new TypeError(message) : new Error(message);
}

async function sendNative(services: RuntimeFetchServices, url: URL, wire: RuntimeWire, signal?: AbortSignal) {
    const controller = new AbortController();
    const untrack = trackNativeController(controller);
    const forwardAbort = () => controller.abort(signal?.reason);
    const dispose = () => {
        signal?.removeEventListener("abort", forwardAbort);
        untrack();
    };
    signal?.addEventListener("abort", forwardAbort, {once: true});
    if (signal?.aborted) forwardAbort();
    let response: Response;
    try {
        controller.signal.throwIfAborted();
        response = await services.nativeFetch(url.href, {
            ...wire, headers: new Headers(wire.headers), signal: controller.signal,
            maxRedirections: 0, connectTimeout: CONNECT_TIMEOUT_MS,
        });
    } catch (error) {
        dispose();
        controller.signal.throwIfAborted();
        throw nativeTransportError(error);
    }
    if (controller.signal.aborted) {
        dispose();
        await cancelBody(response.body);
        controller.signal.throwIfAborted();
    }
    return {response, dispose, signal: controller.signal};
}

function applyRedirect(status: number, current: URL, target: URL, wire: RuntimeWire): void {
    if (target.origin !== current.origin) {
        for (const name of ["authorization", "proxy-authorization", "cookie", "cookie2", "x-api-key", "api-key"]) wire.headers.delete(name);
    }
    if (([301, 302].includes(status) && wire.method === "POST") ||
        status === 303 && !["GET", "HEAD"].includes(wire.method)) {
        wire.method = "GET";
        wire.body = null;
        for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) wire.headers.delete(name);
    }
}

async function redirectTarget(response: Response, url: URL, wire: RuntimeWire, hop: number, dispose: () => void): Promise<URL | null> {
    if (![301, 302, 303, 307, 308].includes(response.status) || wire.redirect === "manual") return null;
    const location = response.headers.get("location");
    if (wire.redirect !== "error" && !location) return null;
    dispose();
    await cancelBody(response.body);
    if (wire.redirect === "error") throw new Error("网络请求发生重定向，已按请求策略拒绝");
    if (hop >= MAX_REDIRECTS) throw new Error("网络请求重定向超过 5 次，已停止");
    if (!location) throw new Error("网络请求重定向缺少目标地址");
    let target: URL;
    try {
        target = remoteHttpUrl(new URL(location, url).href);
    } catch {
        throw new Error("网络请求重定向地址无效");
    }
    applyRedirect(response.status, url, target, wire);
    return target;
}

/** Preserve abort identity for headers and for every Response body reader. */
function abortableResponse(response: Response, signal: AbortSignal | undefined, dispose: () => void, redirected: boolean): Response {
    if (!response.body) {
        dispose();
        Object.defineProperty(response, "redirected", {value: redirected});
        return response;
    }
    const reader = response.body.getReader();
    let finished = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const cleanup = () => {
        signal?.removeEventListener("abort", abort);
        dispose();
    };
    const abort = () => {
        if (finished) return;
        finished = true;
        cleanup();
        controller.error(signal?.reason);
        void cancelBody(reader);
    };
    const body = new ReadableStream<Uint8Array>({
        start(value) {
            controller = value;
            signal?.addEventListener("abort", abort, {once: true});
            if (signal?.aborted) abort();
        },
        async pull(value) {
            try {
                const chunk = await reader.read();
                if (finished) return;
                signal?.throwIfAborted();
                if (chunk.done) {
                    finished = true;
                    cleanup();
                    reader.releaseLock();
                    value.close();
                } else value.enqueue(chunk.value);
            } catch (error) {
                if (finished) return;
                finished = true;
                cleanup();
                value.error(signal?.aborted ? signal.reason : error);
                await cancelBody(reader);
            }
        },
        async cancel(reason) {
            finished = true;
            cleanup();
            try {
                await reader.cancel(reason);
            } catch { /* Cancellation remains cleanup. */
            }
        },
    }, {highWaterMark: 0});
    const result = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
    });
    Object.defineProperty(result, "url", {value: response.url});
    Object.defineProperty(result, "redirected", {value: redirected});
    return result;
}

/** One selected transport; shared provider code continues owning protocols, reads and deadlines. */
export function createRuntimeFetch(services: RuntimeFetchServices, scope: RuntimeHttpScope = {purpose: "configured"}): typeof fetch {
    const acquireUpload = sharedUploadSlots(services);
    return async (input, init) => {
        if (!services.native() || !/^https?:/i.test(inputUrl(input))) return services.webFetch(input, init);
        const hasUpload = init?.body != null || input instanceof Request && input.body != null;
        const releaseUpload = hasUpload ? await acquireUpload(inputSignal(input, init)) : undefined;
        try {
            const parts = await requestParts(input, init);
            let {url} = parts;
            const wire = parts.init;
            for (let hop = 0; ; hop++) {
                parts.signal?.throwIfAborted();
                const grant = await services.authorize(url, wire.method, wire.headers, wire.body, {
                    ...scope,
                    redirected: hop > 0
                });
                parts.signal?.throwIfAborted();
                await services.grant(grant.origin, grant.allowHttp);
                parts.signal?.throwIfAborted();
                const {response, dispose, signal} = await sendNative(services, url, wire, parts.signal);
                const target = await redirectTarget(response, url, wire, hop, dispose);
                if (!target) return abortableResponse(response, signal, dispose, hop > 0);
                url = target;
            }
        } finally {
            releaseUpload?.();
        }
    };
}

const services: RuntimeFetchServices = {
    native: isTauriRuntime,
    webFetch: (input, init) => fetch(input, init),
    nativeFetch: async (input, init) => (await import("@tauri-apps/plugin-http")).fetch(input, init),
    authorize: authorizeRuntimeHttp,
    async grant(origin, allowHttp) {
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (!invoke) throw new Error("原生网络服务不可用，请重新打开应用");
        const reply = await invoke("authorize_http_origin", {origin, allowHttp});
        if (!reply || typeof reply !== "object" || !("origin" in reply) || reply.origin !== origin)
            throw new Error("原生网络地址授权未确认");
    },
};

const runtimeFetch = createRuntimeFetch(services);
export const runtimeResultFetch = createRuntimeFetch(services, {purpose: "result-download"});
const searchProbeFetch = createRuntimeFetch(services, {purpose: "search-probe"});
const modelCatalogFetch = createRuntimeFetch(services, {purpose: "model-catalog"});
const releaseCheckFetch = createRuntimeFetch(services, {purpose: "release-check"});
const releaseAssetFetch = createRuntimeFetch(services, {purpose: "release-asset"});

export function runtimeFetchFor(purpose: RuntimeHttpPurpose = "configured"): typeof fetch {
    if (purpose === "result-download") return runtimeResultFetch;
    if (purpose === "model-catalog") return modelCatalogFetch;
    if (purpose === "release-check") return releaseCheckFetch;
    if (purpose === "release-asset") return releaseAssetFetch;
    return purpose === "search-probe" ? searchProbeFetch : runtimeFetch;
}

/** Draft connector scope is local to this explicit discovery/test operation, never a global policy. */
export function connectorProbeFetch(baseUrl: string, fetchImpl?: typeof fetch): typeof fetch {
    if (fetchImpl) return fetchImpl;
    if (!services.native()) return runtimeFetch;
    return (input, init) => createRuntimeFetch(services, {
        purpose: "configured",
        probeOrigin: remoteHttpUrl(baseUrl).origin
    })(input, init);
}
