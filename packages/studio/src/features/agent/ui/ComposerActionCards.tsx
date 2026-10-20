import {useState} from "react";
import {MODEL_STEPS_PER_SEGMENT} from "../models/agent";
import type {RunAction} from "../models/chatRunAction";
import {useComposerActions, type ApprovalCardData, type RecoveryCardData} from "./useComposerActions";
import {Check, Hand, Pause, Play, ShieldAlert, ShieldCheck, Square, X} from "../../../ui/icons";
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

function RecoveryRow({card, busy, onRunAction}: {card: RecoveryCardData; busy: boolean; onRunAction: OnRunAction}) {
    const {run, state} = card;
    const resumeTitle = state.budgetPaused ? `继续执行 · 最多 ${MODEL_STEPS_PER_SEGMENT} 轮` : "从已保存的步骤继续";
    return <ComposerRow className="agent-composer-action-card" data-kind="recovery"
                        icon={state.unknown ? <Hand size={16}/> : <Pause size={16}/>}
                        actions={<>
                            {state.canResume ? <RowAction icon={<Play size={16} aria-hidden/>} label="继续" primary disabled={busy}
                                                          title={resumeTitle} onClick={() => onRunAction(run.id, "resume")}/> : null}
                            <RowAction icon={<X size={16} aria-hidden/>} label="结束" disabled={busy}
                                       title="结束本次执行" onClick={() => onRunAction(run.id, "cancel")}/>
                        </>}>
        <span className="composer-row-lead">{state.budgetPaused ? "执行已暂停" : state.unknown ? "有操作结果待核实" : "执行未完成"}</span>
        <span className="composer-row-quiet">
            {state.unknown ? "请先核实未确认的操作，再决定是否继续" : state.budgetPaused ? `可继续，最多再跑 ${MODEL_STEPS_PER_SEGMENT} 轮` : "已保存的步骤不会丢失"}
        </span>
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
    // Approvals of one run are decided in order; later ones appear after the first is answered.
    const visible = cards.filter(card => card.kind !== "approval" || card.position === 1);
    if (!visible.length) return null;
    return <ComposerPanel label="待你处理" className="agent-composer-action-cards">
        {visible.map(card => card.kind === "approval"
            ? <ApprovalRow key={card.call.id} card={card} busy={busy} onRunAction={onRunAction}/>
            : <RecoveryRow key={`recovery:${card.run.id}`} card={card} busy={busy} onRunAction={onRunAction}/>)}
    </ComposerPanel>;
}
