import {invoke} from "@tauri-apps/api/core";
import {z} from "zod";
import type {ManagedBinaryRef} from "../media/binaryTypes";
import {Sha256} from "../media/sha256";
import {registerBinaryReference, registerPreparedBinaryReference} from "./codec";
import {StorageError} from "./errors";
import {type BinaryClaim, IPC_CHUNK_BYTES, type NativeSession} from "./protocol";

const uuid = z.string().uuid().refine(value => value === value.toLowerCase());
const referenceSchema = z.object({
    version: z.literal(1), workspaceId: uuid, binaryId: uuid,
    byteLength: z.number().int().nonnegative().safe(),
    mimeType: z.string().max(256).refine(value => new TextEncoder().encode(value).byteLength <= 256 && !Array.from(value).some(character => {
        const code = character.codePointAt(0)!;
        return code < 32 || (code >= 127 && code <= 159);
    })),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
const claimSchema = z.object({reference: referenceSchema, stageId: uuid}).strict();
const preparedSchema = z.object({
    type: z.literal("prepared"),
    stageId: uuid,
    binaryId: uuid,
    workspaceId: uuid,
    chunkBytes: z.literal(IPC_CHUNK_BYTES)
}).strict();
const sealedSchema = z.object({type: z.literal("sealed"), claim: claimSchema}).strict();
const readySchema = z.object({
    type: z.literal("readReady"),
    leaseId: uuid,
    reference: referenceSchema,
    chunkBytes: z.literal(IPC_CHUNK_BYTES)
}).strict();
const verifiedSchema = z.object({type: z.literal("verified")}).strict();
const availabilitySchema = z.object({
    type: z.literal("availability"),
    state: z.enum(["ready", "missing", "corrupt"])
}).strict();

export type BinaryAvailability = "ready" | "missing" | "corrupt";
export type BinaryAction = { type: "prepare"; byteLength: number; mimeType: string }
    | { type: "write"; stageId: string; offset: number; bytes: number[] }
    | { type: "seal"; stageId: string; contentHash: string }
    | { type: "abort"; stageId: string }
    | { type: "readStart" | "availability"; reference: ManagedBinaryRef }
    | { type: "readChunk"; leaseId: string; offset: number; byteLength: number }
    | { type: "readVerify" | "readClose"; leaseId: string };

export interface NativeBinaryLease {
    readonly identity: string;
    readonly reference: ManagedBinaryRef;

    readBlob(signal?: AbortSignal): Promise<Blob>;

    verify(signal?: AbortSignal): Promise<void>;

    close(): Promise<void>;
}

export interface NativeBinaryServices {
    prepare(blob: Blob, session: NativeSession, signal?: AbortSignal): Promise<BinaryClaim>;

    discard(claim: BinaryClaim, session: NativeSession): Promise<void>;

    open(reference: ManagedBinaryRef, signal?: AbortSignal): Promise<NativeBinaryLease>;

    identity(reference: ManagedBinaryRef): Promise<string>;

    availability(reference: ManagedBinaryRef, signal?: AbortSignal): Promise<BinaryAvailability>;

    preview?(reference: ManagedBinaryRef, signal?: AbortSignal): Promise<{ url: string; release(): void }>;
}

export interface NativeBinaryTransport {
    getSession(): Promise<NativeSession>;

    request(session: NativeSession, action: BinaryAction): Promise<unknown>;

    read(session: NativeSession, action: Extract<BinaryAction, { type: "readChunk" }>): Promise<unknown>;

    preview?(session: NativeSession, reference: ManagedBinaryRef): Promise<unknown>;

    releasePreview?(session: NativeSession, previewId: string): Promise<unknown>;

    write?(session: NativeSession, stageId: string, offset: number, bytes: Uint8Array): Promise<unknown>;
}

function sessionDto(session: NativeSession): NativeSession {
    // StoreTx handles carry extra transaction fields. Binary IO only receives
    // the closed current session envelope, with no renderer path or row authority.
    return z.object({
        version: z.literal(1),
        session: uuid,
        workspaceId: uuid,
        generation: z.number().int().nonnegative().safe()
    }).strict().parse({
        version: session.version,
        session: session.session,
        workspaceId: session.workspaceId,
        generation: session.generation
    });
}

/** Called only by the closed native media transport with its actual store session. */
export function registerNativePreparedBinary(value: unknown, session: NativeSession): ManagedBinaryRef {
    return registerPreparedBinaryReference(claimSchema.parse(value), sessionDto(session));
}

function missingBinary(message: string): StorageError {
    return new StorageError("unavailable", message);
}

function sessionMatches(reference: ManagedBinaryRef, session: NativeSession): void {
    referenceSchema.parse(reference);
    if (reference.workspaceId !== session.workspaceId) throw missingBinary("素材来自其他工作区，无法读取");
}

function sameReference(left: ManagedBinaryRef, right: ManagedBinaryRef): boolean {
    return left.version === right.version && left.workspaceId === right.workspaceId && left.binaryId === right.binaryId
        && left.byteLength === right.byteLength && left.mimeType === right.mimeType && left.contentHash === right.contentHash;
}

export class BinaryUnavailableError extends StorageError {
    constructor(readonly availability: "missing" | "corrupt") {
        super("unavailable", availability === "missing" ? "素材已丢失，请重新导入" : "素材内容已损坏，无法使用");
    }
}

async function binaryInvoke(command: string, request: unknown): Promise<unknown> {
    try {
        return await invoke(command, {request});
    } catch (error) {
        if (error && typeof error === "object" && "code" in error) {
            if (error.code === "missing") throw new BinaryUnavailableError("missing");
            if (error.code === "corrupt" || error.code === "changed") throw new BinaryUnavailableError("corrupt");
        }
        throw new StorageError("unavailable", "工作区素材读取或写入失败", "rollback", {cause: error});
    }
}

function normalizeReadBytes(value: unknown): Uint8Array<ArrayBuffer> {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (value instanceof Uint8Array) return new Uint8Array(value);
    throw new StorageError("invalid", "原生素材读取未返回字节缓冲区");
}

/** Uses the store's existing fixed session; it never opens another workspace. */
export function nativeBinaryTransport(getSession: () => Promise<NativeSession>): NativeBinaryTransport {
    return {
        getSession,
        preview: (session, reference) => binaryInvoke("product_media_preview", {...session, reference}),
        releasePreview: (session, previewId) => binaryInvoke("product_media_release", {...session, previewId}),
        request: (session, action) => binaryInvoke("product_binary_request", {...session, action}),
        read: (session, action) => binaryInvoke("product_binary_read", {...session, action}),
        write: async (session, stageId, offset, bytes) => {
            try {
                return await invoke("product_binary_write", bytes, {
                    headers: {
                        "x-momoki-binary": JSON.stringify({
                            ...session,
                            stageId,
                            offset
                        })
                    }
                });
            } catch (error) {
                throw new StorageError("unavailable", "工作区素材分块写入失败", "rollback", {cause: error});
            }
        },
    };
}

/** Share the native read/write handle bounds across all callers of this service.
 * Waiting for a slot does not issue native requests or retry a business command. */
function transferSlots(capacity: number) {
    let active = 0;
    type Waiter = {
        signal?: AbortSignal;
        resolve: (release: () => void) => void;
        reject: (error: Error) => void;
        canceled: () => void
    };
    const queue: Waiter[] = [];
    const cancellation = (signal?: AbortSignal) => signal?.reason instanceof Error ? signal.reason : new DOMException("素材读取已取消", "AbortError");
    const drain = () => {
        while (active < capacity && queue.length) {
            const waiter = queue.shift()!;
            waiter.signal?.removeEventListener("abort", waiter.canceled);
            if (waiter.signal?.aborted) {
                waiter.reject(cancellation(waiter.signal));
                continue;
            }
            active++;
            let released = false;
            waiter.resolve(() => {
                if (released) return;
                released = true;
                active--;
                drain();
            });
        }
    };
    return (signal?: AbortSignal): Promise<() => void> => new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(cancellation(signal));
            return;
        }
        const waiter: Waiter = {
            signal, resolve, reject, canceled: () => {
                const at = queue.indexOf(waiter);
                if (at < 0) return;
                queue.splice(at, 1);
                reject(cancellation(signal));
            }
        };
        queue.push(waiter);
        signal?.addEventListener("abort", waiter.canceled, {once: true});
        drain();
    });
}

function readFailure(error: unknown): Error {
    if (error instanceof Error) return error;
    if (error && typeof error === "object" && "code" in error) {
        if (error.code === "missing") return new BinaryUnavailableError("missing");
        if (error.code === "changed" || error.code === "corrupt") return new BinaryUnavailableError("corrupt");
    }
    return new StorageError("unavailable", "工作区素材读取失败", "rollback", {cause: error});
}

/** Every transfer and hash turn is bounded. A complete requested Blob can still
 * be required by existing decoders/providers, but metadata reads never do this. */
export function createNativeBinaryServices(transport: NativeBinaryTransport): NativeBinaryServices {
    const acquireRead = transferSlots(8);
    const acquireWrite = transferSlots(2);
    const discard = async (claim: BinaryClaim, session: NativeSession) => {
        await transport.request(sessionDto(session), {type: "abort", stageId: claim.stageId});
    };
    return {
        async preview(reference, signal) {
            signal?.throwIfAborted();
            if (!transport.preview || !transport.releasePreview) throw new StorageError("unavailable", "原生媒体播放尚未就绪");
            const session = await transport.getSession();
            sessionMatches(reference, session);
            const value = z.object({
                previewId: uuid,
                url: z.string(),
                byteLength: z.number().int().nonnegative().safe(),
                mimeType: z.string()
            }).strict().parse(await transport.preview(session, reference));
            let validUrl = false;
            try {
                const url = new URL(value.url);
                const port = Number(url.port);
                validUrl = url.protocol === "http:" && url.hostname === "127.0.0.1"
                    && port >= 1024 && port <= 65535 && Number.isInteger(port)
                    && url.href === value.url && url.pathname === `/${value.previewId}`
                    && !url.search && !url.hash && !url.username && !url.password;
            } catch { /* A malformed reply still needs its opaque capability released. */
            }
            if (!validUrl || value.byteLength !== reference.byteLength || value.mimeType !== reference.mimeType) {
                await transport.releasePreview(session, value.previewId);
                throw new StorageError("invalid", "原生媒体地址与素材引用不匹配");
            }
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                void transport.releasePreview!(session, value.previewId).catch(() => { /* Closing the session also revokes all previews. */
                });
            };
            if (signal?.aborted) {
                release();
                signal.throwIfAborted();
            }
            return {url: value.url, release};
        },
        async prepare(blob, session, signal) {
            const releaseSlot = await acquireWrite(signal);
            try {
                signal?.throwIfAborted();
                session = sessionDto(session);
                const prepared = preparedSchema.parse(await transport.request(session, {
                    type: "prepare",
                    byteLength: blob.size,
                    mimeType: blob.type
                }));
                let sealed = false;
                try {
                    if (prepared.workspaceId !== session.workspaceId) throw new StorageError("invalid", "素材写入返回了其他工作区");
                    const hash = new Sha256();
                    for (let offset = 0; offset < blob.size; offset += IPC_CHUNK_BYTES) {
                        signal?.throwIfAborted();
                        const bytes = new Uint8Array(await blob.slice(offset, offset + IPC_CHUNK_BYTES).arrayBuffer());
                        signal?.throwIfAborted();
                        const reply = transport.write
                            ? await transport.write(session, prepared.stageId, offset, bytes)
                            : await transport.request(session, {
                                type: "write",
                                stageId: prepared.stageId,
                                offset,
                                bytes: Array.from(bytes)
                            });
                        const progress = z.object({
                            type: z.literal("progress"),
                            offset: z.number().int().nonnegative().safe()
                        }).strict().parse(reply);
                        if (progress.offset !== offset + bytes.byteLength) throw new StorageError("invalid", "素材写入的字节位置不正确");
                        hash.update(bytes);
                    }
                    signal?.throwIfAborted();
                    const result = sealedSchema.parse(await transport.request(session, {
                        type: "seal",
                        stageId: prepared.stageId,
                        contentHash: hash.digest()
                    }));
                    sessionMatches(result.claim.reference, session);
                    if (result.claim.stageId !== prepared.stageId || result.claim.reference.binaryId !== prepared.binaryId
                        || result.claim.reference.byteLength !== blob.size || result.claim.reference.contentHash !== hash.digest()
                        || result.claim.reference.mimeType !== blob.type) throw new StorageError("invalid", "素材发布后的校验信息不一致");
                    signal?.throwIfAborted();
                    sealed = true;
                    return {...result.claim, reference: registerBinaryReference(result.claim.reference)};
                } finally {
                    if (!sealed) await transport.request(session, {
                        type: "abort",
                        stageId: prepared.stageId
                    }).catch(() => undefined);
                }
            } finally {
                releaseSlot();
            }
        },
        discard,
        async open(reference, signal) {
            const releaseSlot = await acquireRead(signal);
            let handedOff = false;
            try {
                signal?.throwIfAborted();
                const session = await transport.getSession();
                sessionMatches(reference, session);
                signal?.throwIfAborted();
                const reply = await transport.request(session, {type: "readStart", reference});
                const parsed = readySchema.safeParse(reply);
                if (!parsed.success) {
                    // A malformed acknowledgement may still have allocated a native
                    // handle. Close its canonical opaque id without trusting its ref.
                    const handle = z.object({leaseId: uuid}).passthrough().safeParse(reply);
                    if (handle.success) await transport.request(session, {
                        type: "readClose",
                        leaseId: handle.data.leaseId
                    }).catch(() => undefined);
                    throw new StorageError("invalid", "原生素材读取返回了无效租约", "rollback", {cause: parsed.error});
                }
                const ready = parsed.data;
                let closed = false;
                let closing: Promise<void> | undefined;
                const canceled = () => {
                    void close().catch(() => undefined);
                };
                const close = (): Promise<void> => {
                    if (closing) return closing;
                    closed = true;
                    signal?.removeEventListener("abort", canceled);
                    closing = Promise.resolve().then(() => transport.request(session, {
                        type: "readClose",
                        leaseId: ready.leaseId
                    })).then(() => undefined).finally(releaseSlot);
                    return closing;
                };
                const assertOpen = (operationSignal?: AbortSignal) => {
                    signal?.throwIfAborted();
                    operationSignal?.throwIfAborted();
                    if (closed) throw new StorageError("closed", "素材读取已结束");
                };
                const guarded = async <T>(read: () => Promise<T>): Promise<T> => {
                    try {
                        return await read();
                    } catch (error) {
                        await close().catch(() => undefined);
                        throw readFailure(error);
                    }
                };
                handedOff = true;
                if (!sameReference(ready.reference, reference)) {
                    await close();
                    throw new StorageError("invalid", "素材读取的身份不一致");
                }
                if (signal?.aborted) {
                    await close();
                    signal.throwIfAborted();
                }
                signal?.addEventListener("abort", canceled, {once: true});
                return {
                    identity: `${session.workspaceId}:${session.generation}:${reference.binaryId}:${reference.contentHash}`,
                    reference,
                    readBlob: readSignal => guarded(async () => {
                        assertOpen(readSignal);
                        const chunks: Uint8Array<ArrayBuffer>[] = [];
                        const hash = new Sha256();
                        for (let offset = 0; offset < reference.byteLength; offset += IPC_CHUNK_BYTES) {
                            assertOpen(readSignal);
                            const byteLength = Math.min(IPC_CHUNK_BYTES, reference.byteLength - offset);
                            const bytes = normalizeReadBytes(await transport.read(session, {
                                type: "readChunk",
                                leaseId: ready.leaseId,
                                offset,
                                byteLength
                            }));
                            assertOpen(readSignal);
                            if (bytes.byteLength !== byteLength) throw new StorageError("invalid", "素材读取返回了不完整的字节");
                            hash.update(bytes);
                            chunks.push(bytes);
                        }
                        if (hash.digest() !== reference.contentHash) throw new BinaryUnavailableError("corrupt");
                        return new Blob(chunks, {type: reference.mimeType});
                    }),
                    verify: verificationSignal => guarded(async () => {
                        assertOpen(verificationSignal);
                        verifiedSchema.parse(await transport.request(session, {
                            type: "readVerify",
                            leaseId: ready.leaseId
                        }));
                        assertOpen(verificationSignal);
                    }),
                    close,
                };
            } catch (error) {
                throw readFailure(error);
            } finally {
                if (!handedOff) releaseSlot();
            }
        },
        async identity(reference) {
            const session = await transport.getSession();
            sessionMatches(reference, session);
            return `${session.workspaceId}:${session.generation}:${reference.binaryId}:${reference.contentHash}:${reference.byteLength}`;
        },
        async availability(reference, signal) {
            signal?.throwIfAborted();
            const session = await transport.getSession();
            sessionMatches(reference, session);
            const reply = availabilitySchema.parse(await transport.request(session, {type: "availability", reference}));
            signal?.throwIfAborted();
            return reply.state;
        },
    };
}
