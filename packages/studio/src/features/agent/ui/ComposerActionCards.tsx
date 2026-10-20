import {useState} from "react";
import type {RunAction} from "../models/chatRunAction";
import {useComposerActions, type ApprovalCardData, type BatchCardData} from "./useComposerActions";
import {Check, ChevronRight, Images, Pause, Play, ShieldAlert, ShieldCheck, Square, Undo2, X} from "../../../ui/icons";
import {applyBatchSelections, retryFailedBatch} from "../commands/agentGenerationBatches";
import {batchUserAction, startGenerationBatch, stopGenerationBatch} from "../../video/agent/generationBatchRuntime";
import {type AgentActivityTarget, useAgentActivityNavigation} from "./AgentActivityNavigation";
import {agentExecution} from "../runtime/agentExecution";
import {ComposerPanel, ComposerRow, MenuItem, RowAction, RowMenu} from "./ComposerPanel";

type OnRunAction = (runId: string, action: RunAction, callId?: string) => void;

function previewLine(card: ApprovalCardData): string {
    const preview = card.call.generationOverride?.preview ?? card.call.preview;
    return (preview?.summary || preview?.target?.label || card.call.title).replace(/\s+/g, " ").trim();
}

function ApprovalRow({card, busy, onRunAction}: {card: ApprovalCardData; busy: boolean; onRunAction: OnRunAction}) {
    const [menu, setMenu] = useState(false);
    const {run, call} = card;
    const preview = call.generationOverride?.preview ?? call.preview;
    const risky = Boolean(call.highRisk);
    return <ComposerRow className="agent-composer-action-card" data-kind="approval" data-high-risk={risky ? "true" : undefined}
                        icon={risky ? <ShieldAlert size={16}/> : <ShieldCheck size={16}/>} tone={risky ? "warn" : undefined}
                        actions={<>
                            <RowAction icon={<Check size={16} aria-hidden/>} label="批准" primary disabled={busy}
                                       title={`批准：${call.title}`} onClick={() => onRunAction(run.id, "approve", call.id)}/>
                            <RowAction icon={<X size={16} aria-hidden/>} label="拒绝" disabled={busy}
                                       title={`拒绝：${call.title}`} onClick={() => onRunAction(run.id, "reject", call.id)}/>
                            <RowMenu open={menu} onOpenChange={setMenu}>
                                <MenuItem icon={<Square size={14} aria-hidden/>} label="结束本次执行" disabled={busy}
                                          onClick={() => {setMenu(false); onRunAction(run.id, "cancel");}}/>
                            </RowMenu>
                        </>}>
        <span className="composer-row-lead">{`等待批准 · ${call.title}`}</span>
        <span className="composer-row-quiet" title={preview?.changes.slice(0, 3).join("；") || undefined}>{previewLine(card)}</span>
        {card.total > 1 ? <span className="composer-row-tag">{`${card.position}/${card.total}`}</span> : null}
        {risky ? <span className="composer-row-tag" data-tone="warn">高风险操作</span> : null}
    </ComposerRow>;
}

function batchSummary(card: BatchCardData): string {
    if (card.draft) return "待确认，确认后才会向供应商提交";
    if (card.pendingWrites > 0) return `已选 ${card.selectedCount} 个目标，待写入`;
    if (card.running) return `生成中 · ${card.downloaded}/${card.batch.confirmedItemIds.length} 份已保存`;
    if (card.queued > 0 || card.active > 0) return card.unknown ? "提交未确认，可查询进度" : `已暂停 · 还有 ${card.queued + card.active} 份未完成`;
    if (card.failed > 0) return `${card.failed} 份生成失败`;
    return `${card.downloaded} 份结果可以审阅`;
}

function BatchRow({card, onReveal}: {card: BatchCardData; onReveal: (target: AgentActivityTarget) => void}) {
    const [menu, setMenu] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string>();
    const {batch} = card;
    const threadId = batch.threadId;
    const resumable = !card.running && !card.draft && (card.queued > 0 || card.active > 0);
    async function run(work: () => Promise<void>) {
        if (pending) return;
        setPending(true);
        setError(undefined);
        setMenu(false);
        try {await work();} catch (cause) {setError(cause instanceof Error ? cause.message : "操作失败，请重试");}
        finally {setPending(false);}
    }
    const review = () => {setMenu(false); onReveal({runId: batch.runId, batchId: batch.id});};
    const pause = () => void run(() => stopGenerationBatch(batch.id, threadId, "pause"));
    // Starting is a long-lived worker, not an awaited step; failures surface here, progress shows in the summary.
    const resume = () => {setMenu(false); setError(undefined); void startGenerationBatch(batch.id, threadId).catch(cause =>
        setError(cause instanceof Error ? cause.message : "操作失败，请重试"));};
    const cancelRest = () => void run(() => stopGenerationBatch(batch.id, threadId, "cancel"));
    const retryFailed = () => void run(async () => {await batchUserAction(batch.id, () => retryFailedBatch(batch.id, threadId));});
    const write = () => void run(async () => {
        const result = await batchUserAction(batch.id, () => applyBatchSelections(batch.id, threadId));
        const missed = result.filter(item => !item.applied);
        if (missed.length) setError(`${missed.length} 个目标未写入：${missed[0].error ?? "目标已被修改"}`);
        // The adoption queued a continuation for the agent; start it now if the conversation is free.
        if (result.some(item => item.applied)) void agentExecution.drainQueue(threadId).catch(() => undefined);
    });
    const canAct = !card.readOnly && !pending;
    const writeLabel = `写入 ${card.pendingWrites} 个目标`;
    const resumeLabel = card.unknown || batch.status === "cancelled" ? "查询进度" : "继续";
    // One primary action per state: what the user most likely needs to do next.
    const primary = card.draft ? "review" : card.pendingWrites > 0 && !card.readOnly ? "write"
        : card.running && !card.readOnly ? "pause" : resumable && !card.readOnly ? "resume" : "review";
    return <ComposerRow className="agent-composer-action-card" data-kind="batch" icon={<Images size={16}/>}
                        tone={error ? "warn" : undefined}
                        actions={<>
                            {primary === "review" && <RowAction icon={<ChevronRight size={16} aria-hidden/>} label={card.draft ? "审阅并确认" : "审阅"}
                                                                primary title={`打开批量生成：${batch.title}`} onClick={review}/>}
                            {primary === "write" && <RowAction icon={<Check size={16} aria-hidden/>} label="写入" primary disabled={!canAct}
                                                               title={writeLabel} onClick={write}/>}
                            {primary === "pause" && <RowAction icon={<Pause size={16} aria-hidden/>} label="暂停" primary disabled={!canAct}
                                                               title="暂停队列" onClick={pause}/>}
                            {primary === "resume" && <RowAction icon={<Play size={16} aria-hidden/>} label={resumeLabel} primary disabled={!canAct}
                                                                title={resumeLabel} onClick={resume}/>}
                            <RowMenu open={menu} onOpenChange={setMenu}>
                                {primary !== "review" && <MenuItem icon={<ChevronRight size={14} aria-hidden/>} label="审阅" onClick={review}/>}
                                {card.running && primary !== "pause" && canAct ? <MenuItem icon={<Pause size={14} aria-hidden/>} label="暂停队列" onClick={pause}/> : null}
                                {resumable && primary !== "resume" && canAct ? <MenuItem icon={<Play size={14} aria-hidden/>} label={resumeLabel} onClick={resume}/> : null}
                                {card.pendingWrites > 0 && primary !== "write" && canAct ? <MenuItem icon={<Check size={14} aria-hidden/>} label={writeLabel} onClick={write}/> : null}
                                {card.queued > 0 && canAct ? <MenuItem icon={<X size={14} aria-hidden/>} label={`取消剩余 ${card.queued} 份`} onClick={cancelRest}/> : null}
                                {card.failed > 0 && canAct ? <MenuItem icon={<Undo2 size={14} aria-hidden/>} label="为失败项新建草稿" onClick={retryFailed}/> : null}
                            </RowMenu>
                        </>}>
        <span className="composer-row-lead">{batch.title}</span>
        <span className="composer-row-quiet">{batchSummary(card)}</span>
        {error ? <span className="composer-row-tag" data-tone="warn" role="alert" title={error}>{error}</span> : null}
    </ComposerRow>;
}

/**
 * Decision rows attached above the composer: a row executes its action directly, through the same
 * run-action handler the message area used before. One approval is shown at a time, in saved order.
 */
export function ComposerActionCards({threadId, busy, readOnly, onRunAction}: {
    threadId: string; busy: boolean; readOnly?: boolean; onRunAction: OnRunAction;
}) {
    const cards = useComposerActions({threadId, readOnly});
    const {reveal} = useAgentActivityNavigation();
    // Approvals of one run are decided in order; later ones appear after the first is answered.
    const visible = cards.filter(card => card.kind !== "approval" || card.position === 1);
    if (!visible.length) return null;
    return <ComposerPanel label="待你处理" className="agent-composer-action-cards">
        {visible.map(card => card.kind === "approval"
            ? <ApprovalRow key={card.call.id} card={card} busy={busy} onRunAction={onRunAction}/>
            : <BatchRow key={`batch:${card.batch.id}`} card={card} onReveal={reveal}/>)}
    </ComposerPanel>;
}
