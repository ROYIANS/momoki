import {afterEach, describe, expect, it, vi} from "vitest";
import {db} from "@/platform/product/store";
import {beginAgentRun} from "@/features/agent/commands/agentRuns";
import {appendToolResults, pauseForApproval, resolveAgentToolApproval, resumeAgentRun, saveToolPreview, transitionToolCall} from "@/features/agent/commands/agentTools";
import {createChatThread} from "@/features/agent/commands/chat";
import {createAudioMusicProject, createProject} from "@/features/projects/commands/projects";
import {addShot} from "@/features/video/commands/shots";
import {bindProjectIp, createIpProfile} from "@/features/library/commands/ipProfiles";
import {adoptMaterialInProject, createFileMaterial} from "@/features/library/commands/materials";
import {addMusicWork} from "@/features/music/commands/music";
import {BUILTIN_TOOLS, requiresToolApproval, type AgentToolContext} from "@/features/agent/runtime/tools";
import {GenerationPendingError, submitAgentGeneration} from "@/features/video/agent/generationRuntime";
import type {GenerationSubmitArgs} from "@/features/video/agent/generationProfiles";
import {prepareAudioGeneration, submitAudioGeneration} from "@/features/audio/generation/runtime";
import {readBinaryBlob} from "@/platform/storage/binary";
import {materializeChatMessages} from "@/features/agent/providers/referenceWire";
import {readWriteReceipt} from "@/features/agent/runtime/writeReceipt";
import type {AgentReferenceInput} from "@/features/references/models/referenceInput";
import type {AgentRun} from "@/features/agent/models/agent";
import type {ConnectorConfig} from "@/features/settings/models/connector";
import type {MusicSettings} from "@/features/music/models/music";
import {saveFixtureToolRound} from "./helpers/toolDispatch";

// The permanent native lane aliases only the database owner to the actual Rust
// process. Every parser, preview and registered execution below stays shared.
const owner = process.env.MOMOKI_STORAGE_TEST_OWNER ?? "indexeddb";
const connector: ConnectorConfig = {
    id: "registered-success-provider", definitionId: "apimart",
    baseUrl: "https://provider.fixture.test/v1", apiKey: "disposable-fixture-key", updatedAt: "2026-10-12",
};
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const png = Uint8Array.from(atob(pngBase64), char => char.charCodeAt(0));
let serial = 0;

afterEach(() => vi.unstubAllGlobals());

async function begin(projectId: string): Promise<AgentRun> {
    await db.connectors.put(connector);
    const thread = await createChatThread({projectId, taskMode: true});
    const initial = await beginAgentRun({threadId: thread.id, connector, model: "fixture-model", content: "按明确方案处理当前项目", modelMetadata: {source: "provider", vision: true}});
    const run: AgentRun = {...initial, permissionMode: "full", enabledToolNames: BUILTIN_TOOLS.map(tool => tool.name), toolLoading: undefined};
    await db.agentRuns.put(run);
    return run;
}

async function prepared(run: AgentRun, name: string, raw: unknown) {
    const definition = BUILTIN_TOOLS.find(tool => tool.name === name);
    if (!definition) throw new Error(`Tool is not registered: ${name}`);
    const args = definition.parseArguments(raw);
    const providerCallId = `success-call-${++serial}`;
    await saveFixtureToolRound(run.id, "", [{id: providerCallId, type: "function", function: {name, arguments: JSON.stringify(raw)}}], [{title: definition.title, effect: definition.effect, highRisk: definition.highRisk(args), atomic: definition.atomic, recovery: definition.recovery, requiresConfirmation: definition.requiresConfirmation}]);
    const call = (await db.agentToolCalls.where("runId").equals(run.id).toArray()).find(row => row.providerCallId === providerCallId)!;
    const context: AgentToolContext = {runId: run.id, threadId: run.threadId, projectId: run.projectId, callId: call.id, signal: new AbortController().signal, store: db};
    if (definition.prepare) {
        context.preview = await definition.prepare(args, context);
        await saveToolPreview(run.id, call.id, context.preview);
        expect(context.preview.revision).toBeTruthy();
    }
    if (requiresToolApproval("full", definition, args)) {
        expect(await transitionToolCall(run.id, call.id, ["pending"], "awaiting_approval")).toBe(true);
        await pauseForApproval(run.id);
        await resolveAgentToolApproval(run.id, call.id, "approve");
        await resumeAgentRun(run.id);
        expect(await transitionToolCall(run.id, call.id, ["approved"], "running")).toBe(true);
    } else expect(await transitionToolCall(run.id, call.id, ["pending"], "running")).toBe(true);
    return {definition, args, context, call, async execute() {
        const result = await definition.execute(args, context);
        // Read/network tools are completed by the runner. Persist their actual
        // returned value through the same ledger CAS, never a canned result.
        const current = (await db.agentToolCalls.get(call.id))!;
        if (current.status === "running") expect(await transitionToolCall(run.id, call.id, ["running"], "completed", {result: JSON.stringify(result)})).toBe(true);
        expect(await db.agentToolCalls.get(call.id)).toMatchObject({status: "completed", arguments: JSON.stringify(raw)});
        expect(JSON.parse((await db.agentToolCalls.get(call.id))!.result!)).toEqual(JSON.parse(JSON.stringify(result)));
        return result;
    }};
}

async function invoke(run: AgentRun, name: string, raw: unknown) {
    return (await prepared(run, name, raw)).execute();
}

function generationFetch(completed = true) {
    return vi.fn<typeof fetch>(async (url, init) => {
        if (init?.method === "POST") return Response.json({code: 200, data: [{task_id: "success-remote-task"}]});
        if (String(url).includes("/tasks/")) return Response.json({code: 200, data: {id: "success-remote-task", status: completed ? "completed" : "processing", progress: completed ? 100 : 35, ...(completed ? {result: {images: [{url: "https://bytes.fixture.test/result.png"}]}} : {})}});
        expect(String(url)).toBe("https://bytes.fixture.test/result.png");
        expect(init?.headers).toBeUndefined();
        expect(init?.credentials).toBe("omit");
        return new Response(png, {headers: {"content-type": "image/png"}});
    });
}

async function videoFixture() {
    const project = await createProject("注册工具视频项目");
    const episode = (await db.episodes.where("projectId").equals(project.id).first())!;
    const shot = await addShot(project.id, episode.id);
    const run = await begin(project.id);
    const args: GenerationSubmitArgs = {connectorId: connector.id, model: "gpt-image-2", prompt: "窗边暖色光线", target: {kind: "shot", projectId: project.id, episodeId: episode.id, entityId: shot.id, slot: "firstFrame"}, parameters: {}, inputs: []};
    return {project, episode, shot, run, args};
}

async function downloadedFixture() {
    const fixture = await videoFixture(), fetcher = generationFetch();
    vi.stubGlobal("fetch", fetcher);
    const submitted = await invoke(fixture.run, "submit_generation", fixture.args) as {jobId: string; status: string};
    expect(submitted.status).toBe("downloaded");
    const job = (await db.agentGenerationJobs.get(submitted.jobId))!;
    expect(new Uint8Array(await (await readBinaryBlob((await db.media.get(job.result!.mediaId))!.blob)).arrayBuffer())).toEqual(png);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    return {...fixture, job, fetcher};
}

describe(`${owner} registered tool successful business paths`, () => {
    it("apply_generation commits the real downloaded media, original shot text and completed ledger", async () => {
        const f = await downloadedFixture(), operation = await prepared(f.run, "apply_generation", {jobId: f.job.id});
        expect(operation.context.preview?.changes).toContain(`结果素材：${f.job.result!.mediaId}`);
        expect(await operation.execute()).toMatchObject({jobId: f.job.id, status: "applied", applied: true});
        expect(await db.shots.get(f.shot.id)).toEqual({...f.shot, firstFrame: {...f.shot.firstFrame, result: f.job.result}});
        expect((await db.agentGenerationJobs.get(f.job.id))?.status).toBe("applied");
        expect(await operation.execute()).toMatchObject({jobId: f.job.id, status: "applied"});
        expect(await db.media.count()).toBe(1);
        expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    });

    it("audio_generation_check verifies the saved take and real retained bytes without another paid POST", async () => {
        const project = await createAudioMusicProject("声音查询项目", "audio"), run = await begin(project.id);
        const job = await prepareAudioGeneration({projectId: project.id, connectorId: connector.id, input: {kind: "speech", text: "保留原文配音", voice: "alloy", speed: 1}});
        const bytes = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 65, 86, 69]);
        const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes, {headers: {"content-type": "audio/wav"}}));
        const saved = await submitAudioGeneration(project.id, job.id, {fetchImpl: fetcher, decode: async () => ({durationSec: 3, sampleRate: 48000, channels: 1})});
        expect(saved.status).toBe("saved");
        const unexpected = vi.fn<typeof fetch>(async () => {throw new Error("A saved job must not submit/query again");});
        vi.stubGlobal("fetch", unexpected);
        expect(await invoke(run, "audio_generation_check", {jobId: job.id})).toMatchObject({id: job.id, projectId: project.id, status: "saved", outputs: {allAvailable: true, availableCount: 1, results: [{available: true, availability: "available"}]}});
        expect(unexpected).not.toHaveBeenCalled();
        expect(fetcher).toHaveBeenCalledOnce();
        const take = (await db.audioTakes.get(saved.results[0].takeId!))!;
        expect(take).toMatchObject({durationSec: 3, source: "tts", textSnapshot: "保留原文配音"});
        expect(new Uint8Array(await (await readBinaryBlob((await db.media.get(take.mediaId))!.blob)).arrayBuffer())).toEqual(bytes);
    });

    it("check_generation resumes a known remote task through GET, downloads genuine bytes and never resubmits", async () => {
        const f = await videoFixture(), operation = await prepared(f.run, "submit_generation", f.args), pending = generationFetch(false);
        await expect(submitAgentGeneration(f.args, operation.context, {fetchImpl: pending, pollIntervalMs: 0, maxPolls: 1})).rejects.toBeInstanceOf(GenerationPendingError);
        const job = (await db.agentGenerationJobs.toArray())[0];
        expect(job).toMatchObject({status: "running", providerTaskId: "success-remote-task", progress: 35});
        await transitionToolCall(f.run.id, operation.call.id, ["running"], "failed", {error: "本轮查询等待已暂停，任务仍可查询"});
        const completed = generationFetch();
        vi.stubGlobal("fetch", completed);
        expect(await invoke(f.run, "check_generation", {jobId: job.id})).toMatchObject({jobId: job.id, status: "downloaded", applied: false});
        expect(completed.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
        expect(completed).toHaveBeenCalledTimes(2);
        expect(pending.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
        const result = (await db.agentGenerationJobs.get(job.id))!.result!;
        expect(new Uint8Array(await (await readBinaryBlob((await db.media.get(result.mediaId))!.blob)).arrayBuffer())).toEqual(png);
        expect((await db.shots.get(f.shot.id))?.firstFrame.result).toBeUndefined();
    });

    it("list_generation_jobs returns actual current-thread states and excludes another thread", async () => {
        const own = await downloadedFixture(), foreign = await downloadedFixture();
        const noNetwork = vi.fn<typeof fetch>(async () => {throw new Error("Local history must not fetch");});
        vi.stubGlobal("fetch", noNetwork);
        expect(await invoke(own.run, "list_generation_jobs", {})).toEqual([expect.objectContaining({jobId: own.job.id, projectId: own.project.id, target: own.args.target, status: "downloaded", result: own.job.result, applied: false})]);
        expect((await db.agentGenerationJobs.get(foreign.job.id))?.result).toEqual(foreign.job.result);
        expect(noNetwork).not.toHaveBeenCalled();
    });

    it("material_read_image queues the immutable real pixels, then sends those exact bytes using its actual ledger provenance", async () => {
        const project = await createProject("素材视觉项目"), run = await begin(project.id);
        const material = await createFileMaterial(new File([png], "visual.png", {type: "image/png"}), {kind: "global"});
        const result = await invoke(run, "material_read_image", {materialId: material.id, revision: 1}) as {status: string; referenceInput: AgentReferenceInput};
        expect(result).toMatchObject({status: "queued", materialId: material.id, revision: 1, referenceInput: {material: {kind: "image", materialId: material.id, revision: 1, digest: expect.stringMatching(/^[a-f0-9]{64}$/)}}});
        await appendToolResults(run.id);
        const current = (await db.agentRuns.get(run.id))!;
        const wire = await materializeChatMessages(current.continuationMessages!, {runId: run.id, projectId: project.id, model: run.model, visionCapability: run.visionCapability});
        expect(JSON.stringify(wire)).toContain(`data:image/png;base64,${pngBase64}`);
        expect(JSON.stringify(current)).not.toContain(pngBase64);
        expect(current.continuationMessages?.filter(message => message.referenceInput)).toHaveLength(1);
    });

    it("read_generation_batch reads real prepared candidates without submitting or selecting them", async () => {
        const f = await videoFixture();
        const preparedBatch = await invoke(f.run, "prepare_generation_batch", {title: "首帧候选", candidates: [f.args, {...f.args, prompt: "夜晚冷色光线"}]}) as {batchId: string};
        const noNetwork = vi.fn<typeof fetch>(async () => {throw new Error("Draft batch read must not fetch");});
        vi.stubGlobal("fetch", noNetwork);
        const result = await invoke(f.run, "read_generation_batch", {batchId: preparedBatch.batchId});
        const rows = await db.agentGenerationBatchItems.where("batchId").equals(preparedBatch.batchId).sortBy("order");
        expect(result).toMatchObject({batchId: preparedBatch.batchId, title: "首帧候选", status: "draft", candidates: rows.map(row => ({itemId: row.id, target: f.args.target, status: "draft", selected: false, applied: false}))});
        expect(rows.map(row => row.draft.prompt)).toEqual([f.args.prompt, "夜晚冷色光线"]);
        expect(await db.agentGenerationJobs.count()).toBe(0);
        expect((await db.shots.get(f.shot.id))?.firstFrame.result).toBeUndefined();
        expect(noNetwork).not.toHaveBeenCalled();
    });

    it("ip_update approves the real preview, updates the shared IP and preserves existing project content", async () => {
        const project = await createProject("IP 关联项目"), ip = await createIpProfile({name: "原名称", voice: "轻柔"});
        await bindProjectIp(project.id, ip.id);
        const projectBefore = await db.projects.get(project.id), linkBefore = await db.projectIpLinks.get(project.id), run = await begin(project.id);
        const operation = await prepared(run, "ip_update", {id: ip.id, expectedRevision: 1, patch: {name: "新名称", expression: "温暖叙述"}});
        expect(operation.context.preview?.changes.join("\n")).toContain("关联 1 个项目");
        expect((await db.agentToolCalls.get(operation.call.id))?.decision).toBe("approve");
        expect(await operation.execute()).toMatchObject({id: ip.id, name: "新名称", revision: 2});
        expect(await db.ipProfiles.get(ip.id)).toEqual({...ip, name: "新名称", expression: "温暖叙述", revision: 2, updatedAt: expect.any(String)});
        expect(await db.projects.get(project.id)).toEqual(projectBefore);
        expect(await db.projectIpLinks.get(project.id)).toEqual(linkBefore);
        expect(await operation.execute()).toMatchObject({id: ip.id, revision: 2});
        expect((await db.ipProfiles.get(ip.id))?.revision).toBe(2);
    });

    it("material_update_metadata creates the next immutable version while preserving an adopted copy and original file bytes", async () => {
        const project = await createProject("已采用素材项目"), run = await begin(project.id);
        const material = await createFileMaterial(new File(["original-document-bytes"], "guide.txt", {type: "text/plain"}), {kind: "global"});
        const use = await adoptMaterialInProject(material.id, project.id), versions = await db.materialVersions.where("materialId").equals(material.id).toArray();
        const operation = await prepared(run, "material_update_metadata", {materialId: material.id, revision: 1, patch: {name: "拍摄指南", tags: ["对白", "光线"], notes: "已复核"}});
        expect(operation.context.preview?.changes.join("\n")).toContain("现有 1 条采用记录保持原版本");
        expect(await operation.execute()).toMatchObject({material: {id: material.id, name: "拍摄指南", revision: 2}});
        expect(await db.libraryMaterials.get(material.id)).toMatchObject({revision: 2, tags: ["对白", "光线"], notes: "已复核"});
        expect(await db.materialUses.get(use.id)).toEqual(use);
        expect(await (await readBinaryBlob((await db.media.get(use.targetId))!.blob)).text()).toBe("original-document-bytes");
        expect(await db.materialVersions.where("materialId").equals(material.id).count()).toBe(2);
        expect(await db.materialVersions.get(versions[0].id)).toEqual(versions[0]);
        const newest = (await db.materialVersions.where("[materialId+revision]").equals([material.id, 2]).first())!;
        expect(newest.payload.type).toBe("file");
        if (newest.payload.type !== "file") throw new Error("Expected actual versioned file");
        expect(await (await readBinaryBlob(newest.payload.blob)).text()).toBe("original-document-bytes");
    });

    it("music_reuse_work creates a new exact-parameter draft and receipt while retaining the work and media", async () => {
        const project = await createAudioMusicProject("复用音乐项目", "music"), run = await begin(project.id);
        const settings: MusicSettings = {engine: "suno", version: "v6", custom: true, instrumental: false, prompt: "[Verse]\n保存歌词", title: "原作品", style: "木吉他", negativeTags: "噪声", durationSec: 30};
        const work = await addMusicWork(project.id, {mediaId: "reuse-music-source", title: "原作品", notes: "人工备注", favorite: true, lyrics: "保存歌词", settings, durationSec: 30, sampleRate: 48000, channels: 2}, {id: "reuse-music-source", projectId: project.id, filename: "work.wav", mimeType: "audio/wav", blob: new Blob(["music-source-bytes"], {type: "audio/wav"})});
        const countBefore = await db.musicDrafts.count(), operation = await prepared(run, "music_reuse_work", {id: work.id, revision: work.revision});
        const result = await operation.execute() as {id: string; settings: MusicSettings; writeReceipt: unknown};
        expect(result.settings).toEqual(settings);
        expect(result.id).not.toBe(work.id);
        expect(readWriteReceipt(result.writeReceipt)).toMatchObject({entries: [{kind: "music_draft", operation: "created", id: result.id}]});
        expect((await db.musicDrafts.get(result.id))?.settings).toEqual(settings);
        expect(await db.musicDrafts.count()).toBe(countBefore + 1);
        expect(await db.musicWorks.get(work.id)).toEqual(work);
        expect(await (await readBinaryBlob((await db.media.get(work.mediaId))!.blob)).text()).toBe("music-source-bytes");
        await operation.execute();
        expect(await db.musicDrafts.count()).toBe(countBefore + 1);
    });

    it("task_record_read returns actual append-only history with bounded text and completes its ledger atomically", async () => {
        const project = await createProject("任务记录项目"), run = await begin(project.id);
        await invoke(run, "task_create", {title: "明确创作任务", goal: "整理方案与记录", acceptanceCriteria: ["可追溯方案"], steps: [{id: "prepare", title: "整理方案", status: "pending"}], sources: [{type: "message", id: run.userMessageId}]});
        const first = await invoke(run, "task_record_write", {kind: "approach", claim: "proposal", title: "方案版本", body: "第一版完整正文", sources: []}) as {record: {id: string; revision: number}};
        await invoke(run, "task_record_write", {kind: "approach", claim: "proposal", title: "方案版本", body: "第二版完整正文", sources: [], id: first.record.id, expectedRevision: first.record.revision});
        const operation = await prepared(run, "task_record_read", {id: first.record.id, revision: 1, offset: 2, limit: 4});
        expect(await operation.execute()).toMatchObject({record: {id: first.record.id, revision: 1, body: "版完整正"}, totalLength: "第一版完整正文".length, versionCount: 2, versions: [{revision: 1}, {revision: 2}]});
        expect((await db.agentTaskRecords.get(first.record.id))?.body).toBe("第二版完整正文");
        expect(await db.agentTaskRecordVersions.where("recordId").equals(first.record.id).count()).toBe(2);
        expect((await db.agentToolCalls.get(operation.call.id))?.atomic).toBe(true);
    });
});
