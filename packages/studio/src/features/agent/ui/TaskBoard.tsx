import {ModuleLayout} from "../../../app/layout/ModuleLayout";
import {useMemo, useRef, useState} from "react";
import {ArrowUpRight, Check, ListTodo, Plus, Search, Sparkles} from "../../../ui/icons";
import {toast} from "sonner";
import type {AgentRun, AgentTask} from "../models/agent";
import type {Id} from "../../../platform/identity";
import type {Project} from "../../projects/models/project";
import {createAgentTask} from "../commands/agentTasks";
import {getTaskDisplayState, TASK_STATE_LABELS} from "../runtime/taskState";
import {Button} from "../../../ui/button";
import {SidePanel} from "../../../app/layout/SidePanel";
import {Input} from "../../../ui/input";
import {Textarea} from "../../../ui/textarea";
import {PageHeader, PageState, PageToolbar} from "../../../app/layout/PageLayout";
import {ProjectPicker} from "./ProjectPicker";
import "./taskWorkspace.css";
import "./composerControls.css";

type BoardFilter = "active" | "all" | "archived";
const COLUMNS = [
    {id: "pending", label: "待开始", hint: "把想法变成清晰的目标", states: ["pending"]},
    {id: "running", label: "进行中", hint: "围绕目标，逐步推进", states: ["running"]},
    {
        id: "attention",
        label: "待处理",
        hint: "检查结果，或接续执行",
        states: ["approval", "interrupted", "failed", "cancelled", "review"]
    },
    {id: "done", label: "已完成", hint: "经过你确认的成果", states: ["completed", "archived"]},
];

export function TaskBoard({tasks, runs, projects, onOpenTask, onBack}: {
    tasks: AgentTask[] | undefined; runs: AgentRun[] | undefined; projects: Project[];
    onOpenTask: (task: AgentTask) => void; onBack: () => void;
}) {
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<BoardFilter>("active");
    const [creating, setCreating] = useState(false);
    const [title, setTitle] = useState("");
    const [goal, setGoal] = useState("");
    const [saving, setSaving] = useState(false);
    const [projectId, setProjectId] = useState<Id>();
    const [filterProjectId, setFilterProjectId] = useState<Id>();
    const saveLock = useRef(false);
    const ready = tasks !== undefined && runs !== undefined;
    const entries = useMemo(() => {
        const grouped = new Map<string, AgentRun[]>();
        for (const run of runs ?? []) grouped.set(run.threadId, [...(grouped.get(run.threadId) ?? []), run]);
        return (tasks ?? []).map((task) => ({task, state: getTaskDisplayState(task, grouped.get(task.threadId) ?? [])}))
            .sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));
    }, [tasks, runs]);
    const scoped = entries.filter(({task}) => !filterProjectId || task.projectId === filterProjectId);
    const visible = scoped.filter(({task}) =>
        (filter === "all" || (filter === "archived" ? task.lifecycle === "archived" : task.lifecycle !== "archived")) &&
        `${task.title} ${task.goal}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const completeCount = scoped.filter(({state}) => state === "completed").length;

    async function create() {
        if (saveLock.current || !title.trim() || !goal.trim() || !projectId) {
            if (!projectId) toast.error("请先选择项目");
            return;
        }
        saveLock.current = true;
        setSaving(true);
        try {
            const task = await createAgentTask({projectId, title: title.trim(), goal: goal.trim()});
            setCreating(false);
            setTitle("");
            setGoal("");
            onOpenTask(task);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "创建任务失败，请重试");
        } finally {
            saveLock.current = false;
            setSaving(false);
        }
    }

    return <ModuleLayout navigationLabel="任务导航" navigation={<>
        <h2 className="module-nav-heading">任务</h2>
        <div className="module-nav-group">
            <button type="button" className="module-nav-item" onClick={onBack}>创作助手</button>
        </div>
        <div className="module-nav-group" role="group" aria-label="筛选任务">{([{
            value: "active",
            label: "工作台"
        }, {value: "all", label: "全部"}, {value: "archived", label: "已归档"}] as const).map(({value, label}) =>
            <button key={value} type="button" className="module-nav-item" aria-pressed={filter === value}
                    onClick={() => setFilter(value)}>{label}</button>)}</div>
        <div className="module-nav-group"><h3 className="module-nav-heading text-xs">所属项目</h3><ProjectPicker
            projects={projects} projectId={filterProjectId} onChange={setFilterProjectId} allLabel="全部项目"/></div>
    </>} mainClassName="agent-module-main">
        <section className="agent-task-board" aria-label="任务工作区">
            <PageHeader title="任务" description="管理项目目标、执行步骤与已确认的成果。"
                        className="agent-task-board-heading"
                        actions={<Button onClick={() => {
                            setProjectId(filterProjectId);
                            setCreating(true);
                        }}><Plus/>新建任务</Button>}/>
            <PageToolbar className="agent-task-board-toolbar">
            <span
                className="agent-task-board-count">{ready ? `${scoped.length} 个任务 · ${completeCount} 个已完成` : "读取工作区…"}</span>
                <label className="agent-task-search"><Search size={16} aria-hidden/><Input aria-label="搜索任务"
                                                                                           placeholder="搜索任务与目标…"
                                                                                           value={query}
                                                                                           onChange={(event) => setQuery(event.target.value)}/></label>
            </PageToolbar>
            {!ready ?
                <PageState kind="loading" title="正在读取任务与执行进度…"/> : entries.length === 0 ?
                    <div className="agent-task-empty"><ListTodo size={32} aria-hidden/>
                        <h2>还没有任务</h2><p>写下项目目标与完成标准，再与助手一起推进。
                        </p><Button onClick={() => {
                            setProjectId(filterProjectId);
                            setCreating(true);
                        }}><Plus/>创建第一个任务</Button><span>无需配置模型，也可以手动管理任务</span></div> :
                    <div className="agent-task-columns">
                        {COLUMNS.map((column) => {
                            const cards = visible.filter(({state}) => column.states.includes(state));
                            return <section className="agent-task-column" key={column.id} aria-label={column.label}>
                                <header><span className={`agent-task-state-dot is-${column.id}`}/>
                                    <h2>{column.label}</h2>
                                    <span>{cards.length}</span></header>
                                <p className="agent-task-column-hint">{column.hint}</p>
                                {cards.length === 0 ? <div
                                    className="agent-task-column-empty">{query || filter === "archived" ? "没有匹配的任务" : "暂无任务"}</div> : cards.map(({
                                                                                                                                                                task,
                                                                                                                                                                state
                                                                                                                                                            }) => {
                                    const done = task.plan.filter((step) => step.status === "completed").length;
                                    return <button className="agent-task-card" key={task.id} type="button"
                                                   onClick={() => onOpenTask(task)}>
                                        <div className="agent-task-card-top"><span
                                            className={`agent-task-status is-${state}`}>{TASK_STATE_LABELS[state]}</span><ArrowUpRight
                                            size={16} aria-hidden/></div>
                                        <h3>{task.title}</h3><p>{task.goal}</p><small
                                        className="agent-task-card-project">{projects.find((project) => project.id === task.projectId)?.name ?? "项目不可用"}</small>
                                        {task.plan.length > 0 && <div className="agent-task-mini-progress"><span
                                            style={{width: `${done / task.plan.length * 100}%`}}/></div>}
                                        <footer><span><Sparkles size={12}
                                                                aria-hidden/>小光点</span><span>{task.plan.length ? <>
                                            <Check
                                                size={12}
                                                aria-hidden/>{done}/{task.plan.length}</> : "待拆解步骤"}</span>
                                        </footer>
                                    </button>;
                                })}
                            </section>;
                        })}
                    </div>}
            <SidePanel open={creating} onOpenChange={(next) => {
                if (!saveLock.current) setCreating(next);
            }} kind="task-create" width={460} title="新建任务" description="写下想完成的事情，步骤可以稍后补充。"
                       footer={<><Button type="button" variant="ghost" disabled={saving}
                                              onClick={() => setCreating(false)}>取消</Button><Button type="submit" form="agent-task-create-form"
                                                                                                      disabled={saving || !projectId || !title.trim() || !goal.trim()}>{saving ? "创建中…" : "创建任务"}</Button></>}>
                    <form id="agent-task-create-form" className="agent-task-dialog-form" onSubmit={(event) => {
                        event.preventDefault();
                        void create();
                    }}>
                        <div className="agent-task-dialog-body">
                            <div className="agent-task-field">所属项目<ProjectPicker projects={projects}
                                                                                     projectId={projectId}
                                                                                     required allowClear={false}
                                                                                     locked={saving}
                                                                                     onChange={setProjectId}/></div>
                            <label className="agent-task-field">任务名称<Input autoFocus value={title} maxLength={120}
                                                                               onChange={(event) => setTitle(event.target.value)}
                                                                               placeholder="例如：完善主角的人物设定"
                                                                               disabled={saving} required/></label>
                            <label className="agent-task-field">目标与完成标准<Textarea value={goal} maxLength={20_000}
                                                                                        onChange={(event) => setGoal(event.target.value)}
                                                                                        placeholder="希望得到什么结果？有哪些需要注意的要求？"
                                                                                        rows={5} disabled={saving}
                                                                                        required/></label>
                        </div>
                    </form>
            </SidePanel>
        </section>
    </ModuleLayout>;
}
