// @vitest-environment jsdom
import {act, createElement as h, type ReactNode, useRef} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {db} from "@/platform/product/store";
import {createProject} from "@/features/projects/commands/projects";
import {addShot} from "@/features/video/commands/shots";
import {addCharacter} from "@/features/library/commands/assets";
import {STUDIO_LIBRARY_ID} from "@/features/library/models/ownership";
import {createChatThread} from "@/features/agent/commands/chat";
import {beginAgentRun} from "@/features/agent/commands/agentRuns";
import {transitionToolCall} from "@/features/agent/commands/agentTools";
import * as batches from "@/features/agent/commands/agentGenerationBatches";
import * as runtime from "@/features/video/agent/generationBatchRuntime";
import type {GenerationSubmitArgs} from "@/features/video/agent/generationProfiles";
import type {ConnectorConfig} from "@/features/settings/models/connector";
import {AgentGenerationBatches} from "@/features/agent/ui/AgentGenerationBatches";
import {BusinessDetailsProvider, useBusinessDetails, type DetailReturnOrigin} from "@/app/details/BusinessDetails";
import * as businessDetails from "@/app/details/BusinessDetails";
import {ContextPanelHostProvider} from "@/app/layout/ContextPanelHost";
import {AgentActivityNavigationProvider, useAgentActivityNavigation} from "@/features/agent/ui/AgentActivityNavigation";
import {saveFixtureToolRound} from "./helpers/toolDispatch";

const navigation = vi.hoisted(() => ({anchors: vi.fn(), blockers: new Map<object, {shouldBlockFn: () => boolean}>()}));
vi.mock("@tanstack/react-router", () => ({
    Link: ({to, params, search, children, onClick, ...props}: {
        to: string;
        params?: Record<string, string>;
        search?: Record<string, string>;
        children?: ReactNode;
        onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
    }) => {
        let href = to.replace(/\$([A-Za-z]+)/g, (_match, key: string) => encodeURIComponent(params?.[key] ?? ""));
        if (search) href += `?${new URLSearchParams(search)}`;
        return h("a", {...props, href, onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
            onClick?.(event);
            if (!event.defaultPrevented) navigation.anchors(href);
            event.preventDefault();
        }}, children);
    },
    useBlocker: (options: {shouldBlockFn: () => boolean}) => {
        const owner = useRef({}).current;
        navigation.blockers.set(owner, options);
        return {status: "idle", proceed: vi.fn(), reset: vi.fn()};
    },
}));

let root: Root, container: HTMLDivElement, portal: HTMLDivElement;
let fixture: Awaited<ReturnType<typeof seedBatch>>;
async function seedBatch(assetOwner?: "project" | "studio") {
    const connector: ConnectorConfig = {id: "e16-batch-connector", name: "Generation", definitionId: "apimart", baseUrl: "https://apimart.test/v1", apiKey: "local-test-key", updatedAt: "now"};
    await db.connectors.put(connector);
    const project = await createProject("批次详情测试");
    const episode = (await db.episodes.where("projectId").equals(project.id).first())!;
    const shots = await Promise.all([addShot(project.id, episode.id), addShot(project.id, episode.id)]);
    const thread = await createChatThread();
    const run = await beginAgentRun({threadId: thread.id, connector, model: "chat", content: "准备候选"});
    const asset = assetOwner ? await addCharacter(assetOwner === "studio" ? STUDIO_LIBRARY_ID : project.id) : undefined;
    const candidates: GenerationSubmitArgs[] = asset
        ? [{connectorId: connector.id, model: "gpt-image-2", prompt: "原始画面描述", parameters: {}, inputs: [], target: {kind: "character", projectId: asset.projectId, entityId: asset.id, slot: "front"}}]
        : shots.map(shot => ({connectorId: connector.id, model: "gpt-image-2", prompt: "原始画面描述", parameters: {}, inputs: [], target: {kind: "shot", projectId: project.id, episodeId: episode.id, entityId: shot.id, slot: "firstFrame"}}));
    await saveFixtureToolRound(run.id, "", [{id: "e16-batch-source", type: "function", function: {name: "prepare_generation_batch", arguments: JSON.stringify({title: "候选批次", candidates})}}], [{title: "准备批量生成", effect: "bookkeeping", highRisk: false, atomic: true}]);
    const call = (await db.agentToolCalls.where("runId").equals(run.id).first())!;
    await transitionToolCall(run.id, call.id, ["pending"], "running");
    const result = await batches.prepareGenerationBatch("候选批次", candidates, {runId: run.id, threadId: thread.id, callId: call.id, signal: new AbortController().signal}) as {batchId: string};
    return {project, episode, shots, asset, thread, run, id: result.batchId};
}
async function settle(check: () => void) {await vi.waitFor(async () => {await act(async () => {}); check();});}
async function click(node: HTMLElement) {await act(async () => node.click());}
function button(label: string) {
    const control = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label || node.getAttribute("aria-label") === label);
    expect(control, label).toBeTruthy();
    return control!;
}
async function showReview() {
    await settle(() => expect(document.querySelector(".agent-batch-open")).not.toBeNull());
    await click(document.querySelector<HTMLElement>(".agent-batch-open")!);
    await settle(() => expect(document.querySelectorAll(".agent-batch-draft-row")).toHaveLength(2));
    await click(document.querySelector<HTMLElement>(".agent-batch-config-toggle")!);
    await settle(() => expect(document.querySelector(".agent-batch-fields textarea")).not.toBeNull());
}
async function editPrompt(value: string) {
    const input = document.querySelector<HTMLTextAreaElement>(".agent-batch-fields textarea")!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", {bubbles: true}));
    });
    return input;
}
function Controls() {
    const api = useBusinessDetails();
    const activity = useAgentActivityNavigation();
    return h("div", null,
        h("button", {onClick: () => void api?.open({kind: "shot", target: {projectId: fixture.project.id, episodeId: fixture.episode.id, shotId: fixture.shots[1].id}})}, "Inspect other shot"),
        h("button", {onClick: () => activity.reveal({runId: fixture.run.id, batchId: fixture.id})}, "Reveal source review"));
}
function Fixture({width = 1440}: {width?: number}) {
    return h(ContextPanelHostProvider, {target: portal, surfaceWidth: width, navigationWidth: 260},
        h(BusinessDetailsProvider, null,
            h(AgentActivityNavigationProvider, {threadId: fixture.thread.id},
                h(Controls), h(AgentGenerationBatches, {runId: fixture.run.id}))));
}
function targetLink() {return document.querySelector<HTMLAnchorElement>(".agent-batch-target")!;}
function noExecution() {
    expect(batches.confirmGenerationBatch).not.toHaveBeenCalled();
    expect(runtime.startGenerationBatch).not.toHaveBeenCalled();
    expect(navigation.anchors).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
}
beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class {observe() {} unobserve() {} disconnect() {}});
    vi.stubGlobal("matchMedia", () => ({matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}}));
    navigation.anchors.mockClear(); navigation.blockers.clear();
    container = document.createElement("div"); container.className = "agent-chat-root";
    portal = document.createElement("div"); document.body.append(container, portal); root = createRoot(container);
    fixture = await seedBatch();
    vi.spyOn(batches, "confirmGenerationBatch"); vi.spyOn(runtime, "startGenerationBatch");
    vi.spyOn(globalThis, "fetch");
    await act(async () => root.render(h(Fixture)));
});
afterEach(async () => {
    await act(async () => root.unmount());
    await act(async () => {await new Promise(resolve => setTimeout(resolve, 5));});
    container.remove(); portal.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("actual batch review target handoff", () => {
    it("keeps ordinary dirty close protection without approving or starting work", async () => {
        await showReview();
        await editPrompt("保留本地画面描述");
        // The review is a panel: its own close goes through the same departure guard as any panel.
        await click(document.querySelector<HTMLElement>('button[aria-label="关闭"]')!);
        expect(document.querySelector(".agent-batch-dialog")).not.toBeNull();
        expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("保留本地画面描述");
        expect([...navigation.blockers.values()].some(owner => owner.shouldBlockFn())).toBe(true);
        expect(batches.confirmGenerationBatch).not.toHaveBeenCalled();
        expect(runtime.startGenerationBatch).not.toHaveBeenCalled();
    });
    it.each([1440, 760])("hands over to the detail panel and restores the exact review at surface width %i", async width => {
        await act(async () => root.render(h(Fixture, {width})));
        await showReview();
        const prompt = await editPrompt("保留本地画面描述");
        const include = document.querySelector<HTMLInputElement>(".agent-batch-include input")!;
        await click(include);
        const body = document.querySelector<HTMLElement>(".agent-batch-body")!;
        body.scrollTop = 273; prompt.focus(); prompt.setSelectionRange(2, 5, "backward");
        await click(targetLink());
        await settle(() => expect(portal.querySelector("[data-shot-editor]")).not.toBeNull());
        expect(document.querySelector(".agent-batch-dialog")).toBeNull();
        expect(document.querySelector(".agent-batch-overlay")).toBeNull();
        expect(document.body.style.pointerEvents).not.toBe("none");
        const detailInput = portal.querySelector<HTMLInputElement>('[aria-label="时长（秒）"]')!;
        detailInput.focus();
        expect(document.activeElement).toBe(detailInput);
        expect(detailInput.closest('[aria-hidden="true"], [inert]')).toBeNull();
        expect([...navigation.blockers.values()].some(owner => owner.shouldBlockFn())).toBe(true);
        noExecution();
        expect((await batches.readGenerationBatch(fixture.id, fixture.thread.id)).items[0].draft.prompt).toBe("原始画面描述");
        await click(button("返回批量审阅"));
        await settle(() => expect(document.querySelector(".agent-batch-dialog")).not.toBeNull());
        const restored = document.querySelector<HTMLTextAreaElement>(".agent-batch-fields textarea")!;
        expect(restored).not.toBe(prompt);
        expect(restored.value).toBe("保留本地画面描述");
        expect(document.querySelector<HTMLInputElement>(".agent-batch-include input")?.checked).toBe(false);
        expect(document.querySelector(".agent-batch-config-toggle")?.getAttribute("aria-expanded")).toBe("true");
        expect(document.querySelector<HTMLElement>(".agent-batch-body")?.scrollTop).toBe(273);
        await settle(() => expect(document.activeElement).toBe(restored));
        expect(restored.selectionStart).toBe(2); expect(restored.selectionEnd).toBe(5); expect(restored.selectionDirection).toBe("backward");
        noExecution();
    });
    it("preserves modified target activation as real-anchor navigation", async () => {
        await showReview();
        await act(async () => targetLink().dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, metaKey: true, button: 0})));
        expect(navigation.anchors).toHaveBeenCalledOnce();
        expect(document.querySelector(".agent-batch-dialog")).not.toBeNull();
        expect(portal.querySelector("[data-shot-detail]")).toBeNull();
        expect(batches.confirmGenerationBatch).not.toHaveBeenCalled();
        expect(runtime.startGenerationBatch).not.toHaveBeenCalled();
    });
    it("does not intercept a canonical href that disagrees with its typed production target", async () => {
        await showReview();
        const link = targetLink();
        const href = new URL(link.getAttribute("href")!, "https://cuepoint.test");
        href.searchParams.set("shot", fixture.shots[1].id);
        link.setAttribute("href", `${href.pathname}${href.search}`);
        await click(link);
        expect(navigation.anchors).toHaveBeenCalledOnce();
        expect(document.querySelector(".agent-batch-dialog")).not.toBeNull();
        expect(portal.querySelector("[data-shot-detail]")).toBeNull();
        expect(batches.confirmGenerationBatch).not.toHaveBeenCalled();
        expect(runtime.startGenerationBatch).not.toHaveBeenCalled();
    });
    it.each(["project", "studio"] as const)("hands an exact %s asset target to its actual Library editor", async owner => {
        fixture = await seedBatch(owner);
        await act(async () => root.render(h(Fixture)));
        await settle(() => expect(document.querySelector(".agent-batch-open")).not.toBeNull());
        await click(document.querySelector<HTMLElement>(".agent-batch-open")!);
        await settle(() => expect(document.querySelectorAll(".agent-batch-draft-row")).toHaveLength(1));
        await click(document.querySelector<HTMLElement>(".agent-batch-config-toggle")!);
        await settle(() => expect(targetLink()).not.toBeNull());
        expect(targetLink().getAttribute("href")).toContain(owner === "studio" ? "/characters/" : `/p/${fixture.project.id}/assets/characters/`);
        await click(targetLink());
        await settle(() => expect(portal.querySelector("[data-asset-editor]")?.getAttribute("data-asset-editor")).toBe(fixture.asset!.id));
        expect(document.querySelector(".agent-batch-dialog")).toBeNull();
        await click(button("返回批量审阅"));
        await settle(() => expect(document.querySelector(".agent-batch-dialog")).not.toBeNull());
        noExecution();
    });
    it("never replaces a detail that holds unsaved input: the review stays closed and the draft stays put", async () => {
        await click(button("Inspect other shot"));
        await settle(() => expect(portal.querySelector("[data-shot-editor]")?.getAttribute("data-shot-editor")).toBe(fixture.shots[1].id));
        const duration = portal.querySelector<HTMLInputElement>('[aria-label="时长（秒）"]')!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(duration, "invalid");
            duration.dispatchEvent(new Event("input", {bubbles: true}));
        });
        await settle(() => expect(document.querySelector(".agent-batch-open")).not.toBeNull());
        await click(document.querySelector<HTMLElement>(".agent-batch-open")!);
        // The open detail's own guard decides; the review does not push it away.
        await settle(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
        expect(document.querySelector(".agent-batch-dialog")).toBeNull();
        await click(button("继续编辑"));
        await settle(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
        expect(document.querySelector(".agent-batch-dialog")).toBeNull();
        expect(portal.querySelector('[aria-label="时长（秒）"]')).toBe(duration);
        expect(duration.value).toBe("invalid");
        noExecution();
    });
    it("retires a replaced origin without reopening it over the new detail", async () => {
        await showReview(); await editPrompt("仍是原来的审阅"); await click(targetLink());
        await settle(() => expect(portal.querySelector("[data-shot-editor]")?.getAttribute("data-shot-editor")).toBe(fixture.shots[0].id));
        await click(button("Inspect other shot"));
        await settle(() => expect(portal.querySelector("[data-shot-editor]")?.getAttribute("data-shot-editor")).toBe(fixture.shots[1].id));
        expect(document.querySelector(".agent-batch-dialog")).toBeNull();
        expect([...document.querySelectorAll("button")].some(node => node.textContent === "返回批量审阅")).toBe(false);
        // The retained dirty draft is announced, not silently hidden.
        expect(document.querySelector(".agent-batch-error[role=status]")?.textContent).toContain("未保存的编辑仍保留");
        await click(document.querySelector<HTMLElement>(".agent-batch-open")!);
        expect(document.querySelector(".agent-batch-error[role=status]")).toBeNull();
        await settle(() => expect(document.querySelector(".agent-batch-dialog")).not.toBeNull());
        expect(document.querySelector<HTMLTextAreaElement>(".agent-batch-fields textarea")?.value).toBe("仍是原来的审阅");
        noExecution();
    });
    it.each(["acknowledged", "rejected"] as const)("retains a pending save and its %s outcome while viewing detail", async outcome => {
        const original = batches.saveGenerationBatchDraft;
        let release!: () => void, reject!: (cause: Error) => void;
        const gate = new Promise<void>((resolve, fail) => {release = resolve; reject = fail;});
        const save = vi.spyOn(batches, "saveGenerationBatchDraft").mockImplementation(async (...args) => {await gate; return original(...args);});
        await showReview(); await editPrompt("冻结在原批次的保存");
        await click(button("保存草稿"));
        await settle(() => expect(save).toHaveBeenCalledOnce());
        expect(save.mock.calls[0].slice(0, 3)).toEqual([fixture.id, fixture.thread.id, 1]);
        await click(targetLink());
        await settle(() => expect(portal.querySelector("[data-shot-editor]")).not.toBeNull());
        expect(document.querySelector(".agent-batch-dialog")).toBeNull();
        await act(async () => {
            if (outcome === "acknowledged") release(); else reject(new Error("保存暂时失败"));
            await save.mock.results[0].value.catch(() => undefined);
        });
        await click(button("返回批量审阅"));
        await settle(() => expect(document.querySelector(".agent-batch-dialog")).not.toBeNull());
        expect(document.querySelector<HTMLTextAreaElement>(".agent-batch-fields textarea")?.value).toBe("冻结在原批次的保存");
        if (outcome === "acknowledged") {
            await settle(() => expect(document.querySelector(".agent-batch-dialog")?.textContent).toContain("草稿已保存"));
            expect((await batches.readGenerationBatch(fixture.id, fixture.thread.id)).batch.revision).toBe(2);
            expect((await batches.readGenerationBatch(fixture.id, fixture.thread.id)).items[0].draft.prompt).toBe("冻结在原批次的保存");
        } else {
            await settle(() => expect(document.querySelector(".agent-batch-dialog")?.textContent).toContain("保存暂时失败"));
            expect(button("保存草稿").disabled).toBe(false);
            expect((await batches.readGenerationBatch(fixture.id, fixture.thread.id)).batch.revision).toBe(1);
        }
        expect(save).toHaveBeenCalledOnce(); noExecution();
    });
    it("uses the same guarded origin when activity navigation reveals an away review", async () => {
        await showReview(); await editPrompt("通过原来源返回"); await click(targetLink());
        await settle(() => expect(portal.querySelector("[data-shot-editor]")).not.toBeNull());
        const duration = portal.querySelector<HTMLInputElement>('[aria-label="时长（秒）"]')!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(duration, "invalid");
            duration.dispatchEvent(new Event("input", {bubbles: true}));
        });
        await click(button("Reveal source review"));
        await settle(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
        expect(document.querySelector(".agent-batch-dialog")).toBeNull();
        await click(button("继续编辑"));
        expect(document.querySelector(".agent-batch-dialog")).toBeNull();
        expect(portal.querySelector('[aria-label="时长（秒）"]')).toBe(duration);
        await click(button("Reveal source review"));
        await settle(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
        await click(button("放弃并离开"));
        await settle(() => expect(document.querySelector(".agent-batch-dialog")).not.toBeNull());
        expect(document.querySelector<HTMLTextAreaElement>(".agent-batch-fields textarea")?.value).toBe("通过原来源返回");
        expect(portal.querySelector("[data-shot-editor]")).toBeNull();
        noExecution();
    });
    it("keeps the selected comparison group and its bookmark through the second target entry", async () => {
        await act(async () => {await batches.confirmGenerationBatch(fixture.id, fixture.thread.id, 1, new AbortController().signal);});
        vi.mocked(batches.confirmGenerationBatch).mockClear();
        await settle(() => expect(document.querySelector(".agent-batch-open")).not.toBeNull());
        await click(document.querySelector<HTMLElement>(".agent-batch-open")!);
        await settle(() => expect(document.querySelectorAll(".agent-batch-targets button")).toHaveLength(2));
        const groups = document.querySelectorAll<HTMLButtonElement>(".agent-batch-targets button");
        await click(groups[1]); groups[1].focus();
        document.querySelector<HTMLElement>(".agent-batch-body")!.scrollTop = 144;
        await click(document.querySelector<HTMLElement>(".agent-batch-comparison-heading a")!);
        await settle(() => expect(portal.querySelector("[data-shot-editor]")?.getAttribute("data-shot-editor")).toBe(fixture.shots[1].id));
        await click(button("返回批量审阅"));
        await settle(() => expect(document.querySelector(".agent-batch-dialog")).not.toBeNull());
        const restoredGroups = document.querySelectorAll<HTMLButtonElement>(".agent-batch-targets button");
        expect(restoredGroups[1].getAttribute("aria-pressed")).toBe("true");
        expect(document.querySelector<HTMLElement>(".agent-batch-body")?.scrollTop).toBe(144);
        await settle(() => expect(document.activeElement).toBe(restoredGroups[1]));
        noExecution();
    });
    it("ignores a retired origin notification after a later handoff owns the source", async () => {
        const origins: Array<{origin: DetailReturnOrigin; requestId?: string}> = [];
        const originalHook = businessDetails.useBusinessDetails;
        vi.spyOn(businessDetails, "useBusinessDetails").mockImplementation(() => {
            const api = originalHook();
            return api ? {...api, open: (target, options) => {
                const captured = options?.origin ? {origin: options.origin, requestId: undefined as string | undefined} : undefined;
                if (captured) origins.push(captured);
                return api.open(target, options).then(result => {if (captured) captured.requestId = result.requestId; return result;});
            }} : null;
        });
        await act(async () => root.render(h(Fixture)));
        await showReview(); await editPrompt("第二次让位仍保留"); await click(targetLink());
        await settle(() => expect(portal.querySelector("[data-shot-editor]")?.getAttribute("data-shot-editor")).toBe(fixture.shots[0].id));
        await click(button("Inspect other shot"));
        await settle(() => expect(portal.querySelector("[data-shot-editor]")?.getAttribute("data-shot-editor")).toBe(fixture.shots[1].id));
        await click(document.querySelector<HTMLElement>(".agent-batch-open")!);
        await settle(() => expect(document.querySelector(".agent-batch-dialog")).not.toBeNull());
        await click(targetLink());
        await settle(() => expect(origins).toHaveLength(2));
        await settle(() => expect(portal.querySelector("[data-shot-editor]")?.getAttribute("data-shot-editor")).toBe(fixture.shots[0].id));
        expect(origins[0].origin.token).not.toBe(origins[1].origin.token);
        await act(async () => origins[0].origin.onEnd({token: origins[0].origin.token, requestId: origins[0].requestId!, reason: "close"}));
        expect(document.querySelector(".agent-batch-dialog")).toBeNull();
        await click(button("返回批量审阅"));
        await settle(() => expect(document.querySelector(".agent-batch-dialog")).not.toBeNull());
        expect(document.querySelector<HTMLTextAreaElement>(".agent-batch-fields textarea")?.value).toBe("第二次让位仍保留");
        noExecution();
    });

    it("opens a draft that needs confirming by itself, beside the content and without taking focus", async () => {
        const typing = document.createElement("textarea"); document.body.append(typing); typing.focus();
        await settle(() => expect(document.querySelector(".agent-batch-dialog")).not.toBeNull());
        // The user keeps typing where they were; the panel does not pull focus away.
        expect(document.activeElement).toBe(typing);
        // The confirm and save actions live in the panel's fixed footer, not in the body.
        const footer = document.querySelector(".context-panel-footer")!;
        expect(footer.textContent).toContain("确认生成");
        expect(footer.textContent).toContain("草稿已保存");
        expect(document.querySelector(".agent-batch-body")!.contains(footer)).toBe(false);
        typing.remove(); noExecution();
    });

    it("does not open by itself when the panel would cover the content, but still opens on request", async () => {
        await act(async () => root.render(h(Fixture, {width: 760})));
        await settle(() => expect(document.querySelector(".agent-batch-open")).not.toBeNull());
        await act(async () => {await new Promise(resolve => setTimeout(resolve, 30));});
        expect(document.querySelector(".agent-batch-dialog")).toBeNull();
        await click(document.querySelector<HTMLElement>(".agent-batch-open")!);
        await settle(() => expect(document.querySelector(".agent-batch-dialog")).not.toBeNull());
    });

    it("is offered once: after the user closes it, it does not come back by itself", async () => {
        await settle(() => expect(document.querySelector(".agent-batch-dialog")).not.toBeNull());
        await click(document.querySelector<HTMLElement>('button[aria-label="关闭"]')!);
        await settle(() => expect(document.querySelector(".agent-batch-dialog")).toBeNull());
        await act(async () => {await new Promise(resolve => setTimeout(resolve, 60));});
        expect(document.querySelector(".agent-batch-dialog")).toBeNull();
        // The row above the composer still brings it back.
        await click(document.querySelector<HTMLElement>(".agent-batch-open")!);
        await settle(() => expect(document.querySelector(".agent-batch-dialog")).not.toBeNull());
        noExecution();
    });
});
