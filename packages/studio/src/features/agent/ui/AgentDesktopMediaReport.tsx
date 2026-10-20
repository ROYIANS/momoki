import {useState} from "react";
import {useProductQueryState} from "../../../platform/product/queries";
import type {AgentRun, AgentToolCall} from "../models/agent";

function OwnedDesktopMediaReport({run, call}: {run: AgentRun; call: AgentToolCall; readOnly?: boolean}) {
    const [retry] = useState(0);
    const key = JSON.stringify([run.threadId, run.projectId, run.id, call.id]);
    const state = useProductQueryState(async tx => {
        const [thread, original, currentCall, record] = await Promise.all([tx.chatThreads.get(run.threadId), tx.agentRuns.get(run.id), tx.agentToolCalls.get(call.id), tx.desktopMediaImports.get(call.id)]);
        if (!thread || !original || !currentCall || original.threadId !== thread.id || thread.projectId !== run.projectId || original.projectId !== run.projectId ||
            currentCall.runId !== run.id || currentCall.threadId !== thread.id || currentCall.name !== "desktop_media_import") return {key, unavailable: true as const};
        if (!record) return {key};
        if (record.projectId !== run.projectId || record.actor.kind !== "agent" || record.actor.runId !== run.id || record.actor.threadId !== thread.id || record.actor.callId !== call.id) return {key, unavailable: true as const};
        return {key, record};
    }, [key, retry]);
    const value = state.value?.key === key ? state.value : undefined, record = value?.record;
    if (state.error || value?.unavailable) return <p role="alert">导入记录不可用，请核对原项目。</p>;
    if (!record) return null;
    const remaining = record.selection.items.length - record.receipts.length;
    return <div className="agent-job-progress" data-desktop-media-import={record.id}>
        <p>已导入 {record.receipts.length} / {record.selection.items.length} 个视频</p>
        {record.status === "stopping" && <p>等待当前处理结束，不再开始下一项。</p>}
        {record.status === "stopped" && <p>已停止，保留已导入的素材。还有 {remaining} 项未导入。</p>}
        {record.status === "failed" && <p role="alert">{record.error ?? "未能完成导入，已保存的素材仍然保留。"}</p>}
        {record.status === "unknown" && <p role="alert">导入结果待核对，不会自动重新处理视频。</p>}
        {record.receipts.length > 0 && <ul aria-label="已导入视频">{record.receipts.slice(-3).map(receipt => <li key={receipt.itemId}>{record.selection.items.find(item => item.entryId === receipt.itemId)?.filename}</li>)}</ul>}
    </div>;
}
export function AgentDesktopMediaReport(props: {run: AgentRun; call: AgentToolCall; readOnly?: boolean}) {
    if (props.call.name !== "desktop_media_import" || props.call.runId !== props.run.id || props.call.threadId !== props.run.threadId || !props.run.projectId) return null;
    return <OwnedDesktopMediaReport key={JSON.stringify([props.run.threadId, props.run.projectId, props.run.id, props.call.id])} {...props}/>;
}
