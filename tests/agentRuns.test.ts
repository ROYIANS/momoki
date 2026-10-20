import { describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import {browserDatabase} from "@/platform/storage/browserDatabase";
import {createBrowserProductStore} from "@/platform/storage/browser";
import { db } from "@/platform/product/store";
import { beginAgentRun, checkpointAgentRun, finishAgentRun, canRetryRun, assertRetryConnector } from "@/features/agent/commands/agentRuns";
import {createChatThread} from "@/features/agent/commands/chat";
import {deleteChatThread} from "@/features/agent/commands/lifecycle";
import type {ConnectorConfig} from "@/features/settings/models/connector";
import {executeChatRun} from "@/features/agent/runtime/runChat";
import {createRunWriter} from "@momoki/agent-core";
import { recoverAbandonedRuns, withThreadRunLock, type ThreadLockManager } from "@/features/agent/runtime/runOwnership";

const connector: ConnectorConfig = { id: "cx", protocol: "openai-compatible", definitionId: "openai-compatible", baseUrl: "https://example.com/v1", apiKey: "secret-test-key", updatedAt: "2026-09-18T00:00:00Z" };
async function begin(content = "hello") {
  const thread = await createChatThread();
  return beginAgentRun({ threadId: thread.id, connector, model: "test", content });
}
function locksFixture() {
  const owned = new Set<string>();
  const locks: ThreadLockManager = { async request(name, _options, callback) {
    if (owned.has(name)) return callback(null);
    owned.add(name);
    try { return await callback({ name }); } finally { owned.delete(name); }
  } };
  return { locks, owned };
}

describe("durable Agent runs", () => {
  it("creates an agent, request snapshot and linked messages atomically without credentials", async () => {
    const run = await begin();
    expect(await db.agents.count()).toBe(1);
    expect(await db.chatMessages.count()).toBe(2);
    expect((await db.chatMessages.get(run.assistantMessageId))?.runId).toBe(run.id);
    expect(run.requestMessages.at(-1)).toEqual({ role: "user", content: "hello" });
    expect(JSON.stringify(run)).not.toContain(connector.apiKey);
    await expect(beginAgentRun({ threadId: "missing", connector, model: "test", content: "hi" })).rejects.toThrow("不存在");
    expect(await db.agentRuns.count()).toBe(1);
  });
  it("freezes conversation mode without skills or tool schemas", async () => {
    const thread = await createChatThread();
    const run = await beginAgentRun({ threadId: thread.id, connector, model: "test", content: "只聊天", interactionMode: "conversation" });
    expect(run.interactionMode).toBe("conversation");
    expect(run.enabledToolNames).toEqual([]);
    expect(run.skillInstructions).toBe("");
    expect(run.requestMessages.some((message) => message.role === "system" && message.content.includes("workspace_overview"))).toBe(false);
  });
  it("keeps conversation mode across retry and sends no tool definitions", async () => {
    const thread = await createChatThread();
    const run = await beginAgentRun({ threadId: thread.id, connector, model: "test", content: "plain", interactionMode: "conversation" });
    await finishAgentRun(run.id, "failed");
    const retry = await beginAgentRun({ threadId: thread.id, connector, model: "test", retryOfRunId: run.id, interactionMode: "smart" });
    expect(retry.interactionMode).toBe("conversation");
    expect(retry.enabledToolNames).toEqual([]);
    const requests: Record<string, unknown>[] = [];
    await executeChatRun(retry, connector.apiKey, new AbortController(), (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: { content: "answer" }, finish_reason: "stop" }] });
    }) as typeof fetch);
    expect(requests).toHaveLength(1);
    expect(requests[0].tools).toBeUndefined();
    expect((await db.agentRuns.get(retry.id))?.status).toBe("completed");
  });
  it("does not enable today's skills on a legacy retry with no tool snapshot", async () => {
    const run = await begin();
    await finishAgentRun(run.id, "failed");
    await db.agentRuns.update(run.id, { enabledToolNames: undefined, skillInstructions: undefined, interactionMode: undefined, toolLoading: undefined });
    const retry = await beginAgentRun({ threadId: run.threadId, connector, model: "test", retryOfRunId: run.id, interactionMode: "conversation" });
    expect(retry.enabledToolNames).toEqual([]);
    expect(retry.skillInstructions).toBe("");
  });
  it("rejects credentials in base URLs and competing begins", async () => {
    const run = await begin();
    await expect(beginAgentRun({ threadId: run.threadId, connector, model: "test", content: "second" })).rejects.toThrow("已有执行");
    await expect(beginAgentRun({ threadId: run.threadId, connector: { ...connector, baseUrl: "https://example.com/v1?key=secret" }, model: "test", content: "hi" })).rejects.toThrow("连接地址");
    expect(await db.chatMessages.count()).toBe(2);
  });
  it("ignores out-of-order and post-terminal checkpoints", async () => {
    const run = await begin();
    await checkpointAgentRun(run.id, 2, { content: "new" });
    await checkpointAgentRun(run.id, 1, { content: "old" });
    await finishAgentRun(run.id, "completed", { content: "final" });
    await checkpointAgentRun(run.id, 3, { content: "late" });
    await finishAgentRun(run.id, "failed", { content: "wrong" });
    expect(await db.chatMessages.get(run.assistantMessageId)).toMatchObject({ content: "final", status: "complete" });
  });
  it("preserves partial attempts and retries original context once in follow-up history", async () => {
    const run = await begin();
    await finishAgentRun(run.id, "failed", { content: "partial" }, "network failure");
    const retry = await beginAgentRun({ threadId: run.threadId, connector, model: "test", retryOfRunId: run.id });
    expect(retry.requestMessages).toEqual(run.requestMessages);
    expect(retry.userMessageId).toBe(run.userMessageId);
    expect(retry.retryOfRunId).toBe(run.id);
    expect(await db.chatMessages.count()).toBe(3);
    await finishAgentRun(retry.id, "completed", { content: "answer" });
    const next = await beginAgentRun({ threadId: run.threadId, connector, model: "new-model", content: "next" });
    expect(next.requestMessages.map((m) => m.content)).not.toContain("partial");
    expect(next.requestMessages.filter((m) => m.content === "answer")).toHaveLength(1);
    expect(next.requestMessages.filter((m) => m.content === "hello")).toHaveLength(1);
    expect((await db.chatMessages.get(run.assistantMessageId))?.error).toBe("network failure");
  });
  it("refuses retries of completed, superseded or foreign runs and changed providers", async () => {
    const run = await begin();
    await finishAgentRun(run.id, "failed", { content: "" });
    expect(() => assertRetryConnector(run, { ...connector, baseUrl: "https://elsewhere.test/v1" })).toThrow("原连接");
    expect(() => assertRetryConnector(run, { ...connector, apiKey: "rotated" })).not.toThrow();
    await beginAgentRun({ threadId: run.threadId, connector, model: "test", content: "next" });
    const history = await db.chatMessages.where("threadId").equals(run.threadId).toArray();
    const runs = await db.agentRuns.toArray();
    expect(canRetryRun({ ...run, status: "failed" }, runs, history)).toBe(false);
    await expect(beginAgentRun({ threadId: run.threadId, connector, model: "test", retryOfRunId: run.id })).rejects.toThrow();
  });
  it("deletes runs and never resurrects deleted threads/messages", async () => {
    const run = await begin();
    await deleteChatThread(run.threadId);
    await expect(checkpointAgentRun(run.id, 1, { content: "late" })).rejects.toThrow("已删除");
    await finishAgentRun(run.id, "completed", { content: "late" });
    expect(await db.agentRuns.count()).toBe(0);
    expect(await db.chatMessages.count()).toBe(0);
    expect(await db.chatThreads.count()).toBe(0);
  });
  it("recovers only abandoned runs and rejects another tab while a lock is held", async () => {
    const { locks } = locksFixture();
    const abandoned = await begin("abandoned");
    await checkpointAgentRun(abandoned.id, 1, { content: "saved partial" });
    const thread = await createChatThread();
    await withThreadRunLock(thread.id, async () => {
      const active = await beginAgentRun({ threadId: thread.id, connector, model: "test", content: "active" });
      await recoverAbandonedRuns(locks);
      expect((await db.agentRuns.get(active.id))?.status).toBe("running");
      expect((await db.agentRuns.get(abandoned.id))?.status).toBe("interrupted");
      await expect(withThreadRunLock(thread.id, async () => undefined, locks)).rejects.toThrow("另一个页面");
    }, locks);
    await recoverAbandonedRuns(locks);
    expect((await db.agentRuns.where("status").equals("running").count())).toBe(0);
    expect((await db.chatMessages.get(abandoned.assistantMessageId))?.content).toBe("saved partial");
  });
  it("upgrades v7 without losing history and marks orphan streams interrupted", async () => {
    if (!browserDatabase) throw new Error("Historical migration comparator requires browser storage");
    const db=createBrowserProductStore(browserDatabase);
    await db.delete();
    const old = new Dexie("aifenjing");
    old.version(7).stores({ projects: "id, updatedAt", characters: "id, projectId, updatedAt", scenes: "id, projectId, updatedAt", props: "id, projectId, updatedAt", styles: "id, projectId, updatedAt", episodes: "id, projectId, order, updatedAt", shots: "id, projectId, episodeId, order", media: "id, projectId", connectors: "id, definitionId, updatedAt", chatThreads: "id, updatedAt", chatMessages: "id, threadId, createdAt", productionProposals: "id, projectId, episodeId, status, createdAt" });
    await old.open();
    await old.table("chatMessages").bulkAdd([
      { id: "partial", threadId: "t", role: "assistant", content: "kept", status: "streaming", createdAt: "2026-01-01" },
      { id: "complete", threadId: "t", role: "assistant", content: "done", status: "complete", createdAt: "2026-01-01" },
    ]);
    old.close();
    await db.open();
    expect(await db.chatMessages.get("partial")).toMatchObject({ content: "kept", status: "interrupted" });
    expect(await db.chatMessages.get("complete")).toMatchObject({ content: "done", status: "complete" });
  });
});

describe("checkpoint writer and runtime", () => {
  it("serializes/coalesces slow writes and flushes newest content", async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const values: string[] = [];
    const persist = vi.fn(async (_seq: number, output: { content: string }) => { if (!values.length) await first; values.push(output.content); });
    const writer = createRunWriter(persist, vi.fn());
    writer.push({ content: "a" }); writer.push({ content: "ab" }); writer.push({ content: "abc" });
    expect(persist).toHaveBeenCalledTimes(1);
    release(); await writer.flush();
    expect(values).toEqual(["a", "abc"]);
  });
  it("surfaces persistence failure and stops new checkpoints", async () => {
    const stop = vi.fn(); const persist = vi.fn(async () => { throw new Error("quota"); });
    const writer = createRunWriter(persist, stop);
    writer.push({ content: "a" });
    await expect(writer.flush()).rejects.toThrow("quota");
    writer.push({ content: "b" });
    expect(stop).toHaveBeenCalledTimes(1); expect(persist).toHaveBeenCalledTimes(1);
  });
  it("persists complete/error/stop without putting error text in answers", async () => {
    const complete = await begin();
    await executeChatRun(complete, connector.apiKey, new AbortController(), vi.fn(async () => Response.json({ choices: [{ message: { content: "answer" }, finish_reason: "stop" }] })));
    expect(await db.chatMessages.get(complete.assistantMessageId)).toMatchObject({ content: "answer", status: "complete" });
    const fail = await begin();
    await executeChatRun(fail, connector.apiKey, new AbortController(), vi.fn(async () => new Response("denied", { status: 403 })));
    expect(await db.chatMessages.get(fail.assistantMessageId)).toMatchObject({ content: "", status: "error" });
    const stop = await begin(); const abort = new AbortController(); abort.abort(); const fetcher = vi.fn();
    await executeChatRun(stop, connector.apiKey, abort, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await db.agentRuns.get(stop.id))?.status).toBe("cancelled");
  });
});
