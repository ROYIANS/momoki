import {type MouseEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState} from "react";
import {readBusinessDetailTarget, useBusinessDetails, type BusinessDetailTarget, type DetailReturnOrigin} from "../../../app/details/BusinessDetails";
import {useProductQuery} from "../../../platform/product/queries";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
    ContextPanel,
    ContextPanelContent,
    ContextPanelDescription,
    ContextPanelFooter,
    ContextPanelHeader,
    ContextPanelTitle
} from "../../../app/layout/context-panel";
import {useAutoOpenPanel} from "../../../app/layout/autoOpen";
import {Link, useBlocker} from "@tanstack/react-router";
import {
    ArrowUpRight,
    Check,
    ChevronRight,
    CircleAlert,
    Copy,
    Images,
    LoaderCircle,
    Maximize2,
    Pause,
    Play,
    Trash2,
    X
} from "../../../ui/icons";
import {resolveConnector} from "../../settings/commands/connectors";
import {
    applyBatchSelections,
    changeGenerationBatchItems,
    confirmGenerationBatch,
    readGenerationBatch,
    retryFailedBatch,
    saveGenerationBatchDraft,
    selectBatchCandidate
} from "../commands/agentGenerationBatches";
import {
    BATCH_CONCURRENCY,
    BATCH_REQUEST_LIMIT,
    BATCH_TARGET_LIMIT,
    type GenerationBatch,
    type GenerationBatchItem,
    generationKind
} from "../models/agentGenerationBatch";
import {CHARACTER_SLOTS, PROP_SLOTS, SCENE_SLOTS, STYLE_SLOTS} from "../../library/models/slots";
import {STUDIO_LIBRARY_ID} from "../../library/models/ownership";
import type {ProductionTarget} from "../../video/models/production";
import type {AgentGenerationJob, AgentGenerationStatus} from "../models/agentGeneration";
import {type GenerationSubmitArgs, generationSubmitSchema, profileRequest} from "../../video/agent/generationProfiles";
import {getGenerationPreferenceState} from "../../settings/commands/generationPreferences";
import {recommendGenerationSelection} from "../../video/agent/generationSelection";
import {applyGenerationSelection} from "../../video/agent/generationReviewDraft";
import {batchUserAction, startGenerationBatch, stopGenerationBatch} from "../../video/agent/generationBatchRuntime";
import {generationTargetDestination} from "../../video/services/generationTargetDestination";
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle
} from "../../../ui/alert-dialog";
import {Button} from "../../../ui/button";
import {MediaPreview} from "../../library/ui/MediaThumb";
import {GenerationConfigurationFields} from "./GenerationReview";
import {useAgentActivityNavigation} from "./AgentActivityNavigation";
import {agentExecution} from "../runtime/agentExecution";
import "./generationBatch.css";

type BatchDetail = Awaited<ReturnType<typeof readGenerationBatch>>;
type DraftEdit = { id: string; draft: GenerationSubmitArgs; included: boolean };
type ReviewBookmark = {
    scrollTop: number;
    itemId?: string;
    controlKey: string;
    controlIndex: number;
    selection?: {start: number; end: number; direction: "forward" | "backward" | "none"};
};
type ReviewHandoff = {
    token: string;
    target: BusinessDetailTarget;
    bookmark: ReviewBookmark;
    phase: "opening" | "opened";
    requestId?: string;
    returnRequested?: boolean;
};
const REVIEW_CONTROLS = "button, a[href], input, textarea, select, summary, [tabindex]";

function reviewControlKey(control: HTMLElement) {
    const labels = control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement
        ? [...control.labels ?? []].map(label => label.textContent?.trim()).join("|") : "";
    const name = control.getAttribute("aria-label") ?? (labels || control.textContent?.trim());
    return [control.tagName, control.getAttribute("type"), name].join(":");
}

function captureReviewBookmark(body: HTMLElement, fallback: HTMLElement): ReviewBookmark {
    const focused = document.activeElement instanceof HTMLElement && body.contains(document.activeElement) ? document.activeElement : fallback;
    const item = focused.closest<HTMLElement>("[data-batch-item-id]");
    const scope = item ?? body;
    const controlKey = reviewControlKey(focused);
    const controls = [...scope.querySelectorAll<HTMLElement>(REVIEW_CONTROLS)].filter(control => reviewControlKey(control) === controlKey);
    const bookmark: ReviewBookmark = {
        scrollTop: body.scrollTop,
        itemId: item?.dataset.batchItemId,
        controlKey,
        controlIndex: controls.indexOf(focused),
    };
    if ((focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement)
        && focused.selectionStart !== null && focused.selectionEnd !== null) {
        bookmark.selection = {start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection ?? "none"};
    }
    return bookmark;
}

function restoreReviewBookmark(body: HTMLElement, bookmark: ReviewBookmark) {
    const item = bookmark.itemId ? [...body.querySelectorAll<HTMLElement>("[data-batch-item-id]")]
        .find(row => row.dataset.batchItemId === bookmark.itemId) : undefined;
    const control = [...(item ?? body).querySelectorAll<HTMLElement>(REVIEW_CONTROLS)]
        .filter(candidate => reviewControlKey(candidate) === bookmark.controlKey)[bookmark.controlIndex];
    if (control && !control.matches(":disabled") && !control.closest("[inert], [hidden]")) {
        control.focus({preventScroll: true});
        if (bookmark.selection && (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)
            && control.selectionStart !== null && control.selectionEnd !== null) {
            control.setSelectionRange(bookmark.selection.start, bookmark.selection.end, bookmark.selection.direction);
        }
    } else {
        body.closest<HTMLElement>("[role=dialog]")?.focus({preventScroll: true});
    }
    body.scrollTop = bookmark.scrollTop;
}

function matchesProductionTarget(parsed: BusinessDetailTarget, target: ProductionTarget) {
    if (parsed.kind === "shot") return target.kind === "shot" && parsed.target.projectId === target.projectId
        && parsed.target.episodeId === target.episodeId && parsed.target.shotId === target.entityId;
    return target.kind !== "shot" && parsed.target.kind === target.kind && parsed.target.entityId === target.entityId
        && (parsed.target.owner.kind === "studio" ? target.projectId === STUDIO_LIBRARY_ID : parsed.target.owner.projectId === target.projectId);
}
const BATCH_LABELS = {
    draft: "待确认",
    ready: "等待开始",
    running: "处理中",
    paused: "已暂停",
    settled: "处理完成",
    cancelled: "已取消剩余"
};
const JOB_LABELS: Record<AgentGenerationStatus, string> = {
    submitting: "正在提交",
    submitted: "等待生成",
    running: "正在生成",
    remote_completed: "准备保存",
    downloading: "正在保存",
    downloaded: "已保存",
    applied: "已保存",
    conflict: "目标有变化，结果保留",
    failed: "生成失败",
    unknown: "提交未确认",
};
const WORKING = new Set<AgentGenerationStatus>(["submitting", "submitted", "running", "remote_completed", "downloading"]);

function message(cause: unknown) {
    return cause instanceof Error ? cause.message : "操作失败，请重试；当前编辑已保留。";
}

function targetLabel(item: GenerationBatchItem) {
    const target = item.draft.target;
    if (target.kind === "library") return `${item.label} · 素材库 · ${target.slot === "video" ? "视频" : "图片"}`;
    const slots = target.kind === "shot" ? [{id: "firstFrame", label: "首帧"}, {
        id: "lastFrame",
        label: "尾帧"
    }, {id: "clip", label: "视频"}] : {
        character: CHARACTER_SLOTS,
        scene: SCENE_SLOTS,
        prop: PROP_SLOTS,
        style: STYLE_SLOTS
    }[target.kind];
    return `${item.label} · ${slots.find(slot => slot.id === target.slot)?.label ?? target.slot}`;
}

function itemStatus(item: GenerationBatchItem, job?: AgentGenerationJob) {
    if (job) return JOB_LABELS[job.status];
    return item.state === "cancelled" ? "未提交" : item.state === "queued" ? "排队中" : item.included ? "待确认" : "不生成";
}

/** Mounting only reads local state. Every network operation begins with a user action. */
export function AgentGenerationBatches({runId}: { runId: string }) {
    const last = useRef<{ runId: string; batches: GenerationBatch[] } | null>(null);
    const [readAttempt, setReadAttempt] = useState(0);
    const view = useProductQuery(async (db) => {
        try {
            const batches = await db.agentGenerationBatches.where("runId").equals(runId).sortBy("createdAt");
            last.current = {runId, batches};
            return {runId, batches, error: undefined as string | undefined};
        } catch (cause) {
            return {runId, batches: last.current?.runId === runId ? last.current.batches : [], error: message(cause)};
        }
    }, [runId, readAttempt]);
    if (!view || view.runId !== runId) return null;
    return <div className="agent-batches" aria-label="批量生成">
        {view.error && <p className="agent-batch-error" role="alert">读取失败，当前内容已保留
            <button type="button" title={view.error} onClick={() => setReadAttempt(value => value + 1)}>重试</button>
        </p>}
        {view.batches.map(batch => <BatchSurface key={batch.id} batch={batch} parentReadError={Boolean(view.error)}/>)}
    </div>;
}

function BatchSurface({batch, parentReadError}: { batch: GenerationBatch; parentReadError: boolean }) {
    const {request} = useAgentActivityNavigation();
    const details = useBusinessDetails();
    const openDetail = details?.open, returnToOrigin = details?.returnToOrigin;
    const session = useId();
    const sequence = useRef(0);
    const alive = useRef(true);
    const handoffRef = useRef<ReviewHandoff | null>(null);
    const restoreBookmark = useRef<ReviewBookmark | null>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const last = useRef<BatchDetail | undefined>(undefined);
    const [readAttempt, setReadAttempt] = useState(0);
    const [open, setOpen] = useState(false);
    const [retainedNotice, setRetainedNotice] = useState<string>();
    const localRef = useRef<{ revision: number; edits: DraftEdit[] } | null>(null);
    const finishHandoff = useCallback((token: string, restore: boolean) => {
        const current = handoffRef.current;
        if (!alive.current || current?.token !== token) return;
        restoreBookmark.current = restore ? current.bookmark : null;
        handoffRef.current = null;
        // Replacement retires the old origin without reopening the review over the new detail.
        setOpen(restore);
        // The retained local draft stays reachable and is announced, never silently hidden.
        if (!restore && localRef.current) setRetainedNotice("批量审阅已收起，未保存的编辑仍保留。点击「打开」继续审阅。");
    }, []);
    const revealReview = useCallback(() => {
        const current = handoffRef.current;
        setRetainedNotice(undefined);
        if (!current) {setOpen(true); return;}
        if (current.phase !== "opened") {current.returnRequested = true; return;}
        if (returnToOrigin) void returnToOrigin(current.token).then(result => {
            if (result === "stale") finishHandoff(current.token, true);
        });
    }, [returnToOrigin, finishHandoff]);
    useEffect(() => {
        if (request?.runId === batch.runId && request.batchId === batch.id) revealReview();
    }, [request, batch.runId, batch.id, revealReview]);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            queueMicrotask(() => {if (!alive.current) handoffRef.current = null;});
        };
    }, []);
    const [inspecting, setInspecting] = useState(false);
    const [local, setLocal] = useState<{ revision: number; edits: DraftEdit[] } | null>(null);
    useLayoutEffect(() => {localRef.current = local;});
    const [expanded, setExpanded] = useState<string>();
    const [targetKey, setTargetKey] = useState<string>();
    const [pending, setPending] = useState(false);
    const pendingRef = useRef(false);
    const [error, setError] = useState<string>();
    const [notice, setNotice] = useState<string>();
    const [outcomes, setOutcomes] = useState<Array<{ targetKey: string; applied: boolean; error?: string }>>([]);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const view = useProductQuery(async (db) => {
        try {
            const detail = await readGenerationBatch(batch.id, batch.threadId, db);
            const task = batch.taskId ? await db.agentTasks.get(batch.taskId) : undefined;
            last.current = detail;
            return {
                detail,
                error: undefined as string | undefined,
                readOnly: Boolean(batch.taskId && task?.lifecycle !== "open")
            };
        } catch (cause) {
            return {detail: last.current, error: message(cause), readOnly: true};
        }
    }, [batch.id, batch.threadId, batch.taskId, readAttempt]);
    const detail = last.current && view?.detail && last.current.batch.revision > view.detail.batch.revision ? last.current : view?.detail;
    const current = detail?.batch ?? batch;
    const items = detail?.items ?? [];
    const edits = local?.edits ?? items.map(item => ({id: item.id, draft: item.draft, included: item.included}));
    const included = edits.filter(item => item.included);
    const draft = current.status === "draft";
    const jobs = detail?.jobs ?? [];
    const queued = items.filter(item => item.state === "queued").length;
    const downloaded = jobs.filter(job => job.result).length;
    const active = jobs.filter(job => WORKING.has(job.status)).length;
    const failed = jobs.filter(job => job.status === "failed").length;
    const unknown = jobs.some(job => job.status === "unknown");
    const blocked = pending || !detail || Boolean(view?.error) || parentReadError || Boolean(view?.readOnly);
    const groups = [...new Set(items.map(item => item.targetKey))];
    const chosenTarget = targetKey && groups.includes(targetKey) ? targetKey : groups[0];
    const groupItems = items.filter(item => item.targetKey === chosenTarget);
    const selectedCount = Object.keys(current.selections).length;
    const appliedCount = items.filter(item => {
        const job = jobs.find(candidate => candidate.id === item.jobId);
        return job?.result && detail?.currentMedia[item.targetKey] === job.result.mediaId;
    }).length;
    const portalRoot = typeof document !== "undefined" ? document.querySelector<HTMLElement>(".agent-chat-root") ?? document.body : undefined;

    // Something needs the user: a draft to confirm, or results nobody has looked at. Offered once, without taking focus.
    const autoKey = draft ? `batch:${current.id}:draft`
        : current.status === "settled" && downloaded > 0 && selectedCount === 0 ? `batch:${current.id}:results` : undefined;
    const panelOpenChange = useAutoOpenPanel({key: autoKey, ready: Boolean(autoKey && detail && !view?.readOnly), open, width: 520, setOpen});

    const blocker = useBlocker({
        shouldBlockFn: () => Boolean(local) || pendingRef.current,
        withResolver: true,
        enableBeforeUnload: Boolean(local) || pending,
    });

    function edit(item: GenerationBatchItem, patch: Partial<Pick<DraftEdit, "draft" | "included">>) {
        setLocal(value => ({
            revision: value?.revision ?? current.revision,
            edits: (value?.edits ?? edits).map(row => row.id === item.id ? {...row, ...patch} : row)
        }));
        setError(undefined);
        setNotice(undefined);
    }

    async function persist() {
        if (!local) return current.revision;
        const saved = await saveGenerationBatchDraft(current.id, current.threadId, local.revision, local.edits);
        setLocal(null);
        setNotice("草稿已保存");
        // Keep the acknowledged values visible until the live query catches up.
        if (last.current) last.current = {
            ...last.current,
            batch: saved,
            items: last.current.items.map(item => ({...item, ...local.edits.find(row => row.id === item.id)}))
        };
        return saved.revision;
    }

    async function action(work: () => Promise<unknown>) {
        if (pendingRef.current || blocked) return;
        pendingRef.current = true;
        setPending(true);
        setError(undefined);
        setNotice(undefined);
        try {
            await work();
        } catch (cause) {
            setError(message(cause));
        } finally {
            pendingRef.current = false;
            setPending(false);
        }
    }

    function start() {
        setError(undefined);
        void startGenerationBatch(current.id, current.threadId).catch(cause => setError(message(cause)));
    }

    async function confirm() {
        await batchUserAction(current.id, async () => {
            const revision = await persist();
            await confirmGenerationBatch(current.id, current.threadId, revision, new AbortController().signal);
        });
        start();
    }

    async function change(itemId: string, operation: "clone" | "remove") {
        await batchUserAction(current.id, async () => {
            const revision = await persist();
            await changeGenerationBatchItems(current.id, current.threadId, revision, itemId, operation);
        });
    }

    /** A departure (close, or another panel taking over) is refused while the review holds unsaved or in-flight work. */
    function requestDeparture(proceed: () => void, cancel?: () => void) {
        // Opening a target's detail from here keeps the edits, so it is always allowed.
        if (handoffRef.current) {proceed(); return;}
        if (local || pending) {
            setError(local ? "还有未保存的编辑，请先保存草稿，或放弃本地编辑后关闭。" : "正在保存，请稍候再关闭。");
            cancel?.();
            return;
        }
        proceed();
    }

    const endOrigin: DetailReturnOrigin["onEnd"] = event => {
        const current = handoffRef.current;
        if (!current || current.token !== event.token || (current.requestId && current.requestId !== event.requestId)) return;
        finishHandoff(event.token, event.reason !== "replaced");
    };

    function activateTarget(event: MouseEvent<HTMLAnchorElement>, target: ProductionTarget) {
        if (!openDetail || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey
            || event.altKey || event.currentTarget.hasAttribute("download") || inspecting) return;
        const parsed = readBusinessDetailTarget(event.currentTarget.getAttribute("href") ?? "");
        if (!parsed || !matchesProductionTarget(parsed, target) || !bodyRef.current) return;
        event.preventDefault();
        if (handoffRef.current) return;
        const source: ReviewHandoff = {
            token: `${session}-review-${++sequence.current}`,
            target: parsed,
            bookmark: captureReviewBookmark(bodyRef.current, event.currentTarget),
            phase: "opening",
        };
        handoffRef.current = source;
        // The detail is a panel too: it takes this panel's place, and ending it brings the review back.
        void openDetail(parsed, {origin: {token: source.token, label: "返回批量审阅", onEnd: endOrigin}}).then(result => {
            if (!alive.current || handoffRef.current !== source) return;
            if (result.status === "refused") {handoffRef.current = null; return;}
            source.phase = "opened";
            source.requestId = result.requestId;
            if (source.returnRequested && returnToOrigin) void returnToOrigin(source.token).then(outcome => {
                if (outcome === "stale") finishHandoff(source.token, true);
            });
        }, () => {
            if (alive.current && handoffRef.current === source) {
                setError("无法打开目标详情，批次编辑已保留。");
                handoffRef.current = null;
            }
        });
    }

    return <section className="agent-batch" aria-label={current.title}>
        <div className="agent-batch-strip">
            <Images size={18} aria-hidden/>
            <div className="agent-batch-strip-copy">
                <strong>{current.title}</strong><span>{groups.length} 个目标 · {draft ? `${included.length} 次生成待确认` : `${downloaded}/${current.confirmedItemIds.length} 份已保存`}</span>
            </div>
            <span className="agent-batch-state"
                  data-attention={unknown || current.status === "paused"}>{current.status === "running" &&
                <LoaderCircle size={12} className="animate-spin motion-reduce:animate-none"
                              aria-hidden/>}{BATCH_LABELS[current.status]}</span>
            <button ref={triggerRef} type="button" className="agent-batch-open"
                    aria-label={`打开批量生成：${current.title}`} onClick={revealReview}>打开<ChevronRight
                size={14} aria-hidden/></button>
        </div>
        {retainedNotice && !open && <p className="agent-batch-error" role="status">{retainedNotice}</p>}
        {view?.error && !parentReadError && !open && <p className="agent-batch-error" role="alert">读取失败，当前内容已保留
            <button type="button" title={view.error} onClick={() => setReadAttempt(value => value + 1)}>重试</button>
        </p>}
        <ContextPanel kind="batch-review" title="批量生成" open={open} width={520} onOpenChange={panelOpenChange}
                      onRequestDeparture={requestDeparture}>
            <ContextPanelContent className="agent-batch-dialog" onOpenAutoFocus={event => {
                const bookmark = restoreBookmark.current;
                if (bookmark && bodyRef.current) {
                    event.preventDefault();
                    restoreBookmark.current = null;
                    restoreReviewBookmark(bodyRef.current, bookmark);
                }
            }} onCloseAutoFocus={event => {
                event.preventDefault();
                if (!handoffRef.current && alive.current) triggerRef.current?.focus({preventScroll: true});
            }}>
                    <ContextPanelHeader className="agent-batch-header">
                        <div><span
                            className="agent-batch-eyebrow">批量生成 · {BATCH_LABELS[current.status]}</span><ContextPanelTitle>{current.title}</ContextPanelTitle>
                            <ContextPanelDescription>{draft ? `逐项检查配置，每个目标最多 ${BATCH_TARGET_LIMIT} 份候选，每批最多 ${BATCH_REQUEST_LIMIT} 份。` : "按目标比较候选。选择后点击写入，其他结果仍会保留。"}</ContextPanelDescription>
                        </div>
                    </ContextPanelHeader>
                    <div ref={bodyRef} className="agent-batch-body">
                        {(view?.error || parentReadError) &&
                            <p role="alert" className="agent-batch-error">读取失败，当前内容已保留
                                <button type="button" title={view?.error} onClick={() => setReadAttempt(value => value + 1)}>重试
                                </button>
                            </p>}
                        {view?.readOnly && !view.error &&
                            <p className="agent-batch-note">任务已关闭，重新打开任务后可以继续编辑和选用。</p>}
                        {!detail && !view?.error && <p className="agent-batch-note">正在读取候选…</p>}
                        {draft ? <>
                            <div className="agent-batch-review-heading">
                                <span>目标与候选</span><span>{items.length}/{BATCH_REQUEST_LIMIT} 份 · {included.length} 份将提交</span>
                            </div>
                            {items.map(item => {
                                const value = edits.find(row => row.id === item.id) ?? item;
                                const siblings = items.filter(row => row.targetKey === item.targetKey);
                                const letter = String.fromCharCode(65 + siblings.findIndex(row => row.id === item.id));
                                return <div className="agent-batch-draft-row" key={item.id}
                                            data-batch-item-id={item.id}
                                            data-included={value.included}>
                                    <div className="agent-batch-row-summary">
                                        <label className="agent-batch-include"><input type="checkbox"
                                                                                      checked={value.included}
                                                                                      disabled={blocked}
                                                                                      onChange={event => edit(item, {included: event.target.checked})}
                                                                                      aria-label={`生成 ${targetLabel(item)} 候选 ${letter}`}/><span
                                            className="sr-only">生成此候选</span></label>
                                        <button className="agent-batch-config-toggle" type="button"
                                                aria-expanded={expanded === item.id}
                                                aria-controls={`batch-fields-${item.id}`}
                                                onClick={() => setExpanded(expanded === item.id ? undefined : item.id)}>
                                            <strong>{targetLabel(item)}<span
                                                className="agent-batch-letter">候选 {letter}</span></strong><BatchConfigurationSummary
                                            draft={value.draft}/>
                                        </button>
                                        <div className="agent-batch-row-actions">
                                            <button type="button" className="agent-batch-icon" title="增加一份候选"
                                                    aria-label={`复制 ${targetLabel(item)} 候选 ${letter}`}
                                                    disabled={blocked || siblings.length >= BATCH_TARGET_LIMIT || items.length >= BATCH_REQUEST_LIMIT}
                                                    onClick={() => void action(() => change(item.id, "clone"))}><Copy
                                                size={16} aria-hidden/></button>
                                            <button type="button" className="agent-batch-icon" title="移除候选"
                                                    aria-label={`移除 ${targetLabel(item)} 候选 ${letter}`}
                                                    disabled={blocked || items.length <= 1}
                                                    onClick={() => void action(() => change(item.id, "remove"))}><Trash2
                                                size={16} aria-hidden/></button>
                                            <ChevronRight size={16}
                                                          className={expanded === item.id ? "agent-batch-chevron-open" : ""}
                                                          aria-hidden/></div>
                                    </div>
                                    {expanded === item.id &&
                                        <div id={`batch-fields-${item.id}`} className="agent-batch-fields">
                                            <Link {...generationTargetDestination(item.baseline.target)}
                                                  onClick={event => activateTarget(event, item.baseline.target)}
                                                  className="agent-batch-target">查看目标
                                                · {targetLabel(item)}<ArrowUpRight size={14} aria-hidden/></Link>
                                            <BatchConfigurationFields draft={value.draft}
                                                                      onChange={(next: GenerationSubmitArgs) => edit(item, {draft: next})}
                                                                      disabled={blocked}/>
                                            <BatchReferences inputs={value.draft.inputs}/><p
                                            className="agent-batch-note">目标和参考素材固定于本次提案。每份候选分别提交一次。</p>
                                        </div>}
                                </div>;
                            })}
                        </> : <>
                            <div className="agent-batch-metrics" role="status"><span><strong>{downloaded}</strong> 已保存</span><span><strong>{active}</strong> 处理中</span><span><strong>{queued}</strong> 排队</span>{failed > 0 &&
                                <span><strong>{failed}</strong> 失败</span>}<span><strong>{appliedCount}</strong> 当前已写入</span>
                            </div>
                            {current.pauseReason && <p className="agent-batch-note">{current.pauseReason}</p>}
                            {unknown && <p className="agent-batch-warning"><CircleAlert size={16} aria-hidden/>有请求提交未确认，已暂停后续发送。请先在供应商处确认；其他任务可继续查询。
                            </p>}
                            <div className="agent-batch-targets" aria-label="选择比较目标">{groups.map(key => {
                                const group = items.filter(item => item.targetKey === key),
                                    label = targetLabel(group[0]);
                                return <button key={key} type="button" aria-pressed={chosenTarget === key}
                                               onClick={() => setTargetKey(key)}>{label}<span>{group.length} 份</span>
                                </button>;
                            })}</div>
                            {groupItems.length > 0 && <div className="agent-batch-comparison-heading">
                                <strong>{targetLabel(groupItems[0])}</strong><Link {...generationTargetDestination(groupItems[0].baseline.target)} onClick={event => activateTarget(event, groupItems[0].baseline.target)}>查看目标<ArrowUpRight
                                size={14} aria-hidden/></Link></div>}
                            <div className="agent-batch-candidates"
                                 data-video={groupItems.some(item => generationKind(item.draft.target) === "video")}>
                                {groupItems.map((item, index) => {
                                    const job = jobs.find(row => row.id === item.jobId),
                                        selected = current.selections[item.targetKey] === item.id;
                                    const applied = Boolean(job?.result && detail?.currentMedia[item.targetKey] === job.result.mediaId);
                                    const previous = current.applications.some(row => row.itemId === item.id) && !applied;
                                    const letter = String.fromCharCode(65 + index);
                                    return <article key={item.id} className="agent-batch-candidate"
                                                    data-selected={selected}>
                                        <div className="agent-batch-candidate-heading">
                                            <strong>候选 {letter}</strong>{applied ?
                                            <span className="agent-batch-applied"><Check size={12} aria-hidden/>当前已写入</span> : previous ?
                                                <span>已被替换</span> : selected ? <span>已选中</span> : null}</div>
                                        {job?.result ? <CandidateMedia mediaId={job.result.mediaId}
                                                                       label={`${targetLabel(item)} · 候选 ${letter}`}
                                                                       portalRoot={portalRoot}
                                                                       onInspectChange={setInspecting}/> : <div
                                            className="agent-batch-candidate-status">{job && WORKING.has(job.status) ?
                                            <LoaderCircle size={20} className="animate-spin motion-reduce:animate-none"
                                                          aria-hidden/> : job?.status === "failed" || job?.status === "unknown" ?
                                                <CircleAlert size={20}
                                                             aria-hidden/> : null}<span>{itemStatus(item, job)}</span>
                                        </div>}
                                        <BatchConfigurationSummary draft={item.draft}/>
                                        <p className="agent-batch-note">{itemStatus(item, job)}{job && WORKING.has(job.status) && typeof job.progress === "number" && job.progress >= 0 && job.progress <= 100 ? ` · ${job.progress}%` : ""}</p>
                                        {job?.error && <p className="agent-batch-error">{job.error}</p>}
                                        <details className="agent-batch-configuration">
                                            <summary>查看生成配置</summary>
                                            <p>{item.draft.prompt}</p>
                                            <dl>{Object.entries(item.snapshot?.parameters ?? item.draft.parameters).filter(([key]) => key !== "prompt").map(([key, value]) =>
                                                <div key={key}>
                                                    <dt>{key}</dt>
                                                    <dd>{String(value)}</dd>
                                                </div>)}</dl>
                                            <BatchReferences inputs={item.draft.inputs}/></details>
                                        {job?.result && <Button size="sm" variant={selected ? "secondary" : "outline"}
                                                                disabled={blocked || selected}
                                                                aria-label={`选择候选 ${letter}：${targetLabel(item)}`}
                                                                onClick={() => void action(() => batchUserAction(current.id, () => selectBatchCandidate(current.id, current.threadId, item.id)))}>{selected &&
                                            <Check size={14} aria-hidden/>}{selected ? "已选中" : "选择候选"}</Button>}
                                    </article>;
                                })}
                            </div>
                            {outcomes.length > 0 &&
                                <ul className="agent-batch-outcomes" aria-live="polite">{outcomes.map(outcome => <li
                                    key={outcome.targetKey}
                                    className={outcome.applied ? "" : "agent-batch-error"}>{items.find(item => item.targetKey === outcome.targetKey) ? targetLabel(items.find(item => item.targetKey === outcome.targetKey)!) : outcome.targetKey}：{outcome.applied ? "已写入" : outcome.error}</li>)}</ul>}
                        </>}
                        {error && blocker.status !== "blocked" && <p className="agent-batch-error" role="alert">{error}</p>}
                        {notice && <p className="agent-batch-note" role="status">{notice}</p>}
                    </div>
                    <ContextPanelFooter className="agent-batch-footer">
                        {draft ? <>
                            <div className="agent-batch-cost"><strong>{included.length} 次生成 ·
                                同时处理 {BATCH_CONCURRENCY} 份</strong><span>确认后向所选供应商提交，可能产生费用。每份候选独立计费。</span>
                            </div>
                            <div className="agent-batch-footer-actions"><Button size="sm" variant="ghost"
                                                                                disabled={blocked}
                                                                                onClick={() => void action(async () => {
                                                                                    await stopGenerationBatch(current.id, current.threadId, "cancel");
                                                                                    setLocal(null);
                                                                                })}>放弃批次</Button>
                                {local && <button type="button" className="agent-batch-text-action" disabled={pending}
                                                  onClick={() => {
                                                      setLocal(null);
                                                      setError(undefined);
                                                  }}>放弃本地编辑</button>}
                                <Button size="sm" variant="secondary" disabled={blocked || !local}
                                        onClick={() => void action(() => batchUserAction(current.id, persist))}>{pending ? "保存中…" : local ? "保存草稿" : "草稿已保存"}</Button>
                                <Button size="sm"
                                        disabled={blocked || included.length === 0 || included.length > BATCH_REQUEST_LIMIT}
                                        onClick={() => void action(confirm)}>确认生成 {included.length} 份</Button>
                            </div>
                        </> : <>
                            <p className="agent-batch-note">{selectedCount} 个目标已选候选。写入会检查目标是否被修改；取消剩余仅阻止尚未发送的请求。</p>
                            <div className="agent-batch-footer-actions">
                                {current.status === "running" ? <Button size="sm" variant="secondary" disabled={blocked}
                                                                        onClick={() => void action(() => stopGenerationBatch(current.id, current.threadId, "pause"))}><Pause
                                    size={14} aria-hidden/>暂停队列</Button> : (queued > 0 || active > 0) &&
                                    <Button size="sm" variant="secondary" disabled={blocked} onClick={start}><Play
                                        size={14}
                                        aria-hidden/>{unknown || current.status === "cancelled" ? "查询进度" : "继续处理"}
                                    </Button>}
                                {queued > 0 && <Button size="sm" variant="ghost" disabled={blocked}
                                                       onClick={() => void action(() => stopGenerationBatch(current.id, current.threadId, "cancel"))}>取消剩余 {queued} 份</Button>}
                                {failed > 0 && <Button size="sm" variant="ghost" disabled={blocked}
                                                       onClick={() => void action(async () => {
                                                           await batchUserAction(current.id, () => retryFailedBatch(current.id, current.threadId));
                                                           setNotice("已创建失败项目的新草稿，请关闭后打开重试批次，检查并重新确认费用。");
                                                       })}>为失败项新建草稿</Button>}
                                <Button size="sm" disabled={blocked || selectedCount === 0}
                                        onClick={() => void action(async () => {
                                            const result = await batchUserAction(current.id, () => applyBatchSelections(current.id, current.threadId));
                                            setOutcomes(result);
                                            // The adoption queued a continuation for the agent; start it now if the conversation is free.
                                            if (result.some(item => item.applied)) void agentExecution.drainQueue(current.threadId).catch(() => undefined);
                                        })}>写入选中的 {selectedCount} 个目标</Button>
                            </div>
                        </>}
                    </ContextPanelFooter>
            </ContextPanelContent>
        </ContextPanel>
        <AlertDialog open={blocker.status === "blocked"} onOpenChange={next => {
            if (!next && !pending) blocker.reset?.();
        }}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>离开前处理批次编辑</AlertDialogTitle>
                    <AlertDialogDescription>{pending ? "操作正在进行，请等待完成后再离开。" : "当前批次有未保存的编辑。保存草稿只会保留配置，不会开始生成。"}</AlertDialogDescription>
                </AlertDialogHeader>
                {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
                <AlertDialogFooter>
                    <AlertDialogCancel asChild onClick={event => event.preventDefault()}><Button variant="ghost"
                                                                                                 disabled={pending}
                                                                                                 onClick={() => blocker.reset?.()}>继续编辑</Button></AlertDialogCancel>
                    <Button variant="outline" disabled={pending} onClick={() => {
                        setLocal(null);
                        blocker.proceed?.();
                    }}>放弃编辑并离开</Button>
                    <Button disabled={blocked} onClick={() => void action(async () => {
                        await batchUserAction(current.id, persist);
                        blocker.proceed?.();
                    })}>保存草稿并离开</Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    </section>;
}

function CandidateMedia({mediaId, label, portalRoot, onInspectChange}: {
    mediaId: string;
    label: string;
    portalRoot?: HTMLElement;
    onInspectChange: (open: boolean) => void
}) {
    const [open, setOpen] = useState(false);
    const changeOpen = (next: boolean) => {
        setOpen(next);
        onInspectChange(next);
    };
    useEffect(() => {
        if (!open) return;
        // Handle the top preview before document-level dismiss listeners. Portalled
        // nested layers can register in either order after their parent rerenders.
        const escape = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopImmediatePropagation();
            setOpen(false);
            onInspectChange(false);
        };
        window.addEventListener("keydown", escape, true);
        return () => window.removeEventListener("keydown", escape, true);
    }, [open, onInspectChange]);
    return <div className="agent-batch-media-wrap"><MediaPreview mediaId={mediaId} inspect label={label}
                                                                 className="agent-batch-media"/>
        <DialogPrimitive.Root open={open} onOpenChange={changeOpen}><DialogPrimitive.Trigger asChild>
            <button type="button" className="agent-batch-inspect" aria-label={`放大查看 ${label}`}><Maximize2 size={14}
                                                                                                              aria-hidden/><span>放大</span>
            </button>
        </DialogPrimitive.Trigger>
            <DialogPrimitive.Portal container={portalRoot}><DialogPrimitive.Overlay
                className="agent-batch-overlay agent-batch-inspect-overlay"/><DialogPrimitive.Content
                className="agent-batch-inspection" onEscapeKeyDown={event => {
                // Escape listeners share the document. Prevent Radix default dismissal and
                // stop sibling listeners before closing only this controlled preview.
                event.preventDefault();
                event.stopImmediatePropagation();
                changeOpen(false);
            }}>
                <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title><DialogPrimitive.Description
                className="sr-only">查看完整生成素材</DialogPrimitive.Description>
                <MediaPreview mediaId={mediaId} inspect label={label}
                              className="agent-batch-full-media"/><DialogPrimitive.Close asChild>
                <button type="button" className="agent-batch-inspection-close" aria-label="关闭素材预览"><X size={20}
                                                                                                            aria-hidden/>
                </button>
            </DialogPrimitive.Close>
            </DialogPrimitive.Content></DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    </div>;
}

function BatchReferences({inputs}: { inputs: GenerationSubmitArgs["inputs"] }) {
    const identity = inputs.map(input => `${input.role}:${input.mediaId}`).join("|");
    const names = useProductQuery(async (db) => {
        try {
            const media = await db.media.bulkGet(inputs.map(input => input.mediaId));
            return {identity, labels: media.map((item, index) => item?.filename || inputs[index].mediaId)};
        } catch {
            return {identity, labels: inputs.map(input => input.mediaId)};
        }
    }, [identity]);
    const roles = {
        "first-frame": "首帧",
        "last-frame": "尾帧",
        "reference-image": "参考图",
        "reference-video": "参考视频"
    };
    if (!inputs.length) return <p className="agent-batch-note">文字生成 · 无参考素材</p>;
    return <ul className="agent-batch-references" aria-label="固定参考素材">{inputs.map((input, index) => <li
        key={`${input.role}:${input.mediaId}`}><span>{roles[input.role]}</span><span
        title={input.mediaId}>{names?.identity === identity ? names.labels[index] : input.mediaId}</span></li>)}</ul>;
}

function BatchConfigurationSummary({draft}: { draft: GenerationSubmitArgs }) {
    const connector = useProductQuery(async (db) => {
        try {
            const row = await resolveConnector(draft.connectorId, db);
            return {
                id: draft.connectorId,
                label: row ? `${row.definitionId === "apimart" ? "APIMart" : row.definitionId === "aihubmix" ? "AIHubMix" : row.definitionId}${row.label ? ` · ${row.label}` : ""}` : "连接已不可用"
            };
        } catch {
            return {id: draft.connectorId, label: "连接读取失败"};
        }
    }, [draft.connectorId]);
    const p = draft.parameters;
    const parameters = [p.size, p.resolution, p.aspectRatio, p.duration === undefined ? undefined : `${p.duration} 秒`, p.quality, p.version].filter(Boolean);
    return <span
        className="agent-batch-config-summary">{connector?.id === draft.connectorId ? connector.label : "读取连接…"} · {draft.model}{parameters.length ? ` · ${parameters.join(" / ")}` : " · 模型默认参数"} · {draft.inputs.length} 份参考</span>;
}

function BatchConfigurationFields({draft, onChange, disabled}: {
    draft: GenerationSubmitArgs;
    onChange: (draft: GenerationSubmitArgs) => void;
    disabled: boolean
}) {
    const state = useProductQuery(async (db) => {
        try {
            const connectors = await db.connectors.toArray();
            const preferences = await getGenerationPreferenceState(db);
            const project = await db.projects.get(draft.target.projectId);
            return {
                projectId: draft.target.projectId,
                connectors,
                preferences,
                project,
                error: undefined as string | undefined
            };
        } catch (cause) {
            return {
                projectId: draft.target.projectId,
                connectors: [],
                preferences: undefined,
                project: undefined,
                error: message(cause)
            };
        }
    }, [draft.target.projectId]);
    const available = state?.projectId === draft.target.projectId ? state : undefined;
    const recommendation = available && !available.error ? recommendGenerationSelection({
        kind: generationKind(draft.target),
        connectors: available.connectors,
        projectDefaults: available.project?.generationDefaults,
        preferences: available.preferences?.preferences,
        preferenceIssues: available.preferences?.issues
    }) : undefined;
    let validation: string | undefined;
    try {
        if (!available) throw new Error("正在读取生成配置…");
        if (available.error) throw new Error(available.error);
        const connector = available.connectors.find(item => item.id === draft.connectorId);
        if (!connector?.apiKey.trim() || connector.definitionId !== "apimart" && connector.definitionId !== "aihubmix") throw new Error("请选择已配置密钥的生成连接。");
        profileRequest(generationSubmitSchema.parse(draft), connector.definitionId);
    } catch (cause) {
        validation = cause instanceof Error && cause.name !== "ZodError" ? cause.message : "请检查画面描述与生成参数。";
    }
    return <div className="agent-batch-shared-fields">
        {recommendation && ["project", "global"].includes(recommendation.source) &&
            <div className="agent-generation-default">
                <span>{recommendation.status === "ready" ? `${recommendation.source === "project" ? "项目" : "我的"}默认 · ${recommendation.recommendation?.model}` : recommendation.issues.join("；")}</span>{recommendation.recommendation &&
                <button type="button" disabled={disabled} onClick={() => {
                    const choice = recommendation.recommendation!;
                    const provider = available?.connectors.find(item => item.id === choice.connectorId)?.definitionId;
                    if (provider === "apimart" || provider === "aihubmix") onChange(applyGenerationSelection(draft, choice, provider));
                }}>应用默认</button>}</div>}
        <GenerationConfigurationFields draft={draft} onChange={onChange} disabled={disabled}/>
        {validation && <p role="alert" className="agent-batch-error">{validation}</p>}
    </div>;
}
