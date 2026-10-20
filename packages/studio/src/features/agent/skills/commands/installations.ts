import {formatSkillCatalogue, SKILL_LIMITS} from "@momoki/agent-core";
import {createId, nowIso} from "../../../../platform/identity";
import {sha256Bytes} from "../../../../platform/media/sha256";
import {db as productDb} from "../../../../platform/product/store";
import {StorageError} from "../../../../platform/storage/errors";
import type {ProductStore, StoreTx} from "../../../../platform/storage/types";
import {AGENT_SKILLS} from "../../runtime/skills";
import type {InstalledSkill, SkillCatalogue, SkillImportCandidate, SkillMutationExpectation, SkillMutationKind, SkillMutationReceipt, SkillRetention} from "../models/installedSkill";
import {skillSerializedBytes, verifySkillCandidate} from "../runtime/package";
import {readSkillCatalogueRecord, readSkillManifestRecord, SKILL_CATALOGUE_KEY, skillBodyKey, skillId,
    skillManifestKey, skillResourceKey, skillRetentionKey, skillRevision} from "../runtime/records";
import {collectSkillRevision, putSkillSetting, readSkillRetentions} from "./retention";

type InstallInput = SkillMutationExpectation & {readonly candidate: SkillImportCandidate; readonly enabled: boolean};
type UpdateInput = SkillMutationExpectation & {readonly skillId: string; readonly expectedRevision: string; readonly candidate: SkillImportCandidate};
type EnableInput = SkillMutationExpectation & {readonly skillId: string; readonly expectedRevision: string; readonly enabled: boolean};
type UninstallInput = SkillMutationExpectation & {readonly skillId: string; readonly expectedRevision: string};

interface Mutation {
    readonly kind: SkillMutationKind;
    readonly operationId: string;
    readonly catalogueRevision: number;
    readonly skillId?: string;
    readonly expectedRevision?: string;
    readonly enabled?: boolean;
    readonly candidate?: SkillImportCandidate;
}

function fingerprint(mutation: Mutation): string {
    return sha256Bytes(new TextEncoder().encode(JSON.stringify([mutation.kind, mutation.operationId, mutation.catalogueRevision,
        mutation.skillId ?? null, mutation.expectedRevision ?? null, mutation.enabled ?? null, mutation.candidate?.manifest.revision ?? null])));
}

function validateMutation(mutation: Mutation): void {
    skillId(mutation.operationId);
    if (!Number.isSafeInteger(mutation.catalogueRevision) || mutation.catalogueRevision < 0 || mutation.catalogueRevision >= Number.MAX_SAFE_INTEGER) throw new Error("技能目录版本无效");
    if (mutation.skillId !== undefined) skillId(mutation.skillId);
    if (mutation.expectedRevision !== undefined) skillRevision(mutation.expectedRevision);
    if (mutation.enabled !== undefined && typeof mutation.enabled !== "boolean") throw new Error("技能启用状态无效");
}

function assertExpected(catalogue: SkillCatalogue, mutation: Mutation): void {
    if (catalogue.revision !== mutation.catalogueRevision) throw new StorageError("conflict", "技能列表已变化，请重新查看后再操作");
}

async function verifyExistingContent(candidate: SkillImportCandidate, tx: StoreTx): Promise<void> {
    const revision = candidate.manifest.revision;
    const manifest = await readSkillManifestRecord(revision, tx);
    if (JSON.stringify(manifest) !== JSON.stringify(candidate.manifest)) throw new Error("技能版本清单不一致");
    const keys = [skillBodyKey(revision), ...manifest.resources.map(resource => skillResourceKey(revision, resource.ordinal))];
    const records = [candidate.document, ...candidate.resources];
    const rows = await tx.deviceSettings.bulkGet(keys);
    if (rows.some((row, index) => !row || JSON.stringify(row.value) !== JSON.stringify(records[index]))) throw new Error("已有技能版本内容已损坏");
}

async function addContent(candidate: SkillImportCandidate, retentions: Map<string, SkillRetention>, tx: StoreTx): Promise<void> {
    const revision = candidate.manifest.revision;
    const prior = retentions.get(revision);
    if (prior) {
        if (prior.serializedBytes !== candidate.serializedBytes) throw new Error("技能版本容量记录不一致");
        await verifyExistingContent(candidate, tx);
        return;
    }
    if (retentions.size >= SKILL_LIMITS.retainedRevisionCount) throw new Error("技能保留版本已达上限。可在技能管理中选择“释放历史版本”，或删除相关历史对话");
    const retainedBytes = [...retentions.values()].reduce((sum, retention) => sum + retention.serializedBytes, 0);
    if (retainedBytes + candidate.serializedBytes > SKILL_LIMITS.retainedBytes) throw new Error("技能保留内容已达容量上限。可在技能管理中选择“释放历史版本”，或删除相关历史对话");
    const retention: SkillRetention = {version: 1, revision, currentReferences: 0, runReferences: 0, serializedBytes: candidate.serializedBytes};
    const rows = [
        {key: skillManifestKey(revision), value: candidate.manifest, updatedAt: nowIso()},
        {key: skillBodyKey(revision), value: candidate.document, updatedAt: nowIso()},
        ...candidate.resources.map((resource, ordinal) => ({key: skillResourceKey(revision, ordinal), value: resource, updatedAt: nowIso()})),
        {key: skillRetentionKey(revision), value: retention, updatedAt: nowIso()},
    ];
    // add, rather than put, rejects orphan/corrupt groups instead of overwriting them.
    await tx.deviceSettings.bulkAdd(rows);
    retentions.set(revision, retention);
}

async function adjustCurrentReferences(revisions: readonly string[], entries: readonly InstalledSkill[], retentions: Map<string, SkillRetention>, tx: StoreTx): Promise<void> {
    for (const revision of new Set(revisions)) {
        const retention = retentions.get(revision);
        if (!retention) throw new Error("技能保留记录缺失");
        const next = {...retention, currentReferences: entries.filter(entry => entry.revision === revision).length};
        if (next.currentReferences === 0 && next.runReferences === 0) {
            await collectSkillRevision(revision, tx);
            retentions.delete(revision);
        } else await putSkillSetting(skillRetentionKey(revision), next, tx);
    }
}

function catalogueWithEntries(catalogue: SkillCatalogue, entries: readonly InstalledSkill[], retentions: Map<string, SkillRetention>, receipt: SkillMutationReceipt): SkillCatalogue {
    if (entries.length > SKILL_LIMITS.installedCount) throw new Error("已安装技能数量达到上限");
    formatSkillCatalogue(entries.filter(entry => entry.enabled));
    const result: SkillCatalogue = {...catalogue, revision: receipt.catalogueRevision, entries,
        retainedRevisions: [...retentions.keys()], serializedBytes: [...retentions.values()].reduce((sum, retention) => sum + retention.serializedBytes, 0), lastOperation: receipt};
    skillSerializedBytes(result);
    return result;
}

function updateEntries(catalogue: SkillCatalogue, mutation: Mutation, at: string): {entries: InstalledSkill[]; target: InstalledSkill; affected: string[]} {
    const candidate = mutation.candidate;
    if (mutation.kind === "install") {
        if (!candidate) throw new Error("缺少技能安装内容");
        const name = candidate.manifest.metadata.name;
        if (AGENT_SKILLS.some(skill => skill.id === name) || catalogue.entries.some(entry => entry.metadata.name === name)) throw new Error("同名技能已存在，请选择该技能进行更新");
        const target: InstalledSkill = {skillId: createId("skill"), revision: candidate.manifest.revision, metadata: candidate.manifest.metadata,
            enabled: mutation.enabled === true, installedAt: at, updatedAt: at, source: {kind: "directory", label: name}};
        return {entries: [...catalogue.entries, target], target, affected: [target.revision]};
    }
    const previous = catalogue.entries.find(entry => entry.skillId === mutation.skillId);
    if (!previous || previous.revision !== mutation.expectedRevision) throw new StorageError("conflict", "技能版本已变化，请重新查看后再操作");
    let target = previous;
    switch (mutation.kind) {
        case "update":
            if (!candidate || candidate.manifest.metadata.name !== previous.metadata.name) throw new Error("更新文件夹必须属于同名技能");
            target = {...previous, revision: candidate.manifest.revision, metadata: candidate.manifest.metadata, updatedAt: candidate.manifest.revision === previous.revision ? previous.updatedAt : at};
            break;
        case "enable":
            target = {...previous, enabled: mutation.enabled === true, updatedAt: previous.enabled === mutation.enabled ? previous.updatedAt : at};
            break;
        case "uninstall":
            return {entries: catalogue.entries.filter(entry => entry.skillId !== previous.skillId), target, affected: [previous.revision]};
    }
    return {entries: catalogue.entries.map(entry => entry.skillId === target.skillId ? target : entry), target, affected: [previous.revision, target.revision]};
}

async function mutateSkills(mutation: Mutation, store: ProductStore): Promise<SkillMutationReceipt> {
    validateMutation(mutation);
    const owned: Mutation = {...mutation, ...(mutation.candidate ? {candidate: verifySkillCandidate(mutation.candidate)} : {})};
    const signature = fingerprint(owned);
    return store.transaction("rw", ["deviceSettings"], async tx => {
        const catalogue = await readSkillCatalogueRecord(tx);
        if (catalogue.lastOperation?.operationId === owned.operationId) {
            if (catalogue.lastOperation.fingerprint !== signature) throw new StorageError("conflict", "技能操作标识已用于其他内容");
            return catalogue.lastOperation;
        }
        assertExpected(catalogue, owned);
        const retentions = await readSkillRetentions(catalogue, tx);
        const {entries, target, affected} = updateEntries(catalogue, owned, nowIso());
        // Enabling/count/catalogue limits reject before any immutable content write.
        if (entries.length > SKILL_LIMITS.installedCount) throw new Error("已安装技能数量达到上限");
        formatSkillCatalogue(entries.filter(entry => entry.enabled));
        if (owned.kind === "update" && owned.candidate && owned.expectedRevision !== owned.candidate.manifest.revision) {
            // Free only the obsolete unpinned group before checking the new group's quota.
            // A later validation/write failure rolls this collection back with the update.
            await adjustCurrentReferences([owned.expectedRevision!], entries, retentions, tx);
        }
        if (owned.candidate) await addContent(owned.candidate, retentions, tx);
        await adjustCurrentReferences(affected.filter(revision => retentions.has(revision)), entries, retentions, tx);
        const receipt: SkillMutationReceipt = {operationId: owned.operationId, fingerprint: signature, kind: owned.kind, skillId: target.skillId,
            revision: target.revision, catalogueRevision: catalogue.revision + 1};
        await putSkillSetting(SKILL_CATALOGUE_KEY, catalogueWithEntries(catalogue, entries, retentions, receipt), tx);
        return receipt;
    });
}

export function installSkill(input: InstallInput, store: ProductStore = productDb): Promise<SkillMutationReceipt> {
    return mutateSkills({kind: "install", ...input}, store);
}

export function updateInstalledSkill(input: UpdateInput, store: ProductStore = productDb): Promise<SkillMutationReceipt> {
    return mutateSkills({kind: "update", ...input}, store);
}

export function setInstalledSkillEnabled(input: EnableInput, store: ProductStore = productDb): Promise<SkillMutationReceipt> {
    return mutateSkills({kind: "enable", ...input}, store);
}

export function uninstallSkill(input: UninstallInput, store: ProductStore = productDb): Promise<SkillMutationReceipt> {
    return mutateSkills({kind: "uninstall", ...input}, store);
}

export type SkillMutationReconciliation = {readonly status: "committed"; readonly receipt: SkillMutationReceipt}
    | {readonly status: "unresolved"} | {readonly status: "conflict"};

/** Explicit readback only; unknown transport certainty never triggers a second write. */
export async function reconcileSkillMutation(expectation: SkillMutationExpectation, store: ProductStore = productDb): Promise<SkillMutationReconciliation> {
    skillId(expectation.operationId);
    return store.transaction("r", ["deviceSettings"], async tx => {
        const catalogue = await readSkillCatalogueRecord(tx);
        if (catalogue.lastOperation?.operationId === expectation.operationId) return {status: "committed", receipt: catalogue.lastOperation};
        // Absence is not rollback proof: an earlier native COMMIT can still be pending.
        return {status: catalogue.revision === expectation.catalogueRevision ? "unresolved" : "conflict"};
    });
}
