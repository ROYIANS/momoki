import type {ToolSpec} from "@momoki/agent-core";
import {z} from "zod";
import {ASPECT_PRESET_IDS} from "../../video/models/format";
import {SHOT_STATUSES} from "../../video/models/shots";
import {
    APIMART_IMAGE_MODELS,
    IMAGE_EXT_VERSIONS,
    IMAGE_QUALITIES,
    IMAGE_RATIOS,
    IMAGE_RESOLUTIONS,
    OUTPUT_PROFILE_VERSION,
    VIDEO_RATIOS,
    VIDEO_RESOLUTIONS
} from "../../video/models/output";

/** Build strict runtime and advertised schemas together; never accept passthrough fields. */
export interface Spec<T> extends ToolSpec<T> {
    schema: z.ZodType<T, z.ZodTypeDef, unknown>;
    json: Record<string, unknown>;
    optional?: boolean
}

export function text(max = 8000, min = 0): Spec<string> {
    return {
        schema: z.string().min(min).max(max).refine((value) => min === 0 || value.trim().length >= min, "文本不能为空"),
        json: {type: "string", minLength: min, maxLength: max}
    };
}

/** Used only where the existing parser trims input before enforcing bounds. */
export function trimmedText(max: number, min = 1): Spec<string> {
    return {schema: z.string().trim().min(min).max(max), json: {type: "string", minLength: min, maxLength: max}};
}

/** A default supplies required output while the advertised input remains optional. */
export function defaulted<S extends Spec<unknown>>(spec: S, value: z.input<S["schema"]> & z.output<S["schema"]>) {
    const schema: S["schema"] = spec.schema;
    return {...spec, schema: schema.default(value), optional: true};
}

export function number(min: number, max: number, integer = false): Spec<number> {
    const schema = z.number().finite().min(min).max(max);
    return {
        schema: integer ? schema.int() : schema,
        json: {type: integer ? "integer" : "number", minimum: min, maximum: max}
    };
}

export function choice<const T extends readonly [string, ...string[]]>(values: T): Spec<T[number]> {
    return {schema: z.enum(values), json: {type: "string", enum: values}};
}

export const bool: Spec<boolean> = {schema: z.boolean(), json: {type: "boolean"}};

export function optional<T>(spec: Spec<T>): Spec<T | undefined> {
    return {schema: spec.schema.optional(), json: spec.json, optional: true};
}

export function nullable<T>(spec: Spec<T>): Spec<T | null> {
    return {schema: spec.schema.nullable(), json: {anyOf: [spec.json, {type: "null"}]}};
}

export function array<T>(spec: Spec<T>, max = 50, min = 0): Spec<T[]> {
    return {
        schema: z.array(spec.schema).min(min).max(max),
        json: {type: "array", items: spec.json, minItems: min, maxItems: max}
    };
}

export function object<const S extends Record<string, Spec<unknown>>>(shape: S) {
    // Object.entries preserves the same recipe keys; this is schema construction,
    // never an assertion of untrusted model arguments. Keep the actual object
    // schema public so existing pick/omit/shape consumers retain their contracts.
    const fields = Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, value.schema])) as { -readonly [K in keyof S]: S[K]["schema"] };
    return {
        schema: z.object(fields).strict(), json: {
            type: "object", additionalProperties: false,
            properties: Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, value.json])),
            required: Object.entries(shape).filter(([, value]) => !value.optional).map(([key]) => key),
        }
    };
}

export function nonempty<T extends object>(spec: Spec<T>): Spec<T> {
    return {
        ...spec,
        schema: spec.schema.refine((value) => Object.keys(value).length > 0, "至少提供一个要修改的字段"),
        json: {...spec.json, minProperties: 1}
    };
}

export const id = text(160, 1);
export const ids = {
    ...array(id, 100),
    schema: array(id, 100).schema.refine((items) => new Set(items).size === items.length, "标识不能重复")
};
export const owner = {ownerId: optional(id)};
export const target = {...owner, id};
export const episodeTarget = {...owner, episodeId: id};
export const beatTarget = {...episodeTarget, id};
export const page = {offset: optional(number(0, 100000, true)), limit: optional(number(1, 50, true))};
export const assetKind = choice(["character", "scene", "prop", "style"]);
export const entityKind = choice(["project", "episode", "beat", "shot", "character", "scene", "prop", "style", "media"]);
export const assetFields = {
    character: {
        name: optional(text(200, 1)),
        bio: optional(text()),
        appearance: optional(text()),
        notes: optional(text()),
        personality: optional(text()),
        motivation: optional(text()),
        voice: optional(text())
    },
    scene: {
        name: optional(text(200, 1)),
        location: optional(text()),
        timeOfDay: optional(text(200)),
        atmosphere: optional(text()),
        notes: optional(text()),
        geography: optional(text()),
        lighting: optional(text())
    },
    prop: {
        name: optional(text(200, 1)),
        kind: optional(text(200)),
        notes: optional(text()),
        appearance: optional(text()),
        material: optional(text()),
        size: optional(text()),
        usage: optional(text()),
        continuity: optional(text())
    },
    style: {
        name: optional(text(200, 1)),
        notes: optional(text()),
        palette: optional(text()),
        lighting: optional(text()),
        lens: optional(text()),
        composition: optional(text()),
        negativePrompt: optional(text())
    },
};
const imageDefaults = object({
    provider: choice(["apimart"]),
    model: choice(APIMART_IMAGE_MODELS),
    profileVersion: choice([OUTPUT_PROFILE_VERSION]),
    size: choice([...IMAGE_RATIOS, "auto"]),
    resolution: choice(IMAGE_RESOLUTIONS),
    quality: optional(choice(IMAGE_QUALITIES)),
    version: optional(choice(IMAGE_EXT_VERSIONS)),
});
const videoDefaults = object({
    provider: choice(["apimart"]),
    model: choice(["MiniMax-H3"]),
    profileVersion: choice([OUTPUT_PROFILE_VERSION]),
    mode: choice(["text", "frames", "reference"]),
    aspectRatio: choice([...VIDEO_RATIOS, "adaptive"]),
    resolution: choice(VIDEO_RESOLUTIONS),
    duration: number(4, 15, true)
});
export const projectFields = {
    name: optional(text(200, 1)),
    brief: optional(text()),
    genre: optional(text(1000)),
    audience: optional(text(1000)),
    tone: optional(text(1000)),
    aspectPreset: optional(choice(ASPECT_PRESET_IDS)),
    defaultStyleId: optional(nullable(id)),
    generationDefaults: optional(nullable(object({image: optional(imageDefaults), video: optional(videoDefaults)}))),
    logline: optional(text()),
    setting: optional(nonempty(object({
        worldview: optional(text()),
        background: optional(text()),
        rules: optional(text())
    }))),
    coverMediaId: optional(nullable(id)),
    defaultDurationSec: optional(number(0, 3600)),
    autoIncrementShotNumber: optional(bool),
};
export const episodeFields = {title: optional(text(200)), logline: optional(text()), script: optional(text(24000))};
export const beatFields = {
    title: optional(text(200)),
    content: optional(text()),
    timeOfDay: optional(text(200)),
    characterIds: optional(ids),
    sceneId: optional(nullable(id)),
};
export const shotFields = {
    shotNumber: optional(text(80)),
    status: optional(choice(SHOT_STATUSES)),
    durationSec: optional(number(0, 3600)),
    content: optional(text()),
    notes: optional(text()),
    category: optional(text(200)),
    sceneCloseup: optional(text()),
    sound: optional(text()),
    emotion: optional(text()),
    cameraAngle: optional(text(1000)),
    cameraGear: optional(text(1000)),
    focalLength: optional(text(200)),
    characterIds: optional(ids),
    propIds: optional(ids),
    sceneId: optional(nullable(id)),
    beatId: optional(nullable(id)),
    // null explicitly disables style; inheritance is a separate boolean to avoid magic IDs.
    styleId: optional(nullable(id)),
    inheritStyle: optional(bool),
};
export const slotPatch = nonempty(object({
    prompt: optional(text()),
    referenceImageIds: optional(ids),
    referenceVideoIds: optional(ids),
    result: optional(nullable(object({mediaId: id, kind: choice(["image", "video"])})))
}));
