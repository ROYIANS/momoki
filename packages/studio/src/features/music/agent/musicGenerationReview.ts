import type {ProductStore} from "../../../platform/storage/types";
import {db as productDb} from "../../../platform/product/store";
import {canResumeAgentRun, resolveAgentToolApproval} from "../../agent/commands/agentTools";
import type {AgentToolCall} from "../../agent/models/agent";
import {targetRevision} from "../../../platform/data/revision";
import {musicGenerateTool} from "../../audio/agent/audioGenerationTools";
import {parseMusicGenerationReview} from "./musicGenerationReviewSnapshot";
import {isLaterUserTurn} from "../../agent/models/chatTurns";

export {parseMusicGenerationReview} from "./musicGenerationReviewSnapshot";

export interface MusicGenerationReviewState {
    status: "ready" | "stale" | "unavailable";
    message?: string
}

const stale = (): MusicGenerationReviewState => ({
    status: "stale",
    message: "草稿、连接或确认内容已变化。请取消本次请求，按当前草稿重新准备确认。"
});
const unavailable = (message = "音乐确认已处理或当前执行不可继续，请取消旧请求并重新准备。 "): MusicGenerationReviewState => ({
    status: "unavailable",
    message
});

async function inspect(expected: AgentToolCall, store?: ProductStore): Promise<MusicGenerationReviewState> {
    const db = store ?? productDb;
    const snapshot = parseMusicGenerationReview(expected.preview?.music);
    if (!snapshot || !expected.preview?.revision) return unavailable("旧请求缺少完整音乐确认内容，请取消后重新准备，才能确认提交。");
    const call = await db.agentToolCalls.get(expected.id), run = await db.agentRuns.get(expected.runId);
    if (!call || !run || call.runId !== expected.runId || call.threadId !== expected.threadId || call.threadId !== run.threadId ||
        call.name !== "music_generate" || call.status !== "awaiting_approval" || !call.requiresConfirmation || call.decision || call.generationOverride ||
        !canResumeAgentRun(run) || run.interactionMode === "conversation" || !run.enabledToolNames?.includes("music_generate")) return unavailable();
    if (call.arguments !== expected.arguments || call.preview?.revision !== expected.preview.revision ||
        targetRevision(call.preview?.music) !== targetRevision(expected.preview.music)) return stale();
    const thread = await db.chatThreads.get(run.threadId), message = await db.chatMessages.get(run.assistantMessageId);
    if (!thread || thread.projectId !== run.projectId || run.projectId !== snapshot.projectId || !message || message.threadId !== run.threadId || message.runId !== run.id) return unavailable();
    const siblings = await db.agentRuns.where("threadId").equals(run.threadId).toArray();
    const history = await db.chatMessages.where("threadId").equals(run.threadId).toArray();
    if (siblings.some(row => row.id !== run.id && row.createdAt >= run.createdAt) || history.some(row => isLaterUserTurn(row, run))) return unavailable("只能确认当前最后一次执行，请在最新对话中重新准备请求。");
    const calls = await db.agentToolCalls.where("runId").equals(run.id).toArray();
    if (calls.some(row => row.status === "unknown" || row.status === "running")) return unavailable("有操作结果尚不确定，请先核实，暂不能确认新的音乐生成。");
    if (await db.audioGenerationJobs.where("intentId").equals(`agent-audio:${call.id}`).first()) return unavailable("此请求已有生成任务记录，不能重复确认；请查询已有任务。");
    try {
        const tool = musicGenerateTool;
        const args = tool.parseArguments(JSON.parse(call.arguments));
        if (!tool.prepare) return unavailable();
        const fresh = await tool.prepare(args, {
            runId: run.id,
            threadId: run.threadId,
            callId: call.id,
            projectId: run.projectId,
            signal: new AbortController().signal,
            store: db
        });
        const current = parseMusicGenerationReview(fresh.music);
        if (!current || fresh.revision !== expected.preview.revision || targetRevision(current) !== targetRevision(snapshot)) return stale();
    } catch {
        return stale();
    }
    return {status: "ready"};
}

/** Local consistent snapshot only; never refreshes/changes the frozen draft or contacts the provider. */
export async function readMusicGenerationReview(call: AgentToolCall, store?: ProductStore): Promise<MusicGenerationReviewState> {
    const db = store ?? productDb;
    return db.transaction("r", db.tables, (db) => db.waitFor(inspect(call, db)));
}

/** Revalidation and the existing durable approval CAS share one transaction. Submission still rechecks. */
export async function approveMusicGenerationReview(call: AgentToolCall, store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    await db.transaction("rw", db.tables, async (db) => {
        const state = await db.waitFor(inspect(call, db));
        if (state.status !== "ready") throw new Error(state.message);
        await resolveAgentToolApproval(call.runId, call.id, "approve", db);
    });
}
