import {SKILL_LIMITS, splitSkillDocument, validateSkillMetadata, validateSkillResourcePaths} from "@momoki/agent-core";
import {isAlias, isMap, isPair, isScalar, isSeq, parseDocument} from "yaml";
import {sha256Bytes, Sha256} from "../../../../platform/media/sha256";
import type {SkillComponent, SkillImportCandidate, SkillImportExclusions, SkillImportFile, SkillTextRecord} from "../models/installedSkill";

const encoder = new TextEncoder();
const EXCLUSION_PREVIEW_COUNT = 20;
const YAML_MAX_DEPTH = 4;

export function skillSerializedBytes(value: unknown): number {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("技能内容无法序列化");
    const size = encoder.encode(json).byteLength;
    if (size > SKILL_LIMITS.persistedValueBytes) throw new Error("技能内容超过单条存储上限");
    return size;
}

function decodeUtf8(bytes: Uint8Array): string {
    // ignoreBOM=true preserves the BOM as content, so the exact original bytes hash.
    const text = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes);
    if (text.includes("\0")) throw new Error("技能只支持 UTF-8 文本");
    return text;
}

/** Inspect the YAML AST before conversion; aliases/tags never reach toJS. */
function validateYamlNode(node: unknown, depth = 0): void {
    if (depth > YAML_MAX_DEPTH) throw new Error("技能元数据层级过深");
    if (node === null) return;
    if (isAlias(node)) throw new Error("技能元数据不支持 YAML 别名");
    if (isPair(node)) {
        validateYamlNode(node.key, depth);
        validateYamlNode(node.value, depth + 1);
        return;
    }
    if (isMap(node) || isSeq(node)) {
        if (node.tag) throw new Error("技能元数据不支持显式 YAML 标签");
        for (const item of node.items) validateYamlNode(item, depth + 1);
        return;
    }
    if (!isScalar(node) || node.tag || (node.value !== null && typeof node.value !== "string" && typeof node.value !== "number" && typeof node.value !== "boolean")) {
        throw new Error("技能元数据不支持此 YAML 值");
    }
}

export function decodeSkillFrontmatter(frontmatter: string): unknown {
    if (encoder.encode(frontmatter).byteLength > SKILL_LIMITS.frontmatterBytes) throw new Error("技能元数据过大");
    const document = parseDocument(frontmatter, {schema: "failsafe", uniqueKeys: true, strict: true, prettyErrors: false});
    if (document.errors.length || document.warnings.length) throw new Error("技能元数据 YAML 无效");
    validateYamlNode(document.contents);
    const decoded: unknown = document.toJS({maxAliasCount: 0, mapAsMap: false});
    return decoded;
}

export function validateSkillImportPath(path: string): void {
    const segments = path.split("/");
    if (!path || encoder.encode(path).byteLength > SKILL_LIMITS.pathBytes || segments.length > SKILL_LIMITS.pathDepth
        || /[\\:<>"|?*\p{Cc}\p{Cf}]/u.test(path)
        || segments.some(part => !part || part === "." || part === ".." || /[ .]$/u.test(part)
            || encoder.encode(part).byteLength > SKILL_LIMITS.pathSegmentBytes || /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(part))) {
        throw new Error("技能文件路径无效");
    }
}

export function isSupportedSkillResource(path: string, nestedRoots: readonly string[]): boolean {
    if (path.split("/").some(segment => segment.startsWith(".")) || nestedRoots.some(root => path.startsWith(root))) return false;
    if (path === "LICENSE" || path === "LICENSE.txt") return true;
    return /^(?:references|assets)\/.+\.(?:md|txt|json|yaml|yml|csv)$/iu.test(path) && !path.toLowerCase().endsWith("/skill.md");
}

function component(path: string, text: string, ordinal: number): SkillComponent {
    const bytes = encoder.encode(text);
    return {path, digest: sha256Bytes(bytes), byteLength: bytes.byteLength, ordinal};
}

export function skillContentRevision(components: readonly SkillComponent[]): string {
    const hash = new Sha256().update(encoder.encode("momoki-skill-v1\n"));
    for (const entry of [...components].sort((left, right) => left.path < right.path ? -1 : Number(left.path > right.path))) {
        // Length+digest framing preserves exact byte identity without retaining another copy.
        hash.update(encoder.encode(JSON.stringify([entry.path, entry.byteLength, entry.digest]) + "\n"));
    }
    return hash.digest();
}

function eligibleImportFiles(files: readonly SkillImportFile[], priorExclusions?: SkillImportExclusions): readonly SkillImportFile[] {
    if (files.length > SKILL_LIMITS.directoryEntries) throw new Error("技能目录条目过多");
    if (priorExclusions && (!Number.isSafeInteger(priorExclusions.count) || priorExclusions.count < priorExclusions.paths.length
        || priorExclusions.paths.length > EXCLUSION_PREVIEW_COUNT)) throw new Error("技能排除列表无效");
    const seen = new Set<string>();
    for (const file of files) {
        validateSkillImportPath(file.path);
        const folded = file.path.normalize("NFC").toUpperCase().toLowerCase();
        if (seen.has(folded)) throw new Error("技能目录包含重名文件");
        seen.add(folded);
    }
    const nestedRoots = files.filter(file => file.path !== "SKILL.md" && file.path.endsWith("/SKILL.md")).map(file => file.path.slice(0, -8));
    const eligible = files.filter(file => file.path === "SKILL.md" || isSupportedSkillResource(file.path, nestedRoots));
    if (eligible.length > SKILL_LIMITS.fileCount) throw new Error("技能文本文件过多");
    let totalBytes = 0;
    for (const file of eligible) {
        totalBytes += file.bytes.byteLength;
        const limit = file.path === "SKILL.md" ? SKILL_LIMITS.frontmatterBytes + SKILL_LIMITS.bodyBytes + 16 : SKILL_LIMITS.resourceBytes;
        if (file.bytes.byteLength > limit) throw new Error("技能文本文件过大");
    }
    if (totalBytes > SKILL_LIMITS.packageBytes) throw new Error("技能文本总大小超过上限");
    return eligible;
}

/** Host input is copied/decoded once; source folders are never used after review. */
export function prepareSkillImport(directoryName: string, files: readonly SkillImportFile[], priorExclusions?: SkillImportExclusions): SkillImportCandidate {
    const eligible = eligibleImportFiles(files, priorExclusions);
    const root = eligible.find(file => file.path === "SKILL.md");
    if (!root) throw new Error("请选择根目录包含 SKILL.md 的技能文件夹");
    const documentText = decodeUtf8(root.bytes);
    const {frontmatter} = splitSkillDocument(documentText);
    const metadata = validateSkillMetadata(decodeSkillFrontmatter(frontmatter), directoryName);
    const paths = validateSkillResourcePaths(eligible.filter(file => file.path !== "SKILL.md").map(file => file.path));
    const resources = paths.map(path => {
        const file = eligible.find(entry => entry.path === path);
        if (!file) throw new Error("技能文件缺失");
        return {path, text: decodeUtf8(file.bytes)};
    });
    const documentComponent = component("SKILL.md", documentText, 0);
    const resourceComponents = resources.map((resource, ordinal) => component(resource.path, resource.text, ordinal));
    const revision = skillContentRevision([documentComponent, ...resourceComponents]);
    const document: SkillTextRecord = {version: 1, revision, path: "SKILL.md", text: documentText};
    const records: SkillTextRecord[] = resources.map(resource => ({version: 1, revision, ...resource}));
    const manifest = {version: 1 as const, revision, metadata, document: documentComponent, resources: resourceComponents};
    const serializedBytes = skillSerializedBytes(manifest) + skillSerializedBytes(document) + records.reduce((sum, record) => sum + skillSerializedBytes(record), 0);
    if (serializedBytes > SKILL_LIMITS.persistedValueBytes) throw new Error("技能版本转义后的内容超过存储上限");
    const excluded = files.filter(file => !eligible.includes(file)).map(file => file.path);
    const count = excluded.length + (priorExclusions?.count ?? 0);
    if (!Number.isSafeInteger(count) || count < 0 || count > SKILL_LIMITS.directoryEntries) throw new Error("技能排除列表无效");
    const exclusionPaths = [...(priorExclusions?.paths ?? []), ...excluded].slice(0, EXCLUSION_PREVIEW_COUNT);
    for (const path of exclusionPaths) validateSkillImportPath(path);
    return {version: 1, directoryName, manifest, document, resources: records,
        exclusions: {count, paths: exclusionPaths}, serializedBytes};
}

/** Rebuild from owned text before publication, rather than trusting a mutable preview object. */
export function verifySkillCandidate(candidate: SkillImportCandidate): SkillImportCandidate {
    const rebuilt = prepareSkillImport(candidate.directoryName,
        [candidate.document, ...candidate.resources].map(record => ({path: record.path, bytes: encoder.encode(record.text)})), candidate.exclusions);
    if (JSON.stringify(rebuilt) !== JSON.stringify(candidate)) throw new Error("技能预览内容已改变，请重新选择文件夹");
    return rebuilt;
}
