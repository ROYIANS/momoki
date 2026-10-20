import type {ProductStore, StoreTable} from "../../../platform/storage/types";
import {readBinaryBlob} from "../../../platform/storage/binary";
import {binaryByteLength} from "../../../platform/media/binaryTypes";
import {z} from 'zod';
import {db as productDb} from '../../../platform/product/store';
import {getReferenceSource} from '../commands/references';
import {CHARACTER_SLOTS, type GenerationSlot, PROP_SLOTS, SCENE_SLOTS, STYLE_SLOTS} from "../../library/models/slots";
import {episodeLabel} from "../../video/models/episodes";
import {type MediaRecord} from "../../library/models/media";
import {STUDIO_LIBRARY_ID} from "../../library/models/ownership";
import {parseGenerationSlot, parseShotPictureSlots} from '../../library/models/slot';
import type {DiscoveredImage, ImageDiscoveryResult, ImageEntityKind, ImageSourceLocator} from '../models/imageDiscovery';
import type {AgentReferenceInput} from '../models/referenceInput';
import type {AgentToolContext} from '../../agent/runtime/tools';
import {frozenProjectScope} from '../../agent/runtime/projectScope';
import {targetRevision} from "../../../platform/data/revision";

const text = z.string().trim().min(1).max(200);
export const imageDiscoverySchema = z.object({
    projectQuery: text.optional(),
    projectId: text.optional(),
    episodeQuery: text.optional(),
    entityKind: z.enum(['shot', 'character', 'scene', 'prop', 'style']).optional(),
    query: z.string().trim().max(500).optional(),
    slot: text.optional(),
    source: z.enum(['current', 'reference', 'candidate']).default('current'),
    offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(20).default(10)
}).strict();
const tables = {shot: 'shots', character: 'characters', scene: 'scenes', prop: 'props', style: 'styles'} as const;
const catalogs = {
    shot: [{id: 'firstFrame', label: '首帧'}, {id: 'lastFrame', label: '尾帧'}, {
        id: 'clip',
        label: '视频参考'
    }], character: CHARACTER_SLOTS, scene: SCENE_SLOTS, prop: PROP_SLOTS, style: STYLE_SLOTS
};
const normalized = (value: string) => value.trim().toLocaleLowerCase();
const matches = (value: string, query: string) => normalized(value).includes(normalized(query));
const label = (value: string | undefined) => (value ?? '').slice(0, 120);

interface Entity {
    id: string;
    projectId: string;
    episodeId?: string;
    name?: string;
    shotNumber?: string;
    content?: string;
    order?: number;
    slots?: Record<string, GenerationSlot>;

    [key: string]: unknown
}

function slots(kind: ImageEntityKind, entity: Entity): Record<string, GenerationSlot> {
    return kind === 'shot' ? parseShotPictureSlots(entity) : Object.fromEntries(catalogs[kind].map(({id}) => [id, parseGenerationSlot(entity.slots?.[id])]));
}

function target(projectId: string, kind: ImageEntityKind, entity: Entity) {
    const enc = encodeURIComponent;
    return {
        label: label(entity.name ?? `镜头 ${entity.shotNumber}`),
        href: kind === 'shot' ? `/p/${enc(projectId)}/e/${enc(entity.episodeId!)}/shots?shot=${enc(entity.id)}` : `/p/${enc(projectId)}/assets/${tables[kind]}/${enc(entity.id)}`
    };
}

async function sourceState(projectId: string, locator: ImageSourceLocator, store?: ProductStore) {
    const db = store ?? productDb;
    let identity: unknown, mediaId: string | undefined, currentlyApplied: boolean | undefined;
    if (locator.kind === 'slot') {
        const entity = await (db.table(tables[locator.entityKind]) as unknown as StoreTable<Entity>).get(locator.entityId);
        if (!entity || entity.projectId !== projectId) throw new Error('图片所属目标已删除，请重新查找');
        if (entity.episodeId) {
            const episode = await db.episodes.get(entity.episodeId);
            if (!episode || episode.projectId !== projectId) throw new Error('图片分集已不存在');
        }
        const slot = slots(locator.entityKind, entity)[locator.slot];
        if (!slot) throw new Error('图片槽位已不存在');
        mediaId = locator.source === 'current' ? slot.result?.mediaId : slot.referenceImageIds.includes(locator.mediaId ?? '') ? locator.mediaId : undefined;
        identity = {
            entityId: entity.id,
            episodeId: entity.episodeId,
            label: entity.name ?? entity.shotNumber,
            slot: locator.slot,
            source: locator.source,
            association: locator.source === 'current' ? slot.result : slot.referenceImageIds
        };
    } else if (locator.kind === 'reference') {
        const reference = await db.projectReferences.get(locator.referenceId);
        if (!reference || reference.projectId !== projectId || reference.kind !== 'image') throw new Error('图片参考资料已不存在');
        mediaId = reference.mediaId;
        identity = {
            id: reference.id,
            revision: reference.revision,
            status: reference.status,
            digest: reference.digest,
            mediaId
        };
    } else {
        const job = await db.agentGenerationJobs.get(locator.jobId);
        if (!job || job.projectId !== projectId || job.kind !== 'image' || !['downloaded', 'applied', 'conflict'].includes(job.status)) throw new Error('候选图片已不可用');
        mediaId = job.result?.mediaId;
        if (job.target.kind === 'library') currentlyApplied = job.status === 'applied';
        else {
            const owner = await (db.table(tables[job.target.kind]) as unknown as StoreTable<Entity>).get(job.target.entityId);
            if (!owner || owner.projectId !== projectId || job.target.kind === 'shot' && owner.episodeId !== job.target.episodeId) throw new Error('候选目标已不存在');
            currentlyApplied = !!mediaId && slots(job.target.kind, owner)[job.target.slot ?? 'firstFrame']?.result?.mediaId === mediaId;
        }
        identity = {id: job.id, result: job.result, target: job.target, currentlyApplied};
    }
    const media = mediaId ? await db.media.get(mediaId) : undefined;
    const references = mediaId ? (await db.projectReferences.where('mediaId').equals(mediaId).toArray()).filter((row) => row.projectId === projectId) : [];
    const active = references.filter((row) => row.status === 'ready' || row.status === 'partial').sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))[0];
    const attachment = locator.kind === 'reference' ? references.find((row) => row.id === locator.referenceId) : active;
    let unavailableReason = !mediaId ? '当前目标没有此类图片' : !media || media.projectId !== projectId ? '图片文件已移除或归属不匹配' : !['image/png', 'image/jpeg', 'image/webp'].includes(media.mimeType) ? '仅支持 PNG、JPEG 或 WebP 图片' : binaryByteLength(media.blob) <= 0 || binaryByteLength(media.blob) > 10 * 1024 * 1024 ? '图片为空或超过 10 MiB' : undefined;
    if (attachment && !['ready', 'partial'].includes(attachment.status) || !attachment && references.length) unavailableReason = '图片参考资料已撤下或尚未准备完成';
    const reference = attachment ? {referenceId: attachment.id, revision: attachment.revision} : undefined;
    const revision = targetRevision({
        identity,
        media: media ? {
            id: media.id,
            projectId: media.projectId,
            mimeType: media.mimeType,
            size: binaryByteLength(media.blob),
            filename: media.filename
        } : null,
        reference,
        referenceState: attachment?.status
    });
    return {media, mediaId, revision, reference, unavailableReason, currentlyApplied};
}

export async function discoverProjectImages(raw: unknown, context: AgentToolContext, store?: ProductStore): Promise<ImageDiscoveryResult> {
    const db = store ?? context.store ?? productDb;
    context.signal.throwIfAborted();
    const args = imageDiscoverySchema.parse(raw), bound = await frozenProjectScope(context, db);
    if (!bound && !args.projectId && !args.projectQuery) throw new Error('请提供用户指定的项目名称或已确认的项目 ID');
    if (bound && args.projectId && bound !== args.projectId) throw new Error('此对话只能查看绑定项目的图片');
    let projects = bound ? [await db.projects.get(bound)] : args.projectId ? [await db.projects.get(args.projectId)] : await db.projects.toArray();
    projects = projects.filter((item) => !!item && item.id !== STUDIO_LIBRARY_ID);
    if (args.projectQuery) {
        const exact = projects.filter((row) => normalized(row!.name) === normalized(args.projectQuery!));
        projects = exact.length ? exact : projects.filter((row) => matches(row!.name, args.projectQuery!));
    }
    projects.sort((a, b) => a!.name.localeCompare(b!.name) || a!.id.localeCompare(b!.id));
    const base = {
        discoveryCallId: context.callId,
        projects: projects.slice(0, 20).map((row) => ({id: row!.id, name: label(row!.name)})),
        projectCount: projects.length,
        candidates: [] as DiscoveredImage[],
        total: 0,
        offset: args.offset,
        hasMore: false
    };
    if (projects.length !== 1) return {
        ...base,
        status: projects.length ? 'ambiguous_project' : 'not_found',
        note: projects.length ? '多个项目匹配，请确认项目后重新查找；此结果不授予图片读取。' : '未找到匹配项目。'
    };
    const project = projects[0]!;
    const episodes = (await db.episodes.where('projectId').equals(project.id).toArray()).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const exactEpisodes = args.episodeQuery ? episodes.filter((row) => row.id === args.episodeQuery || normalized(episodeLabel(row)) === normalized(args.episodeQuery!) || normalized(row.title) === normalized(args.episodeQuery!)) : episodes;
    const selectedEpisodes = exactEpisodes.length ? exactEpisodes : episodes.filter((row) => matches(episodeLabel(row), args.episodeQuery!));
    const episodeMap = new Map(selectedEpisodes.map((row) => [row.id, row]));
    const rows: Array<Omit<DiscoveredImage, 'id' | 'revision' | 'available' | 'mediaId' | 'mimeType'>> = [];
    const kinds: ImageEntityKind[] = args.entityKind ? [args.entityKind] : ['shot', 'character', 'scene', 'prop', 'style'];
    const jobs = args.source === 'candidate' ? await db.agentGenerationJobs.where('projectId').equals(project.id).toArray() : [];
    for (const kind of kinds) {
        let entities = await (db.table(tables[kind]) as unknown as StoreTable<Entity>).where('projectId').equals(project.id).toArray();
        if (kind === 'shot') entities = entities.filter((row) => episodeMap.has(row.episodeId!));
        else if (args.episodeQuery) continue;
        if (args.query) {
            const exact = entities.filter((row) => row.id === args.query || normalized(String(row.shotNumber ?? row.name)) === normalized(args.query!));
            entities = exact.length ? exact : entities.filter((row) => matches(`${row.name ?? ''} ${row.shotNumber ?? ''} ${row.content ?? ''}`, args.query!));
        }
        entities.sort((a, b) => (episodeMap.get(a.episodeId!)?.order ?? 0) - (episodeMap.get(b.episodeId!)?.order ?? 0) || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
        for (const entity of entities) {
            for (const entry of catalogs[kind].filter((entry) => (!args.slot || entry.id === args.slot || entry.label === args.slot) && (entry.id !== 'clip' || args.source === 'reference'))) {
                const episode = episodeMap.get(entity.episodeId!);
                const common = {
                    projectId: project.id,
                    projectName: label(project.name),
                    episodeId: entity.episodeId,
                    episodeTitle: episode ? episodeLabel(episode).slice(0, 120) : undefined,
                    entityKind: kind,
                    entityId: entity.id,
                    entityLabel: label(kind === 'shot' ? `镜头 ${entity.shotNumber}` : entity.name),
                    slot: entry.id,
                    slotLabel: entry.label,
                    source: args.source,
                    target: target(project.id, kind, entity)
                };
                if (args.source === 'candidate') {
                    for (const job of jobs.filter((job) => job.target.kind === kind && job.target.entityId === entity.id && (job.target.slot ?? 'firstFrame') === entry.id && job.kind === 'image' && ['downloaded', 'applied', 'conflict'].includes(job.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) rows.push({
                        ...common,
                        locator: {kind: 'job', jobId: job.id}
                    });
                } else if (args.source === 'reference') {
                    for (const mediaId of slots(kind, entity)[entry.id].referenceImageIds) rows.push({
                        ...common,
                        locator: {
                            kind: 'slot',
                            entityKind: kind,
                            entityId: entity.id,
                            slot: entry.id,
                            source: 'reference',
                            mediaId
                        }
                    });
                } else rows.push({
                    ...common,
                    locator: {kind: 'slot', entityKind: kind, entityId: entity.id, slot: entry.id, source: 'current'}
                });
            }
        }
    }
    if (args.source === 'reference' && !args.entityKind && !args.episodeQuery && !args.slot) {
        for (const reference of (await db.projectReferences.where('projectId').equals(project.id).toArray()).filter((row) => row.kind === 'image' && (!args.query || matches(row.filename, args.query))).sort((a, b) => a.id.localeCompare(b.id))) rows.push({
            projectId: project.id,
            projectName: label(project.name),
            entityKind: 'reference',
            entityId: reference.id,
            entityLabel: label(reference.filename),
            slot: 'reference',
            slotLabel: '资料库图片',
            source: 'reference',
            locator: {kind: 'reference', referenceId: reference.id},
            target: {label: label(reference.filename), href: `/p/${encodeURIComponent(project.id)}`}
        });
    }
    const candidates: DiscoveredImage[] = [];
    for (const row of rows.slice(args.offset, args.offset + args.limit)) {
        const state = await sourceState(project.id, row.locator, db);
        candidates.push({
            ...row,
            id: targetRevision({projectId: project.id, locator: row.locator}),
            revision: state.revision,
            mediaId: state.mediaId,
            mimeType: state.media?.mimeType,
            available: !state.unavailableReason,
            unavailableReason: state.unavailableReason, ...(state.currentlyApplied !== undefined ? {currentlyApplied: state.currentlyApplied} : {})
        });
    }
    context.signal.throwIfAborted();
    await frozenProjectScope(context, db);
    const result: ImageDiscoveryResult = {
        ...base,
        status: 'resolved',
        candidates,
        total: rows.length,
        hasMore: args.offset + candidates.length < rows.length,
        note: '仅查找图片身份，尚未读取像素。不同分集、槽位和候选保持独立；有歧义时请确认，比较请求可明确选择多张。current 仅表示当前槽位结果，不用参考图或旧候选代替缺失结果。'
    };
    while (JSON.stringify(result).length > 60000 && candidates.length) candidates.pop();
    result.hasMore = args.offset + candidates.length < rows.length;
    return result;
}

/** Resolve a grant only from a completed discovery ledger belonging to this run. */
export async function resolveDiscoveredImage(runId: string, discoveryCallId: string, candidateId: string, store?: ProductStore) {
    const db = store ?? productDb;
    const run = await db.agentRuns.get(runId), call = await db.agentToolCalls.get(discoveryCallId);
    const thread = run && await db.chatThreads.get(run.threadId);
    if (!run || !thread || run.projectId !== thread.projectId || !call || call.runId !== runId || call.threadId !== run.threadId || call.name !== 'discover_project_images' || call.status !== 'completed' || !call.result) throw new Error('图片查找来源无效，请在当前执行重新查找');
    const result = JSON.parse(call.result) as ImageDiscoveryResult;
    const candidate = result.discoveryCallId === discoveryCallId && result.status === 'resolved' ? result.candidates.find((row) => row.id === candidateId) : undefined;
    if (!candidate || !candidate.available || !candidate.mediaId || candidate.projectId === STUDIO_LIBRARY_ID || run.projectId && candidate.projectId !== run.projectId || !await db.projects.get(candidate.projectId)) throw new Error('图片候选不可读取或项目归属不匹配，请重新查找');
    const state = await sourceState(candidate.projectId, candidate.locator, db);
    if (state.unavailableReason || state.revision !== candidate.revision || state.mediaId !== candidate.mediaId) throw new Error('图片来源已变化，请重新查找后读取');
    if (state.reference) await getReferenceSource(candidate.projectId, state.reference, db);
    return {candidate, media: state.media!, reference: state.reference};
}

export async function imageDigest(media: MediaRecord): Promise<string> {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await (await readBinaryBlob(media.blob)).arrayBuffer()))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function validateDiscoveredInput(input: AgentReferenceInput, runId: string | undefined, store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    const provenance = input.discovery;
    if (!runId || !provenance || input.images?.length !== 1 || input.coverage?.length) throw new Error('图片查找来源缺失');
    const read = await db.agentToolCalls.get(provenance.readCallId), run = await db.agentRuns.get(runId);
    if (!read || !run || read.name !== 'read_project_image' || read.status !== 'completed' || read.runId !== runId || read.threadId !== run.threadId || !read.result) throw new Error('图片读取来源不属于当前执行');
    const args = JSON.parse(read.arguments) as { discoveryCallId?: string; candidateId?: string };
    const saved = (JSON.parse(read.result) as { referenceInput?: AgentReferenceInput }).referenceInput;
    if (args.discoveryCallId !== provenance.discoveryCallId || args.candidateId !== provenance.candidateId || targetRevision(saved) !== targetRevision(input)) throw new Error('图片读取身份与执行记录不匹配');
    const resolved = await resolveDiscoveredImage(runId, provenance.discoveryCallId, provenance.candidateId, db);
    if (input.projectId !== resolved.candidate.projectId || input.images[0].mediaId !== resolved.media.id || JSON.stringify(input.references) !== JSON.stringify(resolved.reference ? [resolved.reference] : [])) throw new Error('图片读取范围与来源不匹配');
    if (await imageDigest(resolved.media) !== provenance.mediaDigest) throw new Error('图片内容已变化，请重新查找后读取');
    // Hashing awaits Blob reads; the source association can change while it runs,
    // including during the final post-encoding validation before dispatch.
    await resolveDiscoveredImage(runId, provenance.discoveryCallId, provenance.candidateId, db);
}
