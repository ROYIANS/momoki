import {nowIso} from "../../../platform/identity";
import type {ProductStore} from "../../../platform/storage/types";
import type {AgentRequestMessage, AgentResponseItem, AgentRun, AgentToolCallStatus} from "../models/agent";
import type {AgentPendingInput} from "../models/agentPendingInput";
import {toResponseInput} from "../providers/responsesStream";

const SETTLED_CALL: readonly AgentToolCallStatus[] = ["completed", "failed", "rejected"];

/** True only when every assistant tool_call in the saved messages already has its tool result (a complete round boundary). */
function roundIsClosed(messages: readonly AgentRequestMessage[]): boolean {
    const answered = new Set(messages.flatMap(message => message.role === "tool" ? [message.tool_call_id] : []));
    return messages.every(message => message.role !== "assistant" || (message.tool_calls ?? []).every(call => answered.has(call.id)));
}

/**
 * next-step delivery. Runs in the caller's (run-guarded) transaction at the top of the model loop, after
 * every tool result of the previous round was appended. Appends one user message per eligible queued item
 * after the saved tool results, mirrors it into the Responses envelope, writes the visible user row and
 * deletes the queue row, all atomically. Never touches the frozen base prefix. Returns the reread run.
 */
export async function injectSteerInputs(runId: string, store: ProductStore): Promise<AgentRun> {
    return store.transaction("rw", [store.agentRuns, store.chatMessages, store.agentPendingInputs, store.agentToolCalls], async (db) => {
        const run = await db.agentRuns.get(runId);
        if (!run) throw new Error("执行已删除");
        if (run.status !== "running") return run;
        const items = (await db.agentPendingInputs.where("threadId").equals(run.threadId).toArray())
            .filter(item => item.status === "queued" && item.mode === "next-step" && item.source === "user" && !item.attachments?.length)
            .sort((a, b) => a.position - b.position);
        if (!items.length) return run;
        const calls = await db.agentToolCalls.where("runId").equals(runId).toArray();
        const messages: AgentRequestMessage[] = [...(run.continuationMessages ?? run.requestMessages)];
        // Never inside an open tool round: unsettled calls or an assistant tool_calls without its results.
        if (calls.some(call => !SETTLED_CALL.includes(call.status)) || !roundIsClosed(messages)) return run;
        const responseItems: AgentResponseItem[] | undefined = run.protocol === "responses" ? [...(run.responseItems ?? toResponseInput(messages))] : undefined;
        const history = await db.chatMessages.where("threadId").equals(run.threadId).toArray();
        let clock = Math.max(Date.now(), ...history.map(message => Date.parse(message.createdAt) + 1).filter(Number.isFinite));
        const deliver = async (item: AgentPendingInput) => {
            if (!messages.some(message => message.sourceQueueItemId === item.id)) {
                const message: AgentRequestMessage = {role: "user", content: item.content, sourceQueueItemId: item.id};
                messages.push(message);
                responseItems?.push(...toResponseInput([message]));
            }
            if (!await db.chatMessages.get(item.userMessageId)) {
                await db.chatMessages.add({
                    id: item.userMessageId, threadId: run.threadId, role: "user", content: item.content,
                    status: "complete", steeredIntoRunId: run.id, createdAt: new Date(clock++).toISOString(),
                });
            }
            await db.agentPendingInputs.delete(item.id);
        };
        for (const item of items) await deliver(item);
        await db.agentRuns.update(runId, {continuationMessages: messages, ...(responseItems ? {responseItems} : {}), updatedAt: nowIso()});
        return (await db.agentRuns.get(runId))!;
    });
}
