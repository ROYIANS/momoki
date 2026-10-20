import {interceptStoreTable} from "./helpers/storeFaults";
import {describe, expect, it, vi} from "vitest";
import JSZip from "jszip";
import {db} from "@/platform/product/store";
import {createAudioMusicProject} from "@/features/projects/commands/projects";
import {addAudioChapter, addAudioSegment, addAudioSpeaker, deleteAudioChapter, deleteAudioSegment, patchAudioSegment, patchAudioSpeaker} from "@/features/audio/commands/audio";
import {deleteChatThread} from "@/features/agent/commands/lifecycle";
import {deleteProject} from "@/features/projects/commands/lifecycle";
import {
    confirmAudioGenerationBatch, controlAudioGenerationBatch, includeAudioBatchItem, prepareAudioGenerationBatch,
    readAudioGenerationBatch, retryFailedAudioBatch
} from "@/features/audio/commands/batches";
import {audioBatchUserAction, pauseAudioGenerationBatches, reconcileAudioBatchHistory, recoverAudioGenerationBatch, startAudioGenerationBatch, stopAudioGenerationBatch} from "@/features/audio/generation/batchRuntime";
import {collectMediaIds, deleteMediaIfOrphan} from "@/features/library/commands/media";
import {exportProjectZip, importProjectZip} from "@/app/workflows/packages/projectPackage";
import {createAgentExecutionService} from "@/features/agent/runtime/agentExecutionService";
import {currentAgentBatchWorks} from "@/features/agent/runtime/threadWork";
import {createChatThread} from "@/features/agent/commands/chat";
import {beginAgentRun, finishAgentRun} from "@/features/agent/commands/agentRuns";
import {transitionToolCall} from "@/features/agent/commands/agentTools";
import {createAgentTaskForThread} from "@/features/agent/commands/agentTasks";
import {getTaskWrapupState} from "@/features/agent/commands/agentTaskWrapups";
import {collectWrapupSnapshot} from "@/features/agent/runtime/wrapupEvidence";
import {ownedTaskAudioGenerationJob, taskAudioGenerationSource} from "@/features/audio/agent/taskEvidence";
import {AUDIO_BATCH_TOOLS} from "@/features/audio/agent/audioBatchTools";
import {registeredTools} from "./helpers/registeredTools";
import {saveFixtureToolRound} from "./helpers/toolDispatch";
import type {ConnectorConfig} from "@/features/settings/models/connector";
import type {ThreadLockManager} from "@/features/agent/runtime/runOwnership";
import type {AgentToolContext} from "@/features/agent/runtime/tools";
import {encodePcm16Wav} from "@/features/audio/engine/wav";

const connector: ConnectorConfig = {id: "batch-apimart", definitionId: "apimart", protocol: "openai-compatible", apiKey: "batch-private-key", baseUrl: "https://audio.example/v1", updatedAt: "2026-10-10"};
const decode = async () => ({durationSec: 2.5, sampleRate: 48000, channels: 1});
const binary = () => new Response(new Uint8Array([82, 73, 70, 70]), {headers: {"Content-Type": "audio/wav"}});
function locks(): ThreadLockManager {
    const held = new Set<string>();
    return {async request(name, _options, callback) {
        if (held.has(name)) return callback(null);
        held.add(name); try {return await callback({});} finally {held.delete(name);}
    }};
}
async function fixture(count = 4) {
    const project = await createAudioMusicProject("配音批次", "audio");
    const chapter = (await db.audioChapters.where("projectId").equals(project.id).first())!;
    await db.connectors.put(connector);
    const speaker = await addAudioSpeaker(project.id, {name: "旁白", voice: "alloy", speed: 1});
    const segments = [];
    for (let order = 0; order < count; order++) segments.push(await addAudioSegment(project.id, {chapterId: chapter.id, text: `段落 ${order}`, speakerId: speaker.id, order, notes: ""}));
    const args = {projectId: project.id, chapterId: chapter.id, segmentIds: segments.map(segment => segment.id)};
    return {project, chapter, speaker, segments, args, locks: locks()};
}
async function ready(f: Awaited<ReturnType<typeof fixture>>) {
    const draft = await prepareAudioGenerationBatch(f.args);
    return confirmAudioGenerationBatch(f.project.id, draft.id, draft.revision);
}
async function agentFixture(count = 2) {
    const f = await fixture(count);
    const thread = await createChatThread({projectId: f.project.id});
    const task = await createAgentTaskForThread(thread.id, {projectId: f.project.id, title:"配音任务", goal:"批量保存真实声音"});
    const run = await beginAgentRun({threadId: thread.id, connector, model: "fixture", content: "准备批量配音"});
    await db.agentRuns.update(run.id, {interactionMode: "smart", permissionMode: "full", enabledToolNames: ["prepare_audio_generation_batch", "audio_read_generation_batch"], toolLoading: undefined});
    const tool = registeredTools(AUDIO_BATCH_TOOLS).find(tool => tool.name === "prepare_audio_generation_batch")!;
    await saveFixtureToolRound(run.id, "", [{id: "audio-batch-origin", type: "function", function: {name: tool.name, arguments: JSON.stringify(f.args)}}], [{title: tool.title, effect: tool.effect, highRisk: false, atomic: true}]);
    const call = (await db.agentToolCalls.where("runId").equals(run.id).first())!;
    await transitionToolCall(run.id, call.id, ["pending"], "running");
    const context: AgentToolContext = {runId: run.id, threadId: thread.id, callId: call.id, projectId: f.project.id, signal: new AbortController().signal};
    const result = await tool.execute(tool.parseArguments(f.args), context) as {batchId: string};
    await finishAgentRun(run.id, "completed");
    return {...f, thread, task, run, call, context, id: result.batchId};
}

describe("durable reviewed audio batches", () => {
    it.each([1, 11, 20])("prepares %i immutable items without jobs, keys, selection or POST", async count => {
        const f = await fixture(count), fetchImpl = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetchImpl);
        try {
            const batch = await prepareAudioGenerationBatch(f.args), view = await readAudioGenerationBatch(f.project.id, batch.id);
            expect(view.items).toHaveLength(count); expect(new Set(view.items.map(item => item.intentId)).size).toBe(count);
            expect(view.items.every(item => item.snapshot.input.voice === "alloy" && item.snapshot.input.segmentRevision === 1)).toBe(true);
            expect(JSON.stringify(view)).not.toContain(connector.apiKey);
            expect(await db.audioGenerationJobs.count()).toBe(0); expect(await db.audioTakes.count()).toBe(0); expect(await db.audioClips.count()).toBe(0); expect(fetchImpl).not.toHaveBeenCalled();
        } finally {vi.unstubAllGlobals();}
    });
    it("rejects empty, 21, duplicate, foreign and empty-text selections atomically", async () => {
        const f = await fixture(21), other = await fixture(1);
        for (const segmentIds of [[], f.args.segmentIds, [f.segments[0].id, f.segments[0].id], [other.segments[0].id]]) await expect(prepareAudioGenerationBatch({...f.args, segmentIds})).rejects.toThrow();
        await patchAudioSegment(f.project.id, f.segments[0].id, 1, {text: ""});
        await expect(prepareAudioGenerationBatch({...f.args, segmentIds: [f.segments[0].id]})).rejects.toThrow("第 1");
        expect(await db.audioGenerationBatches.count()).toBe(0); expect(await db.audioGenerationBatchItems.count()).toBe(0);
    });
    it("confirms only a reviewed subset with CAS, and rejects double-confirm and draft dispatch", async () => {
        const f = await fixture(), draft = await prepareAudioGenerationBatch(f.args), view = await readAudioGenerationBatch(f.project.id, draft.id);
        const fetchImpl = vi.fn<typeof fetch>(async () => binary());
        await expect(startAudioGenerationBatch(f.project.id, draft.id, {locks: f.locks, fetchImpl, decode})).rejects.toThrow("确认");
        const excluded = await includeAudioBatchItem(f.project.id, draft.id, draft.revision, view.items[1].id, false);
        await expect(confirmAudioGenerationBatch(f.project.id, draft.id, draft.revision)).rejects.toThrow("修改");
        const outcomes = await Promise.allSettled([confirmAudioGenerationBatch(f.project.id, draft.id, excluded.revision), confirmAudioGenerationBatch(f.project.id, draft.id, excluded.revision)]);
        expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
        const pauses:string[]=[],pause=interceptStoreTable(db,"audioGenerationBatches","put",async (_tx,args,next)=> {const row=args[0] as {status:string;pauseReason?:string};if (row.status === "paused") pauses.push(row.pauseReason ?? "");return next();});
        try {await startAudioGenerationBatch(f.project.id, draft.id, {locks: f.locks, fetchImpl, decode});}finally {pause.mockRestore();}
        const completed=await readAudioGenerationBatch(f.project.id,draft.id);
        expect(fetchImpl,JSON.stringify({pauses,jobs:completed.jobs.map(job=>({status:job.status,error:job.error}))})).toHaveBeenCalledTimes(3); expect(completed.counts).toMatchObject({saved: 3, cancelled: 1});
    });
    it.each(["segment", "speaker", "credential", "destination"] as const)("rejects stale %s before any paid effects", async change => {
        const f = await fixture(1), draft = await prepareAudioGenerationBatch(f.args);
        if (change === "segment") await patchAudioSegment(f.project.id, f.segments[0].id, 1, {text: "changed"});
        if (change === "speaker") await patchAudioSpeaker(f.project.id, f.speaker.id, 1, {voice: "echo"});
        if (change === "credential") await db.connectors.update(connector.id, {apiKey: "rotated"});
        if (change === "destination") await db.connectors.update(connector.id, {baseUrl: "https://other.example/v1"});
        await expect(confirmAudioGenerationBatch(f.project.id, draft.id, draft.revision)).rejects.toThrow("变化");
        expect(await db.audioGenerationJobs.count()).toBe(0);
    });
    it("bounds real transport to two workers and reports 9 saved / 1 failed / 1 awaiting response", async () => {
        const f = await fixture(11), batch = await ready(f);
        let active = 0, maximum = 0, posts = 0, releaseLast: (() => void) | undefined;
        const fetchImpl = vi.fn<typeof fetch>(async () => {
            active++; maximum = Math.max(maximum, active); const index = ++posts;
            if (index === 11) await new Promise<void>(resolve => {releaseLast = resolve;});
            active--;
            return index === 10 ? Response.json({error: {message: "invalid text"}}, {status: 400}) : binary();
        });
        const running = startAudioGenerationBatch(f.project.id, batch.id, {locks: f.locks, fetchImpl, decode});
        try {
            await vi.waitFor(async () => expect((await readAudioGenerationBatch(f.project.id, batch.id)).counts).toMatchObject({saved: 9, failed: 1, submitting: 1}),{timeout:10000});
            expect(maximum).toBeLessThanOrEqual(2); expect(posts).toBe(11);
            const reload = await readAudioGenerationBatch(f.project.id, batch.id);
            expect(reload.rows.filter(row => row.selected || row.placed)).toHaveLength(0); expect(fetchImpl).toHaveBeenCalledTimes(11);
        } finally {releaseLast?.(); await running;}
        expect((await readAudioGenerationBatch(f.project.id, batch.id)).counts).toMatchObject({saved: 10, failed: 1});
    });
    it("creates only selected definite failures as new unconfirmed intents, excluding all successful items", async () => {
        const f = await fixture(4), batch = await ready(f); let posts = 0;
        const fetchImpl = vi.fn<typeof fetch>(async () => ++posts === 2 || posts === 3 ? Response.json({error: {message: "rejected"}}, {status: 422}) : binary());
        await startAudioGenerationBatch(f.project.id, batch.id, {locks: f.locks, fetchImpl, decode});
        const view = await readAudioGenerationBatch(f.project.id, batch.id), failed = view.rows.filter(row => row.state === "failed"), saved = view.rows.find(row => row.state === "saved")!;
        await expect(retryFailedAudioBatch(f.project.id, batch.id, [saved.item.id])).rejects.toThrow("明确");
        const retry = await retryFailedAudioBatch(f.project.id, batch.id, [failed[0].item.id]);
        expect(retry).toMatchObject({status: "draft", confirmedItemIds: [], retrySourceBatchId: batch.id}); expect(retry.confirmedAt).toBeUndefined();
        const next = await readAudioGenerationBatch(f.project.id, retry.id); expect(next.items).toHaveLength(1); expect(next.items[0].intentId).not.toBe(failed[0].item.intentId);
        expect(posts).toBe(4); await confirmAudioGenerationBatch(f.project.id, retry.id, retry.revision);
        await startAudioGenerationBatch(f.project.id, retry.id, {locks: f.locks, fetchImpl, decode}); expect(posts).toBe(5);
        expect(await db.audioTakes.count()).toBe(3);
    });
    it.each(["network", "server"] as const)("pauses uncertain %s acceptance and never offers paid retry or reload replay", async kind => {
        const f = await fixture(5), batch = await ready(f);
        const fetchImpl = vi.fn<typeof fetch>(async () => {if (kind === "network") throw new Error("lost reply"); return new Response("gateway", {status: 503});});
        await startAudioGenerationBatch(f.project.id, batch.id, {locks: f.locks, fetchImpl, decode});
        const view = await readAudioGenerationBatch(f.project.id, batch.id); expect(view.counts.uncertain).toBeGreaterThan(0); expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(2);
        await expect(retryFailedAudioBatch(f.project.id, batch.id, [view.items[0].id])).rejects.toThrow("明确");
        const posts = fetchImpl.mock.calls.length; await reconcileAudioBatchHistory(f.project.id, batch.id, f.locks); await recoverAudioGenerationBatch(f.project.id, batch.id, {locks: f.locks, fetchImpl, decode});
        await expect(startAudioGenerationBatch(f.project.id, batch.id, {locks: f.locks, fetchImpl, decode})).rejects.toThrow("不确定"); expect(fetchImpl).toHaveBeenCalledTimes(posts);
    });
    it("recovers stored bytes locally without POST and excludes decode failures from paid retry", async () => {
        const f = await fixture(2), batch = await ready(f), fetchImpl = vi.fn<typeof fetch>(async () => binary());
        await startAudioGenerationBatch(f.project.id, batch.id, {locks: f.locks, fetchImpl, decode: async () => {throw new Error("decoder unavailable");}});
        const view = await readAudioGenerationBatch(f.project.id, batch.id); expect(view.counts.recovery).toBe(2);
        await expect(retryFailedAudioBatch(f.project.id, batch.id, [view.items[0].id])).rejects.toThrow("明确");
        await recoverAudioGenerationBatch(f.project.id, batch.id, {locks: f.locks, fetchImpl, decode});
        expect((await readAudioGenerationBatch(f.project.id, batch.id)).counts.saved).toBe(2); expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
    it("latches pause on failed storage and drains the in-flight sibling before releasing ownership", async () => {
        const f = await fixture(5), batch = await ready(f);
        const releases: Array<() => void> = [];
        const fetchImpl = vi.fn<typeof fetch>(async () => new Promise(resolve => {const index = releases.length; releases.push(() => resolve(index === 0 ? new Response("server", {status: 503}) : binary()));}));
        let pauseFailed = false;
        const spy = interceptStoreTable(db, "audioGenerationBatches", "put", async (_tx,args,next)=> {const [row]=args as Parameters<typeof db.audioGenerationBatches.put>;if (row.status === "paused") {pauseFailed = true; return Promise.reject(new Error("disk unavailable"));} return next(); });
        const running = startAudioGenerationBatch(f.project.id, batch.id, {locks: f.locks, fetchImpl, decode}).catch(() => undefined);
        try {
            await vi.waitFor(() => expect(releases).toHaveLength(2)); releases[0]();
            await vi.waitFor(() => expect(pauseFailed).toBe(true));
            let acquired = false; await f.locks.request(`cuepoint.audio-batch.${batch.id}`, {ifAvailable: true}, async lock => {acquired = !!lock;});
            expect(acquired).toBe(false); expect(fetchImpl).toHaveBeenCalledTimes(2);
        } finally {releases.forEach(release => release()); await running; spy.mockRestore();}
        expect(fetchImpl).toHaveBeenCalledTimes(2); expect(await db.audioTakes.count()).toBe(1);
    });
    it("holds an exclusive batch lock and refuses cross-tab duplicate dispatch", async () => {
        const f = await fixture(2), batch = await ready(f), held = f.locks;
        const fetchImpl = vi.fn<typeof fetch>();
        await held.request(`cuepoint.audio-batch.${batch.id}`, {ifAvailable: true}, async () => {
            await expect(startAudioGenerationBatch(f.project.id, batch.id, {locks: held, fetchImpl, decode})).rejects.toThrow("另一个");
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it("fails closed without cross-tab Web Locks and does not claim or submit jobs", async () => {
        const f = await fixture(1), batch = await ready(f), network = vi.fn<typeof fetch>();
        vi.stubGlobal("navigator", {});
        try {
            await expect(startAudioGenerationBatch(f.project.id, batch.id, {fetchImpl: network, decode})).rejects.toThrow("Web Locks");
            expect(await db.audioGenerationJobs.count()).toBe(0); expect(network).not.toHaveBeenCalled();
        } finally {vi.unstubAllGlobals();}
    });
    it("does not host control writes before the registered dispatcher actually acquires ownership", async () => {
        const f = await fixture(1), batch = await ready(f);
        let release: (() => void) | undefined;
        let requested = false;
        const delayedLocks: ThreadLockManager = {async request(_name, _options, callback) {
            requested = true;
            await new Promise<void>(resolve => {release = resolve;});
            return callback(null);
        }};
        const running = startAudioGenerationBatch(f.project.id, batch.id, {locks: delayedLocks, fetchImpl: vi.fn(), decode});
        const refused = expect(running).rejects.toThrow("另一个");
        await vi.waitFor(() => expect(requested).toBe(true));
        const control = vi.fn(async () => controlAudioGenerationBatch(f.project.id, batch.id, "cancel"));
        const action = audioBatchUserAction(f.project.id, batch.id, control, f.locks);
        const actionRefused = expect(action).rejects.toThrow("另一个");
        await Promise.resolve();
        expect(control).not.toHaveBeenCalled();
        expect((await readAudioGenerationBatch(f.project.id, batch.id)).batch.status).toBe("ready");
        release?.();
        await refused; await actionRefused;
        expect(control).not.toHaveBeenCalled();
        expect((await readAudioGenerationBatch(f.project.id, batch.id)).counts.queued).toBe(1);
    });
    it("cancel preserves accepted outputs and prevents every unsent item", async () => {
        const f = await fixture(3), batch = await ready(f);
        await controlAudioGenerationBatch(f.project.id, batch.id, "cancel");
        await expect(startAudioGenerationBatch(f.project.id, batch.id, {locks: f.locks, fetchImpl: vi.fn(), decode})).rejects.toThrow("确认");
        expect((await readAudioGenerationBatch(f.project.id, batch.id)).counts.cancelled).toBe(3);
    });
    it("Stop interrupts two live requests, keeps their uncertain identities and cancels only unsent work", async () => {
        const f = await fixture(5), batch = await ready(f);
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {init?.signal?.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")), {once: true});}));
        const running = startAudioGenerationBatch(f.project.id, batch.id, {locks: f.locks, fetchImpl, decode});
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
        await stopAudioGenerationBatch(f.project.id, batch.id, "cancel", f.locks); await running;
        const view = await readAudioGenerationBatch(f.project.id, batch.id);
        expect(view.counts).toMatchObject({uncertain: 2, cancelled: 3}); expect(view.jobs).toHaveLength(2);
        await expect(startAudioGenerationBatch(f.project.id, batch.id, {locks: f.locks, fetchImpl, decode})).rejects.toThrow("确认"); expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
    it("rechecks queued credentials before each send and preserves already returned sibling bytes", async () => {
        const f = await fixture(5), batch = await ready(f); let posts = 0;
        const fetchImpl = vi.fn<typeof fetch>(async () => {posts++; await db.connectors.update(connector.id, {apiKey: "changed-during-first-request"}); return binary();});
        await startAudioGenerationBatch(f.project.id, batch.id, {locks: f.locks, fetchImpl, decode});
        expect(posts).toBeLessThanOrEqual(2); expect(posts).toBeGreaterThan(0);
        const view = await readAudioGenerationBatch(f.project.id, batch.id); expect(view.counts.saved).toBe(posts); expect(view.batch.status).toBe("paused");
        expect(view.rows.filter(row => row.state === "queued").length).toBeGreaterThan(0);
    });
    it("freezes real clone bytes, retains references in cancelled history and fails a changed clone before confirmation", async () => {
        const f = await fixture(1);
        const blob = encodePcm16Wav({length: 16, sampleRate: 48000, numberOfChannels: 1, getChannelData: () => new Float32Array(16)}).blob;
        await db.connectors.put({id: "batch-mimo", definitionId: "mimo", protocol: "openai-compatible", apiKey: "private-mimo", baseUrl: "https://mimo.example/v1", updatedAt: "now"});
        await db.media.add({id: "reference", projectId: f.project.id, blob, mimeType: "audio/wav", filename: "reference.wav"});
        await patchAudioSpeaker(f.project.id, f.speaker.id, f.speaker.revision, {voice: "mimo_default", mimo: {mode: "clone", instruction: "", referenceMediaId: "reference"}});
        const draft = await prepareAudioGenerationBatch(f.args); const before = await readAudioGenerationBatch(f.project.id, draft.id);
        expect(before.items[0].snapshot.referenceFingerprint).toMatch(/^[a-f0-9]{64}$/);
        await db.media.update("reference", {blob: new Blob([blob, new Uint8Array([1])], {type: "audio/wav"})});
        await expect(confirmAudioGenerationBatch(f.project.id, draft.id, draft.revision)).rejects.toThrow("变化");
        await db.audioSpeakers.update(f.speaker.id, {mimo: undefined}); await controlAudioGenerationBatch(f.project.id, draft.id, "cancel");
        await deleteMediaIfOrphan("reference"); expect(await db.media.get("reference")).toBeTruthy(); expect(await collectMediaIds(f.project.id)).toContain("reference");
        const imported = await importProjectZip(await exportProjectZip(f.project.id));
        const item = (await db.audioGenerationBatchItems.where("projectId").equals(imported.id).first())!;
        expect(item.snapshot.input.mimo?.referenceMediaId).not.toBe("reference"); expect(await db.media.get(item.snapshot.input.mimo!.referenceMediaId!)).toBeTruthy();
    });
    it("reconciles abandoned claimed records without POST and retains remaining confirmed unsent items", async () => {
        const f = await fixture(3), batch = await ready(f);
        await controlAudioGenerationBatch(f.project.id, batch.id, "run");
        const {linkAudioBatchJob} = await import("@/features/audio/commands/batches");
        const item = (await readAudioGenerationBatch(f.project.id, batch.id)).items[0], job = (await linkAudioBatchJob(f.project.id, batch.id, item.id))!;
        const {claimAudioGenerationJob} = await import("@/features/audio/commands/generation"); await claimAudioGenerationJob(f.project.id, job.id, job.revision, "abandoned");
        const network = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", network);
        try {
            await reconcileAudioBatchHistory(f.project.id, batch.id, f.locks);
            expect(network).not.toHaveBeenCalled(); const view = await readAudioGenerationBatch(f.project.id, batch.id);
            expect(view.counts).toMatchObject({uncertain: 1, queued: 2}); expect(view.batch.status).toBe("paused");
        } finally {vi.unstubAllGlobals();}
    });
    it("retains cancelled clone references, rejects deleted owners and rejects late take resurrection", async () => {
        const f = await fixture(1), batch = await ready(f);
        let release: (() => void) | undefined;
        const fetchImpl = vi.fn<typeof fetch>(async () => {await new Promise<void>(resolve => {release = resolve;}); return binary();});
        const running = startAudioGenerationBatch(f.project.id, batch.id, {locks: f.locks, fetchImpl, decode}).catch(() => undefined);
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
        await addAudioChapter(f.project.id, {title: "保留章节", order: 1}); await deleteAudioChapter(f.project.id, f.chapter.id, f.chapter.revision);
        release?.(); await running;
        expect(await db.audioGenerationBatches.count()).toBe(0); expect(await db.audioTakes.count()).toBe(0); expect(await db.audioGenerationBatchItems.count()).toBe(0);
        expect(await exportProjectZip(f.project.id)).toBeInstanceOf(Blob);
        await deleteProject(f.project.id); expect(await db.audioGenerationJobs.count()).toBe(0);
    });
    it("round-trips dormant batch history with remapped ownership, input, result and intent identity", async () => {
        const f = await fixture(2), batch = await ready(f), fetchImpl = vi.fn<typeof fetch>(async () => binary());
        await startAudioGenerationBatch(f.project.id, batch.id, {locks: f.locks, fetchImpl, decode});
        const imported = await importProjectZip(await exportProjectZip(f.project.id));
        const history = (await db.audioGenerationBatches.where("projectId").equals(imported.id).first())!;
        const view = await readAudioGenerationBatch(imported.id, history.id);
        expect(history).toMatchObject({dormant: true, owner: {kind: "manual"}, confirmedItemIds: []}); expect(history.confirmedAt).toBeUndefined();
        expect(history.id).not.toBe(batch.id); expect(view.items).toHaveLength(2); expect(view.counts.saved).toBe(2);
        for (const row of view.rows) {
            expect(row.job?.source).toMatchObject({kind: "batch", batchId: history.id, itemId: row.item.id}); expect(row.job?.intentId).toBe(row.item.intentId);
            expect(row.item.snapshot.input.segmentId).toBe(row.item.segmentId); expect(row.job?.input).toMatchObject({segmentId: row.item.segmentId});
        }
        await expect(confirmAudioGenerationBatch(imported.id, history.id, history.revision)).rejects.toThrow("历史");
        await expect(startAudioGenerationBatch(imported.id, history.id, {locks: f.locks, fetchImpl, decode})).rejects.toThrow("历史"); expect(fetchImpl).toHaveBeenCalledTimes(2);
        const zip = await JSZip.loadAsync(await exportProjectZip(f.project.id)); expect(JSON.stringify(zip.files)).not.toContain(connector.apiKey);
    });
    it("exports a draft after segment deletion as historical identity without recreating the segment", async () => {
        const f = await fixture(1), draft = await prepareAudioGenerationBatch(f.args);
        await deleteAudioSegment(f.project.id, f.segments[0].id, 1);
        await expect(confirmAudioGenerationBatch(f.project.id, draft.id, draft.revision)).rejects.toThrow();
        const imported = await importProjectZip(await exportProjectZip(f.project.id));
        expect(await db.audioSegments.where("projectId").equals(imported.id).count()).toBe(0);
        expect(await db.audioGenerationBatchItems.where("projectId").equals(imported.id).count()).toBe(1);
    });
    it("saved output deletion remains unavailable history and never regenerates on explicit continuation", async () => {
        const f = await fixture(1), batch = await ready(f), fetchImpl = vi.fn<typeof fetch>(async () => binary());
        await startAudioGenerationBatch(f.project.id, batch.id, {locks: f.locks, fetchImpl, decode});
        const before = await readAudioGenerationBatch(f.project.id, batch.id), take = (await db.audioTakes.get(before.jobs[0].results[0].takeId!))!;
        const {deleteAudioTake} = await import("@/features/audio/commands/audio"); await deleteAudioTake(f.project.id, take.id, take.revision);
        await startAudioGenerationBatch(f.project.id, batch.id, {locks: f.locks, fetchImpl, decode});
        const view = await readAudioGenerationBatch(f.project.id, batch.id); expect(view.counts.unavailable).toBe(1); expect(await db.audioTakes.count()).toBe(0); expect(fetchImpl).toHaveBeenCalledOnce();
    });
    it.each(["media-reference", "provenance", "empty-media", "job-source", "item-segment"] as const)("does not report a saved result after %s corruption", async invalid => {
        const f = await fixture(1), batch = await ready(f), fetchImpl = vi.fn<typeof fetch>(async () => binary());
        await startAudioGenerationBatch(f.project.id, batch.id, {locks: f.locks, fetchImpl, decode});
        const before = await readAudioGenerationBatch(f.project.id, batch.id), job = before.jobs[0];
        const take = (await db.audioTakes.get(job.results[0].takeId!))!;
        if (invalid === "media-reference") await db.audioTakes.update(take.id, {mediaId: "unrelated-media"});
        if (invalid === "provenance") await db.audioTakes.update(take.id, {provenance: {...take.provenance!, jobId: "unrelated-job"}});
        if (invalid === "empty-media") await db.media.update(take.mediaId, {blob: new Blob([], {type: "audio/wav"})});
        if (invalid === "job-source") await db.audioGenerationJobs.update(job.id, {source: {kind: "manual"}});
        if (invalid === "item-segment") await db.audioGenerationBatchItems.update(before.items[0].id, {segmentId: "unrelated-segment"});
        const view = await readAudioGenerationBatch(f.project.id, batch.id);
        expect(view.counts.saved).toBe(0); expect(view.counts.unavailable).toBe(1); expect(view.rows[0]).toMatchObject({selected: false, placed: false});
        expect(fetchImpl).toHaveBeenCalledOnce();
    });
});

describe("Agent batch preparation, evidence and completion", () => {
    it("retains Agent-owned audio through project teardown and admits the first service observer", async () => {
        const f = await agentFixture(1), draft = (await readAudioGenerationBatch(f.project.id, f.id)).batch;
        await confirmAudioGenerationBatch(f.project.id, f.id, draft.revision);
        let enter!: () => void, release!: () => void, signal!: AbortSignal;
        const entered = new Promise<void>(resolve => {enter = resolve;}), held = new Promise<void>(resolve => {release = resolve;});
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {signal = init!.signal!; enter(); await held; return binary();});
        const running = startAudioGenerationBatch(f.project.id, f.id, {agentThreadId: f.thread.id, locks: f.locks, fetchImpl, decode});
        const owner = createAgentExecutionService({store: db});
        // The batch runs under its own lock: the conversation is not busy, only the batch is a live worker.
        expect(owner.snapshot(f.thread.id).active).toBe(false);
        expect(currentAgentBatchWorks(db, f.thread.id)).toEqual([expect.objectContaining({identity: expect.objectContaining({kind: "audioBatch", batchId: f.id})})]);
        await entered;
        pauseAudioGenerationBatches({projectId: f.project.id, projectOnly: true});
        expect(signal.aborted).toBe(false);
        release(); await running;
        expect((await readAudioGenerationBatch(f.project.id, f.id)).counts.saved).toBe(1);
        expect(owner.snapshot(f.thread.id).active).toBe(false); expect(currentAgentBatchWorks(db, f.thread.id)).toEqual([]); expect(fetchImpl).toHaveBeenCalledOnce();
    });
    it("writes preparation and its real ledger result atomically, without granting paid approval", async () => {
        const f = await agentFixture(); const call = await db.agentToolCalls.get(f.call.id);
        expect(call?.status).toBe("completed"); expect(JSON.parse(call!.result!)).toMatchObject({batchId: f.id, submitted: false, confirmed: false});
        const prepared = JSON.parse(call!.result!);
        expect(prepared.items.every((item: {auditionVerification: string}) => item.auditionVerification === "not_checked")).toBe(true);
        expect(prepared.items.some((item: object) => "auditioned" in item)).toBe(false);
        const reader = registeredTools(AUDIO_BATCH_TOOLS).find(tool => tool.name === "audio_read_generation_batch")!;
        const read = await reader.execute(reader.parseArguments({batchId: f.id}), f.context) as {items: Array<{auditionVerification: string}>; note: string};
        expect(read.items.every(item => item.auditionVerification === "not_checked")).toBe(true);
        expect(read.note).toContain("不代表用户没有听过");
        expect(await db.audioGenerationJobs.count()).toBe(0);
        expect((await getTaskWrapupState(f.task.id)).completionBlockers).toContain("批量配音还有未确认草稿、排队或待核实结果");
        const before = await collectWrapupSnapshot(f.task); const batch = (await readAudioGenerationBatch(f.project.id, f.id)).batch;
        await confirmAudioGenerationBatch(f.project.id, f.id, batch.revision);
        const after = await collectWrapupSnapshot(f.task); expect(after.fingerprint).not.toBe(before.fingerprint);
    });
    it("uses confirmed origin and per-item output proof, never preparation as generation evidence", async () => {
        const f = await agentFixture(); const batch = (await readAudioGenerationBatch(f.project.id, f.id)).batch;
        await confirmAudioGenerationBatch(f.project.id, f.id, batch.revision);
        await startAudioGenerationBatch(f.project.id, f.id, {locks: f.locks, fetchImpl: vi.fn(async () => binary()), decode});
        const view = await readAudioGenerationBatch(f.project.id, f.id), job = view.jobs[0];
        expect(await ownedTaskAudioGenerationJob(f.task, job)).toBe(true);
        const source = await taskAudioGenerationSource(f.task, job, job.results[0].key); expect(source).toMatchObject({available: true, supportsResult: true, applied: false});
        await db.audioGenerationBatchItems.update(view.items[0].id, {included: false}); expect(await ownedTaskAudioGenerationJob(f.task, job)).toBe(false);
    });
    it("keeps all pending batch items in completion blockers even when one sibling result is saved", async () => {
        const f = await agentFixture(3), batch = (await readAudioGenerationBatch(f.project.id, f.id)).batch;
        await confirmAudioGenerationBatch(f.project.id, f.id, batch.revision); let posts = 0;
        const fetchImpl = vi.fn<typeof fetch>(async () => {if (++posts === 2) throw new Error("lost reply"); return binary();});
        await startAudioGenerationBatch(f.project.id, f.id, {locks: f.locks, fetchImpl, decode});
        const view = await readAudioGenerationBatch(f.project.id, f.id); expect(view.counts.saved).toBe(1); expect(view.counts.uncertain).toBe(1);
        const before = await collectWrapupSnapshot(f.task); expect((await getTaskWrapupState(f.task.id)).completionBlockers).toContain("批量配音还有未确认草稿、排队或待核实结果");
        await db.audioGenerationBatchItems.update(view.items[2].id, {state: "cancelled"}); const after = await collectWrapupSnapshot(f.task); expect(after.fingerprint).not.toBe(before.fingerprint);
        expect((await getTaskWrapupState(f.task.id)).completionBlockers).toContain("批量配音还有未确认草稿、排队或待核实结果");
    });
    it.each(["confirmed", "membership", "state", "chapter", "segment", "intent", "origin"] as const)("rejects forged %s source linkage", async invalid => {
        const f = await agentFixture(1), draft = (await readAudioGenerationBatch(f.project.id, f.id)).batch;
        await confirmAudioGenerationBatch(f.project.id, f.id, draft.revision); await startAudioGenerationBatch(f.project.id, f.id, {locks: f.locks, fetchImpl: vi.fn(async () => binary()), decode});
        const view = await readAudioGenerationBatch(f.project.id, f.id), item = view.items[0], job = view.jobs[0];
        if (invalid === "confirmed") await db.audioGenerationBatches.update(f.id, {confirmedAt: undefined});
        if (invalid === "membership") await db.audioGenerationBatches.update(f.id, {itemIds: []});
        if (invalid === "state") await db.audioGenerationBatchItems.update(item.id, {state: "queued"});
        if (invalid === "chapter") await db.audioGenerationBatchItems.update(item.id, {chapterId: "foreign"});
        if (invalid === "segment") await db.audioGenerationBatchItems.update(item.id, {segmentId: "foreign"});
        if (invalid === "intent") await db.audioGenerationBatchItems.update(item.id, {intentId: "foreign"});
        if (invalid === "origin") await db.audioGenerationBatches.update(f.id, {sourceCallId: "forged", retrySourceBatchId: "retry"});
        expect(await ownedTaskAudioGenerationJob(f.task, job)).toBe(false);
    });
    it("rejects newer execution and disabled/conversation scope before batch confirmation", async () => {
        const f = await agentFixture(1), batch = (await readAudioGenerationBatch(f.project.id, f.id)).batch;
        await db.agentRuns.update(f.run.id, {enabledToolNames: []}); await expect(confirmAudioGenerationBatch(f.project.id, f.id, batch.revision)).rejects.toThrow("未启用");
        await db.agentRuns.update(f.run.id, {enabledToolNames: ["prepare_audio_generation_batch"], interactionMode: "conversation"}); await expect(confirmAudioGenerationBatch(f.project.id, f.id, batch.revision)).rejects.toThrow("未启用");
        await db.agentRuns.update(f.run.id, {interactionMode: "smart"}); await beginAgentRun({threadId: f.thread.id, connector, model: "fixture", content: "新任务"});
        await expect(confirmAudioGenerationBatch(f.project.id, f.id, batch.revision)).rejects.toThrow("较早"); expect(await db.audioGenerationJobs.count()).toBe(0);
    });
    it("preserves outputs after chat deletion as dormant project history", async () => {
        const f = await agentFixture(1), draft = (await readAudioGenerationBatch(f.project.id, f.id)).batch;
        await confirmAudioGenerationBatch(f.project.id, f.id, draft.revision); await startAudioGenerationBatch(f.project.id, f.id, {locks: f.locks, fetchImpl: vi.fn(async () => binary()), decode});
        await deleteChatThread(f.thread.id);
        const view = await readAudioGenerationBatch(f.project.id, f.id); expect(view.batch.dormant).toBe(true); expect(view.counts.saved).toBe(1);
        expect(await collectMediaIds(f.project.id)).toContain(view.jobs[0].results[0].mediaId);
        await deleteMediaIfOrphan(view.jobs[0].results[0].mediaId); expect(await db.audioTakes.count()).toBe(1);
    });
});
