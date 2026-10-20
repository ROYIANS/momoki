import {createCapabilityRegistry, type ToolBindingIdentity, type ToolDefinition} from "@momoki/agent-core";
import type {ProductStore} from "../../../../platform/storage/types";
import {db as productDb} from "../../../../platform/product/store";
import type {AgentToolPreview} from "../../models/agent";
import {BUILTIN_TOOLS, type AgentToolContext, type AgentToolDefinition} from "../../runtime/tools";
import type {McpRunGeneration, McpRunSnapshot} from "../models/manifest";
import {mcpRuntimeOwner} from "./owner";
import {assertMcpSnapshotCurrent} from "./surface";
import {mcpBindingMatches} from "./manifest";
import {createMcpTools} from "./tools";

export function mcpCapabilityBinding(generation: McpRunGeneration): ToolBindingIdentity {
    return {capabilityId: `mcp/${generation.binding.serverId}`, version: generation.manifest.revision, registrationId: generation.binding.registrationId};
}

/** Materialization never connects or discovers. Every definition comes from saved run facts. */
export function createMcpRunRegistry(snapshot: McpRunSnapshot | undefined, base: readonly AgentToolDefinition[] = BUILTIN_TOOLS, store: ProductStore = productDb) {
    const owner = mcpRuntimeOwner();
    const registry = createCapabilityRegistry<AgentToolContext, AgentToolPreview>();
    const assertGeneration = async (generation: McpRunGeneration, currentStore: ProductStore = store) => {
        if (!snapshot) throw new Error("MCP 执行快照缺失");
        await assertMcpSnapshotCurrent({...snapshot, generations: [generation]}, owner?.connections, currentStore);
    };
    if (snapshot) {
        const tools = createMcpTools(snapshot, owner?.host, async binding => {
            const generation = snapshot.generations.find(item => mcpBindingMatches(item.binding, binding));
            if (!generation) throw new Error("MCP 调用不属于原执行快照");
            await assertGeneration(generation);
        });
        for (const generation of snapshot.generations) {
            const identity = mcpCapabilityBinding(generation);
            const registered = tools.filter(tool => tool.binding?.capabilityId === identity.capabilityId);
            if (registered.length) registry.register({identity, tools: registered});
        }
    }
    const external = registry.snapshot().map((tool: ToolDefinition<unknown, AgentToolContext, AgentToolPreview, unknown>): AgentToolDefinition => {
        const {recovery, ...definition} = tool;
        if (recovery !== undefined && recovery !== "generation" && recovery !== "repeatable") throw new Error("未知工具恢复策略");
        return {...definition, ...(recovery ? {recovery} : {})};
    });
    return {
        definitions: Object.freeze([...base, ...external]),
        /** Scope/claim compare original binding. StoreTx callers pass their own transaction. */
        async assertBinding(binding: ToolBindingIdentity | undefined, currentStore: ProductStore = store) {
            if (!binding) return;
            registry.assertCurrent(binding);
            const generation = snapshot?.generations.find(item => {
                const expected = mcpCapabilityBinding(item);
                return expected.capabilityId === binding.capabilityId && expected.version === binding.version && expected.registrationId === binding.registrationId;
            });
            if (!generation) throw new Error("工具能力不属于原执行快照");
            await assertGeneration(generation, currentStore);
        },
    };
}
