import {interceptStoreTable} from "./helpers/storeFaults";
import {afterEach, describe, expect, it, vi} from "vitest";
import {db as browserDb} from "@/platform/product/store";
import {emptySlot} from "@/features/library/models/slot";
import {emptyProject} from "@/features/projects/models/newProject";
import {resolveProductStorage} from "@/platform/runtime/storageProfile";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
});

function nativeProfile(id: string, storage = "indexeddb") {
    const invoke = vi.fn(() => {throw new Error("Unexpected SQLite/system request");});
    vi.stubGlobal("window", {
        __TAURI_INTERNALS__: {invoke},
        __MOMOKI_PRODUCT_PROFILE__: {version: 1, id, storage},
        dispatchEvent: vi.fn(),
    });
    return invoke;
}

describe("fixed shared product storage ownership", () => {
    it("keeps the browser namespace even when a native profile is present without native IPC", () => {
        expect(resolveProductStorage(false, {version: 1, id: "other", storage: "sqlite"})).toEqual({
            runtime: "browser", storage: "indexeddb", profileId: null, databaseName: "aifenjing",
        });
    });

    it("separates native runtime identity, declared storage owner and stable fresh namespaces", () => {
        const normal = resolveProductStorage(true, {version: 1, id: "dev.momoki.product", storage: "indexeddb"});
        const isolated = resolveProductStorage(true, {version: 1, id: "dev.momoki.review", storage: "indexeddb"});
        const prototype = resolveProductStorage(true, {version: 1, id: "dev.momoki.fixture", storage: "sqlite"});
        expect(normal).toMatchObject({runtime: "tauri", storage: "indexeddb"});
        expect(isolated.databaseName).not.toBe(normal.databaseName);
        expect(normal.databaseName).not.toBe("aifenjing");
        expect(prototype.storage).toBe("sqlite");
        expect(Object.isFrozen(normal)).toBe(true);
    });

    it.each([
        undefined, null, [], {}, {version: 2, id: "dev.app", storage: "indexeddb"},
        {version: 1, id: "../dev.app", storage: "indexeddb"},
        {version: 1, id: "dev.app", storage: "auto"},
        {version: 1, id: "dev.app", storage: "indexeddb", importOldData: true},
    ])("rejects invalid native startup configuration without choosing a fallback (%j)", profile => {
        expect(() => resolveProductStorage(true, profile)).toThrow("存储配置无效");
    });

    it("opens only a fresh desktop database and keeps one owner despite later profile mutation", async () => {
        await browserDb.projects.add({...emptyProject("Browser sentinel"), id: "browser-sentinel"});
        const browserRead = vi.spyOn(browserDb.projects, "toArray");
        vi.resetModules();
        const invoke = nativeProfile("dev.momoki.owner-test");
        const {db} = await import("@/platform/product/store");
        const {getProductStorage} = await import("@/platform/runtime/storageProfile");
        const {getVideoWorkspaceRepository} = await import("@/features/video/services/workspaceRepository");
        const {uploadMediaFile} = await import("@/features/library/services/media");
        try {
            await db.delete();
            await db.open();
            expect(db.name).toBe("momoki-desktop:dev.momoki.owner-test:v1");
            const repository = getVideoWorkspaceRepository();
            expect(repository.storage).toBe("indexeddb");
            expect(await repository.projects()).toEqual([]);
            const project = await repository.createProject("Full desktop owner", "series");
            const [episode] = await repository.episodes(project.id);
            const shot = await repository.addShot(project.id, episode.id);
            const imported = await uploadMediaFile(project.id, new File(["internal-image"], "frame.png", {type: "image/png"}));
            await repository.setShotSlot(shot.id, "firstFrame", {...emptySlot(), result: {mediaId: imported.id, kind: "image"}});
            const bytes = (await db.media.get(imported.id))?.blob;
            expect(await bytes?.text()).toBe("internal-image");
            window.__MOMOKI_PRODUCT_PROFILE__ = {version: 1, id: "different", storage: "sqlite"};
            expect(getProductStorage().profileId).toBe("dev.momoki.owner-test");
            expect(getVideoWorkspaceRepository()).toBe(repository);
            db.close();
            await db.open();
            expect((await repository.project(project.id))?.name).toBe("Full desktop owner");
            expect((await db.media.get(imported.id))?.blob.size).toBe("internal-image".length);
            const failure = new Error("IndexedDB episode write failed");
            let lateWriteReached = false;
            const lateWrite = interceptStoreTable(db, "episodes", "add", async () => {lateWriteReached = true; throw failure;});
            await expect(repository.createProject("Must roll back")).rejects.toBe(failure);
            expect(lateWriteReached).toBe(true);
            lateWrite.mockRestore();
            expect((await repository.projects()).map(row => row.name)).toEqual(["Full desktop owner"]);
            expect(browserRead).not.toHaveBeenCalled();
            expect(invoke).not.toHaveBeenCalled();
        } finally {
            await db.delete();
            db.close();
        }
    });

    it("does not read or import another desktop profile's records or bytes", async () => {
        vi.resetModules();
        nativeProfile("dev.momoki.isolation-a");
        const first = (await import("@/platform/product/store")).db;
        await first.delete();
        await first.open();
        await first.media.add({id: "profile-a-only", projectId: "studio", filename: "owned.png", mimeType: "image/png", blob: new Blob(["a-only"])});
        first.close();
        vi.resetModules();
        const invoke = nativeProfile("dev.momoki.isolation-b");
        const second = (await import("@/platform/product/store")).db;
        try {
            await second.delete();
            await second.open();
            expect(await second.media.get("profile-a-only")).toBeUndefined();
            await second.media.add({id: "profile-b-only", projectId: "studio", filename: "owned.png", mimeType: "image/png", blob: new Blob(["b-only"])});
            await first.open();
            expect(await first.media.get("profile-b-only")).toBeUndefined();
            expect(await (await first.media.get("profile-a-only"))?.blob.text()).toBe("a-only");
            expect(invoke).not.toHaveBeenCalled();
        } finally {
            await first.delete();
            await second.delete();
            first.close(); second.close();
        }
    });
});
