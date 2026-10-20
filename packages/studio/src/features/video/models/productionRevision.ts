import type {ProductionTarget} from "./production";
import {CHARACTER_SLOTS, PROP_SLOTS, SCENE_SLOTS, STYLE_SLOTS} from "../../library/models/slots";
import {SHOT_PICTURE_FIELDS} from "../../library/models/slot";

export function validateProductionTarget(raw: unknown): ProductionTarget {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("生成目标格式无效");
    const value = raw as Record<string, unknown>;
    for (const key of ["projectId", "entityId"]) {
        if (typeof value[key] !== "string" || !value[key].trim()) throw new Error("生成目标缺少归属或标识");
    }
    const common = {projectId: value.projectId as string, entityId: value.entityId as string};
    if (value.kind === "shot") {
        if (typeof value.episodeId !== "string" || !value.episodeId.trim()) throw new Error("镜头目标缺少集标识");
        if (value.slot !== undefined && !SHOT_PICTURE_FIELDS.includes(value.slot as never)) throw new Error("镜头素材槽位无效");
        return {
            kind: "shot", ...common,
            episodeId: value.episodeId, ...(value.slot === undefined ? {} : {slot: value.slot as "firstFrame" | "lastFrame" | "clip"})
        };
    }
    if (value.kind === "library") {
        if (value.slot !== "image" && value.slot !== "video") throw new Error("素材库生成需要指明图片或视频");
        if (typeof value.label === "string" && value.label.length > 120) throw new Error("素材名称过长");
        return {kind: "library", ...common, slot: value.slot, ...(typeof value.label === "string" && value.label.trim() ? {label: value.label.trim()} : {})};
    }
    const slots = {character: CHARACTER_SLOTS, scene: SCENE_SLOTS, prop: PROP_SLOTS, style: STYLE_SLOTS};
    if (typeof value.kind !== "string" || !Object.hasOwn(slots, value.kind)) throw new Error("生成目标类型无效");
    const kind = value.kind as keyof typeof slots;
    if (!slots[kind].some(({id}) => id === value.slot)) throw new Error("资产素材槽位无效");
    return {kind, ...common, slot: value.slot} as ProductionTarget;
}
