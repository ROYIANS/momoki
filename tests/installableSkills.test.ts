import {afterEach, describe, expect, it, vi} from "vitest";
import {SKILL_LIMITS} from "@momoki/agent-core";
import {db} from "@/platform/product/store";
import {UnknownCommitError} from "@/platform/storage/errors";
import {browserDatabase} from "@/platform/storage/browserDatabase";
import {createBrowserProductStore} from "@/platform/storage/browser";
import {prepareSkillImport, decodeSkillFrontmatter} from "@/features/agent/skills/runtime/package";
import {installSkill, updateInstalledSkill, setInstalledSkillEnabled, uninstallSkill, reconcileSkillMutation} from "@/features/agent/skills/commands/installations";
import {retainInstalledSkills, releaseInstalledSkills} from "@/features/agent/skills/commands/retention";
import {getInstalledSkillCatalogue, loadInstalledSkill, readInstalledSkillResource} from "@/features/agent/skills/queries/installedSkills";
import {SKILL_CATALOGUE_KEY, skillBodyKey, skillManifestKey, skillResourceKey, skillRetentionKey} from "@/features/agent/skills/runtime/records";
import type {InstalledSkillsSnapshot} from "@/features/agent/skills/models/installedSkill";
import {interceptStoreTable} from "./helpers/storeFaults";

const bytes = (text: string) => new TextEncoder().encode(text);
const document = (name = "scene-planning", body = "# 正文\n保存与权限仍由工具控制。", extra = "") => `---\nname: ${name}\ndescription: 创作步骤说明\n${extra}---\n${body}`;
function candidate(body = "# 正文\n保存与权限仍由工具控制。", name = "scene-planning") {
    return prepareSkillImport(name, [
        {path: "SKILL.md", bytes: bytes(document(name, body))},
        {path: "references/steps.md", bytes: bytes("甲😀乙\n步骤资料")},
        {path: "assets/example.json", bytes: bytes('{"not":"configuration"}')},
    ]);
}
const first = (input = candidate(), enabled = true) => installSkill({operationId: "install-one", catalogueRevision: 0, candidate: input, enabled});
afterEach(() => vi.restoreAllMocks());

describe("installed text skill packages", () => {
    it("preserves exact UTF-8 BOM/CRLF byte identities and canonical resource order", () => {
        const lf = document();
        const input = [{path: "references/z.md", bytes: bytes("尾部")}, {path: "SKILL.md", bytes: bytes(lf)}, {path: "assets/a.txt", bytes: bytes("首部")}];
        const a = prepareSkillImport("scene-planning", input);
        const b = prepareSkillImport("scene-planning", [...input].reverse());
        expect(a.manifest.revision).toBe(b.manifest.revision);
        expect(a.manifest.resources.map(item => item.path)).toEqual(["assets/a.txt", "references/z.md"]);
        const crlf = "\uFEFF" + lf.replaceAll("\n", "\r\n");
        const c = prepareSkillImport("scene-planning", [{path: "SKILL.md", bytes: bytes(crlf)}]);
        expect(c.document.text).toBe(crlf);
        const d = prepareSkillImport("scene-planning", [{path: "SKILL.md", bytes: bytes(lf)}]);
        expect(c.manifest.revision).not.toBe(d.manifest.revision);
    });

    it("rejects ambiguous YAML before conversion and reports advisory/unknown fields", () => {
        for (const yaml of ["name: a\nname: b", "name: &x hello\ndescription: *x", "name: !host run", "name: !!str abc", "name: a\n---\nname: b", "name: {a: {b: {c: {d: x}}}}"])
            expect(() => decodeSkillFrontmatter(yaml)).toThrow();
        const input = prepareSkillImport("scene-planning", [{path: "SKILL.md", bytes: bytes(document("scene-planning", "Body", "allowed-tools: arbitrary_shell\nfuture-field: ignored\nmetadata:\n  author: 小明\n"))}]);
        expect(input.manifest.metadata.allowedTools).toBe("arbitrary_shell");
        expect(input.manifest.metadata.unsupportedFields).toEqual(["allowed-tools", "future-field"]);
        expect(input.manifest.metadata.metadata?.author).toBe("小明");
    });

    it("rejects invalid UTF-8, binary text, oversized text and directory/name mismatch", () => {
        for (const invalid of [new Uint8Array([0xff]), bytes(document() + "\0")]) expect(() => prepareSkillImport("scene-planning", [{path: "SKILL.md", bytes: invalid}])).toThrow();
        expect(() => prepareSkillImport("wrong-name", [{path: "SKILL.md", bytes: bytes(document())}])).toThrow(/名称一致/);
        expect(() => candidate("x".repeat(SKILL_LIMITS.bodyBytes + 1))).toThrow();
        expect(() => prepareSkillImport("scene-planning", [{path: "SKILL.md", bytes: bytes(document())}, {path: "references/huge.txt", bytes: new Uint8Array(SKILL_LIMITS.resourceBytes + 1)}])).toThrow();
    });

    it("rejects escaping/Windows aliases/case conflicts and bounds text counts/raw/escaped bytes", () => {
        for (const path of ["../outside.md", "/outside.md", "C:/file.md", "references\\file.md", "references/NUL.md", "references/file.txt:stream", "references/a. /file.md"])
            expect(() => prepareSkillImport("scene-planning", [{path: "SKILL.md", bytes: bytes(document())}, {path, bytes: bytes("x")}])).toThrow();
        expect(() => prepareSkillImport("scene-planning", [{path: "SKILL.md", bytes: bytes(document())}, {path: "references/A.md", bytes: bytes("a")}, {path: "references/a.md", bytes: bytes("b")}])).toThrow();
        expect(() => prepareSkillImport("scene-planning", [{path: "SKILL.md", bytes: bytes(document())}, ...Array.from({length: 32}, (_, i) => ({path: `references/${i}.txt`, bytes: bytes("x")}))])).toThrow(/过多/);
        expect(() => prepareSkillImport("scene-planning", [{path: "SKILL.md", bytes: bytes(document())}, ...Array.from({length: 4}, (_, i) => ({path: `references/${i}.txt`, bytes: bytes("x".repeat(SKILL_LIMITS.resourceBytes))}))])).toThrow(/总大小/);
        // 4*120KiB raw is under the raw cap but JSON escapes each control scalar sixfold.
        expect(() => prepareSkillImport("scene-planning", [{path: "SKILL.md", bytes: bytes(document())}, ...Array.from({length: 4}, (_, i) => ({path: `references/${i}.txt`, bytes: bytes("\u0001".repeat(120 * 1024))}))])).toThrow(/转义/);
    });

    it("excludes executable/binary/hidden/nested skill packages with a bounded summary", () => {
        const names = ["scripts/run.js", "assets/image.png", ".private/notes.md", "references/nested/SKILL.md", "references/nested/notes.md"];
        const input = prepareSkillImport("scene-planning", [{path: "SKILL.md", bytes: bytes(document())}, ...names.map(path => ({path, bytes: bytes("unavailable")}))]);
        expect(input.resources).toEqual([]);
        expect(input.exclusions).toEqual({count: 5, paths: names});
    });
});

describe("real ProductStore installed skill ownership", () => {
    it("discovers metadata without hydrating content and reads only the requested component", async () => {
        await first();
        const keys: string[] = [];
        const reads = interceptStoreTable(db, "deviceSettings", "get", async (_tx, args, next) => {keys.push(String(args[0])); return next();});
        const catalogue = await getInstalledSkillCatalogue();
        expect(keys).toEqual([SKILL_CATALOGUE_KEY]);
        const entry = catalogue.entries[0];
        keys.length = 0;
        const loaded = await loadInstalledSkill(entry);
        expect(loaded.body).toContain("保存与权限");
        expect(keys).toEqual([skillManifestKey(entry.revision), skillBodyKey(entry.revision)]);
        keys.length = 0;
        const page = await readInstalledSkillResource(entry, "references/steps.md", 1, 2);
        expect(page).toEqual({text: "😀乙", offset: 1, nextOffset: 3, end: false});
        expect(keys).toEqual([skillManifestKey(entry.revision), skillResourceKey(entry.revision, 1)]);
        keys.length = 0;
        await expect(readInstalledSkillResource(entry, "references/absent.md")).rejects.toThrow(/清单/);
        expect(keys).toEqual([skillManifestKey(entry.revision)]);
        reads.mockRestore();
    });

    it("installs disabled unless explicitly enabled and prevents builtin/same-name shadowing", async () => {
        await first(candidate(), false);
        expect((await getInstalledSkillCatalogue()).entries[0].enabled).toBe(false);
        await expect(installSkill({operationId: "duplicate", catalogueRevision: 1, candidate: candidate(), enabled: true})).rejects.toThrow(/同名/);
        await expect(installSkill({operationId: "builtin", catalogueRevision: 1, candidate: candidate("body", "desktop-media"), enabled: true})).rejects.toThrow(/同名/);
        expect((await getInstalledSkillCatalogue()).revision).toBe(1);
    });

    it("publishes catalogue/content/counts atomically and rolls back a reached late failure", async () => {
        let reached = false;
        const fault = interceptStoreTable(db, "deviceSettings", "put", async (_tx, args, next) => {
            if ((args[0] as {key: string}).key === SKILL_CATALOGUE_KEY) {reached = true; throw new Error("late catalogue fault");}
            return next();
        });
        await expect(first()).rejects.toThrow("late catalogue fault");
        expect(reached).toBe(true);
        fault.mockRestore();
        expect(await db.deviceSettings.count()).toBe(0);
        await first();
        expect((await getInstalledSkillCatalogue()).entries).toHaveLength(1);
    });

    it.each(["manifest", "body", "resource", "retention"] as const)("rejects an orphan %s row without overwriting or adopting it", async kind => {
        const selected = candidate();
        const revision = selected.manifest.revision;
        const rows = {
            manifest: {key: skillManifestKey(revision), value: selected.manifest, updatedAt: "orphan"},
            body: {key: skillBodyKey(revision), value: selected.document, updatedAt: "orphan"},
            resource: {key: skillResourceKey(revision, 0), value: selected.resources[0], updatedAt: "orphan"},
            retention: {key: skillRetentionKey(revision), value: {version: 1, revision, currentReferences: 0, runReferences: 3, serializedBytes: selected.serializedBytes}, updatedAt: "orphan"},
        };
        await db.deviceSettings.add(rows[kind]);
        const before = await db.deviceSettings.toArray();
        await expect(first(selected)).rejects.toThrow();
        expect(await db.deviceSettings.toArray()).toEqual(before);
        expect((await getInstalledSkillCatalogue()).entries).toEqual([]);
    });

    it("keeps the old update usable after a late transactional failure", async () => {
        const old = await first();
        const next = candidate("New body");
        const fault = interceptStoreTable(db, "deviceSettings", "put", async (_tx, args, proceed) => {
            if ((args[0] as {key: string}).key === SKILL_CATALOGUE_KEY) throw new Error("late update fault");
            return proceed();
        });
        await expect(updateInstalledSkill({operationId: "update-one", catalogueRevision: 1, skillId: old.skillId, expectedRevision: old.revision, candidate: next})).rejects.toThrow("late update fault");
        fault.mockRestore();
        const catalogue = await getInstalledSkillCatalogue();
        expect(catalogue.entries[0].revision).toBe(old.revision);
        expect((await loadInstalledSkill(catalogue.entries[0])).body).toContain("保存与权限");
        expect(await db.deviceSettings.get(skillManifestKey(next.manifest.revision))).toBeUndefined();
    });

    it("uses compare-and-set across competing panels and validates preview immutability", async () => {
        const installed = await first();
        const expectation = {catalogueRevision: 1, skillId: installed.skillId, expectedRevision: installed.revision};
        const results = await Promise.allSettled([
            setInstalledSkillEnabled({...expectation, operationId: "panel-a", enabled: false}),
            updateInstalledSkill({...expectation, operationId: "panel-b", candidate: candidate("updated")}),
        ]);
        expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
        const preview = candidate("preview");
        const changed = {...preview, document: {...preview.document, text: document("scene-planning", "changed")}};
        const catalogue = await getInstalledSkillCatalogue();
        await expect(updateInstalledSkill({operationId: "tampered", catalogueRevision: catalogue.revision, skillId: installed.skillId, expectedRevision: catalogue.entries[0].revision, candidate: changed})).rejects.toThrow(/已改变/);
    });

    it("reconciles an uncertain committed reply without duplicate writes and rejects reused operation identity", async () => {
        const original = db.transaction.bind(db);
        let lose = true;
        const spy = vi.spyOn(db, "transaction").mockImplementation(async (mode, scope, callback) => {
            const result = await original(mode, scope, callback);
            if (mode === "rw" && lose) {lose = false; throw new UnknownCommitError("native-operation", "fixture");}
            return result;
        });
        await expect(first()).rejects.toMatchObject({certainty: "unknown"});
        const proof = await reconcileSkillMutation({operationId: "install-one", catalogueRevision: 0});
        expect(proof.status).toBe("committed");
        const before = await db.deviceSettings.toArray();
        expect(await first()).toEqual(proof.status === "committed" ? proof.receipt : undefined);
        expect(await db.deviceSettings.toArray()).toEqual(before);
        await expect(first(candidate("other content"))).rejects.toThrow(/已用于其他/);
        spy.mockRestore();
    });

    it("returns conservative conflict after another writer replaces the bounded receipt", async () => {
        const installed = await first();
        await setInstalledSkillEnabled({operationId: "later", catalogueRevision: 1, skillId: installed.skillId, expectedRevision: installed.revision, enabled: false});
        expect(await reconcileSkillMutation({operationId: "install-one", catalogueRevision: 0})).toEqual({status: "conflict"});
        expect(await reconcileSkillMutation({operationId: "not-applied", catalogueRevision: 2})).toEqual({status: "unresolved"});
    });

    it("retains exact old versions across update/uninstall/retry/reinstall and collects after final release", async () => {
        const installed = await first();
        const snapshot = await db.transaction("rw", ["deviceSettings"], tx => retainInstalledSkills(tx));
        await updateInstalledSkill({operationId: "update", catalogueRevision: 1, skillId: installed.skillId, expectedRevision: installed.revision, candidate: candidate("new body")});
        await setInstalledSkillEnabled({operationId: "disable", catalogueRevision: 2, skillId: installed.skillId, expectedRevision: candidate("new body").manifest.revision, enabled: false});
        expect((await db.transaction("rw", ["deviceSettings"], tx => retainInstalledSkills(tx))).entries).toEqual([]);
        await db.transaction("rw", ["deviceSettings"], tx => retainInstalledSkills(tx, snapshot));
        const current = (await getInstalledSkillCatalogue()).entries[0];
        await uninstallSkill({operationId: "uninstall", catalogueRevision: 3, skillId: current.skillId, expectedRevision: current.revision});
        expect((await loadInstalledSkill(snapshot.entries[0])).body).toContain("保存与权限");
        const reinstalled = await installSkill({operationId: "reinstall", catalogueRevision: 4, candidate: candidate(), enabled: true});
        expect(reinstalled.skillId).not.toBe(installed.skillId);
        await uninstallSkill({operationId: "uninstall-again", catalogueRevision: 5, skillId: reinstalled.skillId, expectedRevision: reinstalled.revision});
        await db.transaction("rw", ["deviceSettings"], tx => releaseInstalledSkills(tx, [snapshot]));
        expect(await db.deviceSettings.get(skillManifestKey(installed.revision))).toBeDefined();
        await db.transaction("rw", ["deviceSettings"], tx => releaseInstalledSkills(tx, [snapshot]));
        expect(await db.deviceSettings.get(skillManifestKey(installed.revision))).toBeUndefined();
        expect((await getInstalledSkillCatalogue()).retainedRevisions).toEqual([]);
    });

    it("pin admission touches metadata/counts only and joins its supplied transaction", async () => {
        await first();
        const keys: string[] = [];
        const reads = interceptStoreTable(db, "deviceSettings", "get", async (_tx, args, next) => {keys.push(String(args[0])); return next();});
        let snapshot: InstalledSkillsSnapshot | undefined;
        await expect(db.transaction("rw", ["deviceSettings"], async tx => {snapshot = await retainInstalledSkills(tx); throw new Error("run admission failed");})).rejects.toThrow("run admission failed");
        expect(keys.every(key => key === SKILL_CATALOGUE_KEY || key.startsWith("agentSkills.retention."))).toBe(true);
        reads.mockRestore();
        expect(snapshot?.entries).toHaveLength(1);
        const retention = (await db.deviceSettings.get(skillRetentionKey(snapshot!.entries[0].revision)))?.value as {runReferences: number};
        expect(retention.runReferences).toBe(0);
    });

    it("fails closed on missing/corrupt text, catalogue and retention rather than substituting", async () => {
        const installed = await first();
        const entry = (await getInstalledSkillCatalogue()).entries[0];
        await db.deviceSettings.put({key: skillBodyKey(installed.revision), value: {version: 1, revision: installed.revision, path: "SKILL.md", text: document("scene-planning", "tampered")}, updatedAt: "now"});
        await expect(loadInstalledSkill(entry)).rejects.toThrow(/损坏/);
        await db.deviceSettings.delete(skillRetentionKey(installed.revision));
        await expect(setInstalledSkillEnabled({operationId: "disable", catalogueRevision: 1, skillId: installed.skillId, expectedRevision: installed.revision, enabled: false})).rejects.toThrow(/保留记录缺失/);
        await db.deviceSettings.put({key: SKILL_CATALOGUE_KEY, value: {version: 99}, updatedAt: "now"});
        await expect(getInstalledSkillCatalogue()).rejects.toThrow(/不支持/);
        await expect(installSkill({operationId: "new", catalogueRevision: 0, candidate: candidate("b", "other-skill"), enabled: true})).rejects.toThrow(/不支持/);
    });

    it("enforces enabled catalogue limits transactionally and reopens through the same owner", async () => {
        let revision = 0;
        for (let i = 0; i < SKILL_LIMITS.enabledCount; i++) {
            const receipt = await installSkill({operationId: `install-${i}`, catalogueRevision: revision, candidate: candidate("body", `skill-${i}`), enabled: true});
            revision = receipt.catalogueRevision;
        }
        const extra = candidate("body", "extra-skill");
        await expect(installSkill({operationId: "extra", catalogueRevision: revision, candidate: extra, enabled: true})).rejects.toThrow(/启用/);
        expect(await db.deviceSettings.get(skillManifestKey(extra.manifest.revision))).toBeUndefined();
        const receipt = await installSkill({operationId: "extra-disabled", catalogueRevision: revision, candidate: extra, enabled: false});
        expect(receipt.catalogueRevision).toBe(revision + 1);
        if (!browserDatabase) throw new Error("Browser fixture required");
        db.close();
        const reopened = createBrowserProductStore(browserDatabase);
        await reopened.open();
        expect((await getInstalledSkillCatalogue(reopened)).entries).toHaveLength(17);
        const descriptor = (await getInstalledSkillCatalogue(reopened)).entries.at(-1)!;
        expect((await loadInstalledSkill(descriptor, reopened)).body).toBe("body");
    });

    it("enforces 32 installed entries even when additional entries are disabled", async () => {
        for (let index = 0; index < SKILL_LIMITS.installedCount; index++) {
            await installSkill({operationId: `install-${index}`, catalogueRevision: index, candidate: candidate("body", `skill-${index}`), enabled: false});
        }
        const extra = candidate("body", "extra-skill");
        const before = await db.deviceSettings.count();
        await expect(installSkill({operationId: "extra", catalogueRevision: 32, candidate: extra, enabled: false})).rejects.toThrow(/数量达到上限/);
        expect(await db.deviceSettings.count()).toBe(before);
        expect((await getInstalledSkillCatalogue()).entries).toHaveLength(32);
    });

    it.each([
        {label: "revision count", count: SKILL_LIMITS.retainedRevisionCount, size: 1024, error: /保留版本已达上限/},
        {label: "serialized byte total", count: 64, size: 1024 * 1024, error: /容量上限/},
    ])("rejects retained $label exhaustion without hydrating or evicting pinned versions", async ({count, size, error}) => {
        // Legal bounded accounting rows stand in for already pinned historical groups.
        // Quota admission deliberately reads no retained content and must fail before publication.
        const revisions = Array.from({length: count}, (_, index) => (index + 1).toString(16).padStart(64, "0"));
        await db.transaction("rw", ["deviceSettings"], async tx => {
            await tx.deviceSettings.bulkPut(revisions.map(revision => ({key: skillRetentionKey(revision), updatedAt: "fixture",
                value: {version: 1, revision, currentReferences: 0, runReferences: 1, serializedBytes: size}})));
            await tx.deviceSettings.put({key: SKILL_CATALOGUE_KEY, updatedAt: "fixture", value: {version: 1, revision: 0, entries: [],
                retainedRevisions: revisions, serializedBytes: count * size}});
        });
        const reads: string[] = [];
        const spy = interceptStoreTable(db, "deviceSettings", "get", async (_tx, args, next) => {reads.push(String(args[0])); return next();});
        const selected = candidate();
        await expect(first(selected)).rejects.toThrow(error);
        expect(reads.every(key => key === SKILL_CATALOGUE_KEY || key.startsWith("agentSkills.retention."))).toBe(true);
        spy.mockRestore();
        expect((await getInstalledSkillCatalogue()).retainedRevisions).toEqual(revisions);
        expect(await db.deviceSettings.get(skillManifestKey(selected.manifest.revision))).toBeUndefined();
    });

    it("can replace one unpinned current version at the retained revision boundary", async () => {
        const installed = await first();
        const catalogue = await getInstalledSkillCatalogue();
        const revisions = Array.from({length: SKILL_LIMITS.retainedRevisionCount - 1}, (_, index) => (index + 1).toString(16).padStart(64, "0"));
        await db.transaction("rw", ["deviceSettings"], async tx => {
            await tx.deviceSettings.bulkPut(revisions.map(revision => ({key: skillRetentionKey(revision), updatedAt: "fixture",
                value: {version: 1, revision, currentReferences: 0, runReferences: 1, serializedBytes: 1024}})));
            await tx.deviceSettings.put({key: SKILL_CATALOGUE_KEY, updatedAt: "fixture", value: {...catalogue,
                retainedRevisions: [...catalogue.retainedRevisions, ...revisions], serializedBytes: catalogue.serializedBytes + revisions.length * 1024}});
        });
        const next = candidate("new version at capacity");
        await updateInstalledSkill({operationId: "replace-at-capacity", catalogueRevision: 1, skillId: installed.skillId, expectedRevision: installed.revision, candidate: next});
        expect((await getInstalledSkillCatalogue()).retainedRevisions).toHaveLength(SKILL_LIMITS.retainedRevisionCount);
        expect(await db.deviceSettings.get(skillManifestKey(installed.revision))).toBeUndefined();
        expect((await loadInstalledSkill((await getInstalledSkillCatalogue()).entries[0])).body).toBe("new version at capacity");
    });

    it("rolls back a late uninstall or final-release failure with all content and counts intact", async () => {
        const installed = await first();
        let catalogue = await getInstalledSkillCatalogue();
        const originalRows = await db.deviceSettings.toArray();
        let faultReached = 0;
        const fault = interceptStoreTable(db, "deviceSettings", "put", async (_tx, args, next) => {
            if ((args[0] as {key: string}).key === SKILL_CATALOGUE_KEY) {faultReached++; throw new Error("late collection failure");}
            return next();
        });
        await expect(uninstallSkill({operationId: "uninstall", catalogueRevision: 1, skillId: installed.skillId, expectedRevision: installed.revision})).rejects.toThrow("late collection failure");
        expect(faultReached).toBe(1);
        fault.mockRestore();
        expect(await db.deviceSettings.toArray()).toEqual(originalRows);
        const snapshot = await db.transaction("rw", ["deviceSettings"], tx => retainInstalledSkills(tx));
        await uninstallSkill({operationId: "uninstall", catalogueRevision: 1, skillId: installed.skillId, expectedRevision: installed.revision});
        catalogue = await getInstalledSkillCatalogue();
        const pinnedRows = await db.deviceSettings.toArray();
        const releaseFault = interceptStoreTable(db, "deviceSettings", "put", async (_tx, args, next) => {
            if ((args[0] as {key: string}).key === SKILL_CATALOGUE_KEY) {faultReached++; throw new Error("late release failure");}
            return next();
        });
        await expect(db.transaction("rw", ["deviceSettings"], tx => releaseInstalledSkills(tx, [snapshot]))).rejects.toThrow("late release failure");
        releaseFault.mockRestore();
        expect(faultReached).toBe(2);
        expect(await db.deviceSettings.toArray()).toEqual(pinnedRows);
        expect((await loadInstalledSkill(snapshot.entries[0])).body).toContain("保存与权限");
        expect((await getInstalledSkillCatalogue()).serializedBytes).toBe(catalogue.serializedBytes);
    });
});
