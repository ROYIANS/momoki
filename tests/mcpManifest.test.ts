import {describe, expect, it, vi} from "vitest";
import {selectCapabilityGroups} from "@momoki/agent-core";
import {compileMcpInputSchema} from "@/features/agent/mcp/runtime/schema";
import {collectMcpPages, mcpBindingMatches, mcpPublicToolName, normalizeMcpManifest} from "@/features/agent/mcp/runtime/manifest";
import {composeMcpRunSnapshot, mcpResourceHelperNames, resolveMcpSnapshotTool} from "@/features/agent/mcp/runtime/snapshot";
import {MCP_LIMITS} from "@/features/agent/mcp/runtime/limits";

const schema = {type: "object", properties: {path: {type: "string", minLength: 1}}, required: ["path"], additionalProperties: false};
const rawTool = (name = "read") => ({name, description: "Server-supplied\nuntrusted text", inputSchema: schema, annotations: {readOnlyHint: true, idempotentHint: true}});
function generation(count = 1, resources = false) {
    const manifest = normalizeMcpManifest("server_one", {tools: Array.from({length: count}, (_, i) => rawTool(`tool_${i}`)), resources: resources ? [{uri: "custom:report", name: "报告"}] : []});
    return {label: "资源服务器", manifest, binding: {serverId: "server_one", configRevision: 1, manifestRevision: "host_raw_manifest_one", registrationId: "registration_one", hostSessionId: "host_one", principalRevision: "principal_one"}};
}

describe("MCP bounded immutable manifests", () => {
    it("has deterministic collision-resistant names with exact raw mappings and no annotation authority", () => {
        const names = ["a b", "a-b", "a_b", "工具😀", "a".repeat(256)];
        expect(new Set(names.map(name => mcpPublicToolName("server_one", name))).size).toBe(names.length);
        for (const name of names) expect(mcpPublicToolName("server_one", name)).toMatch(/^[a-z0-9_]{64}$/u);
        expect(mcpPublicToolName("server_two", "read")).not.toBe(mcpPublicToolName("server_one", "read"));
        const a = normalizeMcpManifest("server_one", {tools: [rawTool("b"), rawTool("a")], resources: []});
        const b = normalizeMcpManifest("server_one", {tools: [rawTool("a"), rawTool("b")], resources: []});
        expect(a).toEqual(b);
        expect(JSON.stringify(a)).not.toContain("readOnlyHint");
        expect(Object.isFrozen(a.tools[0].inputSchema)).toBe(true);
    });

    it("rejects duplicate raw names, schema errors and excessive count/size without a partial snapshot", () => {
        expect(() => normalizeMcpManifest("server_one", {tools: [rawTool(), rawTool()], resources: []})).toThrow(/重复/);
        expect(() => generation(129)).toThrow(/上限/);
        expect(() => normalizeMcpManifest("server_one", {tools: [{...rawTool(), description: "x".repeat(2_049)}], resources: []})).toThrow(/过长/);
        expect(() => normalizeMcpManifest("server_one", {tools: [{...rawTool(), inputSchema: {type: "object", properties: {x: {type: "invalid"}}}}], resources: []})).toThrow();
    });

    it("uses an eval-free validator and rejects unsupported schemas/remote or cyclic refs", () => {
        const compiler = vi.spyOn(globalThis, "Function").mockImplementation(() => {throw new Error("unsafe-eval forbidden");});
        try {
            const compiled = compileMcpInputSchema(schema);
            expect(compiled.parse({path: "report"})).toEqual({path: "report"});
            for (const input of [{}, {path: ""}, {path: "report", other: true}, {path: 1}]) expect(() => compiled.parse(input)).toThrow();
            expect(compiler).not.toHaveBeenCalled();
        } finally {compiler.mockRestore();}
        for (const unsupported of [{$ref: "https://example.com/schema"}, {pattern: ".*"}, {multipleOf: 0.1}, {$dynamicRef: "#x"}, {contains: {type: "string"}}]) expect(() => compileMcpInputSchema({type: "object", ...unsupported})).toThrow();
        expect(() => compileMcpInputSchema({type: "object", properties: {x: {$ref: "#/$defs/missing"}}})).toThrow(/引用/);
        expect(() => compileMcpInputSchema({type: "object", $defs: {loop: {$ref: "#/$defs/loop"}}, properties: {x: {$ref: "#/$defs/loop"}}})).toThrow(/引用/);
    });

    it("validates ordinary local definitions, nested arrays, enums and numeric bounds without inherited keys", () => {
        const compiled = compileMcpInputSchema({type: "object", $defs: {count: {type: "integer", minimum: 1}}, properties: {count: {$ref: "#/$defs/count"}, tags: {type: "array", items: {type: "string", enum: ["a", "b"]}}}, required: ["count"], additionalProperties: false});
        expect(compiled.parse({count: 2, tags: ["a", "b"]})).toEqual({count: 2, tags: ["a", "b"]});
        expect(() => compiled.parse({count: 0})).toThrow();
        expect(() => compiled.parse({count: 2, tags: ["c"]})).toThrow();
        expect(() => compileMcpInputSchema({type: "object", required: ["toString"]})).toThrow();
        expect(() => compiled.parse(JSON.parse('{"count":2,"__proto__":{}}'))).toThrow();
    });

    it("rejects argument bytes, oversized/deep schema before validator construction", () => {
        const compiled = compileMcpInputSchema(schema);
        expect(() => compiled.parse({path: "x".repeat(MCP_LIMITS.argumentsBytes)})).toThrow(/大小/);
        expect(() => compileMcpInputSchema({type: "object", description: "x".repeat(MCP_LIMITS.schemaBytes)})).toThrow();
        let deep: unknown = {type: "string"};
        for (let index = 0; index < 34; index++) deep = {type: "object", properties: {next: deep}};
        expect(() => compileMcpInputSchema(deep)).toThrow(/复杂/);
    });

    it("bounds complete pagination, rejects repeated cursors, count overflow and cancellation", async () => {
        const signal = new AbortController().signal;
        expect(await collectMcpPages(async cursor => cursor ? {items: [2]} : {items: [1], nextCursor: "next"}, item => item, 128, signal)).toEqual([1, 2]);
        await expect(collectMcpPages(async () => ({items: [], nextCursor: "same"}), item => item, 128, signal)).rejects.toThrow(/重复/);
        await expect(collectMcpPages(async () => ({items: [1, 2]}), item => item, 1, signal)).rejects.toThrow(/上限/);
        let pages = 0;
        await expect(collectMcpPages(async () => ({items: [], nextCursor: `page_${++pages}`}), item => item, 128, signal)).rejects.toThrow(/上限/);
        expect(pages).toBe(16);
        const canceled = new AbortController();
        canceled.abort();
        const fetch = vi.fn();
        await expect(collectMcpPages(fetch, item => item, 128, canceled.signal)).rejects.toThrow();
        expect(fetch).not.toHaveBeenCalled();
    });

    it("counts real foundation/resource helpers, partitions deterministically and retains core group limits", () => {
        const source = generation(70, true);
        const snapshot = composeMcpRunSnapshot([source], ["load_tool_groups", "plan", "task", "skills_read"]);
        expect(snapshot.foundationToolNames).toHaveLength(6);
        expect(snapshot.foundationToolNames).toEqual(expect.arrayContaining([...mcpResourceHelperNames("server_one")]));
        expect(snapshot.groups.map(group => group.toolNames.length)).toEqual([30, 30, 10]);
        const state = {version: 1 as const, groups: snapshot.groups.map(group => ({...group, toolNames: [...group.toolNames], description: "", instructions: ""})), foundationToolNames: [...snapshot.foundationToolNames], foundationInstructions: "", loadedGroupIds: [], loadedToolNames: []};
        const allowed = [...snapshot.foundationToolNames, ...snapshot.groups.flatMap(group => group.toolNames)];
        expect(selectCapabilityGroups(state, [snapshot.groups[0].id], [], allowed).loadedToolNames).toHaveLength(30);
        expect(() => selectCapabilityGroups(state, snapshot.groups.map(group => group.id), [], allowed)).toThrow();
        expect(() => selectCapabilityGroups(state, [snapshot.groups[0].id, snapshot.groups[1].id], [], allowed)).toThrow(/36/);
        expect(composeMcpRunSnapshot([source], ["load_tool_groups", "plan", "task", "skills_read"])).toEqual(snapshot);
        expect(() => composeMcpRunSnapshot([source], Array.from({length: 36}, (_, i) => `base_${i}`))).toThrow(/36/);
    });

    it("freezes captured names and requires every original binding field to dispatch", () => {
        const source = generation();
        const snapshot = composeMcpRunSnapshot([source], ["load_tool_groups"]);
        const name = source.manifest.tools[0].name;
        expect(resolveMcpSnapshotTool(snapshot, name, source.binding).rawName).toBe("tool_0");
        for (const [key, value] of Object.entries(source.binding)) {
            const changed = {...source.binding, [key]: typeof value === "number" ? value + 1 : `${value}_changed`};
            expect(mcpBindingMatches(source.binding, changed)).toBe(false);
            expect(() => resolveMcpSnapshotTool(snapshot, name, changed)).toThrow();
        }
        expect(() => composeMcpRunSnapshot([{...source, manifest: {...source.manifest, revision: "0".repeat(64)}}], [])).toThrow(/不一致/);
        expect(() => resolveMcpSnapshotTool(snapshot, mcpPublicToolName("server_two", "tool_0"), source.binding)).toThrow();
        expect(Object.isFrozen(snapshot.generations[0].binding)).toBe(true);
    });
});
