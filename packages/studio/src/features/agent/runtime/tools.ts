import type {AgentToolDefinition} from './toolDefinition';
import {assertUniqueToolNames, defineTool} from './toolDefinition';
import {DESKTOP_MEDIA_TOOLS} from "../../library/agent/desktopMediaTools";
import {IP_TOOLS} from "../../library/agent/ipTools";
import {AUDIO_TOOLS} from "../../audio/agent/audioTools";
import {MUSIC_TOOLS} from "../../music/agent/musicTools";
import {AUDIO_GENERATION_TOOLS} from "../../audio/agent/audioGenerationTools";
import {AUDIO_BATCH_TOOLS} from "../../audio/agent/audioBatchTools";
import {AUDIO_ARRANGEMENT_TOOLS} from "../../audio/agent/audioArrangementTools";
import {MATERIAL_TOOLS} from "../../library/agent/materialTools";
import {DISCOVERY_TOOLS} from "./toolLoading";
import {INSTALLED_SKILL_TOOLS} from "../skills/runtime/tools";
import {WEB_TOOLS} from "../../references/agent/webTools";
import {REFERENCE_TOOLS} from "../../references/agent/referenceTools";
import {MEMORY_TOOLS} from "../../memory/agent/memoryTools";
import {frozenProjectScope} from "./projectScope";
import {TASK_TOOLS} from "./taskTools";
import {GENERATION_TOOLS} from "../../video/agent/generationTools";
import {BUSINESS_TOOLS} from "../../video/agent/businessTools";
import {MEDIA_CHECK_TOOLS} from "../../video/agent/mediaCheckTools";
import {JOB_TOOLS} from "./jobTools";
import {z} from "zod";
import {toolArgumentError, ToolUnavailableError, ToolValidationError} from "./toolErrors";
import {db as productDb} from "../../../platform/product/store";
import {updateRunPlanAndComplete} from "../commands/agentTools";
import type {AgentToolCall, AgentToolSchema} from "../models/agent";
import {validateToolInput} from '@momoki/agent-core';

export type {AgentToolContext, AgentToolDefinition} from './toolDefinition';

export {requiresToolApproval} from '@momoki/agent-core';

export const planSchema = z.object({
    reason: z.string().trim().min(1).max(1000).optional(),
    steps: z.array(z.object({
        id: z.string().trim().min(1).max(80),
        title: z.string().trim().min(1).max(240),
        status: z.enum(["pending", "in_progress", "completed"])
    }).strict()).max(30)
}).strict().refine((value) => new Set(value.steps.map((step) => step.id)).size === value.steps.length && value.steps.filter((step) => step.status === "in_progress").length <= 1, "步骤标识必须唯一，最多一个步骤进行中");
const definitions = [
    defineTool({schema: z.object({}).strict(), json: {type: "object", properties: {}, additionalProperties: false}}, {
        name: "workspace_overview",
        title: "查看工作区概览",
        description: "读取工作区项目和角色、场景、道具、风格的数量，最多返回 10 个最近项目名称，不读取密钥或完整业务内容。",
        effect: "read",
        highRisk: () => false,
        async execute(_args, context) {
            const db = context.store ?? productDb;
            const {signal} = context;
            signal.throwIfAborted();
            const projectId = await frozenProjectScope(context, db);
            if (projectId) {
                const project = await db.projects.get(projectId);
                return {
                    project: {id: projectId, name: project!.name},
                    counts: {
                        characters: await db.characters.where("projectId").equals(projectId).count(),
                        scenes: await db.scenes.where("projectId").equals(projectId).count(),
                        props: await db.props.where("projectId").equals(projectId).count(),
                        styles: await db.styles.where("projectId").equals(projectId).count()
                    }
                };
            }
            return db.transaction("r", [db.projects, db.characters, db.scenes, db.props, db.styles], async (db) => ({
                counts: {
                    projects: await db.projects.count(),
                    characters: await db.characters.count(),
                    scenes: await db.scenes.count(),
                    props: await db.props.count(),
                    styles: await db.styles.count()
                },
                projects: (await db.projects.orderBy("updatedAt").reverse().limit(10).toArray()).map((project) => ({
                    id: project.id,
                    name: project.name.slice(0, 200)
                })),
            }));
        }
    }),
    defineTool({
        schema: planSchema, json: {
            type: "object",
            additionalProperties: false,
            required: ["steps"],
            properties: {
                reason: {type: "string", minLength: 1, maxLength: 1000},
                steps: {
                    type: "array",
                    maxItems: 30,
                    items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["id", "title", "status"],
                        properties: {
                            id: {type: "string", minLength: 1, maxLength: 80},
                            title: {type: "string", minLength: 1, maxLength: 240},
                            status: {type: "string", enum: ["pending", "in_progress", "completed"]}
                        }
                    }
                }
            }
        }
    }, {
        name: "update_run_plan",
        title: "更新执行计划",
        description: "维护当前执行及其关联任务的共享计划（最多 30 项），每项有唯一 id、title 和 pending/in_progress/completed 状态。不会修改项目或素材。",
        effect: "bookkeeping",
        atomic: true,
        highRisk: () => false,
        async execute(args, context) {
            const {runId, callId, signal} = context;
            const db = context.store ?? productDb;
            signal.throwIfAborted();
            const result: unknown = JSON.parse(await updateRunPlanAndComplete(runId, callId, args.steps, args.reason, db));
            return result;
        }
    }),
    ...IP_TOOLS,
    ...AUDIO_TOOLS,
    ...MUSIC_TOOLS,
    ...AUDIO_GENERATION_TOOLS,
    ...AUDIO_BATCH_TOOLS,
    ...AUDIO_ARRANGEMENT_TOOLS,
    ...MATERIAL_TOOLS,
    ...DISCOVERY_TOOLS,
    ...INSTALLED_SKILL_TOOLS,
    ...TASK_TOOLS,
    ...BUSINESS_TOOLS,
    ...GENERATION_TOOLS,
    ...MEMORY_TOOLS,
    ...REFERENCE_TOOLS,
    ...WEB_TOOLS,
    ...MEDIA_CHECK_TOOLS,
    ...JOB_TOOLS,
    ...DESKTOP_MEDIA_TOOLS,
];

// Existential registry: dispatch must use the selected definition's own parser before
// invoking its callbacks. Typed family consumers retain their concrete definitions.
assertUniqueToolNames(definitions);
export const BUILTIN_TOOLS = definitions as unknown as readonly AgentToolDefinition[];

export function toolSchemas(names: readonly string[], registry = BUILTIN_TOOLS): AgentToolSchema[] {
    assertUniqueToolNames(registry);
    return names.map((name) => {
        const tool = registry.find((item) => item.name === name);
        if (!tool) throw new Error("启用的工具不存在");
        return {type: "function", function: {name, description: tool.description, parameters: tool.parameters}};
    });
}

export function validateToolCall(name: string, raw: string, enabled: readonly string[], registry = BUILTIN_TOOLS) {
    return validateToolInput(name, raw, enabled, registry, {
        unavailable: (name, enabled) => new ToolUnavailableError(name, enabled),
        tooLarge: (tool, length) => new ToolValidationError(tool.title, name, [{
            path: "参数",
            constraint: "工具参数超过大小限制，最多 32768 个字符",
            received: length
        }]),
        invalid: (tool, parsed, cause) => toolArgumentError(tool.title, name, tool.parameters, parsed, cause),
    });
}

/** Supplement known legacy validation failures without rewriting their saved history. */
export function getLegacyToolValidationFailure(call: Pick<AgentToolCall, "name" | "title" | "status" | "error" | "arguments">) {
    if (call.status !== "failed" || call.error !== `工具 ${call.title} 的参数无效`) return;
    try {
        validateToolCall(call.name, call.arguments, [call.name]);
    } catch (error) {
        if (error instanceof ToolValidationError) return error.failure;
    }
}
