import { describe, expect, it } from "vitest";
import type { AgentRun, AgentToolCall } from "@/features/agent/models/agent";
import { buildRunActivity, formatRunElapsed, getRunElapsedMs, isPersistedToolRound, liveRoundEcho } from "@/features/agent/runtime/runPresentation";

const run: AgentRun = {
  id: "run", threadId: "thread", agentId: "agent", agentSnapshot: { name: "Agent", instructions: "" },
  userMessageId: "user", assistantMessageId: "assistant", model: "model", connector: { id: "cx", definitionId: "openai-compatible", baseUrl: "https://example.test/v1" },
  requestMessages: [], status: "running", checkpoint: 0, createdAt: "2026-09-21T00:00:00.000Z", updatedAt: "2026-09-21T00:01:00.000Z", hasToolCalls: true,
};
function call(step: number, order = 0): AgentToolCall {
  return { id: `call-${step}-${order}`, providerCallId: `provider-${step}-${order}`, runId: run.id, threadId: run.threadId, step, order, name: "workspace_overview", title: "检查工作区", arguments: "{}", effect: "read", highRisk: false, status: "completed", createdAt: run.createdAt, updatedAt: run.updatedAt };
}
function round(item: AgentToolCall, content: string) {
  return { role: "assistant" as const, content, tool_calls: [{ id: item.providerCallId, type: "function" as const, function: { name: item.name, arguments: item.arguments } }] };
}

describe("run activity presentation", () => {
  it("orders public reasoning and text before tools and merges only uninterrupted tool groups", () => {
    const calls = [call(3), call(1, 1), call(2), call(1)];
    const items = buildRunActivity({ ...run, activitySteps: [
      { step: 1, reasoning: "公开思考", reasoningDurationMs: 200, content: "先检查" },
      { step: 2, content: "  " },
      { step: 3, content: "继续检查" },
    ] }, calls);
    expect(items.map((item) => item.kind)).toEqual(["reasoning", "text", "tools", "text", "tools"]);
    expect(items[0]).toMatchObject({ content: "公开思考", durationMs: 200 });
    expect(items[2]).toMatchObject({ calls: [call(1), call(1, 1), call(2)] });
    expect(calls.map((item) => item.step)).toEqual([3, 1, 2, 1]);
    expect(buildRunActivity({ ...run, activitySteps: [{ step: 2, content: "", reasoning: "新思考" }] }, [call(1), call(2)]).map((item) => item.kind)).toEqual(["tools", "reasoning", "tools"]);
  });

  it("recovers only legacy rounds belonging to this run, never request history or opaque Responses data", () => {
    const first = call(1), second = call(2), foreign = { ...call(3), runId: "foreign" };
    const record: AgentRun = { ...run, requestMessages: [round(foreign, "历史内容")], continuationMessages: [round(foreign, "历史内容"), round(first, "本轮第一步"), { role: "tool", content: "工具私有原始结果", tool_call_id: first.providerCallId }, round(second, "本轮第二步")], responseItems: [{ type: "reasoning", summary: [{ type: "summary_text", text: "未授权展示来源" }], encrypted_content: "opaque-secret" }] };
    const items = buildRunActivity(record, [foreign, second, first]);
    expect(items.filter((item) => item.kind === "text").map((item) => item.content)).toEqual(["本轮第一步", "本轮第二步"]);
    expect(JSON.stringify(items)).not.toMatch(/历史内容|工具私有原始结果|opaque-secret|未授权展示来源/);
    expect(buildRunActivity({ ...record, activitySteps: [{ step: 1, content: "新快照" }] }, [first, second])[0]).toMatchObject({ content: "新快照" });
  });

  it("does not trust unmatched or mixed legacy call identities", () => {
    const first = call(1), second = call(2);
    expect(buildRunActivity({ ...run, continuationMessages: [{ ...round(first, "错误参数"), tool_calls: [{ ...round(first, "").tool_calls[0], function: { name: first.name, arguments: '{"foreign":true}' } }] }, { role: "assistant", content: "混合轮次", tool_calls: [...round(first, "").tool_calls, ...round(second, "").tool_calls] }] }, [first, second]).map((item) => item.kind)).toEqual(["tools"]);
  });

  it("uses the compacted base boundary when recovering legacy current-run text", () => {
    const first = call(1);
    const compactedBase = [{ role: "system" as const, content: "压缩后的背景" }];
    const record: AgentRun = {
      ...run,
      requestMessages: [{ role: "system", content: "旧背景" }, { role: "user", content: "旧问题" }, { role: "assistant", content: "旧回答" }],
      context: { policy: { autoCompress: true, limitHistory: false, historyMessageCount: 20 }, capacity: 128000, baseMessages: compactedBase, history: [], draft: "当前问题" },
      continuationMessages: [...compactedBase, round(first, "当前工具前说明")],
    };
    expect(buildRunActivity(record, [first])[0]).toMatchObject({ kind: "text", content: "当前工具前说明" });
    expect(isPersistedToolRound(record, { content: "当前工具前说明" }, [first])).toBe(true);
  });

  it("excludes base history even when a later run reuses the same provider call identity", () => {
    const first = call(1);
    const past = round(first, "其他执行的历史");
    const record = { ...run, requestMessages: [past], continuationMessages: [past] };
    expect(buildRunActivity(record, [first]).map((item) => item.kind)).toEqual(["tools"]);
    expect(isPersistedToolRound(record, { content: past.content }, [first])).toBe(false);
    expect(isPersistedToolRound({ ...record, continuationMessages: [past, round(first, "当前步骤")] }, { content: "当前步骤" })).toBe(true);
  });

  it("suppresses persisted current tool output but never a completed final answer", () => {
    const record = { ...run, modelStep: 2, activitySteps: [{ step: 1, content: "计划", reasoning: "思考" }] };
    expect(isPersistedToolRound(record, { content: "计划", reasoning: "思考" })).toBe(true);
    expect(isPersistedToolRound(record, { content: "新输出", reasoning: "思考" })).toBe(false);
    expect(isPersistedToolRound(record, { content: "计划", reasoning: "新思考" })).toBe(false);
    expect(liveRoundEcho(record, { content: "计划", reasoning: "新思考" })).toEqual({ content: true, reasoning: false });
    expect(isPersistedToolRound({ ...record, status: "completed" }, { content: "计划", reasoning: "思考" })).toBe(false);
    const first = call(1), history = { ...call(0), runId: "old" };
    const legacy = { ...run, requestMessages: [round(history, "过去")], continuationMessages: [round(history, "过去"), round(first, "当前")] };
    expect(isPersistedToolRound(legacy, { content: "当前" })).toBe(true);
    expect(isPersistedToolRound(legacy, { content: "当前" }, [first])).toBe(true);
    expect(isPersistedToolRound({ ...legacy, continuationMessages: [round(history, "过去")] }, { content: "过去" })).toBe(false);
  });

  it("keeps one copy when a later round repeats the sentence already shown before tools", () => {
    const first = call(1);
    const sentence = "哈哈，刚才我说“草稿已准备好”确实不准确";
    const record = {
      ...run,
      activitySteps: [
        { step: 1, content: sentence, reasoning: "思考" },
        { step: 2, content: sentence, reasoning: "收尾思考" },
      ],
    };
    const items = buildRunActivity(record, [first]);
    expect(items.filter((item) => item.kind === "text").map((item) => item.content)).toEqual([sentence]);
    expect(items.map((item) => item.kind)).toEqual(["reasoning", "text", "tools", "reasoning"]);
    expect(liveRoundEcho(record, { content: sentence, reasoning: "新思考" }, [first])).toEqual({ content: true, reasoning: false });
  });
});

describe("run elapsed time", () => {
  it("ticks only running records and freezes paused or ended runs", () => {
    const now = Date.parse(run.createdAt) + 90_000;
    expect(getRunElapsedMs(run, now)).toBe(90_000);
    expect(getRunElapsedMs({ ...run, status: "waiting_approval" }, now)).toBe(60_000);
    expect(getRunElapsedMs({ ...run, status: "completed", endedAt: "2026-09-21T00:00:24.000Z" }, now)).toBe(24_000);
    expect(getRunElapsedMs({ ...run, createdAt: "invalid" }, now)).toBe(0);
    expect(getRunElapsedMs(run, 0)).toBe(0);
  });
  it("formats finite nonnegative seconds, minutes and hours", () => {
    expect(formatRunElapsed(24_999)).toBe("24 秒");
    expect(formatRunElapsed(633_000)).toBe("10 分 33 秒");
    expect(formatRunElapsed(3_661_000)).toBe("1 小时 1 分 1 秒");
    expect(formatRunElapsed(NaN)).toBe("0 秒");
    expect(formatRunElapsed(-1)).toBe("0 秒");
  });
});

describe("a sentence already in the timeline is not drawn again as live output", () => {
    // Step 1 said something and called a tool; steps 2 and 3 only called tools. The message still carries step 1's text.
    const running = (steps: Array<{step: number; content: string; reasoning?: string}>) =>
        ({id: "r", threadId: "t", status: "running", hasToolCalls: true, requestMessages: [], activitySteps: steps}) as unknown as import("@/features/agent/models/agent").AgentRun;

    it("treats the stale sentence as an echo even when the newest steps carry no text", () => {
        const run = running([{step: 1, content: "我先做一次只读查询"}, {step: 2, content: ""}, {step: 3, content: ""}]);
        expect(liveRoundEcho(run, {content: "我先做一次只读查询", reasoning: ""}).content).toBe(true);
    });

    it("still shows genuinely new text that no saved step has said", () => {
        const run = running([{step: 1, content: "我先做一次只读查询"}, {step: 2, content: ""}]);
        expect(liveRoundEcho(run, {content: "查询结果如下", reasoning: ""}).content).toBe(false);
    });

    it("does not hide anything once the run has completed", () => {
        const run = {...running([{step: 1, content: "完成了"}]), status: "completed"} as never;
        expect(liveRoundEcho(run, {content: "完成了", reasoning: ""}).content).toBe(false);
    });

    it("shows text equal to an older step when the newest step has its own text, because it is new output", () => {
        const run = running([{step: 1, content: "重复的话"}, {step: 2, content: "另一段"}]);
        expect(liveRoundEcho(run, {content: "重复的话", reasoning: ""}).content).toBe(false);
    });
});
