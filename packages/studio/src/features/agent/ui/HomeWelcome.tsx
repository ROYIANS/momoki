import {ModuleLayout} from "../../../app/layout/ModuleLayout";
import type {AgentTask} from "../models/agent";
import {ArrowRight, ListTodo} from "../../../ui/icons";
import {Avatar, Text} from "@lobehub/ui";
import type {ComposerProps} from "./composerTypes";
import {FloatingComposer} from "./FloatingComposer";
import {AgentHeader} from "./AgentHeader";
import {HeroLogo} from "./HeroLogo";
import {useAgentTopicNavigation} from "./AgentTopicNavigation";
import {formatRelative} from "./timeGroups";
import type {ChatThread} from "../models/chat";
import type {Id} from "../../../platform/identity";
import {LOGO_SRC} from "@momoki/distribution/brand";

/**
 * Functional entry point with the existing composer and recent work.
 */
export function HomeWelcome({
                                threads,
                                composer,
                                tasks,
                                onOpenTasks,
                                onSelectThread,
                                onNewTopic,
                                onNewTopicInProject,
                                onRenameThread,
                                onDeleteThread,
                            }: {
    tasks: AgentTask[];
    onOpenTasks: () => void;
    threads: ChatThread[];
    composer: ComposerProps;
    onSelectThread: (id: Id) => void;
    onNewTopic: () => void;
    onNewTopicInProject?: (projectId: Id) => void;
    onRenameThread: (thread: ChatThread) => void;
    onDeleteThread: (thread: ChatThread) => void;
}) {
    const topics = useAgentTopicNavigation({
        threads, projects: composer.projects, onNewTopicInProject, onSelect: onSelectThread, onNewTopic,
        onRename: onRenameThread, onDelete: onDeleteThread, onOpenTasks
    });
    const recent = threads.filter((thread) => !composer.projectId || thread.projectId === composer.projectId).slice(0, 8);
    const project = composer.projects.find((item) => item.id === composer.projectId);
    const projectTasks = tasks.filter((task) => (!composer.projectId || task.projectId === composer.projectId) && task.lifecycle !== "archived");
    return (
        <ModuleLayout className="agent-home-shell" mainClassName="agent-module-main" navigationLabel="话题导航"
                      navigation={topics.navigation}>
            <AgentHeader title="创作助手" topicToggle={topics.toggle} onNewTopic={onNewTopic}/>
            <div className="agent-home">
                <div className="agent-home-inner">
                    <div className="agent-home-hero">
                        <HeroLogo/>
                        <h1 className="agent-home-title">
                            创作助手
                        </h1>
                        <Text type="secondary" style={{fontSize: 14, maxWidth: 560, lineHeight: 1.57}}>
                            {project ? `当前项目：${project.name}。` : "选择项目与模型，描述你的创作需求。"}{composer.chatMode === "task" ? "确认目标与要求后，助手会建立任务并推进步骤。" : "提问、编辑内容或启动任务。"}
                        </Text>
                    </div>

                    <FloatingComposer {...composer} large surface="home"/>

                    <div className="agent-home-tasks-heading">
                        <span>{composer.chatMode === "task" ? "最近任务" : "创作工作台"}</span>
                        <button type="button" onClick={onOpenTasks}>任务看板 <ArrowRight size={14}/></button>
                    </div>
                    {composer.chatMode === "task" ? (
                        <div className="agent-home-task-list">
                            {projectTasks.slice(0, 4).map((task) => (
                                <button type="button" key={task.id} onClick={() => onSelectThread(task.threadId)}
                                        className="agent-home-task-row">
                                    <ListTodo
                                        size={18}/><span><strong>{task.title}</strong><small>{task.goal}</small></span>
                                    <small>{task.lifecycle === "completed" ? "已完成" : task.plan.length ? `${task.plan.filter((item) => item.status === "completed").length}/${task.plan.length} 步` : "尚未规划"}</small>
                                </button>
                            ))}
                            {!projectTasks.length && <div className="agent-home-task-empty"><ListTodo
                                size={24}/><strong>还没有任务</strong>
                                <p>在上方描述目标启动任务，也可以先到看板手动整理计划。</p>
                                <button type="button" onClick={onOpenTasks}>打开任务看板 <ArrowRight size={14}/>
                                </button>
                            </div>}
                        </div>
                    ) : recent.length > 0 ? (
                        <div style={{marginTop: 24, textAlign: "start"}}>
                            <Text type="secondary" style={{fontSize: 12, paddingInline: 12, paddingBlock: 8}}>
                                最近活动 {recent.length}
                            </Text>
                            {recent.map((thread) => (
                                <button
                                    type="button"
                                    key={thread.id}
                                    onClick={() => onSelectThread(thread.id)}
                                    className="agent-home-recent-row"
                                >
                                    <Avatar className="agent-home-logo" avatar={LOGO_SRC} background="transparent"
                                            shape="circle" size={22}/>
                                    <div
                                        style={{
                                            flex: 1,
                                            minWidth: 0,
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                            fontSize: 14,
                                        }}
                                    >
                                        {thread.title}
                                    </div>
                                    <Text type="secondary" style={{fontSize: 12, flexShrink: 0}}>
                                        {formatRelative(thread.updatedAt)}
                                    </Text>
                                </button>
                            ))}
                        </div>
                    ) : null}
                </div>
            </div>
        </ModuleLayout>
    );
}
