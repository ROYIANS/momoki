import {beforeEach, describe, expect, it, vi} from "vitest";
import type {ReactElement} from "react";
import type {Episode} from "@/features/video/models/episodes";
import type {Project} from "@/features/projects/models/project";
import type {Shot} from "@/features/video/models/shots";

const host = vi.hoisted(() => ({
    cells: [] as unknown[], cursor: 0, results: [] as unknown[], queryIndex: 0,
    queries: [] as Array<() => Promise<unknown>>, pathname: "", storage: "indexeddb", repository: undefined as unknown,
    liveQueries: [] as Array<() => Promise<unknown>>,
    navigate: vi.fn(), readError: undefined as string | undefined, retry: vi.fn(), registerUndo: vi.fn(),
}));
vi.mock("react", async original => {
    const actual = await original<typeof import("react")>();
    return {...actual,
        useState: (initial: unknown) => {const index = host.cursor++; if (!(index in host.cells)) host.cells[index] = typeof initial === "function" ? initial() : initial; return [host.cells[index], (next: unknown) => {host.cells[index] = typeof next === "function" ? next(host.cells[index]) : next;}];},
        useRef: (initial: unknown) => {const index = host.cursor++; if (!(index in host.cells)) host.cells[index] = {current: initial}; return host.cells[index];},
        useEffect: () => undefined,
        useMemo: (compute: () => unknown) => compute(), useCallback: (callback: unknown) => callback,
        useContext: () => false,
    };
});
vi.mock("@/platform/runtime/storageProfile", () => ({usesSqliteProductStorage: () => host.storage === "sqlite"}));
vi.mock("@/features/video/services/workspaceRepository", () => ({
    getVideoWorkspaceRepository: () => host.repository,
    useVideoWorkspaceRepository: () => host.repository,
    useVideoWorkspaceReadStatus: () => ({error: host.readError, retry: host.retry}),
    useVideoWorkspaceQuery: (query: (repository: unknown) => Promise<unknown>) => {host.queries.push(() => query(host.repository)); return host.results[host.queryIndex++];},
}));
vi.mock("@tanstack/react-router", () => ({
    Link: () => null, Navigate: () => null, Outlet: () => null, useNavigate: () => host.navigate,
    createFileRoute: () => (options: unknown) => ({options}), redirect: (options: unknown) => options,
    useBlocker: () => ({status: "idle"}),
    useRouterState: ({select}: {select: (state: unknown) => unknown}) => select({location: {pathname: host.pathname}}),
}));
vi.mock("@dnd-kit/core", () => ({DndContext: () => null, PointerSensor: {}, KeyboardSensor: {}, closestCenter: {}, useSensor: vi.fn(), useSensors: () => []}));
vi.mock("@dnd-kit/sortable", () => ({SortableContext: () => null, sortableKeyboardCoordinates: {}, verticalListSortingStrategy: {}, useSortable: () => ({setNodeRef: vi.fn()})}));
vi.mock("@/app/drafts/undo", () => ({useUndo: () => ({registerUndo: host.registerUndo})}));
vi.mock("@/platform/product/queries", () => ({useProductQuery: (query: (tx: typeof db) => Promise<unknown>) => {
    host.liveQueries.push(() => query(db)); return undefined;
}}));
vi.mock("@/features/video/queries/useShotMedia", () => ({useShotMedia: () => new Map()}));
vi.mock("@/features/video/ui/ShotRowViewport", () => ({ShotScrollViewport: () => null, useShotRowViewport: () => ({rowRef: vi.fn(), nearViewport: true})}));
vi.mock("sonner", () => ({toast: {error: vi.fn(), success: vi.fn()}}));

import {Outlet} from "@tanstack/react-router";
import {db} from "@/platform/product/store";
import {emptyEpisode, emptyShot} from "@/features/video/models/newRecords";
import {emptyProject} from "@/features/projects/models/newProject";
import {AppFrame} from "@/app/layout/AppFrame";
import {PageHeader, PageState} from "@/app/layout/PageLayout";
import {WorkspaceChrome} from "@/app/workspace/WorkspaceChrome";
import {AppHeaderPortal} from "@/app/layout/AppHeaderPortal";
import {ProjectHomePage} from "@/app/workspace/ProjectHomePage";
import {WorkspaceCapabilityState} from "@/app/workspace/WorkspaceCapabilityState";
import {StoryPage} from "@/features/video/ui/StoryPage";
import {ShotEditorPage} from "@/features/video/ui/ShotEditorPage";
import {BeatTextField} from "@/features/video/ui/BeatTextField";
import {ShotTextField} from "@/features/video/ui/ShotTextField";
import {TextDraftField} from "@/app/drafts/TextDraftField";
import {ShotRow} from "@/features/video/ui/ShotRow";
import {EditableGenerationSlot} from "@/features/library/ui/GenerationSlotCard";
import {VideoWorkspaceReadNotice} from "@/app/workspace/VideoWorkspaceReadNotice";
import {AudioWorkspacePage} from "@/features/audio/ui/AudioWorkspacePage";
import {MusicWorkspacePage} from "@/features/music/ui/MusicWorkspacePage";
import {Route as StudioRoute} from "@/app/routes/_studio";
import {Route as StudioIndexRoute} from "@/app/routes/_studio.index.tsx";
import {StudioShell} from "@/app/layout/StudioShell";
import {ProjectGalleryPage} from "@/features/projects/ui/ProjectGalleryPage";
import {CoverCard} from "@/features/library/ui/CoverCard";
import {ProjectIpPicker} from "@/features/projects/ui/ProjectIpPicker";
import {MaterialLibraryPage} from "@/features/library/ui/MaterialLibraryPage";

// Execute the real page/row components with a deterministic hook host. Only the
// storage boundary is substituted; native assertions execute captured queriers.
import {ModuleLayout} from "@/app/layout/ModuleLayout";
type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    const node = value as Node;
    const children = node.type === PageHeader || node.type === PageState
        ? (node.type as (props: Record<string, unknown>) => unknown)(node.props) : node.props.children;
    // A side panel keeps its confirm/cancel in `footer`, outside its children.
    return [node, ...nodes(children), ...(node.type === ModuleLayout ? nodes(node.props.navigation) : []), ...nodes(node.props.footer)];
}
function render(run: () => unknown, results: unknown[] = []) {host.cursor = 0; host.queryIndex = 0; host.queries = []; host.results = results; return nodes(run());}
function scoped(node: unknown) {const element = node as Node; return (element.type as (props: unknown) => unknown)(element.props);}
function fixture(storage: "indexeddb" | "sqlite") {
    const project = emptyProject("同一套产品", "series"); const episode = emptyEpisode(project.id, 0, "第一集");
    episode.story.script = "正文";
    episode.story.beats = [{id: "beat", title: "开场", content: "正文", characterIds: [], timeOfDay: "日"}];
    const shot = emptyShot(project.id, episode.id, 0, "1", 3, "beat");
    const capabilities = ["world", "generation", "relations", "mediaSlots", "sync"].map(id => ({id, status: id === "sync" ? "unavailable" : "available"}));
    const repository = {
        storage, capabilities: () => capabilities, capability: (id: string) => capabilities.find(item => item.id === id),
        project: vi.fn(async () => project), episode: vi.fn(async () => episode), episodes: vi.fn(async () => [episode]), shots: vi.fn(async () => [shot]),
        characters: vi.fn(async () => []), scenes: vi.fn(async () => []), props: vi.fn(async () => []), styles: vi.fn(async () => []),
        patchShot: vi.fn(async () => undefined), patchStoryBeat: vi.fn(async () => undefined),
    };
    host.storage = storage; host.repository = repository; return {project, episode, shot, repository};
}
function shellResults(project: Project, episode: Episode) {return [{projectId: project.id, project}, {projectId: project.id, episodeId: episode.id, episode}, {projectId: project.id, episode}];}
function shotResults(project: Project, episode: Episode, shot: Shot) {return [{projectId: project.id, project}, {projectId: project.id, episodeId: episode.id, episode}, {projectId: project.id, episodeId: episode.id, shots: [shot]}, {projectId: project.id, characters: [], scenes: []}, {projectId: project.id, props: [], styles: []}];}
beforeEach(() => {host.cells = []; host.storage = "indexeddb"; host.liveQueries = []; host.readError = undefined; host.registerUndo.mockClear(); vi.stubGlobal("window", {addEventListener: vi.fn(), removeEventListener: vi.fn()});});

describe("shared video product page consumers", () => {
    it.each([
        {runtime: "tauri", storage: "sqlite", pathname: "/assets", available: true},
        {runtime: "tauri", storage: "sqlite", pathname: "/characters", available: true},
        {runtime: "browser", storage: "indexeddb", pathname: "/assets", available: true},
        {runtime: "tauri", storage: "indexeddb", pathname: "/characters", available: true},
        {runtime: "tauri", storage: "indexeddb", pathname: "/agent", available: true},
        {runtime: "tauri", storage: "indexeddb", pathname: "/connectors", available: true},
    ])("$runtime Studio route $pathname preserves its actual data owner boundary", ({runtime, storage, pathname, available}) => {
        host.pathname = pathname; host.storage = storage;
        vi.stubGlobal("window", {
            addEventListener: vi.fn(), removeEventListener: vi.fn(),
            ...(runtime === "tauri" ? {__TAURI_INTERNALS__: {invoke: vi.fn()}} : {}),
        });
        const tree = render(() => (StudioRoute.options.component as () => unknown)());
        expect(tree.some(node => node.type === StudioShell)).toBe(true);
        expect(tree.some(node => node.type === Outlet)).toBe(available);
        expect(tree.some(node => node.type === WorkspaceCapabilityState)).toBe(!available);
        expect(tree.find(node => node.type === StudioShell)?.props.onImport).toBeTypeOf("function");
    });
    it.each(["indexeddb", "sqlite"] as const)("%s uses the same AppFrame, workspace header and nested Outlet", storage => {
        const {project, episode} = fixture(storage); host.pathname = `/p/${project.id}/e/${episode.id}/shots`;
        const tree = render(() => WorkspaceChrome({projectId: project.id}), shellResults(project, episode));
        expect(tree.some(node => node.type === AppFrame)).toBe(true);
        expect(tree.some(node => node.type === AppHeaderPortal)).toBe(true);
        expect(tree.some(node => node.type === "div" && String(node.props.className).includes("workspace-header"))).toBe(true);
        expect(tree.some(node => node.type === Outlet)).toBe(true);
        expect(tree.some(node => node.type === WorkspaceCapabilityState)).toBe(false);
    });
    it.each(["indexeddb", "sqlite"] as const)("%s studio entry selects the existing product home", storage => {
        host.storage = storage;
        let redirect: unknown;
        try {(StudioIndexRoute.options.beforeLoad as () => void)();} catch (cause) {redirect = cause;}
        expect(redirect).toEqual({to: "/agent"});
    });
    it("desktop IndexedDB renders the complete shared material library and its existing query", async () => {
        host.storage = "indexeddb";
        const invoke = vi.fn();
        vi.stubGlobal("window", {__TAURI_INTERNALS__: {invoke}, addEventListener: vi.fn(), removeEventListener: vi.fn()});
        const tree = render(() => MaterialLibraryPage({search: {view: "settings"}}));
        expect(tree.find(node => node.type === PageHeader)?.props.description).toBe("管理媒体、资料和创作设定的版本。");
        expect(host.liveQueries).toHaveLength(1);
        await expect(host.liveQueries[0]()).resolves.toEqual({materials: [], ips: [], projects: []});
        expect(invoke).not.toHaveBeenCalled();
    });
    it("SQLite renders the same complete material library and query", async () => {
        host.storage = "sqlite";
        vi.stubGlobal("window", {__TAURI_INTERNALS__: {invoke: vi.fn()}, addEventListener: vi.fn(), removeEventListener: vi.fn()});
        const tree = render(() => MaterialLibraryPage({search: {}}));
        expect(tree.find(node => node.type === PageHeader)?.props.description).toBe("管理媒体、资料和创作设定的版本。");
        expect(host.liveQueries).toHaveLength(1);
        await expect(host.liveQueries[0]()).resolves.toEqual({materials: [], ips: [], projects: []});
    });
    it("desktop IndexedDB keeps gallery IP/backup and available audio/music creation controls", () => {
        const {project} = fixture("indexeddb");
        vi.stubGlobal("window", {__TAURI_INTERNALS__: {invoke: vi.fn()}, addEventListener: vi.fn(), removeEventListener: vi.fn()});
        const galleryResults = [[project], [], [], {key: JSON.stringify([project.id]), covers: new Map()}];
        let tree = render(ProjectGalleryPage, galleryResults);
        const actions = tree.find(node => node.type === CoverCard)?.props.actions as Array<{label: string}>;
        expect(actions.map(action => action.label)).toEqual(expect.arrayContaining(["所属 IP", "备份项目（zip）"]));
        expect(tree.some(node => node.type === ProjectIpPicker)).toBe(true);
        for (const label of ["音频", "音乐"]) {
            const typeButton = tree.find(node => node.type === "button" && Array.isArray(node.props.children) && node.props.children.some(child => child === label || typeof child === "object" && child && "props" in child && child.props.children === label));
            expect(typeButton).toBeDefined();
            (typeButton?.props.onClick as () => void)();
            tree = render(ProjectGalleryPage, galleryResults);
            expect(tree.some(node => node.props.children === "创建项目" && node.props.disabled === false)).toBe(true);
        }
    });
    it("gallery state labels select the actual exclusive active and archived card collections", () => {
        const {project} = fixture("indexeddb");
        const archived = {...project, id: "archived-project", name: "归档项目", archivedAt: "2026-10-15T00:00:00.000Z"};
        const results = [[project, archived], [], [], undefined];
        let tree = render(ProjectGalleryPage, results);
        const cards = () => tree.filter(node => node.type === CoverCard).map(node => node.key);
        const state = (label: string) => tree.find(node => node.type === "button" && node.props.children === label);
        expect(cards()).toEqual([project.id]); expect(state("使用中")?.props["aria-pressed"]).toBe(true);
        expect(state("已归档")?.props["aria-pressed"]).toBe(false);
        (state("已归档")?.props.onClick as () => void)(); tree = render(ProjectGalleryPage, results);
        expect(cards()).toEqual([archived.id]); expect(state("已归档")?.props["aria-pressed"]).toBe(true);
        expect(state("使用中")?.props["aria-pressed"]).toBe(false);
        (state("使用中")?.props.onClick as () => void)(); tree = render(ProjectGalleryPage, results);
        expect(cards()).toEqual([project.id]); expect(state("使用中")?.props["aria-pressed"]).toBe(true);
    });
    it.each(["world", "memory", "e/episode/produce", "e/episode/storyboard", "assets/characters/character"])("desktop IndexedDB mounts the existing %s route under shared workspace chrome", path => {
        const {project, episode} = fixture("indexeddb");
        host.pathname = `/p/${project.id}/${path.replace("episode", episode.id)}`;
        vi.stubGlobal("window", {__TAURI_INTERNALS__: {invoke: vi.fn()}, addEventListener: vi.fn(), removeEventListener: vi.fn()});
        const scopedEpisodeId = path.startsWith("e/") ? episode.id : undefined;
        const tree = render(() => WorkspaceChrome({projectId: project.id}), [{projectId: project.id, project}, {projectId: project.id, episodeId: scopedEpisodeId, episode: scopedEpisodeId ? episode : null}, {projectId: project.id, episode}]);
        expect(tree.some(node => node.type === AppFrame)).toBe(true);
        expect(tree.some(node => node.type === Outlet)).toBe(true);
        expect(tree.some(node => node.type === WorkspaceCapabilityState)).toBe(false);
        expect(tree.find(node => node.type === AppFrame)?.props.onImport).toBeTypeOf("function");
        expect(tree.find(node => node.props["aria-label"] === "备份项目")?.props.disabled).toBe(false);
    });
    it.each(["audio", "music"] as const)("desktop IndexedDB dispatches the existing %s workspace", kind => {
        const {project} = fixture("indexeddb"); project.kind = kind;
        vi.stubGlobal("window", {__TAURI_INTERNALS__: {invoke: vi.fn()}, addEventListener: vi.fn(), removeEventListener: vi.fn()});
        const tree = render(() => ProjectHomePage({projectId: project.id}), [{projectId: project.id, project}, {projectId: project.id, episode: null}]);
        expect(tree.some(node => node.type === (kind === "audio" ? AudioWorkspacePage : MusicWorkspacePage))).toBe(true);
        expect(tree.some(node => node.type === WorkspaceCapabilityState)).toBe(false);
    });
    it("SQLite world routes mount the shared workspace beneath the same shell", () => {
        const {project, episode} = fixture("sqlite"); host.pathname = `/p/${project.id}/world`;
        const tree = render(() => WorkspaceChrome({projectId: project.id}), [{projectId: project.id, project}, {projectId: project.id, episodeId: undefined, episode: null}, {projectId: project.id, episode}]);
        expect(tree.some(node => node.type === AppFrame)).toBe(true);
        expect(tree.some(node => node.type === WorkspaceCapabilityState)).toBe(false);
        expect(tree.some(node => node.type === Outlet)).toBe(true);
    });
    it.each(["audio", "music"] as const)("SQLite mounts the existing shared %s workspace", kind => {
        const {project} = fixture("sqlite");
        project.kind = kind;
        const tree = render(() => ProjectHomePage({projectId: project.id}), [{projectId: project.id, project}, {projectId: project.id, episode: null}]);
        expect(tree.some(node => node.type === WorkspaceCapabilityState)).toBe(false);
        expect(tree.some(node => node.type === (kind === "audio" ? AudioWorkspacePage : MusicWorkspacePage))).toBe(true);
    });
    it("native story and shot workbench query only the selected repository", async () => {
        const {project, episode, shot, repository} = fixture("sqlite");
        const projectRead = vi.spyOn(db.projects, "get"); const episodeRead = vi.spyOn(db.episodes, "get"); const shotsRead = vi.spyOn(db.shots, "where");
        const story = render(() => scoped(StoryPage({projectId: project.id, episodeId: episode.id})), [project, episode, [], []]);
        expect(story.some(node => typeof node.type === "function" && node.type.name === "StoryEditor")).toBe(true);
        await Promise.all(host.queries.map(query => query()));
        host.cells = [];
        const shots = render(() => scoped(ShotEditorPage({projectId: project.id, episodeId: episode.id})), shotResults(project, episode, shot));
        expect(shots.some(node => node.type === "h1" && node.props.children === "分镜")).toBe(true);
        await Promise.all(host.queries.map(query => query()));
        expect(repository.project).toHaveBeenCalledWith(project.id);
        expect(repository.episode).toHaveBeenCalledWith(episode.id);
        expect(repository.shots).toHaveBeenCalledWith(episode.id);
        expect(projectRead).not.toHaveBeenCalled(); expect(episodeRead).not.toHaveBeenCalled(); expect(shotsRead).not.toHaveBeenCalled();
    });
    it("native text field saves retain the original scalar baselines", async () => {
        const {project, episode, shot, repository} = fixture("sqlite");
        const beatField = BeatTextField({projectId: project.id, episodeId: episode.id, beat: episode.story.beats[0], field: "title"}) as ReactElement<Parameters<typeof TextDraftField>[0]>;
        const shotField = ShotTextField({shot, field: "content"}) as ReactElement<Parameters<typeof TextDraftField>[0]>;
        await beatField.props.persist("修改后", "开场"); await shotField.props.persist("新镜头", "旧镜头");
        expect(repository.patchStoryBeat).toHaveBeenCalledWith(episode.id, "beat", {title: "修改后"}, {title: "开场"});
        expect(repository.patchShot).toHaveBeenCalledWith(shot.id, {content: "新镜头"}, {content: "旧镜头"});
    });
    it("SQLite media columns retain the shared row and all existing generation controls", () => {
        const {project, episode, shot} = fixture("sqlite");
        const tree = render(() => ShotRow({shot, projectId: project.id, episodeId: episode.id, striped: false, initiallyVisible: true, selecting: false, selected: false, onSelectedChange: vi.fn(), onActivate: vi.fn(), workspaceView: "media", visibleDefs: [], characters: [], scenes: [], canMoveUp: false, canMoveDown: false, onMove: vi.fn(), onDuplicate: vi.fn(), onEditRelations: vi.fn(), onSlotOpenChange: vi.fn(), unavailable: false}));
        expect(tree.some(node => node.props["data-shot-mounted"] === "true")).toBe(true);
        expect(tree.filter(node => typeof node.type === "function" && node.type.name === "MediaSlotCapability")).toHaveLength(0);
        expect(tree.filter(node => node.type === EditableGenerationSlot)).toHaveLength(3);
        expect(tree.some(node => node.type === ShotTextField && node.props.field === "content")).toBe(true);
    });
    it("initial native read failure exposes recovery and later errors retain the shared workbench", () => {
        const {project, episode, shot} = fixture("sqlite"); host.readError = "SQLite 工作区不可用";
        const failed = render(() => scoped(ShotEditorPage({projectId: project.id, episodeId: episode.id})));
        expect(failed.find(node => node.type === PageState)?.props.kind).toBe("error");
        host.cells = [];
        const retained = render(() => scoped(ShotEditorPage({projectId: project.id, episodeId: episode.id})), shotResults(project, episode, shot));
        expect(retained.some(node => node.type === VideoWorkspaceReadNotice && node.props.error === host.readError)).toBe(true);
        expect(retained.some(node => node.type === "h1" && node.props.children === "分镜")).toBe(true);
    });
    it("native scene-copy undo uses the committed inverse and does not delete from a page snapshot", async () => {
        const {project, episode, shot, repository} = fixture("sqlite");
        const restore = vi.fn(async () => undefined);
        const deletes = {deleteShots: vi.fn(), deleteStoryBeat: vi.fn()};
        Object.assign(repository, deletes, {duplicateBeat: vi.fn(async () => ({beat: {...episode.story.beats[0], id: "copy"}, shots: [{...shot, id: "copy-shot"}], undo: {restore}}))});
        const story = render(() => scoped(StoryPage({projectId: project.id, episodeId: episode.id})), [project, episode, [], []]);
        const editor = story.find(node => typeof node.type === "function" && node.type.name === "StoryEditor");
        host.cells = [];
        const controls = render(() => scoped(editor));
        const copy = controls.find(node => node.props["aria-label"] === "复制场次及其镜头");
        (copy?.props.onClick as () => void)();
        await vi.waitFor(() => expect(host.registerUndo).toHaveBeenCalledOnce());
        await host.registerUndo.mock.calls[0][0].restore();
        expect(restore).toHaveBeenCalledOnce();
        expect(deletes.deleteShots).not.toHaveBeenCalled();
        expect(deletes.deleteStoryBeat).not.toHaveBeenCalled();
    });
    it("native shot-copy undo uses the committed inverse", async () => {
        const {project, episode, shot, repository} = fixture("sqlite");
        const restore = vi.fn(async () => undefined);
        const deleteShots = vi.fn();
        Object.assign(repository, {deleteShots, duplicateShot: vi.fn(async () => ({...shot, id: "copy-shot", undo: {restore}}))});
        const tree = render(() => scoped(ShotEditorPage({projectId: project.id, episodeId: episode.id})), shotResults(project, episode, shot));
        const group = tree.find(node => typeof node.props.onDuplicateShot === "function");
        (group?.props.onDuplicateShot as (id: string) => void)(shot.id);
        await vi.waitFor(() => expect(host.registerUndo).toHaveBeenCalledOnce());
        await host.registerUndo.mock.calls[0][0].restore();
        expect(restore).toHaveBeenCalledOnce();
        expect(deleteShots).not.toHaveBeenCalled();
    });
});
