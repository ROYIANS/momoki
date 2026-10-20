import {afterEach, describe, expect, it, vi} from "vitest";
import {readHttpJson, type HttpJsonReadPolicy} from '@momoki/agent-providers/http';
import {requestOnce} from "@/platform/http/requestBoundary";
import * as bounded from "@momoki/agent-providers/http";
import {MAX_ERROR_BYTES, MAX_JSON_BYTES} from "@/platform/media/limits";
import {submitApimartImageGeneration, getApimartTask} from "@/features/video/providers/apimart";
import {submitAIHubMixImageGeneration, downloadAIHubMixResult, type AIHubMixTask} from "@/features/video/providers/aihubmix";
import {submitApimartMusic, getApimartMusicTask} from "@/features/audio/providers/apimartAudio";
import {listMimoModels} from "@/features/audio/providers/mimoSpeech";
import {listModels, testConnection} from "@/features/agent/providers/openaiCompatible";
import {discoverConnectorChatModels} from "@/features/settings/models/connectors";
import {executeWebRequest} from "@/features/references/providers/tavily";
import {saveSearchConnection, getSearchConnectionState} from "@/features/settings/commands/searchConnections";

const credentials = {baseUrl: "https://proxy.example/v1", apiKey: "sk-secret"};
const native: HttpJsonReadPolicy = {success: {kind: "native-json"}, failure: {kind: "native-json"}};
const finite: HttpJsonReadPolicy = {
    success: {kind: "bounded-json", maxBytes: 9, fatalUtf8: true},
    failure: {kind: "bounded-json", maxBytes: 9, fatalUtf8: true},
};
afterEach(() => vi.restoreAllMocks());

function failingNative(status: number, error: Error) {
    const response = new Response(null, {status});
    const json = vi.spyOn(response, "json").mockRejectedValue(error);
    return {response, json};
}
function streamed(bytes: Uint8Array[], status = 200) {
    let at = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({pull(controller) {
        if (at === bytes.length) controller.close();
        else controller.enqueue(bytes[at++]);
    }, cancel}, {highWaterMark: 0});
    return {response: new Response(body, {status, headers: {"content-length": "1"}}), body, cancel};
}
const encoded = (text: string) => new TextEncoder().encode(text);
const protectedTask: AIHubMixTask = {
    id: "task_1", kind: "image", model: "model", status: "completed", providerStatus: "completed",
    outputs: [{index: 0, type: "file", contentUrl: "https://proxy.example/ai/v1/images/task_1/content/result_0", requiresAuthentication: true}],
};

describe("D07 explicit single request and JSON policies", () => {
    it("forwards the original wire/response and transport exception once, without reading or replaying", async () => {
        const signal = new AbortController().signal;
        const response = Response.json({accepted: true});
        const json = vi.spyOn(response, "json");
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
        const wire = {method: "POST", headers: {Authorization: "Bearer secret"}, body: "paid-body"};
        expect(await requestOnce("https://proxy.example/submit", wire, {fetchImpl, signal, credentials: "omit", redirect: "error"})).toBe(response);
        expect(fetchImpl).toHaveBeenCalledExactlyOnceWith("https://proxy.example/submit", {...wire, signal, credentials: "omit", redirect: "error"});
        expect(json).not.toHaveBeenCalled();
        const error = new TypeError("unknown outcome");
        fetchImpl.mockReset().mockRejectedValue(error);
        await expect(requestOnce("https://proxy.example/submit", wire, {fetchImpl, credentials: "omit", redirect: "error"})).rejects.toBe(error);
        expect(fetchImpl).toHaveBeenCalledOnce();
        const controller = new AbortController();
        controller.abort(error);
        fetchImpl.mockClear();
        await expect(requestOnce("https://proxy.example/submit", wire, {fetchImpl, signal: controller.signal, credentials: "omit", redirect: "error"})).rejects.toBe(error);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it.each([200, 503])("preserves original native reader AbortError at HTTP %i", async status => {
        const error = new DOMException("original reader abort", "AbortError");
        const {response, json} = failingNative(status, error);
        await expect(readHttpJson(response, native)).rejects.toBe(error);
        expect(json).toHaveBeenCalledOnce();
    });
    it("discards only optional HTTP diagnostic failures; successful parser errors and primitives stay real", async () => {
        const error = new SyntaxError("bad body");
        await expect(readHttpJson(failingNative(200, error).response, native)).rejects.toBe(error);
        expect(await readHttpJson(failingNative(429, error).response, native)).toBeUndefined();
        for (const value of [null, false, 0, "scalar", []]) {
            expect(await readHttpJson(Response.json(value), native)).toEqual(value);
        }
    });
    it("uses actual bytes/fatal UTF8 and cancels/releases failed bounded diagnostics", async () => {
        const exact = streamed([encoded('{"é":1}')]);
        expect(await readHttpJson(exact.response, finite)).toEqual({é: 1});
        expect(exact.body.locked).toBe(false);
        const overflow = streamed([encoded("12345"), encoded("67890")], 503);
        expect(await readHttpJson(overflow.response, finite)).toBeUndefined();
        expect(overflow.cancel).toHaveBeenCalledOnce();
        expect(overflow.body.locked).toBe(false);
        const success = streamed([encoded("12345"), encoded("67890")]);
        await expect(readHttpJson(success.response, finite)).rejects.toBeInstanceOf(bounded.ResponseLimitError);
        expect(success.cancel).toHaveBeenCalledOnce();
        expect(success.body.locked).toBe(false);
        const malformed = streamed([new Uint8Array([34, 255, 34])], 503);
        expect(await readHttpJson(malformed.response, finite)).toBeUndefined();
        expect(malformed.body.locked).toBe(false);
        const replacement = {success: {kind: "bounded-json" as const, maxBytes: 9, fatalUtf8: false}, failure: finite.failure};
        expect(await readHttpJson(streamed([new Uint8Array([34, 255, 34])]).response, replacement)).toBe("�");
    });
    it("cancels a blocked bounded reader and retains a caller TypeError abort reason identity", async () => {
        const cancel = vi.fn();
        const pulling = Promise.withResolvers<void>();
        const body = new ReadableStream<Uint8Array>({pull() {pulling.resolve();}, cancel}, {highWaterMark: 0});
        const controller = new AbortController();
        const error = new TypeError("stop during body");
        const reading = readHttpJson(new Response(body, {status: 503}), finite, controller.signal);
        const assertion = expect(reading).rejects.toBe(error);
        await pulling.promise;
        controller.abort(error);
        await assertion;
        expect(cancel).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
    });
});

describe("D07 actual adapter status, reading, paid outcome and cancellation", () => {
    it.each([401, 429, 503])("keeps native HTTP %i authoritative when APIMart/AIHubMix diagnostics fail", async status => {
        for (const submit of [submitApimartImageGeneration, submitAIHubMixImageGeneration]) {
            const {response, json} = failingNative(status, new TypeError("failed body"));
            const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
            expect(await submit(credentials, {model: "model", prompt: "image"}, {fetchImpl})).toMatchObject({ok: false, kind: "http", httpStatus: status});
            expect(fetchImpl).toHaveBeenCalledOnce();
            expect(json).toHaveBeenCalledOnce();
        }
    });
    it("keeps bounded HTTP status after oversized or unreadable music/protected-download/MiMo diagnostics", async () => {
        for (const makeResponse of [
            () => new Response("", {status: 429, headers: {"content-length": String(MAX_ERROR_BYTES + 1)}}),
            () => new Response(new ReadableStream({start(controller) {controller.error(new TypeError("broken body"));}}), {status: 429}),
            () => new Response(new Uint8Array([255]), {status: 429}),
        ]) {
            expect(await submitApimartMusic(credentials, {model: "flowmusic", sound_prompt: "piano"}, {fetchImpl: async () => makeResponse()})).toMatchObject({ok: false, kind: "http", httpStatus: 429});
            expect(await downloadAIHubMixResult(credentials, protectedTask, protectedTask.outputs[0], {fetchImpl: async () => makeResponse()})).toMatchObject({ok: false, kind: "http", httpStatus: 429});
            expect(await listMimoModels(credentials, {fetchImpl: async () => makeResponse()})).toMatchObject({ok: false, message: expect.stringContaining("429")});
        }
    });
    it("keeps successful inline image JSON native above finite ordinary/audio budgets without large allocations", async () => {
        // Finite policy seam: any accidental bounded-reader use fails, while native .json runs.
        const image = {id: "inline", object: "image", model: "model", status: "completed", output: [{index: 0, type: "file", content_type: "image/png", content_url: null, b64_json: "YQ=="}], error: null};
        const hub = Response.json(image, {headers: {"content-length": String(33 * 1024 * 1024)}});
        const hubJson = vi.spyOn(hub, "json");
        const hubBody = vi.spyOn(hub, "body", "get").mockImplementation(() => {throw new Error("Bounded reader used for native JSON");});
        expect(await submitAIHubMixImageGeneration(credentials, {model: "model", prompt: "image"}, {fetchImpl: async () => hub})).toMatchObject({ok: true, task: {outputs: [{b64Json: "YQ=="}]}});
        const mart = Response.json({code: 200, data: [{task_id: "image"}]}, {headers: {"content-length": String(MAX_JSON_BYTES + 1)}});
        const martJson = vi.spyOn(mart, "json");
        const martBody = vi.spyOn(mart, "body", "get").mockImplementation(() => {throw new Error("Bounded reader used for native JSON");});
        expect(await submitApimartImageGeneration(credentials, {model: "model"}, {fetchImpl: async () => mart})).toMatchObject({ok: true});
        expect(hubJson).toHaveBeenCalledOnce();
        expect(martJson).toHaveBeenCalledOnce();
        expect(hubBody).not.toHaveBeenCalled();
        expect(martBody).not.toHaveBeenCalled();
    });
    it("does not replay a paid POST after unknown success-body outcome; explicit GET recovery is separate", async () => {
        const response = failingNative(200, new TypeError("response lost after submit")).response;
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response).mockResolvedValueOnce(Response.json({code: 200, data: {id: "task-1", status: "processing"}}));
        expect(await submitApimartImageGeneration(credentials, {model: "model"}, {fetchImpl})).toMatchObject({ok: false, kind: "protocol"});
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(await getApimartTask(credentials, "task-1", {fetchImpl})).toMatchObject({ok: true, task: {id: "task-1", status: "processing"}});
        expect(fetchImpl.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
            ["https://proxy.example/v1/images/generations", "POST"], ["https://proxy.example/v1/tasks/task-1?language=zh", "GET"],
        ]);
        const musicFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("", {headers: {"content-length": String(MAX_JSON_BYTES + 1)}})).mockResolvedValueOnce(Response.json({code: 200, data: {id: "music-1", status: "processing"}}));
        expect(await submitApimartMusic(credentials, {model: "flowmusic", sound_prompt: "piano"}, {fetchImpl: musicFetch})).toMatchObject({ok: false, kind: "protocol"});
        expect(musicFetch).toHaveBeenCalledOnce();
        expect(await getApimartMusicTask(credentials, "music-1", {fetchImpl: musicFetch})).toMatchObject({ok: true});
        expect(musicFetch.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
    });
    it.each(["fetch", "success-body", "http-body"])("keeps generic %s abort outside its paid fallback gate", async phase => {
        const controller = new AbortController();
        const reason = new TypeError("caller stopped");
        const fetchImpl = vi.fn<typeof fetch>(async () => {
            if (phase === "fetch") {controller.abort(reason); throw reason;}
            const response = new Response(null, {status: phase === "http-body" ? 401 : 200});
            const method = phase === "http-body" ? "text" : "json";
            vi.spyOn(response, method).mockImplementation(async () => {controller.abort(reason); throw reason;});
            return response;
        });
        expect(await testConnection(credentials, fetchImpl, {signal: controller.signal})).toEqual({ok: false, message: "caller stopped"});
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(fetchImpl.mock.calls[0][1]?.method).toBe("GET");
        expect(fetchImpl.mock.calls[0][1]?.signal).toBe(controller.signal);
    });
    it("forwards generic discovery signal, blocks pre-abort and never converts reader AbortError to protocol text", async () => {
        const controller = new AbortController();
        const error = new DOMException("native body abort", "AbortError");
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(failingNative(200, error).response);
        expect(await discoverConnectorChatModels({...credentials, definitionId: "openai-compatible"}, {fetchImpl, signal: controller.signal})).toEqual({ok: false, message: "native body abort"});
        expect(fetchImpl.mock.calls[0][1]?.signal).toBe(controller.signal);
        controller.abort(new TypeError("pre-stop"));
        fetchImpl.mockClear();
        expect(await listModels(credentials, fetchImpl, {signal: controller.signal})).toEqual({ok: false, message: "pre-stop"});
        expect(await testConnection(credentials, fetchImpl, {signal: controller.signal})).toEqual({ok: false, message: "pre-stop"});
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it("retains generic nonabort fetch-only fallback and rejects successful reader TypeError without another request", async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("CORS GET")).mockResolvedValueOnce(Response.json({choices: [{message: {role: "assistant", content: ""}}]}));
        expect(await testConnection({...credentials, defaultModel: "custom"}, fetchImpl)).toEqual({ok: true, via: "chat"});
        expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST"]);
        expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({model: "custom", messages: [{role: "user", content: "ping"}], max_tokens: 1});
        const bad = vi.fn<typeof fetch>().mockResolvedValue(failingNative(200, new TypeError("decoder failed")).response);
        expect(await testConnection(credentials, bad)).toEqual({ok: false, message: "服务响应解析失败：decoder failed"});
        expect(bad).toHaveBeenCalledOnce();
    });
    it("redacts full configured credentials before native adapter truncation and Tavily encoded-key URL filtering", async () => {
        const key = `sk-${"q".repeat(540)}/+`;
        const config = {...credentials, apiKey: key};
        for (const submit of [submitApimartImageGeneration, submitAIHubMixImageGeneration]) {
            const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({error: {message: `Bearer ${key} ${"tail".repeat(200)}`, code: key, type: key}}, {status: 403}));
            const result = await submit(config, {model: "model", prompt: "image"}, {fetchImpl});
            expect(result).toMatchObject({ok: false, kind: "http", httpStatus: 403});
            expect(JSON.stringify(result)).not.toContain("q".repeat(30));
        }
        const generic = await listModels(config, async () => new Response(`Bearer ${key} ${"tail".repeat(200)}`, {status: 403}));
        expect(generic).toMatchObject({ok: false, message: expect.stringContaining("403")});
        expect(JSON.stringify(generic)).not.toContain("q".repeat(30));
        await saveSearchConnection({apiKey: key, enabled: true});
        const revision = (await getSearchConnectionState()).revision;
        const result = await executeWebRequest("search", {query: "research"}, revision, {fetchImpl: async () => Response.json({results: [
            {title: "unsafe", url: `https://example.com/${encodeURIComponent(key)}`, content: "hidden"},
            {title: `${key} ${encodeURIComponent(key)}`, url: "https://example.com/safe", content: `${encodeURIComponent(key)} ${key}`},
        ]})});
        expect(result).toMatchObject({ok: true, sources: [{url: "https://example.com/safe"}]});
        expect(JSON.stringify(result)).not.toContain("q".repeat(30));
        expect(result.ok && "sources" in result && result.sources).toHaveLength(1);
    });
});
