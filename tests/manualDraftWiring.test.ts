import {describe, expect, it, vi} from "vitest";
import type {ReactElement} from "react";
import type {GenerationSlot} from "@/features/library/models/slots";
import type {Project} from "@/features/projects/models/project";
import {emptySlot} from "@/features/library/models/slot";
import {defaultImageGeneration} from "@/features/video/models/output";

// Small hook host: execute the actual components and event callbacks without a DOM.
// UI primitives remain JSX nodes; no source-string assertions or copied save callbacks.
const host = vi.hoisted(() => ({
    cells: [] as unknown[], cursor: 0, effects: [] as Array<() => void>, row: undefined as unknown,
    draftOptions: undefined as unknown, queries: undefined as unknown[] | undefined, queryIndex: 0,
    cleanups: new Map<number, () => void>(),
    blocker: {status: "idle" as "idle" | "blocked", proceed: vi.fn(), reset: vi.fn()},
}));
vi.mock("react", async importOriginal => {
    const react = await importOriginal<typeof import("react")>();
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
        useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
            const index = host.cursor++;
            const previous = host.cells[index] as unknown[] | undefined;
            if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous[i]))) {
                host.cells[index] = deps;
                host.effects.push(() => {
                    host.cleanups.get(index)?.();
                    const cleanup = effect();
                    if (typeof cleanup === "function") host.cleanups.set(index, cleanup);
                    else host.cleanups.delete(index);
                });
            }
        },
        useContext: () => false, // A04 host has no unavailable workspace provider.
        useId: () => "test-id",
        useMemo: (compute: () => unknown) => compute(),
        useCallback: (callback: unknown) => callback,
    };
});
vi.mock("@/platform/product/queries", () => {
    const read = () => host.queries ? host.queries[host.queryIndex++] : host.row;
    return {useProductQuery: read, useProductQueryState: () => ({value: read(), error: null})};
});
vi.mock("@dnd-kit/core", () => ({DndContext: () => null, PointerSensor: {}, KeyboardSensor: {}, closestCenter: {}, useSensor: vi.fn(), useSensors: () => []}));
vi.mock("@dnd-kit/sortable", () => ({SortableContext: () => null, sortableKeyboardCoordinates: {}, verticalListSortingStrategy: {}, useSortable: () => ({setNodeRef: vi.fn()})}));
vi.mock("@/app/drafts/undo", () => ({useUndo: () => ({registerUndo: vi.fn()})}));
vi.mock("@/features/video/queries/useShotMedia", () => ({useShotMedia: () => new Map()}));
vi.mock("@/features/video/ui/ShotRowViewport", () => ({ShotScrollViewport: () => null, useShotRowViewport: () => ({rowRef: vi.fn(), nearViewport: true})}));
vi.mock("@tanstack/react-router", () => ({Link: () => null, useNavigate: () => vi.fn(), useBlocker: () => host.blocker}));
vi.mock("@/platform/product/drafts", () => ({useDebouncedDraft: (options: {initialValue: unknown}) => {
    host.draftOptions = options;
    return {draft: options.initialValue, setDraft: vi.fn(), status: "saved", retry: vi.fn(), useLatest: vi.fn()};
}}));
vi.mock("@/features/library/services/media", () => ({IMAGE_ACCEPT: "image/*", VIDEO_ACCEPT: "video/*", MEDIA_ACCEPT: "*/*", pickMediaFile: vi.fn(), uploadMediaFile: vi.fn()}));
vi.mock("sonner", () => ({toast: {error: vi.fn(), success: vi.fn()}}));

import {db} from "@/platform/product/store";
import * as repoProjects from "@/features/projects/commands/projects";
import * as repoMedia from "@/features/library/commands/media";
import * as repoAssets from "@/features/library/commands/assets";
import * as repoEpisodes from "@/features/video/commands/episodes";
import * as repoShots from "@/features/video/commands/shots";
import {DraftConflictError} from "@/platform/product/draftConflict";
import {CharacterDetailPage} from "@/features/library/ui/CharacterDetailPage";
import {SceneDetailPage} from "@/features/library/ui/SceneDetailPage";
import {PropDetailPage} from "@/features/library/ui/PropDetailPage";
import {StyleDetailPage} from "@/features/library/ui/StyleDetailPage";
import {EditableGenerationSlot, GenerationSlotEditor} from "@/features/library/ui/GenerationSlotCard";
import {ProjectSettingsPanel} from "@/features/projects/ui/ProjectSettingsPanel";
import {ShotEditorPage} from "@/features/video/ui/ShotEditorPage";
import {DurationInput} from "@/features/video/ui/DurationInput";
import {AssetDetailContent, assetTargetKey} from "@/features/library/ui/AssetDetailContent";
import {CharacterDetailFields, SceneDetailFields, PropDetailFields, StyleDetailFields} from "@/features/library/ui/assetDetailFields";
import {AssetTextField} from "@/features/library/ui/AssetTextField";

vi.stubGlobal("window", {addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn()});
import {pickMediaFile, uploadMediaFile} from "@/features/library/services/media";

type Node = ReactElement<Record<string, unknown>>;
function nodes(tree: unknown): Node[] {
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
    const node = tree as Node;
    if ([AssetDetailContent, CharacterDetailFields, SceneDetailFields, PropDetailFields, StyleDetailFields].includes(node.type as never))
        return [node, ...nodes((node.type as (props: Record<string, unknown>) => unknown)(node.props))];
    // A side panel keeps its confirm/cancel in `footer`, outside its children.
    return [node, ...nodes(node.props.children), ...nodes(node.props.footer)];
}
// Identity wrappers must be traversed to keep exercising their actual consumers.
function unwrap(tree: unknown): unknown {
    const node = tree as Node;
    if (node && typeof node.type === "function" && /DetailContent|AssetDetailRoute|ShotEditorPageContent/.test(node.type.name)) {
        return (node.type as (props: Record<string, unknown>) => unknown)(node.props);
    }
    return tree;
}
function render(run: () => unknown) {
    host.cursor = 0;
    const tree = unwrap(run());
    const effects = host.effects.splice(0);
    effects.forEach(effect => effect());
    return nodes(tree);
}
function reset() {host.cells = []; host.cursor = 0; host.effects = []; host.row = undefined; host.queries = undefined; host.queryIndex = 0; host.cleanups.clear(); host.blocker.status = "idle"; host.blocker.proceed.mockClear(); host.blocker.reset.mockClear();}
function nodeName(node: Node) {return typeof node.type === "function" ? node.type.name : node.type;}
function button(tree: Node[], text: string) {
    const node = tree.find(n => n.props.children === text);
    expect(node, text).toBeDefined();
    return node!;
}
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => {resolve = r;});
    return {promise, resolve};
}
async function settle() {for (let i = 0; i < 8; i++) await Promise.resolve();}

describe("actual manual consumer wiring", () => {
    it("balances mounted slot notifications on close and actual unmount", () => {
        reset();
        const onEditorOpenChange = vi.fn();
        const props = {projectId: "owner", targetKey: "owner:asset:front", variant: "frame" as const,
            title: "asset", onSave: vi.fn(async () => {}), onEditorOpenChange};
        const draw = () => render(() => EditableGenerationSlot(props));
        let tree = draw();
        (tree.find(n => nodeName(n) === "GenerationSlotTile")!.props.onOpen as () => void)();
        tree = draw();
        expect(onEditorOpenChange.mock.calls).toEqual([[true]]);
        (tree.find(n => n.type === GenerationSlotEditor)!.props.onClose as () => void)();
        tree = draw();
        expect(onEditorOpenChange.mock.calls).toEqual([[true], [false]]);
        (tree.find(n => nodeName(n) === "GenerationSlotTile")!.props.onOpen as () => void)();
        draw();
        // Execute the actual mounted hook cleanup, as React does when a row is removed.
        for (const cleanup of host.cleanups.values()) cleanup();
        host.cleanups.clear();
        expect(onEditorOpenChange.mock.calls).toEqual([[true], [false], [true], [false]]);
    });

    it("failed navigation cleanup keeps owned media and disables the closed session until retry completes", async () => {
        reset();
        const project = await repoProjects.createProject("navigation cleanup");
        vi.mocked(pickMediaFile).mockResolvedValue({type: "image/png"} as File);
        vi.mocked(uploadMediaFile).mockImplementation(async owner => {
            await repoMedia.putMedia({id: "navigation-owned", projectId: owner, mimeType: "image/png", filename: "owned.png", blob: new Blob(["owned"])});
            return {id: "navigation-owned", kind: "image"};
        });
        const originalDelete = repoMedia.deleteMediaIfOrphan;
        let failCleanup = true;
        const cleanupGate = deferred();
        const cleanup = vi.spyOn(repoMedia, "deleteMediaIfOrphan").mockImplementation(async id => {
            if (failCleanup) throw new Error("cleanup unavailable");
            await cleanupGate.promise;
            return originalDelete(id);
        });
        try {
            const props = {open: true, targetKey: `${project.id}:asset:front`, projectId: project.id,
                title: "asset", value: emptySlot(), onClose: vi.fn(), onSave: vi.fn(async () => {})};
            const draw = () => render(() => GenerationSlotEditor(props));
            let tree = draw();
            (button(tree, "上传素材").props.onClick as () => void)();
            await settle(); await db.transaction("r", [db.media], tx => tx.media.toArray()); await settle();
            host.blocker.status = "blocked";
            tree = draw();
            (button(tree, "放弃并离开").props.onClick as () => void)();
            await settle();
            tree = draw();
            expect(host.blocker.proceed).not.toHaveBeenCalled();
            expect(await db.media.get("navigation-owned")).toBeDefined();
            expect(tree.find(n => n.props.children === "保存" || n.props.children === "重试保存")!.props.disabled).toBe(true);
            (button(tree, "继续编辑").props.onClick as () => void)();
            host.blocker.status = "idle";
            tree = draw();
            expect(button(tree, "重试保存").props.disabled).toBe(true);
            expect(tree.some(n => Array.isArray(n.props.children) && n.props.children.includes("请再次取消以重试清理。"))).toBe(true);
            failCleanup = false;
            host.blocker.status = "blocked";
            tree = draw();
            (button(tree, "放弃并离开").props.onClick as () => void)();
            await settle();
            tree = draw();
            expect(tree.some(n => n.props.children === "放弃并离开")).toBe(false);
            expect(host.blocker.proceed).not.toHaveBeenCalled();
            cleanupGate.resolve();
            await settle(); await db.transaction("r", [db.media], tx => tx.media.toArray()); await settle();
            expect(await db.media.get("navigation-owned")).toBeUndefined();
            expect(host.blocker.proceed).toHaveBeenCalledOnce();
            expect(props.onSave).not.toHaveBeenCalled();
            expect(props.onClose).not.toHaveBeenCalled();
        } finally {cleanup.mockRestore();}
    });

    it("passes frozen baselines from every asset page through the actual wrapper/editor to DB", async () => {
        const project = await repoProjects.createProject("manual assets");
        const cases = [
            {row: await repoAssets.addCharacter(project.id), page: (id: string) => CharacterDetailPage({characterId: id, back: {kind: "project", projectId: project.id}}), write: (id: string) => repoAssets.setCharacterSlot(id, "front", {...emptySlot(), prompt: "theirs"})},
            {row: await repoAssets.addScene(project.id), page: (id: string) => SceneDetailPage({sceneId: id, back: {kind: "project", projectId: project.id}}), write: (id: string) => repoAssets.setSceneSlot(id, "wide", {...emptySlot(), prompt: "theirs"})},
            {row: await repoAssets.addProp(project.id), page: (id: string) => PropDetailPage({propId: id, back: {kind: "project", projectId: project.id}}), write: (id: string) => repoAssets.setPropSlot(id, "hero", {...emptySlot(), prompt: "theirs"})},
            {row: await repoAssets.addStyle(project.id), page: (id: string) => StyleDetailPage({styleId: id, back: {kind: "project", projectId: project.id}}), write: (id: string) => repoAssets.setStyleSlot(id, "look", {...emptySlot(), prompt: "theirs"})},
        ];
        for (const c of cases) {
            reset();
            const target = (c.page(c.row.id) as ReactElement<{target: Parameters<typeof assetTargetKey>[0]}>).props.target;
            host.row = {key: assetTargetKey(target), value: {kind: target.kind, asset: c.row}};
            const slot = render(() => c.page(c.row.id)).find(n => n.type === EditableGenerationSlot)!;
            expect(slot.props.targetKey).toContain(c.row.id);
            reset();
            const wrapper = () => EditableGenerationSlot(slot.props as Parameters<typeof EditableGenerationSlot>[0]);
            let tree = render(wrapper);
            (tree.find(n => nodeName(n) === "GenerationSlotTile")!.props.onOpen as () => void)();
            tree = render(wrapper);
            const editor = tree.find(n => n.type === GenerationSlotEditor)!;
            reset();
            const edit = () => GenerationSlotEditor(editor.props as Parameters<typeof GenerationSlotEditor>[0]);
            tree = render(edit);
            (tree.find(n => n.props.value === "" && n.props.onChange)!.props.onChange as (e: unknown) => void)({target: {value: "mine"}});
            await c.write(c.row.id);
            tree = render(edit);
            (button(tree, "保存").props.onClick as () => void)();
            await settle();
            // Drain the real IndexedDB transaction before checking component failure state.
            await db.transaction("r", [db.projects], tx => tx.projects.toArray());
            await settle();
            tree = render(edit);
            expect(tree.some(n => n.props.value === "mine")).toBe(true);
            expect(tree.some(n => n.props.children === "重试保存")).toBe(true);
        }
    });

    it("wires all three actual shot-row slot callbacks with target identities and baselines", async () => {
        const project = await repoProjects.createProject("shot callbacks");
        const episode = (await repoEpisodes.firstEpisode(project.id))!;
        const shot = await repoShots.addShot(project.id, episode.id);
        reset();
        host.queries = [{projectId: project.id, project: {...project, shotSettings: {...project.shotSettings, workspaceView: "media"}}}, {projectId: project.id, episodeId: episode.id, episode}, {projectId: project.id, episodeId: episode.id, shots: [shot]}, {projectId: project.id, characters: [], scenes: []}, {projectId: project.id, props: [], styles: []}];
        host.cursor = 0;
        let tree = nodes(unwrap(ShotEditorPage({projectId: project.id, episodeId: episode.id})));
        // Expand only actual product beat/row components; skip DOM and UI primitives.
        for (const name of ["BeatBlock", "BeatBlockView", "ShotRow"]) {
            const child = tree.find(n => nodeName(n) === name)!;
            expect(child, name).toBeDefined();
            reset();
            tree = nodes((child.type as (props: Record<string, unknown>) => unknown)(child.props));
        }
        const slots = tree.filter(n => n.type === EditableGenerationSlot);
        expect(slots).toHaveLength(3);
        for (const [index, field] of (["firstFrame", "lastFrame", "clip"] as const).entries()) {
            expect(slots[index].props.targetKey).toBe(JSON.stringify([project.id, "shot", shot.id, field]));
            await repoShots.setShotSlot(shot.id, field, {...emptySlot(), prompt: "theirs"});
            const save = slots[index].props.onSave as (value: GenerationSlot, baseline: GenerationSlot) => Promise<void>;
            await expect(save({...emptySlot(), prompt: "mine"}, emptySlot())).rejects.toBeInstanceOf(DraftConflictError);
        }
    });

    it("passes all five project text baselines and immediate style baseline", async () => {
        reset();
        const project = await repoProjects.createProject("project fields");
        host.row = [];
        const tree = render(() => ProjectSettingsPanel({project, onOutputState: () => {}}));
        const fields = tree.filter(n => n.type === AssetTextField);
        expect(fields).toHaveLength(5);
        for (const field of fields) {
            const key = String(field.props.draftKey).split(":").at(-1)!;
            await repoProjects.patchProjectDetails(project.id, {[key]: "theirs"});
            const persist = field.props.persist as (value: string, baseline: string) => Promise<void>;
            await expect(persist("mine", key === "name" ? project.name : "")).rejects.toBeInstanceOf(DraftConflictError);
        }
        const a = await repoAssets.addStyle(project.id);
        const b = await repoAssets.addStyle(project.id);
        await repoProjects.patchProjectDetails(project.id, {defaultStyleId: a.id});
        const styleSelect = tree.find(n => n.props.label === "项目风格")!;
        (styleSelect.props.onChange as (value: string) => void)(b.id);
        await db.transaction("r", [db.projects], tx => tx.projects.toArray());
        expect((await db.projects.get(project.id))?.defaultStyleId).toBe(a.id);
    });

    it("DurationInput passes the hook baseline so stale saves fail", async () => {
        reset();
        const project = await repoProjects.createProject("duration wiring");
        const episode = (await repoEpisodes.firstEpisode(project.id))!;
        const shot = await repoShots.addShot(project.id, episode.id);
        render(() => DurationInput({projectId: project.id, shotId: shot.id, value: shot.durationSec}));
        const options = host.draftOptions as {persist: (value: number, baseline: number) => Promise<void>};
        await repoShots.patchShot(shot.id, {durationSec: 20});
        await expect(options.persist(9, shot.durationSec ?? 0)).rejects.toBeInstanceOf(DraftConflictError);
    });
});

describe("slot session target and owned media", () => {
    it("keeps A title/owner/draft and rejects a B save even with identical empty slots", async () => {
        reset();
        const a = vi.fn(async () => {});
        const b = vi.fn(async () => {});
        let props = {open: true, targetKey: "owner-A:asset-A:front", projectId: "owner-A", title: "A title", value: emptySlot(), onClose: vi.fn(), onSave: a};
        const draw = () => render(() => GenerationSlotEditor(props));
        let tree = draw();
        (tree.find(n => n.props.value === "" && n.props.onChange)!.props.onChange as (e: unknown) => void)({target: {value: "A draft"}});
        tree = draw();
        const staleSave = button(tree, "保存").props.onClick as () => void;
        props = {...props, targetKey: "owner-B:asset-B:front", projectId: "owner-B", title: "B title", onSave: b};
        tree = draw();
        expect(tree.some(n => n.props.title === "A title" && n.props.kind === "slot-editor")).toBe(true);
        expect(tree.some(n => n.props.title === "B title")).toBe(false);
        expect(tree.some(n => n.props.value === "A draft")).toBe(true);
        expect(button(tree, "保存").props.disabled).toBe(true);
        staleSave();
        await settle();
        expect(a).not.toHaveBeenCalled();
        expect(b).not.toHaveBeenCalled();
        expect(props.onClose).not.toHaveBeenCalled();
    });

    it("a deferred A save never closes B and persists through the original callback", async () => {
        reset();
        const pending = deferred();
        const a = vi.fn(() => pending.promise);
        const b = vi.fn(async () => {});
        const close = vi.fn();
        let props = {open: true, targetKey: "owner:A:front", projectId: "owner", title: "A", value: emptySlot(), onClose: close, onSave: a};
        const draw = () => render(() => GenerationSlotEditor(props));
        let tree = draw();
        (button(tree, "保存").props.onClick as () => void)();
        await settle();
        expect(a).toHaveBeenCalledWith(emptySlot(), emptySlot());
        props = {...props, targetKey: "owner:B:front", title: "B", onSave: b};
        draw();
        pending.resolve();
        await settle();
        expect(close).not.toHaveBeenCalled();
        expect(b).not.toHaveBeenCalled();
        tree = draw();
        expect(button(tree, "保存").props.disabled).toBe(true);
    });

    it("failed CAS retains actual uploaded media and draft until explicit close", async () => {
        reset();
        const project = await repoProjects.createProject("owned session");
        const asset = await repoAssets.addCharacter(project.id);
        vi.mocked(pickMediaFile).mockResolvedValue({type: "image/png"} as File);
        vi.mocked(uploadMediaFile).mockImplementation(async owner => {
            await repoMedia.putMedia({id: "owned", projectId: owner, mimeType: "image/png", filename: "owned.png", blob: new Blob(["owned"])});
            return {id: "owned", kind: "image"};
        });
        const props = {open: true, targetKey: `${project.id}:${asset.id}:front`, projectId: project.id, title: "asset", value: emptySlot(),
            onClose: vi.fn(), onSave: (value: GenerationSlot, baseline: GenerationSlot) => repoAssets.setCharacterSlot(asset.id, "front", value, baseline)};
        const draw = () => render(() => GenerationSlotEditor(props));
        let tree = draw();
        (button(tree, "上传素材").props.onClick as () => void)();
        await settle();
        await db.transaction("r", [db.media], tx => tx.media.toArray());
        await settle();
        tree = draw();
        await repoAssets.setCharacterSlot(asset.id, "front", {...emptySlot(), prompt: "theirs"});
        (button(tree, "保存").props.onClick as () => void)();
        await settle();
        await db.transaction("r", [db.characters], tx => tx.characters.toArray());
        await settle();
        expect(await db.media.get("owned")).toBeDefined();
        expect(props.onClose).not.toHaveBeenCalled();
        tree = draw();
        expect(tree.some(n => n.props.mediaId === "owned")).toBe(true);
        expect(button(tree, "重试保存")).toBeDefined();
        (button(tree, "取消").props.onClick as () => void)();
        await settle();
        await db.transaction("r", [db.media], tx => tx.media.toArray());
        await settle();
        expect(await db.media.get("owned")).toBeUndefined();
    });
});

function outputComponent(project: Project) {
    reset(); host.row = [];
    const tree = render(() => ProjectSettingsPanel({project, onOutputState: () => {}}));
    const component = tree.find(n => nodeName(n) === "ProjectOutputSettings")!;
    reset();
    return component.type as (props: {project: Project; onOutputState: (state: {dirty: boolean; saving: boolean}) => void}) => unknown;
}

describe("actual explicit output save", () => {
    it.each(["9:16", "16:9"] as const)("acknowledges a later same-field commit to %s during a pending save", async latestRatio => {
        let project = await repoProjects.createProject("output same-field acknowledgement");
        const component = outputComponent(project);
        const onOutputState = vi.fn();
        const draw = () => render(() => component({project, onOutputState}));
        let tree = draw();
        (tree.find(n => n.props.label === "项目目标画幅")!.props.onChange as (value: string) => void)("1:1");
        tree = draw();
        const pending = deferred();
        const original = repoProjects.patchProjectDetails;
        const save = vi.spyOn(repoProjects, "patchProjectDetails").mockImplementation(async (...args) => {await original(...args); await pending.promise;});
        try {
            (button(tree, "保存输出配置").props.onClick as () => void)();
            await settle(); await db.transaction("r", [db.projects], tx => tx.projects.toArray());
            expect((await db.projects.get(project.id))?.aspectPreset).toBe("1:1");
            await original(project.id, {aspectPreset: latestRatio});
            project = (await db.projects.get(project.id))!;
            tree = draw();
            expect(tree.some(n => n.props.label === "项目目标画幅" && n.props.value === "1:1")).toBe(true);
            pending.resolve(); await settle();
            await db.transaction("r", [db.projects], tx => tx.projects.toArray()); await settle();
            draw(); tree = draw();
            expect(tree.some(n => n.props.label === "项目目标画幅" && n.props.value === latestRatio)).toBe(true);
            expect(onOutputState.mock.lastCall?.[0]).toEqual({dirty: false, saving: false});
            project = {...project, generationDefaults: structuredClone(project.generationDefaults)};
            draw(); tree = draw();
            expect(tree.some(n => n.props.label === "项目目标画幅" && n.props.value === latestRatio)).toBe(true);
            expect((await db.projects.get(project.id))?.aspectPreset).toBe(latestRatio);
        } finally {save.mockRestore();}
    });

    it("follows pending live values when one field becomes clean while another stays dirty", async () => {
        let project = await repoProjects.createProject("output revert baseline");
        const originalRatio = project.aspectPreset;
        const component = outputComponent(project);
        const onOutputState = vi.fn();
        const draw = () => render(() => component({project, onOutputState}));
        let tree = draw();
        (tree.find(n => n.props.label === "项目目标画幅")!.props.onChange as (value: string) => void)("1:1");
        (tree.find(n => n.props.label === "图片模型")!.props.onChange as (value: string) => void)(defaultImageGeneration().model);
        tree = draw();
        await repoProjects.patchProjectDetails(project.id, {aspectPreset: "9:16"});
        project = (await db.projects.get(project.id))!;
        draw(); tree = draw();
        expect(tree.some(n => n.props.label === "项目目标画幅" && n.props.value === "1:1")).toBe(true);
        (tree.find(n => n.props.label === "项目目标画幅")!.props.onChange as (value: string) => void)(originalRatio);
        draw(); tree = draw();
        expect(tree.some(n => n.props.label === "项目目标画幅" && n.props.value === "9:16")).toBe(true);
        expect(onOutputState.mock.lastCall?.[0].dirty).toBe(true);
        expect(tree.some(n => n.props.label === "图片模型" && n.props.value === defaultImageGeneration().model)).toBe(true);
    });

    it("rebases clean fields, defers live changes during saving and ignores stale props after ack", async () => {
        let project = await repoProjects.createProject("output sequence");
        const component = outputComponent(project);
        const states: Array<{dirty: boolean; saving: boolean}> = [];
        const onOutputState = (state: {dirty: boolean; saving: boolean}) => states.push(state);
        const draw = () => render(() => component({project, onOutputState}));
        let tree = draw();
        const image = defaultImageGeneration();
        project = {...project, generationDefaults: {image}};
        draw(); tree = draw();
        expect(tree.some(n => n.props.label === "图片模型" && n.props.value === image.model)).toBe(true);
        expect(states.at(-1)?.dirty).toBe(false);
        (tree.find(n => n.props.label === "项目目标画幅")!.props.onChange as (value: string) => void)("1:1");
        tree = draw();
        const pending = deferred();
        const original = repoProjects.patchProjectDetails;
        const save = vi.spyOn(repoProjects, "patchProjectDetails").mockImplementation(async (...args) => {await original(...args); await pending.promise;});
        try {
            (button(tree, "保存输出配置").props.onClick as () => void)();
            await settle();
            await db.transaction("r", [db.projects], tx => tx.projects.toArray());
            // A new independent field arrives while the write is pending; no rebase yet.
            const newerImage = {...image, resolution: "2k"};
            project = {...project, generationDefaults: {image: newerImage}};
            tree = draw();
            expect(tree.some(n => n.props.label === "图片清晰度" && n.props.value === image.resolution)).toBe(true);
            expect(save.mock.calls[0][1]).toEqual({aspectPreset: "1:1"});
            pending.resolve(); await settle();
            await db.transaction("r", [db.projects], tx => tx.projects.toArray()); await settle();
            tree = draw(); tree = draw();
            expect(tree.some(n => n.props.label === "项目目标画幅" && n.props.value === "1:1")).toBe(true);
            expect(tree.some(n => n.props.label === "图片清晰度" && n.props.value === newerImage.resolution)).toBe(true);
            expect(states.at(-1)).toEqual({dirty: false, saving: false});
            // Same stale ratio props rerendered with new object identities cannot undo acknowledgement.
            project = {...project, generationDefaults: structuredClone(project.generationDefaults)};
            draw(); tree = draw();
            expect(tree.some(n => n.props.label === "项目目标画幅" && n.props.value === "1:1")).toBe(true);
            // Returning an edited field to its acknowledged baseline also ignores stale props.
            (tree.find(n => n.props.label === "项目目标画幅")!.props.onChange as (value: string) => void)("9:16");
            tree = draw();
            (tree.find(n => n.props.label === "项目目标画幅")!.props.onChange as (value: string) => void)("1:1");
            draw(); tree = draw();
            expect(tree.some(n => n.props.label === "项目目标画幅" && n.props.value === "1:1")).toBe(true);
            project = {...project, aspectPreset: "1:1"}; draw(); tree = draw();
            project = {...project, aspectPreset: "9:16"}; draw(); tree = draw();
            expect(tree.some(n => n.props.label === "项目目标画幅" && n.props.value === "9:16")).toBe(true);
        } finally {save.mockRestore();}
    });

    it("keeps a conflicted draft/baseline, adopts latest explicitly and uses the next baseline", async () => {
        let project = await repoProjects.createProject("output conflict");
        const component = outputComponent(project);
        const onOutputState = vi.fn();
        const draw = () => render(() => component({project, onOutputState}));
        let tree = draw();
        (tree.find(n => n.props.label === "项目目标画幅")!.props.onChange as (value: string) => void)("1:1");
        await repoProjects.patchProjectDetails(project.id, {aspectPreset: "9:16"});
        project = (await db.projects.get(project.id))!;
        draw(); tree = draw();
        (button(tree, "保存输出配置").props.onClick as () => void)();
        await settle(); await db.transaction("r", [db.projects], tx => tx.projects.toArray()); await settle();
        tree = draw();
        expect(tree.some(n => n.props.label === "项目目标画幅" && n.props.value === "1:1")).toBe(true);
        (button(tree, "采用最新内容").props.onClick as () => void)();
        tree = draw();
        expect(tree.some(n => n.props.label === "项目目标画幅" && n.props.value === "9:16")).toBe(true);
        (tree.find(n => n.props.label === "项目目标画幅")!.props.onChange as (value: string) => void)("1:1");
        tree = draw(); (button(tree, "保存输出配置").props.onClick as () => void)();
        await settle(); await db.transaction("r", [db.projects], tx => tx.projects.toArray()); await settle();
        expect((await db.projects.get(project.id))?.aspectPreset).toBe("1:1");
    });
});
