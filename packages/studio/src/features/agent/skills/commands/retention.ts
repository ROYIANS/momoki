import type {InstalledSkillDescriptor} from "@momoki/agent-core";
import {formatSkillCatalogue, SKILL_LIMITS} from "@momoki/agent-core";
import {nowIso} from "../../../../platform/identity";
import type {ProductStore, StoreTx} from "../../../../platform/storage/types";
import type {InstalledSkillsSnapshot, SkillCatalogue, SkillRetention} from "../models/installedSkill";
import {skillSerializedBytes} from "../runtime/package";
import {parseStoredSkillMetadata, readSkillCatalogueRecord, readSkillManifestRecord, readSkillRetentionRecord, SKILL_CATALOGUE_KEY,
    skillBodyKey, skillId, skillManifestKey, skillResourceKey, skillRetentionKey, skillRevision} from "../runtime/records";

export async function putSkillSetting(key: string, value: unknown, store: ProductStore): Promise<void> {
    skillSerializedBytes(value);
    await store.deviceSettings.put({key, value, updatedAt: nowIso()});
}

/** Includes all retained revisions; no content rows are hydrated for accounting. */
export async function readSkillRetentions(catalogue: SkillCatalogue, store: ProductStore): Promise<Map<string, SkillRetention>> {
    const records = new Map<string, SkillRetention>();
    let bytes = 0;
    for (const revision of catalogue.retainedRevisions) {
        const retention = await readSkillRetentionRecord(revision, store);
        const current = catalogue.entries.filter(entry => entry.revision === revision).length;
        if (retention.currentReferences !== current) throw new Error("技能当前版本引用计数不一致");
        records.set(revision, retention);
        bytes += retention.serializedBytes;
    }
    if (bytes !== catalogue.serializedBytes) throw new Error("技能保留容量不一致");
    return records;
}

/** Caller already proved both counts reached zero in its own root transaction. */
export async function collectSkillRevision(revision: string, store: ProductStore): Promise<void> {
    const manifest = await readSkillManifestRecord(revision, store);
    await store.deviceSettings.bulkDelete([skillManifestKey(revision), skillBodyKey(revision), skillRetentionKey(revision),
        ...manifest.resources.map(resource => skillResourceKey(revision, resource.ordinal))]);
}

export function parseInstalledSkillsSnapshot(raw: unknown): InstalledSkillsSnapshot {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("技能执行快照无效");
    const record = raw as Record<string, unknown>;
    if (record.version !== 1 || !Array.isArray(record.entries) || record.entries.length > SKILL_LIMITS.enabledCount) throw new Error("技能执行快照无效");
    const entries: InstalledSkillDescriptor[] = record.entries.map((entry: unknown) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("技能执行快照条目无效");
        const item = entry as Record<string, unknown>;
        return {skillId: skillId(item.skillId), revision: skillRevision(item.revision), metadata: parseStoredSkillMetadata(item.metadata)};
    });
    if (new Set(entries.map(entry => entry.skillId)).size !== entries.length) throw new Error("技能执行快照重复");
    formatSkillCatalogue(entries);
    return {version: 1, entries};
}

/** Join run admission's transaction; resume must not call this a second time. */
export async function retainInstalledSkills(tx: StoreTx, previous?: InstalledSkillsSnapshot): Promise<InstalledSkillsSnapshot> {
    if (tx.mode !== "rw" || !tx.scope.includes("deviceSettings")) throw new Error("技能版本保留需要执行所属事务");
    const catalogue = await readSkillCatalogueRecord(tx);
    const snapshot = previous ? parseInstalledSkillsSnapshot(previous) : {version: 1 as const, entries: catalogue.entries.filter(entry => entry.enabled)
        .map(({skillId, revision, metadata}) => ({skillId, revision, metadata}))};
    const retentions = await readSkillRetentions(catalogue, tx);
    for (const revision of new Set(snapshot.entries.map(entry => entry.revision))) {
        const retention = retentions.get(revision);
        if (!retention || retention.runReferences >= Number.MAX_SAFE_INTEGER) throw new Error("执行引用的技能版本缺失或计数无效");
        // Retaining a retry reads metadata/counts only. Content is checked at the selected read.
        await putSkillSetting(skillRetentionKey(revision), {...retention, runReferences: retention.runReferences + 1}, tx);
    }
    return snapshot;
}

/** Release all deleted runs together inside their aggregate deletion transaction. */
export async function releaseInstalledSkills(tx: StoreTx, snapshots: readonly InstalledSkillsSnapshot[]): Promise<void> {
    if (tx.mode !== "rw" || !tx.scope.includes("deviceSettings")) throw new Error("技能版本释放需要执行所属事务");
    if (!snapshots.length) return;
    const catalogue = await readSkillCatalogueRecord(tx);
    const retentions = await readSkillRetentions(catalogue, tx);
    const decrements = new Map<string, number>();
    for (const input of snapshots) {
        const snapshot = parseInstalledSkillsSnapshot(input);
        for (const revision of new Set(snapshot.entries.map(entry => entry.revision))) decrements.set(revision, (decrements.get(revision) ?? 0) + 1);
    }
    for (const [revision, decrement] of decrements) {
        const retention = retentions.get(revision);
        if (!retention || retention.runReferences < decrement) throw new Error("技能执行引用计数不一致");
        const next = {...retention, runReferences: retention.runReferences - decrement};
        if (next.runReferences === 0 && next.currentReferences === 0) {
            await collectSkillRevision(revision, tx);
            retentions.delete(revision);
        } else await putSkillSetting(skillRetentionKey(revision), next, tx);
    }
    // Accounting changes do not alter the catalogue mutation revision/receipt.
    await putSkillSetting(SKILL_CATALOGUE_KEY, {...catalogue, retainedRevisions: [...retentions.keys()],
        serializedBytes: [...retentions.values()].reduce((sum, retention) => sum + retention.serializedBytes, 0)}, tx);
}
