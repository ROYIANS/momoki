import type {RuntimeRun, RuntimeCall, ToolContext, AgentToolLoading, ContextSource, SummaryRecord, ToolBindingIdentity, ResourceGrantSnapshot, ResourceGrantRef} from '@momoki/agent-core';
import type {ResponseItem} from '@momoki/agent-providers';

export type Scenario = 'todo' | 'update' | 'pair' | 'restart' | 'committed' | 'stream' | 'budget' | 'external' | 'load' | 'summary';
export interface TodoRun extends RuntimeRun {
    ownerId: string;
    revision: number;
    scope: string;
    scenario: Scenario;
    enabledToolNames: string[];
    toolLoading?: AgentToolLoading;
    offeredTools: Array<{step: number; names: string[]}>;
    responseItems: ResponseItem[];
    history: ContextSource[];
    summaryId?: string;
    requestCount: number;
    summaryRequests: number;
    createBinding?: ToolBindingIdentity;
    error?: string;
}
export type TodoAction = 'create' | 'complete' | 'list';
export interface TodoResourceFact {readonly kind: 'todo-list'; readonly listId: string; readonly action: TodoAction}
export interface TodoAuthority {
    readonly id: string;
    revision: number;
    readonly runId: string;
    readonly scopeId: string;
    readonly binding: ToolBindingIdentity;
    readonly facts: readonly TodoResourceFact[];
    readonly parent?: ResourceGrantRef;
    revoked: boolean;
}
export interface Preview {title: string; authority?: ResourceGrantSnapshot<TodoResourceFact>}
export interface TodoCall extends RuntimeCall<Preview> {
    runId: string;
    result?: string;
    error?: string;
    appended?: boolean;
    decision?: 'approved' | 'rejected';
}
export interface TodoContext extends ToolContext<Preview> {
    services: {
        list: () => Array<{id: string; title: string; done: boolean}>;
        prepare: (action: TodoAction) => Promise<ResourceGrantSnapshot<TodoResourceFact>>;
        mutate: (callId: string, signal: AbortSignal, operation: {kind: 'create'; title: string} | {kind: 'complete'; id: string}, expected?: ResourceGrantSnapshot<TodoResourceFact>) => unknown;
        load: (callId: string, groups: string[], signal: AbortSignal) => unknown;
        external: (callId: string, signal: AbortSignal) => never;
    };
}
export interface TodoSummary extends SummaryRecord<ContextSource> {runId: string; baseRevision: number}
export interface Faults {
    result?: 'oversize' | 'nonserializable';
    receipt?: boolean;
    afterCommit?: boolean;
    unreadableConfirmation?: boolean;
    abortBeforeCommit?: () => void;
    beforeSummaryActivation?: () => Promise<void>;
}
export class RolledBackError extends Error {}
export class UnknownOutcomeError extends Error {}
