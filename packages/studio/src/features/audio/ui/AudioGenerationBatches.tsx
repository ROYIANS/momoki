import {useEffect, useState} from "react";
import {useProductQuery} from "../../../platform/product/queries";
import {toast} from "sonner";
import {Button} from "../../../ui/button";
import {Checkbox} from "../../../ui/checkbox";
import {SidePanel} from "../../../app/layout/SidePanel";
import {useAutoOpenPanel} from "../../../app/layout/autoOpen";
import type {AudioProjectSnapshot} from "../models/audio";
import type {AudioBatchItemState} from "../models/audioGenerationBatch";
import {AUDIO_BATCH_LIMIT} from "../models/audioGenerationBatch";
import {
    confirmAudioGenerationBatch,
    includeAudioBatchItem,
    prepareAudioGenerationBatch,
    readAudioGenerationBatch,
    retryFailedAudioBatch
} from "../commands/batches";
import {
    audioBatchUserAction,
    reconcileAudioBatchHistory,
    recoverAudioGenerationBatch,
    startAudioGenerationBatch,
    stopAudioGenerationBatch
} from "../generation/batchRuntime";
import {flushPendingDrafts} from "../../../platform/product/drafts";
import {speakerSpeechProfile} from "../generation/defaults";
import {MIMO_MODELS} from "../providers/mimoSpeech";

const LABELS: Record<AudioBatchItemState, string> = {
    draft: "待确认", queued: "待发送", submitting: "正在提交", pending: "等待结果", saved: "已保存", failed: "失败",
    uncertain: "未确认提交", cancelled: "已取消", recovery: "待保存", unavailable: "不可用"
};
const message = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请重试";

function AudioBatchPanel({projectId, batchId}: { projectId: string; batchId: string }) {
    const view = useProductQuery(async (db) => await db.audioGenerationBatches.get(batchId) ? await readAudioGenerationBatch(projectId, batchId, db) : null, [projectId, batchId]);
    const [reviewOpen, setReviewOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [retryIds, setRetryIds] = useState<string[]>([]);
    const needsReview = !view?.batch.dormant && view?.batch.status === "draft";
    // A prepared batch asks to be checked and confirmed: offer the panel once, without taking focus.
    const reviewOpenChange = useAutoOpenPanel({key: needsReview ? `audio-batch:${batchId}` : undefined, ready: needsReview, open: reviewOpen, width: 480, setOpen: setReviewOpen});
    const abandonedCandidate = !view?.batch.dormant && view?.batch.status === "running" ? batchId : undefined;
    useEffect(() => {
        if (!abandonedCandidate) return;
        // Ownership refusal is visible; a live tab's queue must never be silently taken over.
        void reconcileAudioBatchHistory(projectId, abandonedCandidate).catch(cause => setError(message(cause)));
    }, [projectId, abandonedCandidate]);

    async function act(action: () => Promise<unknown>) {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
            await action();
        } catch (cause) {
            setError(message(cause));
        } finally {
            setBusy(false);
        }
    }

    if (view === undefined) return <p className="text-sm text-muted-foreground">加载批量配音…</p>;
    if (view === null) return <p className="text-sm text-muted-foreground">批次已删除</p>;
    const {batch, rows, counts} = view;
    const included = rows.filter(row => row.item.included);
    const retryable = rows.filter(row => row.job?.status === "failed" && row.job.failureStage === "provider" && !row.job.results.length);
    const start = () => {
        void startAudioGenerationBatch(projectId, batchId, batch.owner.kind === "agent" ? {agentThreadId: batch.owner.threadId} : {}).catch(cause => setError(message(cause)));
    };
    return <section className="min-w-0 border-t py-4 text-sm" aria-label="批量配音进度">
        <div className="flex flex-wrap items-center gap-2"><strong
            className="min-w-0 break-words">{batch.title}</strong>
            <span
                className="text-muted-foreground">{included.length} 段 · 已保存 {counts.saved} · 失败 {counts.failed} · 待处理 {(counts.queued ?? 0) + (counts.submitting ?? 0) + (counts.pending ?? 0) + (counts.recovery ?? 0) + (counts.uncertain ?? 0)}</span>
        </div>
        {batch.pauseReason && <p className="mt-1 break-words text-muted-foreground">{batch.pauseReason}</p>}
        {batch.dormant ? <p className="mt-1 text-muted-foreground">导入的历史批次，只供查看。</p> :
            <div className="mt-2 flex flex-wrap gap-2">
                {batch.status === "draft" &&
                    <Button size="sm" disabled={busy} onClick={() => setReviewOpen(true)}>核对并确认</Button>}
                {["ready", "paused"].includes(batch.status) &&
                    <Button size="sm" disabled={busy || counts.uncertain > 0} onClick={start}>继续未发送项</Button>}
                {batch.status === "running" && <Button size="sm" variant="outline" disabled={busy}
                                                       onClick={() => void act(() => stopAudioGenerationBatch(projectId, batchId, "pause"))}>暂停</Button>}
                {!["settled", "cancelled"].includes(batch.status) && <Button size="sm" variant="ghost" disabled={busy}
                                                                             onClick={() => void act(() => stopAudioGenerationBatch(projectId, batchId, "cancel"))}>取消未发送项</Button>}
                {(counts.recovery > 0 || counts.pending > 0 || counts.uncertain > 0) &&
                    <Button size="sm" variant="outline" disabled={busy}
                            onClick={() => void act(() => recoverAudioGenerationBatch(projectId, batchId))}>恢复已有结果</Button>}
            </div>}
        {error && <p role="alert" className="mt-2 break-words text-destructive">{error}</p>}
        <details className="mt-2">
            <summary className="cursor-pointer">查看各段进度与失败项</summary>
            <ol className="mt-2 space-y-2">{rows.map(row => <li key={row.item.id} className="min-w-0">
                <div
                    className="flex items-start gap-2">{!batch.dormant && retryable.some(item => item.item.id === row.item.id) &&
                    <Checkbox aria-label={`重试：${row.item.snapshot.input.text.slice(0, 24)}`}
                              checked={retryIds.includes(row.item.id)}
                              onCheckedChange={checked => setRetryIds(current => checked === true ? [...current, row.item.id] : current.filter(id => id !== row.item.id))}/>}
                    <span
                        className="min-w-0 break-words">{row.item.order + 1}. {row.item.snapshot.input.text.slice(0, 100)}</span><span
                        className="shrink-0 text-muted-foreground">{LABELS[row.state]}</span></div>
                {row.state === "saved" &&
                    <p className="text-xs text-muted-foreground">{row.selected ? "已选用" : "未选用"} · {row.placed ? "已入轨" : "未入轨"} ·
                        本面板未试听</p>}
                {row.job?.error && <p className="break-words text-xs text-destructive">{row.job.error}</p>}
            </li>)}</ol>
            {!batch.dormant && retryable.length > 0 &&
                <Button size="sm" className="mt-3" variant="outline" disabled={busy || !retryIds.length}
                        onClick={() => void act(async () => {
                            await audioBatchUserAction(projectId, batchId, () => retryFailedAudioBatch(projectId, batchId, retryIds));
                            setRetryIds([]);
                            toast.success("已准备失败项草稿，请核对并重新确认");
                        })}>为选中失败项准备新草稿</Button>}
            <p className="mt-2 text-xs text-muted-foreground">暂停或取消不会删除已提交的任务和已有音频。</p>
        </details>
        <SidePanel open={reviewOpen} onOpenChange={reviewOpenChange} kind="audio-batch-review" title="确认批量配音" width={480}
                   description={`${included.length} 段，最多 ${included.length} 次付费请求；供应商按实际请求计费。本批最多同时发送 2 条，不自动选用或入轨。`}
                   footer={<><Button variant="outline" onClick={() => setReviewOpen(false)}>暂不发送</Button><Button
                       disabled={busy || !included.length || batch.status !== "draft"} onClick={() => void act(async () => {
                       await flushPendingDrafts(projectId);
                       await audioBatchUserAction(projectId, batchId, () => confirmAudioGenerationBatch(projectId, batchId, batch.revision));
                       setReviewOpen(false);
                       start();
                   })}>确认并开始 {included.length} 段</Button></>}>
            <div className="space-y-3">{rows.map(row => <label key={row.item.id} className="flex min-w-0 items-start gap-3">
                <Checkbox aria-label={`包含：${row.item.snapshot.input.text.slice(0, 24)}`}
                          disabled={busy || batch.status !== "draft"} checked={row.item.included}
                          onCheckedChange={checked => void act(() => audioBatchUserAction(projectId, batchId, () => includeAudioBatchItem(projectId, batchId, batch.revision, row.item.id, checked === true)))}/>
                <span className="min-w-0"><span
                    className="block whitespace-pre-wrap break-words">{row.item.snapshot.input.text}</span>
                    <span
                        className="text-xs text-muted-foreground">{row.item.snapshot.connector.provider} · {row.item.snapshot.input.voice} · 语速 {row.item.snapshot.input.speed}</span>
                    <details className="text-xs text-muted-foreground"><summary>音色和连接详情</summary>
                        <p>模型 {row.item.snapshot.input.mimo ? MIMO_MODELS[row.item.snapshot.input.mimo.mode] : "gpt-4o-mini-tts"} · {row.item.snapshot.input.mimo?.mode === "clone" ? "克隆音色" : row.item.snapshot.input.mimo?.mode === "design" ? "设计音色" : "预置音色"}</p>
                        <p className="whitespace-pre-wrap break-words">音色或演绎说明：{row.item.snapshot.input.mimo?.instruction || "未添加说明，使用保存的音色配置"}</p>
                        <p>{row.item.snapshot.input.mimo?.optimizeTextPreview ? "已允许供应商优化文本" : "保留原始文本"}</p>
                        <p className="break-all">连接 {row.item.snapshot.connector.id} · {row.item.snapshot.connector.baseUrl}</p>
                        {row.item.snapshot.speakerId &&
                            <p className="break-all">保存的角色音色 {row.item.snapshot.speakerId}</p>}
                        {row.item.snapshot.input.mimo?.mode === "clone" && <div>
                            <p>克隆参考已冻结；确认前可在声音工作区检查对应参考文件。</p>
                            <p className="break-all">参考文件 {row.item.snapshot.input.mimo.referenceMediaId}</p>
                            <p className="break-all">参考字节
                                SHA-256：{row.item.snapshot.referenceFingerprint ?? "缺少参考指纹，请重新准备"}</p>
                        </div>}
                        {row.item.snapshot.input.mimo && <pre
                            className="whitespace-pre-wrap break-all">{JSON.stringify(row.item.snapshot.input.mimo, null, 2)}</pre>}
                    </details></span>
            </label>)}{error && <p role="alert" className="break-words text-destructive">{error}</p>}</div>
        </SidePanel>
    </section>;
}

export function AudioBatchActions({projectId, chapterId, snapshot}: {
    projectId: string;
    chapterId: string;
    snapshot: AudioProjectSnapshot
}) {
    const [open, setOpen] = useState(false), [chosen, setChosen] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
    const segments = snapshot.segments.filter(segment => segment.chapterId === chapterId && segment.text.trim());
    return <><Button size="sm" variant="ghost" disabled={!segments.length} onClick={() => {
        setChosen(segments.filter(segment => !snapshot.takes.some(take => take.segmentId === segment.id)).map(segment => segment.id));
        setError("");
        setOpen(true);
    }}>批量配音</Button><SidePanel open={open} onOpenChange={next => setOpen(next)} kind="audio-batch-select" title="选择本批段落" width={440}
        description="默认包含没有声音版本的段落。每批 1–20 段；继承已保存角色音色，准备好后在右侧核对实际请求再确认付费。"
        footer={<><Button variant="outline" onClick={() => setOpen(false)}>取消</Button><Button
            disabled={busy || chosen.length < 1 || chosen.length > AUDIO_BATCH_LIMIT} onClick={() => {
            setBusy(true);
            setError("");
            void flushPendingDrafts(projectId).then(() => prepareAudioGenerationBatch({
                projectId,
                chapterId,
                segmentIds: segments.filter(segment => chosen.includes(segment.id)).map(segment => segment.id)
            })).then(() => setOpen(false)).catch(cause => setError(message(cause))).finally(() => setBusy(false));
        }}>准备 {chosen.length} 段请求</Button></>}>
        <div className="space-y-3">{segments.map(segment => {
            const speaker = snapshot.speakers.find(row => row.id === segment.speakerId);
            return <label key={segment.id} className="flex min-w-0 items-start gap-3"><Checkbox
                aria-label={`包含：${segment.text.slice(0, 24)}`} checked={chosen.includes(segment.id)}
                onCheckedChange={checked => setChosen(current => checked === true ? [...current, segment.id] : current.filter(id => id !== segment.id))}/><span
                className="min-w-0 whitespace-pre-wrap break-words">{segment.text}<span
                className="block text-xs text-muted-foreground">{speaker?.name ?? "默认音色"} · {speakerSpeechProfile(speaker).voice}</span></span></label>;
        })}{error && <p role="alert" className="break-words text-destructive">{error}</p>}
            {chosen.length > AUDIO_BATCH_LIMIT &&
                <p role="alert" className="text-destructive">每批最多 20 段，请选择一个明确子集。</p>}</div>
    </SidePanel></>;
}

export function AudioChapterBatches({projectId, chapterId}: { projectId: string; chapterId: string }) {
    const batches = useProductQuery((db) => db.audioGenerationBatches.where("chapterId").equals(chapterId).filter(batch => batch.projectId === projectId).reverse().sortBy("createdAt"), [projectId, chapterId]);
    return <div className="space-y-2">{batches?.slice(0, 20).map(batch => <AudioBatchPanel key={batch.id}
                                                                                           projectId={projectId}
                                                                                           batchId={batch.id}/>)}{batches && batches.length > 20 &&
        <p className="text-xs text-muted-foreground">显示最近 20 批，另有 {batches.length - 20} 批历史记录。</p>}</div>;
}

export function AgentAudioBatches({runId}: { runId: string }) {
    const batches = useProductQuery((db) => db.audioGenerationBatches.where("owner.runId").equals(runId).sortBy("createdAt"), [runId]);
    return <div className="space-y-2">{batches?.slice(0, 20).map(batch => <AudioBatchPanel key={batch.id}
                                                                                           projectId={batch.projectId}
                                                                                           batchId={batch.id}/>)}{batches && batches.length > 20 &&
        <p className="text-xs text-muted-foreground">显示 20 批，另有 {batches.length - 20} 批历史记录。</p>}</div>;
}
