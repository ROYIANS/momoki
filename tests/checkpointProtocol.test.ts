import {describe, expect, it, vi} from "vitest";
import {CHECKPOINT_CHUNK_SIZE, CHECKPOINT_FORMAT, createCheckpointManifest, decodeCheckpointManifest, encodeCheckpointManifest, prepareCheckpoint, validateCheckpointManifest, verifyCheckpointDelivery} from "@/app/workflows/checkpoint";
import type {CheckpointBuildInput, CheckpointManifest, CheckpointRecord} from "@/app/workflows/checkpoint";
import {Sha256} from "@/platform/media/sha256";
import {mediaWorkspaceRef, workspaceId} from "@/features/library/services/workspace";
import {checkpointFixtureInput, fixtureBinaryId, fixtureMediaId, fixtureProjectId, fixtureWorkspaceId} from "./helpers/checkpointProtocolFixture";

function plain(manifest: CheckpointManifest): Record<string, unknown> {
    return JSON.parse(encodeCheckpointManifest(manifest)) as Record<string, unknown>;
}

function reorderedInput(): CheckpointBuildInput {
    const ids = ["é", "e\u0301", "A", "a"];
    return {
        ...checkpointFixtureInput(),
        parentRevisionIds: [`sha256-v1:${"1".repeat(64)}`, `sha256-v1:${"2".repeat(64)}`],
        records: [
            {kind: "project", id: fixtureProjectId, title: "Exact identities"},
            ...ids.map(id => ({kind: "media" as const, id, projectId: fixtureProjectId, title: id, mediaWorkspaceRef: mediaWorkspaceRef(fixtureWorkspaceId, fixtureProjectId, id), binaryId: id})),
        ],
        binaries: ids.map((id, index) => ({binaryId: id, mediaId: id, projectId: fixtureProjectId, mimeType: "application/octet-stream", bytes: new Uint8Array([index + 1])})),
    };
}

describe("strict partial checkpoint manifest", () => {
    it("round-trips the explicit fixture and preserves authored title content", async () => {
        const title = "apiKey = authored text\n不能按关键词擦掉内容";
        const prepared = await prepareCheckpoint(checkpointFixtureInput(undefined, title));
        expect(prepared.manifest.format).toBe(CHECKPOINT_FORMAT);
        expect(prepared.manifest.coverage).toMatchObject({kind: "partial", included: ["project", "media"]});
        expect(prepared.manifest.records.find(record => record.kind === "project")).toMatchObject({title});
        expect(decodeCheckpointManifest(encodeCheckpointManifest(prepared.manifest))).toEqual(prepared.manifest);
        expect(decodeCheckpointManifest(prepared.manifest)).toEqual(prepared.manifest);
        expect(() => decodeCheckpointManifest("broken JSON")).toThrow("JSON");
    });

    it("has exact locale-independent revision and wire ordering for Unicode/case-sensitive identities", async () => {
        const input = reorderedInput();
        const first = await prepareCheckpoint(input);
        const reverse = await prepareCheckpoint({...input, records: [...input.records].reverse(), binaries: [...input.binaries].reverse(), parentRevisionIds: [...input.parentRevisionIds!].reverse()});
        expect(first.manifest.revisionId).toBe(reverse.manifest.revisionId);
        expect(encodeCheckpointManifest(first.manifest)).toBe(encodeCheckpointManifest(reverse.manifest));
        const permuted = {...first.manifest, records: [...first.manifest.records].reverse(), binaries: [...first.manifest.binaries].reverse(), parentRevisionIds: [...first.manifest.parentRevisionIds].reverse()};
        expect(encodeCheckpointManifest(permuted)).toBe(encodeCheckpointManifest(first.manifest));
        expect(new Set(first.manifest.binaries.map(binary => binary.mediaWorkspaceRef.relativePath.toLowerCase())).size).toBe(4);
    });

    it("changes revision identity for actual authored fields, byte content, workspace or parents", async () => {
        const first = await prepareCheckpoint(checkpointFixtureInput());
        const changes = [
            checkpointFixtureInput(undefined, "Different title"),
            checkpointFixtureInput(new Uint8Array([8, 9, 10])),
            checkpointFixtureInput(undefined, undefined, [first.manifest.revisionId]),
            {...checkpointFixtureInput(), workspaceId: "workspace-other", records: checkpointFixtureInput().records.map(record => record.kind === "media" ? {...record, mediaWorkspaceRef: mediaWorkspaceRef(workspaceId("workspace-other"), fixtureProjectId, fixtureMediaId)} : record)},
        ];
        for (const change of changes) expect((await prepareCheckpoint(change)).manifest.revisionId).not.toBe(first.manifest.revisionId);
    });

    it.each([
        ["unknown format", (raw: Record<string, unknown>) => { raw.format = "momoki.production.v1"; }],
        ["unknown schema", (raw: Record<string, unknown>) => { raw.schemaVersion = 2; }],
        ["unknown manifest field", (raw: Record<string, unknown>) => { raw.credential = "private"; }],
        ["browser-local", (raw: Record<string, unknown>) => { raw.workspaceId = "browser-local"; }],
        ["false full coverage", (raw: Record<string, unknown>) => { raw.coverage = {kind: "full", included: ["project", "media"], omitted: []}; }],
        ["unsupported coverage", (raw: Record<string, unknown>) => { raw.coverage = {kind: "partial", included: ["all-production-tables"], omitted: []}; }],
        ["malformed revision", (raw: Record<string, unknown>) => { raw.revisionId = "unknown"; }],
        ["non-finite size", (raw: Record<string, unknown>) => { (raw.binaries as Array<Record<string, unknown>>)[0]!.byteLength = Infinity; }],
        ["malformed hash", (raw: Record<string, unknown>) => { (raw.binaries as Array<Record<string, unknown>>)[0]!.sha256 = "bad"; }],
        ["runtime record", (raw: Record<string, unknown>) => { (raw.records as Array<Record<string, unknown>>)[0]!.claim = {owner: "running"}; }],
        ["opaque history", (raw: Record<string, unknown>) => { (raw.records as Array<Record<string, unknown>>)[0]!.result = {execution: "opaque"}; }],
        ["binary secret", (raw: Record<string, unknown>) => { (raw.binaries as Array<Record<string, unknown>>)[0]!.apiKey = "private"; }],
        ["absolute root", (raw: Record<string, unknown>) => { ((raw.binaries as Array<Record<string, unknown>>)[0]!.mediaWorkspaceRef as Record<string, unknown>).absoluteRoot = "/device"; }],
        ["traversal", (raw: Record<string, unknown>) => { ((raw.binaries as Array<Record<string, unknown>>)[0]!.mediaWorkspaceRef as Record<string, unknown>).relativePath = "../escape"; }],
        ["safe but wrong path", (raw: Record<string, unknown>) => { ((raw.binaries as Array<Record<string, unknown>>)[0]!.mediaWorkspaceRef as Record<string, unknown>).relativePath = mediaWorkspaceRef(fixtureWorkspaceId, fixtureProjectId, "other-media").relativePath; }],
        ["foreign media owner", (raw: Record<string, unknown>) => { (raw.records as Array<Record<string, unknown>>).find(record => record.kind === "media")!.projectId = "another-project"; }],
        ["foreign binary owner", (raw: Record<string, unknown>) => { (raw.binaries as Array<Record<string, unknown>>)[0]!.projectId = "another-project"; }],
        ["missing binary", (raw: Record<string, unknown>) => { raw.binaries = []; }],
        ["missing media", (raw: Record<string, unknown>) => { raw.records = (raw.records as Array<Record<string, unknown>>).filter(record => record.kind !== "media"); }],
        ["duplicate record", (raw: Record<string, unknown>) => { (raw.records as unknown[]).push((raw.records as unknown[])[0]); }],
        ["duplicate binary", (raw: Record<string, unknown>) => { (raw.binaries as unknown[]).push((raw.binaries as unknown[])[0]); }],
        ["duplicate parent", (raw: Record<string, unknown>) => { raw.parentRevisionIds = [`sha256-v1:${"1".repeat(64)}`, `sha256-v1:${"1".repeat(64)}`]; }],
        ["self parent", (raw: Record<string, unknown>) => { raw.parentRevisionIds = [raw.revisionId]; }],
        ["changed title", (raw: Record<string, unknown>) => { (raw.records as Array<Record<string, unknown>>)[0]!.title = "tampered"; }],
    ])("rejects %s before accepting a manifest", async (_label, change) => {
        const prepared = await prepareCheckpoint(checkpointFixtureInput());
        const candidate = plain(prepared.manifest);
        change(candidate);
        expect(() => validateCheckpointManifest(candidate)).toThrow();
    });

    it("rejects unknown raw build/descriptor/ref fields instead of projecting them silently", async () => {
        const input = checkpointFixtureInput();
        await expect(prepareCheckpoint({...input, credentials: {apiKey: "private"}} as CheckpointBuildInput)).rejects.toThrow("unsupported");
        await expect(prepareCheckpoint({...input, binaries: [{...input.binaries[0]!, paidJob: {owner: "live"}}]} as unknown as CheckpointBuildInput)).rejects.toThrow("unsupported");
        await expect(prepareCheckpoint({...input, records: input.records.map(record => record.kind === "media" ? {...record, mediaWorkspaceRef: {...record.mediaWorkspaceRef, localRoot: "/root"}} : record)} as CheckpointBuildInput)).rejects.toThrow("unsupported");
        await expect(prepareCheckpoint({...input, projectId: "studio"})).rejects.toThrow("Studio");
        await expect(prepareCheckpoint({...input, projectId: "bad\ud800"})).rejects.toThrow("Unicode");
    });

    it("supports a record-only partial fixture without inventing missing media", async () => {
        const prepared = await prepareCheckpoint({...checkpointFixtureInput(), records: [{kind: "project", id: fixtureProjectId, title: "No media"}], binaries: []});
        expect(prepared.binaries).toEqual([]);
        expect(validateCheckpointManifest(prepared.manifest).records).toHaveLength(1);
        const entries = (await prepareCheckpoint(checkpointFixtureInput())).manifest.binaries;
        expect(() => createCheckpointManifest({...checkpointFixtureInput(), binaries: entries})).not.toThrow();
    });
});

describe("immutable complete byte preparation and delivery", () => {
    it.each(["typed-array", "array-buffer"])("snapshots %s bytes and all metadata before the first await", async kind => {
        const bytes = new Uint8Array(CHECKPOINT_CHUNK_SIZE * 2 + 7).fill(1);
        const parentRevisionIds = [`sha256-v1:${"1".repeat(64)}`];
        const records: CheckpointRecord[] = [...checkpointFixtureInput().records];
        records[0] = {kind: "project", id: fixtureProjectId, title: "Before"};
        const coverage = {kind: "partial" as const, included: ["project", "media"] as ["project", "media"], omitted: ["opaque-history"]};
        const input = {...checkpointFixtureInput(kind === "typed-array" ? bytes : bytes.buffer), records, parentRevisionIds, coverage};
        const promise = prepareCheckpoint(input);
        records[0] = {kind: "project", id: fixtureProjectId, title: "After"};
        parentRevisionIds[0] = `sha256-v1:${"2".repeat(64)}`;
        coverage.omitted[0] = "after";
        bytes.fill(2);
        const prepared = await promise;
        expect(prepared.manifest.records.find(record => record.kind === "project")).toMatchObject({title: "Before"});
        expect(prepared.manifest.parentRevisionIds).toEqual([`sha256-v1:${"1".repeat(64)}`]);
        expect(prepared.manifest.coverage.omitted).toEqual(["opaque-history"]);
        expect(prepared.binaries[0]!.bytes.every(value => value === 1)).toBe(true);
        const exposed = prepared.binaries[0]!.bytes;
        exposed.fill(9);
        expect(prepared.binaries[0]!.bytes[0]).toBe(1);
        expect(Object.isFrozen(prepared.manifest)).toBe(true);
        expect(Object.isFrozen(prepared.binaries[0]!.entry)).toBe(true);
        expect(Object.isFrozen(prepared.binaries[0]!.entry.mediaWorkspaceRef)).toBe(true);
    });

    it("hashes only bounded turns and gives a real macrotask opportunity before completion", async () => {
        const lengths: number[] = [];
        const update = Sha256.prototype.update;
        const spy = vi.spyOn(Sha256.prototype, "update").mockImplementation(function(this: Sha256, bytes) { lengths.push(bytes.byteLength); return update.call(this, bytes); });
        try {
            let timerRan = false;
            setTimeout(() => { timerRan = true; }, 0);
            const prepared = await prepareCheckpoint(checkpointFixtureInput(new Blob([new Uint8Array(CHECKPOINT_CHUNK_SIZE * 4 + 11)])));
            expect(timerRan).toBe(true);
            expect(Math.max(...lengths)).toBeLessThanOrEqual(CHECKPOINT_CHUNK_SIZE);
            lengths.length = 0;
            await verifyCheckpointDelivery(prepared.manifest, new Map([[fixtureBinaryId, new Blob([new Uint8Array(prepared.binaries[0]!.bytes).buffer])]]));
            expect(Math.max(...lengths)).toBeLessThanOrEqual(CHECKPOINT_CHUNK_SIZE);
        } finally { spy.mockRestore(); }
    });

    it.each(["one-chunk", "record-only", "during-chunk-yield"])("cancels before return at %s", async kind => {
        const controller = new AbortController();
        const input = kind === "record-only" ? {...checkpointFixtureInput(), records: [checkpointFixtureInput().records[0]!], binaries: []} : checkpointFixtureInput(new Uint8Array(kind === "one-chunk" ? 8 : CHECKPOINT_CHUNK_SIZE * 4));
        const promise = prepareCheckpoint(input, controller.signal);
        if (kind === "during-chunk-yield") setTimeout(() => controller.abort(), 0);
        else controller.abort();
        await expect(promise).rejects.toMatchObject({name: "AbortError"});
    });

    it("rejects failed or truncated reads and empty input bytes", async () => {
        class TruncatedBlob extends Blob { override slice(): Blob { return new Blob([new Uint8Array([1])]); } }
        class FailedBlob extends Blob { override slice(): Blob { const part = new Blob(); part.arrayBuffer = async () => { throw new Error("read fault"); }; return part; } }
        await expect(prepareCheckpoint(checkpointFixtureInput(new TruncatedBlob([new Uint8Array([1, 2])])))).rejects.toThrow("truncated");
        await expect(prepareCheckpoint(checkpointFixtureInput(new FailedBlob([new Uint8Array([1, 2])])))).rejects.toThrow("read fault");
        await expect(prepareCheckpoint(checkpointFixtureInput(new Uint8Array()))).rejects.toThrow();
    });

    it.each(["missing", "corrupt", "truncated", "extra"])("rejects %s delivery bytes", async kind => {
        const prepared = await prepareCheckpoint(checkpointFixtureInput());
        const sources = new Map([[fixtureBinaryId, prepared.binaries[0]!.bytes]]);
        if (kind === "missing") sources.clear();
        if (kind === "corrupt") sources.set(fixtureBinaryId, new Uint8Array([9, 2, 3, 255]));
        if (kind === "truncated") sources.set(fixtureBinaryId, new Uint8Array([1, 2]));
        if (kind === "extra") sources.set("extra", new Uint8Array([1]));
        await expect(verifyCheckpointDelivery(prepared.manifest, sources)).rejects.toThrow();
    });

    it("snapshots provider maps and mutable bytes before verification yields", async () => {
        const bytes = new Uint8Array(CHECKPOINT_CHUNK_SIZE * 2 + 3).fill(1);
        const prepared = await prepareCheckpoint(checkpointFixtureInput(bytes));
        const source = new Uint8Array(bytes);
        const sources = new Map([[fixtureBinaryId, source]]);
        const promise = verifyCheckpointDelivery(prepared.manifest, sources);
        source.fill(2);
        sources.clear();
        const verified = await promise;
        expect(verified.binaries[0]!.bytes.every(value => value === 1)).toBe(true);
    });
});
