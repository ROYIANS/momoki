import { describe, it, expect } from 'vitest';
import Dexie from 'dexie';
import { db } from '@/platform/product/store';
import {browserDatabase} from '@/platform/storage/browserDatabase';
import {createBrowserProductStore} from '@/platform/storage/browser';
import {createProject, patchProjectOutput} from "@/features/projects/commands/projects";
import {deleteProject, setProjectArchived} from "@/features/projects/commands/lifecycle";
import {collectMediaIds, deleteMediaIfOrphan} from "@/features/library/commands/media";
import {releaseMaterialUse} from "@/features/library/commands/assetReuse";
import { createIpProfile, bindProjectIp, setIpArchived } from '@/features/library/commands/ipProfiles';
import { createFileMaterial, adoptMaterialInProject, promoteMaterial } from '@/features/library/commands/materials';
import { exportProjectZip, importProjectZip } from '@/app/workflows/packages/projectPackage';

const file = () => new File(['retained fixture audio'], 'intro.mp3', { type: 'audio/mpeg' });

describe('IP and material integration with legacy projects', () => {
  it('upgrades v21 with no IP/material tables without changing existing projects', async () => {
    if (!browserDatabase) throw new Error('Historical comparator requires browser storage');
    const rawDb=browserDatabase,db=createBrowserProductStore(rawDb);
    const project = await createProject('legacy v21',undefined,undefined,undefined,db);
    const added = new Set(['ipProfiles', 'projectIpLinks', 'libraryMaterials', 'materialVersions', 'materialUses', 'materialEvents', 'audioGenerationBatches', 'audioGenerationBatchItems', 'audioArrangementProposals', 'agentJobs', 'agentJobResultChunks', 'desktopMediaImports']);
    const stores = Object.fromEntries(browserDatabase!.tables.filter((table) => !added.has(table.name))
      .map((table) => [table.name, [table.schema.primKey.src, ...table.schema.indexes.map((index) => index.src)].join(',')]));
    await db.delete();
    const legacy = new Dexie(db.name);
    legacy.version(21).stores(stores);
    await legacy.open();
    await legacy.table('projects').add(project);
    legacy.close();
    await db.open();
    expect(db.verno).toBe(28);
    expect(await db.projects.get(project.id)).toEqual(project);
    for (const name of added) expect(await db.table(name).count()).toBe(0);
  });
  it('releases an unused copy but rolls back when a project still uses it', async () => {
    const project = await createProject('references');
    const material = await createFileMaterial(new File(['image'], 'test.png', { type: 'image/png' }), { kind: 'global' });
    const use = await adoptMaterialInProject(material.id, project.id);
    await patchProjectOutput(project.id, { coverMediaId: use.targetId });
    await expect(releaseMaterialUse(use.id)).rejects.toThrow('仍被');
    expect(await db.materialUses.get(use.id)).toBeDefined();
    expect((await db.media.get(use.targetId))?.libraryRetained).toBe(true);
    await patchProjectOutput(project.id, { coverMediaId: null });
    await releaseMaterialUse(use.id);
    expect(await db.materialUses.get(use.id)).toBeUndefined();
    expect(await db.media.get(use.targetId)).toBeUndefined();
    expect(await db.materialVersions.where('materialId').equals(material.id).count()).toBe(1);
  });
  it('creates project and IP association atomically, rejects archived or missing identity', async () => {
    const ip = await createIpProfile({ name: '小饭团' });
    const project = await createProject('episode', 'film', '16:9', ip.id);
    expect((await db.projectIpLinks.get(project.id))?.ipId).toBe(ip.id);
    await setIpArchived(ip.id, true);
    await expect(createProject('no partial', 'film', '16:9', ip.id)).rejects.toThrow();
    await expect(createProject('missing', 'film', '16:9', 'missing')).rejects.toThrow();
    expect(await db.projects.count()).toBe(1);
    expect(await db.episodes.count()).toBe(1);
    expect(await db.projectIpLinks.count()).toBe(1);
  });
  it('retains adopted loose media through orphan cleanup and two ZIP round trips', async () => {
    const project = await createProject('podcast assets');
    const material = await createFileMaterial(file(), { kind: 'global' });
    const use = await adoptMaterialInProject(material.id, project.id);
    expect(await collectMediaIds(project.id)).toContain(use.targetId);
    await deleteMediaIfOrphan(use.targetId);
    expect(await db.media.get(use.targetId)).toBeDefined();
    const imported = await importProjectZip(await exportProjectZip(project.id));
    const importedMedia = await db.media.where('projectId').equals(imported.id).toArray();
    expect(importedMedia).toHaveLength(1);
    expect(importedMedia[0].mimeType).toBe('audio/mpeg');
    expect(importedMedia[0].libraryRetained).toBe(true);
    expect(await db.projectIpLinks.get(imported.id)).toBeUndefined();
    expect(await db.materialUses.where('projectId').equals(imported.id).count()).toBe(0);
    await deleteMediaIfOrphan(importedMedia[0].id);
    const twice = await importProjectZip(await exportProjectZip(imported.id));
    expect(await db.media.where('projectId').equals(twice.id).count()).toBe(1);
  });
  it('archives project-owned materials and removes bindings on deletion without destroying shared snapshots', async () => {
    const ip = await createIpProfile({ name: '创作者' });
    const project = await createProject('source');
    await bindProjectIp(project.id, ip.id);
    const local = await createFileMaterial(file(), { kind: 'project', id: project.id });
    const shared = await promoteMaterial(local.id, { kind: 'ip', id: ip.id });
    await adoptMaterialInProject(shared.id, project.id);
    await setProjectArchived(project.id, true);
    expect((await db.libraryMaterials.get(local.id))?.archived).toBe(true);
    expect((await db.libraryMaterials.get(shared.id))?.archived).toBe(false);
    await deleteProject(project.id);
    expect(await db.projectIpLinks.get(project.id)).toBeUndefined();
    expect(await db.materialUses.where('projectId').equals(project.id).count()).toBe(0);
    expect(await db.materialVersions.where('materialId').equals(shared.id).count()).toBe(1);
    expect(await db.ipProfiles.get(ip.id)).toBeDefined();
  });
});
