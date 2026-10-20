import {describe, expect, it} from "vitest";
import {buildRunActivity} from "@/features/agent/runtime/runPresentation";
import type {AgentRun, AgentToolCall} from "@/features/agent/models/agent";
import type {ChatMessage} from "@/features/agent/models/chat";

const run = {id: "run", threadId: "t", requestMessages: []} as unknown as AgentRun;
const call = (step: number): AgentToolCall => ({id: `c${step}`, runId: "run", threadId: "t", providerCallId: `p${step}`, step, order: 0,
    name: "x", arguments: "{}"} as unknown as AgentToolCall);
const steered = (id: string, afterStep: number, createdAt: string): ChatMessage =>
    ({id, threadId: "t", role: "user", content: id, createdAt, status: "complete", steeredIntoRunId: "run", steeredAfterStep: afterStep});
const shape = (items: ReturnType<typeof buildRunActivity>) => items.map(item => item.kind === "user" ? `user:${item.message.id}` : item.kind === "tools" ? `tools:${item.calls.map(c => c.step)}` : item.kind);

describe("steered messages sit where the run took them in", () => {
    it("places a message between the tool rounds it was delivered between", () => {
        const items = buildRunActivity(run, [call(1), call(2), call(3)], [steered("a", 1, "2026-10-20T10:00:01Z")]);
        // Delivered after step 1: step 1 stays above it, steps 2 and 3 follow it.
        expect(shape(items)).toEqual(["tools:1", "user:a", "tools:2,3"]);
    });

    it("keeps several messages in the order they were delivered, each at its own boundary", () => {
        const items = buildRunActivity(run, [call(1), call(2), call(3)], [
            steered("late", 2, "2026-10-20T10:00:09Z"), steered("early", 1, "2026-10-20T10:00:03Z")]);
        expect(shape(items)).toEqual(["tools:1", "user:early", "tools:2", "user:late", "tools:3"]);
    });

    it("puts a message delivered after the last step at the end, and one before any step at the start", () => {
        expect(shape(buildRunActivity(run, [call(1), call(2)], [steered("end", 2, "2026-10-20T10:00:05Z")])))
            .toEqual(["tools:1,2", "user:end"]);
        expect(shape(buildRunActivity(run, [call(1)], [steered("start", 0, "2026-10-20T10:00:05Z")])))
            .toEqual(["user:start", "tools:1"]);
    });

    it("changes nothing when nothing was steered", () => {
        expect(shape(buildRunActivity(run, [call(1), call(2)]))).toEqual(["tools:1,2"]);
    });
});
