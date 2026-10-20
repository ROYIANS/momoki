import {beforeEach, describe, expect, it, vi} from "vitest";
import {Sha256} from "@/platform/media/sha256";
import {registerBinaryReference} from "@/platform/storage/codec";
import {StorageError} from "@/platform/storage/errors";
import {binaryAvailability, installNativeBinaryAccess, readBinaryBlob, withBinaryReadLease} from "@/platform/storage/binary";
import {createNativeBinaryServices, type BinaryAction, type NativeBinaryTransport, type NativeBinaryLease} from "@/platform/storage/nativeBinary";
import {IPC_CHUNK_BYTES, type NativeSession} from "@/platform/storage/protocol";
import {loadAudioBuffer} from "@/features/audio/engine/buffers";
import {db} from "@/platform/product/store";

const {decodeAudioBlob} = vi.hoisted(() => ({decodeAudioBlob: vi.fn(async () => ({length: 10, numberOfChannels: 1}) as AudioBuffer)}));
vi.mock("@/features/audio/engine/engine", async importOriginal => ({...await importOriginal<typeof import("@/features/audio/engine/engine")>(), decodeAudioBlob}));

const session: NativeSession = {version: 1, session: "33333333-3333-4333-8333-333333333333", workspaceId: "11111111-1111-4111-8111-111111111111", generation: 1};
const binaryId = "22222222-2222-4222-8222-222222222222";
const stageId = "44444444-4444-4444-8444-444444444444";
const leaseId = "55555555-5555-4555-8555-555555555555";
function reference(bytes: Uint8Array) {
    return registerBinaryReference({version: 1, workspaceId: session.workspaceId, binaryId, byteLength: bytes.byteLength, mimeType: "audio/wav", contentHash: new Sha256().update(bytes).digest()});
}

/** This exercises the real TS transport/access seam; native disk authority is
 * independently exercised by product_binary Rust tests, not by these replies. */
function transportFixture() {
    let source = new Uint8Array([1, 2, 3, 4]);
    let available = true;
    let corrupt = false;
    const actions: BinaryAction[] = [];
    const writes: Uint8Array[] = [];
    const request = async (_session: NativeSession, action: BinaryAction): Promise<unknown> => {
        actions.push(action);
        switch (action.type) {
            case "prepare": return {type: "prepared", stageId, binaryId, workspaceId: session.workspaceId, chunkBytes: IPC_CHUNK_BYTES};
            case "write": writes.push(new Uint8Array(action.bytes));return {type: "progress", offset: action.offset + action.bytes.length};
            case "seal": return {type: "sealed", claim: {stageId, reference: {...reference(source), contentHash: action.contentHash}}};
            case "abort": return {type: "aborted", found: true};
            case "availability": return {type: "availability", state: !available ? "missing" : corrupt ? "corrupt" : "ready"};
            case "readStart": {
                if (!available) throw new StorageError("unavailable", "missing");
                return {type: "readReady", leaseId, reference: action.reference, chunkBytes: IPC_CHUNK_BYTES};
            }
            case "readVerify": {
                if (!available || corrupt) throw new StorageError("unavailable", "changed during read");
                return {type: "verified"};
            }
            case "readClose": return {type: "closed", found: true};
            case "readChunk": return source.slice(action.offset, action.offset + action.byteLength).buffer;
        }
    };
    const transport: NativeBinaryTransport = {
        getSession: async () => session,
        request,
        read: request,
        write: async (_session, _stageId, offset, bytes) => {
            writes.push(new Uint8Array(bytes));
            return {type: "progress", offset: offset + bytes.byteLength};
        },
    };
    const services = createNativeBinaryServices(transport);
    return {services, transport, actions, writes, reference: () => reference(source), setBytes: (bytes: Uint8Array) => {source = bytes;}, remove: () => {available = false;}, damage: () => {corrupt = true;}, reset() {source = new Uint8Array([1, 2, 3, 4]);available = true;corrupt = false;actions.length = 0;writes.length = 0;}};
}

const shared = transportFixture();
installNativeBinaryAccess(shared.services);
beforeEach(() => {shared.reset();decodeAudioBlob.mockClear();});

describe("native binary TS access", () => {
    it("returns only verified opaque native playback URLs and revokes invalid or canceled previews", async () => {
        const fixture = transportFixture();
        const releases: string[] = [];
        const previewId = "66666666-6666-4666-8666-666666666666";
        const ref = fixture.reference();
        fixture.transport.preview = async () => ({previewId, url: `http://127.0.0.1:49152/${previewId}`, byteLength: ref.byteLength, mimeType: ref.mimeType});
        fixture.transport.releasePreview = async (_session, id) => {releases.push(id);return {};};
        const preview = await fixture.services.preview!(ref);
        expect(preview.url).toBe(`http://127.0.0.1:49152/${previewId}`);
        expect(fixture.actions).toEqual([]);
        preview.release();preview.release();
        expect(releases).toEqual([previewId]);
        for (const invalidUrl of [
            "file:///private/user/original.wav", "invalid-url", `momoki-media://localhost/${previewId}`,
            `http://localhost:49152/${previewId}`, `http://127.0.0.2:49152/${previewId}`, `http://127.1:49152/${previewId}`,
            `http://2130706433:49152/${previewId}`, `https://127.0.0.1:49152/${previewId}`, `http://127.0.0.1/${previewId}`,
            `http://127.0.0.1:443/${previewId}`, `http://127.0.0.1:49152/${previewId}?path=x`, `http://127.0.0.1:49152/${previewId}#x`,
            `http://user@127.0.0.1:49152/${previewId}`, `http://127.0.0.1:49152/not-the-issued-id`,
        ]) {
            fixture.transport.preview = async () => ({previewId, url: invalidUrl, byteLength: ref.byteLength, mimeType: ref.mimeType});
            await expect(fixture.services.preview!(ref)).rejects.toThrow("地址与素材引用不匹配");
        }
        expect(releases).toEqual(Array.from({length: 15}, () => previewId));
        const controller = new AbortController();
        fixture.transport.preview = async () => {controller.abort();return {previewId, url: `http://127.0.0.1:49152/${previewId}`, byteLength: ref.byteLength, mimeType: ref.mimeType};};
        await expect(fixture.services.preview!(ref, controller.signal)).rejects.toThrow();
        expect(releases).toEqual(Array.from({length: 16}, () => previewId));
    });

    it("prepares bounded raw chunks and returns a branded immutable claim without making it a row", async () => {
        const fixture = transportFixture();
        const bytes = new Uint8Array(IPC_CHUNK_BYTES * 2 + 17).map((_, index) => index % 251);
        fixture.setBytes(bytes);
        const claim = await fixture.services.prepare(new Blob([bytes], {type: "audio/wav"}), session);
        expect(fixture.writes.map(chunk => chunk.length)).toEqual([IPC_CHUNK_BYTES, IPC_CHUNK_BYTES, 17]);
        expect(claim.reference).toEqual(reference(bytes));
        expect(Object.isFrozen(claim.reference)).toBe(true);
        expect(fixture.actions.map(action => action.type)).toEqual(["prepare", "seal"]);
    });

    it("cancels incomplete preparation and rejects incorrect published metadata", async () => {
        const fixture = transportFixture();
        const controller = new AbortController();
        fixture.transport.write = async () => {controller.abort();return {type: "progress", offset: 4};};
        await expect(fixture.services.prepare(new Blob([new Uint8Array([1, 2, 3, 4])], {type: "audio/wav"}), session, controller.signal)).rejects.toThrow();
        expect(fixture.actions.at(-1)?.type).toBe("abort");
        const second = transportFixture();
        second.setBytes(new Uint8Array([9]));
        await expect(second.services.prepare(new Blob([new Uint8Array([1, 2, 3, 4])], {type: "audio/wav"}), session)).rejects.toThrow("校验信息不一致");
        expect(second.actions.at(-1)?.type).toBe("abort");
    });

    it("loads only requested managed bytes, verifies before callback result escapes and closes the lease", async () => {
        const blob = await readBinaryBlob(shared.reference());
        expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4]);
        expect(shared.actions.map(action => action.type)).toEqual(["readStart", "readChunk", "readVerify", "readClose"]);
        await expect(withBinaryReadLease(shared.reference(), async () => {shared.remove();return "prepared export";})).rejects.toThrow("changed during read");
        expect(shared.actions.at(-1)?.type).toBe("readClose");
    });

    it("preserves Blob identity in browser and rejects authored lookalike native capabilities", async () => {
        const blob = new Blob(["browser"]);
        expect(await readBinaryBlob(blob)).toBe(blob);
        expect(shared.actions).toEqual([]);
        await expect(readBinaryBlob({...shared.reference()})).rejects.toThrow("未经存储层验证");
    });

    it("keeps missing/corrupt metadata distinct from a real storage read fault", async () => {
        shared.remove();
        expect(await binaryAvailability(shared.reference())).toBe("missing");
        shared.reset();shared.damage();
        expect(await binaryAvailability(shared.reference())).toBe("corrupt");
        const fixture = transportFixture();
        fixture.transport.request = async () => {throw new StorageError("unavailable", "storage IO fault");};
        await expect(fixture.services.availability(fixture.reference())).rejects.toThrow("storage IO fault");
    });

    it("revalidates a cached audio buffer and cannot use it when original managed bytes disappear", async () => {
        const id = "native-audio-buffer-cache-fixture";
        await db.media.add({id, projectId: "studio", filename: "fixture.wav", mimeType: "audio/wav", blob: shared.reference()});
        // The browser test adapter structured-clones objects. Direct test source
        // registration restores the native decode brand without fabricating Blob.
        vi.spyOn(db.media, "get").mockResolvedValue({id, projectId: "studio", filename: "fixture.wav", mimeType: "audio/wav", blob: shared.reference()});
        await loadAudioBuffer(id);
        await loadAudioBuffer(id);
        expect(decodeAudioBlob).toHaveBeenCalledTimes(1);
        expect(shared.actions.filter(action => action.type === "readStart")).toHaveLength(2);
        shared.remove();
        await expect(loadAudioBuffer(id)).rejects.toThrow("missing");
        expect(decodeAudioBlob).toHaveBeenCalledTimes(1);
    });
});

describe("bounded native read scheduling", () => {
    function concurrentFixture() {
        const fixture = transportFixture();
        const original = fixture.transport.request;
        let active = 0, peak = 0, sequence = 0;
        const starts: string[] = [], closed: string[] = [];
        fixture.transport.request = async (session, action) => {
            if (action.type === "readStart") {
                active++;peak = Math.max(peak, active);
                const id = `55555555-5555-4555-8555-${String(++sequence).padStart(12, "0")}`;
                starts.push(id);
                return {type: "readReady", leaseId: id, reference: action.reference, chunkBytes: IPC_CHUNK_BYTES};
            }
            if (action.type === "readClose") {active--;closed.push(action.leaseId);}
            return original(session, action);
        };
        return {...fixture, starts, closed, peak: () => peak};
    }
    it("serves sixteen simultaneous consumers in FIFO order without exceeding the eight native leases", async () => {
        const fixture = concurrentFixture();
        const completed: number[] = [];
        await Promise.all(Array.from({length: 16}, async (_, index) => {
            const lease = await fixture.services.open(fixture.reference());
            const blob = await lease.readBlob();
            expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4]);
            await lease.verify();
            completed.push(index);
            await lease.close();
        }));
        expect(completed).toEqual(Array.from({length: 16}, (_, index) => index));
        expect(fixture.peak()).toBe(8);
        expect(fixture.closed).toHaveLength(16);
    });
    it("cancels a queued consumer before native IPC and gives the released slot to the next consumer", async () => {
        const fixture = concurrentFixture();
        const held: NativeBinaryLease[] = await Promise.all(Array.from({length: 8}, () => fixture.services.open(fixture.reference())));
        const controller = new AbortController();
        const canceled = fixture.services.open(fixture.reference(), controller.signal);
        const rejected = expect(canceled).rejects.toThrow();
        const next = fixture.services.open(fixture.reference());
        controller.abort();
        await rejected;
        expect(fixture.starts).toHaveLength(8);
        await held[0].close();
        const last = await next;
        expect(fixture.starts).toHaveLength(9);
        await Promise.all([...held.slice(1), last].map(lease => lease.close()));
        expect(fixture.peak()).toBe(8);
    });
    it.each(["start", "read", "verify", "close"] as const)("releases capacity after a %s failure and closes an unsuccessful active read", async failure => {
        const fixture = concurrentFixture();
        const original = fixture.transport.request;
        let fail = true;
        fixture.transport.request = async (session, action) => {
            if (fail && ((failure === "start" && action.type === "readStart") || (failure === "verify" && action.type === "readVerify") || (failure === "close" && action.type === "readClose"))) {
                fail = false;
                if (failure === "close") await original(session, action);
                throw new Error(`injected ${failure} fault`);
            }
            return original(session, action);
        };
        const read = fixture.transport.read;
        fixture.transport.read = async (session, action) => {
            if (failure === "read" && fail) {fail = false;throw new Error("injected read fault");}
            return read(session, action);
        };
        if (failure === "start") await expect(fixture.services.open(fixture.reference())).rejects.toThrow("injected start fault");
        else {
            const lease = await fixture.services.open(fixture.reference());
            if (failure === "read") await expect(lease.readBlob()).rejects.toThrow("injected read fault");
            if (failure === "verify") await expect(lease.verify()).rejects.toThrow("injected verify fault");
            if (failure === "close") await expect(lease.close()).rejects.toThrow("injected close fault");
            else {await lease.close();await expect(lease.verify()).rejects.toThrow("已结束");}
        }
        const next = await Promise.all(Array.from({length: 8}, () => fixture.services.open(fixture.reference())));
        await Promise.all(next.map(lease => lease.close()));
        expect(fixture.peak()).toBe(8);
        expect(fixture.starts.length).toBe(failure === "start" ? 8 : 9);
    });
    it("closes a canonical native handle even when its read acknowledgement is malformed", async () => {
        const fixture = concurrentFixture();
        const original = fixture.transport.request;
        let malformed = true;
        fixture.transport.request = async (session, action) => {
            const reply = await original(session, action);
            if (action.type === "readStart" && malformed) {malformed = false;return {...reply as object, chunkBytes: 1};}
            return reply;
        };
        await expect(fixture.services.open(fixture.reference())).rejects.toThrow("无效租约");
        expect(fixture.closed).toHaveLength(1);
        const held = await Promise.all(Array.from({length: 8}, () => fixture.services.open(fixture.reference())));
        expect(fixture.peak()).toBe(8);
        await Promise.all(held.map(lease => lease.close()));
    });
    it("closes an active lease on cancellation and does not let repeated close release capacity twice", async () => {
        const fixture = concurrentFixture();
        const controller = new AbortController();
        const first = await fixture.services.open(fixture.reference(), controller.signal);
        controller.abort();
        await first.close();await first.close();
        const held: NativeBinaryLease[] = await Promise.all(Array.from({length: 8}, () => fixture.services.open(fixture.reference())));
        expect(fixture.closed).toHaveLength(1);
        expect(fixture.peak()).toBe(8);
        await Promise.all(held.map(lease => lease.close()));
    });
});

describe("bounded native preparation scheduling", () => {
    it("removes canceled queued writes before IPC and releases both slots after seal or abort", async () => {
        const fixture = transportFixture();
        let unblock!: () => void;
        const gate = new Promise<void>(resolve => {unblock = resolve;});
        let prepared = 0, active = 0, peak = 0;
        const original = fixture.transport.request;
        fixture.transport.request = async (session, action) => {
            if (action.type === "prepare") {prepared++;active++;peak = Math.max(active, peak);}
            const reply = await original(session, action);
            if (action.type === "seal") {await gate;active--;}
            if (action.type === "abort") active--;
            return reply;
        };
        const blob = new Blob([new Uint8Array([1, 2, 3, 4])], {type: "audio/wav"});
        const held = [fixture.services.prepare(blob, session), fixture.services.prepare(blob, session)];
        await vi.waitFor(() => expect(prepared).toBe(2));
        const controller = new AbortController();
        const rejected = expect(fixture.services.prepare(blob, session, controller.signal)).rejects.toThrow();
        const next = fixture.services.prepare(blob, session);
        controller.abort();await rejected;
        expect(prepared).toBe(2);unblock();
        await Promise.all([...held, next]);
        expect(prepared).toBe(3);expect(peak).toBe(2);
        const controller2 = new AbortController();
        fixture.transport.write = async () => {controller2.abort();return {type: "progress", offset: 4};};
        await expect(fixture.services.prepare(blob, session, controller2.signal)).rejects.toThrow();
        fixture.transport.write = async (_session, _stage, offset, bytes) => ({type: "progress", offset: offset + bytes.length});
        await Promise.all([fixture.services.prepare(blob, session), fixture.services.prepare(blob, session)]);
        expect(peak).toBe(2);expect(active).toBe(0);
    });
});
