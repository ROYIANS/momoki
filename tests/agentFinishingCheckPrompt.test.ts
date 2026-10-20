import { describe, expect, it } from "vitest";
import type { AgentRun, AgentToolCall } from "@/features/agent/models/agent";
import { buildFinishingCheckPrompt } from "@/features/agent/runtime/finishingCheck";
import { createWriteReceipt } from "@/features/agent/runtime/writeReceipt";

const run: AgentRun = {
  id: "run", threadId: "thread", projectId: "project", agentId: "agent",
  agentSnapshot: { name: "Agent", instructions: "private-instructions" },
  userMessageId: "user", assistantMessageId: "assistant", model: "test",
  connector: { id: "connector", definitionId: "openai-compatible", baseUrl: "https://example.com/v1" },
  requestMessages: [], status: "running", checkpoint: 0, modelStep: 3,
  plan: [{ id: "p", title: "private-plan-claims-completed-generation", status: "pending" }],
  createdAt: "2026-09-22", updatedAt: "2026-09-22",
};
const call = (patch: Partial<AgentToolCall> = {}): AgentToolCall => ({
  id: "call", runId: "run", threadId: "thread", providerCallId: "provider", step: 1, order: 0,
  name: "music_save_draft", title: "private-title", arguments: "private-arguments", effect: "write", atomic: true,
  highRisk: false, status: "completed", result: JSON.stringify({
    writeReceipt: createWriteReceipt([{ kind: "music_draft", operation: "updated", id: "draft", ownerId: "project", revision: 4, label: "private-label" }]),
    private: "private-raw-payload", jobId: "invented-job", status: "processing",
  }), createdAt: "2026-09-22", updatedAt: "2026-09-22", ...patch,
});
const facts = (prompt: string) => JSON.parse(prompt.split("\n\n").at(-1)!);

describe("finishing check evidence", () => {
  it("uses owned validated historical receipts with source IDs, not labels or arbitrary job claims", () => {
    const prompt = buildFinishingCheckPrompt(run, [call(), call({ threadId: "foreign", id: "foreign" })]);
    expect(facts(prompt)).toMatchObject({
      runId: "run", projectId: "project", observedAfterModelStep: 3,
      plan: { total: 1, unfinished: 1, isBusinessEvidence: false },
      calls: { total: 1, completed: { write: 1 } },
      historicalDirectWrites: { total: 1, omitted: 0, uncoveredCompletedWriteCalls: 0,
        receipts: [{ kind: "music_draft", operation: "updated", id: "draft", ownerId: "project", revision: 4, callId: "call" }] },
    });
    expect(prompt).not.toMatch(/private-|invented-job|processing/);
  });

  it("does not convert bookkeeping, network success or uncovered writes into saved works", () => {
    const input = [call({ id: "plan", effect: "bookkeeping", name: "update_run_plan" }),
      call({ id: "network", effect: "network", name: "music_generate" }),
      call({ id: "missing-receipt", result: JSON.stringify({ saved: true, revision: 8 }) })];
    const result = facts(buildFinishingCheckPrompt(run, input));
    expect(result.calls.completed).toEqual({ read: 0, write: 1, network: 1, bookkeeping: 1 });
    expect(result.historicalDirectWrites).toEqual({ total: 0, receipts: [], omitted: 0, uncoveredCompletedWriteCalls: 1 });
  });

  it("retains failure and uncertain counts while excluding foreign and duplicate ledger rows", () => {
    const valid = call();
    const result = facts(buildFinishingCheckPrompt(run, [valid, valid,
      call({ id: "failed", status: "failed" }), call({ id: "rejected", status: "rejected" }),
      call({ id: "unknown", status: "unknown" }), call({ id: "foreign", runId: "other", status: "unknown" })]));
    expect(result.calls).toMatchObject({ total: 4, completed: { write: 1 }, failed: 1, rejected: 1, unresolved: 1 });
    expect(result.historicalDirectWrites.total).toBe(1);
  });

  it("bounds evidence and exposes omitted operations instead of implying full coverage", () => {
    const prompt = buildFinishingCheckPrompt(run, Array.from({ length: 80 }, (_, index) => call({ id: `call-${index}`, step: index })));
    expect(facts(prompt).historicalDirectWrites).toMatchObject({ total: 80, omitted: 60 });
    expect(facts(prompt).historicalDirectWrites.receipts).toHaveLength(20);
    expect(prompt.length).toBeLessThan(10000);
  });

  it("lists which fields each write asked to change, without their values, so a claim can be checked", () => {
    const note = call({ id: "note", name: "shot_update", arguments: JSON.stringify({ id: "shot-11", expectedRevision: 3, patch: { notes: "SECRET 衔接设计：共用交接帧" } }) });
    const frame = call({ id: "frame", name: "slot_update", arguments: JSON.stringify({ ownerId: "project", slot: "lastFrame", result: "media-1" }) });
    const prompt = buildFinishingCheckPrompt(run, [note, frame, call({ id: "bad", name: "shot_update", arguments: "not json" })]);
    expect(facts(prompt).writeCalls).toEqual([
      { tool: "shot_update", fields: ["notes"] },
      { tool: "slot_update", fields: ["slot", "result"] },
      { tool: "shot_update", fields: [] },
    ]);
    expect(prompt).not.toContain("SECRET");
    expect(prompt).toContain("只把设计写进备注");
  });
});
