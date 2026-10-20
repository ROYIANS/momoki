import {existsSync} from "node:fs";
import {readFile, unlink, writeFile, rename, symlink} from "node:fs/promises";
import {join} from "node:path";
import {beforeAll, describe, expect, it, vi} from "vitest";
import {createNativeProbe, nativeProbePath} from "./helpers/nativeProductProbe";
import {createProject} from "@/features/projects/commands/projects";
import {putMedia} from "@/features/library/commands/media";
import {addCharacter, setCharacterSlot} from "@/features/library/commands/assets";
import {createFileMaterial, promoteLegacyMaterial} from "@/features/library/commands/materials";
import {emptySlot} from "@/features/library/models/slot";
import type {BinaryContent, ManagedBinaryRef} from "@/platform/media/binaryTypes";
import {binaryAvailability, installNativeBinaryAccess, readBinaryBlob} from "@/platform/storage/binary";
import type {NativeBinaryServices} from "@/platform/storage/nativeBinary";
import {isBinaryReference} from "@/platform/storage/codec";
import {loadAudioBuffer} from "@/features/audio/engine/buffers";
import {Sha256} from "@/platform/media/sha256";

const {decodeAudioBlob} = vi.hoisted(() => ({decodeAudioBlob: vi.fn(async () => ({length: 10, numberOfChannels: 1}) as AudioBuffer)}));
vi.mock("@/features/audio/engine/engine", async original => ({...await original<typeof import("@/features/audio/engine/engine")>(), decodeAudioBlob}));

let current: Awaited<ReturnType<typeof createNativeProbe>> | undefined;
const access: NativeBinaryServices = {
    prepare: (...args) => current!.binaries.prepare(...args),
    discard: (...args) => current!.binaries.discard(...args),
    open: (...args) => current!.binaries.open(...args),
    identity: (...args) => current!.binaries.identity(...args),
    availability: (...args) => current!.binaries.availability(...args),
};
installNativeBinaryAccess(access);
function managed(binary: BinaryContent): ManagedBinaryRef {
    expect(binary instanceof Blob).toBe(false);
    expect(isBinaryReference(binary)).toBe(true);
    return binary as ManagedBinaryRef;
}
/** Only the disposable test host mutates known native-owned files to inject faults. */
function fixtureFile(root: string, ref: ManagedBinaryRef): string {
    return join(root, "assets", `id-${Buffer.from(ref.binaryId, "utf8").toString("hex")}`);
}
async function digest(binary: BinaryContent): Promise<string> {
    return new Sha256().update(new Uint8Array(await (await readBinaryBlob(binary)).arrayBuffer())).digest();
}

// The generic browser suite does not claim native proof. Explicit native acceptance
// requires the actual pinned Rust probe and fails when it is absent.
describe.skipIf(process.env.MOMOKI_NATIVE_STORAGE_ACCEPTANCE !== "1")("actual native product binary carriers", () => {
    beforeAll(() => {expect(existsSync(nativeProbePath), "Build the pinned native product_store_probe before native acceptance").toBe(true);});
    it("persists >32MiB actual bytes, file material and immutable setting snapshots independently of their import source", async () => {
        const native = await createNativeProbe();current = native;
        try {
            const project = await createProject("原生文件 / Case与大小写 🌹", "film", "16:9", undefined, native.store);
            const bytes = new Uint8Array(33 * 1024 * 1024 + 123);
            for (let at = 0; at < bytes.length; at++) bytes[at] = at % 251;
            const expected = new Sha256().update(bytes).digest();
            const source = join(native.root, "..", "external-source.png");
            await writeFile(source, bytes);
            await putMedia({id: "Original-ID-素材🌹", projectId: project.id, filename: "Source.png", mimeType: "image/png", blob: new Blob([await readFile(source)], {type: "image/png"})}, native.store);
            await unlink(source);
            const media = (await native.store.media.get("Original-ID-素材🌹"))!;
            const mediaRef = managed(media.blob);
            expect(mediaRef.byteLength).toBe(bytes.length);
            expect(await digest(media.blob)).toBe(expected);
            const file = await createFileMaterial(new File(["immutable document"], "guide.txt", {type: "text/plain"}), {kind: "global"}, undefined, native.store);
            const version = (await native.store.materialVersions.where("materialId").equals(file.id).first())!;
            expect(version.payload.type).toBe("file");
            if (version.payload.type !== "file") throw new Error("Expected file version");
            managed(version.payload.blob);
            expect(await (await readBinaryBlob(version.payload.blob)).text()).toBe("immutable document");
            const character = await addCharacter(project.id, native.store);
            await setCharacterSlot(character.id, "portrait", {...emptySlot(), result: {mediaId: media.id, kind: "image"}}, undefined, native.store);
            const setting = await promoteLegacyMaterial("character", character.id, {kind: "global"}, native.store);
            const snapshot = (await native.store.materialVersions.where("materialId").equals(setting.id).first())!;
            if (snapshot.payload.type !== "setting") throw new Error("Expected setting snapshot");
            const snapshotRef = managed(snapshot.payload.media[0].blob);
            expect(snapshotRef.binaryId).not.toBe(mediaRef.binaryId);
            expect(await digest(snapshot.payload.media[0].blob)).toBe(expected);
            await unlink(fixtureFile(native.root, mediaRef));
            expect(await binaryAvailability(mediaRef)).toBe("missing");
            expect(await digest(snapshot.payload.media[0].blob)).toBe(expected);
            await native.reopen();
            const reopened = (await native.store.materialVersions.get(snapshot.id))!;
            if (reopened.payload.type !== "setting") throw new Error("Expected reopened setting snapshot");
            expect(await digest(reopened.payload.media[0].blob)).toBe(expected);
            expect((await native.store.media.get(media.id))!.id).toBe(media.id);
            expect(await binaryAvailability((await native.store.media.get(media.id))!.blob)).toBe("missing");
            const reopenedFile = (await native.store.materialVersions.get(version.id))!;
            if (reopenedFile.payload.type !== "file") throw new Error("Expected reopened file material");
            expect(await (await readBinaryBlob(reopenedFile.payload.blob)).text()).toBe("immutable document");
        } finally {await native.close();current = undefined;}
    }, 300_000);
    it("revalidates actual native files before using warm audio cache and retains missing/corrupt rows across reopen", async () => {
        const native = await createNativeProbe();current = native;decodeAudioBlob.mockClear();
        try {
            const project = await createProject("cached source", "film", "16:9", undefined, native.store);
            await putMedia({id: "native-audio", projectId: project.id, filename: "voice.wav", mimeType: "audio/wav", blob: new Blob([new Uint8Array([1, 2, 3, 4])], {type: "audio/wav"})}, native.store);
            const ref = managed((await native.store.media.get("native-audio"))!.blob);
            await loadAudioBuffer("native-audio", native.store);
            await loadAudioBuffer("native-audio", native.store);
            expect(decodeAudioBlob).toHaveBeenCalledOnce();
            const path = fixtureFile(native.root, ref);
            await writeFile(path, new Uint8Array([4, 3, 2, 1]));
            expect(await binaryAvailability(ref)).toBe("corrupt");
            await expect(loadAudioBuffer("native-audio", native.store)).rejects.toBeDefined();
            expect(decodeAudioBlob).toHaveBeenCalledOnce();
            await unlink(path);
            expect(await binaryAvailability(ref)).toBe("missing");
            await native.reopen();
            const missing = (await native.store.media.get("native-audio"))!;
            expect(missing.id).toBe("native-audio");
            expect(await binaryAvailability(missing.blob)).toBe("missing");
            await expect(loadAudioBuffer("native-audio", native.store)).rejects.toBeDefined();
            expect(decodeAudioBlob).toHaveBeenCalledOnce();
        } finally {await native.close();current = undefined;}
    }, 30_000);
    it("rejects cached leases after an actual managed-parent symlink and permanently closes them", async () => {
        const native = await createNativeProbe();current = native;
        const assets = join(native.root, "assets"), outside = join(native.root, "..", "moved-assets");
        let moved = false;
        try {
            const project = await createProject("lease containment", "film", "16:9", undefined, native.store);
            await putMedia({id: "contained-media", projectId: project.id, filename: "owned.bin", mimeType: "application/octet-stream", blob: new Blob(["owned immutable bytes"])}, native.store);
            const ref = managed((await native.store.media.get("contained-media"))!.blob);
            const read = await native.binaries.open(ref), verify = await native.binaries.open(ref);
            await rename(assets, outside);moved = true;await symlink(outside, assets);
            await expect(read.readBlob()).rejects.toBeDefined();
            await expect(verify.verify()).rejects.toBeDefined();
            expect(await readFile(join(outside, fixtureFile(native.root, ref).split("/").at(-1)! ), "utf8")).toBe("owned immutable bytes");
            await unlink(assets);await rename(outside, assets);moved = false;
            await expect(read.readBlob()).rejects.toThrow("已结束");
            await expect(verify.verify()).rejects.toThrow("已结束");
            await read.close();await verify.close();
            expect(await (await readBinaryBlob(ref)).text()).toBe("owned immutable bytes");
            expect((await native.store.media.get("contained-media"))!.id).toBe("contained-media");
        } finally {
            if (moved) {await unlink(assets);await rename(outside, assets);}
            await native.close();current = undefined;
        }
    }, 30_000);
    it("reads twelve actual native consumers concurrently through the bounded shared queue", async () => {
        const native = await createNativeProbe();current = native;
        try {
            const project = await createProject("dense preview reads", "film", "16:9", undefined, native.store);
            await putMedia({id: "dense-media", projectId: project.id, filename: "owned.bin", mimeType: "application/octet-stream", blob: new Blob(["dense grid verified bytes"])}, native.store);
            const ref = managed((await native.store.media.get("dense-media"))!.blob);
            expect(await Promise.all(Array.from({length: 12}, async () => (await readBinaryBlob(ref)).text()))).toEqual(Array(12).fill("dense grid verified bytes"));
            await native.reopen();
            expect(await (await readBinaryBlob((await native.store.media.get("dense-media"))!.blob)).text()).toBe("dense grid verified bytes");
        } finally {await native.close();current = undefined;}
    }, 30_000);

    it("queues twelve actual raw binary preparations under the two active-stage bound without imposing a batch limit", async () => {
        const native = await createNativeProbe();current = native;
        try {
            const session = await native.driver.getSession();
            const claims = await Promise.all(Array.from({length: 12}, (_, at) => native.binaries.prepare(new Blob([`raw staged bytes ${at}`], {type: "text/plain"}), session)));
            expect(new Set(claims.map(claim => claim.reference.binaryId)).size).toBe(12);
            for (const [at, claim] of claims.entries()) {
                expect(claim.reference.contentHash).toBe(new Sha256().update(new TextEncoder().encode(`raw staged bytes ${at}`)).digest());
                expect(await readFile(fixtureFile(native.root, claim.reference), "utf8")).toBe(`raw staged bytes ${at}`);
            }
            await Promise.all(claims.map(claim => native.binaries.discard(claim, session)));
            expect(await native.store.media.count()).toBe(0);
        } finally {await native.close();current = undefined;}
    }, 30_000);

    it("refuses actual stage write, finish and discard through a replaced parent and preserves external bytes", async () => {
        const native = await createNativeProbe();current = native;
        const stages = join(native.root, ".staging", "binaries"), outside = join(native.root, "..", "moved-stages");
        let moved = false;
        try {
            const session = await native.driver.getSession();
            const partial = await native.binaryRequest(session, {type: "prepare", byteLength: 4, mimeType: "application/octet-stream"}) as {stageId: string};
            const complete = await native.binaryRequest(session, {type: "prepare", byteLength: 4, mimeType: "application/octet-stream"}) as {stageId: string};
            await native.binaryRequest(session, {type: "write", stageId: complete.stageId, offset: 0, bytes: [1, 2, 3, 4]});
            await rename(stages, outside);moved = true;await symlink(outside, stages);
            await expect(native.binaryRequest(session, {type: "write", stageId: partial.stageId, offset: 0, bytes: [1, 2, 3, 4]})).rejects.toMatchObject({code: "containment"});
            const contentHash = new Sha256().update(new Uint8Array([1, 2, 3, 4])).digest();
            await expect(native.binaryRequest(session, {type: "seal", stageId: complete.stageId, contentHash})).rejects.toMatchObject({code: "containment"});
            for (const stage of [partial, complete]) await expect(native.binaryRequest(session, {type: "abort", stageId: stage.stageId})).rejects.toMatchObject({code: "containment"});
            expect((await readFile(join(outside, `${partial.stageId}.stage`))).length).toBe(0);
            expect([...await readFile(join(outside, `${complete.stageId}.stage`))]).toEqual([1, 2, 3, 4]);
            await unlink(stages);await rename(outside, stages);moved = false;
            await expect(native.binaryRequest(session, {type: "write", stageId: partial.stageId, offset: 0, bytes: [1, 2, 3, 4]})).rejects.toMatchObject({code: "expired"});
            await expect(native.binaryRequest(session, {type: "seal", stageId: complete.stageId, contentHash})).rejects.toMatchObject({code: "expired"});
            for (const stage of [partial, complete]) await native.binaryRequest(session, {type: "abort", stageId: stage.stageId});
            expect(await native.store.media.count()).toBe(0);
        } finally {
            if (moved) {await unlink(stages);await rename(outside, stages);}
            await native.close();current = undefined;
        }
    }, 30_000);

});
