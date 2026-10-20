// @vitest-environment jsdom
import {act, createElement as h, type ReactNode} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {db} from "@/platform/product/store";
import type {AgentGenerationJob} from "@/features/agent/models/agentGeneration";

vi.mock("@/features/agent/ui/AgentGenerationBatches", () => ({AgentGenerationBatches: () => null}));
vi.mock("@/features/audio/ui/AudioGenerationBatches", () => ({AgentAudioBatches: () => null}));
vi.mock("@/features/library/ui/MediaThumb", () => ({MediaPreview: ({mediaId}: {mediaId?: string}) => h("img", {"data-media": mediaId, alt: ""})}));
vi.mock("@/app/details/ShotDetails", () => ({ShotDetailLink: ({children}: {children?: ReactNode}) => h("a", null, children)}));
const {AgentGenerationResults} = await import("@/features/agent/ui/AgentGenerationResults");

let root: Root, container: HTMLDivElement;
beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();});

const job = (patch: Partial<AgentGenerationJob>) => ({
    version: 1, id: "j1", runId: "run-g", threadId: "t", projectId: "p", callId: "c", connectorId: "x", provider: "apimart", baseUrl: "https://x/v1",
    model: "gpt-image-2", kind: "image", target: {kind: "library", projectId: "p", entityId: "g", slot: "image"}, baseRevision: "r", sourceRevisions: [],
    parameters: {size: "16:9"}, inputs: [], fingerprint: "f", status: "running", createdAt: "a", updatedAt: "a", ...patch,
}) as AgentGenerationJob;
const draw = () => act(async () => root.render(h(AgentGenerationResults, {runId: "run-g"})));

it("shows one progress block while working, then only the picture", async () => {
    await db.agentGenerationJobs.add(job({progress: 50}));
    await draw();
    await vi.waitFor(() => expect(container.querySelector(".agent-generation-placeholder")).toBeTruthy());
    expect(container.textContent).toContain("正在创建图像");
    expect(container.textContent).toContain("50%");
    expect((container.querySelector(".agent-generation-placeholder") as HTMLElement).style.aspectRatio).toBe("16 / 9");
    expect(container.textContent).not.toContain("gpt-image-2");
    await db.agentGenerationJobs.update("j1", {status: "applied", result: {mediaId: "m1", kind: "image"} as never});
    await vi.waitFor(() => expect(container.querySelector("img[data-media='m1']")).toBeTruthy());
    expect(container.querySelector(".agent-generation-placeholder")).toBeNull();
    expect(container.textContent).not.toContain("正在");
});
