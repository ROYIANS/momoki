import {cn} from "../../../ui/cn";
import {ModuleLayout} from "../../../app/layout/ModuleLayout";
import {VideoWorkspaceReadNotice} from "../../../app/workspace/VideoWorkspaceReadNotice";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "../../../ui/select";
import {flushPendingDrafts} from "../../../platform/product/drafts";
import {Link, useNavigate} from "@tanstack/react-router";
import {
    useVideoWorkspaceQuery,
    useVideoWorkspaceReadStatus,
    useVideoWorkspaceRepository
} from "../../video/services/workspaceRepository";
import {useEffect, useMemo, useRef, useState} from "react";
import {toast} from "sonner";
import {CoverCard, LibraryGrid} from "../../library/ui/CoverCard";
import {LibraryHeader} from "../../library/ui/LibraryHeader";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "../../../ui/alert-dialog";
import {Button} from "../../../ui/button";
import {SidePanel} from "../../../app/layout/SidePanel";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "../../../ui/dialog";
import {Input} from "../../../ui/input";
import {formatUpdatedAt} from "../../../ui/format";
import {filterAndSortLibrary, type LibrarySort} from "../../library/services/library";
import { exportProjectZip,} from "../../../app/workflows/packages/projectPackage";
import {downloadBlob} from "../../../platform/runtime/runtimeSave";
import {reportBackupFailure} from "../../../platform/runtime/backupFeedback";
import {ASPECT_PRESET_IDS, ASPECT_PRESETS, type AspectPresetId, type ProjectMode} from "../../video/models/format";
import {ProjectIpPicker} from "./ProjectIpPicker";
import {Plus} from "../../../ui/icons";
import {PROJECT_KINDS, type ProjectKindId, ProjectKindPlaceholder} from "./projectKinds";
import {PageContent, PageState, PageToolbar} from "../../../app/layout/PageLayout";

export function ProjectGalleryPage() {
    const repository = useVideoWorkspaceRepository();
    const readStatus = useVideoWorkspaceReadStatus();
    const sqlite = repository.storage === "sqlite";
    const navigate = useNavigate();
    const activeRef = useRef(true);
    useEffect(() => {
        activeRef.current = true;
        return () => {
            activeRef.current = false;
        };
    }, []);
    const projects = useVideoWorkspaceQuery((repository) => repository.projects(), []);
    const profiles = useVideoWorkspaceQuery((repository) => repository.ipProfiles(), []) ?? [];
    const ipLinks = useVideoWorkspaceQuery((repository) => repository.projectIpLinks(), []);
    const [ipFilter, setIpFilter] = useState("all");
    const [showArchived, setShowArchived] = useState(false);
    const [createIpId, setCreateIpId] = useState<string | null>(null);
    const [binding, setBinding] = useState<{ projectId: string; name: string; ipId: string | null }>();
    const [bindingBusy, setBindingBusy] = useState(false);
    const [bindingError, setBindingError] = useState("");
    const bindingRef = useRef(false);
    const archiveRef = useRef<string | undefined>(undefined)
    const [archivingId, setArchivingId] = useState<string>();
    const [createError, setCreateError] = useState<string>();
    const [archiveError, setArchiveError] = useState<string>();
    const [query, setQuery] = useState("");
    const [sort, setSort] = useState<LibrarySort>("updated");
    const [kindFilter, setKindFilter] = useState<ProjectKindId | "all">("all");
    const [createKind, setCreateKind] = useState<ProjectKindId>("video");
    const [submitting, setSubmitting] = useState(false);
    const creatingRef = useRef(false);
    const selectedKind = PROJECT_KINDS.find((kind) => kind.id === createKind)!;
    const creationAvailable = selectedKind.available;
    let createLabel = creationAvailable ? "创建项目" : "即将推出";
    if (submitting) createLabel = "创建中…";
    const filteredKind = PROJECT_KINDS.find((kind) => kind.id === kindFilter);
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("未命名项目");
    const [mode, setMode] = useState<ProjectMode>("film");
    const [aspectPreset, setAspectPreset] = useState<AspectPresetId>("16:9");
    const [renameId, setRenameId] = useState<string>();
    const [renameValue, setRenameValue] = useState("");
    const [deleteId, setDeleteId] = useState<string>();
    const renameRef = useRef(false);
    const deleteRef = useRef(false);
    const [renaming, setRenaming] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [renameError, setRenameError] = useState("");
    const [deleteError, setDeleteError] = useState("");

    const visible = useMemo(
        () => filterAndSortLibrary((projects ?? []).filter((project) => {
            const ipId = ipLinks?.find((link) => link.projectId === project.id)?.ipId;
            return (kindFilter === "all" || (project.kind ?? "video") === kindFilter) && Boolean(project.archivedAt) === showArchived && (ipFilter === "all" || (ipFilter === "independent" ? !ipId : ipId === ipFilter));
        }), query, sort),
        [projects, query, sort, ipLinks, ipFilter, showArchived, kindFilter],
    );

    // Stable set identity: sorting/searching may reorder cards without changing this query.
    const coverProjectIds = visible.filter(project => project.coverMediaId == null).map(project => project.id).sort();
    const coverQueryKey = JSON.stringify(coverProjectIds);
    const coverView = useVideoWorkspaceQuery(async (repository) => ({
        key: coverQueryKey,
        covers: await repository.projectCoverIds(coverProjectIds),
    }), [coverQueryKey]);
    // The shared query retains its prior result while a new scope is loading.
    const covers = coverView?.key === coverQueryKey ? coverView.covers : undefined;

    async function handleCreate() {
        if (!creationAvailable || !name.trim() || creatingRef.current) return;
        creatingRef.current = true;
        setSubmitting(true);
        setCreateError(undefined);
        try {
            const project = createKind === "audio" || createKind === "music"
                ? await repository.createAudioMusicProject(name.trim(), createKind, createIpId)
                : await repository.createProject(name.trim(), mode, aspectPreset, createIpId);
            if (!activeRef.current) return;
            setCreating(false);
            setName("未命名项目");
            setMode("film");
            setAspectPreset("16:9");
            await navigate({to: "/p/$projectId", params: {projectId: project.id}});
        } catch (err) {
            if (activeRef.current) setCreateError(err instanceof Error && err.message ? err.message : "创建失败，请重试");
        } finally {
            creatingRef.current = false;
            if (activeRef.current) setSubmitting(false);
        }
    }

    async function handleRename() {
        if (!renameId || renameRef.current) return;
        const id = renameId;
        const value = renameValue;
        renameRef.current = true;
        setRenaming(true);
        setRenameError("");
        try {
            await repository.renameProject(id, value);
            if (activeRef.current) setRenameId((current) => current === id ? undefined : current);
        } catch (error) {
            if (activeRef.current) setRenameError(error instanceof Error && error.message ? error.message : "保存失败，请重试");
        } finally {
            renameRef.current = false;
            if (activeRef.current) setRenaming(false);
        }
    }

    async function handleDelete() {
        if (!deleteId || deleteRef.current) return;
        const id = deleteId;
        deleteRef.current = true;
        setDeleting(true);
        setDeleteError("");
        try {
            await repository.deleteProject(id);
            if (activeRef.current) setDeleteId((current) => current === id ? undefined : current);
        } catch (error) {
            if (activeRef.current) setDeleteError(error instanceof Error && error.message ? error.message : "删除失败，请重试");
        } finally {
            deleteRef.current = false;
            if (activeRef.current) setDeleting(false);
        }
    }

    async function handleBinding() {
        if (!binding || bindingRef.current) return;
        const target = binding;
        bindingRef.current = true;
        setBindingBusy(true);
        setBindingError("");
        try {
            await repository.bindProjectIp(target.projectId, target.ipId);
            if (activeRef.current) setBinding((current) => current === target ? undefined : current);
        } catch (error) {
            if (activeRef.current) setBindingError(error instanceof Error && error.message ? error.message : "保存失败，请重试");
        } finally {
            bindingRef.current = false;
            if (activeRef.current) setBindingBusy(false);
        }
    }

    async function handleArchive(id: string, archived: boolean) {
        if (archiveRef.current) return;
        archiveRef.current = id;
        setArchivingId(id);
        setArchiveError(undefined);
        try {
            await repository.setProjectArchived(id, archived);
        } catch (error) {
            if (activeRef.current) setArchiveError(error instanceof Error && error.message ? error.message : "操作失败，请重试");
        } finally {
            archiveRef.current = undefined;
            if (activeRef.current) setArchivingId(undefined);
        }
    }

    return (
        <ModuleLayout navigationLabel="项目导航" navigation={<>
            <h2 className="module-nav-heading">项目</h2>
            <div className="module-nav-group" role="group" aria-label="按创作类型筛选">
                <button type="button" className="module-nav-item" aria-pressed={kindFilter === "all"}
                        onClick={() => setKindFilter("all")}>全部类型
                </button>
                {PROJECT_KINDS.map(kind => <button key={kind.id} type="button" className="module-nav-item"
                                                   aria-pressed={kindFilter === kind.id}
                                                   onClick={() => setKindFilter(kind.id)}>
                    <kind.icon size={16} weight={kindFilter === kind.id ? "fill" : "regular"} aria-hidden/>
                    {kind.label}{!kind.available && <span className="ml-auto text-xs">即将推出</span>}</button>)}
            </div>
            <div className="module-nav-group" role="group" aria-label="项目状态">
                <button type="button" className="module-nav-item" aria-pressed={!showArchived}
                        onClick={() => setShowArchived(false)}>使用中
                </button>
                <button type="button" className="module-nav-item" aria-pressed={showArchived}
                        onClick={() => setShowArchived(true)}>已归档
                </button>
            </div>
            <div className="module-nav-group"><h3
                className="module-nav-heading text-xs">当前项目</h3>{visible.map(project => <Link key={project.id}
                                                                                                  className="module-nav-item"
                                                                                                  to="/p/$projectId"
                                                                                                  params={{projectId: project.id}}>{project.name}</Link>)}
            </div>
        </>}><PageContent>
            <VideoWorkspaceReadNotice {...readStatus}/>
            {archiveError ? <p role="alert" className="text-destructive text-sm">{archiveError}</p> : null}
            <LibraryHeader title="项目" query={query} onQuery={setQuery} sort={sort} onSort={setSort}
                           extra={<Button onClick={() => {
                               setCreateKind(kindFilter === "all" ? "video" : kindFilter);
                               setCreateError(undefined);
                               setCreating(true);
                           }}><Plus aria-hidden/>新建项目</Button>}
            />
            <PageToolbar className="library-filter-row">
                <label className="flex items-center gap-2">所属 IP
                    <Select value={ipFilter} onValueChange={setIpFilter}><SelectTrigger aria-label="筛选所属 IP"
                                                                                        className="max-w-52"><SelectValue/></SelectTrigger><SelectContent><SelectItem
                        value="all">全部</SelectItem><SelectItem
                        value="independent">独立项目</SelectItem>{profiles.map(ip => <SelectItem key={ip.id}
                                                                                                 value={ip.id}>{ip.name}{ip.archived ? "（已归档）" : ""}</SelectItem>)}
                    </SelectContent></Select>
                </label>
            </PageToolbar>
            <div className="mt-4">
                {filteredKind && !filteredKind.available ? <ProjectKindPlaceholder kind={filteredKind}/> : <>
                    {projects === undefined && !readStatus.error && <PageState kind="loading" title="加载项目中…"/>}
                    {projects !== undefined && !visible.length &&
                        <PageState
                            title={query.trim() || ipFilter !== "all" || showArchived ? "没有找到匹配的项目" : "还没有项目"}
                            description={query.trim() ? "试试其他关键词，或清除搜索。" : undefined}
                            action={query.trim() ? <Button variant="outline"
                                                           onClick={() => setQuery("")}>清除搜索</Button> :
                                <Button variant="outline" onClick={() => {
                                    setCreateKind(kindFilter === "all" ? "video" : kindFilter);
                                    setCreateError(undefined);
                                    setCreating(true);
                                }}>新建项目</Button>}/>}
                    <LibraryGrid>
                        {visible.map((project) => {
                            let archiveLabel = project.archivedAt ? "恢复项目" : "归档项目";
                            if (archivingId === project.id) archiveLabel = "处理中…";
                            return <CoverCard
                                key={project.id}
                                frame="poster"
                                title={project.name}
                                subtitle={`${PROJECT_KINDS.find((kind) => kind.id === (project.kind ?? "video"))?.label ?? "未知类型"} · ${profiles.find((ip) => ip.id === ipLinks?.find((link) => link.projectId === project.id)?.ipId)?.name ?? "独立项目"} · ${project.archivedAt ? "已归档" : formatUpdatedAt(project.updatedAt)}`}
                                mediaId={project.coverMediaId ?? covers?.get(project.id)}
                                onOpen={() =>
                                    void navigate({to: "/p/$projectId", params: {projectId: project.id}})
                                }
                                actions={[
                                    {
                                        label: "项目素材",
                                        onSelect: () => void navigate({to: "/assets", search: {project: project.id}}),
                                    },
                                    ...([{
                                        label: "所属 IP",
                                        onSelect: () => {
                                            if (bindingRef.current) return;
                                            setBindingError("");
                                            setBinding({
                                                projectId: project.id,
                                                name: project.name,
                                                ipId: ipLinks?.find((link) => link.projectId === project.id)?.ipId ?? null
                                            });
                                        },
                                    }]),
                                    {
                                        label: archiveLabel,
                                        onSelect: () => {
                                            void handleArchive(project.id, !project.archivedAt);
                                        },
                                    },
                                    {
                                        label: "重命名",
                                        onSelect: () => {
                                            if (renameRef.current) return;
                                            setRenameError("");
                                            setRenameId(project.id);
                                            setRenameValue(project.name);
                                        },
                                    },
                                    ...([{
                                        label: "备份项目（zip）",
                                        onSelect: () => {
                                            void flushPendingDrafts(project.id)
                                                .then(() => exportProjectZip(project.id))
                                                .then((blob) => downloadBlob(blob, `${project.name}.zip`))
                                                .then((outcome) => {
                                                    if (outcome === "canceled") toast.info("已取消保存项目备份");
                                                })
                                                .catch(reportBackupFailure);
                                        },
                                    }]),
                                    {
                                        label: "删除",
                                        tone: "danger",
                                        onSelect: () => {
                                            if (deleteRef.current) return;
                                            setDeleteError("");
                                            setDeleteId(project.id);
                                        },
                                    },
                                ]}
                            />;
                        })}
                    </LibraryGrid>
                </>}
            </div>

            <SidePanel open={creating} onOpenChange={(open) => {
                if (!creatingRef.current) setCreating(open);
            }} kind="project-create" width={520} title="新建项目" description="选择视频、音频或音乐项目，也可以关联已有 IP。"
                       footer={<>
                        <Button disabled={submitting} variant="outline" onClick={() => {
                            if (!creatingRef.current) setCreating(false);
                        }}>
                            {creationAvailable ? "取消" : "关闭"}
                        </Button>
                        <Button disabled={!creationAvailable || !name.trim() || submitting} variant="brand"
                                onClick={() => void handleCreate()}>
                            {createLabel}
                        </Button>
</>}>
                    <div className="space-y-4">
                        <fieldset disabled={submitting}>
                            <legend className="text-sm font-medium">创作类型</legend>
                            <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5">
                                {PROJECT_KINDS.map((kind) => {
                                    const Icon = kind.icon;
                                    return <button type="button" key={kind.id} aria-pressed={createKind === kind.id}
                                                   onClick={() => setCreateKind(kind.id)}
                                                   className={cn("flex min-h-24 flex-col items-center justify-center gap-2 rounded-xl border px-2 py-3 text-sm focus-visible:outline-2 focus-visible:outline-ring", createKind === kind.id ? "border-brand bg-brand/5" : "text-muted-foreground hover:bg-muted/50")}>
                                        <Icon className="size-5" aria-hidden/><span>{kind.label}</span>
                                        <span className="text-[10px]">{kind.available ? "已开放" : "即将推出"}</span>
                                    </button>;
                                })}
                            </div>
                        </fieldset>
                        {!selectedKind.available ? <ProjectKindPlaceholder kind={selectedKind}/> : <>
                            <label htmlFor="new-project-name" className="text-sm font-medium">项目名称</label>
                            <Input
                                id="new-project-name"
                                disabled={submitting}
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                placeholder="项目名称"
                            />
                            {createKind === "video" && <>
                                <fieldset disabled={submitting}>
                                    <legend className="text-sm font-medium">视频形式</legend>
                                    <div className="mt-2 grid grid-cols-2 gap-3">
                                        {(
                                            [
                                                {value: "film", title: "单片", hint: "直接进入故事，适合短片和电影"},
                                                {value: "series", title: "连载", hint: "按集管理故事、分镜和制作"},
                                            ] satisfies { value: ProjectMode; title: string; hint: string }[]
                                        ).map((option) => (
                                            <button
                                                key={option.value}
                                                type="button"
                                                aria-pressed={mode === option.value}
                                                className={cn(
                                                    "rounded-xl border p-4 text-left transition-colors",
                                                    mode === option.value
                                                        ? "border-brand bg-brand/5"
                                                        : "hover:bg-muted/50",
                                                )}
                                                onClick={() => setMode(option.value)}
                                            >
                                                <span className="block text-sm font-medium">{option.title}</span>
                                                <span className="text-muted-foreground mt-1 block text-xs leading-5">
                    {option.hint}
                  </span>
                                            </button>
                                        ))}
                                    </div>
                                </fieldset>
                                <fieldset disabled={submitting}>
                                    <legend className="text-sm font-medium">画幅比例</legend>
                                    <div className="mt-2 grid grid-cols-3 gap-2">
                                        {ASPECT_PRESET_IDS.map((preset) => (
                                            <button
                                                key={preset}
                                                type="button"
                                                aria-pressed={aspectPreset === preset}
                                                className={cn(
                                                    "rounded-xl border px-3 py-2.5 text-center text-sm font-medium transition-colors",
                                                    aspectPreset === preset
                                                        ? "border-brand bg-brand/5"
                                                        : "hover:bg-muted/50",
                                                )}
                                                onClick={() => setAspectPreset(preset)}
                                            >
                                                {ASPECT_PRESETS[preset].label}
                                            </button>
                                        ))}
                                    </div>
                                    <p className="text-muted-foreground mt-2 text-xs">
                                        生成模型与分辨率可在创建后的项目设定中分别配置
                                    </p>
                                </fieldset>
                            </>}
                            {<div className="space-y-2"><span
                                className="text-sm font-medium">所属 IP</span><ProjectIpPicker
                                value={createIpId} onChange={setCreateIpId} disabled={submitting}/></div>}
                            <p className="text-muted-foreground text-xs leading-5">项目类型创建后不可更改</p>
                        </>}
                        {createError ? <p role="alert" className="text-destructive text-sm">{createError}</p> : null}
                    </div>
            </SidePanel>

            <SidePanel open={Boolean(binding)} onOpenChange={(open) => {
                if (!open && !bindingRef.current) setBinding(undefined);
            }} kind="project-ip-binding" width={420} title="项目所属 IP"
                       description={`${binding?.name ?? ""} · 关联仅整理项目归属，不会改写已有内容。`}
                       footer={<><Button variant="outline" disabled={bindingBusy}
                                          onClick={() => {
                                              if (!bindingRef.current) setBinding(undefined);
                                          }}>取消</Button>
                        <Button disabled={bindingBusy}
                                onClick={() => void handleBinding()}>{bindingBusy ? "保存中…" : "保存"}</Button></>}>
                    {<ProjectIpPicker value={binding?.ipId ?? null}
                                      onChange={(ipId) => setBinding((value) => value ? {...value, ipId} : value)}
                                      disabled={bindingBusy}/>}
                    {bindingError && <p role="alert" className="text-destructive text-sm">{bindingError}</p>}
            </SidePanel>

            <Dialog open={Boolean(renameId)} onOpenChange={(open) => {
                if (!open && !renameRef.current) setRenameId(undefined);
            }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>重命名项目</DialogTitle>
                    </DialogHeader>
                    <Input
                        autoFocus
                        disabled={renaming}
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                    />
                    {renameError && <p role="alert" className="text-destructive text-sm">{renameError}</p>}
                    <DialogFooter>
                        <Button disabled={renaming} variant="outline" onClick={() => {
                            if (!renameRef.current) setRenameId(undefined);
                        }}>
                            取消
                        </Button>
                        <Button
                            disabled={renaming}
                            onClick={() => void handleRename()}
                        >
                            {renaming ? "保存中…" : "保存"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <AlertDialog open={Boolean(deleteId)} onOpenChange={(open) => {
                if (!open && !deleteRef.current) setDeleteId(undefined);
            }}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>删除项目</AlertDialogTitle>
                        <AlertDialogDescription>
                            {sqlite ? "删除后，项目记录及素材关联无法恢复。已复制到工作区的文件副本会暂时保留，此操作不会释放它们占用的磁盘空间。" : "删除后无法恢复（除非你已经备份过项目）。"}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    {deleteError && <p role="alert" className="text-destructive text-sm">{deleteError}</p>}
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive hover:bg-destructive/90"
                            disabled={deleting}
                            onClick={(event) => {
                                event.preventDefault();
                                void handleDelete();
                            }}
                        >
                            {deleting ? "删除中…" : "删除"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </PageContent></ModuleLayout>
    );
}
