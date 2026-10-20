import {invoke} from "@tauri-apps/api/core";
import {z} from "zod";
import {Sha256} from "@momoki/studio/reference/lib/sha256";
import type {NativeAction} from "@momoki/studio/reference/lib/nativeWorkspace";
import {nativeWorkspacePublishedError} from "@momoki/studio/reference/lib/nativeWorkspace";
import {
    nativeAssetSchema as asset,
    nativeAvailabilitySchema as availability,
    nativeBeatSchema as beat,
    nativeConflictSchema,
    nativeDuplicateBeatSchema,
    nativeDuplicateShotSchema,
    nativeEpisodeSchema as episode,
    nativeProjectSchema as project,
    nativeShotSchema as shot,
    nativeUndoSchema,
    nativeVideoProjectSchema as videoProject,
    nativeVideoStateSchema,
    nativeWorkspaceStateSchema as state,
} from "@momoki/studio/reference/lib/nativeWorkspaceContract";

const id = z.string().min(1).max(4096);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const backup = z
    .object({
        format: z.literal("momoki.native-backup.v1"),
        schema: z.literal(4),
        workspaceId: id,
        databaseBytes: z.number().int().positive(),
        databaseHash: digest,
        assets: z.array(asset).max(10000),
    })
    .strict();
const outcome = z.discriminatedUnion("kind", [
    z.object({kind: z.literal("state"), value: state}).strict(),
    z.object({kind: z.literal("project"), value: project}).strict(),
    z.object({kind: z.literal("asset"), value: asset}).strict(),
    z
        .object({
            kind: z.literal("availability"),
            value: z.array(availability).max(10000),
        })
        .strict(),
    z.object({kind: z.literal("videoProject"), value: videoProject}).strict(),
    z.object({kind: z.literal("episode"), value: episode}).strict(),
    z.object({kind: z.literal("beat"), value: beat}).strict(),
    z.object({kind: z.literal("shot"), value: shot}).strict(),
    z
        .object({kind: z.literal("shots"), value: z.array(shot).max(10000)})
        .strict(),
    z
        .object({
            kind: z.literal("duplicateBeat"),
            value: nativeDuplicateBeatSchema,
        })
        .strict(),
    z
        .object({
            kind: z.literal("duplicateShot"),
            value: nativeDuplicateShotSchema,
        })
        .strict(),
    z.object({kind: z.literal("undo"), value: nativeUndoSchema}).strict(),
    z
        .object({
            kind: z.literal("conflict"),
            value: nativeConflictSchema,
        })
        .strict(),
    z
        .object({kind: z.literal("videoState"), value: nativeVideoStateSchema})
        .strict(),
    z.object({kind: z.literal("backup"), value: backup}).strict(),
]);
const result = z.discriminatedUnion("type", [
    z.object({type: z.literal("state"), value: state.nullable()}).strict(),
    z.object({type: z.literal("outcome"), value: outcome}).strict(),
    z.object({type: z.literal("canceled")}).strict(),
    z.object({type: z.literal("closed")}).strict(),
    z.object({type: z.literal("released")}).strict(),
    z
        .object({
            type: z.literal("read"),
            value: z
                .object({session: id, asset, chunkBytes: z.literal(262144)})
                .strict(),
        })
        .strict(),
    z
        .object({
            type: z.literal("chunk"),
            value: z.array(z.number().int().min(0).max(255)).max(262144),
        })
        .strict(),
    z
        .object({
            type: z.literal("saved"),
            value: z
                .object({
                    asset,
                    exported: z.boolean(),
                    byteLength: z
                        .number()
                        .int()
                        .positive()
                        .max(32 * 1024 ** 2),
                    contentHash: digest,
                })
                .strict(),
        })
        .strict(),
    z
        .object({
            type: z.literal("exported"),
            value: z
                .object({
                    byteLength: z
                        .number()
                        .int()
                        .positive()
                        .max(32 * 1024 ** 2),
                    contentHash: digest,
                })
                .strict(),
        })
        .strict(),
]);
const reply = z
    .object({
        version: z.literal(1),
        generation: z.number().int().nonnegative(),
        result,
    })
    .strict();
export type NativeState = z.infer<typeof state>;
type Action =
    | NativeAction
    | { type: "create" | "open" | "reopen" | "close" | "restore" | "backup" }
    | { type: "readStart" | "export"; assetId: string }
    | { type: "readChunk"; session: string; offset: number; length: number }
    | { type: "readClose"; session: string }
    | {
    type: "saveGenerated";
    metadata: {
        projectId: string;
        assetId: string;
        format: "csv" | "zip" | "wav" | "microphone";
        recordedMime?: string;
    };
    mode: "retain" | "export";
    bytes: number[];
};

class NativeWorkspace {
    generation = 0;
    active = new Set<string>();

    async request(action: Action) {
        const operationId = crypto.randomUUID();
        const expectedGeneration = this.generation;
        this.active.add(operationId);
        try {
            const unknown: unknown = await invoke("workspace_request", {
                request: {version: 1, operationId, expectedGeneration, action},
            });
            const parsed = reply.parse(unknown);
            // A late committed outcome is still returned; an older reply cannot move the current generation backward.
            if (
                parsed.generation < this.generation &&
                (parsed.result.type === "state" ||
                    (parsed.result.type === "outcome" &&
                        parsed.result.value.kind === "state"))
            )
                throw new Error("工作区已切换，忽略旧状态");
            this.generation = Math.max(this.generation, parsed.generation);
            return parsed.result;
        } catch (cause) {
            if (cause && typeof cause === "object" && "code" in cause && cause.code === "published") {
                throw nativeWorkspacePublishedError();
            }
            throw cause;
        } finally {
            this.active.delete(operationId);
        }
    }

    async cancel() {
        await Promise.all(
            [...this.active].map(async (operationId) => {
                const value: unknown = await invoke("workspace_cancel", {
                    request: {
                        version: 1,
                        expectedGeneration: this.generation,
                        operationId,
                    },
                });
                z.boolean().parse(value);
            }),
        );
    }

    async read(assetId: string) {
        const started = await this.request({type: "readStart", assetId});
        if (started.type !== "read") throw new Error("原生读取未建立");
        const {session, asset} = started.value;
        const generation = this.generation;
        try {
            if (asset.byteLength > 32 * 1024 ** 2) throw new Error("预览最多 32 MiB");
            const bytes = new Uint8Array(asset.byteLength);
            for (let offset = 0; offset < bytes.length; offset += 262144) {
                if (this.generation !== generation) throw new Error("工作区已切换");
                const length = Math.min(262144, bytes.length - offset);
                const chunk = await this.request({
                    type: "readChunk",
                    session,
                    offset,
                    length,
                });
                if (chunk.type !== "chunk" || chunk.value.length !== length)
                    throw new Error("原生分块长度不符");
                bytes.set(chunk.value, offset);
            }
            const contentHash = await sha256(bytes);
            if (this.generation !== generation || contentHash !== asset.contentHash)
                throw new Error("素材校验失败或工作区已切换");
            return {asset, blob: new Blob([bytes], {type: asset.mimeType})};
        } finally {
            await this.request({type: "readClose", session});
        }
    }

    async save(
        blob: Blob,
        projectId: string,
        format: "csv" | "zip" | "wav" | "microphone",
        mode: "retain" | "export" = "export",
        recordedMime?: string,
    ) {
        if (blob.size === 0 || blob.size > 32 * 1024 ** 2)
            throw new Error("成果最多 32 MiB");
        const generation = this.generation;
        const buffer = await blob.arrayBuffer();
        if (this.generation !== generation) throw new Error("工作区已切换");
        const result = await this.request({
            type: "saveGenerated",
            metadata: {
                projectId,
                assetId: crypto.randomUUID(),
                format,
                ...(recordedMime === undefined ? {} : {recordedMime}),
            },
            mode,
            bytes: [...new Uint8Array(buffer)],
        });
        if (result.type === "canceled") return result;
        if (
            (result.type !== "saved" && result.type !== "exported") ||
            result.value.byteLength !== blob.size ||
            result.value.contentHash !== (await sha256(buffer))
        )
            throw new Error("原生成果保存校验失败");
        return result;
    }
}

export async function sha256(input: ArrayBuffer | Uint8Array) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const hash = new Sha256();
    for (let offset = 0; offset < bytes.length; offset += 262144) {
        hash.update(bytes.subarray(offset, offset + 262144));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return hash.digest();
}

export const native = new NativeWorkspace();

const acceptanceReply = z
    .object({
        version: z.literal(1),
        generation: z.number().int().nonnegative(),
        state: state.nullable(),
        reportSaved: z.boolean(),
    })
    .strict();

export async function acceptanceRequest(action: {
    type: "setup" | "ready" | "report" | "openDeniedProbe";
    json?: string;
}) {
    const unknown: unknown = await invoke("acceptance_request", {
        request: {version: 1, action},
    });
    const value = acceptanceReply.parse(unknown);
    native.generation = Math.max(native.generation, value.generation);
    return value;
}
