import {VideoWorkspaceReadNotice} from "../../../app/workspace/VideoWorkspaceReadNotice";
import {BeatTextField} from "./BeatTextField";
import {type TextDraftStatusChange, useTextDraftRetention} from "../../../app/drafts/useTextDraftRetention";
import {gridColumns} from "./shotColumnFields";
import {ShotRow} from "./ShotRow";
import {ShotRelationsEditor} from "./ShotRelationsEditor";
import {applyShotBulkCommand, deleteShotSelectionCommand, reorderShotGroupCommand} from "./shotEditorCommands";
import {useShotEditorKeyboard} from "./useShotEditorKeyboard";
import {useWorkspaceUnavailable} from "../../../platform/product/workspaceAvailability";
import {useManualDraftGuard} from "../../../app/drafts/useManualDraftGuard";
import {ShotScrollViewport} from "./ShotRowViewport";
import {toast} from "sonner";
import {ShotCommandErrorContext, useShotCommandError} from "./shotCommandError";
import {useShotMedia} from "../queries/useShotMedia";
import {
    closestCenter,
    DndContext,
    type DragEndEvent,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
} from "@dnd-kit/core";
import {
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {CSS} from "@dnd-kit/utilities";
import {
    useVideoWorkspaceQuery,
    useVideoWorkspaceReadStatus,
    useVideoWorkspaceRepository
} from "../services/workspaceRepository";
import {
    CheckSquare,
    ChevronDown,
    Columns3,
    CopyPlus,
    Filter,
    GripVertical,
    Hash,
    Images,
    LayoutList,
    Plus,
    Settings2,
    SquareStack,
    Trash2,
    Type,
    Users,
} from "../../../ui/icons";
import {
    type CSSProperties,
    type Dispatch,
    type SetStateAction,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {type EpisodeShotBulkPatch} from "../commands/shots";
import {type ColumnDef, normalizeVisibleColumns, SHOT_COLUMNS} from "../models/columns";
import {type Character, type Scene} from "../../library/models/assets";
import {getEpisodeShotFilters} from "../models/episodes";
import {normalizeEpisodeStory, type StoryBeat} from "../models/story";
import {normalizeShotSettings, normalizeShotStatus, type Shot, SHOT_STATUS_LABELS, SHOT_STATUSES, SHOT_UNASSIGNED_BEAT, type ShotColumnId, type ShotFilters, shotFiltersActive, type ShotGapFilter, type ShotStatus, type ShotWorkspaceView} from "../models/shots";
import {formatDuration} from "../../../ui/format";
import {moveIdToPosition, sameIdOrder,} from "../../../platform/collections/reorderIds";
import {filterShots} from "../services/shotFilters";
import {beatGroupIds, retainVisibleSelectedIds,} from "../services/shotKeyboard";
import {useUndo} from "../../../app/drafts/undo";
import {cn} from "../../../ui/cn";
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
import {Checkbox} from "../../../ui/checkbox";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import {SidePanel} from "../../../app/layout/SidePanel";
import {Input} from "../../../ui/input";
import {Label} from "../../../ui/label";
import {Popover, PopoverContent, PopoverTrigger} from "../../../ui/popover";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue,} from "../../../ui/select";
import {PageContent, PageHeader, PageState, PageToolbar} from "../../../app/layout/PageLayout";

export function ShotEditorPage(props: Parameters<typeof ShotEditorPageContent>[0]) {
    return <ShotEditorPageContent key={JSON.stringify([props.projectId, props.episodeId])} {...props}/>;
}

function ShotEditorPageContent({
                                   projectId,
                                   episodeId,
                                   focusShotId,
                               }: {
    projectId: string;
    episodeId: string;
    focusShotId?: string;
}) {
    const repository = useVideoWorkspaceRepository();
    const readStatus = useVideoWorkspaceReadStatus();
    const projectResult = useVideoWorkspaceQuery(
        async (repository) => ({projectId, project: await repository.project(projectId)}),
        [projectId],
    );
    const episodeResult = useVideoWorkspaceQuery(
        async (repository) => ({projectId, episodeId, episode: await repository.episode(episodeId)}),
        [projectId, episodeId],
    );
    const shotsResult = useVideoWorkspaceQuery(async (repository) => ({
        projectId, episodeId,
        shots: await repository.shots(episodeId),
    }), [projectId, episodeId]);
    const assetsResult = useVideoWorkspaceQuery(async (repository) => ({
        projectId,
        characters: await repository.characters(projectId),
        scenes: await repository.scenes(projectId),
    }), [projectId]);
    const workspaceUnavailable = useWorkspaceUnavailable();
    const loadedProject = projectResult?.projectId === projectId ? projectResult.project : undefined;
    const loadedEpisode = episodeResult?.projectId === projectId && episodeResult.episodeId === episodeId
        ? episodeResult.episode : undefined;
    const loadedShots = shotsResult?.projectId === projectId && shotsResult.episodeId === episodeId
        ? shotsResult.shots : undefined;
    const loadedCharacters = assetsResult?.projectId === projectId ? assetsResult.characters : undefined;
    const loadedScenes = assetsResult?.projectId === projectId ? assetsResult.scenes : undefined;
    const characters = useMemo(() => loadedCharacters ?? [], [loadedCharacters]);
    const scenes = useMemo(() => loadedScenes ?? [], [loadedScenes]);

    const relationAssets = useVideoWorkspaceQuery(async (repository) => ({
        projectId,
        props: await repository.props(projectId),
        styles: await repository.styles(projectId),
    }), [projectId]);
    const props = relationAssets?.projectId === projectId ? relationAssets.props : undefined;
    const styles = relationAssets?.projectId === projectId ? relationAssets.styles : undefined;
    const [relationShotId, setRelationShotId] = useState<string>();
    const [relationStatus, setRelationStatus] = useState<"saved" | "saving" | "error">("saved");
    const [openSlotShots, setOpenSlotShots] = useState<Record<string, number>>({});
    const onSlotOpenChange = useCallback((shotId: string, open: boolean) => {
        setOpenSlotShots(counts => ({...counts, [shotId]: Math.max(0, (counts[shotId] ?? 0) + (open ? 1 : -1))}));
    }, []);
    const shotText = useTextDraftRetention(loadedShots);
    const loadedBeats = useMemo(() => loadedEpisode ? normalizeEpisodeStory(loadedEpisode.story).beats : undefined, [loadedEpisode]);
    const beatText = useTextDraftRetention(loadedBeats);
    const manualSession = shotText.pending || beatText.pending || Object.values(openSlotShots).some(count => count > 0) || relationStatus !== "saved";
    const lastProject = useRef(loadedProject);
    const lastEpisode = useRef(loadedEpisode);
    const lastShots = useRef(loadedShots ?? []);
    if (loadedProject) lastProject.current = loadedProject;
    if (loadedEpisode) lastEpisode.current = loadedEpisode;
    const {shots, retainedCount} = useMemo(() => {
        const retained = lastShots.current.filter(shot =>
            ((openSlotShots[shot.id] ?? 0) > 0 || relationStatus !== "saved" && relationShotId === shot.id) &&
            !shotText.rows.some(current => current.id === shot.id));
        const current = retained.length > 0 ? [...shotText.rows, ...retained] : shotText.rows;
        lastShots.current = current;
        return {shots: current, retainedCount: retained.length + shotText.retainedCount};
    }, [shotText.rows, shotText.retainedCount, openSlotShots, relationStatus, relationShotId]);
    const project = loadedProject ?? (manualSession ? lastProject.current : loadedProject);
    const episode = loadedEpisode ?? (manualSession ? lastEpisode.current : loadedEpisode);
    const unavailable = workspaceUnavailable || !loadedProject || !loadedEpisode || retainedCount > 0 || beatText.retainedCount > 0;
    const relationNavigationGuard = useManualDraftGuard(relationStatus === "error", relationStatus === "saving" || shotText.pending || beatText.pending, () => {
        setRelationStatus("saved");
        setRelationShotId(undefined);
    });

    const visible = normalizeVisibleColumns(project?.columnSettings.visible);
    const visibleDefs = SHOT_COLUMNS.filter((column) => visible.includes(column.id));
    const shotSettings = normalizeShotSettings(project?.shotSettings);
    const workspaceView = shotSettings.workspaceView;
    const filters = getEpisodeShotFilters(episode ?? {story: normalizeEpisodeStory(undefined)}, project ?? undefined);
    const media = useShotMedia(shots);
    const filtersOn = shotFiltersActive(filters);
    const filteredShots = useMemo(() => filterShots(shots, filters, media), [shots, filters, media]);
    // A filter change must leave an unresolved field readable, just like virtualization.
    const visibleShots = filteredShots.concat(shots.filter(shot => shotText.isPending(shot.id) &&
        !filteredShots.some(current => current.id === shot.id)));
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [pendingBeatId, setPendingBeatId] = useState<string>();
    const [bulkBeatValue, setBulkBeatValue] = useState<string>();
    const [bulkDuration, setBulkDuration] = useState("");
    const [bulkStatus, setBulkStatus] = useState<string>();
    const [bulkSceneValue, setBulkSceneValue] = useState<string>();
    const [bulkNotes, setBulkNotes] = useState("");
    const [bulkCharacterIds, setBulkCharacterIds] = useState<string[]>([]);
    const [activeShotId, setActiveShotId] = useState<string>();
    const [highlightedShotId, setHighlightedShotId] = useState<string>();
    const {registerUndo} = useUndo();
    const sensors = useSensors(
        useSensor(PointerSensor, {activationConstraint: {distance: 6}}),
        useSensor(KeyboardSensor, {coordinateGetter: sortableKeyboardCoordinates}),
    );

    const beats = beatText.rows;
    const beatIdList = beats.map((beat) => beat.id);
    const grouped = beats.map((beat) => ({
        beat,
        shots: visibleShots.filter((shot) => shot.beatId === beat.id),
    }));
    // Keep SortableContext items in sync with mounted beat blocks; filtered-out
    // empty groups must not remain in the sortable id list.
    const visibleGrouped = grouped.filter(
        ({beat, shots: beatShots}) => beatText.isPending(beat.id) || !(filtersOn && beatShots.length === 0),
    );
    const ungrouped = visibleShots.filter(
        (shot) => !shot.beatId || !beats.some((beat) => beat.id === shot.beatId),
    );
    const empty = shots.length === 0 && beats.length === 0;
    const filterEmpty = !empty && filtersOn && visibleShots.length === 0;
    const visibleShotIds = useMemo(
        () => visibleShots.map((shot) => shot.id),
        [visibleShots],
    );

    const totalDuration = useMemo(
        () => visibleShots.reduce((sum, shot) => sum + (Number(shot.durationSec) || 0), 0),
        [visibleShots],
    );

    useEffect(() => {
        setRelationShotId(undefined);
        setRelationStatus("saved");
        setSelecting(false);
        setSelected(new Set());
        setConfirmDelete(false);
        setBulkBeatValue(undefined);
        setBulkDuration("");
        setBulkStatus(undefined);
        setBulkSceneValue(undefined);
        setBulkNotes("");
        setBulkCharacterIds([]);
        setActiveShotId(undefined);
        setHighlightedShotId(undefined);
    }, [episodeId]);

    const focusExists = shots.some((shot) => shot.id === focusShotId);
    const focusVisible = Boolean(focusShotId && visibleShotIds.includes(focusShotId));
    const mediaLoaded = media !== undefined;
    const focusContextLoaded = project?.id === projectId && episode?.id === episodeId && episode?.projectId === projectId;
    const revealedFocus = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (!focusShotId) {
            revealedFocus.current = undefined;
            return;
        }
        const focusKey = `${episodeId}:${focusShotId}`;
        if (revealedFocus.current === focusKey || !mediaLoaded || !focusContextLoaded) return;
        if (!focusExists) return;
        if (!focusVisible) {
            void repository.updateEpisodeShotFilters(episodeId, {statuses: [], beatIds: [], gaps: []})
                .then(() => toast.info("已清除当前集筛选，显示定位镜头"))
                .catch(() => toast.error("无法显示定位镜头，请重试"));
            return;
        }
        revealedFocus.current = focusKey;
        setHighlightedShotId(focusShotId);
        setActiveShotId(focusShotId);
        const frame = window.requestAnimationFrame(() => {
            document
                .getElementById(`shot-${focusShotId}`)
                ?.scrollIntoView({block: "center"});
        });
        const timeout = window.setTimeout(() => setHighlightedShotId(undefined), 3000);
        return () => {
            window.cancelAnimationFrame(frame);
            window.clearTimeout(timeout);
        };
    }, [focusShotId, episodeId, focusExists, focusVisible, mediaLoaded, focusContextLoaded, repository]);

    useEffect(() => {
        if (activeShotId && !visibleShotIds.includes(activeShotId)) {
            setActiveShotId(undefined);
        }
    }, [activeShotId, visibleShotIds]);

    useEffect(() => {
        setSelected((current) => {
            if (current.size === 0) return current;
            const next = retainVisibleSelectedIds(current, visibleShotIds);
            return next.size === current.size ? current : next;
        });
    }, [visibleShotIds]);

    useEffect(() => {
        if (!activeShotId) return;
        document
            .getElementById(`shot-${activeShotId}`)
            ?.scrollIntoView({block: "nearest"});
    }, [activeShotId]);

    const [commandError, setCommandError] = useState<string>();
    function reportShotError(error: unknown, fallback = "保存失败，请重试") {
        setCommandError(error instanceof Error && error.message ? error.message : fallback);
    }
    const reportCommandError = (error: unknown) => reportShotError(error);

    async function commitShotReorder(groupIds: string[], activeId: string, overId: string) {
        const action = await reorderShotGroupCommand({
            repository,
            episodeId,
            fullOrder: shots.map(shot => shot.id),
            groupIds,
            activeId,
            overId
        });
        if (action) registerUndo(action);
    }

    function moveShotByOffset(shotId: string, offset: -1 | 1) {
        const group = beatGroupIds(visibleShots, shotId, beatIdList);
        const targetId = group[group.indexOf(shotId) + offset];
        if (targetId) void commitShotReorder(group, shotId, targetId).catch(reportCommandError);
    }

    useShotEditorKeyboard({
        unavailable, visibleShotIds, activeShotId, hasSelection: selected.size > 0,
        onSelectAll: () => {
            setSelecting(true);
            setSelected(new Set(visibleShotIds));
        },
        onActivate: setActiveShotId,
        onToggleSelected: (id) => {
            setSelecting(true);
            setSelected(current => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id); else next.add(id);
                return next;
            });
        },
        onReorder: moveShotByOffset,
        onAdd: () => {
            void repository.addShot(projectId, episodeId, {beatId: shots.find(shot => shot.id === activeShotId)?.beatId}).catch(reportCommandError);
        },
        onDelete: () => setConfirmDelete(true),
    });

    async function persistFilters(next: ShotFilters) {
        await repository.updateEpisodeShotFilters(episodeId, next).catch((error: unknown) => {
            reportShotError(error, "筛选保存失败");
        });
    }

    function toggleFilterStatus(status: ShotStatus) {
        const statuses = filters.statuses.includes(status)
            ? filters.statuses.filter((item) => item !== status)
            : [...filters.statuses, status];
        void persistFilters({...filters, statuses});
    }

    function toggleFilterBeat(beatId: string) {
        const beatIds = filters.beatIds.includes(beatId)
            ? filters.beatIds.filter((item) => item !== beatId)
            : [...filters.beatIds, beatId];
        void persistFilters({...filters, beatIds});
    }

    function toggleFilterGap(gap: ShotGapFilter) {
        const gaps = filters.gaps.includes(gap)
            ? filters.gaps.filter((item) => item !== gap)
            : [...filters.gaps, gap];
        void persistFilters({...filters, gaps});
    }

    if (project === undefined || episode === undefined || loadedShots === undefined || loadedCharacters === undefined || loadedScenes === undefined || props === undefined || styles === undefined) {
        return <PageContent><PageState kind={readStatus.error ? "error" : "loading"}
                                       title={readStatus.error ? "读取工作区失败" : "正在读取分镜…"}
                                       description={readStatus.error} action={readStatus.error ?
            <Button onClick={readStatus.retry}>重新读取</Button> : undefined}/></PageContent>;
    }
    if (project === null) {
        return <PageContent><PageState kind="missing" title="找不到这个项目"/></PageContent>;
    }
    if (episode === null || episode.projectId !== projectId || episode.id !== episodeId) {
        return <PageContent><PageState kind="missing" title="找不到当前故事"/></PageContent>;
    }

    async function toggleColumn(id: ShotColumnId, next: boolean) {
        const current = visible.includes(id);
        if (next === current) return;
        await repository.setVisibleColumns(
            projectId,
            next ? [...visible, id] : visible.filter((item) => item !== id),
        );
    }

    async function onBeatDragEnd(event: DragEndEvent) {
        const {active, over} = event;
        if (!over || active.id === over.id) return;
        const previous = beats.map((beat) => beat.id);
        const next = moveIdToPosition(previous, String(active.id), String(over.id));
        if (!next || sameIdOrder(previous, next)) return;
        const committed = await repository.reorderBeats(episodeId, next);
        registerUndo({
            label: "已调整场次顺序",
            restore: committed?.restore ?? (async () => {
                await repository.reorderBeats(episodeId, previous);
            }),
        });
    }

    async function removeSelectedShots() {
        const action = await deleteShotSelectionCommand({repository, episodeId, selectedIds: [...selected]});
        if (!action) return;
        registerUndo(action);
        setSelected(new Set());
    }

    async function applyBulkPatch(label: string, patch: EpisodeShotBulkPatch) {
        const action = await applyShotBulkCommand({repository, episodeId, selectedIds: [...selected], patch, label});
        if (action) registerUndo(action);
    }

    async function assignSelectedBeat(beatId: string | undefined) {
        try {
            await applyBulkPatch(`已调整 ${selected.size} 个镜头的场次`, {beatId});
        } finally {
            setBulkBeatValue(undefined);
        }
    }

    async function setSelectedDuration() {
        const durationSec = Math.max(0, Number(bulkDuration) || 0);
        await applyBulkPatch(`已调整 ${selected.size} 个镜头的时长`, {durationSec});
        setBulkDuration("");
    }

    async function assignSelectedStatus(status: ShotStatus) {
        try {
            await applyBulkPatch(`已调整 ${selected.size} 个镜头的状态`, {status});
        } finally {
            setBulkStatus(undefined);
        }
    }

    async function assignSelectedScene(sceneId: string | undefined) {
        try {
            await applyBulkPatch(`已调整 ${selected.size} 个镜头的场景`, {sceneId});
        } finally {
            setBulkSceneValue(undefined);
        }
    }

    async function assignSelectedNotes() {
        await applyBulkPatch(`已调整 ${selected.size} 个镜头的备注`, {notes: bulkNotes});
        setBulkNotes("");
    }

    async function assignSelectedCharacters() {
        await applyBulkPatch(`已调整 ${selected.size} 个镜头的角色`, {
            characterIds: [...bulkCharacterIds],
        });
    }

    function selectAllVisible() {
        setSelecting(true);
        setSelected(new Set(visibleShotIds));
    }

    async function setWorkspaceView(next: ShotWorkspaceView) {
        await repository.updateShotSettings(projectId, {workspaceView: next});
    }

    async function removeBeat(beatId: string) {
        const index = beats.findIndex((beat) => beat.id === beatId);
        const beat = beats[index];
        if (!beat) return;
        const shotIds = shots.filter((shot) => shot.beatId === beatId).map((shot) => shot.id);
        const committed = await repository.deleteStoryBeat(episodeId, beatId);
        registerUndo({
            label: "已删除场次",
            restore: committed?.restore ?? (() => repository.restoreStoryBeat(episodeId, beat, index, shotIds)),
        });
        setPendingBeatId(undefined);
    }

    async function copyShot(shotId: string) {
        const copy = await repository.duplicateShot(shotId);
        registerUndo({
            label: "已复制镜头",
            restore: copy.undo?.restore ?? (() => repository.deleteShots([copy.id])),
        });
    }

    return (
        <>
            <VideoWorkspaceReadNotice {...readStatus}/>
            {relationNavigationGuard}
            <div className="flex h-full min-h-0 min-w-0 flex-col">
                {unavailable && <p role="alert" className="p-4">当前项目、故事或镜头已不可用，未完成的修改仍保留。</p>}
                <PageHeader dense title="分镜" className="shrink-0 border-b px-4 py-3 sm:px-5" actions={
                                                                                                    <DropdownMenu>
                                                                                                       <DropdownMenuTrigger
                                                                                                           asChild>
                                                                                                           <Button
                                                                                                               size="sm"
                                                                                                               variant="brand">
                                                                                                               <Plus/>
                                                                                                               新建
                                                                                                               <ChevronDown/>
                                                                                                           </Button>
                                                                                                       </DropdownMenuTrigger>
                                                                                                       <DropdownMenuContent
                                                                                                           align="start"
                                                                                                           className="w-48">
                                                                                                           <DropdownMenuItem
                                                                                                               onClick={() => void repository.addShot(projectId, episodeId).catch(reportCommandError)}>
                                                                                                               <Plus/>
                                                                                                               创建分镜
                                                                                                           </DropdownMenuItem>
                                                                                                           <DropdownMenuItem
                                                                                                               onClick={() => void repository.addShots(projectId, episodeId, 5).catch(reportCommandError)}>
                                                                                                               <CopyPlus/>
                                                                                                               创建5个分镜
                                                                                                           </DropdownMenuItem>
                                                                                                           <DropdownMenuItem
                                                                                                               onClick={() => void repository.addShots(projectId, episodeId, 10).catch(reportCommandError)}>
                                                                                                               <CopyPlus/>
                                                                                                               创建10个分镜
                                                                                                           </DropdownMenuItem>
                                                                                                           <DropdownMenuSeparator/>
                                                                                                           <DropdownMenuItem
                                                                                                               onClick={() => void repository.addStoryBeat(episodeId).catch(reportCommandError)}>
                                                                                                               <SquareStack/>
                                                                                                               创建场
                                                                                                           </DropdownMenuItem>
                                                                                                       </DropdownMenuContent>
                                                                                                   </DropdownMenu>}/>
                <PageToolbar className="shrink-0 px-4 py-2 sm:px-5" style={{marginBlock: 0}}>
                    <div className="flex flex-wrap items-center gap-1">
                        <Button size="sm" variant="outline" disabled={visibleShots.length === 0}
                                onClick={() => setRelationShotId(visibleShots.find((shot) => shot.id === activeShotId)?.id ?? visibleShots[0]?.id)}>
                            <Settings2/>道具与风格
                        </Button>
                        <div
                            className="bg-muted flex rounded-md p-0.5"
                            role="group"
                            aria-label="分镜视图"
                        >
                            <Button
                                size="sm"
                                variant={workspaceView === "design" ? "secondary" : "ghost"}
                                aria-pressed={workspaceView === "design"}
                                onClick={() => void setWorkspaceView("design").catch(reportCommandError)}
                            >
                                <LayoutList/>
                                设计
                            </Button>
                            <Button
                                size="sm"
                                variant={workspaceView === "media" ? "secondary" : "ghost"}
                                aria-pressed={workspaceView === "media"}
                                onClick={() => void setWorkspaceView("media").catch(reportCommandError)}
                            >
                                <Images/>
                                素材
                            </Button>
                        </div>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button size="sm" variant={filtersOn ? "secondary" : "ghost"}>
                                    <Filter/>
                                    筛选
                                    {filtersOn ? (
                                        <span className="text-muted-foreground text-xs">
                    {visibleShots.length}/{shots.length}
                  </span>
                                    ) : null}
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56">
                                <DropdownMenuLabel className="flex items-center justify-between">
                                    状态
                                    {filters.statuses.length > 0 ? (
                                        <button
                                            type="button"
                                            className="text-muted-foreground hover:text-foreground text-xs font-normal"
                                            onClick={() => void persistFilters({...filters, statuses: []})}
                                        >
                                            清除
                                        </button>
                                    ) : null}
                                </DropdownMenuLabel>
                                {SHOT_STATUSES.map((status) => (
                                    <DropdownMenuCheckboxItem
                                        key={status}
                                        checked={filters.statuses.includes(status)}
                                        onCheckedChange={() => toggleFilterStatus(status)}
                                    >
                                        {SHOT_STATUS_LABELS[status]}
                                    </DropdownMenuCheckboxItem>
                                ))}
                                <DropdownMenuSeparator/>
                                <DropdownMenuLabel className="flex items-center justify-between">
                                    场次
                                    {filters.beatIds.length > 0 ? (
                                        <button
                                            type="button"
                                            className="text-muted-foreground hover:text-foreground text-xs font-normal"
                                            onClick={() => void persistFilters({...filters, beatIds: []})}
                                        >
                                            清除
                                        </button>
                                    ) : null}
                                </DropdownMenuLabel>
                                <DropdownMenuCheckboxItem
                                    checked={filters.beatIds.includes(SHOT_UNASSIGNED_BEAT)}
                                    onCheckedChange={() => toggleFilterBeat(SHOT_UNASSIGNED_BEAT)}
                                >
                                    未分场
                                </DropdownMenuCheckboxItem>
                                {beats.map((beat) => (
                                    <DropdownMenuCheckboxItem
                                        key={beat.id}
                                        checked={filters.beatIds.includes(beat.id)}
                                        onCheckedChange={() => toggleFilterBeat(beat.id)}
                                    >
                                        {beat.title || "未命名场"}
                                    </DropdownMenuCheckboxItem>
                                ))}
                                <DropdownMenuSeparator/>
                                <DropdownMenuLabel className="flex items-center justify-between">
                                    缺口
                                    {filters.gaps.length > 0 ? (
                                        <button
                                            type="button"
                                            className="text-muted-foreground hover:text-foreground text-xs font-normal"
                                            onClick={() => void persistFilters({...filters, gaps: []})}
                                        >
                                            清除
                                        </button>
                                    ) : null}
                                </DropdownMenuLabel>
                                <DropdownMenuCheckboxItem
                                    checked={filters.gaps.includes("missingFirstFrame")}
                                    onCheckedChange={() => toggleFilterGap("missingFirstFrame")}
                                >
                                    缺首帧
                                </DropdownMenuCheckboxItem>
                                <DropdownMenuCheckboxItem
                                    checked={filters.gaps.includes("missingClip")}
                                    onCheckedChange={() => toggleFilterGap("missingClip")}
                                >
                                    缺成片
                                </DropdownMenuCheckboxItem>
                                {filtersOn ? (
                                    <>
                                        <DropdownMenuSeparator/>
                                        <DropdownMenuItem
                                            onClick={() =>
                                                void persistFilters({statuses: [], beatIds: [], gaps: []})
                                            }
                                        >
                                            清除全部筛选
                                        </DropdownMenuItem>
                                    </>
                                ) : null}
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <Button
                            size="sm"
                            variant={selecting ? "secondary" : "ghost"}
                            aria-pressed={selecting}
                            onClick={() => {
                                setSelecting((value) => !value);
                                setSelected(new Set());
                            }}
                        >
                            <CheckSquare/>
                            选择
                        </Button>
                        {selecting ? (
                            <Button
                                size="sm"
                                variant="destructive"
                                disabled={selected.size === 0}
                                onClick={() => setConfirmDelete(true)}
                            >
                                删除所选
                            </Button>
                        ) : null}
                        <Popover>
                            <PopoverTrigger asChild>
                                <Button size="sm" variant="ghost">
                                    <Settings2/>
                                    分镜设置
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent align="end" className="w-72 space-y-3">
                                <div className="flex items-center justify-between gap-3">
                                    <Label htmlFor="default-shot-duration">默认时长（秒）</Label>
                                    <Input
                                        id="default-shot-duration"
                                        type="number"
                                        min={0}
                                        className="h-8 w-20"
                                        value={shotSettings.defaultDurationSec}
                                        onChange={(event) =>
                                            void repository.updateShotSettings(projectId, {
                                                defaultDurationSec: Math.max(0, Number(event.target.value) || 0),
                                            }).catch(reportCommandError)
                                        }
                                    />
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                    <Label htmlFor="auto-shot-number">镜号自动递增</Label>
                                    <Checkbox
                                        id="auto-shot-number"
                                        checked={shotSettings.autoIncrementShotNumber}
                                        onCheckedChange={(checked) =>
                                            void repository.updateShotSettings(projectId, {
                                                autoIncrementShotNumber: checked === true,
                                            }).catch(reportCommandError)
                                        }
                                    />
                                </div>
                            </PopoverContent>
                        </Popover>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button size="sm" variant="outline">
                                    <Columns3/>
                                    列设置
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56">
                                <DropdownMenuLabel className="flex items-center justify-between">
                                    列设置
                                    <button
                                        type="button"
                                        className="text-muted-foreground hover:text-foreground text-xs font-normal"
                                        onClick={() =>
                                            void repository.setVisibleColumns(
                                                projectId,
                                                SHOT_COLUMNS.map((column) => column.id),
                                            )
                                        }
                                    >
                                        全部显示
                                    </button>
                                </DropdownMenuLabel>
                                <DropdownMenuSeparator/>
                                {SHOT_COLUMNS.map((column) => {
                                    const Icon =
                                        column.kind === "number" ? Hash : column.kind === "select" ? Users : Type;
                                    return (
                                        <DropdownMenuCheckboxItem
                                            key={column.id}
                                            checked={visible.includes(column.id)}
                                            onCheckedChange={(checked) => void toggleColumn(column.id, checked).catch(reportCommandError)}
                                        >
                                            <Icon className="text-muted-foreground"/>
                                            {column.label}
                                        </DropdownMenuCheckboxItem>
                                    );
                                })}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </PageToolbar>

                {selecting ? (
                    <div className="bg-muted/60 flex min-h-12 shrink-0 flex-wrap items-center gap-3 border-y px-5 py-2">
                        <span className="text-sm font-medium">已选 {selected.size} 个镜头</span>
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={visibleShotIds.length === 0}
                            onClick={selectAllVisible}
                        >
                            全选可见
                        </Button>
                        <Select
                            disabled={selected.size === 0}
                            value={bulkStatus}
                            onValueChange={(value) => {
                                setBulkStatus(value);
                                void assignSelectedStatus(normalizeShotStatus(value)).catch(reportCommandError);
                            }}
                        >
                            <SelectTrigger aria-label="批量状态" className="h-8 w-32 bg-background">
                                <SelectValue placeholder="批量状态"/>
                            </SelectTrigger>
                            <SelectContent>
                                {SHOT_STATUSES.map((status) => (
                                    <SelectItem key={status} value={status}>
                                        {SHOT_STATUS_LABELS[status]}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Select
                            disabled={selected.size === 0}
                            value={bulkBeatValue}
                            onValueChange={(value) => {
                                setBulkBeatValue(value);
                                void assignSelectedBeat(value === "none" ? undefined : value).catch(reportCommandError);
                            }}
                        >
                            <SelectTrigger aria-label="批量调整场次" className="h-8 w-40 bg-background">
                                <SelectValue placeholder="批量调整场次"/>
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="none">未分场</SelectItem>
                                {beats.map((beat) => (
                                    <SelectItem key={beat.id} value={beat.id}>
                                        {beat.title || "未命名场"}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Select
                            disabled={selected.size === 0}
                            value={bulkSceneValue}
                            onValueChange={(value) => {
                                setBulkSceneValue(value);
                                void assignSelectedScene(value === "none" ? undefined : value).catch(reportCommandError);
                            }}
                        >
                            <SelectTrigger aria-label="批量场景" className="h-8 w-40 bg-background">
                                <SelectValue placeholder="批量场景"/>
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="none">未选择</SelectItem>
                                {scenes.map((scene) => (
                                    <SelectItem key={scene.id} value={scene.id}>
                                        {scene.name || "未命名场景"}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Popover>
                            <PopoverTrigger asChild>
                                <Button size="sm" variant="outline" disabled={selected.size === 0}>
                                    <Users/>
                                    批量角色
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent align="start" className="w-64 space-y-3">
                                <p className="text-sm font-medium">替换所选镜头的角色</p>
                                <div className="flex max-h-48 flex-col gap-1 overflow-auto">
                                    {characters.length === 0 ? (
                                        <p className="text-muted-foreground text-xs">项目里还没有角色</p>
                                    ) : (
                                        characters.map((character) => (
                                            <label key={character.id} className="flex items-center gap-2 text-sm">
                                                <Checkbox
                                                    checked={bulkCharacterIds.includes(character.id)}
                                                    onCheckedChange={(checked) => {
                                                        setBulkCharacterIds((current) =>
                                                            checked
                                                                ? [...current, character.id]
                                                                : current.filter((id) => id !== character.id),
                                                        );
                                                    }}
                                                />
                                                {character.name || "未命名角色"}
                                            </label>
                                        ))
                                    )}
                                </div>
                                <Button
                                    size="sm"
                                    className="w-full"
                                    disabled={selected.size === 0}
                                    onClick={() => void assignSelectedCharacters().catch(reportCommandError)}
                                >
                                    应用角色
                                </Button>
                            </PopoverContent>
                        </Popover>
                        <Input
                            type="number"
                            min={0}
                            aria-label="批量设置时长（秒）"
                            className="h-8 w-28 bg-background"
                            value={bulkDuration}
                            placeholder="时长（秒）"
                            disabled={selected.size === 0}
                            onChange={(event) => setBulkDuration(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && bulkDuration !== "") void setSelectedDuration().catch(reportCommandError);
                            }}
                        />
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={selected.size === 0 || bulkDuration === ""}
                            onClick={() => void setSelectedDuration().catch(reportCommandError)}
                        >
                            应用时长
                        </Button>
                        <Input
                            aria-label="批量设置备注"
                            className="h-8 w-40 bg-background"
                            value={bulkNotes}
                            placeholder="备注"
                            disabled={selected.size === 0}
                            onChange={(event) => setBulkNotes(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") void assignSelectedNotes().catch(reportCommandError);
                            }}
                        />
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={selected.size === 0}
                            onClick={() => void assignSelectedNotes().catch(reportCommandError)}
                        >
                            应用备注
                        </Button>
                    </div>
                ) : null}

                <div className="relative min-h-0 flex-1">
                    {commandError ? <div role="alert"
                                         className="text-destructive flex items-center justify-between gap-2 px-4 py-1 text-sm">
                        <span>{commandError}</span>
                        <Button size="sm" variant="ghost" onClick={() => setCommandError(undefined)}>知道了</Button>
                    </div> : null}
                    <ShotCommandErrorContext value={reportShotError}>
                    <ShotScrollViewport>
                        <div
                            className={cn(
                                empty || filterEmpty ? "" : "pb-16",
                                // Media rows use 1fr columns and must fill the scrollport; design keeps min-w-max for many cols.
                                workspaceView === "media" ? "w-full min-w-0" : "min-w-max",
                            )}
                        >
                            <div
                                className="bg-muted text-muted-foreground grid items-stretch border-y text-xs"
                                style={{
                                    gridTemplateColumns: gridColumns(workspaceView, visibleDefs),
                                }}
                            >
                                {(workspaceView === "media"
                                        ? ["顺序", "镜号", "状态", "首帧", "尾帧", "成片", "内容"]
                                        : ["顺序", "镜号", "状态", ...visibleDefs.map((column) => column.label)]
                                ).map(
                                    (label) => (
                                        <div key={label} className="px-3 py-2.5">
                                            {label}
                                        </div>
                                    ),
                                )}
                            </div>

                            <DndContext
                                sensors={sensors}
                                collisionDetection={closestCenter}
                                onDragEnd={(event) => void onBeatDragEnd(event).catch(reportCommandError)}
                            >
                                <SortableContext
                                    items={visibleGrouped.map(({beat}) => beat.id)}
                                    strategy={verticalListSortingStrategy}
                                >
                                    {visibleGrouped.map(({beat, shots: beatShots}) => (
                                        <BeatBlock
                                            key={beat.id}
                                            beat={beat}
                                            shots={beatShots}
                                            projectId={projectId}
                                            episodeId={episodeId}
                                            selecting={selecting}
                                            selected={selected}
                                            setSelected={setSelected}
                                            activeShotId={activeShotId}
                                            setActiveShotId={setActiveShotId}
                                            workspaceView={workspaceView}
                                            visibleDefs={visibleDefs}
                                            characters={characters}
                                            scenes={scenes}
                                            highlightedShotId={highlightedShotId}
                                            sortable
                                            sensors={sensors}
                                            onDeleteBeat={() => setPendingBeatId(beat.id)}
                                            onReorderShots={commitShotReorder}
                                            unavailable={unavailable}
                                            onShotDraftStatus={shotText.onStatusChange}
                                            onBeatDraftStatus={beatText.onStatusChange}
                                            pendingShotIds={shots.filter(shot => shotText.isPending(shot.id)).map(shot => shot.id)}
                                            onSlotOpenChange={onSlotOpenChange}
                                            onEditRelations={setRelationShotId}
                                            onDuplicateShot={(shotId) => void copyShot(shotId).catch(reportCommandError)}
                                        />
                                    ))}
                                </SortableContext>
                            </DndContext>

                            {!filterEmpty && ungrouped.length > 0 ? (
                                <BeatBlock
                                    beat={{id: "", title: "未分场", content: "", characterIds: [], timeOfDay: ""}}
                                    shots={ungrouped}
                                    projectId={projectId}
                                    episodeId={episodeId}
                                    selecting={selecting}
                                    selected={selected}
                                    setSelected={setSelected}
                                    activeShotId={activeShotId}
                                    setActiveShotId={setActiveShotId}
                                    workspaceView={workspaceView}
                                    visibleDefs={visibleDefs}
                                    characters={characters}
                                    scenes={scenes}
                                    highlightedShotId={highlightedShotId}
                                    loose
                                    hideHeader={beats.length === 0}
                                    sensors={sensors}
                                    onReorderShots={commitShotReorder}
                                    unavailable={unavailable}
                                    onShotDraftStatus={shotText.onStatusChange}
                                    onBeatDraftStatus={beatText.onStatusChange}
                                    pendingShotIds={shots.filter(shot => shotText.isPending(shot.id)).map(shot => shot.id)}
                                    onSlotOpenChange={onSlotOpenChange}
                                    onEditRelations={setRelationShotId}
                                    onDuplicateShot={(shotId) => void copyShot(shotId).catch(reportCommandError)}
                                />
                            ) : null}
                        </div>
                        {empty ? <PageState className="pb-16" title="还没有镜头"
                                           /> : null}
                        {filterEmpty ? (
                            <PageState className="pb-16" title="没有符合当前筛选的镜头" action={<Button
                                size="sm"
                                variant="outline"
                                onClick={() => void persistFilters({statuses: [], beatIds: [], gaps: []})}
                            >
                                清除筛选
                            </Button>}/>
                        ) : null}
                    </ShotScrollViewport>
                    </ShotCommandErrorContext>

                    <div className="text-muted-foreground pointer-events-none absolute bottom-3 left-4 text-xs">
                        镜头总数 {filtersOn ? `${visibleShots.length}/${shots.length}` : shots.length}
                        <span className="mx-3">总时长 {formatDuration(totalDuration)}</span>
                    </div>
                </div>

                <SidePanel open={Boolean(relationShotId)} onOpenChange={(open) => {
                    if (open) return;
                    if (relationStatus !== "saved") {
                        toast.error(relationStatus === "saving" ? "正在保存，请稍候" : "保存未成功，请先重试或放弃未保存的选择");
                        return;
                    }
                    setRelationShotId(undefined);
                }} kind="shot-relations" width={440} title="镜头道具与风格" description="选择自动保存。风格可跟随项目，也可为这条镜头单独指定。">
                        <Select value={relationShotId} onValueChange={setRelationShotId}
                                disabled={relationStatus !== "saved"}>
                            <SelectTrigger aria-label="选择要编辑的镜头"
                                           className="w-full"><SelectValue/></SelectTrigger>
                            <SelectContent>
                                {shots.map((shot) => <SelectItem key={shot.id}
                                                                 value={shot.id}>镜 {shot.shotNumber || shot.order + 1} · {shot.content.slice(0, 36) || "未写内容"}</SelectItem>)}
                            </SelectContent>
                        </Select>
                        {shots.find((shot) => shot.id === relationShotId) ? (
                            <ShotRelationsEditor key={relationShotId} project={project}
                                                 shot={shots.find((shot) => shot.id === relationShotId)!} props={props}
                                                 styles={styles} unavailable={unavailable}
                                                 onStatusChange={setRelationStatus}/>
                        ) : <div className="space-y-2">
                            <p className="text-muted-foreground text-sm">这个镜头已不存在，请选择其他镜头。</p>
                            {relationStatus === "error" && <Button variant="ghost"
                                                                   onClick={() => setRelationStatus("saved")}>放弃未保存的选择</Button>}
                        </div>}
                </SidePanel>

                <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>删除镜头</AlertDialogTitle>
                            <AlertDialogDescription>将删除 {selected.size} 个镜头。</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>取消</AlertDialogCancel>
                            <AlertDialogAction
                                className="bg-destructive hover:bg-destructive/90"
                                onClick={() => {
                                    void removeSelectedShots().catch(reportCommandError);
                                }}
                            >
                                删除
                            </AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
                <AlertDialog
                    open={Boolean(pendingBeatId)}
                    onOpenChange={(open) => !open && setPendingBeatId(undefined)}
                >
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>删除这场</AlertDialogTitle>
                            <AlertDialogDescription>
                                场会去掉，镜头还在，变成未分场。
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>取消</AlertDialogCancel>
                            <AlertDialogAction
                                className="bg-destructive hover:bg-destructive/90"
                                onClick={event => {
                                    event.preventDefault();
                                    if (!pendingBeatId) return;
                                    void removeBeat(pendingBeatId).catch(reportCommandError);
                                }}
                            >
                                删除场
                            </AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </div>
        </>
    );
}


type BeatBlockProps = {
    beat: StoryBeat;
    shots: Shot[];
    projectId: string;
    episodeId: string;
    selecting: boolean;
    selected: Set<string>;
    setSelected: Dispatch<SetStateAction<Set<string>>>;
    activeShotId?: string;
    setActiveShotId: Dispatch<SetStateAction<string | undefined>>;
    workspaceView: ShotWorkspaceView;
    visibleDefs: ColumnDef[];
    characters: Character[];
    scenes: Scene[];
    highlightedShotId?: string;
    loose?: boolean;
    hideHeader?: boolean;
    sortable?: boolean;
    sensors: ReturnType<typeof useSensors>;
    onDeleteBeat?: () => void;
    onReorderShots: (groupIds: string[], activeId: string, overId: string) => Promise<void>;
    unavailable: boolean;
    onSlotOpenChange: (shotId: string, open: boolean) => void;
    onShotDraftStatus: TextDraftStatusChange;
    onBeatDraftStatus: TextDraftStatusChange;
    pendingShotIds: string[];
    onEditRelations: (shotId: string) => void;
    onDuplicateShot: (shotId: string) => void;
};

function BeatBlock(props: BeatBlockProps) {
    if (props.sortable) return <SortableBeatBlock {...props} />;
    return <BeatBlockView {...props} />;
}

function SortableBeatBlock(props: BeatBlockProps) {
    const sortable = useSortable({id: props.beat.id, disabled: props.selecting});
    return <BeatBlockView {...props} sortableState={sortable}/>;
}

function BeatBlockView({
                           beat,
                           shots,
                           projectId,
                           episodeId,
                           selecting,
                           selected,
                           setSelected,
                           activeShotId,
                           setActiveShotId,
                           workspaceView,
                           visibleDefs,
                           characters,
                           scenes,
                           highlightedShotId,
                           loose,
                           hideHeader,
                           sensors,
                           onDeleteBeat,
                           onReorderShots,
                           onDuplicateShot,
                           onEditRelations,
                           onSlotOpenChange,
                           onShotDraftStatus,
                           onBeatDraftStatus,
                           pendingShotIds,
                           unavailable,
                           sortableState,
                       }: BeatBlockProps & {
    sortableState?: ReturnType<typeof useSortable>;
}) {
    const repository = useVideoWorkspaceRepository();
    const reportShotError = useShotCommandError();
    const reportCommandError = (error: unknown) => reportShotError(error);
    const duration = shots.reduce((sum, shot) => sum + (Number(shot.durationSec) || 0), 0);
    const shotIds = shots.map((shot) => shot.id);
    const style: CSSProperties | undefined = sortableState
        ? {
            transform: CSS.Transform.toString(sortableState.transform),
            transition: sortableState.transition,
            opacity: sortableState.isDragging ? 0.72 : undefined,
            position: sortableState.isDragging ? "relative" : undefined,
            zIndex: sortableState.isDragging ? 20 : undefined,
        }
        : undefined;

    async function onShotDragEnd(event: DragEndEvent) {
        const {active, over} = event;
        if (!over || active.id === over.id) return;
        await onReorderShots(shotIds, String(active.id), String(over.id));
    }

    return (
        <section ref={sortableState?.setNodeRef} style={style}>
            {hideHeader ? null : (
                <div className="bg-muted/70 flex min-w-max items-center gap-2 border-b px-3 py-2">
                    {sortableState && !selecting ? (
                        <button
                            type="button"
                            className="text-muted-foreground hover:text-foreground inline-flex size-7 shrink-0 cursor-grab items-center justify-center rounded-md active:cursor-grabbing"
                            aria-label="拖拽调整场次顺序"
                            {...sortableState.attributes}
                            {...sortableState.listeners}
                        >
                            <GripVertical className="size-3.5"/>
                        </button>
                    ) : (
                        <SquareStack className="text-muted-foreground size-3.5 shrink-0"/>
                    )}
                    {loose ? (
                        <p className="text-sm font-medium">未分场</p>
                    ) : (
                        <BeatTextField projectId={projectId} episodeId={episodeId} beat={beat} field="title"
                                       onDraftStatus={onBeatDraftStatus} unavailable={unavailable} ariaLabel="场次标题"
                                       containerClassName="max-w-xs" className="h-8"/>
                    )}
                    <p className="text-muted-foreground text-xs">
                        {shots.length} 镜 · {formatDuration(duration)}
                    </p>
                    {loose ? null : (
                        <Button
                            size="icon-sm"
                            variant="ghost"
                            className="ml-auto"
                            aria-label="删除场"
                            onClick={onDeleteBeat}
                        >
                            <Trash2/>
                        </Button>
                    )}
                </div>
            )}
            {shots.length === 0 ? (
                <div className="text-muted-foreground flex items-center gap-3 border-b px-4 py-6 text-xs">
                    这场还没有镜头
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void repository.addShot(projectId, episodeId, {beatId: beat.id}).catch(reportCommandError)}
                    >
                        <Plus/>
                        添加镜头
                    </Button>
                </div>
            ) : (
                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={(event) => void onShotDragEnd(event).catch(reportCommandError)}
                >
                    <SortableContext items={shotIds} strategy={verticalListSortingStrategy}>
                        {shots.map((shot, index) => (
                            <ShotRow
                                textPending={pendingShotIds.includes(shot.id)}
                                onDraftStatus={onShotDraftStatus}
                                key={shot.id}
                                shot={shot}
                                striped={index % 2 === 1}
                                initiallyVisible={shot.order < 6}
                                projectId={projectId}
                                episodeId={episodeId}
                                selecting={selecting}
                                selected={selected.has(shot.id)}
                                onSelectedChange={(checked) => setSelected(current => {
                                    const next = new Set(current);
                                    if (checked) next.add(shot.id); else next.delete(shot.id);
                                    return next;
                                })}
                                active={activeShotId === shot.id || highlightedShotId === shot.id}
                                onActivate={() => setActiveShotId(shot.id)}
                                workspaceView={workspaceView}
                                visibleDefs={visibleDefs}
                                characters={characters}
                                scenes={scenes}
                                beatId={loose ? undefined : beat.id}
                                showBelow={index === shots.length - 1}
                                canMoveUp={index > 0}
                                canMoveDown={index < shots.length - 1}
                                onMove={(offset) => {
                                    const target = shots[index + offset];
                                    if (target) void onReorderShots(shotIds, shot.id, target.id).catch(reportCommandError);
                                }}
                                unavailable={unavailable}
                                onSlotOpenChange={(open) => onSlotOpenChange(shot.id, open)}
                                onEditRelations={() => onEditRelations(shot.id)}
                                onDuplicate={() => onDuplicateShot(shot.id)}
                            />
                        ))}
                    </SortableContext>
                </DndContext>
            )}
        </section>
    );
}
