import type {AgentRun, AgentRunOutput} from '../models/agent';
import type {RuntimeEvent} from '@momoki/agent-core';

export type ExecutionFeedbackPhase = 'preparing' | 'waiting_model' | 'receiving' | 'working' | 'waiting_approval' | 'stopping';
type PublicKind = 'content' | 'reasoning';
type RunIdentity = Pick<AgentRun, 'id' | 'threadId' | 'assistantMessageId'>;
type RuntimeIdentity = {runId: string; executionId: string};
type RuntimeFeedbackEvent = RuntimeEvent
    | (RuntimeIdentity & {type: 'started'; threadId: string; assistantMessageId: string})
    | (RuntimeIdentity & {type: 'baseline'; output: AgentRunOutput})
    | (RuntimeIdentity & {type: 'preparing' | 'requestInvoked' | 'working'})
    | (RuntimeIdentity & {type: 'publicReceived'; kind: PublicKind});

/** Optional observation only: neither this port nor its failures may affect execution. */
export type RuntimeExecutionFeedback = (event: RuntimeFeedbackEvent) => void;

export interface ExecutionFeedbackSnapshot {
    invocationId: string;
    threadId?: string;
    runId?: string;
    assistantMessageId?: string;
    phase: ExecutionFeedbackPhase | undefined;
    outputRevision: number;
}

export interface ExecutionFeedbackInvocation {
    bindThread(threadId: string): void;
    admitted(run: RunIdentity): void;
    provisionalCommitted(): void;
    requestStop(): boolean;
    release(): void;
    /** Call only from an actual visible public-text DOM owner, never from a queued render. */
    publicCommitted(output: {runId: string; assistantMessageId: string; kind: PublicKind; text: string}): boolean;
    runtime: RuntimeExecutionFeedback;
}

type TimingSink = Pick<Performance, 'mark' | 'measure' | 'clearMarks' | 'clearMeasures'>;
type MarkName = 'submitted' | 'provisionalCommitted' | 'admitted' | 'requestInvoked' | 'firstPublicReceived'
    | 'firstCheckpointConfirmed' | 'firstPublicCommitted' | 'stopRequested' | 'settled' | 'released';
type Signature = {length: number; hash: number};
type OutputSignatures = Partial<Record<PublicKind, Signature>>;
type Trace = {prefix: string; marks: Map<MarkName, number>; entries: Array<{kind: 'mark' | 'measure'; name: string}>};
type InvocationState = {
    snapshot: ExecutionFeedbackSnapshot;
    trace: Trace;
    executionId?: string;
    sequence: number;
    baseline: OutputSignatures;
    confirmed: OutputSignatures;
    received: Set<PublicKind>;
    released: boolean;
    stopped: boolean;
    settled: boolean;
};
let controllerSequence = 0;

/** A diagnostic correlation guard, not an authorization/content-integrity hash. No text is retained. */
function signature(text: string): Signature | undefined {
    // The existing current reasoning/body presenters trim outer whitespace.
    const value = text.trim();
    if (!value) return undefined;
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    return {length: value.length, hash: hash >>> 0};
}

function sameSignature(left: Signature | undefined, right: Signature | undefined): boolean {
    return !!left && !!right && left.length === right.length && left.hash === right.hash;
}

function outputSignatures(output: AgentRunOutput): OutputSignatures {
    return {content: signature(output.content), reasoning: signature(output.reasoning ?? '')};
}

/** One mounted Agent owner, at most eight traces / 136 exact owned User Timing entries. */
export function createExecutionFeedbackController(options: {
    onChange?: (snapshot: ExecutionFeedbackSnapshot | undefined) => void;
    now?: () => number;
    timing?: TimingSink;
} = {}) {
    const ownerId = ++controllerSequence;
    let invocationSequence = 0;
    let current: InvocationState | undefined;
    let lastTime = 0;
    const traces: Trace[] = [];
    const timing = options.timing ?? (typeof performance !== 'undefined' ? performance : undefined);
    let timingEnabled = false;
    try {
        timingEnabled = !!timing && ['mark', 'measure', 'clearMarks', 'clearMeasures'].every(name => typeof Reflect.get(timing, name) === 'function');
    } catch { /* Unsupported diagnostic capabilities do not affect the controller. */ }
    const now = () => {
        try {
            const value = options.now ? options.now() : performance.now();
            if (Number.isFinite(value)) lastTime = Math.max(lastTime, value);
        } catch { /* Diagnostics cannot break an execution without a monotonic clock. */ }
        return lastTime;
    };
    const notify = () => {
        try { options.onChange?.(current ? {...current.snapshot} : undefined); }
        catch { /* Presentation observation is optional. */ }
    };
    const clear = (trace: Trace) => {
        for (const entry of trace.entries) {
            try {
                if (entry.kind === 'mark') timing?.clearMarks(entry.name);
                else timing?.clearMeasures(entry.name);
            } catch { timingEnabled = false; /* Do not accumulate more entries when exact cleanup is unavailable. */ }
        }
        trace.entries.length = 0;
        trace.marks.clear();
    };
    const mark = (state: InvocationState, name: MarkName) => {
        if (state !== current || state.trace.marks.has(name)) return;
        const at = now();
        const trace = state.trace;
        trace.marks.set(name, at);
        const fullName = `${trace.prefix}.${name}`;
        // Names and metadata contain no product IDs, content, errors or transport data.
        if (timingEnabled) {
            trace.entries.push({kind: 'mark', name: fullName});
            try { timing?.mark(fullName, {startTime: at}); }
            catch { timingEnabled = false; /* User Timing support is optional. */ }
        }
        const intervals: Partial<Record<MarkName, [MarkName, string]>> = {
            provisionalCommitted: ['submitted', 'submissionToProvisional'],
            requestInvoked: ['admitted', 'admissionToRequest'],
            firstPublicReceived: ['requestInvoked', 'requestToPublicReceipt'],
            firstCheckpointConfirmed: ['firstPublicReceived', 'receiptToCheckpoint'],
            firstPublicCommitted: ['firstPublicReceived', 'receiptToPublicCommit'],
            settled: ['submitted', 'submissionToSettlement'],
            released: ['submitted', 'submissionToRelease'],
        };
        const interval = intervals[name];
        if (!interval) return;
        const start = trace.marks.get(interval[0]);
        if (start === undefined) return;
        const measureName = `${trace.prefix}.${interval[1]}`;
        if (timingEnabled) {
            trace.entries.push({kind: 'measure', name: measureName});
            try { timing?.measure(measureName, {start, end: at}); }
            catch { timingEnabled = false; /* An unavailable optional measure must not affect execution. */ }
        }
    };
    const setPhase = (state: InvocationState, phase: ExecutionFeedbackPhase) => {
        if (state !== current || state.released || state.settled || state.stopped || state.snapshot.phase === phase) return;
        state.snapshot.phase = phase;
        notify();
    };
    const bindRun = (state: InvocationState, run: RunIdentity) => {
        if (state !== current || state.released || state.snapshot.threadId && state.snapshot.threadId !== run.threadId
            || state.snapshot.runId && (state.snapshot.runId !== run.id || state.snapshot.assistantMessageId !== run.assistantMessageId)) return false;
        state.snapshot = {...state.snapshot, threadId: run.threadId, runId: run.id, assistantMessageId: run.assistantMessageId};
        return true;
    };
    const observe = (state: InvocationState, event: RuntimeFeedbackEvent) => {
        if (state !== current || state.released) return;
        if (event.type === 'started') {
            if (state.executionId || !bindRun(state, {id: event.runId, threadId: event.threadId, assistantMessageId: event.assistantMessageId})) return;
            state.executionId = event.executionId;
            // A resumed invocation already has a known durable run; fresh admission may have marked earlier.
            mark(state, 'admitted');
            notify();
            return;
        }
        if (state.executionId !== event.executionId || state.snapshot.runId !== event.runId) return;
        if ('sequence' in event) {
            if (event.sequence <= state.sequence) return;
            state.sequence = event.sequence;
        }
        switch (event.type) {
            case 'baseline':
                state.baseline = outputSignatures(event.output);
                return;
            case 'preparing':
                setPhase(state, 'preparing');
                return;
            case 'requestInvoked':
                mark(state, 'requestInvoked');
                setPhase(state, 'waiting_model');
                return;
            case 'publicReceived':
                state.received.add(event.kind);
                mark(state, 'firstPublicReceived');
                setPhase(state, 'receiving');
                return;
            case 'checkpoint':
                if (!state.received.size || state.trace.marks.has('firstPublicCommitted')) return;
                state.confirmed = outputSignatures(event.output);
                if (!state.confirmed.content && !state.confirmed.reasoning) return;
                mark(state, 'firstCheckpointConfirmed');
                if (!state.trace.marks.has('firstPublicCommitted')) {
                    state.snapshot.outputRevision++;
                    notify();
                }
                return;
            case 'working':
            case 'tool_round':
            case 'tool_completed':
                setPhase(state, 'working');
                return;
            case 'approval':
                setPhase(state, 'waiting_approval');
                return;
            case 'settled':
                mark(state, 'settled');
                state.settled = true;
                return;
            case 'output':
                // Provisional output is not a checkpoint or proof of DOM publication.
                return;
        }
    };
    return {
        begin(invocationId: string, threadId?: string): ExecutionFeedbackInvocation {
            const trace: Trace = {prefix: `momoki.agent.${ownerId}-${++invocationSequence}`, marks: new Map(), entries: []};
            traces.push(trace);
            if (traces.length > 8) clear(traces.shift()!);
            const state: InvocationState = {snapshot: {invocationId, threadId, phase: 'preparing', outputRevision: 0}, trace,
                sequence: 0, baseline: {}, confirmed: {}, received: new Set(), released: false, stopped: false, settled: false};
            current = state;
            mark(state, 'submitted');
            notify();
            return {
                bindThread(id) {
                    if (state !== current || state.released || state.snapshot.threadId && state.snapshot.threadId !== id) return;
                    state.snapshot.threadId = id;
                    notify();
                },
                admitted(run) {
                    if (!bindRun(state, run)) return;
                    mark(state, 'admitted');
                    notify();
                },
                provisionalCommitted() { if (!state.released) mark(state, 'provisionalCommitted'); },
                requestStop() {
                    if (state !== current || state.released || state.stopped) return false;
                    state.stopped = true;
                    state.snapshot.phase = 'stopping';
                    mark(state, 'stopRequested');
                    notify();
                    return true;
                },
                release() {
                    if (state !== current || state.released) return;
                    mark(state, 'released');
                    state.released = true;
                    state.snapshot.phase = undefined;
                    // Keep compact lineage until the next invocation: a store query may publish after release.
                    notify();
                },
                publicCommitted(output) {
                    if (state !== current || state.snapshot.runId !== output.runId || state.snapshot.assistantMessageId !== output.assistantMessageId
                        || !state.received.has(output.kind)) return false;
                    if (state.trace.marks.has('firstPublicCommitted')) return true;
                    const visible = signature(output.text);
                    if (!sameSignature(visible, state.confirmed[output.kind]) || sameSignature(visible, state.baseline[output.kind])) return false;
                    mark(state, 'firstPublicCommitted');
                    return true;
                },
                runtime(event) {
                    try { observe(state, event); }
                    catch { /* No diagnostic observer error may enter the runtime. */ }
                },
            };
        },
        /** Content-free collection path (tests / dev tooling): trace prefix plus relative mark times, newest last. */
        timeline(): Array<{trace: string; marks: Partial<Record<MarkName, number>>}> {
            return traces.map(trace => ({trace: trace.prefix, marks: Object.fromEntries(trace.marks)}));
        },
        dispose() {
            current = undefined;
            traces.splice(0).forEach(clear);
            // Reusable after StrictMode cleanup; old invocation handles remain invalidated.
        },
    };
}
