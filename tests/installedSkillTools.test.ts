import {afterEach, describe, expect, it, vi} from "vitest";
import {db} from "@/platform/product/store";
import {createBrowserProductStore} from "@/platform/storage/browser";
import {browserDatabase} from "@/platform/storage/browserDatabase";
import {UnknownCommitError} from "@/platform/storage/errors";
import {createChatThread} from "@/features/agent/commands/chat";
import {deleteChatThread} from "@/features/agent/commands/lifecycle";
import {beginAgentRun} from "@/features/agent/commands/agentRuns";
import {updateGeneralAgentConfig} from "@/features/agent/commands/agentSettings";
import {saveToolRound, startModelStep, transitionToolCall} from "@/features/agent/commands/agentTools";
import {BUILTIN_TOOLS, validateToolCall} from "@/features/agent/runtime/tools";
import {createToolLoading, getOfferedToolNames} from "@/features/agent/runtime/toolLoading";
import {selectCapabilityGroups} from "@momoki/agent-core";
import {installedSkillInstructions, INSTALLED_SKILL_TOOL_NAMES} from "@/features/agent/skills/runtime/disclosure";
import {prepareSkillImport} from "@/features/agent/skills/runtime/package";
import {installSkill} from "@/features/agent/skills/commands/installations";
import {getInstalledSkillCatalogue} from "@/features/agent/skills/queries/installedSkills";
import {skillBodyKey, skillManifestKey, skillResourceKey} from "@/features/agent/skills/runtime/records";
import type {AgentRun, AgentToolCall, AgentWireToolCall} from "@/features/agent/models/agent";
import type {AgentToolContext} from "@/features/agent/runtime/toolDefinition";
import type {SkillImportCandidate} from "@/features/agent/skills/models/installedSkill";
import type {ConnectorConfig} from "@/features/settings/models/connector";
import type {ProductStore} from "@/platform/storage/types";
import {interceptStoreTable} from "./helpers/storeFaults";

const connector: ConnectorConfig = {id: "skill-tools", definitionId: "openai-compatible", protocol: "openai-compatible", baseUrl: "https://example.test/v1", apiKey: "secret", updatedAt: "2026-10-16"};
const encode = (text: string) => new TextEncoder().encode(text);
function candidate(body = "# 仅在被请求后读取的正文\n不授予权限。", resource = "甲😀乙\n后续资料", name = "scene-flow"): SkillImportCandidate {
    return prepareSkillImport(name, [
        {path: "SKILL.md", bytes: encode(`---\nname: ${name}\ndescription: 仅目录元数据\nallowed-tools: arbitrary_shell\n---\n${body}`)},
        {path: "references/a.md", bytes: encode(resource)},
        {path: "references/b.md", bytes: encode("不应被加载的另一份资料")},
    ]);
}
async function begin(input = candidate(), store: ProductStore = db) {
    await updateGeneralAgentConfig({permissionMode: "full", enabledSkillIds: ["workspace", "planning", "business-read", "story-edit", "asset-edit"]}, store);
    const catalogue = await getInstalledSkillCatalogue(store);
    await installSkill({operationId: `install_${catalogue.revision}`, catalogueRevision: catalogue.revision, candidate: input, enabled: true}, store);
    const thread = await createChatThread(undefined, store);
    const run = await beginAgentRun({threadId: thread.id, connector, model: "test-model", content: "按技能规划镜头"}, store);
    const descriptor = run.installedSkills!.entries.find(entry => entry.metadata.name === input.directoryName)!;
    return {run, descriptor, input, store};
}
const wire = (name: string, args: unknown, id: string): AgentWireToolCall => ({id, type: "function", function: {name, arguments: JSON.stringify(args)}});
async function record(run: AgentRun, calls: Array<{name: string; args: unknown}>, store: ProductStore = db) {
    const current = await startModelStep(run.id, 32, store);
    const wireCalls = calls.map((call, index) => wire(call.name, call.args, `wire_${current.modelStep}_${index}`));
    await saveToolRound(run.id, "", wireCalls, calls.map(call => {
        const tool = BUILTIN_TOOLS.find(tool => tool.name === call.name)!;
        return {title: tool.title, effect: tool.effect, highRisk: false, atomic: tool.atomic};
    }), undefined, undefined, store);
    return (await store.agentToolCalls.where("runId").equals(run.id).toArray()).filter(call => call.step === current.modelStep).sort((a, b) => a.order - b.order);
}
async function execute(call: AgentToolCall, store: ProductStore = db, controller = new AbortController(), overrides: Partial<AgentToolContext> = {}) {
    const run = (await store.agentRuns.get(call.runId))!;
    if (call.status === "pending") await transitionToolCall(run.id, call.id, ["pending"], "running", undefined, store);
    const {tool, args} = validateToolCall(call.name, call.arguments, run.enabledToolNames ?? []);
    return tool.execute(args, {runId: run.id, threadId: run.threadId, projectId: run.projectId, callId: call.id, signal: controller.signal, store, ...overrides});
}
afterEach(() => vi.restoreAllMocks());

describe("captured installed skill read tools", () => {
    it("advertises metadata without bodies or resource hydration and keeps permission advisory inert", async () => {
        const {run, descriptor} = await begin();
        const instructions = installedSkillInstructions(run.installedSkills);
        expect(instructions).toContain(descriptor.skillId);
        expect(instructions).toContain("仅目录元数据");
        expect(instructions).not.toContain("仅在被请求后读取");
        expect(instructions).not.toContain("arbitrary_shell");
        expect(instructions).not.toContain("另一份资料");
        expect(run.enabledToolNames).toEqual(expect.arrayContaining([...INSTALLED_SKILL_TOOL_NAMES]));
        expect(run.enabledToolNames).not.toContain("arbitrary_shell");
        expect(installedSkillInstructions()).toBe("");
        expect(installedSkillInstructions({version: 1, entries: []})).toBe("");
    });

    it("persists same-round load then paged resource results atomically while reading only selected rows", async () => {
        const {run, descriptor} = await begin();
        const [load, resource] = await record(run, [{name: "load_skill", args: {skillId: descriptor.skillId}},
            {name: "read_skill_resource", args: {skillId: descriptor.skillId, path: "references/a.md", offset: 1, limit: 2}}]);
        const allKeys: string[] = [];
        // The per-conversation activity cursor (E11, agent.thread-activity.<hash>) is read as part of each committed call's
        // shared transaction. It is accounted for separately and bounded; the skill-selected rows stay exact.
        const activity = () => allKeys.filter(key => key.startsWith("agent.thread-activity."));
        const skillKeys = () => allKeys.filter(key => !key.startsWith("agent.thread-activity."));
        const reads = interceptStoreTable(db, "deviceSettings", "get", async (_tx, args, next) => {allKeys.push(String(args[0])); return next();});
        try {
            const loaded = await execute(load);
            expect(loaded).toMatchObject({version: 1, skillId: descriptor.skillId, revision: descriptor.revision, name: "scene-flow", body: expect.stringContaining("仅在被请求后读取")});
            expect(skillKeys()).toEqual([skillManifestKey(descriptor.revision), skillBodyKey(descriptor.revision)]);
            expect(activity().length).toBeLessThanOrEqual(1);
            expect(await db.agentToolCalls.get(load.id)).toMatchObject({status: "completed", result: JSON.stringify(loaded)});
            allKeys.length = 0;
            const page = await execute(resource);
            expect(page).toEqual({version: 1, skillId: descriptor.skillId, revision: descriptor.revision, path: "references/a.md", text: "😀乙", offset: 1, nextOffset: 3, end: false});
            expect(skillKeys()).toEqual([skillManifestKey(descriptor.revision), skillResourceKey(descriptor.revision, 0)]);
            expect(activity().length).toBeLessThanOrEqual(1);
            expect(await db.agentToolCalls.get(resource.id)).toMatchObject({status: "completed", result: JSON.stringify(page)});
        } finally {reads.mockRestore();}
    });

    it.each(["pending", "failed", "unknown", "rejected"] as const)("does not treat a %s body load as successful disclosure", async status => {
        const {run, descriptor} = await begin();
        const [load, resource] = await record(run, [{name: "load_skill", args: {skillId: descriptor.skillId}},
            {name: "read_skill_resource", args: {skillId: descriptor.skillId, path: "references/a.md"}}]);
        await db.agentToolCalls.update(load.id, {status, result: JSON.stringify({skillId: descriptor.skillId, revision: descriptor.revision})});
        const reads = interceptStoreTable(db, "deviceSettings", "get", async () => {throw new Error("must not hydrate content");});
        try {await expect(execute(resource)).rejects.toThrow("请先");} finally {reads.mockRestore();}
        expect((await db.agentToolCalls.get(resource.id))?.result).toBeUndefined();
    });

    it("requires a prior ordered successful load with this run, exact revision and saved arguments", async () => {
        const {run, descriptor} = await begin();
        const [resource, load] = await record(run, [{name: "read_skill_resource", args: {skillId: descriptor.skillId, path: "references/a.md"}},
            {name: "load_skill", args: {skillId: descriptor.skillId}}]);
        await execute(load);
        await expect(execute(resource)).rejects.toThrow("请先");
        await db.agentToolCalls.update(resource.id, {status: "pending", order: 2});
        const saved = (await db.agentToolCalls.get(load.id))!;
        const raw: unknown = JSON.parse(saved.result!);
        const result = raw as Record<string, unknown>;
        await db.agentToolCalls.update(load.id, {result: JSON.stringify({...result, revision: "f".repeat(64)})});
        await expect(execute({...resource, order: 2})).rejects.toThrow("请先");
        await db.agentToolCalls.update(resource.id, {status: "pending"});
        await db.agentToolCalls.update(load.id, {result: saved.result, arguments: JSON.stringify({skillId: "foreign"})});
        await expect(execute(resource)).rejects.toThrow("请先");
        await db.agentToolCalls.update(resource.id, {status: "pending"});
        await db.agentToolCalls.update(load.id, {arguments: saved.arguments, runId: "foreign-run"});
        await expect(execute(resource)).rejects.toThrow("请先");
    });

    it.each(["../outside.md", "/private/file.txt", "references\\a.md", "references/a.md:stream", "references/NUL.md", "https://example.test/a.md"])("rejects unsafe resource path before any read: %s", async path => {
        expect(() => validateToolCall("read_skill_resource", JSON.stringify({skillId: "skill_1", path}), ["read_skill_resource"])).toThrow("参数无效");
    });

    it("rejects revision overrides, disabled tool names, foreign installation IDs and invalid scalar ranges", async () => {
        for (const args of [{skillId: "skill_1", revision: "f".repeat(64)}, {skillId: "skill_1", approved: true}]) {
            expect(() => validateToolCall("load_skill", JSON.stringify(args), ["load_skill"])).toThrow("参数无效");
        }
        for (const args of [{offset: -1}, {offset: 0.5}, {limit: 0}, {limit: 8193}]) {
            expect(() => validateToolCall("read_skill_resource", JSON.stringify({skillId: "skill_1", path: "references/a.md", ...args}), ["read_skill_resource"])).toThrow("参数无效");
        }
        expect(() => validateToolCall("load_skill", '{"skillId":"skill_1"}', [])).toThrow("未启用");
        const {run} = await begin();
        const [call] = await record(run, [{name: "load_skill", args: {skillId: "foreign_install"}}]);
        await expect(execute(call)).rejects.toThrow("固定目录");
        expect((await db.agentToolCalls.get(call.id))?.result).toBeUndefined();
    });

    it.each(["name", "arguments", "offered", "conversation", "legacy", "metadata", "project"] as const)("revalidates %s at the actual read transaction", async mutation => {
        const {run, descriptor} = await begin();
        const [call] = await record(run, [{name: "load_skill", args: {skillId: descriptor.skillId}}]);
        await transitionToolCall(run.id, call.id, ["pending"], "running");
        const {tool, args} = validateToolCall(call.name, call.arguments, run.enabledToolNames ?? []);
        if (mutation === "name") await db.agentToolCalls.update(call.id, {name: "read_skill_resource"});
        if (mutation === "arguments") await db.agentToolCalls.update(call.id, {arguments: JSON.stringify({skillId: "different"})});
        if (mutation === "offered") await db.agentRuns.update(run.id, {offeredTools: [{step: call.step, names: []}]});
        if (mutation === "conversation") await db.agentRuns.update(run.id, {interactionMode: "conversation"});
        if (mutation === "legacy") await db.agentRuns.update(run.id, {installedSkills: undefined});
        if (mutation === "metadata") await db.agentToolCalls.update(call.id, {atomic: false});
        const context: AgentToolContext = {runId: run.id, threadId: run.threadId, callId: call.id, signal: new AbortController().signal, store: db,
            ...(mutation === "project" ? {projectId: "foreign-project"} : {})};
        const reads = interceptStoreTable(db, "deviceSettings", "get", async () => {throw new Error("must not hydrate content");});
        try {await expect(tool.execute(args, context)).rejects.toThrow();} finally {reads.mockRestore();}
        expect((await db.agentToolCalls.get(call.id))?.result).toBeUndefined();
    });

    it("rejects an unlisted resource after its manifest read and fails on corrupt or missing exact versions", async () => {
        const {run, descriptor} = await begin();
        const [load] = await record(run, [{name: "load_skill", args: {skillId: descriptor.skillId}}]);
        await execute(load);
        const [resource] = await record(run, [{name: "read_skill_resource", args: {skillId: descriptor.skillId, path: "references/absent.md"}}]);
        const keys: string[] = [];
        const reads = interceptStoreTable(db, "deviceSettings", "get", async (_tx, args, next) => {keys.push(String(args[0])); return next();});
        try {await expect(execute(resource)).rejects.toThrow("清单");} finally {reads.mockRestore();}
        expect(keys).toEqual([skillManifestKey(descriptor.revision)]);
        const body = (await db.deviceSettings.get(skillBodyKey(descriptor.revision)))!;
        await db.deviceSettings.put({...body, value: {...body.value as Record<string, unknown>, text: "tampered body"}});
        const [corrupt] = await record(run, [{name: "load_skill", args: {skillId: descriptor.skillId}}]);
        await expect(execute(corrupt)).rejects.toThrow("损坏");
        await db.deviceSettings.delete(skillManifestKey(descriptor.revision));
        const [missing] = await record(run, [{name: "load_skill", args: {skillId: descriptor.skillId}}]);
        await expect(execute(missing)).rejects.toThrow("缺失");
    });

    it("keeps selected reads on the explicitly supplied ProductStore transaction", async () => {
        const supplied = createBrowserProductStore(browserDatabase!);
        const {run, descriptor} = await begin(candidate(), supplied);
        const [load] = await record(run, [{name: "load_skill", args: {skillId: descriptor.skillId}}], supplied);
        const escape = vi.spyOn(db, "transaction").mockImplementation(async () => {throw new Error("escaped explicit owner");});
        try {await expect(execute(load, supplied)).resolves.toMatchObject({revision: descriptor.revision});} finally {escape.mockRestore();}
        expect((await supplied.agentToolCalls.get(load.id))?.status).toBe("completed");
    });

    it("does not publish a body result after Stop reaches the actual selected storage read", async () => {
        const {run, descriptor} = await begin();
        const [call] = await record(run, [{name: "load_skill", args: {skillId: descriptor.skillId}}]);
        const controller = new AbortController(); let reached = false;
        const stop = interceptStoreTable(db, "deviceSettings", "get", async (_tx, args, next) => {
            const result = await next();
            if (args[0] === skillBodyKey(descriptor.revision)) {reached = true; controller.abort();}
            return result;
        });
        try {await expect(execute(call, db, controller)).rejects.toThrow();} finally {stop.mockRestore();}
        expect(reached).toBe(true);
        expect((await db.agentToolCalls.get(call.id))?.result).toBeUndefined();
        expect((await db.agentToolCalls.get(call.id))?.status).toBe("running");
    });

    it("refuses deleted or terminal runs without recreating a thread or result", async () => {
        const {run, descriptor} = await begin();
        const [call] = await record(run, [{name: "load_skill", args: {skillId: descriptor.skillId}}]);
        await transitionToolCall(run.id, call.id, ["pending"], "running");
        const {tool, args} = validateToolCall(call.name, call.arguments, run.enabledToolNames ?? []);
        const context: AgentToolContext = {runId: run.id, threadId: run.threadId, callId: call.id, signal: new AbortController().signal, store: db};
        await db.agentRuns.update(run.id, {status: "interrupted"});
        await expect(tool.execute(args, context)).rejects.toThrow("状态");
        await deleteChatThread(run.threadId);
        await expect(tool.execute(args, context)).rejects.toThrow("删除");
        expect(await db.chatThreads.get(run.threadId)).toBeUndefined();
        expect(await db.agentRuns.get(run.id)).toBeUndefined();
        expect(await db.agentToolCalls.get(call.id)).toBeUndefined();
    });

    it("rolls back a reached completion failure and preserves an uncertain completed result without replay", async () => {
        const {run, descriptor} = await begin();
        const [call] = await record(run, [{name: "load_skill", args: {skillId: descriptor.skillId}}]);
        let reached = false;
        const failure = interceptStoreTable(db, "agentToolCalls", "update", async (_tx, args, next) => {
            if ((args[1] as {status?: string}).status === "completed") {reached = true; throw new Error("late completion failure");}
            return next();
        });
        try {await expect(execute(call)).rejects.toThrow("late completion failure");} finally {failure.mockRestore();}
        expect(reached).toBe(true); expect((await db.agentToolCalls.get(call.id))?.result).toBeUndefined();
        const original = db.transaction.bind(db); let lost = false;
        const uncertain = vi.spyOn(db, "transaction").mockImplementation(async (mode, scope, callback) => {
            const value = await original(mode, scope, callback);
            if (!lost && mode === "rw") {lost = true; throw new UnknownCommitError("lost-completion", "workspace");}
            return value;
        });
        const savedRunning = (await db.agentToolCalls.get(call.id))!;
        try {await expect(execute(savedRunning)).rejects.toBeInstanceOf(UnknownCommitError);} finally {uncertain.mockRestore();}
        expect(lost).toBe(true); expect((await db.agentToolCalls.get(call.id))?.status).toBe("completed");
        const reads = interceptStoreTable(db, "deviceSettings", "get", async () => {throw new Error("completed disclosure must not reread");});
        try {await expect(execute((await db.agentToolCalls.get(call.id))!)).resolves.toMatchObject({skillId: descriptor.skillId});} finally {reads.mockRestore();}
    });

    it("retains the existing result-size cap rather than truncating or widening a large escaped body", async () => {
        const {run, descriptor} = await begin(candidate("\u0001".repeat(12_000)));
        const [call, resource] = await record(run, [{name: "load_skill", args: {skillId: descriptor.skillId}},
            {name: "read_skill_resource", args: {skillId: descriptor.skillId, path: "references/a.md"}}]);
        await expect(execute(call)).rejects.toThrow("缩短 SKILL.md 正文或资料路径后手动更新");
        expect((await db.agentToolCalls.get(call.id))?.result).toBeUndefined();
        await expect(execute(resource)).rejects.toThrow("请先");
        expect((await getInstalledSkillCatalogue()).entries[0].revision).toBe(descriptor.revision);
    });

    it("counts both helpers within the existing 36-tool foundation and keeps unsettled business tools pinned", () => {
        const names = ["workspace_overview", "update_run_plan", ...INSTALLED_SKILL_TOOL_NAMES, "project_create", "character_create"];
        const state = createToolLoading(["workspace", "planning", "story-edit", "asset-edit"], names)!;
        expect(state.foundationToolNames).toEqual(["workspace_overview", "update_run_plan", ...INSTALLED_SKILL_TOOL_NAMES, "load_tool_groups"]);
        expect(getOfferedToolNames({toolLoading: state, enabledToolNames: [...names, "load_tool_groups"]})).toEqual(state.foundationToolNames);
        const allowed = [...state.foundationToolNames, ...Array.from({length: 32}, (_, i) => `fixture_${i}`)];
        const loaded = {...state, groups: [{id: "too-many", name: "fixture", description: "fixture", instructions: "", toolNames: allowed.slice(5)}]};
        expect(() => selectCapabilityGroups(loaded, ["too-many"], [], allowed)).toThrow("超过 36");
        const switched = selectCapabilityGroups(state, ["asset-edit"], [{name: "project_create", status: "approved"}], names);
        expect(switched.loadedToolNames).toContain("project_create");
        expect(switched.loadedToolNames).toContain("character_create");
        expect(switched.foundationToolNames).toEqual(state.foundationToolNames);
        expect(() => selectCapabilityGroups(state, ["story-edit", "asset-edit", "third"], [], names)).toThrow();
    });
});
