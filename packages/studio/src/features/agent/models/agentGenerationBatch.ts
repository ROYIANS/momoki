import type {AgentGenerationJob} from './agentGeneration';
import type {GenerationSubmitArgs} from '../../video/agent/generationProfiles';
import type {GenerationResult, MediaKind} from "../../library/models/slots";
import type {ProductionTarget} from '../../video/models/production';

export const BATCH_REQUEST_LIMIT = 20;
export const BATCH_TARGET_LIMIT = 4;
export const BATCH_CONCURRENCY = 2;
type GenerationBatchStatus = 'draft' | 'ready' | 'running' | 'paused' | 'settled' | 'cancelled';
export type GenerationSnapshot = Pick<AgentGenerationJob, 'connectorId' | 'provider' | 'baseUrl' | 'model' | 'kind' | 'target' | 'baseRevision' | 'sourceRevisions' | 'parameters' | 'inputs' | 'fingerprint'>;

export interface GenerationBatch {
    version: 1;
    id: string;
    projectId: string;
    threadId: string;
    runId: string;
    sourceCallId?: string;
    originCallId: string;
    taskId?: string;
    title: string;
    revision: number;
    status: GenerationBatchStatus;
    itemIds: string[];
    confirmedItemIds: string[];
    confirmedAt?: string;
    pauseReason?: string;
    retrySourceBatchId?: string;
    /** Exact full-entity revisions proven by this batch's explicit user writes. */
    entityRevisions: Record<string, string>;
    selections: Record<string, string>;
    applications: Array<{
        itemId: string;
        jobId: string;
        targetKey: string;
        baseline: string;
        beforeRevision: string;
        afterRevision: string;
        before?: GenerationResult;
        result: GenerationResult;
        at: string
    }>;
    createdAt: string;
    updatedAt: string;
}

export interface GenerationBatchItem {
    id: string;
    batchId: string;
    projectId: string;
    threadId: string;
    order: number;
    targetKey: string;
    label: string;
    proposal: GenerationSubmitArgs;
    draft: GenerationSubmitArgs;
    included: boolean;
    state: 'draft' | 'queued' | 'claimed' | 'cancelled';
    snapshot?: GenerationSnapshot;
    jobId?: string;
    /** Freeze original target/input identity even before confirmation. */
    baseline: GenerationSnapshot;
    createdAt: string;
    updatedAt: string;
}

export function generationTargetKey(target: ProductionTarget | GenerationSubmitArgs['target']) {
    return `${target.kind}:${target.entityId}:${target.slot}`;
}

export function generationEntityKey(target: ProductionTarget) {
    return `${target.kind}:${target.entityId}`;
}

export function generationKind(target: GenerationSubmitArgs['target']): MediaKind {
    if (target.kind === 'library') return target.slot === 'video' ? 'video' : 'image';
    return target.kind === 'shot' && target.slot === 'clip' ? 'video' : 'image';
}

export function validateBatchLimits(items: Array<{ draft: GenerationSubmitArgs }>) {
    if (!items.length || items.length > BATCH_REQUEST_LIMIT) throw new Error('每批需要 1–20 份候选');
    const counts = new Map<string, number>();
    for (const item of items) {
        const key = generationTargetKey(item.draft.target);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (counts.get(key)! > BATCH_TARGET_LIMIT) throw new Error('每个目标槽位最多 4 份候选');
        if (item.draft.target.projectId !== items[0].draft.target.projectId) throw new Error('同批候选必须属于同一项目或素材库');
    }
}
