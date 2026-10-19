import type {ProductStore} from "../../../platform/storage/types";
import {type Id, createId, nowIso} from "../../../platform/identity";
import {db as productDb} from "../../../platform/product/store";
import {AUDIO_TABLES} from "../../../platform/product/scopes";
import {prepareThreadActivityKey, clearAgentReportActivity} from "../../agent/commands/threadActivity";
import type {ThreadActivityIdentity} from "../../agent/models/threadActivity";

export type ProjectReportDeletion = Readonly<{projectId: string; jobs: readonly Readonly<{jobId: string; threadId: string; activity: ThreadActivityIdentity}>[]}>;
/** The initiating UI/tool command prepares identities before its aggregate transaction. */
export async function prepareProjectReportDeletion(projectId: string, store?: ProductStore): Promise<ProjectReportDeletion> {
    const db = store ?? productDb;
    if ("transactionId" in db) throw new Error("请在项目删除事务开始前准备报告归属");
    const jobs = await db.agentJobs.where("projectId").equals(projectId).toArray();
    return Object.freeze({projectId, jobs: Object.freeze(jobs.map(job => Object.freeze({jobId: job.id, threadId: job.threadId, activity: prepareThreadActivityKey(job.threadId)})))});
}

/** Archiving hides a project and its owned library snapshots without altering shared sources. */
export async function setProjectArchived(id: Id, archived: boolean, store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    await db.transaction("rw", [db.projects, db.libraryMaterials, db.materialEvents], async (db) => {
        const project = await db.projects.get(id);
        if (!project) throw new Error("项目不存在");
        await db.projects.update(id, {archivedAt: archived ? nowIso() : undefined, updatedAt: nowIso()});
        // Restoring a project leaves individually archived materials for explicit review.
        if (archived) {
            const rows = await db.libraryMaterials.toArray();
            for (const row of rows) if (row.scope.kind === "project" && row.scope.id === id && !row.archived) {
                await db.libraryMaterials.update(row.id, {archived: true, updatedAt: nowIso()});
                await db.materialEvents.add({
                    id: createId("mev"),
                    materialId: row.id,
                    action: "archive",
                    detail: "随项目归档",
                    createdAt: nowIso()
                });
            }
        }
    });
}

export async function deleteProject(id: Id, store?: ProductStore, preparedReports?: ProjectReportDeletion): Promise<void> {
    const db = store ?? productDb;
    const reports = preparedReports ?? await prepareProjectReportDeletion(id, db);
    if (reports.projectId !== id) throw new Error("项目报告删除归属已变化");
    await db.transaction(
        "rw",
        [
            db.projects,
            ...AUDIO_TABLES,
            db.projectIpLinks, db.materialUses, db.libraryMaterials, db.materialEvents,
            db.projectReferences,
            db.referenceChunks,
            db.projectMemories,
            db.projectMemoryVersions,
            db.characters,
            db.scenes,
            db.props,
            db.styles,
            db.episodes,
            db.shots,
            db.media,
            db.productionProposals,
            db.agentGenerationJobs, db.agentGenerationBatches, db.agentGenerationBatchItems,
            db.agentJobs, db.agentJobResultChunks,
            db.deviceSettings,
            db.desktopMediaImports,
            db.agentPendingInputs,
        ],
        async (db) => {
            const jobs = await db.agentJobs.where("projectId").equals(id).toArray();
            const expected = new Map(reports.jobs.map(job => [job.jobId, job]));
            if (jobs.length !== expected.size || jobs.some(job => expected.get(job.id)?.threadId !== job.threadId)) throw new Error("项目报告范围已变化，请重试删除");
            for (const job of jobs) {
                const prepared = expected.get(job.id)!;
                if (prepared.activity.threadId !== job.threadId) throw new Error("项目报告删除归属已变化");
                await clearAgentReportActivity(prepared.activity, job.id, db);
            }
            await db.desktopMediaImports.where("projectId").equals(id).delete();
            await db.agentPendingInputs.where("projectId").equals(id).filter(item => item.source === "system").delete();
            for (const job of jobs) await db.agentJobResultChunks.where("jobId").equals(job.id).delete();
            await db.agentJobs.where("projectId").equals(id).delete();
            for (const table of AUDIO_TABLES) await db.table(table.name).where("projectId").equals(id).delete();
            await db.projectIpLinks.delete(id);
            await db.materialUses.where("projectId").equals(id).delete();
            for (const row of await db.libraryMaterials.toArray()) {
                if (row.scope.kind === "project" && row.scope.id === id) {
                    await db.libraryMaterials.update(row.id, {archived: true, updatedAt: nowIso()});
                    await db.materialEvents.add({
                        id: createId("mev"),
                        materialId: row.id,
                        action: "archive",
                        detail: "来源项目已删除，保留素材快照",
                        createdAt: nowIso()
                    });
                }
            }
            await db.projectReferences.where("projectId").equals(id).delete();
            await db.referenceChunks.where("projectId").equals(id).delete();
            await db.projectMemories.where("projectId").equals(id).delete();
            await db.projectMemoryVersions.where("projectId").equals(id).delete();
            await db.agentGenerationBatches.where("projectId").equals(id).delete();
            await db.agentGenerationBatchItems.where("projectId").equals(id).delete();
            await db.agentGenerationJobs.where("projectId").equals(id).delete();
            await db.productionProposals.where("projectId").equals(id).delete();
            await db.characters.where("projectId").equals(id).delete();
            await db.scenes.where("projectId").equals(id).delete();
            await db.props.where("projectId").equals(id).delete();
            await db.styles.where("projectId").equals(id).delete();
            await db.episodes.where("projectId").equals(id).delete();
            await db.shots.where("projectId").equals(id).delete();
            await db.media.where("projectId").equals(id).delete();
            await db.projects.delete(id);
        },
    );
}
