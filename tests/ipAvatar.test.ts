import {describe, expect, it} from "vitest";
import {db} from "@/platform/product/store";
import {createProject} from "@/features/projects/commands/projects";
import {createIpProfile, setIpAvatar} from "@/features/library/commands/ipProfiles";
import {collectMediaIds, putMedia} from "@/features/library/commands/media";
import {createId} from "@/platform/identity";

const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII="), c => c.charCodeAt(0));

async function image(projectId: string, mimeType = "image/png") {
    const id = createId("med");
    await putMedia({id, projectId, mimeType, filename: "portrait.png", blob: new Blob([bytes], {type: mimeType})});
    return id;
}

describe("IP portrait", () => {
    it("keeps a studio copy of a project image, so the portrait outlives the project's own media", async () => {
        const project = await createProject("头像来源");
        const mediaId = await image(project.id);
        const ip = await createIpProfile({name: "山间来信"});
        await setIpAvatar(ip.id, ip.revision, {mediaId});
        const saved = (await db.ipProfiles.get(ip.id))!;
        expect(saved.revision).toBe(ip.revision + 1);
        expect(saved.avatarMediaId).toBeTruthy();
        expect(saved.avatarMediaId).not.toBe(mediaId);
        expect((await db.media.get(saved.avatarMediaId!))!.projectId).toBe("studio");
        // The studio library keeps it in use; the original stays with its project.
        expect((await collectMediaIds()).has(saved.avatarMediaId!)).toBe(true);
        expect((await collectMediaIds("studio")).has(saved.avatarMediaId!)).toBe(true);
        expect(await db.media.get(mediaId)).toBeTruthy();
    });

    it("replaces and clears the portrait, dropping the old image once nothing uses it", async () => {
        const ip = await createIpProfile({name: "旧头像"});
        const first = await image("studio"), second = await image("studio");
        await setIpAvatar(ip.id, ip.revision, {mediaId: first});
        await setIpAvatar(ip.id, ip.revision + 1, {mediaId: second});
        expect((await db.ipProfiles.get(ip.id))!.avatarMediaId).toBe(second);
        expect(await db.media.get(first)).toBeUndefined();
        await setIpAvatar(ip.id, ip.revision + 2, null);
        expect((await db.ipProfiles.get(ip.id))!.avatarMediaId).toBeUndefined();
        expect(await db.media.get(second)).toBeUndefined();
    });

    it("refuses a stale revision, a non-image, and a missing image", async () => {
        const ip = await createIpProfile({name: "校验"});
        const doc = await image("studio", "application/pdf");
        await expect(setIpAvatar(ip.id, ip.revision, {mediaId: doc})).rejects.toThrow("PNG");
        await expect(setIpAvatar(ip.id, ip.revision, {mediaId: "missing"})).rejects.toThrow("不存在");
        await expect(setIpAvatar(ip.id, ip.revision + 5, {mediaId: await image("studio")})).rejects.toThrow("已更新");
    });
});
