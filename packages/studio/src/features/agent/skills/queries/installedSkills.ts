import {readSkillTextRange, splitSkillDocument, validateSkillMetadata, validateSkillResourcePath} from "@momoki/agent-core";
import {db as productDb} from "../../../../platform/product/store";
import {sha256Bytes} from "../../../../platform/media/sha256";
import type {ProductStore} from "../../../../platform/storage/types";
import type {InstalledSkillDescriptor, SkillTextRange} from "@momoki/agent-core";
import type {SkillCatalogue, SkillComponent, SkillManifest} from "../models/installedSkill";
import {parseSkillTextRecord, readSkillCatalogueRecord, readSkillManifestRecord, skillBodyKey, skillResourceKey} from "../runtime/records";
import {decodeSkillFrontmatter} from "../runtime/package";

/** Metadata only: does not read any manifest, body or resource row. */
export async function getInstalledSkillCatalogue(store: ProductStore = productDb): Promise<SkillCatalogue> {
    return store.transaction("r", ["deviceSettings"], tx => readSkillCatalogueRecord(tx));
}

async function verifiedText(revision: string, component: SkillComponent, key: string, store: ProductStore): Promise<string> {
    const row = await store.deviceSettings.get(key);
    if (!row) throw new Error("技能文本内容缺失");
    const record = parseSkillTextRecord(row.value, revision, component.path);
    const bytes = new TextEncoder().encode(record.text);
    if (bytes.byteLength !== component.byteLength || sha256Bytes(bytes) !== component.digest) throw new Error("技能文本内容已损坏");
    return record.text;
}

function assertDescriptor(manifest: SkillManifest, descriptor: InstalledSkillDescriptor): void {
    if (JSON.stringify(manifest.metadata) !== JSON.stringify(descriptor.metadata)) throw new Error("技能记录与执行快照不一致");
}

export async function getInstalledSkillManifest(descriptor: InstalledSkillDescriptor, store: ProductStore = productDb): Promise<SkillManifest> {
    return store.transaction("r", ["deviceSettings"], async tx => {
        const manifest = await readSkillManifestRecord(descriptor.revision, tx);
        assertDescriptor(manifest, descriptor);
        return manifest;
    });
}

/** Reads only this captured manifest and root document; resource rows stay cold. */
export async function loadInstalledSkill(descriptor: InstalledSkillDescriptor, store: ProductStore = productDb): Promise<{manifest: SkillManifest; document: string; body: string}> {
    return store.transaction("r", ["deviceSettings"], async tx => {
        const manifest = await readSkillManifestRecord(descriptor.revision, tx);
        assertDescriptor(manifest, descriptor);
        const document = await verifiedText(descriptor.revision, manifest.document, skillBodyKey(descriptor.revision), tx);
        const {frontmatter, body} = splitSkillDocument(document);
        if (JSON.stringify(validateSkillMetadata(decodeSkillFrontmatter(frontmatter))) !== JSON.stringify(manifest.metadata)) throw new Error("技能正文元数据与版本清单不一致");
        return {manifest, document, body};
    });
}

/** The caller owns run membership/prior-load checks; this query never opens a path. */
export async function readInstalledSkillResource(descriptor: InstalledSkillDescriptor, path: string, offset?: number, limit?: number, store: ProductStore = productDb): Promise<SkillTextRange> {
    validateSkillResourcePath(path);
    return store.transaction("r", ["deviceSettings"], async tx => {
        const manifest = await readSkillManifestRecord(descriptor.revision, tx);
        assertDescriptor(manifest, descriptor);
        const resource = manifest.resources.find(entry => entry.path === path);
        if (!resource) throw new Error("技能资料不在此版本清单中");
        const text = await verifiedText(descriptor.revision, resource, skillResourceKey(descriptor.revision, resource.ordinal), tx);
        return readSkillTextRange(text, offset, limit);
    });
}
