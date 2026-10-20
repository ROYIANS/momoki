import {describe, expect, it, vi} from 'vitest';
import {createExecutionFeedbackController, type ExecutionFeedbackSnapshot, type RuntimeExecutionFeedback} from '@/features/agent/runtime/executionFeedback';

function timingFixture() {
    const entries = new Map<string, unknown>();
    return {
        entries,
        mark: vi.fn((name: string, options?: PerformanceMarkOptions) => { entries.set(name, options); return {} as PerformanceMark; }),
        measure: vi.fn((name: string, options?: PerformanceMeasureOptions | string) => { entries.set(name, options); return {} as PerformanceMeasure; }),
        clearMarks: vi.fn((name?: string) => { if (name) entries.delete(name); }),
        clearMeasures: vi.fn((name?: string) => { if (name) entries.delete(name); }),
    };
}
const run = {id: 'run-private', threadId: 'thread-private', assistantMessageId: 'assistant-private'};
const identity = {runId: run.id, executionId: 'exec-private'};
const started = {...identity, type: 'started' as const, threadId: run.threadId, assistantMessageId: run.assistantMessageId};
const names = (sink: ReturnType<typeof timingFixture>) => [...sink.entries.keys()].map(name => name.split('.').at(-1));

describe('invocation-owned execution feedback', () => {
    it('records independent actual receipt, confirmed checkpoint and visible DOM boundaries', () => {
        const sink = timingFixture();
        let at = 10;
        let snapshot: ExecutionFeedbackSnapshot | undefined;
        const owner = createExecutionFeedbackController({timing: sink, now: () => at, onChange: next => { snapshot = next; }});
        const invocation = owner.begin('token-private');
        at = 20; invocation.provisionalCommitted();
        invocation.bindThread(run.threadId);
        at = 30; invocation.admitted(run);
        invocation.runtime(started);
        invocation.runtime({...identity, type: 'baseline', output: {content: ''}});
        at = 40; invocation.runtime({...identity, type: 'requestInvoked'});
        expect(snapshot?.phase).toBe('waiting_model');
        at = 55; invocation.runtime({...identity, type: 'publicReceived', kind: 'content'});
        invocation.runtime({...identity, type: 'output', sequence: 1, confirmed: false, output: {content: 'private answer'}});
        expect(snapshot?.phase).toBe('receiving');
        invocation.publicCommitted({runId: run.id, assistantMessageId: run.assistantMessageId, kind: 'content', text: 'private answer'});
        expect(names(sink)).not.toContain('firstPublicCommitted');
        at = 70; invocation.runtime({...identity, type: 'checkpoint', sequence: 2, checkpoint: 1, confirmed: true, output: {content: 'private answer'}});
        expect(snapshot?.outputRevision).toBe(1);
        at = 90; invocation.publicCommitted({runId: run.id, assistantMessageId: run.assistantMessageId, kind: 'content', text: 'private answer'});
        at = 100; invocation.runtime({...identity, type: 'settled', sequence: 3, confirmed: true, status: 'completed'});
        at = 110; invocation.release();
        expect(snapshot?.phase).toBeUndefined();
        const markOptions = Object.fromEntries(sink.mark.mock.calls.map(([name, options]) => [name.split('.').at(-1), options]));
        expect(markOptions).toMatchObject({submitted: {startTime: 10}, provisionalCommitted: {startTime: 20}, admitted: {startTime: 30}, requestInvoked: {startTime: 40}, firstPublicReceived: {startTime: 55}, firstCheckpointConfirmed: {startTime: 70}, firstPublicCommitted: {startTime: 90}, settled: {startTime: 100}, released: {startTime: 110}});
        expect(sink.measure.mock.calls.find(([name]) => name.endsWith('receiptToPublicCommit'))?.[1]).toEqual({start: 55, end: 90});
        expect(JSON.stringify([...sink.entries])).not.toMatch(/private|answer|thread|assistant/);
        owner.dispose();
    });

    it('makes Stop synchronous and repeat-safe while ignoring stale runtime and run identities', () => {
        const sink = timingFixture();
        let snapshot: ExecutionFeedbackSnapshot | undefined;
        const owner = createExecutionFeedbackController({timing: sink, onChange: next => { snapshot = next; }});
        const first = owner.begin('first', run.threadId);
        first.admitted(run); first.runtime(started);
        expect(first.requestStop()).toBe(true);
        expect(snapshot?.phase).toBe('stopping');
        expect(first.requestStop()).toBe(false);
        first.runtime({...identity, type: 'approval', sequence: 1, confirmed: true});
        first.runtime({...identity, type: 'preparing'});
        first.runtime({...identity, type: 'requestInvoked'});
        expect(snapshot?.phase).toBe('stopping');
        expect(sink.mark.mock.calls.filter(([name]) => name.endsWith('.stopRequested'))).toHaveLength(1);
        first.release();
        const second = owner.begin('second', run.threadId);
        second.admitted(run); second.runtime({...started, executionId: 'second-exec'});
        first.release(); first.requestStop(); first.runtime({...identity, type: 'preparing'});
        second.runtime({...identity, type: 'publicReceived', kind: 'content'});
        second.runtime({...identity, executionId: 'second-exec', runId: 'foreign', type: 'working'});
        expect(snapshot).toMatchObject({invocationId: 'second', phase: 'preparing'});
        second.runtime({...identity, executionId: 'second-exec', type: 'approval', sequence: 3, confirmed: true});
        second.runtime({...identity, executionId: 'second-exec', type: 'tool_round', sequence: 2, step: 1, confirmed: true});
        expect(snapshot?.phase).toBe('waiting_approval');
        owner.dispose();
    });

    it('excludes saved resume text and permits a confirmed new DOM publication after release', () => {
        const sink = timingFixture();
        const owner = createExecutionFeedbackController({timing: sink});
        const invocation = owner.begin('resume', run.threadId);
        invocation.runtime(started);
        invocation.runtime({...identity, type: 'baseline', output: {content: 'saved old', reasoning: 'old reasoning'}});
        const visible = (text: string, kind: 'content' | 'reasoning' = 'content') => invocation.publicCommitted({runId: run.id, assistantMessageId: run.assistantMessageId, kind, text});
        visible('saved old');
        invocation.runtime({...identity, type: 'publicReceived', kind: 'reasoning'});
        invocation.runtime({...identity, type: 'checkpoint', confirmed: true, sequence: 1, checkpoint: 4, output: {content: 'saved old', reasoning: '  new reasoning\n'}});
        visible('saved old'); visible('old reasoning', 'reasoning');
        expect(names(sink)).not.toContain('firstPublicCommitted');
        invocation.release();
        visible('new reasoning', 'reasoning');
        expect(names(sink)).toContain('firstPublicCommitted');
        owner.dispose();
    });

    it('keeps phases local to real model/tool operations rather than monotonic progress', () => {
        let snapshot: ExecutionFeedbackSnapshot | undefined;
        const owner = createExecutionFeedbackController({timing: timingFixture(), onChange: next => { snapshot = next; }});
        const invocation = owner.begin('token', run.threadId); invocation.runtime(started);
        const send: RuntimeExecutionFeedback = invocation.runtime;
        send({...identity, type: 'requestInvoked'}); expect(snapshot?.phase).toBe('waiting_model');
        send({...identity, type: 'publicReceived', kind: 'reasoning'}); expect(snapshot?.phase).toBe('receiving');
        send({...identity, type: 'tool_round', confirmed: true, sequence: 1, step: 1}); expect(snapshot?.phase).toBe('working');
        send({...identity, type: 'preparing'}); expect(snapshot?.phase).toBe('preparing');
        send({...identity, type: 'requestInvoked'}); expect(snapshot?.phase).toBe('waiting_model');
        owner.dispose();
    });

    it('bounds traces and uses exact cleanup without clearing other owners', () => {
        const sink = timingFixture();
        sink.entries.set('other-owner.mark', {startTime: 0});
        const owner = createExecutionFeedbackController({timing: sink, now: () => 1});
        for (let index = 0; index < 40; index++) {
            const invocation = owner.begin(`token-${index}`, run.threadId);
            invocation.provisionalCommitted(); invocation.admitted(run); invocation.runtime(started);
            invocation.runtime({...identity, type: 'baseline', output: {content: ''}});
            for (let step = 0; step < 100; step++) {
                invocation.runtime({...identity, type: 'requestInvoked'});
                invocation.runtime({...identity, type: 'publicReceived', kind: 'content'});
                invocation.runtime({...identity, type: 'checkpoint', confirmed: true, sequence: step + 1, checkpoint: step + 1, output: {content: 'answer'}});
                invocation.publicCommitted({runId: run.id, assistantMessageId: run.assistantMessageId, kind: 'content', text: 'answer'});
            }
            invocation.requestStop();
            invocation.runtime({...identity, type: 'settled', sequence: 101, confirmed: true, status: 'cancelled'});
            invocation.release();
            expect(sink.entries.size - 1).toBeLessThanOrEqual(136);
        }
        const traceNames = new Set([...sink.entries.keys()].filter(name => name.startsWith('momoki.agent.')).map(name => name.split('.')[2]));
        expect(traceNames.size).toBe(8);
        owner.dispose();
        expect([...sink.entries.keys()]).toEqual(['other-owner.mark']);
        for (const [name] of [...sink.clearMarks.mock.calls, ...sink.clearMeasures.mock.calls]) expect(name?.startsWith('momoki.agent.')).toBe(true);
    });

    it('isolates clock, timing and notification failures and invalidates disposed handles', () => {
        const sink = timingFixture();
        sink.mark.mockImplementation(() => { throw new Error('unsupported'); });
        sink.measure.mockImplementation(() => { throw new Error('unsupported'); });
        sink.clearMarks.mockImplementation(() => { throw new Error('unsupported'); });
        const notify = vi.fn(() => { throw new Error('subscriber'); });
        const owner = createExecutionFeedbackController({timing: sink, now: () => { throw new Error('clock'); }, onChange: notify});
        const old = owner.begin('old', run.threadId); old.runtime(started);
        expect(old.requestStop()).toBe(true);
        expect(() => owner.dispose()).not.toThrow();
        const before = sink.mark.mock.calls.length;
        old.provisionalCommitted(); old.admitted(run); old.release(); old.runtime({...identity, type: 'requestInvoked'});
        expect(sink.mark).toHaveBeenCalledTimes(before);
        const next = owner.begin('after-effect-replay', run.threadId);
        expect(next.requestStop()).toBe(true);
        owner.dispose();
    });

    it('stops diagnostic writes if exact cleanup fails rather than growing the global timeline', () => {
        const sink = timingFixture();
        sink.clearMarks.mockImplementation(() => { throw new Error('cleanup unavailable'); });
        const owner = createExecutionFeedbackController({timing: sink});
        for (let index = 0; index < 100; index++) owner.begin(`token-${index}`).release();
        expect(sink.entries.size).toBeLessThanOrEqual(24);
        expect(sink.mark.mock.calls.length).toBe(16);
        owner.dispose();
    });
});

describe('timing collection path', () => {
    it('returns bounded, content-free relative marks without requiring User Timing support', () => {
        let at = 5;
        const owner = createExecutionFeedbackController({timing: undefined, now: () => at});
        for (let index = 0; index < 10; index++) { at += 1; owner.begin(`token-${index}`); }
        const first = owner.begin('token-private');
        at = 50; first.admitted(run);
        const timeline = owner.timeline();
        expect(timeline).toHaveLength(8);
        expect(timeline.at(-1)?.marks).toMatchObject({submitted: expect.any(Number), admitted: 50});
        expect(JSON.stringify(timeline)).not.toContain('private');
        owner.dispose();
        expect(owner.timeline()).toEqual([]);
    });
});
