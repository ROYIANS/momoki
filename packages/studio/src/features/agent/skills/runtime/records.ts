import {formatSkillCatalogue, SKILL_LIMITS, validateSkillMetadata, validateSkillResourcePaths} from "@momoki/agent-core";
import type {SkillMetadata} from "@momoki/agent-core";
import type {ProductStore} from "../../../../platform/storage/types";
import type {InstalledSkill, SkillCatalogue, SkillComponent, SkillManifest, SkillMutationReceipt, SkillRetention, SkillTextRecord} from "../models/installedSkill";
import {skillContentRevision, skillSerializedBytes} from "./package";

export const SKILL_CATALOGUE_KEY = "agentSkills.catalog.v1";
export const skillManifestKey = (revision: string) => `agentSkills.content.${revision}`;
export const skillBodyKey = (revision: string) => `agentSkills.body.${revision}`;
export const skillResourceKey = (revision: string, ordinal: number) => `agentSkills.resource.${revision}.${ordinal}`;
export const skillRetentionKey = (revision: string) => `agentSkills.retention.${revision}`;

function skillRecord(raw: unknown): Record<string, unknown> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error("技能存储记录无效");
    return raw as Record<string, unknown>;
}

function text(raw: unknown, maximum = 256): string {
    if (typeof raw !== "string" || !raw || raw.length > maximum) throw new Error("技能存储字段无效");
    return raw;
}

export function skillRevision(raw: unknown): string {
    if (typeof raw !== "string" || !/^[a-f0-9]{64}$/u.test(raw)) throw new Error("技能内容版本无效");
    return raw;
}

export function skillId(raw: unknown): string {
    const value = text(raw, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)) throw new Error("技能安装标识无效");
    return value;
}

function integer(raw: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > maximum) throw new Error("技能存储计数无效");
    return raw;
}

function version(record: Record<string, unknown>): void {
    if (record.version !== 1) throw new Error("不支持此技能存储版本");
}

export function parseStoredSkillMetadata(raw: unknown): SkillMetadata {
    const record = skillRecord(raw);
    const parsed = validateSkillMetadata({name: record.name, description: record.description,
        ...(record.license === undefined ? {} : {license: record.license}),
        ...(record.compatibility === undefined ? {} : {compatibility: record.compatibility}),
        ...(record.metadata === undefined ? {} : {metadata: record.metadata}),
        ...(record.allowedTools === undefined ? {} : {"allowed-tools": record.allowedTools})});
    if (!Array.isArray(record.unsupportedFields) || record.unsupportedFields.length > 32) throw new Error("技能元数据不完整");
    const unsupportedFields = record.unsupportedFields.map((field: unknown) => text(field, 64));
    if (new Set(unsupportedFields).size !== unsupportedFields.length || parsed.allowedTools !== undefined && !unsupportedFields.includes("allowed-tools")) throw new Error("技能元数据不完整");
    return {...parsed, unsupportedFields};
}

function parseInstalled(raw: unknown): InstalledSkill {
    const record = skillRecord(raw), source = skillRecord(record.source);
    if (typeof record.enabled !== "boolean" || source.kind !== "directory") throw new Error("技能目录状态无效");
    const metadata = parseStoredSkillMetadata(record.metadata);
    const label = text(source.label, 64);
    if (label !== metadata.name) throw new Error("技能来源标签无效");
    return {skillId: skillId(record.skillId), revision: skillRevision(record.revision), metadata, enabled: record.enabled,
        installedAt: text(record.installedAt), updatedAt: text(record.updatedAt), source: {kind: "directory", label}};
}

function parseReceipt(raw: unknown): SkillMutationReceipt {
    const record = skillRecord(raw);
    const kind = record.kind;
    if (kind !== "install" && kind !== "update" && kind !== "enable" && kind !== "uninstall") throw new Error("技能操作记录无效");
    return {operationId: skillId(record.operationId), fingerprint: skillRevision(record.fingerprint), kind,
        skillId: skillId(record.skillId), revision: skillRevision(record.revision), catalogueRevision: integer(record.catalogueRevision)};
}

function emptySkillCatalogue(): SkillCatalogue {
    return {version: 1, revision: 0, entries: [], retainedRevisions: [], serializedBytes: 0};
}

function parseSkillCatalogue(raw: unknown): SkillCatalogue {
    skillSerializedBytes(raw);
    const record = skillRecord(raw);
    version(record);
    if (!Array.isArray(record.entries) || record.entries.length > SKILL_LIMITS.installedCount
        || !Array.isArray(record.retainedRevisions) || record.retainedRevisions.length > SKILL_LIMITS.retainedRevisionCount) throw new Error("技能目录超过上限");
    const entries = record.entries.map(parseInstalled);
    if (new Set(entries.map(entry => entry.skillId)).size !== entries.length || new Set(entries.map(entry => entry.metadata.name)).size !== entries.length) throw new Error("技能目录包含重复安装");
    formatSkillCatalogue(entries.filter(entry => entry.enabled));
    const retainedRevisions = record.retainedRevisions.map(skillRevision);
    if (new Set(retainedRevisions).size !== retainedRevisions.length || entries.some(entry => !retainedRevisions.includes(entry.revision))) throw new Error("技能版本保留目录无效");
    const revision = integer(record.revision);
    const lastOperation = record.lastOperation === undefined ? undefined : parseReceipt(record.lastOperation);
    if (lastOperation && lastOperation.catalogueRevision !== revision) throw new Error("技能操作版本无效");
    return {version: 1, revision, entries, retainedRevisions, serializedBytes: integer(record.serializedBytes, SKILL_LIMITS.retainedBytes),
        ...(lastOperation ? {lastOperation} : {})};
}

export async function readSkillCatalogueRecord(store: ProductStore): Promise<SkillCatalogue> {
    const row = await store.deviceSettings.get(SKILL_CATALOGUE_KEY);
    return row ? parseSkillCatalogue(row.value) : emptySkillCatalogue();
}

function parseComponent(raw: unknown): SkillComponent {
    const record = skillRecord(raw);
    return {path: text(record.path, SKILL_LIMITS.pathBytes), digest: skillRevision(record.digest), byteLength: integer(record.byteLength, SKILL_LIMITS.resourceBytes), ordinal: integer(record.ordinal, SKILL_LIMITS.fileCount - 1)};
}

function parseSkillManifest(raw: unknown, expectedRevision: string): SkillManifest {
    skillSerializedBytes(raw);
    const record = skillRecord(raw);
    version(record);
    const revision = skillRevision(record.revision);
    if (revision !== expectedRevision || !Array.isArray(record.resources) || record.resources.length >= SKILL_LIMITS.fileCount) throw new Error("技能版本清单无效");
    const document = parseComponent(record.document);
    if (document.path !== "SKILL.md" || document.ordinal !== 0 || document.byteLength > SKILL_LIMITS.frontmatterBytes + SKILL_LIMITS.bodyBytes + 16) throw new Error("技能正文清单无效");
    const resources = record.resources.map(parseComponent);
    const canonical = validateSkillResourcePaths(resources.map(resource => resource.path));
    if (resources.some((resource, index) => resource.ordinal !== index || resource.path !== canonical[index])) throw new Error("技能资源清单顺序无效");
    if (skillContentRevision([document, ...resources]) !== revision) throw new Error("技能版本清单已改变");
    return {version: 1, revision, metadata: parseStoredSkillMetadata(record.metadata), document, resources};
}

export async function readSkillManifestRecord(revision: string, store: ProductStore): Promise<SkillManifest> {
    skillRevision(revision);
    const row = await store.deviceSettings.get(skillManifestKey(revision));
    if (!row) throw new Error("技能版本内容缺失");
    return parseSkillManifest(row.value, revision);
}

function parseSkillRetention(raw: unknown, expectedRevision: string): SkillRetention {
    const record = skillRecord(raw);
    version(record);
    const revision = skillRevision(record.revision);
    if (revision !== expectedRevision) throw new Error("技能保留版本不匹配");
    const currentReferences = integer(record.currentReferences, SKILL_LIMITS.installedCount), runReferences = integer(record.runReferences);
    if (currentReferences + runReferences === 0) throw new Error("技能版本保留计数无效");
    return {version: 1, revision, currentReferences, runReferences, serializedBytes: integer(record.serializedBytes, SKILL_LIMITS.persistedValueBytes)};
}

export async function readSkillRetentionRecord(revision: string, store: ProductStore): Promise<SkillRetention> {
    const row = await store.deviceSettings.get(skillRetentionKey(skillRevision(revision)));
    if (!row) throw new Error("技能版本保留记录缺失");
    return parseSkillRetention(row.value, revision);
}

export function parseSkillTextRecord(raw: unknown, revision: string, path: string): SkillTextRecord {
    const record = skillRecord(raw);
    version(record);
    if (record.revision !== revision || record.path !== path || typeof record.text !== "string") throw new Error("技能文本记录无效");
    skillSerializedBytes(raw);
    return {version: 1, revision, path, text: record.text};
}
