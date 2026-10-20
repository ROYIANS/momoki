import {useProductQuery} from "../../../platform/product/queries";
import {useCallback, useEffect, useRef, useState} from "react";
import {type ManualDraftDeparture, type ManualDraftState, useManualDraftDeparture} from "../../../app/drafts/useManualDraftGuard";
import {
    Archive,
    ArrowLeft,
    Check,
    ChevronDown,
    Circle,
    ClipboardCheck,
    ListTodo,
    Pencil,
    Pin,
    Plus,
    RotateCcw,
    Sparkles,
    X
} from "../../../ui/icons";
import {toast} from "sonner";
import type {AgentPlanItem, AgentRun, AgentTask} from "../models/agent";
import type {ChatMessage} from "../models/chat";
import {pinAgentTaskResult, setAgentTaskLifecycle, unpinAgentTaskResult, updateAgentTask} from "../commands/agentTasks";
import {getTaskDisplayState, isTaskBusy, TASK_STATE_LABELS} from "../runtime/taskState";
import {Button} from "../../../ui/button";
import {
    ContextPanel,
    ContextPanelContent,
    ContextPanelDescription,
    ContextPanelHeader,
    ContextPanelHeaderActions,
    ContextPanelTitle
} from "../../../app/layout/context-panel";
import {SidePanel} from "../../../app/layout/SidePanel";
import {Input} from "../../../ui/input";
import {Textarea} from "../../../ui/textarea";
import {TaskRecords} from "./TaskRecords";
import {TaskWrapup, type WrapupModelSelection} from "./TaskWrapup";
import "./taskWorkspace.css";

type InspectorProps = {
    projectName?: string;
    projectUnavailable?: boolean;
    summaryModel?: WrapupModelSelection;
    task: AgentTask;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onOpenBoard: () => void;
    onDepartureReady?: (request: ManualDraftDeparture | undefined) => void;
};
const RUN_LABELS: Record<AgentRun["status"], string> = {
    running: "执行中",
    waiting_approval: "等待批准",
    completed: "已回复",
    failed: "执行失败",
    cancelled: "已停止",
    interrupted: "执行中断"
};
const dateLabel = (value: string) => new Date(value).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
});

export function TaskInspector(props: InspectorProps) {
    const [owner, setOwner] = useState(props);
    const [session, setSession] = useState(0);
    const sameOwner = owner.task.id === props.task.id && owner.task.threadId === props.task.threadId && owner.task.projectId === props.task.projectId && (!owner.open || props.open);
    const shown = sameOwner ? props : owner;
    const latest = useRef(shown);
    latest.current = shown;
    const [state, setState] = useState<ManualDraftState>({dirty: false, pending: false});
    const stateRef = useRef(state);
    const updateState = useCallback((next: ManualDraftState) => {
        stateRef.current = next;
        setState(next);
    }, []);
    const departure = useManualDraftDeparture(state.dirty, state.pending, () => {
        updateState({dirty: false, pending: false});
        setSession(value => value + 1);
    }, {readState: () => stateRef.current});
    const {requestDeparture} = departure;
    const requestedOwner = `${props.task.id}:${props.task.threadId}:${props.task.projectId}:${props.open}`;
    const attempted = useRef(requestedOwner);
    const onDepartureReady = props.onDepartureReady;
    useEffect(() => {
        onDepartureReady?.(requestDeparture);
        return () => onDepartureReady?.(undefined);
    }, [onDepartureReady, requestDeparture]);
    useEffect(() => {
        if (sameOwner) {
            attempted.current = requestedOwner;
            setOwner(latest.current);
            return;
        }
        if (attempted.current === requestedOwner) return;
        attempted.current = requestedOwner;
        requestDeparture(() => {
            updateState({dirty: false, pending: false});
            setOwner(props);
        });
    }, [sameOwner, props, requestedOwner, requestDeparture, updateState]);
    const reading = useProductQuery(async tx => ({threadId: shown.task.threadId,
        runs: await tx.agentRuns.where("threadId").equals(shown.task.threadId).sortBy("createdAt"),
        messages: await tx.chatMessages.where("threadId").equals(shown.task.threadId).sortBy("createdAt"),
    }), [shown.task.threadId]);
    return <>{departure.confirmation}<TaskInspectorContent
        key={`${shown.task.id}:${shown.task.threadId}:${shown.task.projectId}:${session}`}
        {...shown} runs={reading?.threadId === shown.task.threadId ? reading.runs : []}
        messages={reading?.threadId === shown.task.threadId ? reading.messages : []} requestDeparture={requestDeparture} onDraftStateChange={updateState}/></>;
}

function TaskInspectorContent({
                                  task,
                                  runs,
                                  messages,
                                  open,
                                  onOpenChange,
                                  onOpenBoard,
                                  summaryModel,
                                  projectName,
                                  projectUnavailable,
                                  requestDeparture,
                                  onDraftStateChange,
                              }: InspectorProps & {runs: AgentRun[]; messages: ChatMessage[];
    requestDeparture: ManualDraftDeparture;
    onDraftStateChange: (state: ManualDraftState) => void
}) {
    const [editor, setEditor] = useState<"goal" | "plan" | null>(null);
    const [tab, setTab] = useState<"overview" | "records" | "wrapup">("overview");
    const [reviewEditing, setReviewEditing] = useState(false);
    const [reviewPending, setReviewPending] = useState(false);
    const [criteria, setCriteria] = useState("");
    const [editRevision, setEditRevision] = useState(1);
    const [title, setTitle] = useState("");
    const [goal, setGoal] = useState("");
    const [planText, setPlanText] = useState("");
    const [pending, setPending] = useState(false);
    const lock = useRef(false);
    const active = useRef(true);
    useEffect(() => {
        active.current = true;
        return () => {
            active.current = false;
        };
    }, []);
    const baseline = useRef("");
    const childStates = useRef<{ records: ManualDraftState; wrapup: ManualDraftState }>({
        records: {
            dirty: false,
            pending: false
        }, wrapup: {dirty: false, pending: false}
    });
    const ownState = useRef<ManualDraftState>({dirty: false, pending: false});
    ownState.current = {
        dirty: editor !== null && JSON.stringify(editor === "goal" ? [title, goal, criteria] : planText) !== baseline.current,
        pending: lock.current
    };
    const publishState = useCallback(() => {
        const children = childStates.current;
        onDraftStateChange({
            dirty: ownState.current.dirty || children.records.dirty || children.wrapup.dirty,
            pending: ownState.current.pending || children.records.pending || children.wrapup.pending,
            routeDirty: ownState.current.dirty || (children.records.routeDirty ?? children.records.dirty) || (children.wrapup.routeDirty ?? children.wrapup.dirty),
            routePending: ownState.current.pending || (children.records.routePending ?? children.records.pending) || (children.wrapup.routePending ?? children.wrapup.pending)
        });
    }, [onDraftStateChange]);
    const recordState = useCallback((state: ManualDraftState) => {
        childStates.current.records = state;
        publishState();
    }, [publishState]);
    const wrapupState = useCallback((state: ManualDraftState) => {
        childStates.current.wrapup = state;
        publishState();
    }, [publishState]);
    useEffect(publishState, [editor, title, goal, criteria, planText, pending, publishState]);
    const threadRuns = runs.filter((run) => run.threadId === task.threadId);
    const taskRuns = threadRuns.filter((run) => run.taskId === task.id);
    const state = getTaskDisplayState(task, taskRuns);
    const busy = isTaskBusy(threadRuns);
    const editable = !projectUnavailable && !busy && !reviewPending && task.lifecycle === "open" && !pending;
    const completed = task.plan.filter((step) => step.status === "completed").length;
    const orderedRuns = [...taskRuns].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const outputs = orderedRuns.flatMap((run) => {
        const message = messages.find((item) => item.id === run.assistantMessageId && item.threadId === task.threadId && item.role === "assistant" && item.runId === run.id && item.status === "complete" && item.content.trim());
        return run.taskId === task.id && run.status === "completed" && message ? [{run, message}] : [];
    });

    async function mutate(action: () => Promise<unknown>, success?: string, after?: () => void) {
        if (lock.current) return;
        lock.current = true;
        ownState.current.pending = true;
        publishState();
        setPending(true);
        try {
            await action();
            if (!active.current) return;
            after?.();
            if (success) toast.success(success);
        } catch (error) {
            if (active.current) toast.error(error instanceof Error ? error.message : "保存失败，请重试");
        } finally {
            lock.current = false;
            ownState.current.pending = false;
            if (active.current) {
                publishState();
                setPending(false);
            }
        }
    }

    function editGoal() {
        baseline.current = JSON.stringify([task.title, task.goal, (task.acceptanceCriteria ?? []).join("\n")]);
        setTitle(task.title);
        setGoal(task.goal);
        setCriteria((task.acceptanceCriteria ?? []).join("\n"));
        setEditRevision(task.revision ?? 1);
        setEditor("goal");
    }

    function editPlan() {
        setEditRevision(task.revision ?? 1);
        baseline.current = JSON.stringify(task.plan.map((item) => item.title).join("\n"));
        setPlanText(task.plan.map((item) => item.title).join("\n"));
        setEditor("plan");
    }

    function savePlan() {
        // Consume matches once: duplicate titles retain their own IDs when reordered.
        const remaining = [...task.plan];
        const plan: AgentPlanItem[] = planText.split("\n").map((line) => line.trim()).filter(Boolean).map((title) => {
            const index = remaining.findIndex((item) => item.title === title);
            return index >= 0 ? remaining.splice(index, 1)[0] : {id: crypto.randomUUID(), title, status: "pending"};
        });
        void mutate(() => updateAgentTask(task.id, {plan}, editRevision), "执行清单已保存", () => setEditor(null));
    }

    return <ContextPanel kind="task" open={open}
                         onRequestDeparture={(proceed, cancel) => requestDeparture(proceed, undefined, cancel)}
                         onOpenChange={(next) => {
                             onOpenChange(next);
                         }}>
        <ContextPanelContent className="agent-chat-root css-var-agent-chat agent-task-inspector"
                             showCloseButton={false}>
            {/* The back action lives in the top bar's panel zone, next to the shared close button. */}
            <ContextPanelHeaderActions><Button variant="ghost" size="sm" disabled={pending || reviewPending}
                                               onClick={() => requestDeparture(onOpenBoard)}><ArrowLeft/>任务工作台</Button></ContextPanelHeaderActions>
            <div className="agent-task-inspector-scroll">
                <ContextPanelHeader className="agent-task-inspector-heading"><span
                    className={`agent-task-status is-${state}`}>{TASK_STATE_LABELS[state]}</span><ContextPanelTitle>{task.title}</ContextPanelTitle><ContextPanelDescription><Sparkles
                    size={14} aria-hidden/>{projectName ?? "项目不可用"} ·
                    小光点<span>更新于 {dateLabel(task.updatedAt)}</span></ContextPanelDescription></ContextPanelHeader>
                {projectUnavailable && <div className="agent-task-notice">所属项目已不可用，历史记录仍可查看。</div>}
                {busy &&
                    <div className="agent-task-notice">执行尚未结束。请在对话中处理批准、停止或恢复操作，再编辑任务。</div>}
                {state === "review" && <div className="agent-task-notice">请检查成果与清单，由你确认任务完成。</div>}
                <div className="agent-task-inspector-tabs" aria-label="任务详情视图">
                    <button type="button" disabled={reviewEditing || reviewPending} aria-pressed={tab === "overview"}
                            onClick={() => setTab("overview")}>概览
                    </button>
                    <button type="button" disabled={reviewEditing || reviewPending} aria-pressed={tab === "records"}
                            onClick={() => setTab("records")}>工作记录
                    </button>
                    <button type="button" aria-pressed={tab === "wrapup"} onClick={() => setTab("wrapup")}>验收总结
                    </button>
                </div>
                <div hidden={tab !== "wrapup"}><TaskWrapup task={task} modelSelection={summaryModel}
                                                           busy={Boolean(projectUnavailable) || busy || pending}
                                                           onEditingChange={setReviewEditing}
                                                           onPendingChange={setReviewPending}
                                                           onDraftStateChange={wrapupState}
                                                           requestDeparture={requestDeparture}/></div>
                <div hidden={tab !== "records"}><TaskRecords task={task} messages={messages} editable={editable}
                                                             onDraftStateChange={recordState}
                                                             requestDeparture={requestDeparture}/></div>
                <div hidden={tab !== "overview"}>
                    <section className="agent-task-section">
                        <div className="agent-task-section-heading"><h3>任务目标</h3><Button variant="ghost"
                                                                                             size="icon-sm"
                                                                                             aria-label="编辑任务目标"
                                                                                             disabled={!editable}
                                                                                             onClick={editGoal}><Pencil/></Button>
                        </div>
                        <p className="agent-task-goal">{task.goal}</p>{!!task.acceptanceCriteria?.length &&
                        <div className="agent-task-acceptance"><h4>完成标准</h4>
                            <ul>{task.acceptanceCriteria.map((criterion, index) => <li
                                key={index}>{criterion}</li>)}</ul>
                        </div>}</section>
                    <section className="agent-task-section">
                        <div className="agent-task-section-heading">
                            <h3>执行清单 <span>{completed} / {task.plan.length}</span></h3><Button variant="ghost"
                                                                                                   size="sm"
                                                                                                   disabled={!editable}
                                                                                                   onClick={editPlan}>{task.plan.length ?
                            <Pencil/> : <Plus/>}{task.plan.length ? "编辑" : "添加步骤"}</Button></div>
                        {task.plan.length ? <>
                                <div className="agent-task-progress" role="progressbar" aria-label="任务步骤完成进度"
                                     aria-valuemin={0} aria-valuemax={task.plan.length} aria-valuenow={completed}><span
                                    style={{width: `${completed / task.plan.length * 100}%`}}/></div>
                                <ol className="agent-task-checklist">{task.plan.map((step) => <li key={step.id}
                                                                                                  className={step.status === "completed" ? "is-completed" : ""}>
                                    <button type="button" role="checkbox" aria-checked={step.status === "completed"}
                                            aria-label={step.title} disabled={!editable}
                                            onClick={() => void mutate(() => updateAgentTask(task.id, {
                                                plan: task.plan.map((item) => item.id === step.id ? {
                                                    ...item,
                                                    status: item.status === "completed" ? "pending" : "completed"
                                                } : item)
                                            }, task.revision ?? 1))}>{step.status === "completed" ?
                                        <Check size={14}/> : step.status === "in_progress" ?
                                            <span className="agent-task-step-active"/> : null}</button>
                                    <span>{step.title}{step.status === "in_progress" && <small>进行中</small>}</span>
                                </li>)}</ol>
                            </> :
                            <p className="agent-task-muted">把目标拆成几个可执行的步骤，也可以在对话中请助手帮你规划。</p>}
                    </section>
                    <section className="agent-task-section">
                        <div className="agent-task-section-heading"><h3>任务成果 <span>{task.artifacts.length}</span>
                        </h3><Pin size={16} className="agent-task-muted" aria-hidden/></div>
                        {task.artifacts.length === 0 &&
                            <p className="agent-task-muted">将有价值的完整回复保留在这里，方便随时回看。</p>}
                        {task.artifacts.map((artifact, index) => {
                            const message = messages.find((item) => item.id === artifact.messageId);
                            return <div key={artifact.id} className="agent-task-result">
                                <details>
                                    <summary><Pin size={14}
                                                  aria-hidden/><span>成果 {index + 1}<small>{dateLabel(artifact.createdAt)}</small></span><ChevronDown
                                        size={14}/></summary>
                                    <p>{message?.content ?? "这条回复已不可用"}</p></details>
                                <Button variant="ghost" size="icon-sm" aria-label={`移除成果 ${index + 1}`}
                                        disabled={!editable}
                                        onClick={() => void mutate(() => unpinAgentTaskResult(task.id, artifact.id), "已从成果中移除")}><X/></Button>
                            </div>;
                        })}
                        {outputs.some(({message}) => !task.artifacts.some((artifact) => artifact.messageId === message.id)) &&
                            <details className="agent-task-output-picker">
                                <summary><Plus size={14}/>从完整回复中添加</summary>
                                {outputs.filter(({message}) => !task.artifacts.some((artifact) => artifact.messageId === message.id)).map(({
                                                                                                                                               run,
                                                                                                                                               message
                                                                                                                                           }) =>
                                    <div key={run.id}>
                                        <span><small>{dateLabel(run.createdAt)}</small><p>{message.content.slice(0, 160)}</p></span><Button
                                        variant="ghost" size="icon-sm"
                                        aria-label={`保留 ${dateLabel(run.createdAt)} 的回复为成果`}
                                        disabled={!editable}
                                        onClick={() => void mutate(() => pinAgentTaskResult(task.id, run.id), "已保留为任务成果")}><Pin/></Button>
                                    </div>)}</details>}
                    </section>
                    <section className="agent-task-section">
                        <div className="agent-task-section-heading"><h3>执行记录 <span>{taskRuns.length}</span></h3>
                            <ListTodo size={16} className="agent-task-muted" aria-hidden/></div>
                        {orderedRuns.length ?
                            <ol className="agent-task-history">{orderedRuns.map((run) => <li key={run.id}><Circle
                                size={8} aria-hidden/>
                                <div>
                                    <span>{RUN_LABELS[run.status]}</span><small>{run.model} · {dateLabel(run.createdAt)}</small>{run.retryOfRunId &&
                                    <small>继续尝试</small>}</div>
                            </li>)}</ol> :
                            <p className="agent-task-muted">还没有执行记录。在对话中发送目标，即可开始。</p>}</section>
                </div>
            </div>
            <footer className="agent-task-inspector-footer">
                {task.lifecycle === "open" ? <><Button variant="ghost"
                                                       disabled={projectUnavailable || busy || pending || reviewPending || reviewEditing}
                                                       onClick={() => void mutate(() => setAgentTaskLifecycle(task.id, "archived"), "任务已归档", () => onOpenChange(false))}><Archive/>归档</Button>{tab !== "wrapup" ?
                    <Button disabled={projectUnavailable || busy || pending || reviewPending}
                            onClick={() => setTab("wrapup")}><ClipboardCheck/>检查并收尾</Button> :
                    <span className="agent-task-muted">由你检查并确认完成</span>}</> : <><span
                    className="agent-task-muted">{task.lifecycle === "completed" ? <Button variant="ghost"
                                                                                           disabled={projectUnavailable || busy || pending || reviewPending || reviewEditing}
                                                                                           onClick={() => void mutate(() => setAgentTaskLifecycle(task.id, "archived"), "任务已归档", () => onOpenChange(false))}><Archive/>归档</Button> : "已归档"}</span><Button
                    disabled={projectUnavailable || busy || pending || reviewPending || reviewEditing}
                    onClick={() => void mutate(() => setAgentTaskLifecycle(task.id, "open"), "任务已重新打开")}><RotateCcw/>重新打开</Button></>}
            </footer>
            <SidePanel open={editor !== null} onOpenChange={(next) => {
                if (!next) requestDeparture(() => setEditor(null), () => {
                });
            }} kind="task-editor" width={460} title={editor === "goal" ? "编辑任务目标" : "编辑执行清单"}
                       description={editor === "goal" ? "清晰的目标和完成标准，帮助每一次执行保持方向。" : "每行一个步骤，调整行的顺序即可排序。修改名称会将该步骤重置为待完成。"}
                       footer={<><Button type="button" variant="ghost" disabled={pending}
                                          onClick={() => requestDeparture(() => setEditor(null), () => {
                                          })}>取消</Button><Button type="submit" form="task-editor-form"
                                                                   disabled={!editable || (editor === "goal" && (!title.trim() || !goal.trim()))}>{pending ? "保存中…" : "保存"}</Button></>}>
                <form id="task-editor-form" onSubmit={(event) => {
                    event.preventDefault();
                    if (editor === "goal") void mutate(() => updateAgentTask(task.id, {
                        title: title.trim(),
                        goal: goal.trim(),
                        acceptanceCriteria: criteria.split("\n").map((line) => line.trim()).filter(Boolean)
                    }, editRevision), "任务目标已保存", () => setEditor(null)); else savePlan();
                }}>
                    {editor === "goal" ? <><label className="agent-task-field">任务名称<Input autoFocus value={title}
                                                                                              maxLength={120} required
                                                                                              disabled={pending}
                                                                                              onChange={(event) => {
                                                                                                  ownState.current.dirty = JSON.stringify([event.target.value, goal, criteria]) !== baseline.current;
                                                                                                  publishState();
                                                                                                  setTitle(event.target.value);
                                                                                              }}/></label><label
                            className="agent-task-field">任务目标<Textarea value={goal} maxLength={20_000} required rows={6}
                                                                           disabled={pending}
                                                                           onChange={(event) => {
                                                                               ownState.current.dirty = JSON.stringify([title, event.target.value, criteria]) !== baseline.current;
                                                                               publishState();
                                                                               setGoal(event.target.value);
                                                                           }}/></label><label
                            className="agent-task-field">完成标准<Textarea value={criteria} rows={4} disabled={pending}
                                                                           onChange={(event) => {
                                                                               ownState.current.dirty = JSON.stringify([title, goal, event.target.value]) !== baseline.current;
                                                                               publishState();
                                                                               setCriteria(event.target.value);
                                                                           }}
                                                                           placeholder="每行一项，写下如何判断任务已经完成"/></label></> :
                        <label className="agent-task-field">步骤<Textarea autoFocus value={planText} rows={9}
                                                                          disabled={pending}
                                                                          onChange={(event) => {
                                                                              ownState.current.dirty = JSON.stringify(event.target.value) !== baseline.current;
                                                                              publishState();
                                                                              setPlanText(event.target.value);
                                                                          }}
                                                                          placeholder={"明确故事主题\n完善人物关系\n确认最终设定"}/></label>}
                </form>
            </SidePanel>
        </ContextPanelContent>
    </ContextPanel>;
}
