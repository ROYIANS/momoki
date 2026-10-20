// @vitest-environment jsdom
import {act, createElement as h, type ReactNode} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {db} from "@/platform/product/store";
import {TABLE_NAMES} from "@/platform/storage/schema";
import type {StoreObserver, StoreTx} from "@/platform/storage/types";
import type {AgentRun} from "@/features/agent/models/agent";
import type {ChatMessage, ChatThread} from "@/features/agent/models/chat";
import type {ComposerProps} from "@/features/agent/ui/composerTypes";
import {DEFAULT_CONTEXT_POLICY} from "@momoki/agent-core";

const router = vi.hoisted(() => ({navigate: vi.fn(), shouldBlock: (() => false) as () => boolean,
    status: "idle" as "idle" | "blocked", proceed: vi.fn(), reset: vi.fn()}));
vi.mock("@tanstack/react-router", () => ({
    useNavigate: () => router.navigate,
    useBlocker: (options: {shouldBlockFn: () => boolean}) => {router.shouldBlock = options.shouldBlockFn; return router;},
    Link: ({children}: {children?: ReactNode}) => h("a", null, children),
}));
vi.mock("@/ui/alert-dialog", async () => {
    const {createContext, useContext} = await import("react");
    const Close = createContext<((open: boolean) => void) | undefined>(undefined);
    const section = ({children}: {children?: ReactNode}) => h("div", null, children);
    return {
        AlertDialog: ({open, onOpenChange, children}: {open: boolean; onOpenChange?: (open: boolean) => void; children?: ReactNode}) =>
            h(Close, {value: onOpenChange}, open ? h("div", {"data-departure-confirmation": true}, children) : null),
        AlertDialogAction: ({onClick, children}: {onClick?: () => void; children?: ReactNode}) => h("button", {onClick}, children),
        AlertDialogCancel: ({children}: {children?: ReactNode}) => {
            const close = useContext(Close); return h("button", {onClick: () => close?.(false)}, children);
        },
        AlertDialogContent: section, AlertDialogDescription: section, AlertDialogFooter: section,
        AlertDialogHeader: section, AlertDialogTitle: section,
    };
});
vi.mock("@lobehub/ui", () => ({Button: "button", Empty: "div", Flexbox: ({children}: {children?: ReactNode}) => h("div", null, children)}));
vi.mock("@/app/layout/ModuleLayout", () => ({ModuleLayout: ({children}: {children?: ReactNode}) => h("div", null, children)}));
vi.mock("@/features/agent/ui/TopicSidebar", () => ({TopicSidebar: () => null}));
vi.mock("@/features/agent/ui/TaskBoard", () => ({TaskBoard: () => null}));
vi.mock("@/features/agent/ui/TaskInspector", () => ({TaskInspector: () => null}));
vi.mock("@/features/agent/ui/HomeWelcome", () => ({HomeWelcome: () => h("div", {"data-home": true})}));
vi.mock("@/features/agent/ui/ContextUsagePanel", () => ({ContextUsageTrigger: () => null}));
vi.mock("@/features/agent/ui/AgentComposerAttention", () => ({AgentComposerAttention: () => null}));
vi.mock("@/features/agent/ui/ChatWorkspace", async () => {
    const {useProductQueryState} = await import("@/platform/product/queries");
    const {readThreadTranscript} = await import("@/features/agent/queries/threadReading");
    const {prepareThreadActivityKey} = await import("@/features/agent/commands/threadActivity");
    return {ChatWorkspace: ({activeThreadId, composer, turnStatus}: {activeThreadId?: string; composer: ComposerProps; turnStatus?: unknown}) => {
        const identity = activeThreadId ? prepareThreadActivityKey(activeThreadId) : undefined;
        const state = useProductQueryState(tx => readThreadTranscript(identity, tx), [activeThreadId]);
        const reading = state.value?.threadId === activeThreadId ? state.value : undefined;
        return h("section", {"data-workspace": true,
            "data-message-state": !reading ? "loading" : reading.messages.length ? "loaded" : "empty",
            "data-run-state": !reading ? "loading" : reading.runs.map(run => run.id).join(","),
            "data-project-locked": String(composer.projectLocked), "data-retry": reading?.retryableRunId ?? ""},
            !reading ? "正在加载对话…" : reading.messages.map(message => h("p", {key: message.id}, message.content)), turnStatus as never, composer.status);
    }};
});
vi.mock("@/features/agent/runtime/runOwnership", () => ({recoverAbandonedRuns: vi.fn().mockResolvedValue(undefined), withThreadRunLock: vi.fn()}));
vi.mock("@/features/agent/runtime/taskWrapup", () => ({recoverTaskWrapups: vi.fn().mockResolvedValue(undefined)}));
vi.mock("@/features/audio/generation/batchRuntime", () => ({pauseAudioGenerationBatches: vi.fn()}));
vi.mock("@/features/settings/models/connectors", () => ({discoverConnectorChatModels: vi.fn().mockResolvedValue({ok: true, models: ["model"]}), runWithCompatibleChatModel: vi.fn()}));

import {AgentChatPage} from "@/features/agent/ui/AgentChatPage";

type Read = {query: (tx: StoreTx) => unknown | Promise<unknown>; observer: StoreObserver<unknown>; stopped: boolean};
let root: Root, container: HTMLDivElement;
let reads: Read[];
const timestamp = "2026-10-15T00:00:00.000Z";
const thread = (id: string): ChatThread => ({id, title: id, connectorId: "connector", model: "model", createdAt: timestamp, updatedAt: timestamp});
function run(threadId: string, status: AgentRun["status"] = "running", hasToolCalls = false): AgentRun {
    return {id: `run-${threadId}`, threadId, userMessageId: `user-${threadId}`, assistantMessageId: `assistant-${threadId}`,
        agentId: "agent", agentSnapshot: {name: "Agent", instructions: ""}, connector: {id: "connector", definitionId: "openai-compatible", baseUrl: "https://unused.invalid"},
        model: "model", requestMessages: [], status, hasToolCalls, checkpoint: 0, createdAt: timestamp, updatedAt: timestamp};
}
async function query(read: Read) {return db.transaction("r", TABLE_NAMES, read.query);}
async function publish(read: Read, value?: unknown) {
    const result = value === undefined ? await query(read) : value;
    await act(async () => read.observer.next(result)); return result;
}
async function draw(threadId: string | undefined) {await act(async () => root.render(h(AgentChatPage, {threadId})));}
const workspace = () => container.querySelector("[data-workspace]")!;
beforeEach(async () => {
    router.status = "idle"; vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class {observe() {} disconnect() {}});
    await db.chatThreads.bulkAdd([thread("A"), thread("B")]);
    await db.connectors.add({id: "connector", definitionId: "openai-compatible", protocol: "openai-compatible", baseUrl: "https://unused.invalid", apiKey: "fixture", updatedAt: timestamp});
    reads = [];
    // Execute queries in real readonly snapshots, but hold delivery outside the transaction.
    vi.spyOn(db, "observe").mockImplementation((querier, observer) => {
        const read: Read = {query: querier, observer: observer as StoreObserver<unknown>, stopped: false}; reads.push(read);
        return () => {read.stopped = true;};
    });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe("actual Agent query observation ownership", () => {
    async function addedThreadReads(start: number) {
        const candidates = await Promise.all(reads.slice(start).map(async read => ({read, value: await query(read) as Record<string, unknown>})));
        return {routed: candidates.find(item => "forId" in item.value)!.read,
            control: candidates.find(item => "ready" in item.value)!.read,
            transcript: candidates.find(item => "messages" in item.value)!.read};
    }
    async function mountA() {
        await draw("A"); expect(reads).toHaveLength(7);
        for (const read of [...reads]) await publish(read);
        expect(reads).toHaveLength(8); await publish(reads[7]);
        expect(workspace()).toBeTruthy(); return [...reads];
    }
    it("keeps empty A distinct from pending B and ignores retired A transcript/control delivery", async () => {
        const initial = await mountA(); expect(workspace().getAttribute("data-message-state")).toBe("empty");
        const emptyA = await query(initial[7]);
        await draw("B"); expect(reads).toHaveLength(11);
        const {routed: routedB, control: controlB, transcript: transcriptB} = await addedThreadReads(8);
        await publish(routedB);
        expect(workspace().getAttribute("data-message-state")).toBe("loading");
        expect(workspace().getAttribute("data-project-locked")).toBe("false");
        expect(initial.slice(5).every(read => read.stopped)).toBe(true);
        await publish(initial[7], emptyA); await publish(initial[6]);
        expect(workspace().getAttribute("data-message-state")).toBe("loading");
        const observed = await publish(transcriptB) as {threadId: string; messages: ChatMessage[]};
        expect(observed.threadId).toBe("B"); expect(observed.messages).toEqual([]);
        expect(workspace().getAttribute("data-message-state")).toBe("empty");
        await publish(controlB); expect(router.shouldBlock()).toBe(false);
    });
    it("never lends A transcript, run, compaction or blocker to B", async () => {
        await db.chatMessages.add({id: "user-A", threadId: "A", role: "user", content: "A private text", status: "complete", createdAt: timestamp});
        await db.agentRuns.add(run("A"));
        await db.contextCompactions.add({id: "compaction-A", threadId: "A", runId: "run-A", status: "running",
            coverage: [], input: [], policy: DEFAULT_CONTEXT_POLICY, connector: run("A").connector, model: "model",
            content: "", beforeTokens: 1, createdAt: timestamp, updatedAt: timestamp});
        const initial = await mountA();
        expect(container.textContent).toContain("A private text"); expect(container.textContent).not.toContain("正在整理较早的对话");
        const old = await query(initial[7]); await draw("B");
        const {routed, control, transcript} = await addedThreadReads(8); await publish(routed);
        expect(container.textContent).not.toContain("A private text"); expect(container.textContent).not.toContain("正在执行");
        await publish(initial[7], old); await publish(initial[6]);
        expect(workspace().getAttribute("data-message-state")).toBe("loading");
        await db.agentRuns.add(run("B", "waiting_approval")); await publish(control); await publish(transcript);
        expect(workspace().getAttribute("data-run-state")).toBe("run-B");
        expect(container.textContent).not.toContain("正在整理较早的对话"); expect(router.shouldBlock()).toBe(false);
        await db.agentRuns.update("run-B", {status: "running"}); await publish(control);
        expect(container.textContent).not.toContain("正在执行"); expect(container.textContent).not.toContain("正在整理较早的对话");
    });
    it("keeps home identity explicit and filters every source by the requested topic in the same snapshot", async () => {
        await db.chatMessages.bulkAdd([{id: "msgA", threadId: "A", role: "user", content: "owned", createdAt: timestamp},
            {id: "msgB", threadId: "B", role: "user", content: "foreign", createdAt: timestamp}]);
        await db.agentRuns.add(run("B"));
        const initial = await mountA();
        const value = await query(initial[7]) as {threadId: string; messages: ChatMessage[]; runs: AgentRun[]};
        expect(value.threadId).toBe("A"); expect(value.messages.map(row => row.id)).toEqual(["msgA"]); expect(value.runs).toEqual([]);
        await draw(undefined);
        const home = await Promise.all(reads.slice(8).map(query));
        const control = home.find(value => !!value && typeof value === "object" && "ready" in value);
        expect(control).toMatchObject({hasMessages: false, runs: []});
        expect(control && "threadId" in control ? control.threadId : undefined).toBeUndefined();
    });
});

it("running and parked saved runs do not install an execution-only departure blocker", async () => {
    await db.agentRuns.add(run("A", "waiting_approval", true));
    await draw("A"); for (const read of [...reads]) await publish(read);
    expect(router.shouldBlock()).toBe(false); expect(container.querySelector("[data-departure-confirmation]")).toBeNull();
    await db.agentRuns.update("run-A", {status: "running"}); await publish(reads[6]); expect(router.shouldBlock()).toBe(false);
});
