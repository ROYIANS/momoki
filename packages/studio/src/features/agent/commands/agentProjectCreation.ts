import type {ProductStore} from "../../../platform/storage/types";
import {db as productDb} from "../../../platform/product/store";
import {nowIso} from "../../../platform/identity";
import {MAX_LOADED_TOOLS, toolNamesForCall} from "../models/agentToolSelection";
import type {AgentToolContext} from "../runtime/tools";
import {getProjectKind} from "../../projects/models/project";
import {isLaterUserTurn} from "../models/chatTurns";

/** Narrow exception for a project created by this run; never changes an existing binding. Caller owns transaction. */
export async function assertAgentProjectCreation(context: AgentToolContext, continuing: boolean, executing = false, store?: ProductStore) {
    const db = store ?? context.store ?? productDb;
    context.signal.throwIfAborted();
    const run = await db.agentRuns.get(context.runId), thread = await db.chatThreads.get(context.threadId);
    if (!run || !thread || run.threadId !== thread.id || run.status !== "running") throw new Error("执行已停止或归属不匹配");
    if (run.projectId || thread.projectId || run.createdProjectBinding || context.projectId) throw new Error("项目绑定对话不能创建其他项目，请在项目页新建");
    if (run.taskId || run.taskMode || thread.taskMode || run.interactionMode === "conversation") throw new Error("只有普通智能对话可以创建并继续项目");
    if (!run.enabledToolNames?.includes("project_create")) throw new Error("此执行未启用创建项目工具");
    const call = await db.agentToolCalls.get(context.callId);
    if (executing && (!call || call.name !== "project_create" || call.runId !== run.id || call.threadId !== thread.id || call.effect !== "write" || !call.atomic || call.status !== "running" ||
        !toolNamesForCall(run, call.step).includes("project_create") || ((run.permissionMode ?? "ask") === "ask" && call.decision !== "approve"))) throw new Error("创建项目工具尚未得到有效批准或归属不匹配");
    const message = await db.chatMessages.get(run.assistantMessageId);
    if (!message || message.threadId !== thread.id || message.runId !== run.id) throw new Error("执行消息归属不匹配");
    const history = await db.chatMessages.where("threadId").equals(thread.id).toArray();
    const runs = await db.agentRuns.where("threadId").equals(thread.id).toArray();
    if (runs.some(row => row.id !== run.id && row.createdAt >= run.createdAt) || history.some(row => isLaterUserTurn(row, run))) throw new Error("只能在当前最后一次执行创建项目");
    if (continuing) {
        const inputs = [...run.requestMessages, ...(run.continuationMessages ?? []), ...(run.responseItems ?? []), ...(run.context?.baseMessages ?? [])];
        if (inputs.some(row => row.referenceInput !== undefined) || run.context?.selectedReferences || run.referenceAudit?.some(row => row.inputs.length)) {
            throw new Error("当前执行包含绑定原归属的参考资料，不能自动切换项目。请使用 continueInProject=false 仅创建项目，再从结果入口开启项目对话；参考资料的归属保持不变。");
        }
        const calls = await db.agentToolCalls.where("runId").equals(run.id).toArray();
        // Same-envelope reads have completed but appendToolResults has not copied
        // their reference inputs into continuation yet.
        if (calls.some(row => {
            if (row.id === context.callId || row.status !== "completed" || !row.result) return false;
            try {
                const result: unknown = JSON.parse(row.result);
                return !!result && typeof result === "object" && !Array.isArray(result) && "referenceInput" in result && result.referenceInput !== undefined;
            } catch {
                return false;
            }
        })) throw new Error("本轮已读取绑定原归属的参考资料，请使用 continueInProject=false 仅创建，再从结果入口开启项目对话。");
        if (calls.some(row => row.id !== context.callId && (row.status === "unknown" || row.status === "running" || row.effect === "write" && row.status === "completed"))) {
            throw new Error("当前执行已有其他归属的写入或未核实操作，不能自动绑定新项目。请使用 continueInProject=false 仅创建项目，再从结果入口继续。");
        }
        if (await db.agentGenerationJobs.where("threadId").equals(thread.id).count() || await db.agentGenerationBatches.where("threadId").equals(thread.id).count() ||
            (await db.audioGenerationJobs.toArray()).some(job => {
                const source = job.source;
                return source.kind === "agent" && runs.some(prior => prior.id === source.runId);
            })) {
            throw new Error("当前执行已有生成任务或批次，不能更换它们的项目归属。请使用 continueInProject=false 仅创建，再从结果入口继续。");
        }
    }
    return run;
}

export async function bindCreatedAgentProject(context: AgentToolContext, projectId: string, store?: ProductStore): Promise<void> {
    const db = store ?? context.store ?? productDb;
    const run = await assertAgentProjectCreation(context, true, true, db);
    const project = await db.projects.get(projectId);
    if (!project) throw new Error("刚创建的项目不存在");
    const preferred = getProjectKind(project) === "audio" ? "audio-production" : getProjectKind(project) === "music" ? "music-creation" : undefined;
    const state = run.toolLoading, group = state?.groups.find(row => row.id === preferred);
    const allowed = group?.toolNames.filter(name => run.enabledToolNames?.includes(name)) ?? [];
    const toolLoading = state && group && new Set([...state.foundationToolNames, ...allowed]).size <= MAX_LOADED_TOOLS
        ? {...state, loadedGroupIds: [group.id], loadedToolNames: [...new Set(allowed)]} : state;
    const at = nowIso();
    await db.chatThreads.update(run.threadId, {projectId, updatedAt: at});
    await db.agentRuns.update(run.id, {
        projectId,
        createdProjectBinding: {projectId, callId: context.callId},
        toolLoading,
        updatedAt: at
    });
}
