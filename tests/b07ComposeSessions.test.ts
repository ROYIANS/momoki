import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {ReactElement} from "react";

// Execute the real page/hooks and their effects/callbacks in a deterministic host.
// UI leaves and provider I/O are mocked; browser scheduling is not verified
// by this host. The separate B07 browser fixture reports its own coverage.
type Effect = {deps?: unknown[]; setup: () => void | (() => void); cleanup?: () => void};
type Host = {cells: unknown[]; cursor: number; effects: Array<() => void>; results: unknown[];
    queryIndex: number; mounted: boolean; lateWrites: number};
const runtime = vi.hoisted(() => ({active: undefined as Host | undefined}));
vi.mock("react", async original => {
    const react = await original<typeof import("react")>();
    return {...react,
        useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => {runtime.active!.cursor++; return snapshot();},
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

vi.mock("@/features/agent/queries/threadReading", () => ({useThreadControl: (threadId?: string) => {
    const host = runtime.active!;
    const results = host.results[8] as {runs: import("@/features/agent/models/agent").AgentRun[]} | undefined;
    return {threadId, ready: true, hasMessages: false, hasRuns: !!results?.runs.length, runs: results?.runs ?? [], compacting: false};
}}));

const io = vi.hoisted(() => ({navigate: vi.fn(), create: vi.fn(), begin: vi.fn(), execute: vi.fn(),
    update: vi.fn(), resolveConnector: vi.fn(), reconcile: vi.fn(), importFile: vi.fn(), retryImport: vi.fn(), compatible: vi.fn(), discover: vi.fn(), lock: vi.fn()}));
vi.mock("@tanstack/react-router", () => ({useNavigate: () => io.navigate, Link: "a", useBlocker: () => ({status: "idle", proceed: vi.fn(), reset: vi.fn()})}));
vi.mock("sonner", () => ({toast: {error: vi.fn(), success: vi.fn()}}));
vi.mock("@/features/agent/commands/chat", async original => ({...await original<typeof import("@/features/agent/commands/chat")>(),
    createChatThread: io.create, updateChatThread: io.update}));
vi.mock("@/features/settings/commands/connectors", () => ({resolveConnector: io.resolveConnector}));
vi.mock("@/features/agent/queries/agentAdmission", () => ({readAgentAdmission: io.reconcile}));
vi.mock("@/platform/identity", async original => ({...await original<typeof import("@/platform/identity")>(),
    createId: (prefix: string) => prefix === "thread" ? "created" : `${prefix}_${crypto.randomUUID()}`}));
vi.mock("@/features/agent/commands/agentRuns", async original => ({...await original<typeof import("@/features/agent/commands/agentRuns")>(), beginAgentRun: io.begin}));
vi.mock("@/features/agent/runtime/runChat", () => ({executeChatRun: io.execute, resumeChatRun: vi.fn()}));
vi.mock("@/features/agent/runtime/runOwnership", async original => ({...await original<typeof import("@/features/agent/runtime/runOwnership")>(),
    recoverAbandonedRuns: vi.fn().mockResolvedValue(undefined), withThreadRunLock: io.lock}));
vi.mock("@/features/agent/runtime/taskWrapup", () => ({recoverTaskWrapups: vi.fn().mockResolvedValue(undefined)}));
vi.mock("@/features/settings/models/connectors", () => ({runWithCompatibleChatModel: io.compatible,
    discoverConnectorChatModels: io.discover}));
vi.mock("@/features/references/documents/import", () => ({importReferenceFile: io.importFile, retryReferenceImport: io.retryImport}));
vi.mock("@/features/agent/ui/AgentActivityNavigation", () => ({AgentActivityNavigationProvider: "navigation-provider"}));
vi.mock("@/features/agent/ui/HomeWelcome", () => ({HomeWelcome: "home"}));
vi.mock("@/features/agent/ui/ChatWorkspace", () => ({ChatWorkspace: "workspace"}));
vi.mock("@/features/agent/ui/TaskBoard", () => ({TaskBoard: "board"}));
vi.mock("@/features/agent/ui/TaskInspector", () => ({TaskInspector: "inspector"}));
vi.mock("@/features/agent/ui/AgentComposerAttention", () => ({AgentComposerAttention: "attention"}));
vi.mock("@/features/agent/ui/ContextUsagePanel", () => ({ContextUsageTrigger: "context"}));
vi.mock("@lobehub/ui", () => ({Button: "button", Empty: "empty", Flexbox: "div"}));


const retained = vi.hoisted(() => ({execution: undefined as AgentExecutionService | undefined,
    drafts: undefined as ReturnType<typeof import("@/features/agent/runtime/chatDraftStore").createChatDraftStore> | undefined}));
vi.mock("@/features/agent/runtime/agentExecution", () => ({get agentExecution() {return retained.execution!;}}));
vi.mock("@/features/agent/runtime/chatDraftStore", async original => ({...await original<typeof import("@/features/agent/runtime/chatDraftStore")>(),
    get chatDrafts() {return retained.drafts!;}}));

import {toast} from "sonner";
import {db} from "@/platform/product/store";
import {UnknownCommitError} from "@/platform/storage/errors";
import {resetReportedErrorsForTests} from "@/platform/diagnostics/reportError";
import {AgentChatPage} from "@/features/agent/ui/AgentChatPage";
import {useReferenceDraft} from "@/features/agent/ui/useReferenceDraft";
import {createAgentExecutionService, type AgentExecutionService} from "@/features/agent/runtime/agentExecutionService";
import {createChatDraftStore} from "@/features/agent/runtime/chatDraftStore";
import type {ComposerProps} from "@/features/agent/ui/composerTypes";
import type {TurnProblem, TurnProblemActionKind} from "@/features/agent/models/turnProblem";
import type {ChatThread} from "@/features/agent/models/chat";
import type {ConnectorConfig} from "@/features/settings/models/connector";
import type {Project} from "@/features/projects/models/project";
import type {ProjectReference} from "@/features/references/models/references";

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
    const node = tree as Node; return [node, ...nodes(node.props.children)];
}
function draw(host: Host, run: () => unknown) {
    runtime.active = host; host.cursor = 0; host.queryIndex = 0;
    const tree = nodes(run()); host.effects.splice(0).forEach(effect => effect()); return tree;
}

function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};
}
async function settle() {
    for (let i = 0; i < 8; i++) {await Promise.resolve(); await new Promise<void>(resolve => setImmediate(resolve));}
}
const connector: ConnectorConfig = {id: "connector", definitionId: "openai-compatible", protocol: "openai-compatible",
    baseUrl: "https://unused.invalid", apiKey: "mock-only", updatedAt: "2026-09-30"};
function thread(id: string, projectId = "p"): ChatThread {
    return {id, projectId, title: id, connectorId: connector.id, model: "model", createdAt: "2026-09-30", updatedAt: "2026-09-30"};
}
function page(initial?: string, connection = connector) {
    const host = mount(); let active = initial; let pendingOwnership = false;
    let runResults: unknown[] = [];
    const threads = [thread("A"), thread("B")];
    const render = () => {
        host.results = [threads, [], [], [connection], [{id: "p"}, {id: "q"}] as Project[],
            pendingOwnership ? {forId: "old", thread: null} : {forId: active ?? null, thread: threads.find(item => item.id === active) ?? null},
            {forThreadId: active ?? null, messages: []}, {forThreadId: active ?? null, compactions: []},
            {forThreadId: active ?? null, runs: runResults}];
        return draw(host, () => {
            const wrapper = AgentChatPage({threadId: active}) as Node;
            const child = (wrapper.props.children as Node).props.children as Node;
            return (child.type as (props: unknown) => unknown)(child.props);
        });
    };
    const surface = () => {render(); return render().find(node => node.type === "home" || node.type === "workspace")!;};
    const composer = () => surface().props.composer as ComposerProps;
    const select = (id?: string) => {active = id; render(); render();};
    io.navigate.mockImplementation(async (options: {params?: {threadId: string}}) => {select(options.params?.threadId);});
    render(); render();
    const attempts = () => (surface().props.submissions ?? []) as import("@/features/agent/models/chatSubmissionAttempt").ChatSubmissionAttempt[];
    // The one bubble above the composer is the only recovery surface; drive its real action callbacks.
    const noticeNode = () => composer().notice as Node | undefined;
    const problem = () => noticeNode()?.props.problem as TurnProblem | undefined;
    const action = async (kind: "retry" | "check" | "recover" | "confirm") => {
        const node = noticeNode(); if (!node) throw new Error("no notice is shown");
        (node.props.onAction as (problem: TurnProblem, kind: TurnProblemActionKind) => void)(node.props.problem as TurnProblem, kind === "retry" ? "retry-send" : kind);
        await settle();
    };
    const dismiss = () => {const node = noticeNode()!; (node.props.onDismiss as (problem: TurnProblem) => void)(node.props.problem as TurnProblem);};
    // Every frozen attempt of the owner, including a failed one whose text already returned to the composer.
    const owned = (id = active ?? "") => retained.execution!.snapshot(id).attempts;
    const turnStatus = () => surface().props.turnStatus;
    return {host, threads, render, surface, composer, turnStatus, select, attempts, owned, problem, action, dismiss, runs: (value: unknown[]) => {runResults = value; render();}, pendingOwnership: () => {pendingOwnership = true; active = "unknown";}, active: () => active, type: (value: string) => composer().onChange(value),
        attach: (id: string) => composer().onAttachReference!({referenceId: id, revision: 1}),
        // The UI deliberately discards handleSend's promise. Drain callbacks explicitly.
        send: async () => {composer().onSend(); await settle(); render(); await settle();}};
}
function reference(id: string, status: ProjectReference["status"] = "ready"): ProjectReference {
    return {id, projectId: "p", mediaId: `media-${id}`, digest: "digest", kind: "text", filename: "file.txt", mimeType: "text/plain",
        size: 3, revision: 1, status, operationId: "op", coverage: {totalUnits: 1, processedUnits: 1, emptyUnits: [], characters: 3, truncated: false},
        warnings: [], createdAt: "2026-09-30", updatedAt: "2026-09-30"};
}
beforeEach(async () => {
    retained.execution = createAgentExecutionService({store: new Proxy(db, {})});
    retained.drafts = createChatDraftStore();
    await db.chatThreads.bulkPut([thread("A"), thread("B"), thread("created")]);
    hosts.length = 0; vi.clearAllMocks(); resetReportedErrorsForTests(); Object.values(io).forEach(mock => mock.mockReset());
    vi.stubGlobal("window", {addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn()});
    io.update.mockResolvedValue(undefined); io.execute.mockResolvedValue(undefined);
    io.resolveConnector.mockResolvedValue(connector); io.reconcile.mockResolvedValue({status: "absent"});
    io.discover.mockResolvedValue({models: ["model"]});
    io.begin.mockResolvedValue({id: "run"});
    io.compatible.mockImplementation(async (_connector, _model, operation, options) => {
        if (options.signal.aborted || !options.isCurrent()) return {ok: false, aborted: true};
        return {ok: true, value: await operation()};
    });
    io.lock.mockImplementation(async (_id, operation) => operation());
});
afterEach(() => {hosts.forEach(host => {if (host.mounted) unmount(host);}); vi.unstubAllGlobals();});

describe("B07 actual compose callbacks", () => {
    it("keeps text and attachments together across A/B/back", () => {
        const ui = page("A"); ui.type("draft A"); ui.attach("refA");
        (ui.surface().props.onSelectThread as (id: string) => void)("B");
        expect(ui.composer().value).toBe(""); ui.type("draft B"); ui.attach("refB");
        (ui.surface().props.onSelectThread as (id: string) => void)("A");
        expect(ui.composer().value).toBe("draft A");
        expect(ui.composer().attachments).toEqual([{referenceId: "refA", revision: 1}]);
        ui.select("B"); expect(ui.composer().value).toBe("draft B");
    });
    it("new topic returns home without creating a thread and keeps the previous draft", async () => {
        const ui = page("A"); ui.type("unsent"); ui.attach("refA");
        (ui.surface().props.onNewTopic as () => void)(); await settle();
        expect(io.create).not.toHaveBeenCalled();
        expect(io.navigate).toHaveBeenCalledWith({to: "/agent"});
        expect(ui.composer().value).toBe(""); expect(ui.composer().attachments).toEqual([]);
        ui.select("A"); expect(ui.composer().value).toBe("unsent"); expect(ui.composer().attachments).toHaveLength(1);
    });
    it("a late begin cannot clear edited-then-reverted text", async () => {
        const ui = page("A"); ui.type("same"); const gate = deferred<{id: string}>(); io.begin.mockReturnValue(gate.promise);
        const pending = ui.send(); await settle(); ui.type("changed"); ui.type("same");
        gate.resolve({id: "run"}); await pending; await settle();
        expect(ui.composer().value).toBe("same");
    });
    it("a late begin cannot clear equal text belonging to another thread", async () => {
        const ui = page("A"); ui.type("same"); const gate = deferred<{id: string}>(); io.begin.mockReturnValue(gate.promise);
        const pending = ui.send(); await settle(); ui.select("B"); ui.type("same");
        gate.resolve({id: "run"}); await pending; await settle();
        expect(ui.composer().value).toBe("same");
    });
});


describe("B07 first send and ownership boundaries", () => {
    function home() {
        const ui = page(); ui.composer().onProjectChange("p"); ui.composer().onModelChange("model");
        ui.type(" submitted "); ui.attach("submitted-ref");
        const created = thread("created"); ui.threads.push(created);
        return {ui, created};
    }
    it("keeps captured payload in the attempt before navigation; keeps newer home text during deferred creation and begin", async () => {
        const {ui, created} = home(); const creation = deferred<ChatThread>(); const begin = deferred<{id: string}>();
        io.create.mockReturnValue(creation.promise); io.begin.mockReturnValue(begin.promise);
        const pending = ui.send(); await settle();
        expect(io.create).toHaveBeenCalledTimes(1); expect(io.begin).not.toHaveBeenCalled();
        ui.type("new home text");
        io.navigate.mockImplementation(async () => {
            ui.select(created.id);
            expect(ui.composer().value).toBe("");
            expect(ui.composer().attachments).toEqual([]);
            expect(ui.attempts()[0].submitted.text).toBe(" submitted ");
        });
        creation.resolve(created); await settle();
        expect(io.begin.mock.calls[0][0]).toMatchObject({threadId: created.id, content: "submitted",
            attachments: [{referenceId: "submitted-ref", revision: 1}]});
        ui.type("new created text"); begin.resolve({id: "run"}); await pending; await settle();
        expect(ui.composer().value).toBe("new created text"); expect(ui.composer().attachments).toEqual([]);
        expect(io.execute.mock.calls[0][2].signal.aborted).toBe(false);
        ui.select(); expect(ui.composer().value).toBe("new home text"); expect(ui.composer().attachments).toEqual([]);
    });
    it("successful first begin clears unchanged destination and keeps home edit-then-revert", async () => {
        const {ui, created} = home(); const gate = deferred<ChatThread>(); io.create.mockReturnValue(gate.promise);
        const pending = ui.send(); await settle(); ui.type("different"); ui.type(" submitted ");
        gate.resolve(created); await pending; await settle();
        expect(ui.composer().value).toBe(""); expect(ui.composer().attachments).toEqual([]);
        ui.select(); expect(ui.composer().value).toBe(" submitted ");
        expect(io.begin).toHaveBeenCalledTimes(1); expect(io.execute).toHaveBeenCalledTimes(1);
    });
    it("failed begin retains submitted text and attachments visibly in the created thread for explicit retry", async () => {
        const {ui, created} = home(); io.create.mockResolvedValue(created); io.begin.mockRejectedValueOnce(new Error("begin failed"));
        await ui.send(); expect(ui.active()).toBe(created.id);
        expect(ui.composer().value).toBe(""); expect(ui.composer().attachments).toEqual([]);
        expect(ui.attempts()[0].submitted).toMatchObject({text: " submitted ", attachments: [{referenceId: "submitted-ref", revision: 1}]});
        expect(io.execute).not.toHaveBeenCalled(); expect(ui.composer().sending).toBe(false);
        // A topic created for the send keeps its echo (the text is not in the home composer), told once by the bubble.
        expect(ui.problem()).toMatchObject({kind: "unsent", reason: "消息未发送", action: {kind: "retry-send"}});
        expect(io.begin).toHaveBeenCalledTimes(1); io.begin.mockResolvedValueOnce({id: "retry-run"});
        await ui.action("retry"); expect(io.begin).toHaveBeenCalledTimes(2);
        expect(ui.composer().value).toBe(""); expect(ui.composer().attachments).toEqual([]);
        expect(io.create).toHaveBeenCalledTimes(1);
    });
    it("failed creation keeps origin contents and sends nothing", async () => {
        const {ui} = home(); io.create.mockRejectedValue(new Error("creation failed")); await ui.send();
        expect(ui.active()).toBeUndefined(); expect(ui.composer().value).toBe("");
        expect(ui.attempts()[0].submitted.text).toBe(" submitted ");
        expect(ui.composer().attachments).toEqual([]); expect(ui.attempts()[0].submitted.attachments).toHaveLength(1); expect(io.begin).not.toHaveBeenCalled();
        expect(io.execute).not.toHaveBeenCalled();
    });
    it("failed Web Lock acquisition retains the attempt in its created thread without dispatch", async () => {
        const {ui, created} = home(); io.create.mockResolvedValue(created);
        io.lock.mockRejectedValue(new Error("thread already running"));
        await ui.send();
        expect(ui.active()).toBe(created.id); expect(ui.composer().value).toBe("");
        expect(ui.attempts()[0].submitted.text).toBe(" submitted ");
        expect(ui.composer().attachments).toEqual([]);
        expect(ui.attempts()[0].submitted.attachments).toEqual([{referenceId: "submitted-ref", revision: 1}]);
        expect(ui.composer().sending).toBe(false); expect(io.navigate).toHaveBeenCalledTimes(1);
        expect(io.begin).not.toHaveBeenCalled(); expect(io.execute).not.toHaveBeenCalled();
        expect(retained.execution!.snapshot(created.id).error).toBeTruthy();
    });
    it("failed navigation retains the submitted attempt and original execution independently", async () => {
        const {ui, created} = home(); io.create.mockResolvedValue(created); io.navigate.mockRejectedValue(new Error("navigation failed"));
        await ui.send(); expect(ui.active()).toBeUndefined(); expect(ui.composer().value).toBe("");
        expect(ui.attempts()[0].submitted.text).toBe(" submitted ");
        expect(ui.composer().attachments).toEqual([]); expect(ui.attempts()[0].submitted.attachments).toHaveLength(1); expect(io.begin).toHaveBeenCalledTimes(1);
        ui.select(created.id); expect(ui.composer().value).toBe(""); expect(ui.composer().attachments).toEqual([]);
    });
    it("failed navigation keeps newer home edits and exposes preserved submitted payload in the created topic", async () => {
        const {ui, created} = home(); const gate = deferred<ChatThread>(); io.create.mockReturnValue(gate.promise);
        const pending = ui.send(); await settle(); ui.type("new home");
        io.navigate.mockRejectedValue(new Error("navigation failed")); gate.resolve(created); await pending; await settle();
        expect(ui.composer().value).toBe("new home"); expect(io.begin).toHaveBeenCalledTimes(1);
        expect(io.execute).toHaveBeenCalledTimes(1);
        ui.select(created.id); expect(ui.composer().value).toBe(""); expect(ui.composer().attachments).toEqual([]);
        expect(ui.attempts()[0].submitted).toMatchObject({text: " submitted ", attachments: [{referenceId: "submitted-ref", revision: 1}]});
    });
    it("deferred failed navigation cannot roll back over post-transfer home edits", async () => {
        const {ui, created} = home(); io.create.mockResolvedValue(created); const nav = deferred<void>();
        io.navigate.mockReturnValue(nav.promise); const pending = ui.send(); await settle(); ui.type("after transfer");
        nav.reject(new Error("navigation failed")); await pending; await settle();
        expect(ui.composer().value).toBe("after transfer"); ui.select(created.id);
        expect(ui.composer().value).toBe(""); expect(ui.composer().attachments).toEqual([]);
        expect(ui.attempts()[0].submitted).toMatchObject({text: " submitted ", attachments: [{referenceId: "submitted-ref", revision: 1}]});
    });
    it("failed navigation cannot restore after target edits then reverts to the submitted text", async () => {
        const {ui, created} = home(); io.create.mockResolvedValue(created); const nav = deferred<void>();
        io.navigate.mockImplementation(() => {ui.select(created.id); return nav.promise;});
        const pending = ui.send(); await settle(); ui.render();
        expect(ui.composer().value).toBe(""); ui.type("edited target"); ui.type(" submitted ");
        nav.reject(new Error("navigation failed")); await pending; await settle();
        expect(ui.composer().value).toBe(" submitted ");
        expect(ui.composer().attachments).toEqual([]);
        expect(ui.attempts()[0].submitted.attachments).toEqual([{referenceId: "submitted-ref", revision: 1}]);
        expect(io.begin).toHaveBeenCalledTimes(1); expect(io.execute).toHaveBeenCalledTimes(1);
        ui.select(); expect(ui.composer().value).toBe(""); expect(ui.composer().attachments).toEqual([]);
    });
    it("existing destination draft is never overwritten and origin stays intact", async () => {
        const {ui, created} = home(); ui.select(created.id); ui.type("existing target"); ui.attach("target-ref"); ui.select();
        io.create.mockResolvedValue(created); await ui.send();
        expect(io.navigate).not.toHaveBeenCalled(); expect(io.begin).not.toHaveBeenCalled();
        expect(ui.composer().value).toBe(" submitted "); expect(ui.composer().attachments).toEqual([{referenceId: "submitted-ref", revision: 1}]);
        expect(ui.attempts()).toEqual([]);
        ui.select(created.id); expect(ui.composer().value).toBe("existing target");
        expect(ui.composer().attachments).toEqual([{referenceId: "target-ref", revision: 1}]);
    });
    it("switching during creation retains old send without late route stealing", async () => {
        const {ui, created} = home(); const gate = deferred<ChatThread>(); io.create.mockReturnValue(gate.promise);
        const pending = ui.send(); await settle(); ui.select("B"); ui.type("other draft"); gate.resolve(created); await pending; await settle();
        expect(io.navigate).not.toHaveBeenCalled(); expect(io.begin).toHaveBeenCalledTimes(1);
        expect(io.execute.mock.calls[0][2].signal.aborted).toBe(false);
        expect(ui.composer().value).toBe("other draft"); ui.select();
        expect(ui.composer().value).toBe(""); expect(ui.composer().attachments).toEqual([]);
        expect(ui.attempts()[0].submitted).toMatchObject({text: " submitted ", attachments: [{referenceId: "submitted-ref", revision: 1}]});
    });
    it("late successful begin clears only its submitted owner and continues after route switch", async () => {
        const ui = page("B"); ui.type("same"); ui.attach("refB"); ui.select("A"); ui.type("same"); ui.attach("refA"); const gate = deferred<{id: string}>(); io.begin.mockReturnValue(gate.promise);
        const pending = ui.send(); await settle(); ui.select("B"); ui.type("same");
        gate.resolve({id: "run"}); await pending; await settle();
        expect(ui.composer().value).toBe("same"); expect(ui.composer().attachments).toEqual([{referenceId: "refB", revision: 1}]);
        expect(io.execute.mock.calls[0][2].signal.aborted).toBe(false);
        ui.select("A"); expect(ui.composer().value).toBe(""); expect(ui.composer().attachments).toEqual([]);
    });
    it("existing-thread payload is consumed immediately and next edits survive execution completion", async () => {
        const ui = page("A"); ui.type("submitted"); ui.attach("refA"); const gate = deferred<void>(); io.execute.mockReturnValue(gate.promise);
        const pending = ui.send(); await settle(); expect(ui.composer().value).toBe(""); expect(ui.composer().attachments).toEqual([]);
        expect(ui.composer().sending).toBe(true); ui.type("next draft"); gate.resolve(); await pending; await settle();
        expect(ui.composer().value).toBe("next draft"); expect(ui.composer().sending).toBe(false);
    });
    it("failed existing-thread begin returns the contents to the composer and the notice retries the frozen attempt", async () => {
        const ui = page("A"); ui.type("submitted"); ui.attach("refA"); io.begin.mockRejectedValueOnce(new Error("begin failed"));
        await ui.send(); await settle();
        // No echo or status in the stream: the text is back in the composer and one bubble tells the failure.
        expect(ui.composer().value).toBe("submitted"); expect(ui.composer().attachments).toEqual([{referenceId: "refA", revision: 1}]);
        expect(ui.attempts()).toEqual([]); expect(ui.owned()[0]).toMatchObject({phase: "failed", submitted: {text: "submitted"}});
        expect(ui.problem()).toMatchObject({kind: "unsent", reason: "消息未发送", action: {kind: "retry-send", label: "重试"}, dismissible: true});
        expect(io.execute).not.toHaveBeenCalled(); expect(io.begin).toHaveBeenCalledTimes(1);
        await ui.action("retry"); expect(io.begin).toHaveBeenCalledTimes(2);
        // Retry sends the original once; the returned copy must not remain to be sent again.
        expect(ui.composer().value).toBe(""); expect(ui.composer().attachments).toEqual([]);
        expect(io.execute).toHaveBeenCalledTimes(1);
    });
    it("sending the returned text again is the same retry: the original admission is read, no second message", async () => {
        const ui = page("A"); ui.type("again"); io.begin.mockRejectedValueOnce(new Error("reply lost")); await ui.send(); await settle();
        expect(ui.composer().value).toBe("again");
        io.reconcile.mockResolvedValueOnce({status: "accepted", run: {status: "running"}}); await ui.send();
        expect(io.reconcile).toHaveBeenCalled(); expect(io.begin).toHaveBeenCalledTimes(1); expect(io.execute).not.toHaveBeenCalled();
        expect(ui.owned()).toHaveLength(1); expect(ui.composer().value).toBe("");
    });
    it("closing the bubble releases the failed send and leaves its returned text alone; different text supersedes it", async () => {
        const ui = page("A"); ui.type("closing"); io.begin.mockRejectedValueOnce(new Error("rollback")); await ui.send(); await settle();
        ui.dismiss(); expect(ui.problem()).toBeUndefined(); expect(ui.owned()).toEqual([]); expect(ui.composer().value).toBe("closing");
        io.begin.mockRejectedValueOnce(new Error("rollback again")); await ui.send(); await settle();
        expect(ui.problem()).toMatchObject({kind: "unsent"}); ui.type("something else"); await ui.send();
        expect(ui.owned().map(attempt => attempt.submitted.text)).toEqual(["something else"]);
        expect(ui.problem()).toBeUndefined();
    });
    it("a project shortcut opens the home composer with that project selected", async () => {
        const ui = page("A"); ui.type("old unsent");
        (ui.surface().props.onNewTopicInProject as (id: string) => void)("p"); await settle();
        expect(io.create).not.toHaveBeenCalled();
        expect(io.navigate).toHaveBeenCalledWith({to: "/agent"});
        expect(ui.composer().projectId).toBe("p");
        expect(ui.composer().value).toBe("");
        ui.select("A"); expect(ui.composer().value).toBe("old unsent");
    });
    it("home project selection keeps independent text and attachments", async () => {
        const ui = page(); ui.composer().onProjectChange("p"); ui.type("project p"); ui.attach("p-ref");
        ui.composer().onProjectChange("q"); expect(ui.composer().value).toBe(""); ui.type("project q"); ui.attach("q-ref");
        ui.composer().onProjectChange("p"); expect(ui.composer().value).toBe("project p");
        expect(ui.composer().attachments).toEqual([{referenceId: "p-ref", revision: 1}]);
    });
    it("keeps the in-flight payload exact while the next draft stays editable during send", async () => {
        const ui = page("A"); ui.type("submitted"); ui.attach("refA"); const gate = deferred<{id: string}>(); io.begin.mockReturnValue(gate.promise);
        const pending = ui.send(); await settle(); const composer = ui.composer();
        composer.onAttachReference!({referenceId: "new", revision: 1}); composer.onRemoveReference!({referenceId: "refA", revision: 1});
        composer.onImportReferences!([new File(["x"], "x.txt")]); composer.onCancelReferenceImport!("old-job");
        composer.onRetryReferenceImport!({id: "job", file: new File([], "file.txt"), filename: "file.txt", status: "failed"});
        await ui.send(); ui.type("new text");
        // The submitted attempt keeps its frozen payload; what is attached while it is in flight belongs to the next draft.
        expect(ui.attempts()[0].submitted.attachments).toEqual([{referenceId: "refA", revision: 1}]);
        expect(ui.composer().attachments).toEqual([{referenceId: "new", revision: 1}]);
        // A second send never begins another run: it is held back (imports pending) or queued, never started.
        expect(io.begin).toHaveBeenCalledTimes(1);
        gate.resolve({id: "run"}); await pending; await settle(); expect(ui.composer().value).toBe("new text");
    });
    it("same-render text/reference edits are the exact submitted payload", async () => {
        const ui = page("A"); const composer = ui.composer();
        composer.onChange("immediate text"); composer.onAttachReference!({referenceId: "immediate-ref", revision: 2});
        composer.onSend(); await settle();
        expect(io.begin.mock.calls[0][0]).toMatchObject({content: "immediate text", attachments: [{referenceId: "immediate-ref", revision: 2}]});
        expect(ui.composer().value).toBe(""); expect(ui.composer().attachments).toEqual([]);
    });
    it("same-render import blocks the captured send callback until success", async () => {
        const ui = page("A"); const composer = ui.composer(); const gate = deferred<ProjectReference>(); io.importFile.mockReturnValue(gate.promise);
        composer.onChange("immediate text"); composer.onImportReferences!([new File(["x"], "file.txt")]); composer.onSend();
        await settle(); expect(io.begin).not.toHaveBeenCalled(); gate.resolve(reference("ref")); await settle();
        expect(ui.composer().value).toBe("immediate text"); expect(ui.composer().attachments).toHaveLength(1);
    });
    it("an existing destination edited back to empty still rejects transfer", async () => {
        const {ui, created} = home(); ui.select(created.id); ui.type("draft"); ui.type(""); ui.select();
        io.create.mockResolvedValue(created); await ui.send();
        expect(io.begin).not.toHaveBeenCalled(); expect(ui.composer().value).toBe(" submitted ");
        expect(ui.attempts()).toEqual([]);
        expect(ui.composer().attachments).toEqual([{referenceId: "submitted-ref", revision: 1}]);
    });
    it("execution failure after committed begin retains next edits and does not restore submitted draft", async () => {
        const {ui, created} = home(); io.create.mockResolvedValue(created); const gate = deferred<void>(); io.execute.mockReturnValue(gate.promise);
        const pending = ui.send(); await settle(); expect(ui.composer().value).toBe(""); ui.type("next");
        gate.reject(new Error("execution failed")); await pending; await settle();
        expect(ui.composer().value).toBe("next"); expect(ui.composer().attachments).toEqual([]);
        expect(retained.execution!.snapshot(created.id).error).toBeTruthy(); expect(io.begin).toHaveBeenCalledTimes(1);
    });
    it("preserves composer loading gate when routed ownership is pending", () => {
        const ui = page(); ui.pendingOwnership();
        expect(ui.render().some(node => node.type === "workspace" || node.type === "home")).toBe(false);
    });
});

describe("E03 owned execution feedback", () => {
    // Run status closes the message stream (turn footer). The fused composer strip is gone.
    const statusText = (ui: ReturnType<typeof page>) => {
        const status = ui.turnStatus();
        if (!status) return "";
        return nodes(status).flatMap(node =>
            typeof node.props.children === "string" ? [node.props.children] :
                Array.isArray(node.props.children) ? node.props.children.filter(child => typeof child === "string") : []).join(" ");
    };
    it("keeps model verification quiet whether it is pending or could not be confirmed", async () => {
        const gate = deferred<{ok: false; models: string[]}>(); io.discover.mockReturnValue(gate.promise);
        const ui = page("A", {...connector, definitionId: "apimart"});
        expect(ui.composer()).toMatchObject({probingModels: true, modelWarning: undefined});
        expect(ui.composer().modelPolicy.verified).toBe(false);
        gate.resolve({ok: false, models: []}); await settle();
        expect(ui.composer().probingModels).toBe(false);
        // Not being able to confirm compatibility is not actionable: the send re-checks, so no hint is shown.
        expect(ui.composer().modelWarning).toBeUndefined();
    });
    it("acknowledges Stop during held compatibility, excludes repeats and retains the lock until the check returns", async () => {
        const ui = page("A"); ui.type("submitted");
        const gate = deferred<{ok: false; aborted: true}>(); io.compatible.mockReturnValue(gate.promise);
        await ui.send();
        expect(statusText(ui)).not.toContain("正在准备");
        expect(ui.composer().modelWarning ?? "").not.toContain("正在确认");
        const stop = ui.composer().onStop;
        stop(); stop();
        expect(ui.composer()).toMatchObject({sending: true, stopping: true});
        expect(statusText(ui)).not.toContain("正在停止");
        expect(ui.composer()).not.toHaveProperty("status");
        ui.type("next draft"); await ui.send();
        expect(io.compatible).toHaveBeenCalledTimes(1); expect(ui.attempts()).toHaveLength(1);
        expect(io.compatible.mock.calls[0][3].signal.aborted).toBe(true);
        gate.resolve({ok: false, aborted: true}); await settle();
        expect(ui.composer()).toMatchObject({sending: false, stopping: false, value: "next draft"});
        expect(io.begin).not.toHaveBeenCalled(); expect(io.execute).not.toHaveBeenCalled();
        expect(ui.attempts()[0].phase).toBe("failed");
    });
    it("keeps Stop pending through an accepted in-flight begin and the original execution's final flush", async () => {
        const ui = page("A"); ui.type("submitted");
        const begin = deferred<{id: string; threadId: string; assistantMessageId: string}>();
        const flush = deferred<void>(); io.begin.mockReturnValue(begin.promise); io.execute.mockReturnValue(flush.promise);
        await ui.send(); const controllerBeforeStop = io.compatible.mock.calls[0][3].signal;
        const stop = ui.composer().onStop; stop(); stop();
        expect(ui.composer().stopping).toBe(true); expect(io.execute).not.toHaveBeenCalled();
        begin.resolve({id: "run", threadId: "A", assistantMessageId: "assistant"}); await settle();
        expect(ui.attempts()[0].phase).toBe("accepted");
        expect(io.execute).toHaveBeenCalledTimes(1);
        expect(io.execute.mock.calls[0][2].signal).toBe(controllerBeforeStop);
        expect(controllerBeforeStop.aborted).toBe(true);
        ui.type("next draft"); await ui.send();
        expect(ui.composer()).toMatchObject({sending: true, stopping: true, value: "next draft"});
        expect(io.begin).toHaveBeenCalledTimes(1);
        flush.resolve(); await settle();
        expect(ui.composer()).toMatchObject({sending: false, stopping: false, value: "next draft"});
    });
    it("shows model wait only after actual request invocation and stays quiet while output advances", async () => {
        const ui = page("A"); ui.type("submitted"); const flush = deferred<void>();
        io.begin.mockResolvedValue({id: "run", threadId: "A", assistantMessageId: "assistant"});
        io.execute.mockReturnValue(flush.promise); await ui.send();
        const observe = io.execute.mock.calls[0][7] as import("@/features/agent/runtime/executionFeedback").RuntimeExecutionFeedback;
        observe({type: "started", runId: "run", threadId: "A", assistantMessageId: "assistant", executionId: "exec"});
        observe({type: "requestInvoked", runId: "run", executionId: "exec"});
        expect(statusText(ui)).not.toContain("正在等待回复");
        observe({type: "publicReceived", runId: "run", executionId: "exec", kind: "content"});
        expect(statusText(ui)).not.toContain("正在等待回复");
        expect(statusText(ui)).not.toContain("正在接收回复");
        ui.composer().onStop();
        observe({type: "preparing", runId: "run", executionId: "exec"});
        expect(ui.composer().stopping).toBe(true);
        expect(statusText(ui)).not.toContain("正在停止");
        flush.resolve(); await settle();
    });
    it("keeps an ordinary reply quiet through final flush and a retained running query after release", async () => {
        const ui = page("A"); ui.type("submitted"); const flush = deferred<void>();
        const run = {id: "run", threadId: "A", assistantMessageId: "assistant", status: "running"};
        io.begin.mockResolvedValue(run); io.execute.mockReturnValue(flush.promise); await ui.send();
        ui.runs([run]);
        const observe = io.execute.mock.calls[0][7] as import("@/features/agent/runtime/executionFeedback").RuntimeExecutionFeedback;
        observe({type: "started", runId: "run", threadId: "A", assistantMessageId: "assistant", executionId: "exec"});
        expect(statusText(ui)).not.toContain("正在执行");
        observe({type: "requestInvoked", runId: "run", executionId: "exec"});
        expect(statusText(ui)).not.toContain("正在等待回复");
        observe({type: "publicReceived", runId: "run", executionId: "exec", kind: "content"});
        expect(statusText(ui)).not.toContain("正在执行");
        observe({type: "settled", runId: "run", executionId: "exec", sequence: 1, confirmed: true, status: "completed"});
        flush.resolve(); await settle();
        expect(ui.composer().sending).toBe(false);
        expect(statusText(ui)).not.toContain("正在执行");
        expect(statusText(ui)).not.toContain("正在等待回复");
    });
    it("retains the existing execution surface for actual tool work", async () => {
        const ui = page("A"); ui.type("submitted"); const flush = deferred<void>();
        const run = {id: "run", threadId: "A", assistantMessageId: "assistant", status: "running", hasToolCalls: true};
        io.begin.mockResolvedValue(run); io.execute.mockReturnValue(flush.promise); await ui.send();
        ui.runs([run]);
        const observe = io.execute.mock.calls[0][7] as import("@/features/agent/runtime/executionFeedback").RuntimeExecutionFeedback;
        observe({type: "started", runId: "run", threadId: "A", assistantMessageId: "assistant", executionId: "exec"});
        observe({type: "tool_round", runId: "run", executionId: "exec", confirmed: true, sequence: 1, step: 1});
        expect(statusText(ui)).not.toContain("正在执行");
        flush.resolve(); await settle();
    });
    it("effect replay and unmount detach only; exact Stop retains final flush ownership", async () => {
        const ui = page("A"); ui.type("retained"); const final = deferred<void>(); io.execute.mockReturnValue(final.promise);
        await ui.send(); const before = retained.execution!.snapshot("A");
        replay(ui.host); ui.render();
        expect(before.work!.controller.signal.aborted).toBe(false);
        unmount(ui.host);
        expect(before.work!.controller.signal.aborted).toBe(false);
        expect(retained.execution!.requestStop({threadId: "A", token: before.token!})).toBe(true);
        expect(retained.execution!.snapshot("A").active).toBe(true);
        final.resolve(); await settle(); expect(retained.execution!.snapshot("A").active).toBe(false);
        expect(ui.host.lateWrites).toBe(0);
    });
});

describe("E02 immediate submission recovery", () => {
    it("publishes exact payload and clears composer before preparation; same-tick duplicates stay one intent", async () => {
        const ui = page("A"); ui.type("  immediate  "); ui.attach("refA");
        const gate = deferred<{ok: false; message: string}>(); io.compatible.mockReturnValue(gate.promise);
        const composer = ui.composer(); composer.onSend(); composer.onSend();
        expect(ui.composer().value).toBe(""); expect(ui.composer().attachments).toEqual([]);
        expect(ui.attempts()).toHaveLength(1);
        expect(ui.attempts()[0]).toMatchObject({phase: "preparing", submitted: {text: "  immediate  ",
            attachments: [{referenceId: "refA", revision: 1}]}});
        expect(io.compatible).not.toHaveBeenCalled();
        ui.type("next draft"); await settle(); expect(io.compatible).toHaveBeenCalledTimes(1);
        gate.resolve({ok: false, message: "offline"}); await settle();
        expect(ui.attempts()[0]).toMatchObject({phase: "failed", error: "offline"});
        expect(ui.composer().value).toBe("next draft"); expect(io.begin).not.toHaveBeenCalled();
        expect(io.execute).not.toHaveBeenCalled();
    });
    it("returns exact failed text/references automatically, and only into the unchanged consumed composer", async () => {
        const ui = page("A"); ui.type("  recover me  "); ui.attach("exact-ref");
        io.begin.mockRejectedValueOnce(new Error("rollback")); await ui.send(); await settle();
        expect(ui.composer().value).toBe("  recover me  ");
        expect(ui.composer().attachments).toEqual([{referenceId: "exact-ref", revision: 1}]);
        // The frozen attempt stays for the admission-checked retry but is not echoed or described in the stream.
        expect(ui.attempts()).toEqual([]); expect(ui.owned()[0].phase).toBe("failed");
    });
    it("keeps the echo visible when text edits back to empty or any attachment mutation prevent the return", async () => {
        const ui = page("A"); ui.type("first"); const gate = deferred<{id: string}>(); io.begin.mockReturnValue(gate.promise);
        const pending = ui.send(); await settle(); ui.type("later"); ui.type("");
        gate.reject(new Error("rollback")); await pending; await settle();
        expect(ui.composer().value).toBe(""); expect(ui.attempts()[0].submitted.text).toBe("first");
        expect(ui.problem()).toMatchObject({kind: "unsent", action: {kind: "retry-send"}});
        const second = deferred<{id: string}>(); io.begin.mockReturnValue(second.promise);
        ui.type("second"); const next = ui.send(); await settle();
        // Attachment edits are locked through the UI during a send; mutate the draft owner directly.
        const draft = retained.drafts!.session(JSON.stringify(["A", "p"]), "p");
        draft.attach({referenceId: "later-ref", revision: 1}); draft.remove({referenceId: "later-ref", revision: 1});
        second.reject(new Error("rollback")); await next; await settle();
        expect(ui.composer().attachments).toEqual([]); expect(ui.composer().value).toBe(""); expect(ui.attempts()).toHaveLength(2);
    });
    it("retains an earlier failed candidate when a later turn is submitted", async () => {
        const ui = page("A"); ui.type("failed first"); const gate = deferred<{id: string}>(); io.begin.mockReturnValue(gate.promise);
        const pending = ui.send(); await settle(); ui.type("typed meanwhile"); gate.reject(new Error("rollback")); await pending; await settle();
        const first = ui.attempts()[0].admission.userMessageId; io.begin.mockResolvedValue({id: "run"});
        ui.type("next turn"); await ui.send();
        expect(ui.attempts()).toHaveLength(2); expect(ui.attempts()[0]).toMatchObject({phase: "failed", admission: {userMessageId: first}});
        expect(ui.attempts()[1].phase).toBe("accepted"); expect(io.execute).toHaveBeenCalledTimes(1);
    });
    it("unknown absent/read failure never permits retry, restore or automatic paid dispatch", async () => {
        const ui = page("A"); ui.type("uncertain"); io.begin.mockRejectedValueOnce(new UnknownCommitError("op", "workspace"));
        await ui.send(); expect(ui.attempts()[0].phase).toBe("uncertain");
        // Only checking or an explicit "not sent" exit is offered: no retry, no returned text, nothing to close.
        expect(ui.problem()).toMatchObject({reason: "发送未确认", action: {kind: "check"}, secondary: {kind: "confirm"}, dismissible: false});
        expect(ui.composer().value).toBe(""); expect(io.begin).toHaveBeenCalledTimes(1);
        io.reconcile.mockRejectedValueOnce(new Error("read unavailable")); await ui.action("check");
        expect(ui.attempts()[0].phase).toBe("uncertain"); expect(ui.composer().value).toBe("");
        io.reconcile.mockResolvedValueOnce({status: "absent"}); await ui.action("check");
        expect(ui.attempts()[0].phase).toBe("uncertain");
        io.reconcile.mockResolvedValueOnce({status: "accepted", run: {status: "running"}}); await ui.action("check");
        expect(ui.attempts()[0].phase).toBe("accepted"); expect(io.execute).not.toHaveBeenCalled();
        expect(io.begin).toHaveBeenCalledTimes(1);
    });
    it("real lost acknowledgement keeps explicit owned state recovery and starts no model request", async () => {
        const {db} = await import("@/platform/product/store");
        const {createProject} = await import("@/features/projects/commands/projects");
        const commands = await vi.importActual<typeof import("@/features/agent/commands/agentRuns")>("@/features/agent/commands/agentRuns");
        const chat = await vi.importActual<typeof import("@/features/agent/commands/chat")>("@/features/agent/commands/chat");
        const reads = await vi.importActual<typeof import("@/features/agent/queries/agentAdmission")>("@/features/agent/queries/agentAdmission");
        const ownership = await vi.importActual<typeof import("@/features/agent/runtime/runOwnership")>("@/features/agent/runtime/runOwnership");
        const project = await createProject("lost acknowledgement"); await db.projects.add({...project, id: "p"});
        await db.chatThreads.delete("A"); await chat.createChatThread({id: "A", projectId: "p", connectorId: connector.id, model: "model"});
        io.begin.mockImplementation(async input => {await commands.beginAgentRun(input); throw new UnknownCommitError("lost-reply", "test-workspace");});
        io.reconcile.mockImplementation(reads.readAgentAdmission);
        const ui = page("A"); ui.type("one committed turn"); await ui.send();
        await vi.waitFor(async () => {await settle(); expect(ui.attempts()[0].phase).toBe("accepted");});
        const admission = ui.attempts()[0].admission;
        expect(await db.agentRuns.count()).toBe(1); expect(await db.chatMessages.count()).toBe(2);
        expect(await db.agentRuns.get(admission.runId)).toMatchObject({userMessageId: admission.userMessageId, assistantMessageId: admission.assistantMessageId});
        expect((await db.chatMessages.get(admission.userMessageId))?.content).toBe("one committed turn");
        expect(ui.attempts()[0].recoveryRequired).toBe(true);
        (ui.surface().props.onSubmissionObserved as (id: string) => void)(admission.userMessageId);
        expect(ui.attempts()).toHaveLength(1);
        expect(ui.problem()).toMatchObject({kind: "interrupted", action: {kind: "recover"}, dismissible: false});
        expect(io.begin).toHaveBeenCalledTimes(1); expect(io.execute).not.toHaveBeenCalled();
        expect(ui.composer().value).toBe("");
        expect((await db.agentRuns.get(admission.runId))?.status).toBe("running");
        io.lock.mockImplementation((id, operation) => ownership.withThreadRunLock(id, operation, {
            request: (_name, _options, callback) => callback(null)
        }));
        await ui.action("recover");
        expect((await db.agentRuns.get(admission.runId))?.status).toBe("running");
        expect(ui.attempts()[0].recoveryRequired).toBe(true);
        expect(ui.attempts()[0].error).toContain("恢复失败");
        let recoveryDone: Promise<unknown> | undefined;
        io.lock.mockImplementation((id, operation) => {
            recoveryDone = ownership.withThreadRunLock(id, operation, {
                request: (_name, _options, callback) => callback({})
            });
            return recoveryDone;
        });
        await ui.action("recover");
        // This UI callback intentionally returns void. Await its actual owned
        // recovery, rather than assuming eight event-loop turns drain real IO.
        expect(recoveryDone).toBeDefined();
        await recoveryDone;
        await settle();
        expect((await db.agentRuns.get(admission.runId))?.status).toBe("interrupted");
        expect(ui.attempts()[0].recoveryRequired).toBe(false);
        expect(io.begin).toHaveBeenCalledTimes(1); expect(io.execute).not.toHaveBeenCalled();
        expect(await db.agentRuns.count()).toBe(1); expect(await db.chatMessages.count()).toBe(2);
        (ui.surface().props.onSubmissionObserved as (id: string) => void)(admission.userMessageId);
        expect(ui.attempts()).toHaveLength(0);
    });
    it("a positively reconciled explicit retry joins accepted records without dispatching", async () => {
        const ui = page("A"); ui.type("accepted before lost reply"); io.begin.mockRejectedValueOnce(new Error("reply lost")); await ui.send();
        io.reconcile.mockResolvedValueOnce({status: "accepted", run: {status: "running"}}); await ui.action("retry");
        expect(ui.attempts()[0].phase).toBe("accepted"); expect(io.begin).toHaveBeenCalledTimes(1);
        expect(io.execute).not.toHaveBeenCalled(); expect(ui.composer().value).toBe("");
    });
    it("the real pre-begin transaction refuses changed project ownership before updating settings", async () => {
        const ui = page("A"); ui.type("frozen project");
        const gate = deferred<void>(); io.lock.mockImplementation(async (_id, operation) => {await gate.promise; return operation();});
        const pending = ui.send(); await settle(); await db.chatThreads.update("A", {projectId: "foreign"});
        gate.resolve(); await pending; await settle();
        expect(io.update).not.toHaveBeenCalled(); expect(io.begin).not.toHaveBeenCalled(); expect(io.execute).not.toHaveBeenCalled();
        expect(ui.owned()[0].phase).toBe("failed"); expect((await db.chatThreads.get("A"))?.projectId).toBe("foreign");
    });
    it("Stop during deferred update never begins a new durable run and leaves recovery", async () => {
        const ui = page("A"); ui.type("stop before begin"); const gate = deferred<void>(); io.update.mockReturnValue(gate.promise);
        const pending = ui.send(); await settle(); ui.composer().onStop(); gate.resolve(); await pending; await settle();
        expect(io.begin).not.toHaveBeenCalled(); expect(io.execute).not.toHaveBeenCalled();
        expect(ui.owned()[0].phase).toBe("failed");
        expect(ui.problem()).toMatchObject({kind: "unsent", reason: "消息未发送", action: {kind: "retry-send"}});
        expect(ui.composer().value).toBe("stop before begin");
    });
    it("switching while explicit retry credentials resolve retains original authorized work", async () => {
        const ui = page("A"); ui.type("old"); io.begin.mockRejectedValueOnce(new Error("rollback")); await ui.send();
        const gate = deferred<ConnectorConfig>(); io.resolveConnector.mockReturnValue(gate.promise);
        const pending = ui.action("retry"); await settle(); ui.select("B"); ui.type("new owner");
        gate.resolve(connector); await pending; await settle(); expect(io.begin).toHaveBeenCalledTimes(2);
        expect(io.execute).toHaveBeenCalledTimes(1); expect(ui.composer().value).toBe("new owner");
        ui.select("A"); expect(ui.attempts()[0].submitted.text).toBe("old");
    });
});

describe("B07 actual reference import callbacks", () => {
    it("origin-bound success preserves text/edit revision and leaves other scope alone", async () => {
        const host = mount(); let scope = "A"; const render = () => {
            let value!: ReturnType<typeof useReferenceDraft>; draw(host, () => {value = useReferenceDraft(scope, "p"); return null;}); return value;
        };
        render().setText("first"); const snapshot = render().capture(); const gate = deferred<ProjectReference>(); io.importFile.mockReturnValue(gate.promise);
        const importing = render().importFiles([new File(["x"], "file.txt")]);
        const options = io.importFile.mock.calls[0][2]; options.onProgress({id: "ref"});
        render().setText("edited"); render().setText("first"); const editedRevision = render().textRevision;
        scope = "B"; render().setText("other"); gate.resolve(reference("ref")); await importing;
        expect(render().text).toBe("other"); expect(render().attachments).toEqual([]);
        scope = "A"; expect(render().text).toBe("first"); expect(render().textRevision).toBe(editedRevision);
        expect(render().attachments).toEqual([{referenceId: "ref", revision: 1}]); expect(render().imports).toEqual([]);
        render().acknowledge(snapshot); expect(render().text).toBe("first"); expect(render().attachments).toHaveLength(1);
    });
    it("page import failure retains origin file/reference/error for retry without replacing compose fields", async () => {
        const ui = page("A"); ui.type("origin"); const file = new File(["resource"], "resource.txt"); const gate = deferred<ProjectReference>();
        io.importFile.mockReturnValue(gate.promise); ui.composer().onImportReferences!([file]);
        io.importFile.mock.calls[0][2].onProgress({id: "allocated-reference"}); ui.type("edited origin"); ui.select("B"); ui.type("other");
        gate.reject(new Error("parse failed")); await settle();
        expect(ui.composer().referenceImports).toEqual([]); ui.select("A");
        expect(ui.composer().value).toBe("edited origin"); const job = ui.composer().referenceImports![0];
        expect(job).toMatchObject({file, referenceId: "allocated-reference", status: "failed", error: "parse failed"});
        const retry = deferred<ProjectReference>(); io.retryImport.mockReturnValue(retry.promise); ui.composer().onRetryReferenceImport!(job);
        expect(io.retryImport.mock.calls[0].slice(0, 2)).toEqual(["p", "allocated-reference"]);
        ui.type("after retry started"); retry.resolve(reference("allocated-reference")); await settle();
        expect(ui.composer().value).toBe("after retry started"); expect(ui.composer().referenceImports).toEqual([]);
        expect(ui.composer().attachments).toEqual([{referenceId: "allocated-reference", revision: 1}]);
    });
    it("explicit cancellation aborts import; unmount retains original import and scope", async () => {
        const ui = page("A"); ui.type("keep"); const first = deferred<ProjectReference>(); io.importFile.mockReturnValueOnce(first.promise);
        ui.composer().onImportReferences!([new File(["x"], "file.txt")]); const firstSignal = io.importFile.mock.calls[0][2].signal as AbortSignal;
        ui.composer().onCancelReferenceImport!(ui.composer().referenceImports![0].id); first.resolve(reference("cancelled")); await settle();
        expect(firstSignal.aborted).toBe(true); expect(ui.composer().attachments).toEqual([]); expect(ui.composer().value).toBe("keep");
        const second = deferred<ProjectReference>(); io.importFile.mockReturnValueOnce(second.promise);
        ui.composer().onImportReferences!([new File(["x"], "file.txt")]); const secondSignal = io.importFile.mock.calls[1][2].signal as AbortSignal;
        unmount(ui.host); expect(secondSignal.aborted).toBe(false); second.resolve(reference("late")); await settle();
        expect(ui.host.lateWrites).toBe(0);
        expect(retained.drafts!.snapshot(JSON.stringify(["A", "p"])).attachments).toEqual([{referenceId: "late", revision: 1}]);
    });
    it("active import blocks send until ready; async success preserves page text", async () => {
        const ui = page("A"); ui.type("original"); const gate = deferred<ProjectReference>(); io.importFile.mockReturnValue(gate.promise);
        ui.composer().onImportReferences!([new File(["x"], "file.txt")]); await ui.send(); expect(io.begin).not.toHaveBeenCalled();
        ui.type("changed"); gate.resolve(reference("ref")); await settle();
        expect(ui.composer().value).toBe("changed"); await ui.send();
        expect(io.begin.mock.calls[0][0]).toMatchObject({content: "changed", attachments: [{referenceId: "ref", revision: 1}]});
    });
});
