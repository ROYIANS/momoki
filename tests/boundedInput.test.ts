import {afterEach, describe, expect, it, vi} from "vitest";
import {assertResponseBytes, readResponseBlob, readResponseBytes, readResponseJson, readResponseText, ResponseLimitError} from "@momoki/agent-providers/http";
import {readSseEvents} from "@momoki/agent-providers/http";
import {downloadApimartAudio, generateApimartSpeech, getApimartMusicTask, submitApimartMusic} from "@/features/audio/providers/apimartAudio";
import {generateMimoSpeech, listMimoModels} from "@/features/audio/providers/mimoSpeech";
import {downloadAIHubMixResult, type AIHubMixTask} from "@/features/video/providers/aihubmix";
import {MAX_AUDIO_BYTES, MAX_ERROR_BYTES, MAX_JSON_BYTES, MAX_MEDIA_DOWNLOAD_BYTES} from "@/platform/media/limits";

const encode = (s: string) => new TextEncoder().encode(s);
const credentials = {baseUrl: "https://api.apimart.ai/v1", apiKey: "sk-secret"};
const speech = {model: "gpt-4o-mini-tts", input: "hello", voice: "alloy", response_format: "wav"} as const;
const mimoInput = {text: "hello", voice: "mimo_default", mimo: {mode: "preset", instruction: ""}} as const;

/** Finite reused chunks exercise real reads, without a 257 MiB fixture allocation. */
function sizedResponse(size: number, headers: Record<string, string> = {}, status = 200) {
    let remaining = size;
    const chunk = new Uint8Array(Math.min(size, 1024 * 1024));
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({pull(controller) {
        if (!remaining) return controller.close();
        const length = Math.min(remaining, chunk.length);
        controller.enqueue(chunk.subarray(0, length));
        remaining -= length;
    }, cancel}, {highWaterMark: 0});
    const response = new Response(body, {headers, status});
    return {response, body, cancel};
}
function chunksResponse(chunks: Uint8Array[], headers: Record<string, string> = {}) {
    let at = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({pull(controller) {
        if (at === chunks.length) controller.close();
        else controller.enqueue(chunks[at++]);
    }, cancel}, {highWaterMark: 0});
    return {response: new Response(body, {headers}), body, cancel};
}
async function events(response: Response, limit: number) {
    const result = [];
    for await (const event of readSseEvents(response, undefined, limit)) result.push(event);
    return result;
}
afterEach(() => vi.restoreAllMocks());

describe("bounded transport bytes and cleanup", () => {
    it.each([{}, {"content-length": "1"}])("enforces actual bytes despite missing/false length %j", async headers => {
        const edge = sizedResponse(9, headers);
        expect((await readResponseBytes(edge.response, 9)).byteLength).toBe(9);
        expect(edge.body.locked).toBe(false);
        const excess = chunksResponse([encode("12345"), encode("67890")], headers);
        await expect(readResponseBytes(excess.response, 9)).rejects.toBeInstanceOf(ResponseLimitError);
        expect(excess.cancel).toHaveBeenCalledOnce();
        expect(excess.body.locked).toBe(false);
    });
    it("rejects large declared size before reading, even when cancellation throws", async () => {
        const pull = vi.fn();
        const body = new ReadableStream<Uint8Array>({pull, cancel() {throw new Error("cleanup failed");}}, {highWaterMark: 0});
        await expect(readResponseBytes(new Response(body, {headers: {"content-length": "10"}}), 9)).rejects.toBeInstanceOf(ResponseLimitError);
        expect(pull).not.toHaveBeenCalled();
        expect(body.locked).toBe(false);
    });
    it("counts multibyte UTF-8 across chunks and rejects malformed UTF-8", async () => {
        const bytes = encode('{"value":"中文"}');
        const fixture = chunksResponse(Array.from(bytes, value => new Uint8Array([value])));
        expect(await readResponseJson(fixture.response, bytes.length)).toEqual({value: "中文"});
        await expect(readResponseText(new Response(bytes), bytes.length - 1)).rejects.toBeInstanceOf(ResponseLimitError);
        await expect(readResponseText(new Response(new Uint8Array([0xff])), 1)).rejects.toThrow();
    });
    it.each([new DOMException("stop", "AbortError"), Object.assign(new Error("stop"), {name: "AbortError"})])("preserves original reader AbortError without signal", async error => {
        const body = new ReadableStream<Uint8Array>({pull() {throw error;}}, {highWaterMark: 0});
        const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel").mockRejectedValue(new Error("cleanup"));
        const release = vi.spyOn(ReadableStreamDefaultReader.prototype, "releaseLock");
        await expect(readResponseBytes(new Response(body), 10)).rejects.toBe(error);
        expect(cancel).toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
    });
    it("cancels an in-flight blocked read on Stop, releases its lock and returns AbortError", async () => {
        const body = new ReadableStream<Uint8Array>({pull() {}}, {highWaterMark: 0});
        const controller = new AbortController();
        const pending = readResponseBytes(new Response(body), 10, controller.signal);
        controller.abort();
        await expect(pending).rejects.toMatchObject({name: "AbortError"});
        expect(body.locked).toBe(false);
    });
    it("creates no oversized Blob", async () => {
        const fixture = sizedResponse(10);
        await expect(readResponseBlob(fixture.response, 9)).rejects.toBeInstanceOf(ResponseLimitError);
        expect(fixture.cancel).toHaveBeenCalledOnce();
        expect(fixture.body.locked).toBe(false);
        expect(() => assertResponseBytes(9, 9)).not.toThrow();
    });
});

describe("physical SSE event budgets", () => {
    it.each([false, true])("counts both CRLF bytes before dispatch, split=%s", async split => {
        const wire = encode("data: 中\r\n\r\n");
        const chunks = split ? Array.from(wire, value => new Uint8Array([value])) : [wire];
        expect(await events(chunksResponse(chunks).response, wire.length)).toEqual([{data: "中", event: ""}]);
        const over = chunksResponse(chunks);
        await expect(events(over.response, wire.length - 1)).rejects.toBeInstanceOf(ResponseLimitError);
        expect(over.cancel).toHaveBeenCalledOnce();
        expect(over.body.locked).toBe(false);
    });
    it("bounds undelimited lines and multi-data-line events before dispatch", async () => {
        for (const wire of ["data: " + "a".repeat(40), "data: 123456789\ndata: 123456789\n\n"]) {
            const fixture = chunksResponse([encode(wire)]);
            await expect(events(fixture.response, 24)).rejects.toBeInstanceOf(ResponseLimitError);
            expect(fixture.cancel).toHaveBeenCalledOnce();
        }
    });
    it("handles many complete small events in one large chunk with no lifetime budget", async () => {
        const wire = "data: 1\n\n".repeat(10000);
        const fixture = chunksResponse([encode(wire)]);
        expect(await events(fixture.response, 9)).toHaveLength(10000);
        expect(fixture.body.locked).toBe(false);
    });
    it("preserves fatal decoding and rejects trailing un-dispatched data", async () => {
        await expect(events(new Response(new Uint8Array([0xff])), 10)).rejects.toThrow();
        await expect(events(new Response("data: 1\n"), 10)).rejects.toThrow("意外中断");
    });
});

describe("actual provider inbound limits", () => {
    it("accepts exactly 32 MiB raw speech and CDN audio, rejects +1 without relying on headers", async () => {
        for (const operation of ["speech", "cdn"] as const) {
            for (const size of [MAX_AUDIO_BYTES, MAX_AUDIO_BYTES + 1]) {
                const fixture = sizedResponse(size, {"content-type": "audio/wav", "content-length": "1"});
                const fetchImpl = vi.fn<typeof fetch>(async () => fixture.response);
                const result = operation === "speech" ? await generateApimartSpeech(credentials, speech, {fetchImpl}) : await downloadApimartAudio("https://cdn.example/audio", {fetchImpl});
                expect(result.ok).toBe(size === MAX_AUDIO_BYTES);
                if (result.ok) expect(result.blob.size).toBe(MAX_AUDIO_BYTES);
                else {
                    expect(result.kind).toBe("protocol");
                    expect(result.message).toContain("32 MiB");
                }
                expect(fetchImpl).toHaveBeenCalledOnce();
                expect(fixture.body.locked).toBe(false);
                if (size > MAX_AUDIO_BYTES) expect(fixture.cancel).toHaveBeenCalledOnce();
            }
        }
    });
    it("bounds APIMart music submit/detail and embedded speech JSON before parse", async () => {
        for (const operation of ["submit", "detail", "speech"] as const) {
            const fixture = sizedResponse(MAX_JSON_BYTES + 1, {"content-type": "application/json"});
            const fetchImpl = vi.fn<typeof fetch>(async () => fixture.response);
            const result = operation === "submit" ? await submitApimartMusic(credentials, {model: "flowmusic", sound_prompt: "piano"}, {fetchImpl}) : operation === "detail" ? await getApimartMusicTask(credentials, "task", {fetchImpl}) : await generateApimartSpeech(credentials, speech, {fetchImpl});
            expect(result).toMatchObject({ok: false, kind: "protocol"});
            expect(fetchImpl).toHaveBeenCalledOnce();
            expect(fixture.cancel).toHaveBeenCalledOnce();
        }
    });
    it("retains authoritative non-2xx HTTP status when APIMart/MiMo diagnostic bodies overflow", async () => {
        for (const provider of ["apimart", "mimo"] as const) {
            const fixture = sizedResponse(MAX_ERROR_BYTES + 1, {}, 403);
            const fetchImpl = vi.fn<typeof fetch>(async () => fixture.response);
            const result = provider === "apimart" ? await generateApimartSpeech(credentials, speech, {fetchImpl}) : await generateMimoSpeech({...credentials, baseUrl: "https://api.mimo.ai/v1"}, mimoInput, {fetchImpl});
            expect(result).toMatchObject({ok: false, kind: "http"});
            expect(result).toHaveProperty("message", expect.stringContaining("403"));
            expect(fixture.cancel).toHaveBeenCalledOnce();
        }
    });
    it("uses ordinary JSON limits for MiMo models, and protocol failure for oversized speech envelopes", async () => {
        for (const operation of ["models", "speech"] as const) {
            const fixture = sizedResponse(operation === "models" ? MAX_JSON_BYTES + 1 : 49 * 1024 * 1024);
            const fetchImpl = vi.fn<typeof fetch>(async () => fixture.response);
            const result = operation === "models" ? await listMimoModels({...credentials, baseUrl: "https://api.mimo.ai/v1"}, {fetchImpl}) : await generateMimoSpeech({...credentials, baseUrl: "https://api.mimo.ai/v1"}, mimoInput, {fetchImpl});
            expect(result).toMatchObject({ok: false, kind: "protocol"});
            expect(fixture.cancel).toHaveBeenCalledOnce();
            expect(fetchImpl).toHaveBeenCalledOnce();
        }
    });
    it.each([1, 2])("checks exact decoded base64 padding (+%s bytes) before atob", async extra => {
        const size = MAX_AUDIO_BYTES + extra;
        const length = Math.ceil(size / 3) * 4;
        const padding = (3 - size % 3) % 3;
        const encoded = "A".repeat(length - padding) + "=".repeat(padding);
        const atobSpy = vi.spyOn(globalThis, "atob");
        const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({choices: [{finish_reason: "stop", message: {audio: {data: encoded}}}]}));
        expect(await generateMimoSpeech({...credentials, baseUrl: "https://api.mimo.ai/v1"}, mimoInput, {fetchImpl})).toMatchObject({ok: false, kind: "protocol", message: expect.stringContaining("32 MiB")});
        expect(atobSpy).not.toHaveBeenCalled();
        expect(fetchImpl).toHaveBeenCalledOnce();
    });
    it("accepts a legitimate MiMo envelope above 4 MiB and exactly the decoded audio boundary", async () => {
        const bytes = new Uint8Array(MAX_AUDIO_BYTES);
        bytes.set(encode("RIFF")); bytes.set(encode("WAVE"), 8);
        const encoded = Buffer.from(bytes).toString("base64");
        const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({choices: [{finish_reason: "stop", message: {audio: {data: encoded}}}]}));
        const result = await generateMimoSpeech({...credentials, baseUrl: "https://api.mimo.ai/v1"}, mimoInput, {fetchImpl});
        expect(result).toMatchObject({ok: true});
        if (result.ok) expect(result.blob.size).toBe(MAX_AUDIO_BYTES);
        expect(fetchImpl).toHaveBeenCalledOnce();
    });
    it("allows protected AIHubMix video above 32 MiB and cancels above the independent media limit", async () => {
        const task: AIHubMixTask = {id: "video-1", kind: "video", status: "completed", providerStatus: "completed", model: "m", outputs: [{index: 0, type: "file", contentUrl: "https://aihubmix.com/ai/v1/videos/video-1/content", requiresAuthentication: true}]};
        for (const size of [MAX_AUDIO_BYTES + 1, MAX_MEDIA_DOWNLOAD_BYTES + 1]) {
            const fixture = sizedResponse(size, {"content-type": "video/mp4", "content-length": "1"});
            const fetchImpl = vi.fn<typeof fetch>(async () => fixture.response);
            const result = await downloadAIHubMixResult({baseUrl: "https://aihubmix.com/v1", apiKey: "secret"}, task, task.outputs[0], {fetchImpl});
            expect(result.ok).toBe(size <= MAX_MEDIA_DOWNLOAD_BYTES);
            if (result.ok) expect(result.blob.size).toBe(size);
            else {
                expect(fixture.cancel).toHaveBeenCalledOnce();
                expect(result).toMatchObject({kind: "protocol", message: expect.stringContaining("256 MiB")});
            }
            expect(fixture.body.locked).toBe(false);
            expect(fetchImpl).toHaveBeenCalledOnce();
            expect(fetchImpl.mock.calls[0][1]).toMatchObject({method: "GET", redirect: "error", credentials: "omit"});
        }
    });
});
