import {afterEach, describe, expect, it, vi} from "vitest";
import {DebouncedDraftController, flushPendingDrafts, registerPendingDraft} from "@/platform/product/drafts";
import {createRunWriter} from "@momoki/agent-core";
import {parseReferenceFile} from "@/features/references/documents/import";
import {streamResponses} from "@/features/agent/providers/responsesStream";

afterEach(() => vi.unstubAllGlobals());

describe("original failure and cancellation contracts", () => {
    it("reports the exact synchronous draft failure, rejects backup, and retries the unsaved value", async () => {
        const failure = Object.freeze({code: "storage-quota", transaction: "draft-1"});
        const errors: unknown[] = [];
        let attempts = 0;
        const saved: string[] = [];
        const controller = new DebouncedDraftController("", value => {
            if (++attempts === 1) throw failure;
            saved.push(value);
            return Promise.resolve();
        }, (_status, error) => {if (error !== undefined) errors.push(error);});
        controller.change("unsaved");
        await expect(controller.flushOrThrow()).rejects.toBe(failure);
        expect(errors).toEqual([failure]);
        await controller.flushOrThrow();
        expect(saved).toEqual(["unsaved"]);
        controller.dispose();
    });

    it("waits for every scoped draft and propagates the exact failure while preserving other scopes", async () => {
        const failure = Object.freeze({code: "quota", field: "story"});
        let finishOther!: () => void;
        const otherWrite = new Promise<void>(resolve => {finishOther = resolve;});
        const outside = vi.fn(async () => undefined);
        const release = [
            registerPendingDraft("e07-owned", () => Promise.reject(failure)),
            registerPendingDraft("e07-owned", () => otherWrite),
            registerPendingDraft("e07-other", outside),
        ];
        let settled = false;
        const flushing = flushPendingDrafts("e07-owned");
        const checked = expect(flushing).rejects.toBe(failure);
        void flushing.finally(() => {settled = true;}).catch(() => undefined);
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(outside).not.toHaveBeenCalled();
        finishOther();
        await checked;
        release.forEach(remove => remove());
    });

    it("preserves an asynchronous checkpoint failure and stops all later writes", async () => {
        const failure = Object.freeze({code: "transaction-aborted", source: "checkpoint"});
        const persist = vi.fn(() => Promise.reject(failure));
        const stop = vi.fn();
        const writer = createRunWriter(persist, stop);
        writer.push({content: "first"});
        await expect(writer.flush()).rejects.toBe(failure);
        writer.push({content: "must not persist"});
        await expect(writer.flush()).rejects.toBe(failure);
        expect(stop).toHaveBeenCalledOnce();
        expect(persist).toHaveBeenCalledOnce();
    });

    it("preserves AbortSignal.reason after DOCX dispatch while retiring the owned worker", async () => {
        const terminate = vi.fn();
        const postMessage = vi.fn();
        vi.stubGlobal("Worker", class {
            terminate = terminate;
            postMessage = postMessage;
            onmessage: unknown;
            onerror: unknown;
        });
        const reason = Object.freeze({code: "reference-owner-left"});
        const controller = new AbortController();
        const parsing = parseReferenceFile(new ArrayBuffer(8), "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", controller.signal);
        expect(postMessage).toHaveBeenCalledOnce();
        controller.abort(reason);
        await expect(parsing).rejects.toBe(reason);
        expect(terminate).toHaveBeenCalledOnce();
    });
});

it.each([null, ["completed"], {status: "completed"}])("rejects a compound or missing terminal status %j before accepting tools", async status => {
    const body = `data: ${JSON.stringify({type: "response.completed", response: {status, output: []}})}\n\n`;
    const fetchImpl = vi.fn(async () => new Response(body, {headers: {"content-type": "text/event-stream"}}));
    const result = await streamResponses({baseUrl: "https://fixture.invalid/v1", apiKey: "test-key", connectorDefinitionId: "openai-compatible", model: "fixture", messages: [{role: "user", content: "hi"}]}, {fetchImpl});
    expect(result).toMatchObject({ok: false, message: "Responses 结束事件状态不一致"});
    expect(result).not.toHaveProperty("toolCalls");
    expect(fetchImpl).toHaveBeenCalledOnce();
});
