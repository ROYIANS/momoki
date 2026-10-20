import {McpHostError} from "./mcpErrors";

function validateUrl(input: RequestInfo | URL): void {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const secure = url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.hash || !secure) throw new McpHostError("unsupported", "not_started", "browser_fetch");
}

function singleUseBody(body: BodyInit | null | undefined): {body: ReadableStream<Uint8Array>; duplex: "half"} {
    if (typeof body !== "string" && !(body instanceof URLSearchParams)) throw new McpHostError("unsupported", "not_started", "browser_fetch");
    let duplexRead = false;
    const probeBody = new ReadableStream<Uint8Array>({start(stream) {stream.close();}});
    const probeInit: RequestInit & {readonly duplex: string} = {method: "POST", body: probeBody, get duplex() {duplexRead = true; return "half";}};
    const probe = new Request("https://momoki.invalid/", probeInit);
    if (!duplexRead || probe.headers.has("Content-Type")) throw new McpHostError("unsupported", "not_started", "browser_fetch");
    const bytes = new TextEncoder().encode(body.toString());
    // A streaming Request has no replayable body source. Never fall back to a string.
    return {body: new ReadableStream<Uint8Array>({start(stream) {stream.enqueue(bytes); stream.close();}}), duplex: "half"};
}

/** One request, no redirects/cookies/retries; byte limits cover consumption, not just headers. */
export function createBoundedMcpFetch(options: {readonly fetch?: typeof fetch; readonly maximumBytes?: number; readonly timeoutMs?: number;
    readonly signal?: AbortSignal; readonly oneShotBody?: boolean; readonly beforeSend?: () => void; readonly onStatus?: (status: number) => void;
    readonly onTask?: (task: Promise<void>) => void} = {}): typeof fetch {
    const source = options.fetch ?? globalThis.fetch.bind(globalThis);
    return async (input, init) => {
        let finishTask: () => void = () => undefined;
        options.onTask?.(new Promise<void>(resolve => {finishTask = resolve;}));
        const controller = new AbortController();
        const signals = [options.signal, init?.signal, input instanceof Request ? input.signal : undefined].filter((signal): signal is AbortSignal => !!signal);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let done = false, cancellation: Promise<void> | undefined;
        const cleanup = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            for (const signal of signals) signal.removeEventListener("abort", abort);
            finishTask();
        };
        const cancelReader = () => cancellation ??= reader?.cancel().catch(() => undefined) ?? Promise.resolve();
        const abort = () => {controller.abort(); if (reader) void cancelReader().finally(cleanup);};
        for (const signal of signals) {
            if (signal.aborted) controller.abort();
            signal.addEventListener("abort", abort, {once: true});
        }
        const timer = setTimeout(abort, options.timeoutMs ?? 30_000);
        try {
            validateUrl(input);
            controller.signal.throwIfAborted();
            const upload = options.oneShotBody && init?.method?.toUpperCase() === "POST" ? singleUseBody(init.body) : {};
            options.beforeSend?.();
            const response = await source(input, {...init, ...upload, cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal});
            options.onStatus?.(response.status);
            reader = response.body?.getReader();
            controller.signal.throwIfAborted();
            if (response.type === "opaque" || response.type === "opaqueredirect" || response.redirected) throw new McpHostError("unsupported", "unknown", "browser_fetch");
            if (!reader) {cleanup(); return response;}
            const ownedReader = reader;
            let bytes = 0;
            const body = new ReadableStream<Uint8Array>({
                async pull(stream) {
                    try {
                        controller.signal.throwIfAborted();
                        const chunk = await ownedReader.read();
                        controller.signal.throwIfAborted();
                        if (chunk.done) {cleanup(); stream.close(); return;}
                        bytes += chunk.value.byteLength;
                        if (bytes > (options.maximumBytes ?? 1_048_576)) throw new McpHostError("limit", "unknown", "browser_fetch");
                        stream.enqueue(chunk.value);
                    } catch (error) {
                        controller.abort();
                        await cancelReader();
                        cleanup();
                        stream.error(error);
                    }
                },
                cancel() {controller.abort(); return cancelReader().finally(cleanup);},
            });
            return new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
        } catch (error) {controller.abort(); await cancelReader(); cleanup(); throw error;}
    };
}
