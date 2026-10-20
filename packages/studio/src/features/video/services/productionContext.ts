import {binaryByteLength} from "../../../platform/media/binaryTypes";
import type {ProductStore} from "../../../platform/storage/types";
/** Historical local read/preflight contract. Durable Agent generation uses agent/generationRuntime and generationBatchRuntime. */
import {db as productDb} from "../../../platform/product/store";
import type {SourceRevision} from "../models/production";
import type {GenerationSlot, MediaKind} from "../../library/models/slots";
import type {Id} from "../../../platform/identity";
import {CHARACTER_SLOTS, PROP_SLOTS, SCENE_SLOTS, STYLE_SLOTS} from "../../library/models/slots";
import {normalizeEpisodeStory} from "../models/story";
import {normalizeProjectMode} from "../models/format";
import {normalizeSetting} from "../models/world";
import {normalizeShotStatus} from "../models/shots";
import {parseGenerationSlot, parseShotPictureSlots} from "../../library/models/slot";
import {targetRevision} from "../../../platform/data/revision";
import {flushPendingDrafts} from "../../../platform/product/drafts";

/** Local metadata only; consumers must explicitly resolve bytes in a later step. */
interface ProductionMediaMetadata {
    id: Id;
    mimeType: string;
    filename: string;
    size: number;
    kind: MediaKind
}

export async function buildProductionContext(projectId: Id, episodeId: Id, shotId: Id, store?: ProductStore) {
    const db = store ?? productDb;
    await flushPendingDrafts(projectId);
    return db.transaction("r", [db.projects, db.episodes, db.shots, db.characters, db.scenes, db.props, db.styles, db.media], async (db) => {
        const project = await db.projects.get(projectId);
        const episode = await db.episodes.get(episodeId);
        const shot = await db.shots.get(shotId);
        if (!project || !episode || episode.projectId !== projectId || !shot || shot.projectId !== projectId || shot.episodeId !== episodeId) {
            throw new Error("项目、集或镜头不存在或归属不匹配");
        }
        const sourceRevisions: SourceRevision[] = [];
        const warnings: string[] = [];
        const source = (kind: string, entity: { id: Id }) => {
            sourceRevisions.push({kind, id: entity.id, revision: targetRevision(entity)});
        };
        source("project", project);
        source("episode", episode);
        source("shot", shot);
        const story = normalizeEpisodeStory(episode.story);
        const beat = story.beats.find((item) => item.id === shot.beatId);
        if (shot.beatId && !beat) warnings.push(`场次不存在：${shot.beatId}`);
        if (beat) source("beat", beat);
        const characterIds = [...new Set([...shot.characterIds, ...(beat?.characterIds ?? [])])];
        const sceneIds = [...new Set([shot.sceneId, beat?.sceneId].filter((id): id is string => Boolean(id)))];
        const propIds = [...new Set(shot.propIds ?? [])];
        const styleId = shot.styleId === undefined ? project.defaultStyleId : shot.styleId;
        const [characters, scenes, props, style] = await Promise.all([
            db.characters.bulkGet(characterIds), db.scenes.bulkGet(sceneIds), db.props.bulkGet(propIds),
            styleId ? db.styles.get(styleId) : Promise.resolve(undefined),
        ]);
        const scoped = <T extends {
            id: Id;
            projectId: Id
        }>(rows: Array<T | undefined>, ids: Id[], kind: string): T[] => rows.flatMap((row, index) => {
            if (!row || row.projectId !== projectId) {
                warnings.push(`${kind}不存在或不属于当前项目：${ids[index]}`);
                return [];
            }
            source(kind, row);
            return [row];
        });
        const linkedCharacters = scoped(characters, characterIds, "character");
        const linkedScenes = scoped(scenes, sceneIds, "scene");
        const linkedProps = scoped(props, propIds, "prop");
        const linkedStyle = styleId ? scoped([style], [styleId], "style")[0] : undefined;
        const slots = parseShotPictureSlots(shot as unknown as Record<string, unknown>);
        const requests: Array<{ id: Id; kind: MediaKind }> = [];
        const inspect = (raw: unknown): GenerationSlot => {
            const slot = parseGenerationSlot(raw);
            requests.push(...slot.referenceImageIds.map((id) => ({
                id,
                kind: "image" as const
            })), ...slot.referenceVideoIds.map((id) => ({id, kind: "video" as const})));
            if (slot.result) requests.push({id: slot.result.mediaId, kind: slot.result.kind});
            return slot;
        };
        const assetSlots = <K extends string>(raw: Partial<Record<K, GenerationSlot>>, keys: {
            id: K
        }[]) => Object.fromEntries(keys.map(({id}) => [id, inspect(raw[id])]));
        Object.values(slots).forEach(inspect);
        const cast = linkedCharacters.map((item) => ({
            id: item.id,
            name: item.name,
            bio: item.bio,
            appearance: item.appearance,
            notes: item.notes,
            personality: item.personality ?? "",
            motivation: item.motivation ?? "",
            voice: item.voice ?? "",
            slots: assetSlots(item.slots, CHARACTER_SLOTS)
        }));
        const locations = linkedScenes.map((item) => ({
            id: item.id,
            name: item.name,
            location: item.location,
            timeOfDay: item.timeOfDay,
            atmosphere: item.atmosphere,
            notes: item.notes,
            geography: item.geography ?? "",
            lighting: item.lighting ?? "",
            slots: assetSlots(item.slots, SCENE_SLOTS)
        }));
        const objects = linkedProps.map((item) => ({
            id: item.id,
            name: item.name,
            kind: item.kind,
            notes: item.notes,
            appearance: item.appearance ?? "",
            material: item.material ?? "",
            size: item.size ?? "",
            usage: item.usage ?? "",
            continuity: item.continuity ?? "",
            slots: assetSlots(item.slots, PROP_SLOTS)
        }));
        const visualStyle = linkedStyle ? {
            id: linkedStyle.id,
            name: linkedStyle.name,
            notes: linkedStyle.notes,
            palette: linkedStyle.palette ?? "",
            lighting: linkedStyle.lighting ?? "",
            lens: linkedStyle.lens ?? "",
            composition: linkedStyle.composition ?? "",
            negativePrompt: linkedStyle.negativePrompt ?? "",
            slots: assetSlots(linkedStyle.slots, STYLE_SLOTS)
        } : undefined;
        const mediaIds = [...new Set(requests.map(({id}) => id))];
        const records = await db.media.bulkGet(mediaIds);
        const media: ProductionMediaMetadata[] = [];
        for (const [index, record] of records.entries()) {
            const expected = requests.filter(({id}) => id === mediaIds[index]);
            const kind = record?.mimeType.startsWith("image/") ? "image" : record?.mimeType.startsWith("video/") ? "video" : undefined;
            if (!record || record.projectId !== projectId || !kind || !binaryByteLength(record.blob)) {
                warnings.push(`素材不存在、为空、类型无效或不属于当前项目：${mediaIds[index]}`);
                continue;
            }
            if (expected.some((request) => request.kind !== kind)) warnings.push(`素材引用类型不匹配：${record.id}`);
            media.push({
                id: record.id,
                filename: record.filename,
                mimeType: record.mimeType,
                size: binaryByteLength(record.blob),
                kind
            });
        }
        const image = project.generationDefaults?.image;
        const video = project.generationDefaults?.video;
        return {
            format: "momoki-production-context-v1" as const,
            project: {
                id: project.id,
                name: project.name,
                mode: normalizeProjectMode(project.mode),
                brief: project.brief ?? "",
                genre: project.genre ?? "",
                audience: project.audience ?? "",
                tone: project.tone ?? "",
                logline: project.story.logline,
                aspectPreset: project.aspectPreset
            },
            world: normalizeSetting(project.setting),
            episode: {
                id: episode.id,
                title: episode.title,
                order: episode.order,
                logline: story.logline,
                script: story.script
            },
            beat: beat ? {
                id: beat.id,
                title: beat.title,
                content: beat.content,
                characterIds: beat.characterIds,
                sceneId: beat.sceneId,
                timeOfDay: beat.timeOfDay,
                scriptRange: beat.scriptRange ? {
                    start: beat.scriptRange.start,
                    end: beat.scriptRange.end,
                    excerpt: beat.scriptRange.excerpt
                } : undefined
            } : undefined,
            shot: {
                id: shot.id,
                order: shot.order,
                shotNumber: shot.shotNumber,
                status: normalizeShotStatus(shot.status),
                content: shot.content,
                notes: shot.notes,
                category: shot.category,
                durationSec: shot.durationSec,
                timingSource: "authored" as const,
                sceneCloseup: shot.sceneCloseup,
                sound: shot.sound,
                emotion: shot.emotion,
                cameraAngle: shot.cameraAngle,
                cameraGear: shot.cameraGear,
                focalLength: shot.focalLength,
                characterIds: shot.characterIds,
                sceneId: shot.sceneId,
                propIds: shot.propIds ?? [],
                slots
            },
            style: {
                source: shot.styleId === undefined ? "project-default" as const : shot.styleId === null ? "none" as const : "shot-override" as const,
                requestedId: styleId,
                value: visualStyle
            },
            assets: {characters: cast, scenes: locations, props: objects},
            output: {
                source: "project-default" as const,
                image: image ? {
                    provider: image.provider,
                    model: image.model,
                    profileVersion: image.profileVersion,
                    size: image.size,
                    resolution: image.resolution,
                    quality: image.quality,
                    version: image.version
                } : undefined,
                video: video ? {
                    provider: video.provider,
                    model: video.model,
                    profileVersion: video.profileVersion,
                    mode: video.mode,
                    aspectRatio: video.aspectRatio,
                    resolution: video.resolution,
                    duration: video.duration
                } : undefined
            },
            media, sourceRevisions, warnings,
        };
    });
}

export type ProductionContext = Awaited<ReturnType<typeof buildProductionContext>>;
