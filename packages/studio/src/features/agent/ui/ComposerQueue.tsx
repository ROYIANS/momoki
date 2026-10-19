import {useState} from "react";
import {agentExecution} from "../runtime/agentExecution";
import type {AgentPendingInput} from "../models/agentPendingInput";
import {PendingInputConflictError} from "../commands/agentPendingInputs";
import {useComposerQueue} from "./useComposerQueue";
import {ArrowDown, ArrowUp, MoreHorizontal, X} from "../../../ui/icons";
import "./composerQueue.css";

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
 * Durable pending-send cards attached above the composer. One card is one future turn; nothing here
 * interrupts the current run, and a card is only delivered by an explicit action or the service drain.
 */
export function ComposerQueue({threadId, active}: {threadId: string; active: boolean}) {
    const view = useComposerQueue({threadId, active});
    const [editing, setEditing] = useState<{id: string; revision: number; value: string}>();
    const [menu, setMenu] = useState<string>();
    const [error, setError] = useState<string>();
    if (view.status !== "ready") return null;
    const {mode, items} = view;
    // A card that was delivered or removed elsewhere still reports why its action failed.
    if (!items.length) return error ? <section className="agent-composer-queue" aria-label="待发送消息">
        <p className="agent-composer-queue-error" role="alert">{error}</p>
    </section> : null;
    // A stopped/failed queue, an idle one and work the next send would end may all be sent explicitly.
    // Only an approval wait keeps the card back, because that run is still going to continue on its own.
    const canDispatch = mode !== "blocked" || view.blocked === "resume";

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

    return <section className="agent-composer-queue" aria-label="待发送消息" data-mode={mode}>
        {view.notice && <p className="agent-composer-queue-notice" role="status">{view.notice}</p>}
        {error && <p className="agent-composer-queue-error" role="alert">{error}</p>}
        <ul className="agent-composer-queue-list">
            {items.map(item => {
                const system = item.source === "system";
                const editingThis = editing?.id === item.id;
                const dispatchLabel = view.blocked === "resume" ? "结束上次执行并发送" : "立即发送";
                return <li key={item.id} className="agent-composer-queue-card" data-source={item.source}
                           data-status={item.status} data-mode={mode}>
                    {editingThis ? <div className="agent-composer-queue-edit">
                        <textarea aria-label="编辑待发送消息" rows={2} value={editing.value}
                                  onChange={event => setEditing({...editing, value: event.target.value})}
                                  onKeyDown={event => {
                                      if (event.key === "Escape") setEditing(undefined);
                                      if (event.key === "Enter" && !event.shiftKey) {
                                          event.preventDefault();
                                          save();
                                      }
                                  }}/>
                        <div className="agent-composer-queue-actions">
                            <button type="button" onClick={save}>保存</button>
                            <button type="button" onClick={() => setEditing(undefined)}>取消</button>
                        </div>
                    </div> : <>
                        <p className="agent-composer-queue-text">{cardText(item)}</p>
                        <div className="agent-composer-queue-meta">
                            {system ? <span>系统事件</span> : null}
                            {item.attachments?.length ? <span>{`含 ${item.attachments.length} 份资料`}</span> : null}
                            {item.status === "held" ? <span>{item.heldReason === "uncertain" ? "发送未确认" : "已停止"}</span> : null}
                            {item.mode === "next-step" && item.status === "queued" ?
                                <span className="agent-composer-queue-steered">{STEERED_LABEL}</span> : null}
                            {item.lastError ?
                                <span className="agent-composer-queue-last-error" title={item.lastError}>{item.lastError}</span> : null}
                        </div>
                    </>}
                    {!editingThis && mode === "running" && <div className="agent-composer-queue-actions">
                        {system ? <>
                            <button type="button" className="is-primary" disabled title="本轮结束后会自动继续">立即发送</button>
                            <button type="button" onClick={() => remove(item)}>取消继续</button>
                        </> : <>
                            <button type="button" disabled={Boolean(item.attachments?.length)}
                                    title={item.attachments?.length ? ATTACHMENT_STEER_HINT : STEER_HINT}
                                    onClick={() => void apply(() => agentExecution.setPendingMode({id: item.id,
                                        expectedRevision: item.revision, mode: "next-step"}))}>引导</button>
                            <button type="button" aria-label={`删除 ${cardText(item).slice(0, 20)}`}
                                    onClick={() => remove(item)}>删除</button>
                            <button type="button" aria-label="更多" aria-expanded={menu === item.id}
                                    onClick={() => setMenu(menu === item.id ? undefined : item.id)}>
                                <MoreHorizontal size={16} aria-hidden/>更多
                            </button>
                            {menu === item.id && <div className="agent-composer-queue-menu" role="menu">
                                <button type="button" role="menuitem" onClick={() => {
                                    setMenu(undefined);
                                    setEditing({id: item.id, revision: item.revision, value: item.content});
                                }}>编辑</button>
                                <button type="button" role="menuitem" onClick={() => {
                                    setMenu(undefined);
                                    void apply(() => agentExecution.movePending({id: item.id, direction: "up"}));
                                }}><ArrowUp size={14} aria-hidden/>上移</button>
                                <button type="button" role="menuitem" onClick={() => {
                                    setMenu(undefined);
                                    void apply(() => agentExecution.movePending({id: item.id, direction: "down"}));
                                }}><ArrowDown size={14} aria-hidden/>下移</button>
                                <button type="button" role="menuitem" onClick={() => setMenu(undefined)}>
                                    <X size={14} aria-hidden/>收起
                                </button>
                            </div>}
                        </>}
                    </div>}
                    {!editingThis && mode === "paused" && <div className="agent-composer-queue-actions">
                        {system ? <>
                            <button type="button" className="is-primary" onClick={() => dispatch(item)}>{dispatchLabel}</button>
                            <button type="button" onClick={() => remove(item)}>取消继续</button>
                        </> : <>
                            <button type="button" className="is-primary" onClick={() => dispatch(item)}>{dispatchLabel}</button>
                            <button type="button" onClick={() => setEditing({id: item.id, revision: item.revision, value: item.content})}>编辑</button>
                            <button type="button" aria-label={`删除 ${cardText(item).slice(0, 20)}`}
                                    onClick={() => remove(item)}>删除</button>
                        </>}
                    </div>}
                    {!editingThis && mode === "idle" && <div className="agent-composer-queue-actions">
                        {system ? <>
                            <button type="button" className="is-primary" onClick={() => dispatch(item)}>立即发送</button>
                            <button type="button" onClick={() => remove(item)}>取消继续</button>
                        </> : <>
                            <button type="button" className="is-primary" onClick={() => dispatch(item)}>立即发送</button>
                            <button type="button" onClick={() => setEditing({id: item.id, revision: item.revision, value: item.content})}>编辑</button>
                            <button type="button" aria-label={`删除 ${cardText(item).slice(0, 20)}`}
                                    onClick={() => remove(item)}>删除</button>
                        </>}
                    </div>}
                    {!editingThis && mode === "blocked" && <div className="agent-composer-queue-actions">
                        {system ? <>
                            <button type="button" className="is-primary" disabled={!canDispatch}
                                    title={canDispatch ? undefined : "等待审批，处理完成后再继续"}
                                    onClick={() => dispatch(item)}>{dispatchLabel}</button>
                            <button type="button" onClick={() => remove(item)}>取消继续</button>
                        </> : canDispatch ? <>
                            <button type="button" className="is-primary" onClick={() => dispatch(item)}>{dispatchLabel}</button>
                            <button type="button" onClick={() => setEditing({id: item.id, revision: item.revision, value: item.content})}>编辑</button>
                            <button type="button" aria-label={`删除 ${cardText(item).slice(0, 20)}`}
                                    onClick={() => remove(item)}>删除</button>
                        </> : <button type="button" aria-label={`删除 ${cardText(item).slice(0, 20)}`}
                                      onClick={() => remove(item)}>删除</button>}
                    </div>}
                </li>;
            })}
        </ul>
    </section>;
}
