import {cloneStoredValue, decodeLocalValue, registerBinaryReference, reservePreparedBinaryReference, settlePreparedBinaryReference} from "./codec";
import {StorageError, UnknownCommitError} from "./errors";
import {deliverStorageNotification} from "./notifications";
import {compareKeys, indexKey, primaryKey, requireKey} from "./keys";
import type {
    BinaryClaim,
    CommitResult,
    NativeQuery,
    NativeSession,
    NativeStoreBridge,
    RowChange,
    StoreKey,
    TransactionHandle,
    WireBatchEntry,
    WireRow,
    WireRowValue
} from "./protocol";
import {IPC_CHUNK_BYTES, IPC_TEXT_CHUNK_BYTES, QUERY_PAGE_SIZE} from "./protocol";
import {encodeProductRow} from "./rowCodec";
import {TABLE_NAMES, tableDefinition} from "./schema";
import {createProductStore} from "./store";
import type {TableName} from "./tableTypes";
import type {ProductStore, StoreChange, StoreDriver, StoreObserver, TransactionBackend} from "./types";
import {validateRowChange, validateWireRow} from "./validate";
import {encodeWireKey, encodeWireText} from "./wireText";
import {Sha256} from "../media/sha256";

export interface BinaryAdapterServices {
    prepare(blob: Blob, session: NativeSession): Promise<BinaryClaim>;

    discard(claim: BinaryClaim, session: NativeSession): Promise<void>;
}

type Mutation = Parameters<TransactionBackend["mutate"]>[0];
type ReadDependency = { table: TableName; keys: readonly string[] } | { table: TableName; query: NativeQuery };
type RootWaiter = {
    mode: "r" | "rw";
    signal?: AbortSignal;
    resolve: (release: () => void) => void;
    cancel: () => void
};
// The native owner rejects more than 64 live contexts. Keep one driver's reads
// below that boundary instead of starting a context for every mounted thumbnail.
const ROOT_READ_CAPACITY = 32;

function matches(row: object, query: NativeQuery): boolean {
    const definition = tableDefinition(query.table);
    const key = query.index === null || query.index === definition.keyPath ? requireKey(primaryKey(row, definition)) : indexKey(row, definition.indexes.find(index => index.name === query.index)!);
    if (key === null) return false;
    return query.selector.kind === "all" || query.selector.keys.some(selector => compareKeys(selector, key) === 0);
}

function compareRows(left: object, right: object, query: NativeQuery): number {
    const definition = tableDefinition(query.table);
    const leftId = primaryKey(left, definition), rightId = primaryKey(right, definition);
    let result = 0;
    if (query.index !== null && query.index !== definition.keyPath) {
        const index = definition.indexes.find(index => index.name === query.index)!;
        result = compareKeys(indexKey(left, index)!, indexKey(right, index)!);
    }
    if (result === 0) result = compareKeys(requireKey(leftId), requireKey(rightId));
    return query.reverse ? -result : result;
}

function affected(dependency: ReadDependency, change: RowChange): boolean {
    if (dependency.table !== change.table) return false;
    if ("keys" in dependency) return dependency.keys.includes(change.key);
    const query = dependency.query;
    if (query.index === null || query.selector.kind === "all") return true;
    const definition = tableDefinition(query.table);
    const before = query.index === definition.keyPath ? requireKey(change.key) : change.before[query.index];
    const after = query.index === definition.keyPath ? requireKey(change.key) : change.after[query.index];
    return query.selector.keys.some(key => (before !== undefined && compareKeys(before, key) === 0) || (after !== undefined && compareKeys(after, key) === 0));
}

class NativeTransaction implements TransactionBackend {
    readonly transactionId: string;
    readonly mode: "r" | "rw";
    readonly scope: readonly TableName[];
    readonly dependencies: ReadDependency[] = [];
    readonly mutations: Mutation[] = [];
    readonly claims: BinaryClaim[] = [];
    readonly overlay = new Map<TableName, Map<string, object | null>>();
    private open = true;
    private readonly blobClaims = new WeakMap<Blob, BinaryClaim>();

    constructor(readonly handle: TransactionHandle, private readonly bridge: NativeStoreBridge, private readonly binaries: BinaryAdapterServices, mode: "r" | "rw", scope: readonly TableName[]) {
        this.transactionId = handle.operationId;
        this.mode = mode;
        this.scope = scope;
    }

    assertOpen(): void {
        if (!this.open) throw new StorageError("closed", "Transaction is closed");
    }

    close(): void {
        this.open = false;
    }

    async get(table: TableName, keys: readonly string[]): Promise<Array<object | undefined>> {
        this.assertTable(table);
        this.dependencies.push({table, keys: [...keys]});
        const result: Array<object | undefined> = [];
        const overlay = this.overlay.get(table);
        for (let offset = 0; offset < keys.length; offset += QUERY_PAGE_SIZE) {
            const page = keys.slice(offset, offset + QUERY_PAGE_SIZE);
            const response = await this.bridge.get({...this.handle, table, keys: [...page]});
            if (response.rows.length !== page.length) throw new StorageError("invalid", "Invalid native point-read result");
            for (let index = 0; index < page.length; index++) {
                const key = page[index];
                if (overlay?.has(key)) {
                    const row = overlay.get(key);
                    result.push(row === null ? undefined : cloneStoredValue(row));
                    continue;
                }
                const value = response.rows[index];
                if (value === null) {
                    result.push(undefined);
                    continue;
                }
                const wire = await this.readRow(value);
                if (wire.key !== key) throw new StorageError("invalid", "Point read returned a foreign key");
                const row = decodeLocalValue(wire.value);
                if (!row || typeof row !== "object" || Array.isArray(row) || primaryKey(row, tableDefinition(table)) !== key) throw new StorageError("invalid", "Invalid native product row");
                result.push(row);
            }
        }
        return result;
    }

    async query(query: NativeQuery): Promise<object[]> {
        this.assertTable(query.table);
        this.dependencies.push({table: query.table, query});
        const rows = new Map<string, object>();
        const groups: NativeQuery[] = [];
        if (query.selector.kind === "anyOf") {
            const keys = [...new Map(query.selector.keys.map(key => [JSON.stringify(key), key])).values()];
            let group: StoreKey[] = [], bytes = 2;
            const encoder = new TextEncoder();
            for (const key of keys) {
                const keyBytes = encoder.encode(JSON.stringify(encodeWireKey(key))).byteLength;
                // Cursor pages resend their selectors. Bound that repeated work,
                // while allowing one arbitrarily large key through bridge chunks.
                if (group.length && (group.length === QUERY_PAGE_SIZE || bytes + 1 + keyBytes > IPC_CHUNK_BYTES / 4)) {
                    groups.push({...query, selector: {kind: "anyOf", keys: group}});
                    group = [];
                    bytes = 2;
                }
                bytes += keyBytes + (group.length ? 1 : 0);
                group.push(key);
            }
            if (group.length) groups.push({...query, selector: {kind: "anyOf", keys: group}});
        } else groups.push(query);
        const limit = this.mode === "r" ? query.limit : undefined;
        const readGroups = groups.map(group => ({...group, ...(limit !== undefined ? {limit} : {limit: undefined})}));
        let epoch: number | undefined;
        for (const group of readGroups) {
            let cursor: string | null = null;
            do {
                const response = await this.bridge.query({...this.handle, query: {...group, cursor}});
                if (epoch !== undefined && epoch !== response.epoch) throw new StorageError("conflict", "Storage query changed between pages");
                epoch = response.epoch;
                for (const value of response.rows) {
                    const wire = await this.readRow(value), row = decodeLocalValue(wire.value);
                    if (!row || typeof row !== "object" || Array.isArray(row) || primaryKey(row, tableDefinition(query.table)) !== wire.key) throw new StorageError("invalid", "Invalid native indexed row");
                    rows.set(wire.key, row);
                }
                cursor = response.cursor;
            } while (cursor !== null);
        }
        for (const [key, row] of this.overlay.get(query.table) ?? []) {
            if (row === null || !matches(row, query)) rows.delete(key); else rows.set(key, cloneStoredValue(row));
        }
        return [...rows.values()].sort((left, right) => compareRows(left, right, query)).slice(0, limit ?? Infinity);
    }

    async count(query: NativeQuery): Promise<number> {
        this.assertTable(query.table);
        this.dependencies.push({table: query.table, query});
        if (this.mode !== "r") return (await this.query({...query, limit: undefined})).length;
        if (query.selector.kind !== "anyOf") return (await this.bridge.count({
            ...this.handle,
            query: {...query, cursor: null}
        })).count;
        const keys = [...new Map(query.selector.keys.map(key => [JSON.stringify(key), key])).values()];
        let total = 0;
        for (let offset = 0; offset < keys.length; offset += QUERY_PAGE_SIZE) total += (await this.bridge.count({
            ...this.handle,
            query: {
                ...query,
                limit: undefined,
                cursor: null,
                selector: {kind: "anyOf", keys: keys.slice(offset, offset + QUERY_PAGE_SIZE)}
            }
        })).count;
        return Math.min(total, query.limit ?? Infinity);
    }

    async mutate(mutation: Mutation): Promise<void> {
        this.assertTable(mutation.table);
        if (this.mode !== "rw") throw new StorageError("scope", "Readonly transaction cannot write");
        const [current] = await this.get(mutation.table, [mutation.key]);
        if (mutation.kind === "add" && current !== undefined) throw new StorageError("constraint", "Duplicate primary key");
        if (mutation.kind !== "delete") {
            const definition = tableDefinition(mutation.table);
            for (const index of definition.indexes) {
                if (!index.unique) continue;
                const key = indexKey(mutation.value, index);
                if (key === null) continue;
                const matches = await this.query({
                    table: mutation.table,
                    index: index.name,
                    selector: {kind: "equals", keys: [key]},
                    reverse: false,
                    cursor: null,
                    pageSize: QUERY_PAGE_SIZE
                });
                if (matches.some(row => primaryKey(row, definition) !== mutation.key)) throw new StorageError("constraint", "Duplicate unique index key");
            }
        }
        let overlay = this.overlay.get(mutation.table);
        if (!overlay) {
            overlay = new Map();
            this.overlay.set(mutation.table, overlay);
        }
        overlay.set(mutation.key, mutation.kind === "delete" ? null : cloneStoredValue(mutation.value));
        this.mutations.push(mutation.kind === "delete" ? {...mutation} : {
            ...mutation,
            value: cloneStoredValue(mutation.value)
        });
    }

    waitFor<T>(promise: Promise<T>): Promise<T> {
        this.assertOpen();
        return Promise.resolve(promise);
    }

    async prepareBatch(): Promise<{ capability: string; fingerprint: string }> {
        const hash = new Sha256().update(new TextEncoder().encode("momoki-batch-v1\n"));
        let chunkIndex = 0;
        const send = async (entry: WireBatchEntry) => {
            const bytes = new TextEncoder().encode(JSON.stringify(entry) + "\n");
            hash.update(bytes);
            for (let offset = 0; offset < bytes.length;) {
                let end = Math.min(bytes.length, offset + IPC_TEXT_CHUNK_BYTES);
                while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
                const payload = new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(offset, end));
                const result = await this.bridge.prepare({...this.handle, chunkIndex, payload});
                if (result.nextChunk !== ++chunkIndex) throw new StorageError("invalid", "Invalid native batch progress");
                offset = end;
            }
        };
        for (const mutation of this.mutations) {
            const wire = mutation.kind === "delete" ? {...mutation, key: encodeWireText(mutation.key)} : {
                ...mutation,
                key: encodeWireText(mutation.key),
                value: await encodeProductRow(mutation.table, mutation.value, blob => this.prepareBlob(blob), reference => {
                    const claim = reservePreparedBinaryReference(reference, this.handle, this.transactionId);
                    if (claim && !this.claims.some(existing => existing.stageId === claim.stageId)) this.claims.push(claim);
                })
            };
            await send({kind: "mutation", mutation: wire});
        }
        for (const claim of this.claims) await send({kind: "claim", claim});
        const fingerprint = hash.digest();
        const sealed = await this.bridge.seal({...this.handle, chunkCount: chunkIndex, fingerprint});
        if (sealed.fingerprint !== fingerprint) throw new StorageError("invalid", "Native batch fingerprint mismatch");
        return sealed;
    }

    async discard(): Promise<void> {
        for (const claim of this.claims) await this.binaries.discard(claim, this.handle).catch(() => undefined);
    }

    settle(outcome: "committed" | "discarded" | "unknown"): void {
        for (const claim of this.claims) settlePreparedBinaryReference(claim.reference, this.transactionId, outcome);
    }

    private assertTable(table: TableName): void {
        this.assertOpen();
        if (!this.scope.includes(table)) throw new StorageError("scope", "Table is not declared in this transaction");
    }

    private async readRow(value: WireRowValue): Promise<WireRow> {
        if (value.kind === "inline") return validateWireRow(value.row);
        let payload = "", offset = 0;
        for (; ;) {
            const next = await this.bridge.readTransfer({
                ...this.handle,
                transferId: value.transferId,
                offset,
                byteLength: IPC_CHUNK_BYTES
            });
            const length = new TextEncoder().encode(next.payload).byteLength;
            if (next.offset !== offset + length || (!next.end && length === 0) || length > IPC_CHUNK_BYTES) throw new StorageError("invalid", "Invalid native row transfer progress");
            payload += next.payload;
            offset = next.offset;
            if (next.end) return validateWireRow(JSON.parse(payload) as unknown);
        }
    }

    private async prepareBlob(blob: Blob): Promise<BinaryClaim["reference"]> {
        const found = this.blobClaims.get(blob);
        if (found) return found.reference;
        const claim = await this.binaries.prepare(blob, this.handle);
        if (claim.reference.workspaceId !== this.handle.workspaceId) throw new StorageError("invalid", "Prepared binary belongs to another workspace");
        this.blobClaims.set(blob, claim);
        this.claims.push(claim);
        return registerBinaryReference(claim.reference);
    }
}

export class NativeStoreDriver implements StoreDriver {
    readonly owner = "sqlite" as const;
    private sessionPromise: Promise<NativeSession> | undefined;
    private readonly listeners = new Set<(change: StoreChange) => void>();
    private lastSequence = 0;
    private readers = 0;
    private writer = false;
    private readonly rootQueue: RootWaiter[] = [];
    private closed = false;
    private closing: Promise<void> | undefined;
    private completeClose: (() => void) | undefined;
    private readonly observers = new Set<() => void>();

    constructor(private readonly bridge: NativeStoreBridge, private readonly binaries: BinaryAdapterServices) {
    }

    getSession(): Promise<NativeSession> {
        if (this.closed && !this.sessionPromise) return Promise.reject(new StorageError("closed", "Storage is closed"));
        this.sessionPromise ??= this.bridge.open().then(session => {
            this.lastSequence = session.changeSequence;
            return {
                version: 1,
                session: session.session,
                workspaceId: session.workspaceId,
                generation: session.generation
            };
        });
        return this.sessionPromise;
    }

    async transaction<T>(mode: "r" | "rw", scope: readonly TableName[], callback: (backend: TransactionBackend) => Promise<T>): Promise<T> {
        return this.admittedTransaction(mode, scope, callback);
    }

    subscribe(listener: (change: StoreChange) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    waitFor<T>(promise: Promise<T>): Promise<T> {
        return Promise.resolve(promise);
    }

    observe<T>(query: (backend: TransactionBackend) => Promise<T>, observer: StoreObserver<T>): () => void {
        if (this.closed) {observer.error(new StorageError("closed", "Storage is closed")); return () => undefined;}
        let disposed = false, running = false, dirty = true;
        const controller = new AbortController();
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        let conflicts = 0;
        let dependencies: ReadDependency[] = [];
        const run = async () => {
            if (disposed || running) return;
            running = true;
            while (dirty && !disposed) {
                dirty = false;
                try {
                    const result = await this.admittedTransaction("r", TABLE_NAMES, async backend => {
                        controller.signal.throwIfAborted();
                        dependencies = (backend as NativeTransaction).dependencies;
                        return query(backend);
                    }, controller.signal);
                    if (!disposed && !dirty) deliverStorageNotification(value => observer.next(value), result);
                    conflicts = 0;
                } catch (error) {
                    if (!disposed && error instanceof StorageError && error.code === "conflict") {
                        dirty = true;
                        // Pure snapshots can restart; mutation callbacks never enter this lane.
                        const delay = Math.min(250, 5 * 2 ** Math.min(conflicts++, 6));
                        retryTimer = setTimeout(() => {
                            retryTimer = undefined;
                            void run();
                        }, delay);
                        break;
                    }
                    if (!disposed) deliverStorageNotification(value => observer.error(value), error);
                }
            }
            running = false;
        };
        const unsubscribe = this.subscribe(change => {
            if (!change.changes || dependencies.some(dependency => change.changes!.some(row => affected(dependency, row)))) {
                dirty = true;
                void run();
            }
        });
        void run();
        const dispose = () => {
            disposed = true;
            controller.abort();
            if (retryTimer !== undefined) clearTimeout(retryTimer);
            unsubscribe();
            this.observers.delete(dispose);
        };
        this.observers.add(dispose);
        return dispose;
    }

    /** Final renderer boundary only: native closes the actual worker after the drained receipt. */
    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closing = new Promise<void>(resolve => {this.completeClose = resolve;});
        for (const dispose of [...this.observers]) dispose();
        this.closed = true;
        this.listeners.clear();
        this.finishClose();
        return this.closing;
    }

    private finishClose(): void {
        if (this.closed && !this.writer && this.readers === 0 && this.rootQueue.length === 0) this.completeClose?.();
    }

    async receiveChangeSequence(sequence: number): Promise<void> {
        if (sequence <= this.lastSequence) return;
        for (let next = this.lastSequence + 1; next <= sequence; next++) await this.notify({
            status: "committed",
            operationId: "notification",
            fingerprint: "notification",
            changeSequence: next,
            tables: TABLE_NAMES
        });
    }

    private async notify(commit: CommitResult): Promise<void> {
        const session = await this.getSession(), changes: RowChange[] = [];
        let cursor: string | null = null;
        do {
            const page = await this.bridge.changes({
                ...session,
                changeSequence: commit.changeSequence,
                cursor,
                pageSize: QUERY_PAGE_SIZE
            });
            for (const change of page.changes) {
                if (!("kind" in change)) {
                    changes.push(change);
                    continue;
                }
                let payload = "", offset = 0;
                for (; ;) {
                    const next = await this.bridge.readChangeTransfer({
                        ...session,
                        transferId: change.transferId,
                        offset,
                        byteLength: IPC_CHUNK_BYTES
                    });
                    const length = new TextEncoder().encode(next.payload).byteLength;
                    if (next.offset !== offset + length || (!next.end && length === 0) || length > IPC_CHUNK_BYTES) throw new StorageError("invalid", "Invalid native change transfer progress");
                    payload += next.payload;
                    offset = next.offset;
                    if (next.end) {
                        changes.push(validateRowChange(JSON.parse(payload) as unknown));
                        break;
                    }
                }
            }
            cursor = page.cursor;
        } while (cursor !== null);
        this.lastSequence = Math.max(this.lastSequence, commit.changeSequence);
        const event = {generation: session.generation, sequence: commit.changeSequence, tables: commit.tables, changes};
        for (const listener of this.listeners) deliverStorageNotification(listener, event);
    }

    private drainRoots(): void {
        while (!this.writer && this.rootQueue.length) {
            const next = this.rootQueue[0];
            if ((next.mode === "rw" && this.readers > 0) || this.readers >= ROOT_READ_CAPACITY) return;
            this.rootQueue.shift();
            next.signal?.removeEventListener("abort", next.cancel);
            if (next.mode === "rw") this.writer = true; else this.readers++;
            let released = false;
            next.resolve(() => {
                if (released) return;
                released = true;
                if (next.mode === "rw") this.writer = false; else this.readers--;
                this.drainRoots();
                this.finishClose();
            });
        }
    }

    private acquireRoot(mode: "r" | "rw", signal?: AbortSignal): Promise<() => void> {
        if (this.closed) return Promise.reject(new StorageError("closed", "Storage is closed"));
        const cancellation = (): Error => signal?.reason instanceof Error ? signal.reason : new DOMException("Storage query was canceled", "AbortError");
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(cancellation());
                return;
            }
            const waiter: RootWaiter = {
                mode, signal, resolve, cancel: () => {
                    const index = this.rootQueue.indexOf(waiter);
                    if (index < 0) return;
                    this.rootQueue.splice(index, 1);
                    reject(cancellation());
                    this.drainRoots();
                    this.finishClose();
                }
            };
            this.rootQueue.push(waiter);
            signal?.addEventListener("abort", waiter.cancel, {once: true});
            this.drainRoots();
        });
    }

    private async admittedTransaction<T>(mode: "r" | "rw", scope: readonly TableName[], callback: (backend: TransactionBackend) => Promise<T>, signal?: AbortSignal): Promise<T> {
        const release = await this.acquireRoot(mode, signal);
        try {
            signal?.throwIfAborted();
            return await this.runTransaction(mode, scope, callback);
        } finally {
            release();
        }
    }

    private async runTransaction<T>(mode: "r" | "rw", scope: readonly TableName[], callback: (backend: TransactionBackend) => Promise<T>): Promise<T> {
        const session = await this.getSession(), operationId = crypto.randomUUID();
        const handle = await this.bridge.begin({...session, operationId, mode, tables: [...scope]});
        const backend = new NativeTransaction(handle, this.bridge, this.binaries, mode, scope);
        let commitSent = false;
        let committed = false;
        try {
            const result = await callback(backend);
            if (mode === "r") {
                await this.bridge.validate(handle);
                return result;
            }
            const prepared = await backend.prepareBatch();
            let commit: CommitResult;
            commitSent = true;
            try {
                commit = await this.bridge.commit({...handle, ...prepared});
            } catch (error) {
                let outcome;
                try {
                    outcome = await this.bridge.status({...session, operationId, fingerprint: prepared.fingerprint});
                } catch (statusError) {
                    throw new UnknownCommitError(operationId, session.workspaceId, statusError);
                }
                if (outcome.status === "committed") commit = outcome;
                else if (outcome.status === "rolledBack") {
                    commitSent = false;
                    throw new StorageError("conflict", "Storage transaction rolled back", "rollback", {cause: error});
                } else throw new UnknownCommitError(operationId, session.workspaceId, error);
            }
            if (commit.operationId !== operationId || commit.fingerprint !== prepared.fingerprint) throw new UnknownCommitError(operationId, session.workspaceId);
            committed = true;
            backend.settle("committed");
            await this.notify(commit).catch(() => {
                for (const listener of this.listeners) deliverStorageNotification(listener, {
                    generation: session.generation,
                    sequence: commit.changeSequence,
                    tables: commit.tables
                });
            });
            return result;
        } finally {
            backend.close();
            if (!commitSent) {
                backend.settle("discarded");
                await this.bridge.abort(handle).catch(() => undefined);
                await backend.discard();
            } else if (!committed) backend.settle("unknown");
        }
    }
}

export function createNativeProductStore(bridge: NativeStoreBridge, binaries: BinaryAdapterServices): {
    store: ProductStore;
    driver: NativeStoreDriver
} {
    const driver = new NativeStoreDriver(bridge, binaries);
    return {store: createProductStore(driver), driver};
}
