// @vitest-environment jsdom
import {Blob as NodeBlob} from "node:buffer";
import {act, createElement as h, StrictMode, type ReactNode} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {retainMcpOriginalInvocation} from "@/features/agent/mcp/runtime/executionOwner";
import {installMcpHostServices, clearMcpHostServices} from "@/platform/runtime/mcpServices";
import type {McpHostServices} from "@/platform/runtime/mcp";
import {AgentJobReport} from "@/features/agent/ui/AgentJobReport";
import {AgentRunDetails} from "@/features/agent/ui/AgentRunDetails";
import {ComposerActionCards} from "@/features/agent/ui/ComposerActionCards";
import {admitAgentJob, checkpointAgentJob, clearAgentJobResult, markAgentJobRunning, publishAgentJob, stopAgentJob} from "@/features/agent/commands/agentJobs";
import type {AgentRun, AgentToolCall} from "@/features/agent/models/agent";
import type {AgentJob, AgentJobReader, AgentJobSelection} from "@/features/agent/models/agentJob";
import {createProject} from "@/features/projects/commands/projects";
import {putMedia} from "@/features/library/commands/media";
import {db} from "@/platform/product/store";
import {TABLE_NAMES} from "@/platform/storage/schema";
import {StorageError, UnknownCommitError} from "@/platform/storage/errors";
import type {StoreObserver, StoreTx} from "@/platform/storage/types";
import {failStoreTableOnce} from "./helpers/storeFaults";

// Only unrelated rich/review owners are replaced; the call row, report, hooks and all reads/writes are real.
vi.mock("@/features/agent/ui/AgentMarkdown", () => ({AgentMarkdown: ({children}: {children?: ReactNode}) => h("p", null, children)}));
vi.mock("@/features/agent/ui/AgentGenerationResults", () => ({AgentGenerationResults: () => null}));
vi.mock("@/features/agent/ui/GenerationReview", () => ({GenerationReview: () => null}));
vi.mock("@/features/agent/ui/MusicGenerationReview", () => ({MusicGenerationReview: () => null}));
vi.mock("@/features/agent/ui/CreatedEntityLinks", () => ({CreatedEntityLinks: () => null}));

type Read = {query: (tx: StoreTx) => unknown | Promise<unknown>; observer: StoreObserver<unknown>; stopped: boolean};
type Owner = {run: AgentRun; call: AgentToolCall; job: AgentJob; context: {runId: string; threadId: string; callId: string; projectId: string}};
let root: Root, container: HTMLDivElement, reads: Read[];
const timestamp = "2026-10-15T00:00:00.000Z";
const network = vi.fn(() => {throw new Error("UI must not dispatch a provider request");});
beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class {observe() {} disconnect() {}});
    // IndexedDB's real structuredClone needs a native Blob; jsdom's wrapper loses its byte metadata.
    vi.stubGlobal("Blob", NodeBlob);
    vi.stubGlobal("fetch", network); network.mockClear(); reads = [];
    vi.spyOn(db, "observe").mockImplementation((query, observer) => {
        const read = {query, observer: observer as StoreObserver<unknown>, stopped: false}; reads.push(read);
        return () => {read.stopped = true;};
    });
    container = document.createElement("div"); container.className = "agent-chat-root";
    container.style.width = "390px"; document.body.append(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
async function seed(suffix: string, kind: Exclude<AgentJob["kind"], "mcp"> = "project_media_check"): Promise<Owner> {
    const projectId = (await createProject(`Report ${suffix}`)).id, threadId = `thread-${suffix}`;
    const run: AgentRun = {id: `run-${suffix}`, threadId, projectId, userMessageId: `user-${suffix}`, assistantMessageId: `assistant-${suffix}`,
        agentId: "agent", agentSnapshot: {name: "Agent", instructions: ""}, connector: {id: "connector", definitionId: "openai-compatible", baseUrl: "https://unused.invalid"},
        model: "model", status: "running", requestMessages: [], enabledToolNames: [kind], offeredTools: [{step: 1, names: [kind]}],
        checkpoint: 0, createdAt: timestamp, updatedAt: timestamp};
    const call: AgentToolCall = {id: `call-${suffix}`, runId: run.id, threadId, providerCallId: `provider-${suffix}`, step: 1, order: 0,
        name: kind, title: kind === "web_read" ? "读取网页" : "检查视频", arguments: "{}", status: "running", effect: "read", highRisk: false,
        createdAt: timestamp, updatedAt: timestamp};
    await db.chatThreads.add({id: threadId, projectId, title: suffix, connectorId: "connector", model: "model", createdAt: timestamp, updatedAt: timestamp});
    await db.chatMessages.add({id: run.assistantMessageId, threadId, runId: run.id, role: "assistant", content: "", status: "streaming", createdAt: timestamp});
    await db.agentRuns.add(run); await db.agentToolCalls.add(call);
    const media = [0, 1].map(index => {
        const name = `很长的视频文件名称-${suffix}-${index}.mp4`;
        return {id: `media-${suffix}-${index}`, name, mimeType: "video/mp4", size: 1, revision: JSON.stringify([name, "video/mp4", 1])};
    });
    for (const item of media) await putMedia({id: item.id, projectId, filename: item.name, mimeType: item.mimeType, blob: new Blob(["v"], {type: item.mimeType})});
    const selection: AgentJobSelection = kind === "web_read" ? {kind, urls: ["https://example.com/source"]} : {kind, media};
    const context = {runId: run.id, threadId, callId: call.id, projectId};
    const {job} = await admitAgentJob(context, selection);
    return {run, call, job, context};
}
async function completed(owner: Owner, text: string, status: "completed" | "stopped" = "completed") {
    let job = owner.job.status === "running" ? owner.job : await markAgentJobRunning(owner.context, owner.job.id, owner.job.revision);
    if (job.kind === "web_read") job = await checkpointAgentJob(owner.context, job.id, job.revision, {completed: 1});
    else for (const media of job.selection.kind === "project_media_check" ? job.selection.media : []) {
        job = await checkpointAgentJob(owner.context, job.id, job.revision, {completed: job.completed + 1, observation: {mediaId: media.id, status: "ready"}});
    }
    await publishAgentJob(owner.context, job.id, job.revision, {status, text});
    owner.call = (await db.agentToolCalls.get(owner.call.id))!;
    owner.job = (await db.agentJobs.get(job.id))!;
}
async function draw(owner: Owner, readOnly = false) {
    await act(async () => root.render(h(StrictMode, null, h(AgentJobReport, {run: owner.run, call: owner.call, readOnly}))));
}
const latest = () => reads.filter(read => !read.stopped).at(-1)!;
const query = (read: Read) => db.transaction("r", TABLE_NAMES, read.query);
async function publish(read = latest(), supplied?: unknown) {
    const result = supplied === undefined ? await query(read) : supplied;
    await act(async () => read.observer.next(result)); return result;
}
function button(text: string) {return [...container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text)!;}
async function click(text: string) {expect(button(text), text).toBeTruthy(); await act(async () => button(text).click());}
const reader = (owner: Owner): AgentJobReader => ({threadId: owner.run.threadId, projectId: owner.run.projectId, original: {runId: owner.run.id, callId: owner.call.id}});

it("renders only committed real progress, then an honest stopped partial report without a second Stop", async () => {
    const owner = await seed("partial"); await draw(owner); await publish();
    expect(container.textContent).toContain("已检查 0 / 2 项");
    let job = await markAgentJobRunning(owner.context, owner.job.id, owner.job.revision);
    job = await checkpointAgentJob(owner.context, job.id, job.revision, {completed: 1, observation: {mediaId: "media-partial-0", status: "missing"}});
    expect(container.textContent).toContain("已检查 0 / 2 项");
    await publish(); expect(container.textContent).toContain("已检查 1 / 2 项"); expect(container.textContent).toContain("文件缺失");
    job = await stopAgentJob(owner.context, job.id); await publish();
    expect(container.textContent).toContain("等待当前检查结束"); expect(button("查看报告")).toBeUndefined();
    await publishAgentJob(owner.context, job.id, job.revision, {status: "stopped", text: "已检查一项；另一项未检查。"});
    await publish(); expect(container.textContent).toContain("还有 1 项未检查");
    await click("查看报告"); await publish(); expect(container.querySelector("pre")?.textContent).toContain("media-partial-0): missing");
    expect(container.querySelector("pre")?.textContent).toContain("media-partial-1): 未检查");
    expect(button("停止")).toBeUndefined(); expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(network).not.toHaveBeenCalled();
});

it("keeps actual call-row progress outside the folded technical and call details", async () => {
    const owner = await seed("call-row");
    const message = (await db.chatMessages.get(owner.run.assistantMessageId))!;
    await act(async () => root.render(h(AgentRunDetails, {run: owner.run, message, calls: [owner.call], busy: true, onAction: vi.fn()})));
    await publish();
    const row = container.querySelector(`[data-activity-call="${owner.call.id}"]`)!;
    const toggle = row.querySelector<HTMLButtonElement>(".agent-tool-call-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const progress = row.querySelector(".agent-job-progress")!;
    expect(progress.textContent).toContain("已检查 0 / 2 项"); expect(progress.closest("[hidden]")).toBeNull();
    const technical = button("参数与返回结果"); expect(technical.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(technical.getAttribute("aria-controls")!)?.hidden).toBe(true);
    await act(async () => toggle.click()); await act(async () => toggle.click());
    expect(progress.closest("[hidden]")).toBeNull();
    for (const noise of ["正在准备", "正在确认", "已完成", "清理成功"]) expect(container.textContent).not.toContain(noise);
    expect(network).not.toHaveBeenCalled();
});

it("shows acknowledged pre-request retention refusal without suggesting an unavailable saved report", async () => {
    const owner = await seed("admission-refused", "web_read");
    await db.agentJobs.delete(owner.job.id);
    const message = "报告存储空间已满，请先清理保留结果。尚未访问网页服务，没有自动重试。";
    await db.agentToolCalls.update(owner.call.id, {status: "completed", result: JSON.stringify({
        ok: false, code: "retention_unavailable", message, serviceMayHaveRun: false, retrievedAt: timestamp,
    })});
    owner.call = (await db.agentToolCalls.get(owner.call.id))!;
    await draw(owner); await publish();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(container.textContent).not.toMatch(/报告不可用|正在读取报告|已提取/);
    expect(button("查看报告")).toBeUndefined(); expect(button("清理保留结果")).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
});

it("pages retained plain text, rejects a held old page and reopens locally with zero provider requests", async () => {
    const owner = await seed("pages", "web_read"), text = '<img src="https://unused.invalid/image">' + "甲".repeat(6000) + "乙".repeat(6000) + "😀尾";
    await draw(owner); await publish(); expect(container.textContent).not.toMatch(/已提取|0\s*\/\s*1/);
    owner.job = await markAgentJobRunning(owner.context, owner.job.id, owner.job.revision); await publish();
    expect(container.textContent).not.toMatch(/已提取|0\s*\/\s*1/);
    await completed(owner, text); await publish(); expect(container.textContent).not.toMatch(/已提取|1\s*\/\s*1/);
    expect(container.querySelector("pre")).toBeNull(); await click("查看报告");
    const firstRead = latest(), first = await publish(firstRead);
    expect(container.querySelector("pre")?.textContent).toBe(text.slice(0, 6000)); expect(container.querySelector("img")).toBeNull();
    await click("下一页"); expect(firstRead.stopped).toBe(true);
    expect(container.querySelector("pre")).toBeNull(); expect(button("下一页").disabled).toBe(true);
    await publish(firstRead, first); expect(container.querySelector("pre")).toBeNull();
    await publish(); expect(container.querySelector("pre")?.textContent).toBe(text.slice(6000, 12000));
    await click("下一页"); await publish(); expect(container.querySelector("pre")?.textContent).toBe(text.slice(12000));
    expect(button("下一页").disabled).toBe(true); await click("上一页"); await publish();
    expect(container.querySelector("pre")?.textContent).toBe(text.slice(6000, 12000));
    await click("收起报告"); expect(container.querySelector("pre")).toBeNull();
    await click("查看报告"); await publish(); expect(container.querySelector("pre")?.textContent).toBe(text.slice(0, 6000));
    expect(network).not.toHaveBeenCalled();
});

it("drops old topic/call deliveries, rejects foreign matching-envelope jobs and observes actual scope loss", async () => {
    const a = await seed("A", "web_read"), b = await seed("B", "web_read"); await completed(a, "A retained private report"); await completed(b, "B retained report");
    await draw(a); const oldRead = latest(), aValue = await publish(oldRead) as {key: string; job: AgentJob};
    await click("查看报告"); await publish(); expect(container.textContent).toContain("A retained private report");
    await draw(b); const bRead = latest(); expect(oldRead.stopped).toBe(true); expect(container.textContent).not.toContain("A retained private report");
    await publish(oldRead, aValue); expect(container.querySelector("[data-agent-job]")).toBeNull();
    const bValue = await query(bRead) as {key: string; job: AgentJob};
    await publish(bRead, {...bValue, job: aValue.job}); expect(container.querySelector("[data-agent-job]")).toBeNull();
    await publish(bRead, bValue); expect(container.querySelector("[data-agent-job]")?.getAttribute("data-agent-job")).toBe(b.job.id);
    await db.chatThreads.update(b.run.threadId, {projectId: a.run.projectId}); await publish(bRead);
    expect(container.textContent).toContain("保留报告不可用"); expect(button("清理保留结果")).toBeUndefined(); expect(network).not.toHaveBeenCalled();
});

it("keeps readOnly inspection, synchronously excludes repeated clears, and clears through the shared durable command", async () => {
    const owner = await seed("clear"); await completed(owner, "saved report"); const originalResult = owner.call.result;
    await draw(owner, true); await publish(); expect(button("查看报告")).toBeTruthy(); expect(button("清理保留结果")).toBeUndefined();
    await draw(owner); const original = db.transaction.bind(db); let release!: () => void, clears = 0;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const spy = vi.spyOn(db, "transaction").mockImplementation((mode, scope, callback) => {
        if (mode === "rw") {clears++; return gate.then(() => original(mode, scope, callback));}
        return original(mode, scope, callback);
    });
    await act(async () => {const clear = button("清理保留结果"); clear.click(); clear.click();});
    expect(button("清理保留结果").disabled).toBe(true); expect(clears).toBe(1);
    await click("清理保留结果"); expect(clears).toBe(1); expect((await db.agentJobs.get(owner.job.id))?.output?.retention).toBe("retained");
    await act(async () => {release(); await gate;});
    await vi.waitFor(async () => expect((await db.agentJobs.get(owner.job.id))?.output?.retention).toBe("cleared"));
    await publish(); expect(container.textContent).toContain("保留结果已清理"); expect(button("查看报告")).toBeUndefined();
    expect(await db.agentJobResultChunks.where("jobId").equals(owner.job.id).count()).toBe(0);
    const redacted = await db.agentToolCalls.get(owner.call.id), before = JSON.parse(originalResult!);
    expect(redacted?.status).toBe("completed"); expect(JSON.parse(redacted!.result!)).toEqual({...before, output: {version: 1, jobId: owner.job.id, revision: before.output.revision + 1, retention: "cleared", length: 0, byteLength: 0, preview: ""}});
    expect(clears).toBe(1); expect(network).not.toHaveBeenCalled(); spy.mockRestore();
});

it("keeps actual read failure distinct from missing and retries the same original owner", async () => {
    const owner = await seed("read-error", "web_read"); await completed(owner, "report body"); await draw(owner);
    const read = latest(), fault = failStoreTableOnce(db, "agentRuns", "get", new StorageError("unavailable", "controlled actual read failure"));
    let failure: unknown; try {await query(read);} catch (cause) {failure = cause;} finally {fault.mockRestore();}
    expect(failure).toBeInstanceOf(StorageError); await act(async () => read.observer.error(failure));
    expect(container.textContent).toContain("任务进度与报告读取失败"); expect(container.textContent).not.toContain("保留报告不可用");
    await click("重试读取任务"); expect(read.stopped).toBe(true); await publish(); await click("查看报告");
    const pageRead = latest(), pageFault = failStoreTableOnce(db, "agentJobs", "get", new StorageError("unavailable", "controlled page read failure"));
    try {await query(pageRead);} catch (cause) {failure = cause;} finally {pageFault.mockRestore();}
    await act(async () => pageRead.observer.error(failure)); expect(container.textContent).toContain("报告读取失败");
    await click("重试读取报告"); await publish(); expect(container.querySelector("pre")?.textContent).toBe("report body"); expect(network).not.toHaveBeenCalled();
});

it("retains a known failed clear and quarantines unknown acknowledgement until a read confirms cleared", async () => {
    const owner = await seed("clear-error"); await completed(owner, "preserved report"); await draw(owner); await publish();
    const fault = failStoreTableOnce(db, "agentJobs", "put", new StorageError("unavailable", "controlled clear rollback"));
    await click("清理保留结果"); await vi.waitFor(() => expect(container.textContent).toContain("清理未完成")); fault.mockRestore();
    expect((await db.agentJobs.get(owner.job.id))?.output?.retention).toBe("retained");
    expect(await db.agentJobResultChunks.where("jobId").equals(owner.job.id).count()).toBeGreaterThan(0);
    const original = db.transaction.bind(db); let clears = 0;
    const spy = vi.spyOn(db, "transaction").mockImplementation((mode, scope, callback) => {
        if (mode === "rw") {clears++; return original(mode, scope, callback).then(() => {throw new UnknownCommitError("clear-operation", "workspace");});}
        return original(mode, scope, callback);
    });
    await click("清理保留结果"); await vi.waitFor(() => expect(container.textContent).toContain("清理结果未确认"));
    expect(button("清理保留结果").disabled).toBe(true); await click("清理保留结果"); expect(clears).toBe(1);
    await click("重新读取任务"); await publish(); expect(container.textContent).toContain("保留结果已清理"); expect(clears).toBe(1); spy.mockRestore();
});

it("distinguishes unpublished unknown, cleared and deleted output without accepting display JSON as authority", async () => {
    const owner = await seed("unknown", "web_read");
    await db.agentJobs.update(owner.job.id, {status: "unknown", serviceMayHaveRun: true});
    await draw(owner); await publish(); expect(container.textContent).toContain("未确认"); expect(container.textContent).toContain("服务可能已经执行");
    expect(container.textContent).toContain("完整报告暂不可读取"); expect(button("查看报告")).toBeUndefined();
    await clearAgentJobResult(reader(owner), owner.job.id); await publish(); expect(container.textContent).toContain("保留结果已清理");
    owner.call = {...owner.call, status: "completed", result: JSON.stringify({jobId: "foreign-display-id"})};
    await db.agentJobs.delete(owner.job.id); await draw(owner); await publish(); expect(container.textContent).toContain("保留报告不可用"); expect(network).not.toHaveBeenCalled();
});


it("keeps MCP unknown evidence readable in its original report while preserving the unresolved call", async () => {
    const owner = await seed("mcp-unknown", "web_read");
    await db.agentJobs.delete(owner.job.id);
    const publicName = "mcp_captured_resource";
    const facts = {version: 1 as const, binding: {serverId: "server_ui", configRevision: 1, manifestRevision: "raw_one", registrationId: "registration_one", hostSessionId: "host_one", principalRevision: "principal_one"},
        manifestDigest: "normalized_one", publicName, operation: "resource_read" as const, target: {kind: "resource" as const, handleId: "resource_one"}};
    const toolBinding = {capabilityId: "mcp/server_ui", version: facts.manifestDigest, registrationId: facts.binding.registrationId};
    await db.agentRuns.update(owner.run.id, {enabledToolNames: [publicName], offeredTools: [{step: 1, names: [publicName]}]});
    await db.agentToolCalls.update(owner.call.id, {name: publicName, binding: toolBinding, preview: {summary: "读取外部资源", changes: [], mcp: facts}, effect: "network", highRisk: true});
    owner.run = (await db.agentRuns.get(owner.run.id))!;
    const initial = await admitAgentJob(owner.context, {kind: "mcp", execution: facts, operationId: owner.call.id});
    const job = await markAgentJobRunning(owner.context, initial.job.id, initial.job.revision, {serviceMayHaveRun: true});
    await publishAgentJob(owner.context, job.id, job.revision, {status: "unknown", text: "原调用的核实记录，不代表已完成。", serviceMayHaveRun: true}, true);
    owner.call = (await db.agentToolCalls.get(owner.call.id))!;
    owner.job = (await db.agentJobs.get(job.id))!;
    await draw(owner); await publish();
    expect(container.querySelector('[aria-label="MCP 服务报告"]')).toBeTruthy();
    expect(container.textContent).toContain("外部操作未确认");
    await click("查看报告"); await publish();
    expect(container.querySelector("pre")?.textContent).toBe("原调用的核实记录，不代表已完成。");
    expect((await db.agentToolCalls.get(owner.call.id))!.status).toBe("unknown");
    const unused = async () => {throw new Error("Unexpected host action");};
    const host: McpHostServices = {active: true, capabilities: {host: "desktop", stdio: true, streamableHttp: true, oauth: true, rememberedCredentials: true},
        initialize: unused, preparePrivateRevision: unused, privateRevisionStatus: unused, discardPrivateRevision: unused, confirmPrivateRevision: unused,
        retireServer: unused, oauthBegin: unused, oauthStatus: unused, oauthCancel: unused, connect: unused, disconnect: unused, prepare: unused,
        invoke: vi.fn(unused), stop: unused, dispose: async () => ({status: "drained" as const}),
        invocationStatus: vi.fn(async identity => ({status: "completed" as const, operationId: identity.operationId, result: {contents: [{uri: "fixture://one", text: "已核实的原回复"}]}}))};
    installMcpHostServices(host);
    try {
        retainMcpOriginalInvocation(host, {identity: {operationId: owner.call.id, authority: {authorityId: "authority_ui", binding: facts.binding,
            scope: {runId: owner.run.id, callId: owner.call.id, scopeId: owner.run.threadId}, target: facts.target, argumentsDigest: "digest_one"}},
            jobId: job.id, revision: job.revision, context: owner.context});
        await draw(owner); await publish();
        // The check is an action row above the composer, never a button inside the message.
        expect(button("检查结果")).toBeFalsy();
        const rowHost = document.createElement("div"); rowHost.className = "agent-chat-root"; document.body.append(rowHost);
        const rowRoot = createRoot(rowHost);
        await act(async () => rowRoot.render(h(ComposerActionCards, {threadId: owner.run.threadId, busy: false, readOnly: false, onRunAction: vi.fn()})));
        await publish();
        const rowButton = [...rowHost.querySelectorAll("button")].find(item => item.textContent?.includes("检查结果"));
        expect(rowButton).toBeTruthy();
        await act(async () => rowButton!.click());
        await publish();
        await act(async () => rowRoot.unmount()); rowHost.remove();
        expect((await db.agentToolCalls.get(owner.call.id))!.status).toBe("completed");
        expect(host.invocationStatus).toHaveBeenCalledTimes(1); expect(host.invoke).not.toHaveBeenCalled();
    } finally {await clearMcpHostServices(host);}
    expect(network).not.toHaveBeenCalled();
});
