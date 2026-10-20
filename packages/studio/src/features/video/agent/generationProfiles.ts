import {z} from "zod";
import * as s from "../../agent/runtime/businessSchemas";
import {
    defaultImageParameters,
    defaultVideoParameters,
    getGenerationCapability,
    isApimartImage25,
    isApimartImageExt,
    isApimartImageModel,
    validateGenerationParameters,
} from "../models/generationCapabilities";
import {validateProductionTarget} from "../models/productionRevision";
import type {ProductionTarget} from "../models/production";

const idSpec = s.trimmedText(160);
const modelSpec = s.choice(["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2.5-ext", "MiniMax-H3", "veo-3.1-fast-generate-preview"]);
const promptSpec = s.trimmedText(32000);
const boundedParameter = (max: number): s.Spec<string> => ({schema: z.string().max(max), json: {type: "string"}});
const targetSpec = s.object({
    kind: s.choice(["shot", "character", "scene", "prop", "style", "library"]), projectId: idSpec, entityId: idSpec,
    episodeId: s.optional(idSpec), slot: {schema: z.string().min(1).max(30), json: {type: "string", description: "素材槽位；kind 为 library 时填 image 或 video。"}},
    label: s.optional(s.trimmedText(120)),
});
const parameterSpec = s.object({
    size: s.optional({
        ...boundedParameter(30),
        json: {type: "string", description: '图片尺寸：APIMart 使用比例，例如 9:16；AIHubMix 使用已支持的像素尺寸。'}
    }),
    resolution: s.optional(boundedParameter(10)),
    duration: s.optional({schema: z.number().int(), json: {type: "integer"}}),
    aspectRatio: s.optional({
        ...boundedParameter(10),
        json: {type: "string", description: "仅视频使用；图片比例使用 size。"}
    }),
    mode: s.optional({
        ...s.choice(["text", "frames", "reference"]),
        json: {type: "string", enum: ["text", "frames", "reference"], description: "仅视频使用；图片不要传入。"}
    }),
    quality: s.optional(s.choice(["low", "medium", "high", "xhigh", "max", "auto"])),
    version: s.optional(s.choice(["flare", "sunburst"])),
});
const inputSpec = s.object({
    mediaId: idSpec,
    role: s.choice(["first-frame", "last-frame", "reference-image", "reference-video"])
});
const submitSpec = s.object({
    connectorId: idSpec,
    model: modelSpec,
    target: targetSpec, prompt: promptSpec,
    parameters: s.defaulted(parameterSpec, {}), inputs: s.defaulted(s.array(inputSpec, 16), []),
});
// The legacy advertisement intentionally has fewer bounds and different property
// ordering than parser output. Keep those wire differences explicit at this leaf.
const submitProperties = {
    connectorId: idSpec.json, model: modelSpec.json,
    prompt: promptSpec.json,
    target: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "projectId", "entityId", "slot"],
        properties: targetSpec.json.properties
    },
    parameters: {type: "object", additionalProperties: false, properties: parameterSpec.json.properties},
    inputs: {
        type: "array",
        maxItems: 16,
        items: {
            type: "object",
            additionalProperties: false,
            required: ["mediaId", "role"],
            properties: inputSpec.json.properties
        }
    },
};
export const generationSubmitSpec = {
    ...submitSpec, json: {
        type: "object",
        additionalProperties: false,
        required: ["connectorId", "model", "target", "prompt"],
        properties: submitProperties,
    }
};
export const generationSubmitSchema = generationSubmitSpec.schema;
export type GenerationSubmitArgs = z.output<typeof generationSubmitSchema>;
const jobSpec = s.object({jobId: idSpec});
export const generationJobSpec = {
    ...jobSpec,
    json: {type: "object", additionalProperties: false, required: ["jobId"], properties: {jobId: idSpec.json}}
};
export const generationJobSchema = generationJobSpec.schema;

export function profileRequest(args: GenerationSubmitArgs, provider: "apimart" | "aihubmix") {
    const target: ProductionTarget = validateProductionTarget(args.target);
    if (!target.slot) throw new Error("生成目标必须指定素材槽位");
    const kind: "image" | "video" = target.kind === "library" ? target.slot : target.kind === "shot" && target.slot === "clip" ? "video" : "image";
    const p = args.parameters;
    const inputs = args.inputs;
    if (new Set(inputs.map((input) => `${input.role}:${input.mediaId}`)).size !== inputs.length) throw new Error("输入素材用途重复");
    const count = (role: string) => inputs.filter((input) => input.role === role).length;
    if (count("first-frame") > 1 || count("last-frame") > 1) throw new Error("首尾帧不能重复");
    const mode = p.mode ?? (inputs.length ? "reference" : "text");
    const profile = getGenerationCapability(provider, args.model, kind);
    const parameterIssues = profile ? validateGenerationParameters(profile, p, {
        purpose: "request",
        mode,
        inputRoles: inputs.map(input => input.role)
    }) : [];
    const invalid = (...fields: Array<typeof parameterIssues[number]["field"]>) => parameterIssues.some(issue => fields.includes(issue.field));
    const parameters: Record<string, string | number | boolean> = {prompt: args.prompt};
    const disallow = (...keys: Array<keyof typeof p>) => {
        if (keys.some((key) => p[key] !== undefined)) throw new Error("当前模型不支持这些生成参数");
    };
    if (kind === "image") {
        if (inputs.some((input) => input.role !== "reference-image")) throw new Error("图片槽位仅支持已验证的图片模型与参考图片输入");
        if (p.aspectRatio !== undefined || p.mode !== undefined) {
            throw new Error('图片生成不支持 parameters.aspectRatio 和 parameters.mode；请移除这两个字段。APIMart 图片比例使用 parameters.size（例如 "9:16"），AIHubMix 使用已支持的像素尺寸；修改参数后重新准备草稿，尚未提交生成。');
        }
        disallow("duration");
        parameters.n = 1;
        parameters.size = p.size ?? defaultImageParameters(args.model, {purpose: "request"}).size;
        if (provider === "apimart") {
            if (!isApimartImageModel(args.model)) throw new Error("图片槽位仅支持已验证的 APIMart 图片模型与参考图片输入");
            const maxImages = profile && "maxImages" in profile ? profile.maxImages : 15;
            if (invalid("size", "resolution") || inputs.length > maxImages) {
                throw new Error(isApimartImageExt(args.model)
                    ? "APIMart GPT Image 2.5 Ext 比例、分辨率或参考图数量无效"
                    : "APIMart GPT Image 比例、分辨率或参考图数量无效");
            }
            if (isApimartImage25(args.model)) {
                disallow("version");
                const quality = p.quality ?? defaultImageParameters(args.model, {purpose: "request"}).quality ?? "auto";
                if (invalid("quality")) throw new Error("请选择 GPT Image 2.5 支持的画质");
                parameters.quality = quality;
                parameters.resolution = p.resolution ?? defaultImageParameters(args.model, {purpose: "request"}).resolution;
            } else if (isApimartImageExt(args.model)) {
                disallow("quality");
                parameters.version = p.version ?? defaultImageParameters(args.model, {purpose: "request"}).version ?? "flare";
                parameters.resolution = (p.resolution ?? defaultImageParameters(args.model, {purpose: "request"}).resolution).toUpperCase();
            } else {
                disallow("quality", "version");
                parameters.resolution = p.resolution ?? defaultImageParameters(args.model, {purpose: "request"}).resolution;
            }
        } else {
            if (args.model !== "gpt-image-2") throw new Error("AIHubMix 图片当前仅支持已验证的 GPT Image 2");
            disallow("resolution", "version");
            // Verified safe common size subset also valid for image editing.
            if (invalid("size")) throw new Error("AIHubMix GPT Image 2 使用 auto 或已验证的像素尺寸");
            parameters.output_format = "png";
            parameters.async = true;
            if (p.quality) {
                if (invalid("quality")) throw new Error("AIHubMix GPT Image 2 画质仅支持 low、medium 或 high");
                parameters.quality = p.quality;
            }
        }
    } else {
        disallow("size", "quality", "version");
        if (mode === "text" && inputs.length || mode === "frames" && (!count("first-frame") || count("reference-image") || count("reference-video")) || mode === "reference" && (!inputs.length || count("first-frame") || count("last-frame"))) throw new Error("视频生成方式与明确的输入素材用途不匹配");
        parameters.mode = mode;
        if (provider === "apimart") {
            if (args.model !== "MiniMax-H3") throw new Error("APIMart 视频当前仅支持已验证的 MiniMax-H3");
            if (args.prompt.length > 7000 || count("reference-image") > 9) throw new Error("MiniMax H3 提示词或参考图片超出限制");
            if (count("reference-video")) throw new Error("APIMart 暂无本地视频上传适配，不能提交参考视频；请选择文字或图片输入");
            const defaults = defaultVideoParameters(provider, {
                purpose: "request",
                mode,
                inputRoles: inputs.map(input => input.role)
            });
            parameters.resolution = p.resolution ?? defaults.resolution;
            parameters.duration = p.duration ?? defaults.duration;
            if (invalid("resolution", "duration")) throw new Error("MiniMax H3 分辨率须为 768P/2K，时长为 4–15 秒整数");
            if (mode === "frames") {
                if (invalid("aspectRatio")) throw new Error("首尾帧比例跟随输入图片");
            } else {
                parameters.aspect_ratio = p.aspectRatio ?? defaults.aspectRatio ?? "16:9";
                if (invalid("aspectRatio")) throw new Error("MiniMax H3 视频比例无效");
            }
        } else {
            if (args.model !== "veo-3.1-fast-generate-preview") throw new Error("AIHubMix 视频当前仅支持已验证的 Veo 3.1 Fast");
            const defaults = defaultVideoParameters(provider, {
                purpose: "request",
                mode,
                inputRoles: inputs.map(input => input.role)
            });
            parameters.duration = p.duration ?? defaults.duration;
            parameters.resolution = p.resolution ?? defaults.resolution;
            parameters.aspect_ratio = p.aspectRatio ?? defaults.aspectRatio ?? "16:9";
            if (invalid("duration", "resolution", "aspectRatio")) throw new Error("Veo 3.1 Fast 时长、分辨率或比例无效");
            if (invalid("constraint")) throw new Error("Veo 高分辨率/参考输入要求 8 秒，参考视频要求 720p");
            if (count("reference-image") > 3 || count("reference-video") > 1) throw new Error("Veo 最多 3 张参考图片与 1 段参考视频");
        }
    }
    return {target, kind, parameters, inputs};
}

// Compatibility export: the ordered advertisement is owned by the capability leaf.
export {GENERATION_CAPABILITIES as GENERATION_PROFILES} from "../models/generationCapabilities";
