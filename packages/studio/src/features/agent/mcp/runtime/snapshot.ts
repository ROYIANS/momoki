import {MAX_LOADED_TOOLS} from "@momoki/agent-core";
import type {McpHostBinding} from "../../../../platform/runtime/mcp";
import type {McpRunGeneration, McpRunSnapshot} from "../models/manifest";
import {MCP_LIMITS} from "./limits";
import {mcpBindingMatches, normalizeMcpManifest, parseMcpBinding} from "./manifest";
import {freezeMcp, mcpDigest, mcpId, mcpJson, mcpOrdinal, mcpText} from "./validation";

export function mcpResourceHelperNames(serverId: string): readonly [string, string] {
    mcpId(serverId);
    return ["list", "read"].map(kind => `mcp_${mcpDigest(JSON.stringify([serverId, "resource", kind])).slice(0, 60)}`) as [string, string];
}

function capturedGeneration(input: McpRunGeneration): McpRunGeneration {
    mcpJson(input, MCP_LIMITS.generationBytes, 44, 32_768);
    const binding = parseMcpBinding(input.binding);
    const manifest = normalizeMcpManifest(binding.serverId, {
        tools: input.manifest.tools.map(tool => ({name: tool.rawName, description: tool.description, inputSchema: tool.inputSchema})),
        resources: input.manifest.resources.map(item => ({uri: item.uri, name: item.name, description: item.description, ...(item.mimeType ? {mimeType: item.mimeType} : {})})),
    });
    if (JSON.stringify(manifest) !== JSON.stringify(input.manifest)) throw new Error("MCP 连接目录与绑定不一致");
    return {binding, manifest, label: mcpText(input.label, 128)};
}

/** Pure snapshot composition; caller supplies every real foundation name, including loader/task/skills. */
export function composeMcpRunSnapshot(generations: readonly McpRunGeneration[], foundationNames: readonly string[]): McpRunSnapshot {
    if (generations.length > MCP_LIMITS.connected) throw new Error("MCP 已连接服务超过上限");
    const captured = generations.map(capturedGeneration).sort((a, b) => mcpOrdinal(a.binding.serverId, b.binding.serverId));
    if (new Set(captured.map(item => item.binding.serverId)).size !== captured.length) throw new Error("MCP 连接不能重复");
    const foundation = [...new Set(foundationNames.map(name => mcpText(name, 64)))];
    if (foundation.length !== foundationNames.length) throw new Error("MCP 基础工具不能重复");
    const helperNames = captured.filter(item => item.manifest.resources.length > 0).flatMap(item => [...mcpResourceHelperNames(item.binding.serverId)]);
    const allNames = [...foundation, ...helperNames, ...captured.flatMap(item => item.manifest.tools.map(tool => tool.name))];
    if (new Set(allNames).size !== allNames.length) throw new Error("MCP 工具名称冲突");
    foundation.push(...helperNames);
    const capacity = MAX_LOADED_TOOLS - foundation.length;
    if (capacity < 0 || capacity === 0 && captured.some(item => item.manifest.tools.length > 0)) throw new Error("MCP 基础工具已达到 36 个上限");
    const groups: McpRunSnapshot["groups"][number][] = [];
    for (const generation of captured) {
        for (let offset = 0; offset < generation.manifest.tools.length; offset += capacity) {
            const tools = generation.manifest.tools.slice(offset, offset + capacity);
            groups.push({id: `mcp_group_${mcpDigest(JSON.stringify([generation.binding.serverId, generation.manifest.revision, offset, capacity]))}`,
                name: `${generation.label} ${Math.floor(offset / capacity) + 1}`, toolNames: tools.map(tool => tool.name)});
        }
    }
    return freezeMcp({version: 1, generations: captured, foundationToolNames: foundation, groups});
}

/** Lookup only a captured mapping; never decode a public name into today's server. */
export function resolveMcpSnapshotTool(snapshot: McpRunSnapshot, publicName: string, currentBinding: McpHostBinding): {readonly binding: McpHostBinding; readonly rawName: string; readonly inputSchema: Readonly<Record<string, unknown>>} {
    const generation = snapshot.generations.find(item => item.manifest.tools.some(tool => tool.name === publicName));
    const tool = generation?.manifest.tools.find(item => item.name === publicName);
    if (!generation || !tool || !mcpBindingMatches(generation.binding, parseMcpBinding(currentBinding))) throw new Error("MCP 工具连接版本已失效");
    return {binding: generation.binding, rawName: tool.rawName, inputSchema: tool.inputSchema};
}
