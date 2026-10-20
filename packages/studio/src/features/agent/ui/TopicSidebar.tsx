import {useTopicActivity} from "../queries/threadActivity";
import {Flexbox, Text} from "@lobehub/ui";
import {LOGO_SRC, PRODUCT_NAME_ZH} from "@momoki/distribution/brand";
import {
    ChevronDown,
    Filter,
    Folder,
    FolderOpen,
    ListTodo,
    MessageSquarePlus,
    Pencil,
    Plus,
    Search,
    Trash2,
    Tray,
    X,
} from "../../../ui/icons";
import {type ComponentType, memo, useId, useEffect, useMemo, useRef, useState,} from "react";
import {filterThreadsByTitle} from "./filterThreadsByTitle";
import {DotMatrixMarker} from "./ThinkingMatrix";
import {resolveTopicMarker, type TopicActivityFlags, topicActivityLabel} from "./statusCopy";
import {groupThreadsByTime} from "./timeGroups";
import {
    formatRelativeShort,
    groupThreadsByProject,
    readTopicGrouping,
    type TopicGrouping,
    UNLINKED_PROJECT_KEY,
    writeTopicGrouping,
} from "./topicGrouping";
import {Tooltip, TooltipContent, TooltipTrigger} from "../../../ui/tooltip";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import type {ChatThread} from "../models/chat";
import type {Id} from "../../../platform/identity";
import type {Project} from "../../projects/models/project";

/**
 * Topic sidebar: brand row, 新话题 / 搜索 / 任务, then grouped topic list
 * (by project by default, optionally merged by time). The list body also powers the narrow overlay.
 */
export const TopicSidebar = memo(function TopicSidebar(props: TopicListProps) {
    return (
        <Flexbox width="100%" height="100%" className="agent-topic-sidebar">
            <TopicListBody {...props}/>
        </Flexbox>
    );
});

interface TopicListProps {
    threads: ChatThread[];
    /** Undefined while projects are still loading: topics render time-grouped so nothing jumps afterwards. */
    projects?: Project[];
    activeThreadId?: Id;
    onSelect: (id: Id) => void;
    onNewTopic: () => void;
    /** Starts a topic directly inside the given project (goes through the same departure confirmation). */
    onNewTopicInProject?: (projectId: Id) => void;
    onOpenTasks: () => void;
    onRename: (thread: ChatThread) => void;
    onDelete: (thread: ChatThread) => void;
}

interface Section {
    key: string;
    projectId?: Id;
    label: string;
    threads: ChatThread[];
}

function TopicListBody({
                           threads,
                           projects,
                           activeThreadId,
                           onSelect,
                           onNewTopic,
                           onNewTopicInProject,
                           onOpenTasks,
                           onRename,
                           onDelete,
                       }: TopicListProps) {
    const [folded, setFolded] = useState<Record<string, boolean>>({});
    const [grouping, setGrouping] = useState<TopicGrouping>(() => readTopicGrouping());
    const [searchOpen, setSearchOpen] = useState(false);
    const [query, setQuery] = useState("");
    const searchRef = useRef<HTMLInputElement>(null);
    const searching = searchOpen && query.trim().length > 0;

    const filtered = useMemo(() => filterThreadsByTitle(threads, query), [threads, query]);
    const byProject = grouping === "project" && projects !== undefined;
    const sections = useMemo<Section[]>(
        () => byProject
            ? groupThreadsByProject(filtered, projects).map((group) => ({
                ...group,
                projectId: group.key === UNLINKED_PROJECT_KEY ? undefined : group.key
            }))
            : groupThreadsByTime(filtered).map((group) => ({
                key: `time:${group.label}`,
                label: group.label,
                threads: group.threads
            })),
        [byProject, filtered, projects],
    );
    const projectNames = useMemo(() => new Map((projects ?? []).map((project) => [project.id, project.name])), [projects]);

    useEffect(() => {
        if (searchOpen) searchRef.current?.focus();
    }, [searchOpen]);

    const clearSearch = () => {
        setQuery("");
        setSearchOpen(false);
    };
    const chooseGrouping = (next: TopicGrouping) => {
        setGrouping(next);
        writeTopicGrouping(next);
    };
    const availableProjects = useMemo(
        () => new Set((projects ?? []).filter((project) => !project.archivedAt).map((project) => project.id)),
        [projects],
    );
    const now = Date.now();

    return (
        <>
            <Flexbox horizontal align="center" gap={8} style={{flex: "none"}} className="agent-topic-brand">
                <img src={LOGO_SRC} alt="" width={24} height={24} style={{objectFit: "contain"}}/>
                <Text strong>{PRODUCT_NAME_ZH}</Text>
            </Flexbox>
            <Flexbox paddingInline={8} gap={2} style={{flex: "none"}}>
                <SidebarNavItem icon={MessageSquarePlus} label="开启新话题" primary onClick={onNewTopic}/>
                <SidebarNavItem icon={Search} label="搜索" onClick={() => setSearchOpen(true)}/>
                <SidebarNavItem icon={ListTodo} label="任务" onClick={onOpenTasks}/>
            </Flexbox>

            {searchOpen ? (
                <Flexbox paddingInline={8} paddingBlock={4} style={{flex: "none"}}>
                    <div className="agent-topic-search">
                        <Search size={14} aria-hidden className="agent-topic-search-icon"/>
                        <input
                            ref={searchRef}
                            type="search"
                            className="agent-topic-search-input"
                            placeholder="搜索话题标题"
                            value={query}
                            aria-label="搜索话题标题"
                            onChange={(event) => setQuery(event.target.value)}
                        />
                        <button
                            type="button"
                            className="agent-topic-search-clear"
                            aria-label="关闭搜索"
                            onClick={clearSearch}
                        >
                            <X size={14}/>
                        </button>
                    </div>
                </Flexbox>
            ) : null}

            <div className="agent-sidebar-list-head">
                <span>{byProject ? "项目" : "时间"}</span>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            className="agent-sidebar-list-toggle"
                            aria-label="列表分组与排序"
                            aria-haspopup="menu"
                            title="列表分组与排序"
                        >
                            <Filter size={14} aria-hidden/>
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="agent-topic-menu">
                        <DropdownMenuLabel className="text-muted-foreground text-xs">分组方式</DropdownMenuLabel>
                        <DropdownMenuRadioGroup value={grouping}
                                                onValueChange={(value) => chooseGrouping(value === "time" ? "time" : "project")}>
                            <DropdownMenuRadioItem value="project">按项目</DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="time">按时间</DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            <Flexbox flex={1} gap={4} className="agent-sidebar-list">
                {filtered.length === 0 ? (
                    <Text type="secondary" style={{fontSize: 12, padding: 8}}>
                        {threads.length === 0
                            ? "还没有话题，发一条消息开始。"
                            : "没有匹配的话题标题。"}
                    </Text>
                ) : (
                    sections.map((section) => {
                        // Matching sections open while searching; the user's own folding returns afterwards.
                        const closed = Boolean(folded[section.key]) && !searching;
                        return (
                            <Flexbox key={section.key} gap={1}
                                     className={byProject ? "agent-sidebar-section-body is-project" : "agent-sidebar-section-body"}>
                                <div className="agent-sidebar-group-row">
                                    <button
                                        type="button"
                                        className="agent-sidebar-group"
                                        aria-expanded={!closed}
                                        onClick={() =>
                                            setFolded((prev) => ({...prev, [section.key]: !prev[section.key]}))
                                        }
                                    >
                                        {byProject ? (
                                            section.projectId
                                                ? (closed ?
                                                    <Folder size={16} aria-hidden className="agent-sidebar-group-icon"/> :
                                                    <FolderOpen size={16} aria-hidden
                                                                className="agent-sidebar-group-icon"/>)
                                                : <Tray size={16} aria-hidden className="agent-sidebar-group-icon"/>
                                        ) : null}
                                        <span className="agent-sidebar-group-label">{section.label}</span>
                                        <ChevronDown
                                            size={12}
                                            className={closed ? "agent-sidebar-chevron is-closed" : "agent-sidebar-chevron"}
                                            aria-hidden
                                        />
                                    </button>
                                    {section.projectId && onNewTopicInProject && availableProjects.has(section.projectId) ? (
                                        <Tooltip delayDuration={500}>
                                            <TooltipTrigger asChild>
                                                <button
                                                    type="button"
                                                    className="agent-sidebar-group-add"
                                                    aria-label={`在 ${section.label} 中新建话题`}
                                                    onClick={() => onNewTopicInProject(section.projectId!)}
                                                >
                                                    <Plus size={14} aria-hidden/>
                                                </button>
                                            </TooltipTrigger>
                                            <TooltipContent
                                                side="right">{`在 ${section.label} 中新建话题`}</TooltipContent>
                                        </Tooltip>
                                    ) : null}
                                </div>
                                {closed
                                    ? null
                                    : section.threads.map((thread) => (
                                        <TopicRow
                                            key={thread.id}
                                            thread={thread}
                                            projectName={thread.projectId ? projectNames.get(thread.projectId) : undefined}
                                            now={now}
                                            active={thread.id === activeThreadId}
                                            onSelect={onSelect}
                                            onRename={onRename}
                                            onDelete={onDelete}
                                        />
                                    ))}
                            </Flexbox>
                        );
                    })
                )}
            </Flexbox>
        </>
    );
}

function SidebarNavItem({
                            icon: Icon,
                            label,
                            onClick,
                            primary,
                        }: {
    icon: ComponentType<{ size?: number; weight?: "regular" | "fill" }>;
    label: string;
    onClick: () => void;
    primary?: boolean;
}) {
    return (
        <button
            type="button"
            className={primary ? "agent-sidebar-nav is-primary" : "agent-sidebar-nav"}
            onClick={onClick}
        >
            <Icon size={16} weight="regular"/>
            <span>{label}</span>
        </button>
    );
}

const TopicRow = memo(function TopicRow({
                      thread,
                      projectName,
                      now,
                      active,
                      onSelect,
                      onRename,
                      onDelete,
                  }: {
    thread: ChatThread;
    projectName?: string;
    now: number;
    active: boolean;
    onSelect: (id: Id) => void;
    onRename: (thread: ChatThread) => void;
    onDelete: (thread: ChatThread) => void;
}) {
    const statusId = useId();
    return (
        <div className={active ? "agent-topic-row is-active" : "agent-topic-row"} data-thread-id={thread.id}>
            <TopicActivityStatus threadId={thread.id} id={statusId}/>
            <Tooltip delayDuration={600}>
                <TooltipTrigger asChild>
                    <button type="button" className="agent-topic-row-title" onClick={() => onSelect(thread.id)}
                            aria-current={active ? "true" : undefined} aria-describedby={statusId}>
                        {thread.title}
                    </button>
                </TooltipTrigger>
                <TooltipContent
                    side="right">{projectName ? `${thread.title} · ${projectName}` : thread.title}</TooltipContent>
            </Tooltip>
            <span className="agent-topic-row-trailing"><time className="agent-topic-row-time"
                  dateTime={thread.updatedAt}>{formatRelativeShort(thread.updatedAt, now)}</time>
            <span className="agent-topic-row-actions">
                <button type="button" role="button" className="agent-topic-row-action" title="重命名"
                        aria-label="重命名" onClick={() => onRename(thread)}>
                    <Pencil size={16} aria-hidden/>
                </button>
                <button type="button" role="button" className="agent-topic-row-action" title="删除" aria-label="删除"
                        onClick={() => onDelete(thread)}>
                    <Trash2 size={16} aria-hidden/>
                </button>
            </span></span>
        </div>
    );
});

/** Streaming can update this finite indicator without rerendering the title/action owner. */
function TopicActivityStatus({threadId, id}: {threadId: string; id: string}) {
    return <TopicStatusCell activity={useTopicActivity(threadId)} id={id}/>;
}

/** Fixed leading cell: exactly one marker by precedence, fixed size so rows never shift. */
export function TopicStatusCell({activity, id}: {activity: TopicActivityFlags; id: string}) {
    const label = topicActivityLabel(activity);
    const marker = resolveTopicMarker(activity);
    return <span className="agent-topic-row-status" data-marker={marker} title={label || undefined}>
        <span id={id} className="sr-only">{label}</span>
        {marker === "running" ? <DotMatrixMarker/> : null}
        {marker !== "running" && marker !== "none" ? <i aria-hidden="true" className={`agent-topic-marker is-${marker}`}/> : null}
    </span>;
}
