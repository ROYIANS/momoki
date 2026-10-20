import {randomUUID} from 'node:crypto';
import {compactContext, estimateTokens, isContextSourcePrefix, replaceContinuationBase, type ContextSource} from '@momoki/agent-core';
import type {ResponseItem} from '@momoki/agent-providers';
import {TodoStore} from './store.js';
import type {TodoRun, TodoSummary} from './types.js';

/** The shared eight-pass algorithm commits this host's own summary jobs and verified base. */
export async function prepareContext(store: TodoStore, initial: TodoRun, signal: AbortSignal, hold?: (kind: 'checkpoint' | 'summary') => Promise<void>): Promise<TodoRun> {
    if (initial.scenario !== 'summary') return store.current(initial.id);
    return compactContext<TodoRun, ContextSource, TodoSummary, string, undefined>({
        read: () => Promise.resolve(store.current(initial.id)),
        assertSettled: run => {if (store.calls(run.id).some(call => !['completed', 'failed', 'rejected'].includes(call.status))) throw new Error('Pending tools cannot be summarized'); return Promise.resolve();},
        context: run => ({history: run.history, summaryId: run.summaryId, autoCompress: true}),
        budget: run => ({needsCompression: !run.summaryId, overBudget: false, outputReserve: 128}),
        readSummary: id => Promise.resolve(store.summaries(initial.id).find(summary => summary.id === id)),
        sameSource: () => true,
        input: (previous, selected) => `${previous?.content ?? ''}\n${selected.map(source => source.content).join('\n')}`,
        fits: () => true,
        create: (run, previous, selected, input) => ({id: randomUUID(), runId: run.id, baseRevision: run.revision, status: 'running', coverage: [...previous?.coverage ?? [], ...selected], content: '', beforeTokens: estimateTokens(input)}),
        begin: (run, summary) => {store.transaction(() => {const current = store.current(run.id); if (current.revision !== summary.baseRevision || current.status !== 'running') throw new Error('Stale summary begin'); store.saveSummary(summary);}); return Promise.resolve();},
        request: async run => {
            store.transaction(() => {const current = store.current(run.id); current.summaryRequests++; store.saveRun(current);});
            if (hold) await hold('summary');
            return {content: 'Earlier todos discussed.', hasToolCalls: false};
        },
        tokens: estimateTokens,
        activate: async (run, summary, content, _usage, activeSignal) => {
            await store.faults.beforeSummaryActivation?.();
            return store.transaction(() => {
                const current = store.current(run.id), saved = store.summaries(run.id).find(item => item.id === summary.id); activeSignal.throwIfAborted();
                if (!saved || saved.status !== 'running' || JSON.stringify(saved) !== JSON.stringify(summary)) throw new Error('Stale summary job');
                if (current.revision !== summary.baseRevision + 1 || current.status !== 'running' || current.summaryId !== run.summaryId || !isContextSourcePrefix(summary.coverage, current.history, () => true)) throw new Error('Stale summary activation');
                const oldBase: ResponseItem[] = [], newBase: ResponseItem[] = [{type: 'message', role: 'system', content}];
                current.responseItems = replaceContinuationBase(current.responseItems, oldBase, newBase);
                current.summaryId = summary.id; store.saveSummary({...summary, content, status: 'completed'}); store.saveRun(current); return current;
            });
        },
        fail: (summary, cause) => {store.transaction(() => {const saved = store.summaries(summary.runId).find(item => item.id === summary.id); if (saved?.status !== 'completed') store.saveSummary({...summary, status: 'failed'});}); return Promise.resolve(cause instanceof Error ? cause.message : 'Summary failed');},
    }, signal);
}
