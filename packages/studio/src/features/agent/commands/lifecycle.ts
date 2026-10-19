import {prepareThreadActivityKey} from "./threadActivity";
import {nowIso} from "../../../platform/identity";
import type {ProductStore} from "../../../platform/storage/types";
import type {Id} from "../../../platform/identity";
import {db as productDb} from "../../../platform/product/store";
import {PRODUCTION_TABLES} from "../../../platform/product/scopes";
import {deleteMediaIfOrphans} from "../../library/commands/media";
import {releaseInstalledSkills} from "../skills/commands/retention";

/** Removes a thread created for a send that never produced any message or run (failure-then-restore). */
export async function discardEmptyChatThread(id: Id, store?: ProductStore): Promise<boolean> {
    const db = store ?? productDb;
    if (await db.chatMessages.where("threadId").equals(id).count() > 0 || await db.agentRuns.where("threadId").equals(id).count() > 0) return false;
    await deleteChatThread(id, db);
    return true;
}

export async function deleteChatThread(id: Id, store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    const activity = prepareThreadActivityKey(id);
    await db.transaction("rw", [...PRODUCTION_TABLES, db.deviceSettings, db.chatThreads, db.chatMessages, db.agentRuns, db.agentToolCalls, db.agentJobs, db.agentJobResultChunks, db.agentTasks, db.contextCompactions, db.agentTaskRecords, db.agentTaskRecordVersions, db.agentTaskWrapups, db.agentTaskWrapupVersions, db.agentPendingInputs], async (db) => {
        await db.agentPendingInputs.where("threadId").equals(id).delete();
        for (const job of await db.agentJobs.where("threadId").equals(id).toArray()) await db.agentJobResultChunks.where("jobId").equals(job.id).delete();
        await db.agentJobs.where("threadId").equals(id).delete();
        const jobs = await db.agentGenerationJobs.where("threadId").equals(id).toArray();
        const batches = await db.agentGenerationBatches.where("threadId").equals(id).toArray();
        const items = await db.agentGenerationBatchItems.where("threadId").equals(id).toArray();
        const jobMedia = new Set([...jobs.flatMap(job => [...job.inputs.map(input => input.mediaId), ...(job.result ? [job.result.mediaId] : [])]), ...items.flatMap(item => item.draft.inputs.map(input => input.mediaId)), ...batches.flatMap(batch => batch.applications.flatMap(a => [a.result.mediaId, ...(a.before ? [a.before.mediaId] : [])]))]);
        await db.agentGenerationBatches.where("threadId").equals(id).delete();
        await db.agentGenerationBatchItems.where("threadId").equals(id).delete();
        await db.agentGenerationJobs.where("threadId").equals(id).delete();
        // Audio sources survive chat deletion as dormant project history, without live approval or dispatch.
        const audioBatches = await db.audioGenerationBatches.where("owner.threadId").equals(id).toArray();
        const audioBatchIds = new Set(audioBatches.map(batch => batch.id));
        for (const batch of audioBatches) {
            await db.audioGenerationBatches.update(batch.id, {
                dormant: true,
                status: "cancelled",
                confirmedAt: undefined,
                confirmedItemIds: [],
                sourceCallId: undefined,
                revision: batch.revision + 1,
                updatedAt: nowIso()
            });
            await db.audioGenerationBatchItems.where("batchId").equals(batch.id).filter(item => !item.jobId).modify({state: "cancelled"});
        }
        await db.audioGenerationJobs.filter(job => job.source.kind === "batch" && audioBatchIds.has(job.source.batchId)).modify({dormant: true});
        await db.contextCompactions.where("threadId").equals(id).delete();
        for (const task of await db.agentTasks.where("threadId").equals(id).toArray()) {
            await db.agentTaskWrapups.where("taskId").equals(task.id).delete();
            await db.agentTaskWrapupVersions.where("taskId").equals(task.id).delete();
            await db.agentTaskRecords.where("taskId").equals(task.id).delete();
            await db.agentTaskRecordVersions.where("taskId").equals(task.id).delete();
        }
        await db.agentTasks.where("threadId").equals(id).delete();
        await db.agentToolCalls.where("threadId").equals(id).delete();
        const deletedRuns = await db.agentRuns.where("threadId").equals(id).toArray();
        await releaseInstalledSkills(db, deletedRuns.flatMap(run => run.installedSkills ? [run.installedSkills] : []));
        await db.agentRuns.where("threadId").equals(id).delete();
        await db.chatMessages.where("threadId").equals(id).delete();
        await db.deviceSettings.delete(activity.key);
        await db.chatThreads.delete(id);
        await deleteMediaIfOrphans([...jobMedia], db);
    });
}
