import {installStoreHook} from "./helpers/storeBackendFaults";
import {describe, expect, it, vi} from "vitest";
import {db} from "@/platform/product/store";
import {createProject} from "@/features/projects/commands/projects";
import {STUDIO_LIBRARY_ID} from "@/features/library/models/ownership";
import {uploadMediaFile} from "@/features/library/services/media";
import {copyIntoManagedWorkspace, mediaWorkspaceRef, resolveWorkspaceRef, workspaceId} from "@/features/library/services/workspace";

// Intercept the actual bounded slice/read boundary, not the unused full source read.
function mockRead(source: Blob, read: () => Promise<ArrayBuffer>) {
    const slice = source.slice.bind(source);
    return vi.spyOn(source, "slice").mockImplementation((start, end, type) => {
        const chunk = slice(start, end, type);
        vi.spyOn(chunk, "arrayBuffer").mockImplementation(read);
        return chunk;
    });
}

const workspace = workspaceId("fixture-workspace");
const metadata = {workspaceId: workspace, projectId: "project", filename: "source.png", mimeType: "image/png"};

describe("portable workspace references", () => {
    it("resolves the same identity against each device's own root, including Windows", () => {
        const ref = mediaWorkspaceRef(workspace, "project", "media");
        expect(ref.relativePath).toBe("projects/id-70726f6a656374/assets/id-6d65646961");
        expect(resolveWorkspaceRef(ref, {workspaceId: workspace, absolutePath: "/first/Momoki/"})).toBe(`/first/Momoki/${ref.relativePath}`);
        expect(resolveWorkspaceRef(ref, {workspaceId: workspace, absolutePath: "C:\\Users\\second\\Momoki"})).toBe(`C:/Users/second/Momoki/${ref.relativePath}`);
        expect(JSON.stringify(ref)).not.toContain("Momoki");
        const studio = mediaWorkspaceRef(workspace, STUDIO_LIBRARY_ID, "media");
        expect(studio.relativePath).toBe("studio/assets/id-6d65646961");
    });

    it("encodes authored identities as literal components without losing them", () => {
        const ref = mediaWorkspaceRef(workspace, "项目/../CON", "a:b/image");
        expect(ref.projectId).toBe("项目/../CON");
        expect(ref.relativePath).toBe("projects/id-e9a1b9e79bae2f2e2e2f434f4e/assets/id-613a622f696d616765");
        expect(resolveWorkspaceRef(ref, {workspaceId: workspace, absolutePath: "/container"})).toBe(`/container/${ref.relativePath}`);
    });

    it("keeps case, Unicode and separator identities distinct on every device root", () => {
        const ids = ["Project", "project", "Media", "media", "项目", "項目", "a/b", "a\\b", "a:b", "a%2Fb", "素材🌹", "é", "e\u0301", "�"];
        const refs = ids.flatMap(projectId => ids.map(mediaId => mediaWorkspaceRef(workspace, projectId, mediaId)));
        for (const absolutePath of ["/device-one/workspace", "C:\\Users\\two\\workspace"]) {
            const paths = refs.map(ref => resolveWorkspaceRef(ref, {workspaceId: workspace, absolutePath}).toLowerCase());
            expect(new Set(paths).size).toBe(ids.length ** 2);
        }
        for (const id of ["\ud800", "\ud801", "\udc00", "a\ud800b"]) {
            expect(() => mediaWorkspaceRef(workspace, id, "media")).toThrow("Unicode");
            expect(() => mediaWorkspaceRef(workspace, "project", id)).toThrow("Unicode");
        }
        const ref = mediaWorkspaceRef(workspace, "project", "Media");
        expect(() => resolveWorkspaceRef({...ref, relativePath: ref.relativePath.toUpperCase()}, {workspaceId: workspace, absolutePath: "/workspace"})).toThrow();
        expect(() => resolveWorkspaceRef({...ref, relativePath: ref.relativePath + "/id-61"}, {workspaceId: workspace, absolutePath: "/workspace"})).toThrow();
    });

    it.each(["/absolute.png", "C:/absolute.png", "\\\\server\\file", "projects/id-70726f6a656374/assets/../file",
        "projects/id-70726f6a656374/assets/./file", "projects/id-70726f6a656374/assets//file", "projects/id-70726f6a656374/assets/file/",
        "projects/id-70726f6a656374/assets/a\\b", "projects/id-70726f6a656374/assets/a:stream", "projects/id-70726f6a656374/assets/a\u0000b",
        "projects/id-70726f6a656374/assets/CON.png", "projects/id-70726f6a656374/assets/trailing.", "projects/id-other/assets/file"])("rejects unsafe or foreign project path %s", relativePath => {
        expect(() => resolveWorkspaceRef({...mediaWorkspaceRef(workspace, "project", "media"), relativePath}, {workspaceId: workspace, absolutePath: "/container"})).toThrow();
    });

    it("rejects foreign workspaces and invalid local roots", () => {
        const ref = mediaWorkspaceRef(workspace, "project", "media");
        expect(() => resolveWorkspaceRef(ref, {workspaceId: workspaceId("foreign"), absolutePath: "/container"})).toThrow("工作区");
        for (const absolutePath of ["relative", "/root/../outside", "C:\\root\\..\\outside", "/root/./other", "/root/\u0000other"]) {
            expect(() => resolveWorkspaceRef(ref, {workspaceId: workspace, absolutePath})).toThrow("目录");
        }
        expect(() => workspaceId("../other")).toThrow();
    });
});

describe("managed-copy staging", () => {
    it("copies bytes independently and hashes the copied content before returning", async () => {
        const inputBytes = new Uint8Array([97, 98, 99]);
        const source = new File([inputBytes], "source.png", {type: "image/png"});
        const staged = await copyIntoManagedWorkspace(source, metadata);
        const copy = staged.copy;
        inputBytes.fill(0);
        vi.spyOn(source, "slice").mockImplementation(() => {throw new Error("original source is gone");});
        expect(copy.blob).not.toBe(source);
        expect(await copy.blob.text()).toBe("abc");
        expect(copy.byteLength).toBe(3);
        expect(copy.contentHash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        expect(copy.ref.workspaceId).toBe(workspace);
        expect(copy.ref.projectId).toBe(metadata.projectId);
        expect(copy.blob.type).toBe("image/png");
        staged.discard();
        expect(() => staged.copy).toThrow("释放");
        expect(await copy.blob.text()).toBe("abc");
    });

    it("normalizes display names while same-name copies retain independent identities", async () => {
        const file = new Blob(["bytes"]);
        const first = await copyIntoManagedWorkspace(file, {...metadata, filename: "folder\\same.png"});
        const second = await copyIntoManagedWorkspace(file, {...metadata, filename: "same.png"});
        expect(first.copy.sourceName).toBe("same.png");
        expect(second.copy.sourceName).toBe("same.png");
        expect(first.copy.mediaId).not.toBe(second.copy.mediaId);
        expect(first.copy.ref.relativePath).not.toBe(second.copy.ref.relativePath);
        expect(first.copy.contentHash).toBe(second.copy.contentHash);
        first.discard(); second.discard();
    });

    it("rejects empty input, invalid metadata and incomplete source reads before persistence", async () => {
        await expect(copyIntoManagedWorkspace(new Blob(), metadata)).rejects.toThrow("为空");
        for (const patch of [{filename: ""}, {filename: ".."}, {mimeType: "unknown"}, {projectId: ""}]) {
            await expect(copyIntoManagedWorkspace(new Blob(["bytes"]), {...metadata, ...patch})).rejects.toThrow();
        }
        const source = new Blob(["bytes"]);
        mockRead(source, async () => new ArrayBuffer(1));
        await expect(copyIntoManagedWorkspace(source, metadata)).rejects.toThrow("不完整");
    });

    it("preserves a read failure and never touches source bytes", async () => {
        const source = new Blob(["source"]);
        const failure = new Error("source read failed");
        mockRead(source, async () => {throw failure;});
        await expect(copyIntoManagedWorkspace(source, metadata)).rejects.toBe(failure);
        expect(await source.text()).toBe("source");
    });

    it("cancels before/during reading and after staging without calling persistence", async () => {
        const canceled = new AbortController(); canceled.abort();
        await expect(copyIntoManagedWorkspace(new Blob(["bytes"]), metadata, canceled.signal)).rejects.toMatchObject({name: "AbortError"});
        const controller = new AbortController();
        let finish!: (buffer: ArrayBuffer) => void;
        const file = new Blob(["bytes"]);
        mockRead(file, () => new Promise(resolve => {finish = resolve;}));
        const pending = copyIntoManagedWorkspace(file, metadata, controller.signal);
        controller.abort(); finish(new TextEncoder().encode("bytes").buffer);
        await expect(pending).rejects.toMatchObject({name: "AbortError"});
        const after = new AbortController();
        const staged = await copyIntoManagedWorkspace(new Blob(["bytes"]), metadata, after.signal);
        const persist = vi.fn(async () => "saved");
        after.abort();
        await expect(staged.commit(persist)).rejects.toMatchObject({name: "AbortError"});
        expect(persist).not.toHaveBeenCalled();
        expect(() => staged.copy).toThrow("释放");
    });

    it("releases staging on persistence failure, preserving the original error", async () => {
        const source = new Blob(["source"]);
        const staged = await copyIntoManagedWorkspace(source, metadata);
        const failure = new Error("database rejected");
        await expect(staged.commit(async () => {throw failure;})).rejects.toBe(failure);
        expect(() => staged.copy).toThrow("释放");
        expect(await source.text()).toBe("source");
    });

    it("allows one persistence call and treats cancellation after it starts as committed", async () => {
        const controller = new AbortController();
        const staged = await copyIntoManagedWorkspace(new Blob(["bytes"]), metadata, controller.signal);
        let finish!: (value: string) => void;
        const persist = vi.fn(() => new Promise<string>(resolve => {finish = resolve;}));
        const pending = staged.commit(persist);
        await expect(staged.commit(persist)).rejects.toThrow("正在保存");
        expect(() => staged.discard()).toThrow("正在保存");
        controller.abort(); finish("saved");
        await expect(pending).resolves.toBe("saved");
        expect(persist).toHaveBeenCalledOnce();
        await expect(staged.commit(persist)).rejects.toThrow("释放");
    });
});

describe("existing media importer integration", () => {
    it("persists copied bytes/metadata and supports studio imports without a project row", async () => {
        const source = new File(["image"], "same.png", {type: "image/png"});
        const result = await uploadMediaFile(STUDIO_LIBRARY_ID, source);
        const record = (await db.media.get(result.id))!;
        expect(result.kind).toBe("image");
        expect(record).toMatchObject({projectId: STUDIO_LIBRARY_ID, filename: source.name, mimeType: source.type});
        expect(record.blob).not.toBe(source);
        expect(await record.blob.text()).toBe("image");
        expect(await db.projects.count()).toBe(0);
        const second = await uploadMediaFile(STUDIO_LIBRARY_ID, source);
        expect(second.id).not.toBe(result.id);
        expect(await db.media.count()).toBe(2);
    });

    it("retains image/video type behavior and rejects unsupported input", async () => {
        const result = await uploadMediaFile(STUDIO_LIBRARY_ID, new File(["video"], "clip.mp4", {type: "video/mp4"}));
        expect(result.kind).toBe("video");
        await expect(uploadMediaFile(STUDIO_LIBRARY_ID, new File(["audio"], "audio.wav", {type: "audio/wav"}))).rejects.toThrow("图片或视频");
        expect(await db.media.count()).toBe(1);
    });

    it.each(["empty", "read-failed", "canceled", "foreign-owner"] as const)("leaves no ready row after %s", async kind => {
        const file = new File(kind === "empty" ? [] : ["source"], "source.png", {type: "image/png"});
        const controller = new AbortController();
        if (kind === "read-failed") mockRead(file, async () => {throw new Error("read failed");});
        if (kind === "canceled") controller.abort();
        await expect(uploadMediaFile(kind === "foreign-owner" ? "missing-project" : STUDIO_LIBRARY_ID, file, controller.signal)).rejects.toThrow();
        expect(await db.media.count()).toBe(0);
        expect(await file.text()).toBe(kind === "empty" ? "" : "source");
    });

    it("waits for the independent copy before writing and revalidates a deleted parent", async () => {
        const project = await createProject("copy boundary");
        const file = new File(["source"], "source.png", {type: "image/png"});
        let finish!: (value: ArrayBuffer) => void;
        mockRead(file, () => new Promise(resolve => {finish = resolve;}));
        const pending = uploadMediaFile(project.id, file);
        expect(await db.media.count()).toBe(0);
        await db.projects.delete(project.id);
        finish(new TextEncoder().encode("source").buffer);
        await expect(pending).rejects.toThrow("项目");
        expect(await db.media.count()).toBe(0);
    });

    it("rolls the media row back when project touch fails", async () => {
        const project = await createProject("rollback");
        await db.projects.update(project.id, {updatedAt: "old timestamp"});
        const before = await db.projects.get(project.id);
        const failure = new Error("project touch failed");
        const fail = () => {throw failure;};
        const storeHook_projects_fail=await installStoreHook(db, "projects", "updating", fail);
        try {
            await expect(uploadMediaFile(project.id, new File(["source"], "source.png", {type: "image/png"}))).rejects.toBe(failure);
        } finally {
            storeHook_projects_fail.mockRestore();
        }
        expect(await db.media.count()).toBe(0);
        expect(await db.projects.get(project.id)).toEqual(before);
    });
});
