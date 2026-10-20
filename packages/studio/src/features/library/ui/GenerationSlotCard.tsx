import {binaryByteLength} from "../../../platform/media/binaryTypes";
import {verifyBinaryAvailable} from "../../../platform/storage/binary";
import {useWorkspaceUnavailable} from "../../../platform/product/workspaceAvailability";
import {useManualDraftGuard} from "../../../app/drafts/useManualDraftGuard";
import {Library, Plus, Trash2, Type} from "../../../ui/icons";
import {useCallback, useEffect, useId, useRef, useState} from "react";
import {toast} from "sonner";
import {deleteMediaIfOrphan} from "../commands/media";
import {SlotEditSession} from "../services/slotEditSession";
import {DraftMediaSession} from "../services/draftMedia";
import {emptySlot, slotHasBody} from "../models/slot";
import type {GenerationSlot, MediaKind} from "../models/slots";
import type {Id} from "../../../platform/identity";
import type {MediaRecord} from "../models/media";
import {IMAGE_ACCEPT, MEDIA_ACCEPT, pickMediaFile, uploadMediaFile, VIDEO_ACCEPT,} from "../services/media";
import {cn} from "../../../ui/cn";
import {MediaPicker} from "./MediaPicker";
import {MediaPreview} from "./MediaThumb";
import {Badge} from "../../../ui/badge";
import {Button} from "../../../ui/button";
import {SidePanel} from "../../../app/layout/SidePanel";
import {Label} from "../../../ui/label";
import {Textarea} from "../../../ui/textarea";

type TileVariant = "frame" | "reference" | "asset" | "clip";
/** `row`: fit capped media/design shot cells; `default`: fixed library/detail tiles. */
type TileSize = "default" | "row";

function reportCleanupFailure(session: DraftMediaSession) {
    toast.error("未保存素材清理失败", {
        action: {
            label: "重试清理",
            onClick: () => {
                void session.cancel().catch(() => reportCleanupFailure(session));
            },
        },
    });
}

function GenerationSlotTile({
                                slot,
                                variant,
                                label,
                                ariaLabel,
                                onOpen,
                                size = "default",
                            }: {
    slot: GenerationSlot;
    variant: TileVariant;
    label?: string;
    ariaLabel?: string;
    onOpen: () => void;
    size?: TileSize;
}) {
    const hasResult = Boolean(slot.result?.mediaId);
    const hasBody = slotHasBody(slot);
    const dashed = (variant === "reference" || variant === "clip") && !hasResult;
    const rowFit = size === "row" && variant !== "asset";

    return (
        <div
            className={
                variant === "asset"
                    ? "w-full"
                    : rowFit
                        ? "relative mx-auto h-full max-h-[120px] w-full max-w-full"
                        : "relative mx-auto h-[124px] w-[220px]"
            }
        >
            {label ? <div className="text-muted-foreground mb-1.5 text-xs">{label}</div> : null}
            <button
                type="button"
                aria-label={ariaLabel}
                onClick={onOpen}
                className={cn(
                    "relative flex flex-col overflow-hidden text-left",
                    variant === "asset"
                        ? "bg-muted h-36 w-full rounded-xl border"
                        : dashed
                            ? "bg-muted/40 h-full w-full rounded-md border border-dashed"
                            : "bg-background h-full w-full rounded-md border",
                )}
            >
                {hasResult ? (
                    <MediaPreview mediaId={slot.result?.mediaId} className="h-full w-full"/>
                ) : hasBody ? (
                    <div className="flex h-full flex-col justify-between p-3">
                        <Type className="text-muted-foreground size-4"/>
                        <p className="line-clamp-3 text-[12px] leading-5">
                            {slot.prompt || "已填写参考，待生成"}
                        </p>
                    </div>
                ) : variant === "clip" ? (
                    <span className="text-muted-foreground m-auto px-4 text-center text-[11px] leading-5">
            成片，可先挂图
          </span>
                ) : variant === "frame" ? (
                    <span className="text-muted-foreground m-auto">
            <Plus className="size-5"/>
          </span>
                ) : (
                    <span className="text-muted-foreground m-auto px-4 text-center text-[11px] leading-5">
            填写提示词与参考
          </span>
                )}
                {hasResult ? (
                    <span className="absolute top-1.5 right-1.5">
            <Badge variant="secondary">{slot.result?.kind === "video" ? "视频" : "图片"}</Badge>
          </span>
                ) : null}
            </button>
        </div>
    );
}

function RefStrip({
                      ids,
                      onRemove,
                      onAdd,
                      addLabel,
                      disabled,
                      labelledBy,
                  }: {
    ids: Id[];
    onRemove: (id: Id) => void;
    onAdd: () => void;
    addLabel: string;
    disabled?: boolean;
    labelledBy: string;
}) {
    return (
        <div role="group" aria-labelledby={labelledBy} className="flex flex-wrap gap-2">
            {ids.map((id, index) => (
                <div key={id} className="relative w-48 space-y-1 overflow-hidden rounded-lg border p-1">
                    <MediaPreview mediaId={id} className="h-28 w-full" inspect/>
                    <Button
                        type="button"
                        size="icon-sm"
                        variant="secondary"
                        className="ml-auto flex size-6 rounded-full"
                        disabled={disabled}
                        onClick={() => onRemove(id)}
                        aria-label={`移除第 ${index + 1} 项参考`}
                    >
                        <Trash2/>
                    </Button>
                </div>
            ))}
            <button
                type="button"
                onClick={onAdd}
                disabled={disabled}
                className="text-muted-foreground hover:text-foreground hover:border-brand flex h-20 w-28 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-xs"
            >
                <Plus className="size-3.5"/>
                {addLabel}
            </button>
        </div>
    );
}

export function GenerationSlotEditor({
                                         open,
                                         targetKey,
                                         title,
                                         projectId,
                                         value,
                                         onClose,
                                         onSave,
                                         resultKinds = ["image", "video"],
                                         unavailable = false,
                                     }: {
    open: boolean;
    unavailable?: boolean;
    targetKey: string;
    resultKinds?: readonly MediaKind[];
    title: string;
    projectId: Id;
    value: GenerationSlot;
    onClose: () => void;
    onSave: (slot: GenerationSlot, baseline: GenerationSlot) => Promise<void>;
}) {
    const workspaceUnavailable = useWorkspaceUnavailable();
    const [editSession] = useState(() => new SlotEditSession(targetKey, projectId, title, value, resultKinds, onSave));
    const [draft, setDraft] = useState(() => structuredClone(editSession.baseline));
    const targetChanged = targetKey !== editSession.targetKey;
    const currentTarget = useRef(targetKey);
    currentTarget.current = targetKey;
    const [pickerTarget, setPickerTarget] = useState<"image" | "video" | "result" | null>(null);
    const [pending, setPending] = useState<"upload" | "save" | "close" | null>(null);
    const [error, setError] = useState<string>();
    const [cancelled, setCancelled] = useState(false);
    const [session] = useState(() => new DraftMediaSession(deleteMediaIfOrphan));
    const busy = useRef(false);
    const failedUpload = useRef<{ kind: "image" | "video" | "result"; file: File } | null>(null);
    const mounted = useRef(true);
    const promptId = useId();
    const refImageId = useId();
    const refVideoId = useId();
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            // StrictMode replays effects; only dispose if this editor really unmounted.
            queueMicrotask(() => {
                if (!mounted.current) void session.cancel().catch(() => reportCleanupFailure(session));
            });
        };
    }, [session]);

    const navigationGuard = useManualDraftGuard(
        JSON.stringify(draft) !== JSON.stringify(editSession.baseline) || Boolean(error) || Boolean(failedUpload.current),
        pending !== null,
        async () => {
            // cancel() closes ownership before deleting uploads. A cleanup failure
            // must leave a readable canceled session, not enabled save/upload controls.
            setCancelled(true);
            try {
                await session.cancel();
            } catch (reason) {
                fail(reason);
                throw reason;
            }
        },
    );

    const mediaIds = (slot: GenerationSlot) => [
        ...slot.referenceImageIds, ...slot.referenceVideoIds,
        ...(slot.result ? [slot.result.mediaId] : []),
    ];
    const fail = (reason: unknown) => {
        if (mounted.current) setError(reason instanceof Error ? reason.message : "操作失败，请重试");
    };

    async function upload(kind: "image" | "video" | "result", retryFile?: File) {
        if (busy.current || cancelled || targetChanged || unavailable || workspaceUnavailable) return;
        busy.current = true;
        setPending("upload");
        setError(undefined);
        try {
            const uploaded = await session.upload(async () => {
                const file = retryFile ?? await pickMediaFile(kind === "result" ? (editSession.resultKinds.length === 1 ? IMAGE_ACCEPT : MEDIA_ACCEPT) : kind === "video" ? VIDEO_ACCEPT : IMAGE_ACCEPT);
                if (!file) throw new Error("未选择文件");
                const allowedKinds = kind === "result" ? editSession.resultKinds : [kind];
                if (!allowedKinds.some((allowed) => file.type.startsWith(`${allowed}/`))) {
                    throw new Error(kind === "video" ? "请选择视频文件" : "请选择支持的图片文件");
                }
                failedUpload.current = {kind, file};
                return uploadMediaFile(editSession.projectId, file);
            });
            if (!uploaded || !mounted.current) return;
            failedUpload.current = null;
            const next = kind === "result"
                ? {...draft, result: {mediaId: uploaded.id, kind: uploaded.kind}}
                : kind === "video"
                    ? {...draft, referenceVideoIds: [...draft.referenceVideoIds, uploaded.id]}
                    : {...draft, referenceImageIds: [...draft.referenceImageIds, uploaded.id]};
            setDraft(next);
            await session.discardExcept(mediaIds(next));
        } catch (reason) {
            if (!(reason instanceof Error && reason.message === "未选择文件")) fail(reason);
        } finally {
            busy.current = false;
            if (mounted.current) setPending((current) => current === "close" ? current : null);
        }
    }

    async function selectExisting(record: MediaRecord) {
        if (busy.current || cancelled || targetChanged || unavailable || workspaceUnavailable || !pickerTarget || record.projectId !== editSession.projectId) return;
        const kind: MediaKind = record.mimeType.startsWith("video/") ? "video" : "image";
        const allowedKinds = pickerTarget === "result" ? editSession.resultKinds : [pickerTarget];
        if (!allowedKinds.includes(kind) || binaryByteLength(record.blob) === 0) return;
        const next = pickerTarget === "result"
            ? {...draft, result: {mediaId: record.id, kind}}
            : pickerTarget === "video"
                ? {...draft, referenceVideoIds: [...new Set([...draft.referenceVideoIds, record.id])]}
                : {...draft, referenceImageIds: [...new Set([...draft.referenceImageIds, record.id])]};
        busy.current = true;
        setPending("upload");
        setError(undefined);
        try {
            await verifyBinaryAvailable(record.blob);
            if (!mounted.current || cancelled || targetChanged || unavailable || workspaceUnavailable) return;
            setDraft(next);
            setPickerTarget(null);
            failedUpload.current = null;
            await session.discardExcept(mediaIds(next));
        } catch (reason) {
            fail(reason);
        } finally {
            busy.current = false;
            if (mounted.current) setPending(null);
        }
    }

    function renderPicker(target: "image" | "video" | "result") {
        if (pickerTarget !== target) return null;
        const selectedIds = target === "result"
            ? draft.result ? [draft.result.mediaId] : []
            : target === "image" ? draft.referenceImageIds : draft.referenceVideoIds;
        return (
            <MediaPicker
                key={target}
                projectId={editSession.projectId}
                kinds={target === "result" ? editSession.resultKinds : [target]}
                disabled={pending !== null || cancelled || targetChanged || unavailable || workspaceUnavailable}
                selectedIds={selectedIds}
                onSelect={(record) => void selectExisting(record)}
                onClose={() => setPickerTarget(null)}
            />
        );
    }

    async function close() {
        if (pending === "save" || pending === "close") return;
        busy.current = true;
        setCancelled(true);
        setPending("close");
        try {
            await session.cancel();
            onClose();
        } catch (reason) {
            fail(reason);
            setPending(null);
        }
    }

    async function save() {
        if (busy.current || cancelled || unavailable || workspaceUnavailable) return;
        busy.current = true;
        setPending("save");
        setError(undefined);
        try {
            editSession.assertTarget(currentTarget.current);
            await session.save(mediaIds(draft), () => editSession.save(draft, currentTarget.current));
            if (mounted.current && currentTarget.current === editSession.targetKey) onClose();
        } catch (reason) {
            fail(reason);
        } finally {
            busy.current = false;
            if (mounted.current) setPending(null);
        }
    }

    return (
        <>
            {navigationGuard}
            <SidePanel open={open} onOpenChange={(next) => !next && void close()} kind="slot-editor" width={520}
                       title={editSession.title}
                       description="填写画面描述、添加参考，或上传、复用已有素材。保存后可用于分镜和交付。"
                       footer={<>
                        <Button variant="outline" disabled={pending === "save" || pending === "close"}
                                onClick={() => void close()}>
                            {pending === "close" ? "正在清理…" : "取消"}
                        </Button>
                        <Button
                            variant="brand"
                            disabled={pending !== null || cancelled || targetChanged || unavailable || workspaceUnavailable}
                            onClick={() => void save()}
                        >
                            {pending === "save" ? "保存中…" : pending === "upload" ? "上传中…" : error && !failedUpload.current ? "重试保存" : "保存"}
                        </Button>
                       </>}>
                    <div className="space-y-5">
                        <div className="grid gap-2">
                            <Label htmlFor={promptId}>画面描述 / 提示词</Label>
                            <Textarea
                                autoFocus
                                id={promptId}
                                disabled={pending !== null || cancelled}
                                readOnly={targetChanged || unavailable || workspaceUnavailable}
                                value={draft.prompt}
                                onChange={(event) => setDraft({...draft, prompt: event.target.value})}
                                placeholder="描述画面内容、动作、光线或镜头…"
                                className="min-h-32"
                            />
                        </div>
                        <div className="grid gap-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div id={refImageId} className="text-sm font-medium">参考图</div>
                                <Button type="button" variant="ghost" size="sm"
                                        disabled={pending !== null || cancelled || targetChanged || unavailable || workspaceUnavailable}
                                        onClick={() => setPickerTarget(pickerTarget === "image" ? null : "image")}>
                                    <Library/> 选择已有参考图
                                </Button>
                            </div>
                            <RefStrip
                                disabled={pending !== null || cancelled || targetChanged || unavailable || workspaceUnavailable}
                                labelledBy={refImageId}
                                ids={draft.referenceImageIds}
                                addLabel="添加图片"
                                onAdd={() => void upload("image")}
                                onRemove={(id) =>
                                    setDraft({
                                        ...draft,
                                        referenceImageIds: draft.referenceImageIds.filter((item) => item !== id),
                                    })
                                }
                            />
                            {renderPicker("image")}
                        </div>
                        <div className="grid gap-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div id={refVideoId} className="text-sm font-medium">参考视频</div>
                                <Button type="button" variant="ghost" size="sm"
                                        disabled={pending !== null || cancelled || targetChanged || unavailable || workspaceUnavailable}
                                        onClick={() => setPickerTarget(pickerTarget === "video" ? null : "video")}>
                                    <Library/> 选择已有参考视频
                                </Button>
                            </div>
                            <RefStrip
                                disabled={pending !== null || cancelled || targetChanged || unavailable || workspaceUnavailable}
                                labelledBy={refVideoId}
                                ids={draft.referenceVideoIds}
                                addLabel="添加视频"
                                onAdd={() => void upload("video")}
                                onRemove={(id) =>
                                    setDraft({
                                        ...draft,
                                        referenceVideoIds: draft.referenceVideoIds.filter((item) => item !== id),
                                    })
                                }
                            />
                            {renderPicker("video")}
                        </div>
                        <div className="bg-muted space-y-3 rounded-xl p-4">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div>
                                    <div className="text-sm font-medium">成片 / 画面素材</div>
                                    <div className="text-muted-foreground text-[11px]">
                                        {editSession.resultKinds.length === 1 ? "支持图片素材，可复用已有画面" : "支持已有图片或视频，视频可直接播放检查"}
                                    </div>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <Button type="button" size="sm" variant="outline"
                                            disabled={pending !== null || cancelled || targetChanged || unavailable || workspaceUnavailable}
                                            onClick={() => setPickerTarget(pickerTarget === "result" ? null : "result")}>
                                        <Library/> 选择已有素材
                                    </Button>
                                    <Button size="sm" variant="outline"
                                            disabled={pending !== null || cancelled || targetChanged || unavailable || workspaceUnavailable}
                                            onClick={() => void upload("result")}>
                                        上传素材
                                    </Button>
                                    {draft.result ? (
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={pending !== null || cancelled || targetChanged || unavailable || workspaceUnavailable}
                                            onClick={() => setDraft({...draft, result: undefined})}
                                        >
                                            清除
                                        </Button>
                                    ) : null}
                                </div>
                            </div>
                            <div className="bg-background h-64 overflow-hidden rounded-lg border">
                                <MediaPreview
                                    mediaId={draft.result?.mediaId}
                                    className="h-full w-full"
                                    empty="尚未添加素材"
                                    inspect
                                />
                            </div>
                            {renderPicker("result")}
                        </div>
                    </div>
                    {targetChanged ? <p role="alert" className="text-destructive text-sm">
                        编辑目标已切换，当前仍是「{editSession.title}」的草稿。请关闭后重新打开目标槽位。
                    </p> : null}
                    {error ? (
                        <div role="alert" className="text-destructive text-sm">
                            <p>{error}。{cancelled ? "请再次取消以重试清理。" : "内容已保留，可重试或取消。"}</p>
                            {failedUpload.current && !cancelled ? (
                                <Button variant="outline" size="sm"
                                        disabled={pending !== null || unavailable || workspaceUnavailable}
                                        onClick={() => {
                                            const retry = failedUpload.current;
                                            if (retry) void upload(retry.kind, retry.file);
                                        }}>重试上传</Button>
                            ) : null}
                        </div>
                    ) : null}
            </SidePanel>
        </>
    );
}

export function EditableGenerationSlot({
                                           projectId,
                                           targetKey,
                                           slot,
                                           variant,
                                           label,
                                           title,
                                           onSave,
                                           size = "default",
                                           onEditorOpenChange,
                                           unavailable = false,
                                       }: {
    projectId: Id;
    targetKey: string;
    slot?: GenerationSlot;
    variant: TileVariant;
    label?: string;
    title: string;
    onSave: (slot: GenerationSlot, baseline: GenerationSlot) => Promise<void>;
    size?: TileSize;
    onEditorOpenChange?: (open: boolean) => void;
    unavailable?: boolean;
}) {
    const value = slot ?? emptySlot();
    const [open, setOpen] = useState(false);
    const reportOpen = useRef(onEditorOpenChange);
    reportOpen.current = onEditorOpenChange;
    const reportedOpen = useRef(false);
    const notifyOpen = useCallback((next: boolean) => {
        if (reportedOpen.current === next) return;
        reportedOpen.current = next;
        reportOpen.current?.(next);
    }, []);
    useEffect(() => {
        if (!open) return;
        notifyOpen(true);
        // Balance notifications when a mounted slot disappears as well as on close.
        return () => notifyOpen(false);
    }, [open, notifyOpen]);
    return (
        <>
            <GenerationSlotTile
                slot={value}
                variant={variant}
                label={label}
                ariaLabel={title}
                size={size}
                onOpen={() => {notifyOpen(true); setOpen(true);}}
            />
            {open ? (
                <GenerationSlotEditor
                    open={open}
                    unavailable={unavailable}
                    targetKey={targetKey}
                    title={title}
                    projectId={projectId}
                    value={value}
                    resultKinds={variant === "clip" ? ["image", "video"] : ["image"]}
                    onClose={() => {notifyOpen(false); setOpen(false);}}
                    onSave={onSave}
                />
            ) : null}
        </>
    );
}
