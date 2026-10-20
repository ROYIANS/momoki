import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {ReactElement} from "react";
import type {MemoryCandidate, MemoryInput, MemorySourceRef, ProjectMemory} from "@/features/memory/models/projectMemory";

// Actual components and callbacks, with a deterministic hook host rather than
// ReactDOM. Effects retain cleanup and old-render callbacks remain callable.
type EffectCell = {deps?: unknown[]; setup: () => (() => void) | void; cleanup?: () => void};
type Host = {
    cells: unknown[]; cursor: number; effects: Array<() => void>;
    results: unknown[]; queryIndex: number; queriers: Array<() => Promise<unknown>>;
    blocker?: {shouldBlockFn: () => boolean; enableBeforeUnload: boolean};
    mounted: boolean; lateWrites: number;
};
const runtime = vi.hoisted(() => ({active: undefined as Host | undefined}));
vi.mock("react", async original => {
    const react = await original<typeof import("react")>();
    const useMemo = (compute: () => unknown, deps: unknown[]) => {
        const host = runtime.active!; const index = host.cursor++;
        const previous = host.cells[index] as {deps: unknown[]; value: unknown} | undefined;
        if (!previous || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
            host.cells[index] = {deps, value: compute()};
        }
        return (host.cells[index] as {value: unknown}).value;
    };
    const useEffect = (effect: () => (() => void) | void, deps?: unknown[]) => {
        const host = runtime.active!; const index = host.cursor++;
        const previous = host.cells[index] as EffectCell | undefined;
        if (!previous || !deps || deps.length !== previous.deps?.length || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
            const cell: EffectCell = {deps, setup: effect}; host.cells[index] = cell;
            host.effects.push(() => {previous?.cleanup?.(); cell.cleanup = effect() || undefined;});
        }
    };
    return {...react,
        useCallback: (callback: unknown) => callback,
        useMemo,
        useEffect,
        useSyncExternalStore: (subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) => {
            const host = runtime.active!;
            const cell = useMemo(() => ({read: getSnapshot, value: getSnapshot()}), []) as {read: () => unknown; value: unknown};
            cell.read = getSnapshot; cell.value = getSnapshot();
            useEffect(() => subscribe(() => {
                if (!host.mounted) host.lateWrites++;
                cell.value = cell.read();
            }), [subscribe]);
            return cell.value;
        },
        useState: (initial: unknown) => {
            const host = runtime.active!; const index = host.cursor++;
            if (!(index in host.cells)) host.cells[index] = typeof initial === "function" ? initial() : initial;
            return [host.cells[index], (next: unknown) => {
                if (!host.mounted) host.lateWrites++;
                host.cells[index] = typeof next === "function" ? next(host.cells[index]) : next;
            }];
        },
        useRef: (initial: unknown) => {
            const host = runtime.active!; const index = host.cursor++;
            if (!(index in host.cells)) host.cells[index] = {current: initial};
            return host.cells[index];
        },
    };
});
vi.mock("@/platform/product/queries", () => {
    const read = (querier: (tx: typeof db) => Promise<unknown>) => {
        const host = runtime.active!; host.queriers.push(() => querier(db));
        return host.results[host.queryIndex++];
    };
    return {useProductQuery: read, useProductQueryState: (querier: (tx: typeof db) => Promise<unknown>) => ({value: read(querier), error: null})};
});
vi.mock("@tanstack/react-router", () => ({Link: () => null, useBlocker: (options: Host["blocker"]) => {
    runtime.active!.blocker = options; return {status: "idle", reset: vi.fn()};
}}));
vi.mock("@/features/agent/runtime/taskWrapup", () => ({recoverTaskWrapups: vi.fn(async () => {}), prepareTaskWrapup: vi.fn(), cancelTaskWrapup: vi.fn()}));
vi.mock("@/features/agent/ui/ReferenceAttachments", () => ({ReferenceSourceLink: () => null}));
vi.mock("sonner", () => ({toast: {error: vi.fn(), success: vi.fn()}}));

import {toast} from "sonner";
import {db} from "@/platform/product/store";
import {createProject} from "@/features/projects/commands/projects";
import {createAgentTask} from "@/features/agent/commands/agentTasks";
import {confirmWrapup, createManualWrapup, getTaskWrapupState, saveWrapup} from "@/features/agent/commands/agentTaskWrapups";
import * as memories from "@/features/memory/commands/projectMemories";
import {TaskWrapup} from "@/features/agent/ui/TaskWrapup";
import {MemoryPromotion} from "@/features/memory/ui/MemoryPromotion";
import {MemoryEditor} from "@/features/memory/ui/MemoryEditor";

type Node = ReactElement<Record<string, unknown>>;
type EditorProps = Parameters<typeof MemoryEditor>[0];
function createHost(): Host {
    return {cells: [], cursor: 0, effects: [], results: [], queryIndex: 0, queriers: [], mounted: true, lateWrites: 0};
}
const hosts: Host[] = [];
function mount() {const host = createHost(); hosts.push(host); return host;}
function unmount(host: Host) {
    host.mounted = false;
    for (const cell of host.cells) if (cell && typeof cell === "object" && "cleanup" in cell) (cell as EffectCell).cleanup?.();
}
// Model the cleanup/setup pass used by StrictMode on an initial mount. This
// exercises the actual effects but does not claim ReactDOM scheduling coverage.
function replayMountEffects(host: Host) {
    const effects = host.cells.filter((cell): cell is EffectCell =>
        !!cell && typeof cell === "object" && "setup" in cell);
    effects.forEach(cell => cell.cleanup?.());
    effects.forEach(cell => {cell.cleanup = cell.setup() || undefined;});
}
function nodes(tree: unknown): Node[] {
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
    const node = tree as Node;
    if (node.type === MemoryPromotion || (typeof node.type === "function" && node.type.name === "ReviewDocument")) {
        return [node, ...nodes((node.type as (props: Record<string, unknown>) => unknown)(node.props))];
    }
    // A side panel keeps its confirm/cancel in `footer`, outside its children.
    return [node, ...nodes(node.props.children), ...nodes(node.props.footer)];
}
function draw(host: Host, run: () => unknown, results = host.results) {
    runtime.active = host; host.cursor = 0; host.queryIndex = 0; host.queriers = []; host.results = results;
    const tree = nodes(run()); host.effects.splice(0).forEach(effect => effect());
    return tree;
}
function text(node: Node): string {
    const value = node.props.children;
    return (Array.isArray(value) ? value : [value]).filter(item => typeof item === "string").join("");
}
function promotionButtons(tree: Node[]) {return tree.filter(node => /存为项目记忆|读取来源/.test(text(node)));}
function click(node: Node) {(node.props.onClick as () => void)();}
function editor(tree: Node[]) {return tree.find(node => node.type === MemoryEditor)?.props as EditorProps | undefined;}
function field(tree: Node[], value: string) {
    const matches = tree.filter(node => node.props.value === value);
    return matches.find(node => node.props.rows === 6) ?? matches[0];
}
function sourceButton(tree: Node[], summaryId: string, kind: MemorySourceRef["itemKind"] = "lesson") {
    const intention = tree.find(node => node.type === MemoryPromotion &&
        (node.props.source as MemorySourceRef).summaryId === summaryId &&
        (node.props.source as MemorySourceRef).itemKind === kind)!;
    return MemoryPromotion(intention.props as Parameters<typeof MemoryPromotion>[0]) as Node;
}
function change(node: Node, value: string) {(node.props.onChange as (event: unknown) => void)({target: {value}});}
function submit(tree: Node[]) {(tree.find(node => node.type === "form")!.props.onSubmit as (event: unknown) => void)({preventDefault() {}});}
function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}
async function settle() {for (let i = 0; i < 5; i++) await Promise.resolve();}
async function fixture() {
    const project = await createProject("B02");
    const task = await createAgentTask({projectId: project.id, title: "来源任务", goal: "交付", acceptanceCriteria: []});
    async function review(prefix: string) {
        const draft = await createManualWrapup(task.id);
        const saved = await saveWrapup(task.id, draft.id, {...draft.content, overview: prefix,
            decisions: [{text: `${prefix}决策`, sourceIds: []}], lessons: [{text: `${prefix}经验`, sourceIds: []}],
        }, draft.revision);
        return confirmWrapup(task.id, saved.id, saved.revision);
    }
    const historical = await review("旧版"); const latest = await review("新版");
    const state = await getTaskWrapupState(task.id);
    const latestCandidates = await memories.listMemoryCandidates(project.id, task.id, latest.id, latest.revision);
    const oldCandidates = await memories.listMemoryCandidates(project.id, task.id, historical.id, historical.revision);
    const onEditingChange = vi.fn(); const onPendingChange = vi.fn();
    const props = {task, busy: false, onEditingChange, onPendingChange};
    const host = mount();
    const render = () => draw(host, () => TaskWrapup(props), [{taskId: task.id, data: state}]);
    return {project, task, state, props, host, render, latestCandidates, oldCandidates, historical};
}
function editorHost(incoming: EditorProps) {
    const props = {...incoming};
    const host = mount();
    const render = () => draw(host, () => MemoryEditor(props), [{data: null}, {data: []}]);
    return {host, props, render};
}
beforeEach(() => {hosts.length = 0;});
afterEach(() => {hosts.forEach(host => {if (host.mounted) unmount(host);}); vi.restoreAllMocks();});

describe("B02 actual promotion and editor sessions", () => {
    it("locks latest/history old-render callbacks before rerender and saves one coherent frozen DB source", async () => {
        const f = await fixture();
        let tree = f.render();
        click(tree.find(node => node.props["aria-label"] === "查看总结历史")!);
        tree = f.render();
        const buttons = promotionButtons(tree);
        expect(buttons.length).toBeGreaterThan(2);
        const request = deferred<MemoryCandidate[]>();
        const calls = vi.spyOn(memories, "listMemoryCandidates").mockReturnValue(request.promise);
        const clickedSource = tree.find(node => node.type === MemoryPromotion)!.props.source as MemorySourceRef;
        click(buttons[0]); click(sourceButton(tree, f.historical.id)); click(buttons[0]);
        clickedSource.itemText = "发起后修改原对象"; clickedSource.itemIndex = 99;
        expect(calls).toHaveBeenCalledTimes(1);
        expect(calls).toHaveBeenCalledWith(f.project.id, f.task.id, f.state.latest!.id, f.state.latest!.revision);
        tree = f.render(); expect(promotionButtons(tree).every(button => button.props.disabled)).toBe(true);
        expect(f.props.onPendingChange).toHaveBeenLastCalledWith(true);
        request.resolve(f.latestCandidates); await settle();
        const original = structuredClone(f.latestCandidates[0]);
        const frozen = editor(f.render())!;
        f.latestCandidates[0].input.body = "外部覆盖"; f.latestCandidates[0].ref.itemText = "外部伪造";
        f.latestCandidates[0].source.excerpt = "外部覆盖引用";
        const ui = editorHost(frozen);
        let form = ui.render();
        change(field(form, original.input.body), "我的正文");
        form = ui.render();
        expect(ui.host.blocker!.shouldBlockFn()).toBe(true);
        expect(ui.host.blocker!.enableBeforeUnload).toBe(true);
        // A newer confirmed summary/live refresh leaves the mounted promotion intact.
        f.state.latest = {...f.state.latest!, content: {...f.state.latest!.content, decisions: [{text: "刷新后决策", sourceIds: []}]}};
        const refreshed = editor(f.render())!;
        Object.assign(ui.props, refreshed); form = ui.render();
        expect(field(form, "我的正文")).toBeDefined();
        expect(form.some(node => text(node).includes(original.source.excerpt))).toBe(true);
        const promotion = vi.spyOn(memories, "promoteProjectMemory");
        submit(form);
        await vi.waitFor(async () => {expect(await db.projectMemories.count()).toBe(1);});
        await vi.waitFor(() => {expect(editor(f.render())).toBeUndefined();});
        const saved = (await db.projectMemories.toArray())[0];
        expect(promotion).toHaveBeenCalledTimes(1);
        expect(promotion.mock.calls[0].slice(0, 3)).toMatchObject([f.project.id, original.ref, {body: "我的正文"}]);
        expect(saved.projectId).toBe(f.project.id); expect(saved.body).toBe("我的正文");
        expect(saved.source).toMatchObject({...original.ref, kind: "summary", excerpt: original.source.excerpt});
        expect(f.props.onEditingChange).toHaveBeenLastCalledWith(false);
        expect(f.props.onPendingChange).toHaveBeenLastCalledWith(false);
        expect(calls).toHaveBeenCalledTimes(1);
    });

    it("shares failure unlock/retry with history, then ignores stale close/save/pending after reopen", async () => {
        const f = await fixture(); const failure = deferred<MemoryCandidate[]>(); const retry = deferred<MemoryCandidate[]>();
        const calls = vi.spyOn(memories, "listMemoryCandidates").mockReturnValueOnce(failure.promise).mockReturnValueOnce(retry.promise);
        const initialTree = f.render(); const oldButtons = promotionButtons(initialTree);
        const oldHistoryButton = sourceButton(initialTree, f.historical.id);
        click(oldButtons[0]); click(oldHistoryButton); expect(calls).toHaveBeenCalledTimes(1);
        failure.reject(new Error("读取失败")); await settle();
        expect(toast.error).toHaveBeenCalledWith("读取失败");
        expect(promotionButtons(f.render()).every(button => !button.props.disabled)).toBe(true);
        click(oldHistoryButton); expect(calls).toHaveBeenCalledTimes(2);
        expect(calls.mock.calls[1][2]).toBe(f.historical.id);
        retry.resolve(f.oldCandidates); await settle();
        const first = editor(f.render())!;
        click(oldButtons[0]); expect(calls).toHaveBeenCalledTimes(2);
        expect(editor(f.render())!.source).toEqual(first.source);
        first.onClose(); expect(editor(f.render())).toBeUndefined();
        calls.mockResolvedValueOnce(f.latestCandidates);
        click(promotionButtons(f.render())[0]); await settle();
        const second = editor(f.render())!;
        expect(second.source!.summaryId).not.toBe(first.source!.summaryId);
        second.onPendingChange!(true); f.render();
        first.onClose(); first.onPendingChange!(false);
        first.onSaved({id: "stale", projectId: f.project.id} as ProjectMemory);
        expect(editor(f.render())!.source).toEqual(second.source);
        expect(f.props.onPendingChange).toHaveBeenLastCalledWith(true);
        expect(calls).toHaveBeenCalledTimes(3);
        second.onPendingChange!(false); second.onClose(); f.render();
        expect(f.props.onPendingChange).toHaveBeenLastCalledWith(false);
    });

    it("gives an explicitly closed/reopened session a fresh mount identity even before rerender", async () => {
        const f = await fixture(); const oldTree = f.render();
        const latestButton = promotionButtons(oldTree)[0];
        const historyButton = sourceButton(oldTree, f.historical.id);
        const calls = vi.spyOn(memories, "listMemoryCandidates").mockResolvedValueOnce(f.latestCandidates)
            .mockResolvedValueOnce(f.oldCandidates);
        click(latestButton); await settle();
        const firstTree = f.render(); const first = editor(firstTree)!;
        const firstKey = firstTree.find(node => node.type === MemoryEditor)!.key;
        click(historyButton); expect(calls).toHaveBeenCalledTimes(1);
        expect(f.render().find(node => node.type === MemoryEditor)!.key).toBe(firstKey);
        first.onClose();
        // Reopen through a real old-render intention before a render can remove the editor.
        click(historyButton); await settle();
        const secondTree = f.render();
        expect(calls).toHaveBeenCalledTimes(2);
        expect(editor(secondTree)!.source!.summaryId).toBe(f.historical.id);
        expect(secondTree.find(node => node.type === MemoryEditor)!.key).not.toBe(firstKey);
        first.onClose();
        expect(editor(f.render())!.source).toEqual(editor(secondTree)!.source);
    });

    it.each(["resolve", "reject"] as const)("ignores old unmounted %s while a reopened inspector has another active editor", async outcome => {
        const f = await fixture(); const old = deferred<MemoryCandidate[]>(); const next = deferred<MemoryCandidate[]>();
        const calls = vi.spyOn(memories, "listMemoryCandidates").mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
        click(promotionButtons(f.render())[0]); unmount(f.host);
        const reopened = mount();
        const render = () => draw(reopened, () => TaskWrapup(f.props), [{taskId: f.task.id, data: f.state}]);
        click(sourceButton(render(), f.historical.id)); next.resolve(f.oldCandidates); await settle();
        const active = editor(render())!;
        if (outcome === "resolve") old.resolve(f.latestCandidates); else old.reject(new Error("过期失败"));
        await settle();
        expect(editor(render())!.source).toEqual(active.source);
        expect(active.source!.summaryId).toBe(f.historical.id);
        expect(f.host.lateWrites).toBe(0); expect(toast.error).not.toHaveBeenCalled();
        expect(calls).toHaveBeenCalledTimes(2);
    });

    it("does not publish or dispatch old-owner callbacks after task/project replacement", async () => {
        const f = await fixture(); const request = deferred<MemoryCandidate[]>();
        const calls = vi.spyOn(memories, "listMemoryCandidates").mockReturnValue(request.promise);
        const oldButtons = promotionButtons(f.render()); click(oldButtons[0]);
        f.props.task = {...f.task, id: "new-task", projectId: "new-project"};
        draw(f.host, () => TaskWrapup(f.props), []);
        request.resolve(f.latestCandidates); await settle();
        expect(editor(draw(f.host, () => TaskWrapup(f.props), []))).toBeUndefined();
        click(oldButtons[3]); expect(calls).toHaveBeenCalledTimes(1);
        expect(toast.error).not.toHaveBeenCalled();
    });

    it("freezes baseline/tags/excerpt, accepts semantic source order, blocks changed identities and preserves dirty close guard", async () => {
        const f = await fixture(); const source = f.latestCandidates[0];
        const initial = structuredClone(source.input);
        const onClose = vi.fn(); const onSaved = vi.fn();
        const ui = editorHost({projectId: f.project.id, initial, source: source.ref, sourceExcerpt: source.source.excerpt, onClose, onSaved});
        const original = ui.render(); change(field(original, initial.body), "本地草稿");
        const dirty = ui.render();
        // Even props matching the dirty body cannot redefine its clean baseline.
        ui.props.initial = {...initial, body: "本地草稿", tags: ["新标签"]};
        ui.props.sourceExcerpt = "另一个引用";
        const preserved = ui.render();
        expect(field(preserved, "本地草稿")).toBeDefined();
        expect(preserved.some(node => text(node).includes(source.source.excerpt))).toBe(true);
        expect(ui.host.blocker!.shouldBlockFn()).toBe(true);
        click(preserved.find(node => text(node) === "取消")!); ui.render();
        expect(onClose).not.toHaveBeenCalled();
        const promote = vi.spyOn(memories, "promoteProjectMemory");
        ui.props.projectId = "foreign-project"; ui.props.source = f.oldCandidates[0].ref;
        const mismatched = ui.render();
        expect(mismatched.some(node => text(node).includes("编辑目标已发生变化"))).toBe(true);
        submit(dirty); submit(mismatched); await settle();
        expect(promote).not.toHaveBeenCalled(); expect(onSaved).not.toHaveBeenCalled();
        expect(field(ui.render(), "本地草稿")).toBeDefined();
        // Restoring the original identity permits saving the original coherent session.
        ui.props.projectId = f.project.id;
        const ref = source.ref;
        ui.props.source = {itemText: ref.itemText, itemIndex: ref.itemIndex, itemKind: ref.itemKind,
            summaryRevision: ref.summaryRevision, summaryId: ref.summaryId, taskId: ref.taskId};
        const reordered = ui.render();
        expect(reordered.find(node => node.props.type === "submit")!.props.disabled).toBe(false);
        expect(reordered.some(node => text(node).includes("草稿与原始来源仍保留"))).toBe(false);
        submit(reordered); await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
        expect(promote.mock.calls[0].slice(0, 3)).toMatchObject([f.project.id, source.ref, {body: "本地草稿", tags: initial.tags}]);
    });

    it("retains edit draft through live revisions and requires explicit latest-revision reconciliation", async () => {
        const project = await createProject("CAS");
        const input: MemoryInput = {category: "decision", title: "主题", topicKey: "主题", body: "原文", applicability: "", tags: ["原标签"]};
        const created = (await memories.createProjectMemory(project.id, input)).memory;
        const onSaved = vi.fn(); const ui = editorHost({projectId: project.id, memory: created, initial: created, onClose: vi.fn(), onSaved});
        let current = created;
        const render = () => draw(ui.host, () => MemoryEditor(ui.props), [{data: current}, {data: []}]);
        change(field(render(), "原文"), "本地修订");
        current = await memories.updateProjectMemory(project.id, created.id, {...input, body: "远程修订"}, created.revision);
        ui.props.memory = current; ui.props.initial = current;
        let tree = render();
        expect(field(tree, "本地修订")).toBeDefined(); expect(ui.host.blocker!.shouldBlockFn()).toBe(true);
        expect(tree.find(node => node.props.type === "submit")!.props.disabled).toBe(true);
        const update = vi.spyOn(memories, "updateProjectMemory");
        submit(tree); await vi.waitFor(() => {expect(render().some(node => text(node).includes("已更新"))).toBe(true);});
        expect(update.mock.calls[0][3]).toBe(1); expect(onSaved).not.toHaveBeenCalled();
        tree = render(); click(tree.find(node => text(node) === "已核对最新版本，保留我的草稿继续编辑")!);
        tree = render(); expect(field(tree, "本地修订")).toBeDefined();
        expect(tree.find(node => node.props.type === "submit")!.props.disabled).toBe(false);
        submit(tree); await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
        expect(update.mock.calls[1][3]).toBe(current.revision);
        expect(await memories.getProjectMemory(project.id, created.id)).toMatchObject({body: "本地修订", revision: 3, tags: ["原标签"]});
        // Query ownership stays on the mount snapshot, independently of prop revisions.
        expect(await ui.host.queriers[0]()).toMatchObject({data: {id: created.id, projectId: project.id}});
    });

    it("retires saved callbacks before synchronous unmount and never submits the closed editor again", async () => {
        const f = await fixture(); const candidate = f.latestCandidates[0];
        const onSaved = vi.fn(() => unmount(ui.host));
        const ui = editorHost({projectId: f.project.id, initial: candidate.input, source: candidate.ref,
            onClose: vi.fn(), onSaved});
        const captured = ui.render(); const promote = vi.spyOn(memories, "promoteProjectMemory");
        submit(captured); await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
        const lateWrites = ui.host.lateWrites;
        submit(captured); await Promise.allSettled(promote.mock.results.map(result => result.value)); await settle();
        expect(promote).toHaveBeenCalledTimes(1);
        expect(ui.host.lateWrites).toBe(0);
        expect(lateWrites).toBe(0);
        expect(await db.projectMemories.count()).toBe(1);
    });

    it("retires saved callbacks even when the caller has not rendered the close yet", async () => {
        const f = await fixture(); const candidate = f.latestCandidates[0]; const onSaved = vi.fn();
        const ui = editorHost({projectId: f.project.id, initial: candidate.input, source: candidate.ref,
            onClose: vi.fn(), onSaved});
        const captured = ui.render(); const promote = vi.spyOn(memories, "promoteProjectMemory");
        submit(captured); await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
        submit(captured); await Promise.allSettled(promote.mock.results.map(result => result.value)); await settle();
        expect(promote).toHaveBeenCalledTimes(1);
        expect(onSaved).toHaveBeenCalledTimes(1);
    });

    it.each(["resolve", "reject"] as const)("ignores pending editor %s and captured submit after unmount", async outcome => {
        const f = await fixture(); const candidate = f.latestCandidates[0]; const gate = deferred<void>();
        const actualPromote = memories.promoteProjectMemory;
        const promote = vi.spyOn(memories, "promoteProjectMemory").mockImplementationOnce(async (...args) => {
            await gate.promise;
            return actualPromote(...args);
        });
        const onSaved = vi.fn(); const ui = editorHost({projectId: f.project.id, initial: candidate.input,
            source: candidate.ref, onClose: vi.fn(), onSaved});
        const captured = ui.render(); submit(captured); unmount(ui.host);
        if (outcome === "resolve") gate.resolve(); else gate.reject(new Error("过期保存失败"));
        await Promise.allSettled(promote.mock.results.map(result => result.value)); await settle();
        submit(captured); await Promise.allSettled(promote.mock.results.map(result => result.value)); await settle();
        expect(promote).toHaveBeenCalledTimes(1);
        expect(onSaved).not.toHaveBeenCalled();
        expect(ui.host.lateWrites).toBe(0);
        expect(toast.success).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
    });

    it("reports a completed original-owner save without calling a changed owner's callback", async () => {
        const f = await fixture(); const candidate = f.latestCandidates[0]; const gate = deferred<void>();
        const actualPromote = memories.promoteProjectMemory;
        const promote = vi.spyOn(memories, "promoteProjectMemory").mockImplementationOnce(async (...args) => {
            await gate.promise;
            return actualPromote(...args);
        });
        const onSaved = vi.fn(); const ui = editorHost({projectId: f.project.id, initial: candidate.input,
            source: candidate.ref, onClose: vi.fn(), onSaved});
        const captured = ui.render(); submit(captured);
        ui.props.projectId = "new-owner"; ui.props.source = f.oldCandidates[0].ref; ui.render();
        gate.resolve();
        await Promise.allSettled(promote.mock.results.map(result => result.value)); await settle();
        expect(onSaved).not.toHaveBeenCalled();
        expect(ui.render().some(node => text(node).includes("原编辑目标已保存"))).toBe(true);
        expect((await db.projectMemories.toArray())[0]).toMatchObject({projectId: f.project.id, body: candidate.input.body});
        expect(ui.host.blocker!.shouldBlockFn()).toBe(false);
        ui.props.projectId = f.project.id; ui.props.source = candidate.ref;
        const completed = ui.render();
        expect(completed.find(node => node.props.type === "submit")!.props.disabled).toBe(true);
        submit(captured); await Promise.allSettled(promote.mock.results.map(result => result.value)); await settle(); expect(promote).toHaveBeenCalledTimes(1);
    });

    it("accepts one promotion and one save after initial effect cleanup/setup replay", async () => {
        const f = await fixture(); const initialTree = f.render(); replayMountEffects(f.host);
        const candidates = vi.spyOn(memories, "listMemoryCandidates").mockResolvedValueOnce(f.latestCandidates);
        click(promotionButtons(initialTree)[0]); click(sourceButton(initialTree, f.historical.id));
        await settle(); const current = editor(f.render())!;
        expect(candidates).toHaveBeenCalledTimes(1);
        const ui = editorHost(current); const captured = ui.render(); replayMountEffects(ui.host);
        const promote = vi.spyOn(memories, "promoteProjectMemory");
        submit(captured); await vi.waitFor(() => expect(editor(f.render())).toBeUndefined());
        expect(promote).toHaveBeenCalledTimes(1);
        expect(await db.projectMemories.count()).toBe(1);
        unmount(ui.host); unmount(f.host); submit(captured); await Promise.allSettled(promote.mock.results.map(result => result.value)); await settle();
        expect(promote).toHaveBeenCalledTimes(1); expect(ui.host.lateWrites).toBe(0);
        expect(f.host.lateWrites).toBe(0);
    });

});
