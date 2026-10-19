import type {ChatRequestMessage, ChatContentPart, ResponseRequestItem, ResponseInputPart} from '@cuepoint/agent-providers';
import {safeHistoricalLookupOutput} from "../../references/agent/referenceEvidence";
import {resolveMaterialInput} from "../../library/agent/materialImageInput";
import {db} from "../../../platform/product/store";
import type {AgentRequestMessage, AgentResponseItem} from "../models/agent";
import type {AgentReferenceInput, AgentVisionCapability} from "../../references/models/referenceInput";
import {validateReferenceInput} from "../../references/agent/referenceContext";
import {requireVision, resolveVisionCapability} from "../../settings/models/visionCapability";
import {verifyBinaryAvailable, withBinaryReadLease} from "../../../platform/storage/binary";
import type {BinaryContent} from "../../../platform/media/binaryTypes";

export interface ReferenceWireScope {
    projectId?: string;
    runId?: string;
    visionCapability?: AgentVisionCapability;
    model: string;
    connectorDefinitionId?: string
}

async function pixels(inputs: Array<AgentReferenceInput | undefined>, scope: ReferenceWireScope, signal?: AbortSignal) {
    const active = inputs.filter((item): item is AgentReferenceInput => !!item);
    if (!active.length) return new Map<string, string>();
    signal?.throwIfAborted();

    async function requireLiveScope() {
        if (!scope.runId) return;
        const run = await db.agentRuns.get(scope.runId), thread = run && await db.chatThreads.get(run.threadId);
        if (!run || run.status !== "running" || !thread || run.projectId !== scope.projectId || thread.projectId !== run.projectId || run.model !== scope.model) throw new Error("执行或图片所属项目已变化");
    }

    await requireLiveScope();
    const images = active.flatMap((item) => item.images ?? []);
    if (images.length > 10) throw new Error("本次上下文图片超过 10 张，请减少历史或选择的图片");
    if (images.length) requireVision(scope.visionCapability ?? await resolveVisionCapability(scope.model, scope.connectorDefinitionId));
    for (const input of active) await validateReferenceInput(input, scope.projectId, scope.runId);
    const encoded = new Map<string, string>();
    const preparedBytes: BinaryContent[] = [];
    for (const image of images) {
        signal?.throwIfAborted();
        if (encoded.has(image.mediaId)) continue;
        const input = active.find(item => item.images?.some(row => row.mediaId === image.mediaId));
        const media = input?.material ? await resolveMaterialInput(input, scope.projectId, scope.runId) : await db.media.get(image.mediaId);
        if (!media) throw new Error("图片文件不可用");
        const inputUrl = await withBinaryReadLease(media.blob, async lease => {
            const bytes = new Uint8Array(await (await lease.readBlob(signal)).arrayBuffer());
            let binary = "";
            for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
            return `data:${image.mimeType};base64,${btoa(binary)}`;
        }, signal);
        encoded.set(image.mediaId, inputUrl);
        preparedBytes.push(media.blob);
    }
    // Reading blobs is asynchronous; withdrawal during encoding must also block dispatch.
    for (const input of active) await validateReferenceInput(input, scope.projectId, scope.runId);
    await requireLiveScope();
    for (const binary of preparedBytes) await verifyBinaryAvailable(binary, signal);
    signal?.throwIfAborted();
    return encoded;
}

export async function materializeChatMessages(messages: AgentRequestMessage[], scope: ReferenceWireScope, signal?: AbortSignal): Promise<ChatRequestMessage[]> {
    const encoded = await pixels(messages.map((message) => message.referenceInput), scope, signal);
    const toolNames = new Map(messages.flatMap(message => message.role === "assistant" ? (message.tool_calls ?? []).map(call => [call.id, call.function.name] as const) : []));
    return messages.map(({referenceInput, sourceToolCallId: _source, sourceQueueItemId: _queue, ...message}): ChatRequestMessage => {
        if (message.role === "tool") return {
            ...message,
            content: safeHistoricalLookupOutput(toolNames.get(message.tool_call_id), message.content)
        };
        if (!referenceInput?.images?.length) return message;
        if (message.role !== "user") throw new Error("图片必须作为用户资料提交");
        return {
            ...message,
            content: [{
                type: "text",
                text: message.content
            }, ...referenceInput.images.map((image): ChatContentPart => ({
                type: "image_url",
                image_url: {url: encoded.get(image.mediaId)!, detail: "auto"}
            }))]
        };
    });
}

export async function materializeResponseItems(items: AgentResponseItem[], scope: ReferenceWireScope, signal?: AbortSignal): Promise<ResponseRequestItem[]> {
    const encoded = await pixels(items.map((item) => item.referenceInput), scope, signal);
    const toolNames = new Map(items.flatMap(item => item.type === "function_call" ? [[item.call_id, item.name] as const] : []));
    return items.map(({referenceInput, sourceToolCallId: _source, sourceQueueItemId: _queue, ...item}): ResponseRequestItem => {
        if (item.type === "function_call_output") return {
            ...item,
            output: safeHistoricalLookupOutput(toolNames.get(item.call_id), item.output)
        };
        if (!referenceInput?.images?.length) return item;
        if (item.type !== "message" || item.role !== "user" || typeof item.content !== "string") throw new Error("图片必须作为用户资料提交");
        return {
            ...item,
            content: [{
                type: "input_text",
                text: item.content
            }, ...referenceInput.images.map((image): ResponseInputPart => ({
                type: "input_image",
                image_url: encoded.get(image.mediaId)!,
                detail: "auto"
            }))]
        };
    });
}
