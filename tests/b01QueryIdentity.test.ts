import {beforeEach, describe, expect, it, vi} from "vitest";
import type {ReactElement} from "react";

// Actual consumer/hook fixture, not ReactDOM. Retained results are supplied on
// purpose; the captured real queriers are also executed against fake IndexedDB.
const host = vi.hoisted(() => ({
    cells: [] as unknown[], cursor: 0, effects: [] as Array<() => void>,
    results: [] as unknown[], queryIndex: 0, queriers: [] as Array<() => Promise<unknown>>,
    params: {projectId: ""}, pathname: "", repairs: [] as string[],
}));
vi.mock("react", async original => {
    const react = await original<typeof import("react")>();
    return {...react,
        useState: (initial: unknown) => {
            const index = host.cursor++;
            if (!(index in host.cells)) host.cells[index] = typeof initial === "function" ? initial() : initial;
            return [host.cells[index], (next: unknown) => {host.cells[index] = typeof next === "function" ? next(host.cells[index]) : next;}];
        },
        useRef: (initial: unknown) => {
            const index = host.cursor++;
            if (!(index in host.cells)) host.cells[index] = {current: initial};
            return host.cells[index];
        },
        useEffect: (effect: () => void, deps?: unknown[]) => {
            const index = host.cursor++;
            const previous = host.cells[index] as unknown[] | undefined;
            if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous[i]))) {
                host.cells[index] = deps; host.effects.push(effect);
            }
        },
        useContext: () => false,
        useId: () => "b01-test",
        useMemo: (compute: () => unknown) => compute(),
        useCallback: (callback: unknown) => callback,
    };
});
vi.mock("@/platform/product/queries", () => {
    const read = (querier: (tx: typeof db) => Promise<unknown>) => {
        host.queriers.push(() => querier(db));
        return host.results[host.queryIndex++];
    };
    return {useProductQuery: read, useProductQueryState: (querier: (tx: typeof db) => Promise<unknown>) => ({value: read(querier), error: null})};
});
vi.mock("@tanstack/react-router", () => ({
    Link: () => null, Navigate: () => null, Outlet: () => null,
    useNavigate: () => vi.fn(), useBlocker: () => ({status: "idle"}),
    useRouterState: ({select}: {select: (state: unknown) => unknown}) => select({location: {pathname: host.pathname}}),
    createFileRoute: () => (options: unknown) => ({options, useParams: () => host.params}),
}));
vi.mock("@dnd-kit/core", () => ({DndContext: () => null, PointerSensor: {}, KeyboardSensor: {}, closestCenter: {}, useSensor: vi.fn(), useSensors: () => []}));
vi.mock("@dnd-kit/sortable", () => ({SortableContext: () => null, sortableKeyboardCoordinates: {}, verticalListSortingStrategy: {}, useSortable: () => ({setNodeRef: vi.fn()})}));
vi.mock("@/app/drafts/undo", () => ({useUndo: () => ({registerUndo: vi.fn()})}));
vi.mock("@/features/video/queries/useShotMedia", () => ({useShotMedia: () => new Map()}));
vi.mock("@/features/video/ui/ShotRowViewport", () => ({ShotScrollViewport: () => null, useShotRowViewport: () => ({rowRef: vi.fn(), nearViewport: true})}));
vi.mock("sonner", () => ({toast: {error: vi.fn(), success: vi.fn()}}));

import {db} from "@/platform/product/store";
import * as repoAssets from "@/features/library/commands/assets";
import * as repoProjects from "@/features/projects/commands/projects";
import * as repoEpisodes from "@/features/video/commands/episodes";
import {CharacterDetailPage} from "@/features/library/ui/CharacterDetailPage";
import {SceneDetailPage} from "@/features/library/ui/SceneDetailPage";
import {PropDetailPage} from "@/features/library/ui/PropDetailPage";
import {StyleDetailPage} from "@/features/library/ui/StyleDetailPage";
import {AssetDetailContent, assetTargetKey} from "@/features/library/ui/AssetDetailContent";
import {CharacterDetailFields, SceneDetailFields, PropDetailFields, StyleDetailFields} from "@/features/library/ui/assetDetailFields";
import {EditableGenerationSlot} from "@/features/library/ui/GenerationSlotCard";
import {ShotEditorPage} from "@/features/video/ui/ShotEditorPage";
import {StoryboardPrintPage} from "@/features/video/ui/StoryboardPrintPage";
import {WorkspaceChrome} from "@/app/workspace/WorkspaceChrome";
import {ProjectSettingsPanel} from "@/features/projects/ui/ProjectSettingsPanel";
import {MaterialDetailPanel} from "@/features/library/ui/materials/MaterialDetailPanel";
import {PageHeader, PageState} from "@/app/layout/PageLayout";
import {Route as HomeRoute} from "@/app/routes/p.$projectId.index.tsx";
import {Route as ProjectRoute} from "@/app/routes/p.$projectId.tsx";

import {ModuleLayout} from "@/app/layout/ModuleLayout";
type Node = ReactElement<Record<string, unknown>>;
function nodes(tree: unknown): Node[] {
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
    const node = tree as Node;
    if ([AssetDetailContent, CharacterDetailFields, SceneDetailFields, PropDetailFields, StyleDetailFields].includes(node.type as never))
        return [node, ...nodes((node.type as (props: Record<string, unknown>) => unknown)(node.props))];
    // These actual pure presentation boundaries receive visible content through
    // named props. Keep hookful frame/feature/slot owners opaque so inspecting a
    // title cannot consume extra mocked queries or alter the owner's hook cells.
    if (node.type === PageHeader || node.type === PageState) {
        return [node, ...nodes((node.type as (props: Record<string, unknown>) => unknown)(node.props))];
    }
    return [node, ...nodes(node.props.children), ...(node.type === ModuleLayout ? nodes(node.props.navigation) : [])];
}
function unwrap(tree: unknown): unknown {
    const node = tree as Node;
    if (node && typeof node.type === "function" && /DetailContent|AssetDetailRoute|PageContent|^ProjectHomePage$/.test(node.type.name)) {
        return unwrap((node.type as (props: Record<string, unknown>) => unknown)(node.props));
    }
    return tree;
}
function draw(run: () => unknown, results: unknown[]) {
    host.cursor = 0; host.queryIndex = 0; host.queriers = []; host.results = results;
    const tree = nodes(unwrap(run()));
    host.effects.splice(0).forEach(effect => effect());
    return tree;
}
function reset() {host.cells = []; host.effects = []; host.cursor = 0;}
function texts(tree: Node[]) {return tree.flatMap(node => typeof node.props.children === "string" ? [node.props.children] : []);}
function expectLoading(tree: Node[]) {
    const states = tree.filter(node => node.type === PageState);
    expect(states).toHaveLength(1);
    expect(states[0].props.kind).toBe("loading");
    expect(tree.some(node => node.type === "div" && node.props.role === "status")).toBe(true);
    expect(texts(tree)).toContain(states[0].props.title);
}
function name(node: Node) {return typeof node.type === "function" ? node.type.name : node.type;}
beforeEach(reset);
vi.stubGlobal("window", {addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn()});

const assetCases = [
    {kind: "character", add: repoAssets.addCharacter, page: (id: string, owner: string) => CharacterDetailPage({characterId: id, back: {kind: "project", projectId: owner}})},
    {kind: "scene", add: repoAssets.addScene, page: (id: string, owner: string) => SceneDetailPage({sceneId: id, back: {kind: "project", projectId: owner}})},
    {kind: "prop", add: repoAssets.addProp, page: (id: string, owner: string) => PropDetailPage({propId: id, back: {kind: "project", projectId: owner}})},
    {kind: "style", add: repoAssets.addStyle, page: (id: string, owner: string) => StyleDetailPage({styleId: id, back: {kind: "project", projectId: owner}})},
];

describe("B01 actual query consumers", () => {
    it.each(assetCases)("$kind rejects retained entity/null and wrong-owner rows; missing querier keeps identity", async c => {
        const a = await repoProjects.createProject("A"); const b = await repoProjects.createProject("B");
        const first = await c.add(a.id); const second = await c.add(a.id);
        const run = () => c.page(second.id, a.id);
        const envelope = (ownerId: string, id: string, value: unknown) => ({
            key: assetTargetKey((c.page(id, ownerId) as ReactElement<{target: Parameters<typeof assetTargetKey>[0]}>).props.target),
            value: value === null ? null : {kind: c.kind, asset: value},
        });
        for (const value of [first, null]) {
            reset();
            const tree = draw(run, [envelope(a.id, first.id, value)]);
            expectLoading(tree);
            expect(tree.some(node => node.type === EditableGenerationSlot)).toBe(false);
        }
        reset();
        expect(texts(draw(run, [envelope(a.id, second.id, null)])).join("")).toContain("找不到");
        reset();
        expect(texts(draw(() => c.page(second.id, b.id), [envelope(b.id, second.id, second)])).join("")).toContain("找不到");
        reset(); draw(() => c.page("missing", a.id), []);
        expect(await host.queriers[0]()).toEqual(envelope(a.id, "missing", null));
        const key = (c.page(second.id, a.id) as Node).key;
        expect((c.page(second.id, b.id) as Node).key).not.toBe(key);
        expect((c.page(first.id, a.id) as Node).key).not.toBe(key);
        expect((c.page(second.id, a.id) as Node).key).toBe(key);
    });

    it.each([ShotEditorPage, StoryboardPrintPage])("$name gates retained episodes and empty lists before editing/printing", async page => {
        const project = await repoProjects.createProject("series", "series");
        const a = (await repoEpisodes.firstEpisode(project.id))!; const b = await repoEpisodes.addEpisode(project.id);
        const valid = [
            {projectId: project.id, project}, {projectId: project.id, episodeId: b.id, episode: b},
            {projectId: project.id, episodeId: b.id, shots: []}, {projectId: project.id, characters: [], scenes: []},
            {projectId: project.id, props: [], styles: []},
        ];
        const run = () => page({projectId: project.id, episodeId: b.id});
        for (const stale of [
            {index: 1, result: {projectId: project.id, episodeId: a.id, episode: null}},
            {index: 1, result: {projectId: project.id, episodeId: a.id, episode: a}},
            {index: 2, result: {projectId: project.id, episodeId: a.id, shots: []}},
            {index: 3, result: {projectId: "other", characters: [], scenes: []}},
            {index: 4, result: {projectId: "other", props: [], styles: []}},
        ]) {
            reset(); const results = [...valid]; results[stale.index] = stale.result as typeof results[number];
            expectLoading(draw(run, results));
        }
        reset(); const loaded = draw(run, valid);
        expect(loaded.some(node => node.type === PageState && node.props.kind === "loading")).toBe(false);
        expect(loaded.some(node => node.type === "h1" && node.props.children === (page === ShotEditorPage ? "分镜" : project.name))).toBe(true);
        const missing = [...valid]; missing[1] = {...valid[1], episode: null} as typeof valid[number];
        reset(); expect(texts(draw(run, missing)).join("")).toContain("找不到");
        const foreign = [...valid]; foreign[1] = {...valid[1], episode: {...b, projectId: "foreign"}} as typeof valid[number];
        reset(); expect(texts(draw(run, foreign)).join("")).toContain("找不到");
        reset(); draw(() => page({projectId: project.id, episodeId: "missing"}), []);
        expect(await host.queriers[1]()).toEqual({projectId: project.id, episodeId: "missing", episode: null});
        expect(await host.queriers[2]()).toEqual({projectId: project.id, episodeId: "missing", shots: []});
        expect((page({projectId: project.id, episodeId: b.id}) as Node).key).not.toBe((page({projectId: project.id, episodeId: a.id}) as Node).key);
    });

    it("Chrome hides old episode/null navigation while keeping settings and Outlet", async () => {
        const project = await repoProjects.createProject("series", "series");
        const a = (await repoEpisodes.firstEpisode(project.id))!; const b = await repoEpisodes.addEpisode(project.id);
        const first = {projectId: project.id, episode: a};
        const result = (episodeId: string, episode: unknown) => ({projectId: project.id, episodeId, episode});
        host.pathname = `/p/${project.id}/e/${a.id}/shots`;
        const run = () => WorkspaceChrome({projectId: project.id});
        let tree = draw(run, [{projectId: project.id, project}, result(a.id, a), first]);
        (tree.find(node => node.props["aria-label"] === "项目设定")!.props.onClick as () => void)();
        tree = draw(run, [{projectId: project.id, project}, result(a.id, a), first]);
        (tree.find(node => node.type === ProjectSettingsPanel)!.props.onOutputState as (state: unknown) => void)({dirty: true, saving: false});
        host.pathname = `/p/${project.id}/e/${b.id}/shots`;
        for (const stale of [a, null]) {
            tree = draw(run, [{projectId: project.id, project}, result(a.id, stale), first]);
            expect(tree.filter(node => name(node) === "Outlet")).toHaveLength(1);
            expect(tree.some(node => name(node) === "SidePanel" && node.props.open === true)).toBe(true);
            expect(tree.some(node => (node.props.params as {episodeId?: string})?.episodeId === a.id)).toBe(false);
        }
        reset(); host.pathname = "/p/missing";
        expect(texts(draw(() => WorkspaceChrome({projectId: "missing"}), [{projectId: project.id, project: null}, {projectId: project.id, episodeId: undefined, episode: null}, first])).join("")).toContain("加载项目");
        reset(); expect(texts(draw(() => WorkspaceChrome({projectId: "missing"}), [{projectId: "missing", project: null}])).join("")).toContain("找不到这个项目");
    });

    it("home never repairs/navigates from retained null or foreign project identity", async () => {
        const a = await repoProjects.createProject("A"); const b = await repoProjects.createProject("B");
        host.params = {projectId: b.id};
        const repair = vi.spyOn(repoEpisodes, "ensureFirstEpisode");
        const run = () => (HomeRoute.options.component as () => unknown)();
        const tree = draw(run, [{projectId: a.id, project: a}, {projectId: a.id, episode: null}]);
        expect(texts(tree)).toContain("加载项目…"); expect(repair).not.toHaveBeenCalled();
        reset(); expect(texts(draw(run, [{projectId: b.id, project: b}, {projectId: a.id, episode: null}]))).toContain("加载项目…");
        expect(repair).not.toHaveBeenCalled();
        reset(); draw(run, []);
        expect(await host.queriers[0]()).toMatchObject({projectId: b.id});
        expect(await host.queriers[1]()).toMatchObject({projectId: b.id});
        repair.mockRestore();
        host.params = {projectId: a.id}; const rootA = (ProjectRoute.options.component as () => Node)();
        host.params = {projectId: b.id}; const rootB = (ProjectRoute.options.component as () => Node)();
        expect(rootA.key).toBe(a.id); expect(rootB.key).toBe(b.id);
    });

    it("material panel distinguishes retained null from matched missing and keys by matched material", async () => {
        const run = () => MaterialDetailPanel({id: "B", onClose: vi.fn(), onSelect: vi.fn()});
        let tree = draw(run, [{id: "A", material: null}]);
        expect(texts(tree)).toContain("正在读取素材…");
        reset(); tree = draw(run, [{id: "B", material: null}]);
        expect(texts(tree)).toContain("素材不存在或已删除");
        reset(); draw(run, []);
        expect(await host.queriers[0]()).toEqual({id: "B", material: null});
        reset(); tree = draw(run, [{id: "B", material: {id: "B"}}]);
        expect(tree.find(node => name(node) === "MaterialEditor")?.key).toBe("B");
    });
});
