import {VideoWorkspaceReadNotice} from "./VideoWorkspaceReadNotice";
import {WorkspaceUnavailableContext} from "../../platform/product/workspaceAvailability";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle
} from "../../ui/alert-dialog";
import {ProjectSettingsPanel} from "../../features/projects/ui/ProjectSettingsPanel";
import {flushPendingDrafts} from "../../platform/product/drafts";
import {Link, Navigate, Outlet, useNavigate, useRouterState} from "@tanstack/react-router";
import {
    useVideoWorkspaceQuery,
    useVideoWorkspaceReadStatus,
    useVideoWorkspaceRepository
} from "../../features/video/services/workspaceRepository";
import {Download, Library, MoreHorizontal, Settings2} from "../../ui/icons";
import {useRef, useState} from "react";
import {toast} from "sonner";
import {Still} from "../../features/library/ui/Still";
import {Button} from "../../ui/button";
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger} from "../../ui/dropdown-menu";
import {SidePanel} from "../layout/SidePanel";
import {episodeLabel} from "../../features/video/models/episodes";
import {normalizeProjectMode} from "../../features/video/models/format";
import {IMAGE_ACCEPT, pickMediaFile, uploadMediaFile} from "../../features/library/services/media";
import {downloadBlob, exportProjectZip} from "../workflows/packages/projectPackage";
import {reportBackupFailure} from "../../platform/runtime/backupFeedback";
import {cn} from "../../ui/cn";
import {shouldRedirectAudioMusicChild} from "../../features/audio/engine/workspaceRoute";
import {AppFrame} from "../layout/AppFrame";
import {ModuleLayout} from "../layout/ModuleLayout";
import {AppHeaderPortal} from "../layout/AppHeaderPortal";
import {PageState} from "../layout/PageLayout";
import {importStudioProject} from "../workflows/importStudioProject";
import {pickZipFile} from "../../features/library/services/library";

const SERIES_STEPS = [
    {id: "episodes", label: "集", to: "/p/$projectId" as const, exact: true},
    {id: "world", label: "世界", to: "/p/$projectId/world" as const, exact: false},
];

const EPISODE_STEPS = [
    {id: "story", label: "故事", to: "/p/$projectId/e/$episodeId" as const, exact: true},
    {id: "shots", label: "分镜", to: "/p/$projectId/e/$episodeId/shots" as const, exact: false},
    {id: "produce", label: "制作", to: "/p/$projectId/e/$episodeId/produce" as const, exact: false},
];

function episodeIdFromPath(pathname: string, projectId: string): string | undefined {
    const prefix = `/p/${projectId}/e/`;
    if (!pathname.startsWith(prefix)) return undefined;
    return pathname.slice(prefix.length).split("/")[0] || undefined;
}

export function WorkspaceChrome({projectId}: { projectId: string }) {
    const repository = useVideoWorkspaceRepository();
    const readStatus = useVideoWorkspaceReadStatus();
    const navigate = useNavigate();
    const pathname = useRouterState({select: (state) => state.location.pathname});
    const episodeId = episodeIdFromPath(pathname, projectId);
    const projectResult = useVideoWorkspaceQuery(
        async (repository) => ({projectId, project: await repository.project(projectId)}),
        [projectId],
    );
    const currentEpisodeResult = useVideoWorkspaceQuery(
        async (repository) => {
            if (!episodeId) return {projectId, episodeId, episode: null};
            const row = await repository.episode(episodeId);
            return {projectId, episodeId, episode: row?.projectId === projectId ? row : null};
        },
        [episodeId, projectId],
    );
    const firstEpisodeResult = useVideoWorkspaceQuery(async (repository) => {
        const rows = await repository.episodes(projectId);
        return {projectId, episode: rows[0] ?? null, episodes: rows};
    }, [projectId]);
    const loadedProject = projectResult?.projectId === projectId ? projectResult.project : undefined;
    const lastProject = useRef(loadedProject);
    if (loadedProject) lastProject.current = loadedProject;
    // Snapshot is layout/session data only. Missing rows are shown explicitly;
    // controls and descendant writes are disabled while preserving the Outlet.
    const project = loadedProject ?? (lastProject.current?.id === projectId ? lastProject.current : loadedProject);
    const currentEpisode = currentEpisodeResult?.projectId === projectId && currentEpisodeResult.episodeId === episodeId
        ? currentEpisodeResult.episode : undefined;
    const firstProjectEpisode = firstEpisodeResult?.projectId === projectId ? firstEpisodeResult.episode : undefined;
    const lastEpisode = useRef(currentEpisode);
    if (currentEpisode) lastEpisode.current = currentEpisode;
    const previouslyLoadedEpisode = lastEpisode.current?.id === episodeId;
    const [backingUp, setBackingUp] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [outputState, setOutputState] = useState({dirty: false, saving: false});
    const [confirmSettingsClose, setConfirmSettingsClose] = useState(false);

    function changeSettingsOpen(open: boolean) {
        if (!open && outputState.saving) return;
        if (!open && outputState.dirty) {
            setConfirmSettingsClose(true);
            return;
        }
        setOutputState({dirty: false, saving: false});
        setSettingsOpen(open);
    }

    if (
        project === undefined ||
        (project && normalizeProjectMode(project.mode) === "film" && firstProjectEpisode === undefined)
    ) {
        return <AppFrame><PageState kind={readStatus.error ? "error" : "loading"}
                                    title={readStatus.error ? "读取工作区失败" : "加载项目…"}
                                    description={readStatus.error} action={readStatus.error ?
            <Button variant="outline" onClick={readStatus.retry}>重新读取</Button> : undefined}/></AppFrame>;
    }

    if (project === null) {
        return (
            <AppFrame><PageState kind="missing" title="找不到这个项目"
                                 action={<Button onClick={() => void navigate({to: "/projects"})}>返回工作室</Button>}/></AppFrame>
        );
    }

    const projectMissing = loadedProject === null;
    const episodeMissing = Boolean(episodeId && currentEpisode === null);
    const unavailable = projectMissing || episodeMissing;
    const outputProtected = outputState.dirty || outputState.saving;
    const kind = project.kind ?? "video";
    if (!["video", "audio", "music"].includes(kind)) return <AppFrame><PageState kind="error" title="不支持的项目类型"/></AppFrame>;
    const mode = normalizeProjectMode(project.mode);
    const projectHome = pathname === `/p/${projectId}` || pathname === `/p/${projectId}/`;

    if (!unavailable && shouldRedirectAudioMusicChild(kind, projectId, pathname)) return <Navigate to="/p/$projectId"
                                                                                                   params={{projectId}}
                                                                                                   replace/>;

    if (episodeId && currentEpisode === null && !previouslyLoadedEpisode && !outputProtected && !projectMissing) {
        return (
            <AppFrame><PageState kind="missing" title="找不到这一集"
                                 action={<Button onClick={() => void navigate({
                                     to: "/p/$projectId",
                                     params: {projectId}
                                 })}>返回项目</Button>}/></AppFrame>
        );
    }

    if (!unavailable && !outputProtected && kind === "video" && mode === "film" && firstProjectEpisode === null && !previouslyLoadedEpisode && !projectHome && pathname !== `/p/${projectId}/memory`) {
        return (
            <AppFrame><PageState kind="missing" title="这个单片项目缺少内部集"
                                 action={<Button onClick={() => void navigate({
                                     to: "/p/$projectId",
                                     params: {projectId}
                                 })}>修复项目</Button>}/></AppFrame>
        );
    }

    // A same-project episode read must not unmount settings or the Outlet.
    // Its previous episode is hidden until the requested identity resolves.
    const episode = currentEpisode || undefined;
    const filmEpisode = kind === "video" && mode === "film" ? firstProjectEpisode || undefined : undefined;
    const title = mode === "film" ? project.name : episode ? episodeLabel(episode) : project.name;

    const projectNavigation = unavailable ? undefined : (
        <nav
            aria-label="项目工作区"
            data-tauri-drag-region="false"
            className="module-navigation-section">
            <p className="module-navigation-heading">{project.name}</p>
            <Link to="/projects" className="module-navigation-row">全部项目</Link>
            {kind === "video" && mode !== "film" && episode &&
                <Link to="/p/$projectId" params={{projectId}} className="module-navigation-row">集列表</Link>}
            {kind !== "video" ? <Link to="/p/$projectId" params={{projectId}}
                                      className={cn("module-navigation-row", projectHome && "bg-accent text-foreground font-medium")}>{kind === "audio" ? "音频制作" : "音乐创作"}</Link> : filmEpisode ? (
                <>
                    <Link
                        to="/p/$projectId/e/$episodeId"
                        params={{projectId, episodeId: filmEpisode.id}}
                        activeOptions={{exact: true}}
                        className={cn(
                            "module-navigation-row",
                            (pathname === `/p/${projectId}/e/${filmEpisode.id}` ||
                                pathname === `/p/${projectId}/e/${filmEpisode.id}/`) &&
                            "bg-accent text-foreground font-medium",
                        )}
                    >
                        故事
                    </Link>
                    <Link
                        to="/p/$projectId/world"
                        params={{projectId}}
                        className={cn(
                            "module-navigation-row",
                            (pathname.startsWith(`/p/${projectId}/world`) ||
                                pathname.startsWith(`/p/${projectId}/assets`)) &&
                            "bg-accent text-foreground font-medium",
                        )}
                    >
                        世界
                    </Link>
                    <Link
                        to="/p/$projectId/e/$episodeId/shots"
                        params={{projectId, episodeId: filmEpisode.id}}
                        search={{shot: undefined}}
                        className={cn(
                            "module-navigation-row",
                            pathname.startsWith(`/p/${projectId}/e/${filmEpisode.id}/shots`) &&
                            "bg-accent text-foreground font-medium",
                        )}
                    >
                        分镜
                    </Link>
                    <Link
                        to="/p/$projectId/e/$episodeId/produce"
                        params={{projectId, episodeId: filmEpisode.id}}
                        className={cn(
                            "module-navigation-row",
                            pathname.startsWith(`/p/${projectId}/e/${filmEpisode.id}/produce`) &&
                            "bg-accent text-foreground font-medium",
                        )}
                    >
                        制作
                    </Link>
                </>
            ) : mode === "film" ? null : episode ? (
                <>
                    {EPISODE_STEPS.map((step) => {
                        const href = step.to
                            .replace("$projectId", projectId)
                            .replace("$episodeId", episode.id);
                        const active = step.exact
                            ? pathname === href || pathname === `${href}/`
                            : pathname.startsWith(href);
                        return (
                            <Link
                                key={step.id}
                                to={step.to}
                                params={{projectId, episodeId: episode.id}}
                                search={step.id === "shots" ? {shot: undefined} : undefined}
                                activeOptions={{exact: step.exact}}
                                className={cn("module-navigation-row", active && "bg-accent text-foreground font-medium")}
                            >
                                {step.label}
                            </Link>
                        );
                    })}
                </>
            ) : (
                <>
                    {SERIES_STEPS.map((step) => {
                        const href = step.to.replace("$projectId", projectId);
                        const active = step.exact
                            ? pathname === href || pathname === `${href}/`
                            : pathname.startsWith(`/p/${projectId}/world`) ||
                            pathname.startsWith(`/p/${projectId}/assets`);
                        return (
                            <Link
                                key={step.id}
                                to={step.to}
                                params={{projectId}}
                                activeOptions={{exact: step.exact}}
                                className={cn("module-navigation-row", active && "bg-accent text-foreground font-medium")}
                            >
                                {step.label}
                            </Link>
                        );
                    })}
                </>
            )}
            {kind === "video" && mode !== "film" && episode && <Link to="/p/$projectId/world" params={{projectId}}
                                                                     className={cn("module-navigation-row", pathname.startsWith(`/p/${projectId}/world`) && "bg-accent text-foreground font-medium")}>世界</Link>}
            {kind === "video" && mode !== "film" && firstEpisodeResult?.projectId === projectId && firstEpisodeResult.episodes?.length ? <>
                <p className="module-navigation-heading mt-4">项目各集</p>
                {firstEpisodeResult.episodes.map((row) => <Link key={row.id} to="/p/$projectId/e/$episodeId"
                                                                params={{projectId, episodeId: row.id}}
                                                                className={cn("module-navigation-row", row.id === episodeId && "bg-accent text-foreground font-medium")}>{episodeLabel(row)}</Link>)}
            </> : null}
            <Link to="/p/$projectId/memory" params={{projectId}}
                  className={cn("module-navigation-row", pathname === `/p/${projectId}/memory` && "bg-accent text-foreground font-medium")}>记忆</Link>
        </nav>
    );

    const backupProject = () => {
        setBackingUp(true);
        void flushPendingDrafts(projectId)
            .then(() => exportProjectZip(projectId))
            .then(async (blob) => {
                const outcome = await downloadBlob(blob, `${project.name}.zip`);
                if (outcome === "saved") toast.success("项目备份已导出");
                else toast.info("已取消保存项目备份");
            })
            .catch(reportBackupFailure)
            .finally(() => setBackingUp(false));
    };

    async function uploadCover() {
        try {
            const file = await pickMediaFile(IMAGE_ACCEPT);
            if (!file) return;
            const uploaded = await uploadMediaFile(projectId, file);
            await repository.patchProjectOutput(projectId, {coverMediaId: uploaded.id});
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "上传封面失败");
        }
    }

    async function clearCover() {
        try {
            await repository.patchProjectOutput(projectId, {coverMediaId: null});
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "清除封面失败");
        }
    }

    return (
        <WorkspaceUnavailableContext value={unavailable}>
            <AppFrame contentScroll="hidden" onImport={() => {
                void (async () => {
                    const file = await pickZipFile();
                    if (!file) return;
                    const imported = await importStudioProject(file);
                    if (imported) await navigate({to: "/p/$projectId", params: {projectId: imported.id}});
                })();
            }}>
                <div className="workspace-shell flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
                    <VideoWorkspaceReadNotice {...readStatus}/>
                    {unavailable && <div className="p-4">
                        <p role="alert">{projectMissing ? "找不到这个项目" : "找不到这一集"}。已打开的修改仍保留，可复制或关闭；当前内容不能保存。</p>
                        <Button className="mt-3" variant="outline"
                                onClick={() => void navigate({to: "/projects"})}>返回工作室</Button>
                    </div>}
                    <AppHeaderPortal>
                        <div hidden={unavailable} style={unavailable ? {display: "none"} : undefined}
                             className="workspace-header">
                            <div className="workspace-header-title flex min-w-0 items-center gap-1">
                                <span className="truncate text-sm font-medium" title={title}>{title}</span>
                            </div>
                            <div className="workspace-header-actions flex items-center justify-end gap-1"
                                 data-tauri-drag-region="false">
                                <div className="hidden items-center gap-1 sm:flex">
                                    <Button variant="ghost" size="sm" className="px-2" asChild><Link to="/assets"
                                                                                                     search={{project: projectId}}
                                                                                                     aria-label="项目素材"><Library/><span
                                        className="hidden sm:inline">素材</span></Link></Button>
                                    <Button variant="ghost" size="sm" className="px-2"
                                            onClick={() => changeSettingsOpen(true)}
                                            aria-label="项目设定">
                                        <Settings2/><span className="hidden sm:inline">项目设定</span>
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={backingUp}
                                        aria-label={backingUp ? "正在保存并备份…" : "备份项目"}
                                        className="px-2"
                                        onClick={backupProject}
                                    >
                                        <Download/>
                                        <span
                                            className="hidden lg:inline">{backingUp ? "正在保存并备份…" : "备份项目"}</span>
                                    </Button>
                                </div>
                                <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost"
                                                                                   className="sm:hidden"
                                                                                   aria-label="项目操作"><MoreHorizontal/></Button></DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                        <DropdownMenuItem asChild><Link to="/assets"
                                                                        search={{project: projectId}}><Library/>项目素材</Link></DropdownMenuItem>
                                        <DropdownMenuItem onSelect={() => changeSettingsOpen(true)}><Settings2/>项目设定</DropdownMenuItem>
                                        <DropdownMenuItem disabled={backingUp}
                                                          onSelect={backupProject}><Download/>{backingUp ? "正在保存并备份…" : "备份项目"}
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </div>
                        </div>
                    </AppHeaderPortal>
                    <ModuleLayout navigation={kind !== "video" && projectHome ? undefined : projectNavigation}
                                  navigationLabel="项目工作区" mainClassName="overflow-hidden">
                        <div
                            className={cn("app-scroll min-h-0 min-w-0 flex-1", kind === "video" ? "overflow-auto" : "overflow-hidden")}
                            inert={unavailable}>
                            <Outlet/>
                        </div>
                    </ModuleLayout>

                    <SidePanel open={settingsOpen && (!unavailable || outputProtected)} onOpenChange={changeSettingsOpen}
                               kind="project-settings" width={460} title="项目设定"
                               footer={<Button variant="outline" disabled={outputState.saving}
                                               onClick={() => changeSettingsOpen(false)}>
                                   完成
                               </Button>}>
                            <div className="space-y-4">
                                <ProjectSettingsPanel project={project} unavailable={unavailable}
                                                      onOutputState={setOutputState}/>
                                <div>
                                    <p className="text-sm font-medium">项目封面</p>
                                    <div className="mt-2 flex items-start gap-4">
                                        <div
                                            className="aspect-[2/3] w-28 overflow-hidden rounded-xl bg-card ring-foreground/8 ring-1">
                                            <Still mediaId={project.coverMediaId} title={project.name}/>
                                        </div>
                                        <div className="flex flex-col gap-2">
                                            <Button variant="outline" size="sm" disabled={unavailable}
                                                    onClick={() => void uploadCover()}>
                                                {project.coverMediaId ? "更换封面" : "上传封面"}
                                            </Button>
                                            {project.coverMediaId ? (
                                                <Button variant="ghost" size="sm" disabled={unavailable}
                                                        onClick={() => void clearCover()}>
                                                    清除封面
                                                </Button>
                                            ) : (
                                                <p className="text-muted-foreground text-xs leading-5">
                                                    {kind === "video" ? "未设置时，项目库会用最早镜头的首帧作封面。" : "为项目上传一张封面，方便在项目库中识别。"}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                    </SidePanel>
                    <AlertDialog open={confirmSettingsClose} onOpenChange={setConfirmSettingsClose}>
                        <AlertDialogContent>
                            <AlertDialogHeader>
                                <AlertDialogTitle>输出配置尚未保存</AlertDialogTitle>
                                <AlertDialogDescription>返回后可保存当前画幅和生成默认值；放弃只撤销本次输出配置修改，已自动保存的项目信息会保留。</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                                <AlertDialogCancel>返回继续编辑</AlertDialogCancel>
                                <AlertDialogAction onClick={() => {
                                    setOutputState({dirty: false, saving: false});
                                    setSettingsOpen(false);
                                }}>放弃输出修改</AlertDialogAction>
                            </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>
                </div>
            </AppFrame>
        </WorkspaceUnavailableContext>
    );
}
