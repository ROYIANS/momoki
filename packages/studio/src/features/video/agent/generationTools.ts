import {defineTool} from '../../agent/runtime/toolDefinition';
import {prepareGenerationBatch, readGenerationBatch} from "../../agent/commands/agentGenerationBatches";
import {validateBatchLimits} from "../../agent/models/agentGenerationBatch";
import {assertProjectToolScope, frozenProjectScope} from "../../agent/runtime/projectScope";
import {z} from "zod";
import {getGenerationPreferenceState} from "../../settings/commands/generationPreferences";
import {recommendGenerationSelection} from "./generationSelection";
import {db as productDb} from "../../../platform/product/store";
import {generationJobSummary} from "../../agent/commands/agentGeneration";
import {
    GENERATION_PROFILES,
    generationJobSpec,
    generationSubmitSchema,
    generationSubmitSpec
} from "./generationProfiles";
import {
    applyAgentGeneration,
    monitorAgentGeneration,
    prepareAgentGeneration,
    prepareGenerationApply,
    submitAgentGeneration
} from "./generationRuntime";

const id = {type: "string", minLength: 1, maxLength: 160};
const batchSchema = z.object({
    title: z.string().trim().min(1).max(160),
    candidates: z.array(generationSubmitSchema).min(1).max(20)
}).strict().superRefine((value, ctx) => {
    try {
        validateBatchLimits(value.candidates.map(draft => ({draft})));
    } catch (error) {
        ctx.addIssue({code: "custom", message: error instanceof Error ? error.message : "候选数量无效"});
    }
});
export const GENERATION_TOOLS = [
    defineTool({
        schema: batchSchema, json: {
            type: "object",
            additionalProperties: false,
            required: ["title", "candidates"],
            properties: {
                title: {type: "string", minLength: 1, maxLength: 160},
                candidates: {type: "array", minItems: 1, maxItems: 20, items: generationSubmitSpec.json}
            }
        }
    }, {
        name: "prepare_generation_batch",
        title: "准备批量生成",
        description: "准备多个目标槽位的图片/视频候选草稿，每个槽位默认1份、最多4份，每批最多20份。不想绑定槽位时用 target.kind=\"library\"（slot 填 image 或 video，entityId 填你给这组备选起的稳定名字），结果选用后保存到项目素材库。每份独立配置。只保存草稿，不上传或付费提交；用户在批量面板编辑并一次确认。结果必须由用户比较选用，禁止自动写入。",
        effect: "bookkeeping",
        atomic: true,
        highRisk: () => false,
        execute: (args, context) => {
            const parsed = batchSchema.parse(args);
            return prepareGenerationBatch(parsed.title, parsed.candidates, context, context.store);
        }
    }),
    defineTool({
        schema: z.object({batchId: z.string().trim().min(1).max(160)}).strict(),
        json: {type: "object", additionalProperties: false, required: ["batchId"], properties: {batchId: id}}
    }, {
        name: "read_generation_batch",
        title: "读取批量结果",
        description: "读取当前对话指定批次的候选状态和当前选用结果，不发送网络请求。draft不是生成成功，queued是未发送，unknown不可重试。",
        effect: "read",
        highRisk: () => false,
        async execute(args, context) {
            const db = context.store ?? productDb;
            await frozenProjectScope(context, db);
            const state = await readGenerationBatch(args.batchId, context.threadId, db);
            await assertProjectToolScope(context, "read_generation_batch", {projectId: state.batch.projectId}, false, db);
            return {
                batchId: state.batch.id,
                title: state.batch.title,
                status: state.batch.status,
                pauseReason: state.batch.pauseReason,
                candidates: state.items.map(item => {
                    const job = state.jobs.find(j => j.id === item.jobId);
                    return {
                        itemId: item.id,
                        target: item.baseline.target,
                        label: item.label,
                        status: job?.status ?? item.state,
                        selected: state.batch.selections[item.targetKey] === item.id,
                        applied: !!job?.result && state.currentMedia[item.targetKey] === job.result.mediaId, ...(job ? {
                            jobId: job.id,
                            provider: job.provider,
                            model: job.model,
                            result: job.result,
                            error: job.error
                        } : {})
                    };
                })
            };
        }
    }),
    defineTool({
        schema: z.object({projectId: z.string().trim().min(1).max(160).optional()}).strict(),
        json: {type: "object", properties: {projectId: id}, additionalProperties: false}
    }, {
        name: "generation_capabilities",
        title: "查看生成能力",
        description: "列出已配置供应商、代码已验证的模型参数，以及项目/全局生成推荐。传 projectId 获取项目默认；用户明确选择优先于项目、全局和自动建议。有问题的推荐不得静默降级。能力列表不是账户授权或余额保证。",
        effect: "read",
        highRisk: () => false,
        async execute(args, context) {
            const db = context.store ?? productDb;
            const {signal} = context;
            const boundProject = await frozenProjectScope(context, db);
            signal.throwIfAborted();
            const projectId = args.projectId ?? boundProject;
            if (projectId) await assertProjectToolScope(context, "generation_capabilities", {projectId}, false, db);
            const project = projectId && projectId !== "studio" ? await db.projects.get(projectId) : undefined;
            if (projectId && projectId !== "studio" && !project) throw new Error("项目不存在，请重新选择生成目标");
            const connectors = (await db.connectors.toArray()).filter((item) => ["apimart", "aihubmix"].includes(item.definitionId));
            const state = await getGenerationPreferenceState(db);
            const recommendations = Object.fromEntries((["image", "video"] as const).map((kind) => [kind, recommendGenerationSelection({
                kind,
                connectors,
                projectDefaults: project?.generationDefaults,
                preferences: state.preferences,
                preferenceIssues: state.issues
            })]));
            signal.throwIfAborted();
            return {
                connectors: connectors.map((item) => ({
                    id: item.id,
                    provider: item.definitionId,
                    label: item.label,
                    configured: Boolean(item.apiKey.trim())
                })),
                profiles: GENERATION_PROFILES,
                recommendations,
                profileDate: "2026-09-19",
                note: "AI 先准备供应商/模型/提示/参数，用户可在确认处调整；付费提交始终需要确认。没有列出的模型/参数组合明确不支持，不会自动替换。"
            };
        }
    }),
    defineTool(generationSubmitSpec, {
        name: "submit_generation",
        title: "生成图片或视频",
        description: "为合法目标槽位提交一次付费生成并等待查询/下载。不绑定槽位时用 target.kind=\"library\"（slot 填 image 或 video，entityId 填稳定名字，可选 label 作素材名），apply_generation 会把结果保存到项目素材库。先查 generation_capabilities。必须使用稳定目标ID和本地素材ID。返回 downloaded 才表示本地素材可用；还需 apply_generation 写入目标。失败/未知提交不可当作成功，也不可盲目重发。",
        effect: "network",
        recovery: "generation",
        requiresConfirmation: true,
        highRisk: () => false,
        prepare: (args, context) => prepareAgentGeneration(args, context, context.store),
        async execute(args, context) {
            const db = context.store ?? productDb;
            const job = await submitAgentGeneration(args, context, undefined, db);
            return {
                ...generationJobSummary(job),
                parameters: job.parameters,
                inputs: job.inputs.map(({mediaId, role}) => ({mediaId, role}))
            };
        }
    }),
    defineTool(generationJobSpec, {
        name: "check_generation",
        title: "继续查询生成任务",
        description: "查询当前对话已有任务并下载真实结果；等待不会消耗模型轮次。只恢复已有任务，不会再次付费提交。返回 downloaded 后才可 apply_generation。",
        effect: "network",
        recovery: "repeatable",
        highRisk: () => false,
        async execute(args, context) {
            const db = context.store ?? productDb;
            return generationJobSummary(await monitorAgentGeneration(args.jobId, context, undefined, db));
        }
    }),
    defineTool(generationJobSpec, {
        name: "apply_generation",
        title: "写入生成素材",
        description: "将已下载的生成结果写入原目标槽位；核验归属和原始版本，冲突保留结果且不覆盖手动修改。不改变文字/时长/人工状态。重复应用返回同一结果。",
        effect: "write",
        atomic: true,
        highRisk: () => false,
        prepare: (args, context) => prepareGenerationApply(args.jobId, context, context.store),
        execute: (args, context) => applyAgentGeneration(args.jobId, context, context.store)
    }),
    defineTool({schema: z.object({}).strict(), json: {type: "object", properties: {}, additionalProperties: false}}, {
        name: "list_generation_jobs",
        title: "查看生成记录",
        description: "列出当前对话最近30项生成任务及真实本地状态，不发送网络请求。未知提交需核实，不可重新提交。",
        effect: "read",
        highRisk: () => false,
        async execute(_args, context) {
            const db = context.store ?? productDb;
            context.signal.throwIfAborted();
            await frozenProjectScope(context, db);
            return (await db.agentGenerationJobs.where("threadId").equals(context.threadId).toArray()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30).map(generationJobSummary);
        }
    }),
];
