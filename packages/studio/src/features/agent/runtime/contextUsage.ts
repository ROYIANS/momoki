import type {AgentRequestMessage, AgentToolSchema} from "../models/agent";

import {estimateTokens} from '@momoki/agent-core';
import {estimateImageTokens, wireTools, type WireProtocol} from "./contextMeasurement";
export {estimateTokens} from '@momoki/agent-core';

export type ContextUsage = {
    categories: Array<{ id: string; label: string; tokens: number; color: string }>;
    total: number;
};

export function estimateContextUsage(input: {
    instructions: string;
    skillInstructions: string;
    messages: readonly AgentRequestMessage[];
    tools: readonly AgentToolSchema[];
    protocol?: WireProtocol;
}): ContextUsage {
    const categories = [
        {id: "assistant", label: "助手指令", tokens: 0, color: "#dc62b6"},
        {id: "skills", label: "技能说明与能力目录", tokens: estimateTokens(input.skillInstructions), color: "#5899f5"},
        {id: "messages", label: "会话消息", tokens: 0, color: "#edb44d"},
        {id: "summary", label: "历史摘要", tokens: 0, color: "#ce9763"},
        {id: "memory", label: "项目记忆", tokens: 0, color: "#a98bea"},
        {id: "references", label: "参考资料与图片", tokens: 0, color: "#5baea5"},
        {id: "results", label: "工具结果", tokens: 0, color: "#a2c96a"},
        {
            id: "tool-schemas",
            label: "当前工具定义",
            tokens: input.tools.length ? estimateTokens(JSON.stringify(wireTools(input.tools, input.protocol ?? "chat-completions"))) : 0,
            color: "#61b7eb"
        },
    ];
    const system = [input.instructions, input.skillInstructions].filter(Boolean).join("\n");
    input.messages.forEach((message, index) => {
        // Split only the exact initial system envelope; never count the skill prompt twice.
        if (index === 0 && message.role === "system" && message.content === system) {
            categories[0].tokens += estimateTokens(input.instructions) + 4;
            return;
        }
        const category = message.referenceInput ? categories[5] : message.role === "user" && message.content.startsWith("[项目记忆 ·") ? categories[4] : message.role === "tool" ? categories[6] : message.role === "assistant" && message.content.startsWith("[历史摘要 ·") ? categories[3] : message.role === "system" ? categories[0] : categories[2];
        category.tokens += estimateTokens(message.content) + 4 + (message.referenceInput?.images ?? []).reduce((sum, image) => sum + estimateImageTokens(image), 0);
        if (message.role === "assistant" && message.tool_calls) category.tokens += estimateTokens(JSON.stringify(message.tool_calls));
        if (message.role === "tool") category.tokens += estimateTokens(message.tool_call_id);
    });
    return {categories, total: categories.reduce((sum, category) => sum + category.tokens, 0)};
}

export type ContextUsageRow = {id: string; label: string; tokens: number; color: string};

/** Product-facing grouping: at most five non-zero rows; request structure folds into the system row. */
const ROW_GROUPS: ReadonlyArray<{id: string; label: string; color: string; members: readonly string[]}> = [
    {id: "system", label: "系统指令", color: "#dc62b6", members: ["assistant", "envelope"]},
    {id: "tools", label: "工具", color: "#61b7eb", members: ["tool-schemas", "skills"]},
    {id: "conversation", label: "对话", color: "#edb44d", members: ["messages", "summary"]},
    {id: "results", label: "工具结果", color: "#a2c96a", members: ["results"]},
    {id: "memory", label: "记忆与参考", color: "#a98bea", members: ["memory", "references"]},
];

export function summarizeContextRows(categories: ContextUsage["categories"]): ContextUsageRow[] {
    return ROW_GROUPS.map(({id, label, color, members}) => ({
        id, label, color, tokens: categories.filter(item => members.includes(item.id)).reduce((sum, item) => sum + item.tokens, 0),
    })).filter(row => row.tokens > 0);
}

export function formatTokenCount(tokens: number): string {
    if (tokens < 1000) return tokens.toLocaleString("en-US");
    if (tokens < 1_000_000) return `${Number((tokens / 1000).toFixed(1))}K`;
    return `${Number((tokens / 1_000_000).toFixed(2))}M`;
}
