import {binaryByteLength} from "../../../platform/media/binaryTypes";
import {readBinaryBlob, verifyBinaryAvailable} from "../../../platform/storage/binary";
import {BinaryUnavailableError} from "../../../platform/storage/nativeBinary";
import {type ShotBinaryState, verifiedShotMediaIndex} from "../queries/shotMedia";
import JSZip from "jszip";
import {db} from "../../../platform/product/store";
import {SHOT_COLUMNS} from "../models/columns";
import {parseShotPictureSlots} from "../../library/models/slot";
import type {GenerationResult} from "../../library/models/slots";
import type {Id} from "../../../platform/identity";
import type {MediaRecord} from "../../library/models/media";
import type {ShotPictureField} from "../models/shots";
import {episodeLabel} from "../models/episodes";
import {normalizeEpisodeStory} from "../models/story";
import {normalizeProjectMode} from "../models/format";
import {flushPendingDrafts} from "../../../platform/product/drafts";
import {deriveEpisodeDelivery, episodeDeliveryCsv} from "./episodeDelivery";

export const HANDOFF_FORMAT = "momoki-handoff-v1" as const;

type SlotState = "empty" | "exported" | "placeholder" | "missing" | "foreign" | "wrong-kind" | "empty-file" | "corrupt";

interface HandoffSlot {
    prompt: string;
    state: SlotState;
    required: boolean;
    expectedResult?: GenerationResult;
    path?: string;
    originalFilename?: string;
    mimeType?: string;
    byteSize?: number;
}

const SLOT_LABELS: Record<ShotPictureField, string> = {firstFrame: "首帧", lastFrame: "尾帧", clip: "成片"};

/** One path component only; user-authored IDs and names never become directories. */
function safeComponent(value: string, fallback: string): string {
    const safe = Array.from(value.normalize("NFKC"), character => character.charCodeAt(0) < 32 ? "-" : character).join("")
        .replace(/[\u007f\\/:*?"<>|]/g, "-")
        .replace(/\s+/g, " ").replace(/^\.+|[. ]+$/g, "").trim();
    let bounded = "";
    for (const character of safe) {
        if (new TextEncoder().encode(bounded + character).length > 100) break;
        bounded += character;
    }
    return !bounded || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(bounded)
        ? fallback : bounded;
}

function inspectSlot(
    field: ShotPictureField,
    prompt: string,
    result: GenerationResult | undefined,
    media: MediaRecord | undefined,
    projectId: Id,
    folder: string,
    availability?: ShotBinaryState,
): HandoffSlot {
    const slot: HandoffSlot = {
        prompt, state: "empty", required: field !== "lastFrame",
        ...(result ? {expectedResult: {mediaId: result.mediaId, kind: result.kind}} : {}),
    };
    if (!result) return slot;
    if (!media) return {...slot, state: "missing"};
    if (media.projectId !== projectId) return {...slot, state: "foreign"};
    if ((result.kind !== "image" && result.kind !== "video") ||
        (field !== "clip" && result.kind !== "image") || !media.mimeType.startsWith(`${result.kind}/`)) {
        return {...slot, state: "wrong-kind"};
    }
    if (binaryByteLength(media.blob) === 0) return {...slot, state: "empty-file"};
    if (availability === "missing" || availability === "corrupt") return {...slot, state: availability};
    return {
        ...slot,
        state: field === "clip" && result.kind === "image" ? "placeholder" : "exported",
        path: `${folder}/${field}-${safeMediaFilename(media.filename, result.kind === "image" ? "image" : "video")}`,
        originalFilename: media.filename, mimeType: media.mimeType, byteSize: binaryByteLength(media.blob),
    };
}

function safeMediaFilename(filename: string, fallback: string): string {
    const extension = filename.match(/\.([a-zA-Z0-9]{1,10})$/)?.[0] ?? "";
    return `${safeComponent(extension ? filename.slice(0, -extension.length) : filename, fallback)}${extension}`;
}

function slotWarning(field: ShotPictureField, slot: HandoffSlot): string | undefined {
    const label = SLOT_LABELS[field];
    switch (slot.state) {
        case "empty":
            return slot.required ? `${label}尚未选择素材` : undefined;
        case "placeholder":
            return "成片为图片占位，仍缺少完成的视频";
        case "missing":
            return `${label}引用的素材不存在`;
        case "corrupt":
            return `${label}素材内容已损坏，未导出`;
        case "foreign":
            return `${label}引用了其他项目的素材，未导出`;
        case "wrong-kind":
            return `${label}素材类型不匹配，未导出`;
        case "empty-file":
            return `${label}素材文件为空，未导出`;
        case "exported":
            return undefined;
    }
}

/** Export only current-episode selected results; this is not a restorable project backup. */
export async function exportProductionHandoff(
    projectId: Id,
    episodeId: Id,
    onProgress?: (percent: number) => void,
): Promise<{ blob: Blob; filename: string; shotCount: number; missingCount: number }> {
    onProgress?.(0);
    await flushPendingDrafts(projectId);
    const snapshot = await db.transaction("r",
        [db.projects, db.episodes, db.shots, db.characters, db.scenes, db.props, db.styles, db.media], async (db) => {
            const project = await db.projects.get(projectId);
            const episode = await db.episodes.get(episodeId);
            if (!project || !episode || episode.projectId !== projectId) throw new Error("找不到当前项目或分集");
            const shots = (await db.shots.where("episodeId").equals(episodeId).toArray())
                .filter((shot) => shot.projectId === projectId)
                .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
                .map((shot) => ({...shot, ...parseShotPictureSlots(shot as unknown as Record<string, unknown>)}));
            if (!shots.length) throw new Error("当前分集还没有镜头，无法导出素材交付包");
            const mediaIds = new Set(shots.flatMap((shot) => [shot.firstFrame.result?.mediaId, shot.lastFrame.result?.mediaId, shot.clip.result?.mediaId])
                .filter((id): id is string => Boolean(id)));
            const characterIds = [...new Set(shots.flatMap((shot) => shot.characterIds))];
            const sceneIds = [...new Set(shots.flatMap((shot) => shot.sceneId ? [shot.sceneId] : []))];
            const propIds = [...new Set(shots.flatMap((shot) => shot.propIds ?? []))];
            const styleIds = [...new Set(shots.flatMap((shot) => {
                const id = shot.styleId === undefined ? project.defaultStyleId : shot.styleId;
                return id ? [id] : [];
            }))];
            const [characters, scenes, props, styles, media] = await Promise.all([
                db.characters.bulkGet(characterIds), db.scenes.bulkGet(sceneIds), db.props.bulkGet(propIds),
                db.styles.bulkGet(styleIds), db.media.bulkGet([...mediaIds]),
            ]);
            const owned = <T extends { projectId: Id }>(item: T | undefined): item is T =>
                item !== undefined && item.projectId === projectId;
            return {
                project, episode, shots,
                characters: characters.filter(owned),
                scenes: scenes.filter(owned),
                props: props.filter(owned),
                styles: styles.filter(owned),
                media: new Map(media.filter((item) => item !== undefined).map((item) => [item.id, item])),
            };
        });
    onProgress?.(10);
    const {project, episode} = snapshot;
    const files = new Map<string, Blob>();
    const states = new Map<string, ShotBinaryState>();
    for (const record of snapshot.media.values()) {
        if (record.projectId !== projectId || binaryByteLength(record.blob) === 0) continue;
        try {
            files.set(record.id, await readBinaryBlob(record.blob));
            states.set(record.id, "ready");
        } catch (error) {
            if (!(error instanceof BinaryUnavailableError)) throw error;
            states.set(record.id, error.availability);
        }
    }
    // All authored camera/sound fields belong in the handoff, even when hidden in the editor.
    const delivery = deriveEpisodeDelivery({
        ...snapshot, media: verifiedShotMediaIndex(snapshot.media, states), project: {
            ...project, columnSettings: {visible: SHOT_COLUMNS.map((column) => column.id)},
        }
    });
    const zip = new JSZip();
    const beats = normalizeEpisodeStory(episode.story).beats;
    const slots = ["firstFrame", "lastFrame", "clip"] as const;
    const rows = delivery.rows.map((row, index) => {
        const shot = row.shot;
        // Sequence guarantees uniqueness even for duplicate/hostile labels and truncated IDs.
        const folder = `shots/${String(index + 1).padStart(4, "0")}-${safeComponent(shot.shotNumber, "shot")}-${safeComponent(shot.id, "id")}`;
        const media = Object.fromEntries(slots.map((field) => {
            const result = shot[field].result;
            const record = result ? snapshot.media.get(result.mediaId) : undefined;
            const slot = inspectSlot(field, shot[field].prompt, result, record, projectId, folder, record ? states.get(record.id) : undefined);
            if (slot.path && record) zip.file(slot.path, files.get(record.id)!);
            return [field, slot];
        })) as Record<ShotPictureField, HandoffSlot>;
        const warnings: string[] = [];
        if (row.missing.includes("content")) warnings.push("镜头内容未填写");
        if (row.missing.includes("duration")) warnings.push("镜头时长未填写");
        if (row.missing.includes("scene")) warnings.push("场景未关联或已不存在");
        const linked = (ids: Id[], records: Array<{ id: Id; name: string }>, label: string) => ids.map((id) => {
            const record = records.find((item) => item.id === id);
            if (!record) warnings.push(`${label}关联失效：${id}`);
            return {id, name: record?.name ?? null};
        });
        const characters = linked(shot.characterIds, snapshot.characters, "角色");
        const props = linked(shot.propIds ?? [], snapshot.props, "道具");
        const effectiveStyleId = shot.styleId === undefined ? project.defaultStyleId : shot.styleId;
        const style = effectiveStyleId ? linked([effectiveStyleId], snapshot.styles, "风格")[0] : null;
        const beat = beats.find((item) => item.id === shot.beatId);
        if (shot.beatId && !beat) warnings.push(`场次关联失效：${shot.beatId}`);
        for (const field of slots) {
            const warning = slotWarning(field, media[field]);
            if (warning) warnings.push(warning);
        }
        const metadata = {
            projectId,
            episodeId,
            shotId: shot.id,
            order: row.order,
            shotNumber: shot.shotNumber,
            status: row.status,
            statusLabel: row.statusLabel,
            durationSec: shot.durationSec,
            content: shot.content,
            notes: shot.notes,
            category: shot.category,
            sceneCloseup: shot.sceneCloseup,
            sound: shot.sound,
            emotion: shot.emotion,
            cameraAngle: shot.cameraAngle,
            cameraGear: shot.cameraGear,
            focalLength: shot.focalLength,
            beat: shot.beatId ? {id: shot.beatId, title: beat?.title ?? null} : null,
            characters,
            scene: shot.sceneId ? {
                id: shot.sceneId,
                name: snapshot.scenes.find((item) => item.id === shot.sceneId)?.name ?? null
            } : null,
            props,
            style,
            styleSource: row.styleSource,
            media,
            warnings,
            folder,
        };
        const detail = [
            `镜头 ${row.order} · ${shot.shotNumber}`, `镜头 ID：${shot.id}`, `状态（人工标记）：${row.statusLabel}`,
            `时长：${shot.durationSec} 秒`, `场次：${row.beat}`, `角色：${row.characters || "无"}`,
            `场景：${row.scene || "未关联"}`, `道具：${row.props || "无"}`, `风格：${row.style}（${row.styleSource}）`,
            `内容：\n${shot.content}`, `备注：\n${shot.notes}`,
            ...delivery.columns.map((column) => `${column.label}：\n${row.values[column.id] ?? ""}`),
            "素材：", ...slots.map((field) => `${SLOT_LABELS[field]}：${media[field].path ?? slotWarning(field, media[field]) ?? "未选择（可选）"}\n素材描述：\n${media[field].prompt}`),
            "检查项：", ...(warnings.length ? warnings : ["无缺失项"]),
        ].join("\n\n");
        zip.file(`${folder}/shot.txt`, detail);
        return metadata;
    });
    const missingCount = rows.filter((row) => row.warnings.length > 0).length;
    const title = normalizeProjectMode(project.mode) === "film" ? project.name : `${project.name} · ${episodeLabel(episode)}`;
    zip.file("manifest.json", JSON.stringify({
        format: HANDOFF_FORMAT, exportedAt: new Date().toISOString(),
        project: {
            id: projectId,
            name: project.name,
            mode: normalizeProjectMode(project.mode),
            aspectPreset: project.aspectPreset
        },
        episode: {id: episodeId, order: episode.order, title: episode.title},
        shotCount: rows.length, missingCount, totalDurationSec: delivery.totalDurationSec, shots: rows,
    }, null, 2));
    zip.file("shots.csv", episodeDeliveryCsv(delivery));
    zip.file("missing.md", [`# 缺失与待确认清单`, `${missingCount} / ${rows.length} 个镜头有待确认项。尾帧未选择不计为缺失。`,
        ...rows.filter((row) => row.warnings.length > 0).map((row) => `## ${row.order} · ${row.shotNumber}\n\n镜头 ID：${row.shotId}\n\n${row.warnings.map((warning) => `- ${warning}`).join("\n")}`),
        ...(missingCount ? [] : ["所有镜头已具备内容、时长、有效场景、首帧和成片视频。"]),
    ].join("\n\n"));
    zip.file("README.md", [
        `# ${title} — 素材交付包`,
        `共 ${rows.length} 个镜头，合计 ${delivery.totalDurationSec} 秒；${missingCount} 个镜头有待确认项。`,
        "这是供制作与剪辑使用的素材交付包，不是可还原的项目备份。仅包含当前分集的镜头信息及已选择的首帧、尾帧、成片原始文件。",
        "请先查看 missing.md，再按 shots.csv 顺序使用 shots/ 下的素材。每个镜头文件夹中的 shot.txt 保留完整文字；manifest.json 提供稳定 ID、关联信息、素材路径与原始文件名。",
        "文件夹以镜头顺序编号，随后是镜号和镜头 ID。素材文件名以 firstFrame、lastFrame、clip 标明用途。路径中的特殊字符已处理，原始文件字节未转码。",
        "尾帧为可选项。成片槽中的图片按占位图导出，仍会提示缺少完成的视频。人工标记的状态不代表所有素材已经齐全。",
    ].join("\n\n"));
    onProgress?.(20);
    // Media are usually compressed already; STORE preserves bytes with lower CPU/memory overhead.
    const blob = await zip.generateAsync({
        type: "blob",
        compression: "STORE"
    }, (event) => onProgress?.(20 + event.percent * 0.8));
    for (const id of files.keys()) await verifyBinaryAvailable(snapshot.media.get(id)!.blob);
    return {blob, filename: `${safeComponent(title, "素材交付")}-素材交付.zip`, shotCount: rows.length, missingCount};
}
