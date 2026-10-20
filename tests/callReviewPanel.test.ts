// @vitest-environment jsdom
import {act, createElement as h} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {AgentToolCall} from "@/features/agent/models/agent";
import type {GenerationSubmitArgs} from "@/features/video/agent/generationProfiles";

// The real forms are tested on their own; here only the shell that owns the panel and the draft matters.
vi.mock("@/features/agent/ui/GenerationReview", () => ({
    GenerationReview: ({retained}: {retained?: {draft?: {prompt: string}; set: (draft: GenerationSubmitArgs) => void}}) =>
        h("div", {"data-testid": "generation-form"},
            h("span", {"data-testid": "prompt"}, retained?.draft?.prompt ?? "原始提案"),
            h("button", {onClick: () => retained?.set({prompt: "我改过的描述"} as GenerationSubmitArgs)}, "改描述")),
}));
vi.mock("@/features/agent/ui/MusicGenerationReview", () => ({MusicGenerationReview: () => h("div", {"data-testid": "music-form"})}));

const {CallReviewPanel} = await import("@/features/agent/ui/CallReviewPanel");
const {ContextPanelHostProvider, useContextPanelHost} = await import("@/app/layout/ContextPanelHost");
const {AgentActivityNavigationProvider, useAgentActivityNavigation} = await import("@/features/agent/ui/AgentActivityNavigation");

let root: Root, container: HTMLDivElement, portal: HTMLDivElement;
let host: ReturnType<typeof useContextPanelHost>, reveal: ReturnType<typeof useAgentActivityNavigation>["reveal"];
const call = {id: "c1", runId: "r1", threadId: "t1", name: "submit_generation", title: "生成首帧", status: "awaiting_approval",
    preview: {summary: "首帧", changes: [], revision: 1}} as unknown as AgentToolCall;

function Probe() {
    host = useContextPanelHost();
    reveal = useAgentActivityNavigation().reveal;
    return null;
}
const mount = (kind: "generation" | "music" = "generation", width = 1440) => act(async () => root.render(
    h(ContextPanelHostProvider, {target: portal, surfaceWidth: width, navigationWidth: 260, headerZone: true},
        h(AgentActivityNavigationProvider, {threadId: "t1"}, h(Probe),
            h(CallReviewPanel, {call, kind, busy: false, onAction: vi.fn()})))));
const settle = () => act(async () => {await new Promise(resolve => setTimeout(resolve, 30));});

beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class {observe() {} unobserve() {} disconnect() {}});
    container = document.createElement("div"); portal = document.createElement("div");
    document.body.append(container, portal); root = createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); portal.remove(); vi.unstubAllGlobals();});

describe("a proposal in the side panel", () => {
    it("says in the message that it waits, and opens the form in the panel by itself without taking focus", async () => {
        const typing = document.createElement("textarea"); document.body.append(typing); typing.focus();
        await mount(); await settle();
        expect(container.textContent).toContain("生成提案待确认，在右侧栏审阅");
        // No form inside the message; it is in the panel's portal.
        expect(container.querySelector("[data-testid=generation-form]")).toBeNull();
        expect(portal.querySelector("[data-testid=generation-form]")).not.toBeNull();
        expect(document.activeElement).toBe(typing);
        expect(host?.activeTitle).toBe("生成提案");
        typing.remove();
    });

    it("keeps the user's edits when the panel is closed and opened again", async () => {
        await mount(); await settle();
        await act(async () => [...portal.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "改描述")!.click());
        expect(portal.querySelector("[data-testid=prompt]")!.textContent).toBe("我改过的描述");
        await act(async () => host!.toggle()); await settle();
        expect(portal.querySelector("[data-testid=generation-form]")).toBeNull();
        await act(async () => host!.toggle()); await settle();
        expect(portal.querySelector("[data-testid=prompt]")!.textContent).toBe("我改过的描述");
    });

    it("is offered once: after the user closes it, only the row's review request brings it back", async () => {
        await mount(); await settle();
        await act(async () => host!.closeActive()); await settle();
        await act(async () => {await new Promise(resolve => setTimeout(resolve, 60));});
        expect(portal.querySelector("[data-testid=generation-form]")).toBeNull();
        await act(async () => reveal({runId: "r1", callId: "c1"})); await settle();
        expect(portal.querySelector("[data-testid=generation-form]")).not.toBeNull();
    });

    it("does not open by itself when the panel would cover the content", async () => {
        await mount("generation", 760); await settle();
        expect(portal.querySelector("[data-testid=generation-form]")).toBeNull();
        await act(async () => reveal({runId: "r1", callId: "c1"})); await settle();
        expect(portal.querySelector("[data-testid=generation-form]")).not.toBeNull();
    });

    it("titles a music proposal as music generation", async () => {
        await mount("music"); await settle();
        expect(host?.activeTitle).toBe("音乐生成");
        expect(portal.querySelector("[data-testid=music-form]")).not.toBeNull();
    });
});
