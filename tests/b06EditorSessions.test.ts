import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {ReactElement} from "react";

// Execute production components, hooks, effects and captured callbacks. The
// deterministic host does not simulate ReactDOM/Radix or browser scheduling.
type Effect = {deps?: unknown[]; setup: () => void | (() => void); cleanup?: () => void};
type Host = {cells: unknown[]; cursor: number; effects: Array<() => void>; results: unknown[];
    queryIndex: number; mounted: boolean; lateWrites: number};
const runtime = vi.hoisted(() => ({active: undefined as Host | undefined}));
vi.mock("react", async original => {
    const react = await original<typeof import("react")>();
    return {...react,
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
        useEffect: (setup: Effect["setup"], deps?: unknown[]) => {
            const host = runtime.active!; const index = host.cursor++;
            const previous = host.cells[index] as Effect | undefined;
            if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
                const cell: Effect = {deps, setup}; host.cells[index] = cell;
                host.effects.push(() => {previous?.cleanup?.(); cell.cleanup = setup() || undefined;});
            }
        },
        useMemo: (compute: () => unknown, deps: unknown[]) => {
            const host = runtime.active!; const index = host.cursor++;
            const previous = host.cells[index] as {deps: unknown[]; value: unknown} | undefined;
            if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) host.cells[index] = {deps, value: compute()};
            return (host.cells[index] as {value: unknown}).value;
        },
        useCallback: (callback: unknown, deps: unknown[]) => {
            const host = runtime.active!; const index = host.cursor++;
            const previous = host.cells[index] as {deps: unknown[]; value: unknown} | undefined;
            if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) host.cells[index] = {deps, value: callback};
            return (host.cells[index] as {value: unknown}).value;
        },
    };
});
vi.mock("@/platform/product/queries", () => {
    const read = () => {const host = runtime.active!; return host.results[host.queryIndex++];};
    return {useProductQuery: read, useProductQueryState: () => ({value: read(), error: null})};
});
vi.mock("@tanstack/react-router", () => ({useBlocker: () => ({status: "idle"})}));
vi.mock("sonner", () => ({toast: {error: vi.fn(), success: vi.fn()}}));
vi.mock("@/app/drafts/undo", () => ({useUndo: () => ({registerUndo: vi.fn()})}));

import {toast} from "sonner";
import {db} from "@/platform/product/store";
import * as repoProjects from "@/features/projects/commands/projects";
import * as repoEpisodes from "@/features/video/commands/episodes";
import * as repoConnectors from "@/features/settings/commands/connectors";
import * as connectors from "@/features/settings/models/connectors";
import {ConnectorsSection as ConnectorsPage} from "@/features/settings/ui/ConnectorsPage";
import {StoryPage} from "@/features/video/ui/StoryPage";
import {PageHeader} from "@/app/layout/PageLayout";
import {SidePanel} from "@/app/layout/SidePanel";
import {DraftStatus} from "@/app/drafts/draft-status";
import {Input} from "@/ui/input";
import {Textarea} from "@/ui/textarea";
import type {ConnectorConfig} from "@/features/settings/models/connector";
import type {Episode} from "@/features/video/models/episodes";

import {ModuleLayout} from "@/app/layout/ModuleLayout";
type Node = ReactElement<Record<string, unknown>>;
const hosts: Host[] = [];
function mount(results: unknown[] = []) {
    const host: Host = {cells: [], cursor: 0, effects: [], results, queryIndex: 0, mounted: true, lateWrites: 0};
    hosts.push(host); return host;
}
function effects(host: Host) {return host.cells.filter((cell): cell is Effect => !!cell && typeof cell === "object" && "setup" in cell);}
function unmount(host: Host) {host.mounted = false; effects(host).forEach(cell => cell.cleanup?.());}
function replay(host: Host) {
    effects(host).forEach(cell => cell.cleanup?.());
    effects(host).forEach(cell => {cell.cleanup = cell.setup() || undefined;});
}
function nodes(tree: unknown): Node[] {
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
    const node = tree as Node;
    // Render the actual stateless header so controls in its actions/back slots
    // remain visible to this shallow host, just as children already are.
    const children = node.type === PageHeader
        ? PageHeader(node.props as Parameters<typeof PageHeader>[0])
        : node.props.children;
    return [node, ...nodes(children), ...(node.type === ModuleLayout ? nodes(node.props.navigation) : []),
        // A side panel keeps its confirm/cancel in `footer`, outside its children.
        ...nodes(node.props.footer)];
}
function draw(host: Host, run: () => unknown) {
    runtime.active = host; host.cursor = 0; host.queryIndex = 0;
    const tree = nodes(run()); host.effects.splice(0).forEach(effect => effect()); return tree;
}
function text(node: Node): string {
    const children = node.props.children;
    return (Array.isArray(children) ? children : [children]).map(child => typeof child === "string" ? child : "").join("");
}
function button(tree: Node[], label: string) {return tree.find(node => text(node) === label)!;}
function click(node: Node) {(node.props.onClick as () => void)();}
function change(node: Node, value: string) {(node.props.onChange as (event: unknown) => void)({target: {value}});}
function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};
}
async function settle() {for (let i = 0; i < 8; i++) await Promise.resolve();}
function connectorUI(configs: ConnectorConfig[] = []) {
    // Match the production live-query result, which also has loading/error
    // states; a raw array would silently open installed connections as new.
    const host = mount([{connectors: configs}]); const render = () => draw(host, () => ConnectorsPage());
    const cards = render().filter(node => text(node).trim() === "安装" || text(node) === "编辑");
    const open = (index = 0) => {click(cards[index]); return render();};
    const close = (tree = render()) => (tree.find(node => node.type === SidePanel)!.props.onOpenChange as (open: boolean) => void)(false);
    return {host, render, open, close, cards};
}
async function storyUI() {
    const project = await repoProjects.createProject("B06");
    const episode = (await repoEpisodes.listEpisodes(project.id))[0];
    await repoEpisodes.updateEpisodeDraft(episode.id, {script: "original", title: "title", logline: "logline"});
    let current = (await db.episodes.get(episode.id))!;
    const pageHost = mount([project, current, [], []]);
    const scope = StoryPage({projectId: project.id, episodeId: episode.id});
    const element = draw(pageHost, () => (scope.type as (props: unknown) => unknown)(scope.props))
        .find(node => typeof node.type === "function" && node.type.name === "StoryEditor")!;
    const host = mount();
    const render = () => draw(host, () => (element.type as (props: unknown) => unknown)({...element.props, episode: current}));
    const script = () => render().find(node => node.type === Textarea)!;
    const drop = (file: File, tree = render()) => (tree.find(node => node.props.onDrop)!.props.onDrop as (event: unknown) => void)({preventDefault() {}, dataTransfer: {files: [file]}});
    const external = (next: Episode) => {current = next; render();};
    render(); return {host, episode, project, render, script, drop, external};
}
function scriptFile(gate: ReturnType<typeof deferred<string>>, name = "script.txt", type = "text/plain") {
    const file = new File([], name, {type}); vi.spyOn(file, "text").mockReturnValue(gate.promise); return file;
}
beforeEach(() => {
    hosts.length = 0;
    vi.stubGlobal("document", {visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn()});
    vi.stubGlobal("window", {addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn()});
});
afterEach(async () => {
    hosts.forEach(host => {if (host.mounted) unmount(host);}); await settle();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("B06 deferred risk proof through actual callbacks", () => {
    it("ignores A probe completion after close/open B and does not release B busy", async () => {
        const a = deferred<Awaited<ReturnType<typeof connectors.listConnectorModels>>>();
        const b = deferred<Awaited<ReturnType<typeof connectors.listConnectorModels>>>();
        vi.spyOn(connectors, "listConnectorModels").mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
        const ui = connectorUI(); click(button(ui.open(), "拉取模型探活")); ui.close();
        click(button(ui.open(1), "拉取模型探活"));
        a.resolve({ok: true, models: ["old-model"]}); await settle();
        expect(toast.success).not.toHaveBeenCalled();
        expect(button(ui.render(), "拉取中…")).toBeDefined();
        expect(ui.render().some(node => text(node).includes("old-model"))).toBe(false);
        b.resolve({ok: true, models: ["new-model"]}); await settle();
        expect(ui.render().some(node => text(node).includes("new-model"))).toBe(true);
    });

    it("preserves edits including edit-then-revert during File.text and offers adoption", async () => {
        const ui = await storyUI(); const gate = deferred<string>(); ui.drop(scriptFile(gate));
        const textarea = ui.script(); change(textarea, "edited"); change(textarea, "original");
        gate.resolve("imported"); await settle();
        expect(ui.script().props.value).toBe("original");
        expect(button(ui.render(), "采用导入正文")).toBeDefined();
    });
});

type Listed = Awaited<ReturnType<typeof connectors.listConnectorModels>>;
type Tested = Awaited<ReturnType<typeof connectors.testConnectorConnection>>;
function credentialInputs(tree: Node[]) {return tree.filter(node => node.type === Input);}
function dialogOpen(tree: Node[]) {return tree.find(node => node.type === SidePanel)!.props.open;}
function displayed(tree: Node[], value: string) {return tree.some(node => text(node).includes(value));}
function latest(tree: Node[]) {
    const status = tree.find(node => node.type === DraftStatus)!;
    // Execute the actual status component's visible conflict action as well.
    const rendered = nodes(DraftStatus(status.props as Parameters<typeof DraftStatus>[0]));
    click(button(rendered, "采用最新内容"));
}
async function conflictStory(ui: Awaited<ReturnType<typeof storyUI>>) {
    (ui.render().find(node => node.type === DraftStatus)!.props.onRetry as () => void)();
    await vi.waitFor(() => expect(ui.render().find(node => node.type === DraftStatus)!.props.status).toBe("error"));
}
async function persistStory(ui: Awaited<ReturnType<typeof storyUI>>) {
    (ui.render().find(node => node.type === DraftStatus)!.props.onRetry as () => void)();
    // Actual Dexie transaction, not a mocked auto-save callback.
    await vi.waitFor(async () => expect((await db.episodes.get(ui.episode.id))?.story?.script).toBe(ui.script().props.value));
}

describe("B06 connector operation ownership", () => {
    it.each(["A-first", "B-first"] as const)("keeps reopened B results with %s completion order", async order => {
        const a = deferred<Listed>(); const b = deferred<Listed>();
        const list = vi.spyOn(connectors, "listConnectorModels").mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
        const ui = connectorUI(); const oldTree = ui.open(); click(button(oldTree, "拉取模型探活"));
        ui.close(oldTree); click(button(ui.open(1), "拉取模型探活"));
        if (order === "A-first") {
            a.resolve({ok: true, models: ["old-A"]}); await settle();
            expect(button(ui.render(), "拉取中…")).toBeDefined();
            b.resolve({ok: true, models: ["current-B"]});
        } else {
            b.resolve({ok: true, models: ["current-B"]}); await settle();
            a.resolve({ok: true, models: ["old-A"]});
        }
        await settle(); ui.close(oldTree); // A's retained close callback cannot close B.
        expect(dialogOpen(ui.render())).toBe(true);
        expect(displayed(ui.render(), "current-B")).toBe(true);
        expect(displayed(ui.render(), "old-A")).toBe(false);
        expect(toast.success).toHaveBeenCalledTimes(1);
        click(button(oldTree, "保存")); click(button(oldTree, "测试连接"));
        expect(list).toHaveBeenCalledTimes(2);
    });

    it.each(["result", "throw"] as const)("ignores A stale probe %s failure and finally during B", async outcome => {
        const a = deferred<Listed>(); const b = deferred<Listed>();
        vi.spyOn(connectors, "listConnectorModels").mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
        const ui = connectorUI(); click(button(ui.open(), "拉取模型探活")); ui.close();
        click(button(ui.open(1), "拉取模型探活"));
        if (outcome === "result") a.resolve({ok: false, message: "stale-A"});
        else a.reject(new Error("stale-A"));
        await settle(); expect(toast.error).not.toHaveBeenCalled();
        expect(button(ui.render(), "拉取中…")).toBeDefined();
        b.resolve({ok: true, models: []}); await settle();
    });

    it.each(["baseUrl", "apiKey"] as const)("invalidates first test on %s edit and never starts old nested GET", async field => {
        const a = deferred<Tested>(); const b = deferred<Tested>();
        const test = vi.spyOn(connectors, "testConnectorConnection").mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
        const list = vi.spyOn(connectors, "listConnectorModels");
        const ui = connectorUI(); let tree = ui.open();
        change(credentialInputs(tree)[1], " first-key "); tree = ui.render();
        click(button(tree, "测试连接"));
        change(credentialInputs(tree)[field === "baseUrl" ? 0 : 1], field === "baseUrl" ? "https://new.example/v1" : "second-key");
        expect(button(ui.render(), "测试连接").props.disabled).toBe(false);
        click(button(ui.render(), "测试连接"));
        a.resolve({ok: true, via: "models", modelCount: 3}); await settle();
        expect(list).not.toHaveBeenCalled(); expect(toast.success).not.toHaveBeenCalled();
        expect(button(ui.render(), "测试中…")).toBeDefined();
        expect(test.mock.calls[0][0].apiKey).toBe("first-key");
        expect(test.mock.calls[1][0][field]).toBe(field === "baseUrl" ? "https://new.example/v1" : "second-key");
        b.resolve({ok: true, via: "authenticated-read"}); await settle();
        expect(toast.success).toHaveBeenCalledTimes(1);
    });

    it.each(["A-first", "B-first"] as const)("keeps nested directory publication frozen and owned with %s", async order => {
        const oldDirectory = deferred<Listed>(); const newProbe = deferred<Listed>();
        const test = vi.spyOn(connectors, "testConnectorConnection").mockResolvedValueOnce({ok: true, via: "models", modelCount: 1});
        const list = vi.spyOn(connectors, "listConnectorModels").mockReturnValueOnce(oldDirectory.promise).mockReturnValueOnce(newProbe.promise);
        const ui = connectorUI(); let tree = ui.open(); change(credentialInputs(tree)[1], "frozen-key"); tree = ui.render();
        click(button(tree, "测试连接")); await settle();
        expect(list).toHaveBeenCalledTimes(1); expect(toast.success).not.toHaveBeenCalled();
        expect(test.mock.calls[0][0]).toEqual(list.mock.calls[0][0]);
        change(credentialInputs(tree)[1], "new-key"); click(button(ui.render(), "拉取模型探活"));
        if (order === "A-first") {
            oldDirectory.resolve({ok: true, models: ["old-directory"]}); await settle();
            expect(button(ui.render(), "拉取中…")).toBeDefined();
            newProbe.resolve({ok: true, models: ["new-directory"]});
        } else {
            newProbe.resolve({ok: true, models: ["new-directory"]}); await settle();
            oldDirectory.resolve({ok: true, models: ["old-directory"]});
        }
        await settle();
        expect(displayed(ui.render(), "old-directory")).toBe(false);
        expect(displayed(ui.render(), "new-directory")).toBe(true);
        expect(list.mock.calls[0][0].apiKey).toBe("frozen-key");
        expect(list.mock.calls[1][0].apiKey).toBe("new-key");
        expect(toast.success).toHaveBeenCalledTimes(1);
    });

    it("locks a same-render double probe and freezes credentials edited without rerender", async () => {
        const gate = deferred<Listed>();
        const list = vi.spyOn(connectors, "listConnectorModels").mockReturnValueOnce(gate.promise);
        const test = vi.spyOn(connectors, "testConnectorConnection");
        const save = vi.spyOn(repoConnectors, "upsertConnector");
        const ui = connectorUI(); const tree = ui.open();
        change(credentialInputs(tree)[0], "https://immediate.example/v1");
        change(credentialInputs(tree)[1], " immediate-key ");
        const probe = button(tree, "拉取模型探活");
        click(probe); click(probe); click(button(tree, "测试连接")); click(button(tree, "保存"));
        expect(list).toHaveBeenCalledTimes(1);
        expect(list.mock.calls[0][0]).toMatchObject({baseUrl: "https://immediate.example/v1", apiKey: "immediate-key"});
        expect(test).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
        gate.resolve({ok: true, models: ["current"]}); await settle();
        expect(toast.success).toHaveBeenCalledTimes(1);
        expect(displayed(ui.render(), "current")).toBe(true);
    });

    it.each(["baseUrl", "apiKey"] as const)("retains B probe lock after stale A result on %s edit", async field => {
        const a = deferred<Listed>(); const b = deferred<Listed>();
        const list = vi.spyOn(connectors, "listConnectorModels").mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
        const ui = connectorUI(); const tree = ui.open();
        change(credentialInputs(tree)[1], "first-key"); click(button(tree, "拉取模型探活"));
        change(credentialInputs(tree)[field === "baseUrl" ? 0 : 1], field === "baseUrl" ? "https://next.example/v1" : "next-key");
        click(button(tree, "拉取模型探活"));
        expect(list).toHaveBeenCalledTimes(2); expect(list.mock.calls[0][0].apiKey).toBe("first-key");
        a.resolve({ok: false, message: "old-error"}); await settle();
        expect(toast.error).not.toHaveBeenCalled(); expect(button(ui.render(), "拉取中…")).toBeDefined();
        b.resolve({ok: true, models: ["next-model"]}); await settle();
        expect(displayed(ui.render(), "next-model")).toBe(true); expect(toast.success).toHaveBeenCalledTimes(1);
    });

    it("keeps one current test/nested list and saved-key fallback", async () => {
        const config = await repoConnectors.upsertConnector({definitionId: "openai-compatible", protocol: "openai-compatible", baseUrl: "https://saved.example/v1", apiKey: "saved-key", label: "saved"});
        const a = deferred<Tested>(); const listed = deferred<Listed>();
        const test = vi.spyOn(connectors, "testConnectorConnection").mockReturnValueOnce(a.promise);
        const list = vi.spyOn(connectors, "listConnectorModels").mockReturnValueOnce(listed.promise);
        const ui = connectorUI([config]); const tree = ui.open();
        click(button(tree, "测试连接")); click(button(tree, "测试连接")); click(button(tree, "拉取模型探活")); click(button(tree, "断开"));
        expect(test).toHaveBeenCalledTimes(1); expect(list).not.toHaveBeenCalled();
        a.resolve({ok: true, via: "models", modelCount: 2}); await settle();
        expect(list.mock.calls[0][0]).toEqual({definitionId: config.definitionId, baseUrl: config.baseUrl, apiKey: "saved-key"});
        expect(button(ui.render(), "测试中…")).toBeDefined(); expect(button(ui.render(), "断开").props.disabled).toBe(true);
        listed.resolve({ok: true, models: ["m1", "m2"]}); await settle();
        expect(toast.success).toHaveBeenCalledWith("连接成功（2 个模型）");
        expect(displayed(ui.render(), "m1 · m2")).toBe(true);
        expect(await db.connectors.get(config.id)).toBeDefined();
    });

    it.each(["save", "disconnect"] as const)("synchronously serializes %s and locks dismissal/open/inputs/direct callbacks", async kind => {
        const config = await repoConnectors.upsertConnector({definitionId: "openai-compatible", protocol: "openai-compatible", baseUrl: "https://saved.example/v1", apiKey: "saved-key", label: "saved"});
        const gate = deferred<void>();
        const actualSave = repoConnectors.upsertConnector; const actualDelete = repoConnectors.deleteConnector;
        const save = vi.spyOn(repoConnectors, "upsertConnector").mockImplementation(async input => {await gate.promise; return actualSave(input);});
        const remove = vi.spyOn(repoConnectors, "deleteConnector").mockImplementation(async id => {await gate.promise; return actualDelete(id);});
        const probe = vi.spyOn(connectors, "listConnectorModels"); const test = vi.spyOn(connectors, "testConnectorConnection");
        const ui = connectorUI([config]); let tree = ui.open();
        change(credentialInputs(tree)[0], "https://frozen.example/v1"); change(credentialInputs(tree)[1], "frozen-key"); tree = ui.render();
        const action = button(tree, kind === "save" ? "保存" : "断开");
        click(action); click(action); click(button(tree, kind === "save" ? "断开" : "保存"));
        ui.close(tree); click(ui.cards[1]);
        change(credentialInputs(tree)[0], "https://changed.example/v1"); change(credentialInputs(tree)[1], "changed-key");
        click(button(tree, "测试连接")); click(button(tree, "拉取模型探活"));
        const locked = ui.render();
        expect(dialogOpen(locked)).toBe(true);
        // The panel's own close paths all go through onOpenChange, which refuses while a write is in flight.
        const panel = locked.find(node => node.type === SidePanel)!;
        (panel.props.onOpenChange as (open: boolean) => void)(false);
        expect(dialogOpen(ui.render())).toBe(true);
        expect(credentialInputs(locked).map(node => node.props.value)).toEqual(["https://frozen.example/v1", "frozen-key"]);
        expect(credentialInputs(locked).every(node => node.props.disabled)).toBe(true);
        expect(button(locked, "断开").props.disabled).toBe(true);
        expect(locked.filter(node => text(node).trim() === "安装" || text(node) === "编辑").every(node => node.props.disabled)).toBe(true);
        expect(save).toHaveBeenCalledTimes(kind === "save" ? 1 : 0);
        expect(remove).toHaveBeenCalledTimes(kind === "disconnect" ? 1 : 0);
        expect(test).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
        gate.resolve(); await Promise.allSettled([...save.mock.results, ...remove.mock.results].map(result => result.value)); await settle();
        expect(dialogOpen(ui.render())).toBe(false);
        if (kind === "save") expect(await db.connectors.get(config.id)).toMatchObject({baseUrl: "https://frozen.example/v1", apiKey: "frozen-key"});
        else expect(await db.connectors.get(config.id)).toBeUndefined();
        expect(toast.success).toHaveBeenCalledTimes(1);
    });

    it.each(["probe", "test", "save", "disconnect"] as const)("redacts current %s failure and unlocks for retry", async kind => {
        const config = await repoConnectors.upsertConnector({definitionId: "openai-compatible", protocol: "openai-compatible", baseUrl: "https://saved.example/v1", apiKey: "private-key", label: "saved"});
        const gate = deferred<never>();
        const list = vi.spyOn(connectors, "listConnectorModels").mockReturnValueOnce(gate.promise).mockResolvedValue({ok: true, models: []});
        const test = vi.spyOn(connectors, "testConnectorConnection").mockReturnValueOnce(gate.promise).mockResolvedValue({ok: true, via: "authenticated-read"});
        const save = vi.spyOn(repoConnectors, "upsertConnector").mockReturnValueOnce(gate.promise).mockResolvedValue(config);
        const remove = vi.spyOn(repoConnectors, "deleteConnector").mockReturnValueOnce(gate.promise).mockResolvedValue(undefined);
        const ui = connectorUI([config]); const label = {probe: "拉取模型探活", test: "测试连接", save: "保存", disconnect: "断开"}[kind];
        click(button(ui.open(), label)); gate.reject(new Error("private-key Bearer hidden-token " + "x".repeat(400))); await settle();
        // Model probing goes through showError (toast description); test/save/disconnect show a sanitized inline alert in the editor dialog.
        let error: string;
        if (kind === "probe") {
            const [, options] = vi.mocked(toast.error).mock.calls[0] as [string, {description?: string}?];
            error = options?.description ?? "";
        } else {
            error = ui.render().filter(node => node.props.role === "alert").map(text).join("");
            expect(toast.error).not.toHaveBeenCalled();
        }
        expect(error).toContain("[已隐藏]"); expect(error).not.toContain("private-key"); expect(error).not.toContain("hidden-token"); expect(error.length).toBeLessThanOrEqual(300);
        expect(dialogOpen(ui.render())).toBe(true); expect(button(ui.render(), label).props.disabled).toBe(false);
        click(button(ui.render(), label)); await settle();
        expect({probe: list, test, save, disconnect: remove}[kind]).toHaveBeenCalledTimes(2);
    });

    it.each(["probe-success", "probe-failure", "test-success", "test-failure", "save-success", "save-failure", "disconnect-success", "disconnect-failure"] as const)("ignores %s completion and captured callbacks after unmount", async caseName => {
        const config = await repoConnectors.upsertConnector({definitionId: "openai-compatible", protocol: "openai-compatible", baseUrl: "https://saved.example/v1", apiKey: "private-key", label: "saved"});
        const gate = deferred<unknown>();
        const list = vi.spyOn(connectors, "listConnectorModels").mockReturnValueOnce(gate.promise as Promise<Listed>);
        const test = vi.spyOn(connectors, "testConnectorConnection").mockReturnValueOnce(gate.promise as Promise<Tested>);
        const save = vi.spyOn(repoConnectors, "upsertConnector").mockReturnValueOnce(gate.promise as ReturnType<typeof repoConnectors.upsertConnector>);
        const remove = vi.spyOn(repoConnectors, "deleteConnector").mockReturnValueOnce(gate.promise as Promise<void>);
        const ui = connectorUI([config]); const tree = ui.open();
        const kind = caseName.split("-")[0]; const label = {probe: "拉取模型探活", test: "测试连接", save: "保存", disconnect: "断开"}[kind]!;
        click(button(tree, label)); unmount(ui.host);
        if (caseName.endsWith("failure")) gate.reject(new Error("late-error"));
        else gate.resolve(kind === "probe" ? {ok: true, models: ["late"]} : kind === "test" ? {ok: true, via: "models", modelCount: 1} : config);
        await settle(); click(button(tree, label)); ui.close(tree); click(ui.cards[1]); change(credentialInputs(tree)[1], "after-unmount");
        expect(toast.success).not.toHaveBeenCalled(); expect(toast.error).not.toHaveBeenCalled();
        expect(ui.host.lateWrites).toBe(0);
        expect(list.mock.calls.length + test.mock.calls.length + save.mock.calls.length + remove.mock.calls.length).toBe(1);
    });

    it("ignores a nested list failure after closing the editor", async () => {
        const gate = deferred<Listed>();
        vi.spyOn(connectors, "testConnectorConnection").mockResolvedValueOnce({ok: true, via: "models", modelCount: 1});
        vi.spyOn(connectors, "listConnectorModels").mockReturnValueOnce(gate.promise);
        const ui = connectorUI(); click(button(ui.open(), "测试连接")); await settle(); ui.close(); ui.open(1);
        gate.reject(new Error("nested-stale")); await settle();
        expect(toast.error).not.toHaveBeenCalled(); expect(toast.success).not.toHaveBeenCalled();
        expect(dialogOpen(ui.render())).toBe(true);
    });

    it("supports effect setup-cleanup-setup replay then exactly one write", async () => {
        const ui = connectorUI(); ui.render(); replay(ui.host);
        let tree = ui.open(); change(credentialInputs(tree)[1], "replay-key"); tree = ui.render();
        const save = vi.spyOn(repoConnectors, "upsertConnector"); click(button(tree, "保存")); click(button(tree, "保存"));
        await Promise.allSettled(save.mock.results.map(result => result.value)); await settle();
        expect(save).toHaveBeenCalledTimes(1); expect(toast.success).toHaveBeenCalledWith("已保存连接");
        expect(dialogOpen(ui.render())).toBe(false);
    });
});

describe("B06 actual StoryEditor File.text ownership", () => {
    it.each(["A-first", "B-first"] as const)("applies only latest file B with %s results", async order => {
        const ui = await storyUI(); const a = deferred<string>(); const b = deferred<string>();
        const tree = ui.render(); ui.drop(scriptFile(a, "A.md"), tree); ui.drop(scriptFile(b, "B.txt"), tree);
        if (order === "A-first") {
            a.resolve("old-A"); await settle(); expect(ui.script().props.value).toBe("original"); b.resolve("new-B");
        } else {b.resolve("new-B"); await settle(); a.resolve("old-A");}
        await settle(); expect(ui.script().props.value).toBe("new-B");
        await persistStory(ui); expect((await db.episodes.get(ui.episode.id))!.story!.script).toBe("new-B");
        expect((await db.episodes.get(ui.episode.id))!.story!.beats).toEqual([]);
    });

    it.each(["adopt", "discard"] as const)("preserves current text until explicit %s, and auto-saves only accepted text", async decision => {
        const ui = await storyUI(); const gate = deferred<string>(); ui.drop(scriptFile(gate)); change(ui.script(), "my-current-script");
        gate.resolve("candidate-text"); await settle();
        expect(ui.script().props.value).toBe("my-current-script");
        await persistStory(ui); expect((await db.episodes.get(ui.episode.id))!.story!.script).toBe("my-current-script");
        const tree = ui.render(); const adopt = button(tree, "采用导入正文"); const discard = button(tree, "放弃导入");
        click(decision === "adopt" ? adopt : discard);
        // Opposite and duplicate captured choices must not act twice.
        click(decision === "adopt" ? discard : adopt); click(adopt);
        expect(ui.script().props.value).toBe(decision === "adopt" ? "candidate-text" : "my-current-script");
        expect(button(ui.render(), "采用导入正文")).toBeUndefined(); await persistStory(ui);
    });

    it("retains later script edits while a candidate is visible, until explicit adoption", async () => {
        const ui = await storyUI(); const gate = deferred<string>(); ui.drop(scriptFile(gate)); change(ui.script(), "edit-before-read");
        gate.resolve("candidate"); await settle(); const adopt = button(ui.render(), "采用导入正文");
        change(ui.script(), "even-newer-edit"); expect(ui.script().props.value).toBe("even-newer-edit");
        expect(button(ui.render(), "采用导入正文")).toBeDefined(); click(adopt);
        expect(ui.script().props.value).toBe("candidate");
    });

    it("title/logline changes do not conflict with script import and survive its DB save", async () => {
        const ui = await storyUI(); const gate = deferred<string>(); ui.drop(scriptFile(gate));
        const inputs = ui.render().filter(node => node.type === Input);
        change(inputs[0], "my-title"); change(inputs[1], "my-logline"); gate.resolve("imported-script"); await settle();
        expect(ui.script().props.value).toBe("imported-script"); expect(button(ui.render(), "采用导入正文")).toBeUndefined();
        await persistStory(ui);
        expect(await db.episodes.get(ui.episode.id)).toMatchObject({title: "my-title", story: {logline: "my-logline", script: "imported-script", beats: []}});
    });

    it("new file synchronously supersedes prior candidate and captured adopt/discard", async () => {
        const ui = await storyUI(); const a = deferred<string>(); ui.drop(scriptFile(a)); change(ui.script(), "local");
        a.resolve("A-candidate"); await settle(); const tree = ui.render();
        const b = deferred<string>(); ui.drop(scriptFile(b, "B.md"), tree);
        click(button(tree, "采用导入正文")); click(button(tree, "放弃导入"));
        expect(ui.script().props.value).toBe("local"); expect(button(ui.render(), "采用导入正文")).toBeUndefined();
        change(ui.script(), "local-B"); b.resolve("B-candidate"); await settle();
        expect(displayed(ui.render(), "B-candidate")).toBe(true); expect(displayed(ui.render(), "A-candidate")).toBe(false);
        click(button(tree, "采用导入正文")); click(button(tree, "放弃导入"));
        expect(ui.script().props.value).toBe("local-B");
        expect(displayed(ui.render(), "B-candidate")).toBe(true);
        click(button(ui.render(), "采用导入正文")); expect(ui.script().props.value).toBe("B-candidate");
    });

    it("read failure preserves the draft, replaces old candidate, and permits retry", async () => {
        const ui = await storyUI(); const a = deferred<string>(); ui.drop(scriptFile(a)); change(ui.script(), "local");
        a.resolve("A-candidate"); await settle();
        const b = deferred<string>(); ui.drop(scriptFile(b)); b.reject(new Error("read failure")); await settle();
        expect(ui.script().props.value).toBe("local"); expect(button(ui.render(), "采用导入正文")).toBeUndefined();
        expect(ui.render().find(node => node.props.role === "alert")).toBeDefined();
        const c = deferred<string>(); ui.drop(scriptFile(c)); expect(ui.render().find(node => node.props.role === "alert")).toBeUndefined();
        c.resolve("retried-import"); await settle(); expect(ui.script().props.value).toBe("retried-import"); await persistStory(ui);
    });

    it.each(["A-first", "B-first"] as const)("ignores older failure with %s completion order", async order => {
        const ui = await storyUI(); const a = deferred<string>(); const b = deferred<string>();
        ui.drop(scriptFile(a)); ui.drop(scriptFile(b));
        if (order === "A-first") {a.reject(new Error("old failure")); await settle(); b.resolve("B");}
        else {b.resolve("B"); await settle(); a.reject(new Error("old failure"));}
        await settle(); expect(ui.script().props.value).toBe("B"); expect(ui.render().find(node => node.props.role === "alert")).toBeUndefined();
    });

    it.each(["resolve", "reject"] as const)("invalidates pending import on useLatest before %s", async outcome => {
        const ui = await storyUI(); const gate = deferred<string>(); ui.drop(scriptFile(gate)); change(ui.script(), "dirty");
        await repoEpisodes.updateEpisodeDraft(ui.episode.id, {script: "remote-latest"});
        ui.external((await db.episodes.get(ui.episode.id))!); await conflictStory(ui); latest(ui.render());
        expect(ui.script().props.value).toBe("remote-latest");
        if (outcome === "resolve") gate.resolve("stale-import"); else gate.reject(new Error("stale-read"));
        await settle(); expect(ui.script().props.value).toBe("remote-latest");
        expect(button(ui.render(), "采用导入正文")).toBeUndefined(); expect(ui.render().find(node => node.props.role === "alert")).toBeUndefined();
    });

    it("useLatest invalidates a visible candidate and captured adoption callback", async () => {
        const ui = await storyUI(); const gate = deferred<string>(); ui.drop(scriptFile(gate)); change(ui.script(), "dirty");
        gate.resolve("candidate"); await settle(); const oldAdopt = button(ui.render(), "采用导入正文");
        await repoEpisodes.updateEpisodeDraft(ui.episode.id, {script: "remote-latest"}); ui.external((await db.episodes.get(ui.episode.id))!);
        await conflictStory(ui); latest(ui.render()); click(oldAdopt);
        expect(ui.script().props.value).toBe("remote-latest"); expect(button(ui.render(), "采用导入正文")).toBeUndefined();
        await persistStory(ui);
    });

    it.each(["resolve", "reject", "candidate"] as const)("ignores %s and captured file/edit/adopt callbacks after episode unmount", async outcome => {
        const ui = await storyUI(); const gate = deferred<string>(); const originalTree = ui.render();
        ui.drop(scriptFile(gate));
        let candidateTree: Node[] | undefined;
        if (outcome === "candidate") {
            change(ui.script(), "local"); gate.resolve("candidate"); await settle(); candidateTree = ui.render(); await persistStory(ui);
        }
        const read = deferred<string>(); const file = scriptFile(read); unmount(ui.host);
        const next = await storyUI();
        if (outcome === "resolve") gate.resolve("stale-import"); else if (outcome === "reject") gate.reject(new Error("stale-read"));
        await settle(); ui.drop(file, originalTree); change(originalTree.find(node => node.type === Textarea)!, "late-edit");
        if (candidateTree) click(button(candidateTree, "采用导入正文"));
        expect(file.text).not.toHaveBeenCalled(); expect(ui.host.lateWrites).toBe(0);
        expect(next.script().props.value).toBe("original"); expect(button(next.render(), "采用导入正文")).toBeUndefined();
        expect((await db.episodes.get(ui.episode.id))!.story!.script).toBe(outcome === "candidate" ? "local" : "original");
    });

    it.each([
        ["SCRIPT.TXT", ""], ["story.MD", ""], ["story.markdown", ""], ["unknown", "text/plain"],
        ["unknown", "text/markdown"], ["unknown", "text/x-markdown"],
    ])("retains filename/MIME acceptance for %s / %s", async (name, mime) => {
        const ui = await storyUI(); const gate = deferred<string>(); const file = scriptFile(gate, name, mime);
        ui.drop(file); gate.resolve("accepted"); await settle(); expect(file.text).toHaveBeenCalledTimes(1);
        expect(ui.script().props.value).toBe("accepted");
    });

    it("ignores unsupported files without invalidating the active accepted read", async () => {
        const ui = await storyUI(); const valid = deferred<string>(); const invalid = deferred<string>();
        ui.drop(scriptFile(valid)); const rejected = scriptFile(invalid, "image.png", "image/png"); ui.drop(rejected);
        expect(rejected.text).not.toHaveBeenCalled(); valid.resolve("valid"); await settle(); expect(ui.script().props.value).toBe("valid");
    });

    it.each(["adopt", "discard"] as const)("real debounce saves local text and only explicit %s controls imported persistence", async decision => {
        const ui = await storyUI(); const gate = deferred<string>();
        const writes = vi.spyOn(repoEpisodes, "updateEpisodeDraft");
        // Control only timeout/Date. IndexedDB scheduling remains real, and no
        // Retry/flush callback is invoked: the production 400ms debounce writes.
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
        try {
            ui.drop(scriptFile(gate)); const tree = ui.render();
            change(tree.find(node => node.type === Input)!, "timer-title");
            change(ui.script(), "timer-local"); gate.resolve("timer-import"); await settle();
            expect(ui.script().props.value).toBe("timer-local"); expect(writes).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(399); expect(writes).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            await Promise.all(writes.mock.results.map(result => result.value)); await settle();
            expect(await db.episodes.get(ui.episode.id)).toMatchObject({title: "timer-title", story: {script: "timer-local", beats: []}});
            const options = ui.render(); click(button(options, decision === "adopt" ? "采用导入正文" : "放弃导入"));
            expect(writes).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(400);
            await Promise.all(writes.mock.results.map(result => result.value)); await settle();
            expect(writes).toHaveBeenCalledTimes(decision === "adopt" ? 2 : 1);
            expect(await db.episodes.get(ui.episode.id)).toMatchObject({title: "timer-title", story: {script: decision === "adopt" ? "timer-import" : "timer-local", beats: []}});
            expect(button(ui.render(), "采用导入正文")).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it("supports actual effect replay then import/adoption through the resumed draft hook", async () => {
        const ui = await storyUI(); replay(ui.host);
        const gate = deferred<string>(); ui.drop(scriptFile(gate)); change(ui.script(), "local-after-replay");
        gate.resolve("import-after-replay"); await settle(); expect(ui.script().props.value).toBe("local-after-replay");
        click(button(ui.render(), "采用导入正文")); await persistStory(ui);
        expect((await db.episodes.get(ui.episode.id))!.story!.script).toBe("import-after-replay"); expect(ui.host.lateWrites).toBe(0);
    });
});
