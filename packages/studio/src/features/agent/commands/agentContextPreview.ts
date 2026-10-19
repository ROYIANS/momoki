import {mcpRuntimeOwner} from "../mcp/runtime/owner";
import {assertMcpSnapshotCurrent} from "../mcp/runtime/surface";
import type {McpRunGeneration} from "../mcp/models/manifest";
import {createMcpRunRegistry} from "../mcp/runtime/runRegistry";
import {toolSchemas} from "../runtime/tools";
import {getOfferedToolNames} from "../models/agentToolSelection";
import type {ProductStore} from "../../../platform/storage/types";
import {db as productDb} from "../../../platform/product/store";
import {getMemorySelection} from "../../memory/queries/memoryRetrieval";
import {type AgentInteractionMode, type AgentRun, GENERAL_AGENT_ID} from "../models/agent";
import type {ReferenceAttachment} from "../../references/models/references";
import type {ChatModelMetadata} from "../../settings/models/modelMetadata";
import {initModelCatalog} from "../../settings/modelCatalog/store";
import {requireVision, resolveVisionCapability} from "../../settings/models/visionCapability";
import {getTaskContext} from "../runtime/taskContext";
import {projectContextTables} from "../runtime/projectContext";
import {normalizeContextPolicy, resolveContextCapacity} from "../runtime/contextPolicy";
import {selectContextHistory} from "../runtime/contextPlanner";
import {referenceSelectionCharacterBudget, selectReferenceContext} from "../../references/agent/referenceContext";
import {getInstalledSkillCatalogue} from "../skills/queries/installedSkills";
import {DEFAULT_SKILL_IDS} from "../runtime/skills";
import {composeRunSkills, type RunSkillSurface} from "../runtime/runSkills";
import type {InstalledSkillsSnapshot} from "../skills/models/installedSkill";

export type ContextPreviewInput = {
    threadId?: string;
    projectId?: string;
    interactionMode?: AgentInteractionMode;
    draft: string;
    attachments: ReferenceAttachment[];
    model: string;
    providerId?: string;
    metadata?: ChatModelMetadata;
};

/** Scope and request inputs only; credentials and parent-page loading results are excluded. */
export function contextPreviewIdentity(input: ContextPreviewInput): string {
    return JSON.stringify([input.threadId ?? null, input.projectId ?? null, input.interactionMode ?? "smart",
        input.draft, input.attachments, input.model, input.providerId ?? null, input.metadata ?? null]);
}

/** Includes every store used by nested project/task/memory/reference readers. */
export function contextPreviewTables(store?: ProductStore) {
    const db = store ?? productDb;
    return [...new Set([db.deviceSettings, db.agents, db.chatThreads, db.chatMessages, db.agentRuns, db.contextCompactions,
        db.agentTasks, db.agentTaskRecords, db.projectMemories, db.projectReferences, db.referenceChunks,
        db.media, ...projectContextTables(db)])];
}

type Unavailable = { identity: string; status: "unavailable"; message: string };
type Missing = { identity: string; status: "missing"; entity: "agent" | "thread" | "project" };

async function readScopedRows(threadId: string | undefined, projectId: string | undefined, store?: ProductStore) {
    const db = store ?? productDb;
    const [config, messages, runs, records, project, task] = await Promise.all([
        db.agents.get(GENERAL_AGENT_ID),
        threadId ? db.chatMessages.where("threadId").equals(threadId).sortBy("createdAt") : [],
        threadId ? db.agentRuns.where("threadId").equals(threadId).sortBy("createdAt") : [],
        threadId ? db.contextCompactions.where("threadId").equals(threadId).sortBy("createdAt") : [],
        projectId ? db.projects.get(projectId) : undefined,
        threadId ? db.agentTasks.where("threadId").equals(threadId).first() : undefined,
    ]);
    return {config, messages, runs, records, project, task};
}

function currentSavedRun(runs: Awaited<ReturnType<typeof readScopedRows>>["runs"]) {
    const latest = runs.at(-1);
    if (!latest) return undefined;
    const active = latest.status === "running" || latest.status === "waiting_approval";
    const recoverable = latest.hasToolCalls && (latest.status === "failed" || latest.status === "interrupted");
    return active || recoverable ? latest : undefined;
}

async function selectPreviewMaterials(input: ContextPreviewInput, rows: Awaited<ReturnType<typeof readScopedRows>>,
                                      thread: import("../models/chat").ChatThread | undefined, projectId: string | undefined,
                                      vision: Awaited<ReturnType<typeof resolveVisionCapability>>, activeRun: AgentRun | undefined, mcpGenerations: readonly McpRunGeneration[], store?: ProductStore) {
    const db = store ?? productDb;
    // Optional saved fields remain absent, rather than acquiring new live selections.
    if (activeRun) return {
        previewPolicy: normalizeContextPolicy(activeRun.context?.policy),
        taskContext: undefined, memorySelection: undefined, selectedReferences: undefined,
        installedSkills: activeRun.installedSkills,
        skillSurface: {enabledToolNames: activeRun.enabledToolNames ?? [], toolLoading: activeRun.toolLoading,
            skillInstructions: activeRun.skillInstructions ?? "", ...(activeRun.mcpSnapshot ? {mcpSnapshot: activeRun.mcpSnapshot} : {})} satisfies RunSkillSurface,
    };
    const previewPolicy = normalizeContextPolicy(thread ? thread.contextPolicy : rows.config?.contextPolicy);
    const interactionMode = input.interactionMode ?? thread?.interactionMode ?? "smart";
    const taskContext = await getTaskContext(input.threadId, rows.config?.instructions ?? "",
        thread?.taskMode, interactionMode, projectId, db);
    const catalogue = interactionMode === "conversation" ? undefined : await getInstalledSkillCatalogue(db);
    const installedSkills: InstalledSkillsSnapshot | undefined = catalogue ? {version: 1, entries: catalogue.entries.filter(entry => entry.enabled)
        .map(({skillId, revision, metadata}) => ({skillId, revision, metadata}))} : undefined;
    const skillSurface = composeRunSkills({enabledSkillIds: rows.config?.enabledSkillIds ?? DEFAULT_SKILL_IDS,
        taskToolNames: taskContext.taskToolNames, projectId, projectKind: taskContext.projectKind, interactionMode, installedSkills, mcpGenerations});
    const capacity = resolveContextCapacity(input.model, input.metadata, input.providerId, previewPolicy).capacity;
    const memorySelection = taskContext.projectContext ? await getMemorySelection({
        projectId: taskContext.projectContext.projectId, threadId: input.threadId, draft: input.draft,
        recentUserTurns: selectContextHistory(rows.messages.filter(message => message.origin !== "system"), previewPolicy).filter(message => message.role === "user").map(message => message.content),
        taskTitle: taskContext.task?.title, taskGoal: taskContext.task?.goal, capacity,
    }, db) : undefined;
    const selectedReferences = await selectReferenceContext(projectId, input.attachments, referenceSelectionCharacterBudget(capacity), db);
    if (selectedReferences?.images?.length) requireVision(vision);
    return {previewPolicy, taskContext, memorySelection, selectedReferences, installedSkills, skillSurface};
}

async function readFacts(input: ContextPreviewInput, identity: string, vision: Awaited<ReturnType<typeof resolveVisionCapability>>, store?: ProductStore) {
    const db = store ?? productDb;
    const owner = mcpRuntimeOwner()?.connections;
    const captured = owner?.capture() ?? [];
    return db.transaction("r", [contextPreviewTables(db)].flat(), async (db) => {
        const thread = input.threadId ? await db.chatThreads.get(input.threadId) : undefined;
        if (input.threadId && !thread) return {identity, status: "missing", entity: "thread"} satisfies Missing;
        if (thread && input.projectId !== undefined && thread.projectId !== input.projectId)
            return {identity, status: "unavailable", message: "对话与当前项目范围不匹配"} satisfies Unavailable;
        const projectId = thread ? thread.projectId : input.projectId;
        const rows = await readScopedRows(input.threadId, projectId, db);
        const activeRun = currentSavedRun(rows.runs);
        if ((rows.task && rows.task.projectId !== projectId) || (activeRun && activeRun.projectId !== projectId))
            return {identity, status: "unavailable", message: "任务或执行记录与对话范围不匹配"} satisfies Unavailable;
        const projectAvailable = !projectId || (!!rows.project && projectId !== "studio");
        if (!activeRun && !rows.config) return {identity, status: "missing", entity: "agent"} satisfies Missing;
        if (!activeRun && !projectAvailable) return {identity, status: "missing", entity: "project"} satisfies Missing;
        const selected = await selectPreviewMaterials(input, rows, thread, projectId, vision, activeRun, captured, db);
        if (!activeRun) await assertMcpSnapshotCurrent(selected.skillSurface.mcpSnapshot, owner, db);
        const definitions = createMcpRunRegistry(selected.skillSurface.mcpSnapshot).definitions;
        const offered = new Set(getOfferedToolNames(selected.skillSurface));
        const schemas = toolSchemas(definitions.filter(tool => offered.has(tool.name)).map(tool => tool.name), definitions);
        return {
            identity, status: "ready" as const, facts: {
                config: rows.config, thread, projectId, available: projectAvailable && !!rows.config,
                messages: rows.messages, records: rows.records, activeRun, lastRun: rows.runs.at(-1), toolSchemas: schemas, ...selected,
            }
        };
    });
}

export type ContextPreviewRead = Awaited<ReturnType<typeof readFacts>> | {
    identity: string;
    status: "error";
    message: string
};

/** Resolve catalog I/O before starting an observed ProductStore snapshot. */
export async function prepareAgentContextPreview(input: ContextPreviewInput) {
    await initModelCatalog();
    return {identity: contextPreviewIdentity(input), vision: await resolveVisionCapability(input.model, input.providerId, input.metadata)};
}
export function readPreparedAgentContextPreview(input: ContextPreviewInput, prepared: Awaited<ReturnType<typeof prepareAgentContextPreview>>, store: ProductStore) {
    const identity = contextPreviewIdentity(input);
    if (prepared.identity !== identity) throw new Error("上下文准备范围已变化");
    return readFacts(input, identity, prepared.vision, store);
}

/** Model catalog loading finishes before the final coherent IndexedDB read. */
export async function readAgentContextPreview(input: ContextPreviewInput, store?: ProductStore): Promise<ContextPreviewRead> {
    const db = store ?? productDb;
    const identity = contextPreviewIdentity(input);
    try {
        const prepared = await prepareAgentContextPreview(input);
        return await readPreparedAgentContextPreview(input, prepared, db);
    } catch (error) {
        return {identity, status: "error", message: error instanceof Error ? error.message : "上下文暂时无法读取"};
    }
}
