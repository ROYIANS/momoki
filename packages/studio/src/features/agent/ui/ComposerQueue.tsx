import {useState} from "react";
import {agentExecution} from "../runtime/agentExecution";
import type {AgentPendingInput} from "../models/agentPendingInput";
import {PendingInputConflictError} from "../commands/agentPendingInputs";
import {useComposerQueue} from "./useComposerQueue";
import {ArrowDown, ArrowUp, Check, CornerDownRight, ListTodo, Pencil, QueueList, Trash2, X} from "../../../ui/icons";
import {ComposerPanel, ComposerRow, MenuItem, RowAction, RowMenu} from "./ComposerPanel";

const STEER_HINT = "提交，但不中断模型运行";
const ATTACHMENT_STEER_HINT = "带资料的消息只能排队";
const STEERED_LABEL = "将在下一个 tool call 之后送达";

function cardText(item: AgentPendingInput): string {
    return item.source === "system" ? item.display?.trim() || item.content : item.content;
}

function failure(cause: unknown): string {
    return cause instanceof Error && cause.message ? cause.message : "操作失败，请重试";
}

/**
 * Durable pending-send rows attached above the composer. One row is one future turn; nothing here
 * interrupts the current run, and a row is only delivered by an explicit action or the service drain.
 */
export function ComposerQueue({threadId, active}: {threadId: string; active: boolean}) {
    const view = useComposerQueue({threadId, active});
    const [editing, setEditing] = useState<{id: string; revision: number; value: string}>();
    const [menu, setMenu] = useState<string>();
    const [error, setError] = useState<string>();
    if (view.status !== "ready") return null;
    const {mode, items} = view;
    // A card that was delivered or removed elsewhere still reports why its action failed.
    if (!items.length) return error ? <ComposerPanel label="待发送消息" note={error} noteRole="alert">{null}</ComposerPanel> : null;
    // A stopped/failed queue, an idle one and work the next send would end may all be sent explicitly.
    // Only an approval wait keeps the row back, because that run is still going to continue on its own.
    const canDispatch = mode !== "blocked" || view.blocked === "resume";
    const note = error ?? view.notice;

    async function apply(operation: () => Promise<unknown>) {
        try {
            await operation();
            setError(undefined);
        } catch (cause) {
            // A card delivered or removed elsewhere reports itself gone; it is never resurrected here.
            setError(cause instanceof PendingInputConflictError && cause.reason === "gone"
                ? "该消息已送出或被删除" : failure(cause));
        }
    }
    function remove(item: AgentPendingInput) {
        void apply(() => agentExecution.removePending({id: item.id, expectedRevision: item.revision}));
    }
    function dispatch(item: AgentPendingInput) {
        try {
            const handle = agentExecution.dispatchPending({threadId, id: item.id});
            void handle.done.catch(cause => setError(failure(cause)));
            setError(agentExecution.snapshot(threadId).error);
        } catch (cause) {
            setError(failure(cause));
        }
    }
    function save() {
        if (!editing) return;
        const target = editing;
        void apply(async () => {
            await agentExecution.editPending({id: target.id, expectedRevision: target.revision, content: target.value});
            setEditing(undefined);
        });
    }

    return <ComposerPanel label="待发送消息" className="agent-composer-queue" data-mode={mode}
                          note={note} noteRole={error ? "alert" : "status"}>
        {items.map(item => {
            const system = item.source === "system";
            const attachments = item.attachments?.length ?? 0;
            const dispatchLabel = view.blocked === "resume" ? "结束上次执行并发送" : "立即发送";
            const data = {"data-source": item.source, "data-status": item.status, "data-mode": mode} as const;
            const removeLabel = `删除 ${cardText(item).slice(0, 20)}`;
            if (editing?.id === item.id) {
                return <ComposerRow key={item.id} icon={<Pencil size={16}/>} className="agent-composer-queue-card" {...data}
                                    actions={<>
                                        <RowAction icon={<Check size={16} aria-hidden/>} ariaLabel="保存" primary onClick={save}/>
                                        <RowAction icon={<X size={16} aria-hidden/>} ariaLabel="取消" onClick={() => setEditing(undefined)}/>
                                    </>}>
                    <div className="composer-row-edit">
                        <textarea aria-label="编辑待发送消息" rows={2} value={editing.value}
                                  onChange={event => setEditing({...editing, value: event.target.value})}
                                  onKeyDown={event => {
                                      if (event.key === "Escape") setEditing(undefined);
                                      if (event.key === "Enter" && !event.shiftKey) {
                                          event.preventDefault();
                                          save();
                                      }
                                  }}/>
                    </div>
                </ComposerRow>;
            }
            const tags = <>
                {system ? <span className="composer-row-tag">系统事件</span> : null}
                {attachments ? <span className="composer-row-tag">{`含 ${attachments} 份资料`}</span> : null}
                {item.status === "held" ? <span className="composer-row-tag">{item.heldReason === "uncertain" ? "发送未确认" : "已停止"}</span> : null}
                {item.mode === "next-step" && item.status === "queued" ?
                    <span className="composer-row-tag agent-composer-queue-steered">{STEERED_LABEL}</span> : null}
                {item.lastError ? <span className="composer-row-tag" data-tone="warn" title={item.lastError}>{item.lastError}</span> : null}
            </>;
            const send = <RowAction icon={<ArrowUp size={16} aria-hidden/>} label={dispatchLabel} primary
                                    disabled={system && mode === "running" || mode === "blocked" && !canDispatch}
                                    title={system && mode === "running" ? "本轮结束后会自动继续"
                                        : mode === "blocked" && !canDispatch ? "等待审批，处理完成后再继续" : undefined}
                                    onClick={() => dispatch(item)}/>;
            const rowMenu = <RowMenu open={menu === item.id}
                                                           onOpenChange={open => setMenu(open ? item.id : undefined)}>
                <MenuItem icon={<Pencil size={14} aria-hidden/>} label="编辑" onClick={() => {
                    setMenu(undefined);
                    setEditing({id: item.id, revision: item.revision, value: item.content});
                }}/>
                <MenuItem icon={<ArrowUp size={14} aria-hidden/>} label="上移" onClick={() => {
                    setMenu(undefined);
                    void apply(() => agentExecution.movePending({id: item.id, direction: "up"}));
                }}/>
                <MenuItem icon={<ArrowDown size={14} aria-hidden/>} label="下移" onClick={() => {
                    setMenu(undefined);
                    void apply(() => agentExecution.movePending({id: item.id, direction: "down"}));
                }}/>
            </RowMenu>;
            const trash = <RowAction icon={<Trash2 size={16} aria-hidden/>} ariaLabel={removeLabel} onClick={() => remove(item)}/>;
            let actions;
            if (system) {
                actions = <>
                    {send}
                    <RowAction icon={<X size={16} aria-hidden/>} ariaLabel="取消继续" onClick={() => remove(item)}/>
                </>;
            } else if (mode === "running") {
                actions = <>
                    <RowAction icon={<CornerDownRight size={16} aria-hidden/>} label="引导" disabled={attachments > 0}
                               title={attachments ? ATTACHMENT_STEER_HINT : STEER_HINT}
                               onClick={() => void apply(() => agentExecution.setPendingMode({id: item.id,
                                   expectedRevision: item.revision, mode: "next-step"}))}/>
                    {trash}{rowMenu}
                </>;
            } else {
                actions = <>{canDispatch ? send : null}{trash}{rowMenu}</>;
            }
            return <ComposerRow key={item.id} icon={system ? <ListTodo size={16}/> : <QueueList size={16}/>}
                                className="agent-composer-queue-card" actions={actions} {...data}>
                <span className="composer-row-text" title={cardText(item)}>{cardText(item)}</span>
                {tags}
            </ComposerRow>;
        })}
    </ComposerPanel>;
}
