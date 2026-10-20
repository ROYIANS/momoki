import {createCapabilityLoading,selectCapabilityGroups,MAX_LOADED_TOOLS} from '@momoki/agent-core';
import type {ProductStore} from "../../../platform/storage/types";
import {defineTool} from './toolDefinition';
import {DISCOVERY_TOOL_NAME, toolNamesForCall} from "../models/agentToolSelection";
import {z} from "zod";
import {db as productDb} from "../../../platform/product/store";
import {executeAtomicTool} from "../commands/agentTools";
import type {AgentRun, AgentToolCall, AgentToolLoading} from "../models/agent";
import {toResponseInput} from "../providers/responsesStream";
import {AGENT_SKILLS, SMART_EXECUTION_INSTRUCTIONS} from "./skills";
import type {ProjectKind} from "../../projects/models/project";
import {INSTALLED_SKILL_TOOL_NAMES, installedSkillInstructions} from "../skills/runtime/disclosure";

export {
    DISCOVERY_TOOL_NAME, MAX_LOADED_TOOLS, getOfferedToolNames, toolNamesForCall
} from "../models/agentToolSelection";

const settled = (call: AgentToolCall) => ["completed", "failed", "rejected"].includes(call.status);
const foundation = (name: string) => name === "workspace_overview" || name === "update_run_plan" || name.startsWith("task_")
    || INSTALLED_SKILL_TOOL_NAMES.some(installed => installed === name);

/** Freeze descriptions, instructions and permission-filtered names at run creation. */
export function createToolLoading(skillIds: readonly string[], allowedNames: readonly string[], projectKind?: ProjectKind): AgentToolLoading | undefined {
    const groups=AGENT_SKILLS.filter(skill=>skillIds.includes(skill.id));
    const preferred=projectKind === 'audio' ? 'audio-production' : projectKind === 'music' ? 'music-creation' : undefined;
    return createCapabilityLoading(groups,allowedNames,foundation,DISCOVERY_TOOL_NAME,preferred);
}

/** New-run composition knows the final foundation, including all MCP resource helpers. */
export function fitToolLoadingFoundation(state: AgentToolLoading, foundationToolNames: readonly string[]): AgentToolLoading {
    const fixed = new Set(foundationToolNames), capacity = MAX_LOADED_TOOLS - fixed.size;
    const groups = state.groups.flatMap(group => {
        const optional = group.toolNames.filter(name => !fixed.has(name));
        if (optional.length <= capacity) return [group];
        if (capacity <= 0) throw new Error("基础工具已达到 36 个上限，无法加载业务能力");
        return Array.from({length: Math.ceil(optional.length / capacity)}, (_, index) => ({
            ...group, id: `${group.id}-part-${capacity}-${index + 1}`, name: `${group.name} ${index + 1}`,
            toolNames: optional.slice(index * capacity, (index + 1) * capacity),
        }));
    });
    let loadedGroupIds = state.loadedGroupIds.filter(id => groups.some(group => group.id === id));
    let loadedToolNames = [...new Set(groups.filter(group => loadedGroupIds.includes(group.id)).flatMap(group => group.toolNames))];
    if (new Set([...foundationToolNames, ...loadedToolNames]).size > MAX_LOADED_TOOLS) {loadedGroupIds = []; loadedToolNames = [];}
    return {...state, foundationToolNames: [...foundationToolNames], groups, loadedGroupIds, loadedToolNames};
}

export function toolLoadingInstructions(state: AgentToolLoading): string {
    return [
        SMART_EXECUTION_INSTRUCTIONS,
        state.foundationInstructions,
        "按需工具：已提供定义的业务工具可以直接调用，不必重复加载。当前未提供的工具须先调用 load_tool_groups，系统在同一次执行的下一次模型请求提供定义，收到结果后立即继续，不需要用户发送继续。groupIds 为要保留的完整分组列表（最多 2 组，替换上次加载）；空列表配合 query 只查目录，不执行业务。发现与加载不改变授权。依赖上一步结果的操作放到收到结果后的下一次模型请求。",
        "可用能力目录：\n" + state.groups.map((group) => `${group.id}｜${group.name}：${group.description}`).join("\n"),
        ...state.groups.filter((group) => state.loadedGroupIds.includes(group.id)).map((group) => group.instructions),
    ].filter(Boolean).join("\n");
}

const loadingSchema = z.object({
    groupIds: z.array(z.string().min(1).max(80)).max(2),
    query: z.string().trim().max(100).optional()
}).strict();
export const DISCOVERY_TOOLS = [defineTool({
    schema: loadingSchema, json: {
        type: "object",
        additionalProperties: false,
        required: ["groupIds"],
        properties: {
            groupIds: {type: "array", maxItems: 2, items: {type: "string", minLength: 1, maxLength: 80}},
            query: {type: "string", maxLength: 100}
        }
    }
}, {
    name: DISCOVERY_TOOL_NAME,
    title: "加载创作工具",
    description: "按能力目录加载最多两组已授权工具，替换之前的业务组；同次执行的下一次模型请求获得完整定义，无需用户再次发送消息。groupIds=[] 时仅按 query 查询目录，不执行业务。",
    effect: "bookkeeping",
    atomic: true,
    highRisk: () => false,
    async execute(raw, context) {
        const db = context.store ?? productDb;
        const args = loadingSchema.parse(raw);
        return executeAtomicTool(context, async (db) => {
            const boundContext = {...context, store: db};
            const run = await db.agentRuns.get(boundContext.runId);
            const state = run?.toolLoading;
            const call = await db.agentToolCalls.get(boundContext.callId);
            if (!run || !state || !call || call.name !== DISCOVERY_TOOL_NAME || !toolNamesForCall(run, call.step).includes(DISCOVERY_TOOL_NAME)) throw new Error("本轮未提供工具加载入口");
            if (args.groupIds.some((id) => !state.groups.some((group) => group.id === id))) throw new Error("请求的能力不存在或未启用，请使用可用能力目录中的分组 ID");
            const selected = state.groups.filter((group) => args.groupIds.includes(group.id));
            if (!selected.length) {
                const query = args.query?.toLocaleLowerCase();
                return {
                    groups: state.groups.filter((group) => !query || `${group.id} ${group.name} ${group.description}`.toLocaleLowerCase().includes(query)).map(({
                                                                                                                                                                    id,
                                                                                                                                                                    name,
                                                                                                                                                                    description
                                                                                                                                                                }) => ({
                        id,
                        name,
                        description
                    })),
                    loadedGroupIds: state.loadedGroupIds,
                    note: "仅查询目录；请接着选择 groupIds，系统将在同次执行的下一次模型请求加载定义；不代表业务已执行。"
                };
            }
            const pending = (await db.agentToolCalls.where("runId").equals(run.id).toArray()).filter((row) => !settled(row));
            const next=selectCapabilityGroups(state,args.groupIds,pending,run.enabledToolNames ?? []);
            const loadedToolNames=next.loadedToolNames;
            await db.agentRuns.update(run.id, {toolLoading: next});
            return {
                loadedGroupIds: next.loadedGroupIds,
                toolNames: loadedToolNames,
                effectiveFromStep: (run.modelStep ?? 0) + 1,
                note: "工具已准备好，系统会在同一次执行的下一次模型请求提供完整参数；请接着调用所需业务工具，无需用户再发送开始或继续。此操作只加载能力，没有执行任何业务。"
            };
        }, db);
    }
})];

/** Replace only the upcoming skill layer; preserve request history and paired tool envelopes. */
export async function refreshRunToolLoading(runId: string, store?: ProductStore): Promise<AgentRun> {
    const db = store ?? productDb;
    return db.transaction("rw", [db.agentRuns, db.agentToolCalls], async (db) => {
        const run = await db.agentRuns.get(runId);
        if (!run || run.status !== "running") throw new Error("执行已停止");
        if (!run.toolLoading && !run.createdProjectBinding) return run;
        if ((await db.agentToolCalls.where("runId").equals(runId).toArray()).some((call) => !settled(call))) throw new Error("请先处理工具步骤，再切换能力");
        const bindingNotice = "当前执行已通过创建项目工具一次性绑定新项目。请以最新项目事实与创建结果中的真实 ID 在同次执行继续用户要求的创作；不需要新开对话或请用户再次发送开始。此说明取代旧技能中创建后必须新开项目对话的指引。原有付费确认、权限和停止边界继续生效。";
        let skillInstructions = run.toolLoading ? [toolLoadingInstructions(run.toolLoading), installedSkillInstructions(run.installedSkills)].filter(Boolean).join("\n") : run.skillInstructions ?? "";
        if (run.createdProjectBinding?.projectId === run.projectId && !skillInstructions.includes(bindingNotice)) skillInstructions += `\n${bindingNotice}`;
        if (skillInstructions === run.skillInstructions) return run;
        const messages = run.continuationMessages ?? run.requestMessages;
        const oldBase = run.context?.baseMessages ?? [messages[0]];
        if (!oldBase[0] || oldBase[0].role !== "system" || JSON.stringify(messages.slice(0, oldBase.length)) !== JSON.stringify(oldBase)) throw new Error("技能上下文信封不匹配");
        const baseMessages = [{
            ...oldBase[0],
            content: [run.agentSnapshot.instructions, skillInstructions].filter(Boolean).join("\n")
        }, ...oldBase.slice(1)];
        const oldResponseBase = toResponseInput(oldBase);
        if (run.responseItems && JSON.stringify(run.responseItems.slice(0, oldResponseBase.length)) !== JSON.stringify(oldResponseBase)) throw new Error("Responses 技能信封不匹配");
        const next: AgentRun = {
            ...run,
            skillInstructions, ...(run.context ? {
                context: {
                    ...run.context,
                    baseMessages
                }
            } : {}),
            continuationMessages: [...baseMessages, ...messages.slice(oldBase.length)], ...(run.responseItems ? {responseItems: [...toResponseInput(baseMessages), ...run.responseItems.slice(oldResponseBase.length)]} : {})
        };
        await db.agentRuns.put(next);
        return next;
    });
}
