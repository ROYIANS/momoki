import {withThreadRunLock} from "../runtime/runOwnership";
import {agentExecution} from "../runtime/agentExecution";
import {useChatExecutionSession} from "./useChatExecutionSession";
import {ShotDetailLink} from "../../../app/details/ShotDetails";
import {Link} from "@tanstack/react-router";
import {ReferenceSourceLink} from "./ReferenceAttachments";
import {MemoryEditor} from "../../memory/ui/MemoryEditor";
import type {MemoryCandidate, MemorySourceRef, ProjectMemory} from "../../memory/models/projectMemory";
import {listMemoryCandidates} from "../../memory/commands/projectMemories";
import {MemoryPromotion} from "../../memory/ui/MemoryPromotion";
import {useCallback, useEffect, useRef, useState} from "react";
import {type ManualDraftDeparture, type ManualDraftState, useManualDraftDeparture} from "../../../app/drafts/useManualDraftGuard";
import {useProductQuery} from "../../../platform/product/queries";

import {
    ArrowUpRight,
    CheckCheck,
    ClipboardCheck,
    History,
    LoaderCircle,
    Pencil,
    Plus,
    RefreshCw,
    Sparkles,
    X
} from "../../../ui/icons";
import {toast} from "sonner";
import type {AgentReasoningEffort, AgentTask} from "../models/agent";
import type {ConnectorConfig} from "../../settings/models/connector";
import type {ChatModelMetadata} from "../../settings/models/modelMetadata";
import type {AgentTaskWrapup, TaskWrapupState, WrapupContent, WrapupEvidence} from "../models/agentTaskWrapup";
import {confirmWrapup, createManualWrapup, getTaskWrapupState, saveWrapup} from "../commands/agentTaskWrapups";
import {setAgentTaskLifecycle} from "../commands/agentTasks";
import {cancelTaskWrapup} from "../runtime/taskWrapup";
import {Button} from "../../../ui/button";
import {Textarea} from "../../../ui/textarea";
import {SidePanel} from "../../../app/layout/SidePanel";
import "./taskWrapup.css";

export type WrapupModelSelection = {
    connector: ConnectorConfig;
    model: string;
    modelMetadata?: ChatModelMetadata;
    reasoningEffort?: AgentReasoningEffort
};
type Props = {
    task: AgentTask;
    modelSelection?: WrapupModelSelection;
    busy: boolean;
    onEditingChange: (value: boolean) => void;
    onPendingChange: (value: boolean) => void;
    onDraftStateChange?: (state: ManualDraftState) => void;
    requestDeparture?: ManualDraftDeparture
};
type Section = "results" | "decisions" | "lessons" | "unresolved";
const SECTIONS: Array<{ key: Section; label: string; hint: string }> = [
    {key: "results", label: "交付成果", hint: "实际完成了什么，成果在哪里"},
    {key: "decisions", label: "决策与约束", hint: "保留后续工作需要遵循的选择"},
    {key: "lessons", label: "问题与经验", hint: "哪些方法有效，哪些问题值得记住"},
    {key: "unresolved", label: "未完成与下一步", hint: "仍待处理的事项；没有则留空"},
];
const OUTCOMES = {fact: "记录", downloaded: "已生成 · 未应用", applied: "已应用", unresolved: "待核实"};
const FINDINGS = {met: "符合要求", unmet: "尚未达到", review: "待检查"};
const dateLabel = (value: string) => new Date(value).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
});

function Sources({ids, evidence, selectable, onChange}: {
    ids: string[];
    evidence: WrapupEvidence[];
    selectable?: boolean;
    onChange?: (ids: string[]) => void
}) {
    if (!selectable && !ids.length) return null;
    return <details className="task-review-sources">
        <summary>{selectable ? "关联依据" : "查看依据"}<span>{ids.length}</span></summary>
        {selectable ? <div className="task-review-source-options">{evidence.length ? evidence.map((source) => <label
                key={source.id}><input type="checkbox" checked={ids.includes(source.id)}
                                       disabled={!ids.includes(source.id) && (!source.available || ids.length >= 12)}
                                       onChange={() => onChange?.(ids.includes(source.id) ? ids.filter((id) => id !== source.id) : [...ids, source.id])}/><span>{source.label}<small>{source.available ? OUTCOMES[source.outcome] : "已不可用"}</small></span></label>) :
            <p>尚无可关联的记录，可以先保存人工总结。</p>}</div> : ids.map((id) => {
            const source = evidence.find((entry) => entry.id === id);
            return <div className="task-review-source" key={id}>
                <div>
                    <span>{source?.label ?? "原始来源已不可用"}</span><small>{source?.available ? OUTCOMES[source.outcome] : "当前来源不可用"}</small>
                </div>
                {source?.available && source.reference &&
                    <ReferenceSourceLink projectId={source.reference.projectId} attachment={source.reference}
                                         label="查看参考资料"/>}{source?.available && source.href && /^\/(?!\/)/.test(source.href) &&
                <ShotDetailLink href={source.href}>打开成果<ArrowUpRight size={13}/></ShotDetailLink>}{source && <details>
                <summary>本版保存的记录</summary>
                <pre>{source.body}</pre>
            </details>}</div>;
        })}
    </details>;
}

function ReviewDocument({record, evidence, promotionPending, promotionDisabled, onPromote}: {
    record: AgentTaskWrapup;
    evidence: WrapupEvidence[];
    promotionPending: boolean;
    promotionDisabled: boolean;
    onPromote: (source: MemorySourceRef) => void
}) {
    const content = record.content;
    return <div className="task-review-document">
        <p className="task-review-overview">{content.overview || "尚未填写总结。"}</p>
        <section className="task-review-section">
            <h3>完成标准 <span>{content.acceptance.filter((item) => item.status === "met").length} / {content.acceptance.length}</span>
            </h3>{content.acceptance.length ? content.acceptance.map((finding) => <div className="task-review-finding"
                                                                                       key={finding.criterionIndex}>
                <div><span>{finding.criterion}</span><small
                    className={`is-${finding.status}`}>{FINDINGS[finding.status]}</small></div>
                {finding.note && <p>{finding.note}</p>}<Sources ids={finding.sourceIds} evidence={evidence}/></div>) :
            <p className="agent-task-muted">此任务未单独设置完成标准，请核对目标、成果与清单。</p>}</section>
        {SECTIONS.map(({key, label}) => <section key={key} className="task-review-section">
            <h3>{label}<span>{content[key].length}</span></h3>{content[key].length ? content[key].map((item, index) =>
                <div key={index} className="task-review-entry"><p>{item.text}</p><Sources ids={item.sourceIds}
                                                                                          evidence={evidence}/>{record.confirmedAt && (key === "decisions" || key === "lessons") &&
                    <MemoryPromotion onPromote={onPromote} pending={promotionPending} disabled={promotionDisabled} source={{
                        taskId: record.taskId,
                        summaryId: record.id,
                        summaryRevision: record.revision,
                        itemKind: key === "decisions" ? "decision" : "lesson",
                        itemIndex: index,
                        itemText: item.text
                    }}/>}</div>) :
            <p className="agent-task-muted">{key === "unresolved" ? "未列出待办事项。" : "尚未记录。"}</p>}</section>)}
    </div>;
}

export function TaskWrapup({
                               task,
                               modelSelection,
                               busy,
                               onEditingChange,
                               onPendingChange,
                               onDraftStateChange,
                               requestDeparture
                           }: Props) {
    const [readAttempt, setReadAttempt] = useState(0);
    const [lastRead, setLastRead] = useState<{ taskId: string; data: TaskWrapupState }>();
    const read = useProductQuery(async (db) => {
        try {
            return {taskId: task.id, data: await getTaskWrapupState(task.id, db), error: undefined};
        } catch (failure) {
            return {
                taskId: task.id,
                data: undefined,
                error: failure instanceof Error ? failure.message : "数据库读取失败"
            };
        }
    }, [task.id, readAttempt]);
    const currentRead = read?.taskId === task.id ? read : undefined;
    const state = currentRead?.data ?? (lastRead?.taskId === task.id ? lastRead.data : undefined);
    const readError = currentRead?.error;
    // Keep editors mounted through a live-query failure; stale evidence cannot be saved.
    useEffect(() => {
        if (currentRead?.data) setLastRead({taskId: task.id, data: currentRead.data});
    }, [currentRead, task.id]);
    const [draft, setDraft] = useState<{
        id: string;
        revision: number;
        content: WrapupContent;
        sources: WrapupEvidence[];
        record: AgentTaskWrapup;
        baseline: string;
        owner: { taskId: string; threadId: string; projectId: string }
    }>();
    const draftRef = useRef(draft);
    const lifetime = useRef({mounted: false, epoch: 0});
    const taskOwner = useRef(task);
    taskOwner.current = task;
    useEffect(() => {
        const session = lifetime.current;
        session.mounted = true;
        return () => {
            session.mounted = false;
            session.epoch++;
        };
    }, []);
    const [candidate, setCandidate] = useState<{ epoch: number; projectId: string; value: MemoryCandidate }>();
    const [candidatePending, setCandidatePending] = useState(false);
    const promotion = useRef<{ mounted: boolean; epoch: number; phase: "idle" | "preparing" | "editing" }>({
        mounted: false, epoch: 0, phase: "idle",
    });
    const promotionOwner = useRef({taskId: task.id, projectId: task.projectId});
    promotionOwner.current = {taskId: task.id, projectId: task.projectId};
    useEffect(() => {
        const session = promotion.current;
        session.mounted = true;
        return () => {
            session.mounted = false;
            session.epoch++;
            session.phase = "idle";
        };
    }, []);

    async function prepareMemory(source: MemorySourceRef) {
        const session = promotion.current;
        const owner = {taskId: task.id, projectId: task.projectId};
        if (!session.mounted || session.phase !== "idle" || candidate ||
            promotionOwner.current.taskId !== owner.taskId || promotionOwner.current.projectId !== owner.projectId ||
            source.taskId !== owner.taskId) return;
        // The ref locks immediately, including callbacks from a render before disabled updates.
        const epoch = ++session.epoch;
        session.phase = "preparing";
        onDraftStateChange?.(draftState());
        const frozenSource = structuredClone(source);
        setCandidatePending(true);
        const active = () => session.mounted && session.epoch === epoch && session.phase === "preparing" &&
            promotionOwner.current.taskId === owner.taskId && promotionOwner.current.projectId === owner.projectId;
        try {
            const candidates = await listMemoryCandidates(owner.projectId, frozenSource.taskId,
                frozenSource.summaryId, frozenSource.summaryRevision);
            if (!active()) return;
            const selected = candidates.find(item => item.ref.itemKind === frozenSource.itemKind &&
                item.ref.itemIndex === frozenSource.itemIndex && item.ref.itemText === frozenSource.itemText);
            if (!selected) throw new Error("这条总结来源已发生变化，请重新打开后再试");
            const frozenCandidate = structuredClone(selected);
            session.phase = "editing";
            setCandidate({epoch, projectId: owner.projectId, value: frozenCandidate});
        } catch (failure) {
            if (active()) toast.error(failure instanceof Error ? failure.message : "读取总结来源失败");
        } finally {
            if (session.mounted && session.epoch === epoch) {
                if (session.phase === "preparing") session.phase = "idle";
                setCandidatePending(false);
                onDraftStateChange?.(draftState());
            }
        }
    }

    function closeMemory(epoch: number) {
        const session = promotion.current;
        if (!session.mounted || session.epoch !== epoch || session.phase !== "editing") return false;
        session.epoch++;
        session.phase = "idle";
        setCandidate(undefined);
        setMemoryPending(false);
        return true;
    }

    const [savedMemory, setSavedMemory] = useState<ProjectMemory>();
    const [memoryPending, setMemoryPending] = useState(false);
    const [pending, setPending] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [error, setError] = useState("");
    const lock = useRef(false);
    const {snapshot: execution} = useChatExecutionSession(task.threadId, JSON.stringify([task.threadId, task.projectId]));
    const latest = state?.latest ?? draft?.record;
    const preparing = latest?.status === "preparing";
    const editable = !!currentRead?.data && !busy && !pending && !preparing && task.lifecycle === "open";
    const canGenerate = !!modelSelection?.connector.apiKey.trim() && !!modelSelection.model.trim();
    const draftState = useCallback((): ManualDraftState => {
        const dirty = !!draftRef.current && JSON.stringify(draftRef.current.content) !== draftRef.current.baseline;
        const pending = lock.current || promotion.current.phase === "preparing";
        // MemoryEditor owns its existing route blocker; local inspector departure still owns the candidate.
        return {
            dirty: dirty || promotion.current.phase === "editing",
            pending: pending || memoryPending || candidatePending,
            routeDirty: dirty,
            routePending: pending
        };
    }, [memoryPending, candidatePending]);
    const hasDraft = !!draft;
    const hasCandidate = !!candidate;
    useEffect(() => {
        onEditingChange(hasDraft || hasCandidate);
        return () => onEditingChange(false);
    }, [hasDraft, hasCandidate, onEditingChange]);
    useEffect(() => {
        onPendingChange(pending || memoryPending || candidatePending);
        onDraftStateChange?.(draftState());
        return () => onPendingChange(false);
    }, [pending, memoryPending, candidatePending, onPendingChange, onDraftStateChange, draftState]);

    function publishDraft(next: typeof draft) {
        draftRef.current = next;
        setDraft(next);
        onDraftStateChange?.(draftState());
    }

    const departure = useManualDraftDeparture(draftState().dirty, draftState().pending, () => {
    }, {
        readState: draftState, route: !onDraftStateChange,
    });

    function requestLocalDeparture(leave: () => void) {
        if (requestDeparture) requestDeparture(leave, () => {
        });
        else departure.requestDeparture(leave);
    }

    async function act(action: () => Promise<unknown>, success?: string) {
        if (lock.current || !currentRead?.data) return;
        lock.current = true;
        const session = lifetime.current;
        const epoch = ++session.epoch;
        const owner = {taskId: task.id, threadId: task.threadId, projectId: task.projectId};
        const active = () => session.mounted && session.epoch === epoch && taskOwner.current.id === owner.taskId &&
            taskOwner.current.threadId === owner.threadId && taskOwner.current.projectId === owner.projectId;
        setPending(true);
        onPendingChange(true);
        onDraftStateChange?.(draftState());
        setError("");
        try {
            await action();
            if (active() && success) toast.success(success);
        } catch (failure) {
            if (active()) setError(failure instanceof Error ? failure.message : "操作失败，请重试");
        } finally {
            if (active()) {
                lock.current = false;
                setPending(false);
                onPendingChange(false);
                onDraftStateChange?.(draftState());
            }
        }
    }

    async function manual() {
        await act(async () => {
            const record = await createManualWrapup(task.id);
            if (!lifetime.current.mounted || taskOwner.current.id !== record.taskId) return;
            publishDraft({
                baseline: JSON.stringify(record.content),
                owner: {taskId: task.id, threadId: task.threadId, projectId: task.projectId},
                id: record.id,
                revision: record.revision,
                content: structuredClone(record.content),
                sources: record.snapshot.evidence,
                record
            });
        });
    }

    function generate() {
        if (!modelSelection || !canGenerate || draftRef.current || lock.current) return;
        try {
            agentExecution.prepareTaskWrapup({threadId: task.threadId, taskId: task.id,
                connectorId: modelSelection.connector.id, model: modelSelection.model,
                reasoningEffort: modelSelection.reasoningEffort, modelMetadata: modelSelection.modelMetadata});
        } catch (failure) {setError(failure instanceof Error ? failure.message : "无法整理总结");}
    }

    function edit() {
        if (latest) {
            setError("");
            publishDraft({
                baseline: JSON.stringify(latest.content),
                owner: {taskId: task.id, threadId: task.threadId, projectId: task.projectId},
                id: latest.id,
                revision: latest.revision,
                content: structuredClone(latest.content),
                sources: latest.snapshot.evidence,
                record: latest
            });
        }
    }

    function change(content: WrapupContent) {
        if (!lock.current && draftRef.current) publishDraft({...draftRef.current, content});
    }

    function currentSources(sources: WrapupEvidence[]) {
        return sources.map((source) => {
            const current = state?.currentEvidence.find((item) => item.id === source.id);
            return current ? {...source, ...current, body: source.body} : {
                ...source,
                available: false,
                href: undefined
            };
        });
    }

    const evidence = draft ? currentSources(draft.sources) : latest ? currentSources(latest.snapshot.evidence) : [];
    return <div className="task-review" aria-label="任务验收总结">{departure.confirmation}
        <div className="task-review-heading">
            <div><span className="task-review-eyebrow">REVIEW & REFLECTION</span><h3>让这次工作，有一个清晰的收尾。</h3>
                <p>检查交付，留下决策与经验，再确认完成。</p></div>
            <ClipboardCheck size={24} aria-hidden/></div>
        {readError && <div className="task-review-error" role="alert">
            <p>暂时无法读取验收总结。{draft ? "你的草稿仍保留，恢复读取后可继续保存。" : "任务和对话仍可查看。"}</p>
            <details>
                <summary>查看错误详情</summary>
                <p>{readError}</p></details>
            <Button variant="outline" size="sm"
                    onClick={() => setReadAttempt((value) => value + 1)}>重新读取总结</Button></div>}
        {state === undefined ? !readError && <p className="agent-task-muted" role="status">正在读取总结…</p> : <>
            {!latest && <div className="task-review-start">
                <p>把已有成果与完成标准放在一起检查。也可以先保存阶段总结，之后再回来继续。</p>
                <div><Button disabled={!editable || !canGenerate} onClick={() => void generate()}><Sparkles/>AI 整理总结</Button><Button
                    variant="ghost" disabled={!editable} onClick={() => void manual()}><Pencil/>手动填写</Button></div>
                <small>{canGenerate ? `使用 ${modelSelection!.model} · 仅整理已有记录` : "尚未配置对话模型，仍可手动填写总结。"}</small>
            </div>}
            {latest && <>
                <div className="task-review-toolbar">
                    <span>{latest.confirmedAt ? "已确认" : preparing ? "整理中" : latest.status === "failed" ? "整理失败" : latest.status === "interrupted" ? "整理已中断" : "待你检查"}<small>版本 {latest.revision} · {latest.author === "ai" ? "AI 草稿" : "人工修订"}</small></span><Button
                    variant="ghost" size="icon-sm" aria-label="查看总结历史"
                    onClick={() => setHistoryOpen(true)}><History/></Button>{!draft && !preparing &&
                    <Button variant="ghost" size="sm"
                            disabled={!editable || state.stale || latest.status !== "draft" || !!latest.confirmedAt}
                            onClick={edit}><Pencil/>编辑</Button>}</div>
                {preparing &&
                    <div className="task-review-notice" role="status"><LoaderCircle className="task-review-spinner"
                                                                                    size={16}/><span>正在整理已有记录…<small>不会执行创作工具，之前的总结会保留。</small></span><Button
                        variant="ghost" size="sm" onClick={() => {
                        if (execution.token && execution.kind === "taskWrapup" && execution.wrapupId === latest.id &&
                            execution.work?.identity.kind === "taskWrapup" && execution.work.identity.taskId === task.id &&
                            agentExecution.requestStop({threadId: task.threadId, token: execution.token})) return;
                        void withThreadRunLock(task.threadId, () => cancelTaskWrapup(task.id, latest.id)).catch((failure: Error) => setError(failure.message));
                    }}>停止</Button></div>}
                {state.stale && <div className="task-review-notice"><RefreshCw
                    size={16}/><span>任务或来源已有变化<small>当前总结作为历史保留。请基于最新记录重新整理，再确认完成。</small></span>
                </div>}
                {(latest.status === "failed" || latest.status === "interrupted") && <div className="task-review-notice">
                    <span>{latest.error || "本次整理未完成，任务状态保持不变。"}<small>可以重新整理，也可以手动接着写。</small></span>
                </div>}
                <p className="task-review-coverage">本版参考 {latest.snapshot.coverage.included} / {latest.snapshot.coverage.total} 项记录{latest.snapshot.coverage.omitted > 0 ? ` · ${latest.snapshot.coverage.omitted} 项未纳入` : ""}{latest.snapshot.coverage.truncated > 0 ? ` · ${latest.snapshot.coverage.truncated} 项为摘录` : ""}。验收仍需要你的判断。</p>
                {draft ? <form className="task-review-editor" onSubmit={(event) => {
                    event.preventDefault();
                    void act(async () => {
                        const owner = draftRef.current;
                        if (!owner) return;
                        await saveWrapup(owner.owner.taskId, owner.id, structuredClone(owner.content), owner.revision);
                        if (lifetime.current.mounted && draftRef.current === owner) publishDraft(undefined);
                    }, "总结草稿已保存");
                }}>
                    <label className="agent-task-field">总结<Textarea autoFocus value={draft.content.overview} rows={4}
                                                                      maxLength={4000} disabled={pending}
                                                                      onChange={(event) => change({
                                                                          ...draft.content,
                                                                          overview: event.target.value
                                                                      })}
                                                                      placeholder="这次完成了什么，目前处于什么状态…"/></label>
                    <section className="task-review-section">
                        <h3>完成标准</h3>{draft.content.acceptance.length ? draft.content.acceptance.map((finding, index) =>
                            <div className="task-review-finding-editor" key={finding.criterionIndex}><label
                                className="agent-task-field">{finding.criterion}<select
                                aria-label={`验收：${finding.criterion}`} disabled={pending} value={finding.status}
                                onChange={(event) => change({
                                    ...draft.content,
                                    acceptance: draft.content.acceptance.map((item, at) => at === index ? {
                                        ...item,
                                        status: event.target.value as typeof finding.status
                                    } : item)
                                })}>{Object.entries(FINDINGS).map(([value, label]) => <option key={value}
                                                                                              value={value}>{label}</option>)}</select></label><Textarea
                                aria-label={`验收说明：${finding.criterion}`} placeholder="你的检查结果与判断依据…"
                                value={finding.note} rows={2} maxLength={2000} disabled={pending}
                                onChange={(event) => change({
                                    ...draft.content,
                                    acceptance: draft.content.acceptance.map((item, at) => at === index ? {
                                        ...item,
                                        note: event.target.value
                                    } : item)
                                })}/><Sources ids={finding.sourceIds} evidence={evidence} selectable={!pending}
                                              onChange={(sourceIds) => change({
                                                  ...draft.content,
                                                  acceptance: draft.content.acceptance.map((item, at) => at === index ? {
                                                      ...item,
                                                      sourceIds
                                                  } : item)
                                              })}/></div>) :
                        <p className="agent-task-muted">尚无独立完成标准，可回到概览补充。</p>}</section>
                    {SECTIONS.map(({key, label, hint}) => <section className="task-review-section" key={key}>
                        <div className="agent-task-section-heading"><h3>{label}</h3><Button type="button"
                                                                                            variant="ghost"
                                                                                            size="icon-sm"
                                                                                            aria-label={`添加${label}`}
                                                                                            disabled={pending || draft.content[key].length >= 20}
                                                                                            onClick={() => change({
                                                                                                ...draft.content,
                                                                                                [key]: [...draft.content[key], {
                                                                                                    text: "",
                                                                                                    sourceIds: []
                                                                                                }]
                                                                                            })}><Plus/></Button></div>
                        <p className="agent-task-muted">{hint}</p>{draft.content[key].map((entry, index) => <div
                        className="task-review-entry-editor" key={index}>
                        <div><Textarea aria-label={`${label} ${index + 1}`} rows={3} maxLength={2000} disabled={pending}
                                       value={entry.text} onChange={(event) => change({
                            ...draft.content,
                            [key]: draft.content[key].map((item, at) => at === index ? {
                                ...item,
                                text: event.target.value
                            } : item)
                        })}/><Button type="button" variant="ghost" size="icon-sm" disabled={pending}
                                     aria-label={`移除${label} ${index + 1}`} onClick={() => change({
                            ...draft.content,
                            [key]: draft.content[key].filter((_, at) => at !== index)
                        })}><X/></Button></div>
                        <Sources ids={entry.sourceIds} evidence={evidence} selectable={!pending}
                                 onChange={(sourceIds) => change({
                                     ...draft.content,
                                     [key]: draft.content[key].map((item, at) => at === index ? {
                                         ...item,
                                         sourceIds
                                     } : item)
                                 })}/></div>)}</section>)}
                    <div className="task-review-editor-actions"><Button type="button" variant="ghost" disabled={pending}
                                                                        onClick={() => requestLocalDeparture(() => {
                                                                            publishDraft(undefined);
                                                                            setError("");
                                                                        })}>取消编辑</Button><Button type="submit"
                                                                                                     disabled={!editable || !draft.content.overview.trim()}>{pending ? "保存中…" : "保存草稿"}</Button>
                    </div>
                </form> : <>
                    {latest.status === "draft" &&
                        <ReviewDocument onPromote={source => void prepareMemory(source)}
                                        promotionPending={candidatePending}
                                        promotionDisabled={candidatePending || !!candidate} record={latest}
                                        evidence={evidence}/>}
                    {state.confirmed && (latest.id !== state.confirmed.id || latest.revision !== state.confirmed.revision) &&
                        <details className="task-review-previous">
                            <summary>上次确认的总结 · {dateLabel(state.confirmed.confirmedAt!)}</summary>
                            <ReviewDocument onPromote={source => void prepareMemory(source)}
                                            promotionPending={candidatePending}
                                            promotionDisabled={candidatePending || !!candidate}
                                            record={state.confirmed}
                                            evidence={currentSources(state.confirmed.snapshot.evidence)}/></details>}
                    {!preparing && task.lifecycle === "open" && <div className="task-review-actions">
                        <div><Button variant="ghost" size="sm" disabled={!editable || !canGenerate}
                                     onClick={() => void generate()}><Sparkles/>{latest.status === "failed" || latest.status === "interrupted" ? "重新尝试" : "重新整理"}
                        </Button><Button variant="ghost" size="sm" disabled={!editable}
                                         onClick={() => void manual()}><Pencil/>{state.stale ? "基于最新记录填写" : "新建人工版本"}
                        </Button></div>
                        {!state.stale && latest.status === "draft" && !latest.confirmedAt &&
                            <Button disabled={!editable || !latest.content.overview.trim()}
                                    onClick={() => void act(() => confirmWrapup(task.id, latest.id, latest.revision), "总结已确认，任务尚未标记完成")}><CheckCheck/>确认这份总结</Button>}
                        {latest.confirmedAt && !state.stale &&
                            <Button disabled={!editable || state.completionBlockers.length > 0}
                                    onClick={() => void act(() => setAgentTaskLifecycle(task.id, "completed", {
                                        id: latest.id,
                                        revision: latest.revision
                                    }), "任务已确认完成")}><CheckCheck/>确认任务完成</Button>}
                        {state.completionBlockers.length > 0 &&
                            <div className="task-review-blockers"><span>完成前还需要</span>
                                <ul>{state.completionBlockers.map((reason, index) => <li
                                    key={index}>{reason}</li>)}</ul>
                            </div>}
                    </div>}
                </>}
            </>}
            {error && <p className="task-review-error" role="alert">{error}{draft ? "。编辑内容仍保留。" : ""}</p>}
        </>}
        {savedMemory && <p className="task-review-coverage">已保存在项目记忆中。<Link to="/p/$projectId/memory"
                                                                                     params={{projectId: task.projectId}}
                                                                                     search={{memory: savedMemory.id}}>查看“{savedMemory.title}”</Link>
        </p>}
        {candidate && <MemoryEditor key={candidate.epoch} projectId={task.projectId} initial={candidate.value.input}
                                    source={candidate.value.ref}
                                    sourceExcerpt={`${candidate.value.source.taskTitle} · 总结版本 ${candidate.value.ref.summaryRevision}\n${candidate.value.source.excerpt}`}
                                    onPendingChange={value => {
                                        if (promotion.current.mounted && promotion.current.epoch === candidate.epoch &&
                                            promotion.current.phase === "editing") setMemoryPending(value);
                                    }} onClose={() => closeMemory(candidate.epoch)}
                                    onSaved={(memory) => {
                                        if (memory.projectId === candidate.projectId && closeMemory(candidate.epoch))
                                            setSavedMemory(memory);
                                    }}/>}
        <SidePanel open={historyOpen} onOpenChange={setHistoryOpen} kind="wrapup-history" width={480} title="总结历史"
                   description="每次保存独立留存。旧总结仅供追溯，不代表当前工作已通过验收。">
            {state?.history.map((version) =>
            <details key={`${version.id}:${version.revision}`}>
                <summary>
                    <span>{version.confirmedAt ? "已确认" : version.status === "draft" ? "草稿" : version.status === "failed" ? "失败" : "中断"} · 版本 {version.revision}<small>{dateLabel(version.updatedAt)} · {version.author === "ai" ? "AI" : "人工"}</small></span>
                </summary>
                <ReviewDocument onPromote={source => void prepareMemory(source)} promotionPending={candidatePending}
                                promotionDisabled={candidatePending || !!candidate} record={version}
                                evidence={currentSources(version.snapshot.evidence)}/></details>)}
        </SidePanel>
    </div>;
}
