import {useEffect, useMemo, useRef, useState} from "react";
import type {AudioProjectSnapshot} from "../models/audio";
import {AudioArrangementConflictError, type AudioArrangementProposal} from "../models/audioArrangement";
import {AudioClipHistory} from "../engine/commands";
import {
    applyAudioArrangementProposal,
    previewAudioArrangement,
    previewAudioSelection,
    saveAudioArrangementProposal
} from "../commands/arrangement";
import {flushPendingDrafts} from "../../../platform/product/drafts";
import {Button} from "../../../ui/button";
import {Checkbox} from "../../../ui/checkbox";
import {Input} from "../../../ui/input";
import {SidePanel} from "../../../app/layout/SidePanel";
import {Field} from "../presentation/shared";
import {SelectOption, WorkspaceSelect} from "../presentation/controls";

export function AudioArrangementActions({projectId, chapterId, snapshot, history}: {
    projectId: string;
    chapterId: string;
    snapshot: AudioProjectSnapshot;
    history?: AudioClipHistory
}) {
    const localHistory = useMemo(() => new AudioClipHistory(projectId, chapterId), [projectId, chapterId]);
    const clipHistory = history ?? localHistory;
    const [mode, setMode] = useState<"selection" | "arrangement">();
    const [choices, setChoices] = useState<Record<string, string>>({});
    const [included, setIncluded] = useState<string[]>([]);
    const [page, setPage] = useState(0);
    const [trackId, setTrackId] = useState("");
    const [gap, setGap] = useState("0"), [start, setStart] = useState("");
    const [proposal, setProposal] = useState<AudioArrangementProposal>();
    const [conflicted, setConflicted] = useState(false);
    const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
    const lock = useRef(false), epoch = useRef(0), mounted = useRef(false);
    const trigger = useRef<HTMLButtonElement | null>(null);
    const controller = useRef<AbortController | undefined>(undefined);
    const segments = snapshot.segments.filter(row => row.chapterId === chapterId).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const tracks = snapshot.tracks.filter(row => row.chapterId === chapterId && row.role === "voice");
    const pageSegments = segments.slice(page * 20, (page + 1) * 20);
    useEffect(() => {
        mounted.current = true;
        epoch.current++;
        const ownership = mounted, cancellationEpoch = epoch, pendingController = controller;
        setMode(undefined);
        setProposal(undefined);
        setError("");
        setNotice("");
        return () => {
            ownership.current = false;
            cancellationEpoch.current++;
            pendingController.current?.abort();
        };
    }, [projectId, chapterId]);

    async function action(operation: (signal: AbortSignal) => Promise<void>) {
        if (lock.current) return;
        const token = epoch.current;
        const current = new AbortController();
        controller.current = current;
        lock.current = true;
        setBusy(true);
        setError("");
        try {
            await operation(current.signal);
        } catch (cause) {
            if (epoch.current === token) {
                setError(cause instanceof Error ? cause.message : "操作失败，请重试");
                if (proposal && cause instanceof AudioArrangementConflictError) setConflicted(true);
            }
        } finally {
            if (controller.current === current) {
                lock.current = false;
                controller.current = undefined;
                if (mounted.current) setBusy(false);
            }
        }
    }

    function open(next: "selection" | "arrangement") {
        const candidates = segments.slice(0, 20);
        setMode(next);
        setPage(0);
        setError("");
        setConflicted(false);
        setProposal(undefined);
        setChoices(Object.fromEntries(segments.filter(row => row.selectedTakeId).map(row => [row.id, row.selectedTakeId!])));
        setIncluded(next === "arrangement" ? candidates.filter(row => row.selectedTakeId).map(row => row.id) : candidates.map(row => row.id));
        setTrackId(tracks[0]?.id ?? "");
        setGap("0");
        setStart("");
    }

    function changePage(next: number) {
        setPage(next);
        const rows = segments.slice(next * 20, (next + 1) * 20);
        setIncluded(mode === "arrangement" ? rows.filter(row => row.selectedTakeId).map(row => row.id) : rows.map(row => row.id));
        setError("");
    }

    async function prepare(signal: AbortSignal) {
        const token = epoch.current;
        await flushPendingDrafts(projectId);
        signal.throwIfAborted();
        const selected = segments.filter(row => included.includes(row.id));
        const next = mode === "selection" ? await previewAudioSelection(projectId, chapterId, selected.map(segment => {
            const take = snapshot.takes.find(row => row.id === choices[segment.id]);
            if (!take) throw new Error("请为每个勾选段落明确选择声音版本");
            return {
                segmentId: segment.id,
                segmentRevision: segment.revision,
                takeId: take.id,
                takeRevision: take.revision
            };
        })) : await previewAudioArrangement(projectId, chapterId, {
            segmentIds: selected.map(row => row.id),
            trackId,
            gapSec: Number(gap), ...(start.trim() ? {startSec: Number(start)} : {})
        });
        signal.throwIfAborted();
        await saveAudioArrangementProposal(next);
        if (epoch.current === token) setProposal(next);
    }

    async function apply(signal: AbortSignal) {
        if (!proposal) return;
        const token = epoch.current;
        const operation = () => applyAudioArrangementProposal(projectId, proposal.id, proposal.revision, {type: "manual"}, signal);
        const receipt = proposal.kind === "arrangement" ? await clipHistory.applyArrangement(operation) : await operation();
        if (epoch.current !== token) return;
        setNotice(proposal.kind === "selection" ? `已更新 ${receipt.selected.length} 段选用，未改变时间线。` : `新增 ${receipt.added.length} 个片段；保留 ${receipt.preserved} 段已有剪辑（其中 ${receipt.conflicts} 段需手动检查）。此操作未核验试听效果。`);
        setMode(undefined);
        setProposal(undefined);
    }

    const adding = proposal?.items.filter(row => row.status === "add").length ?? 0;
    return <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Button size="sm" variant="ghost" disabled={busy || !segments.length} onClick={event => {
            trigger.current = event.currentTarget;
            open("selection");
        }}>批量选用</Button>
        <Button size="sm" variant="ghost" disabled={busy || !segments.some(row => row.selectedTakeId)}
                onClick={event => {
                    trigger.current = event.currentTarget;
                    open("arrangement");
                }}>排列已选声音</Button>
        {clipHistory.canUndo &&
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(async () => {
                await clipHistory.undo();
                setNotice("已撤销时间线操作，选用和源声音保持不变。");
            })}>撤销时间线操作</Button>}
        {notice && <p role="status" className="basis-full text-xs text-muted-foreground break-words">{notice}</p>}
        {!mode && error && <p role="alert" className="basis-full text-xs text-destructive break-words">{error}</p>}
        <SidePanel open={Boolean(mode)} kind="audio-arrangement" width={520}
                   onOpenChange={value => {
                       if (!value && !lock.current) {
                           setMode(undefined);
                           setProposal(undefined);
                       }
                   }}
                   title={mode === "selection" ? "批量选用配音版本" : "排列已选声音"}
                   description={`${mode === "selection" ? "选择声音版本并预览，只改变选用，不放入时间线。" : "按真实时长追加未放置的声音；已有剪辑全部保留。"}此操作未核验试听效果，请自行试听。`}
                   footer={<>
                       <Button variant="outline" disabled={busy} onClick={() => {
                           if (proposal) {
                               setProposal(undefined);
                               setError("");
                               setConflicted(false);
                           } else setMode(undefined);
                       }}>{proposal ? "重新预览" : "取消"}</Button>
                       <Button disabled={busy || !included.length || conflicted}
                               onClick={() => void action(proposal ? apply : prepare)}>{busy ? "正在保存…" : proposal ? "确认应用" : "查看预览"}</Button>
                   </>}>
                <div className="min-w-0">
                    {!proposal ? <div className="grid min-w-0 gap-3">
                        {mode === "arrangement" && <div className="grid gap-3 sm:grid-cols-3">
                            <Field label="人声音轨"><WorkspaceSelect aria-label="排列目标人声音轨" disabled={busy}
                                                                     value={trackId}
                                                                     onValueChange={setTrackId}>{tracks.map(track =>
                                <SelectOption key={track.id}
                                              value={track.id}>{track.name}</SelectOption>)}</WorkspaceSelect></Field>
                            <Field label="段间空隙（秒）"><Input disabled={busy} type="number" min={0} max={300}
                                                               step={.01} value={gap}
                                                               onChange={event => setGap(event.target.value)}/></Field>
                            <Field label="起点（留空追加）"><Input disabled={busy} type="number" min={0} max={86400}
                                                                 step={.01} value={start}
                                                                 onChange={event => setStart(event.target.value)}/></Field>
                        </div>}
                        <p className="text-xs text-muted-foreground">每次最多 20
                            段。已勾选 {included.length} 段{segments.length > 20 ? `；当前第 ${page + 1} 页，共 ${segments.length} 段。` : "。"}</p>
                        {pageSegments.map(segment => <div key={segment.id}
                                                          className="grid min-w-0 gap-2 border-b py-2 sm:grid-cols-[1fr_220px]">
                            <label className="flex min-w-0 items-start gap-2 text-sm"><Checkbox disabled={busy}
                                                                                                aria-label={`包含段落 ${segment.text.slice(0, 60)}`}
                                                                                                checked={included.includes(segment.id)}
                                                                                                onCheckedChange={checked => setIncluded(checked === true ? [...included, segment.id] : included.filter(id => id !== segment.id))}/><span
                                className="min-w-0 break-words">{segment.text || "空段落"}</span></label>
                            {mode === "selection" ?
                                <WorkspaceSelect aria-label={`段落 ${segment.text.slice(0, 60)} 选用版本`}
                                                 disabled={busy} value={choices[segment.id] ?? "none"}
                                                 onValueChange={value => setChoices({...choices, [segment.id]: value})}><SelectOption
                                    value="none">请选择声音版本</SelectOption>{snapshot.takes.filter(take => take.segmentId === segment.id).map(take =>
                                    <SelectOption key={take.id}
                                                  value={take.id}>{take.name} · {take.durationSec.toFixed(3)} 秒</SelectOption>)}
                                </WorkspaceSelect> : <span
                                    className="text-xs text-muted-foreground break-words">{snapshot.takes.find(row => row.id === segment.selectedTakeId)?.name ?? "尚未选用"}</span>}
                        </div>)}
                        {segments.length > 20 && <div className="flex gap-2"><Button size="sm" variant="outline"
                                                                                     disabled={busy || page === 0}
                                                                                     onClick={() => changePage(page - 1)}>上一页</Button><Button
                            size="sm" variant="outline" disabled={busy || (page + 1) * 20 >= segments.length}
                            onClick={() => changePage(page + 1)}>下一页</Button><span
                            className="text-xs text-muted-foreground">翻页重新选择本页段落</span></div>}
                    </div> : <div className="grid min-w-0 gap-3">
                        {proposal.request &&
                            <p className="text-xs text-muted-foreground break-all">目标音轨 {proposal.request.trackId} ·
                                段间空隙 {proposal.request.gapSec ?? 0} 秒
                                · {proposal.request.startSec === undefined ? "追加到原音轨末尾" : `从 ${proposal.request.startSec} 秒开始`}</p>}
                        <p className="text-sm">{proposal.kind === "selection" ? `确认选用 ${proposal.selections.length} 段；不新增片段。` : `确认新增 ${adding} 段；保留 ${proposal.items.length - adding} 段，其中 ${proposal.items.filter(row => row.status === "manual_conflict").length} 段有手动或其他版本剪辑。`}</p>
                        {proposal.kind === "selection" ? proposal.selections.map(item => <div key={item.segment.id}
                                                                                              className="border-b py-2 text-sm break-words">
                            <p>{item.segment.text.slice(0, 300)}</p><p
                            className="text-muted-foreground">{item.take.name} · {item.take.durationSec.toFixed(3)} 秒
                            · {item.segment.selectedTakeId === item.take.id ? "已选用，保持原样" : "改为选用"}{item.textMismatch ? " · 来源文字与当前脚本不同" : ""}</p>
                        </div>) : proposal.items.map(item => <div key={item.segmentId}
                                                                  className="border-b py-2 text-sm break-words">
                            <p>{item.text}</p><p className="text-muted-foreground">{item.takeName} ·
                            所选来源 {item.durationSec.toFixed(3)} 秒{item.clip ? ` · ${item.clip.startSec.toFixed(3)} 秒开始 · 裁剪 ${item.clip.trimStartSec.toFixed(3)}–${item.clip.trimEndSec.toFixed(3)} 秒` : item.status === "already_placed" ? " · 已放置，保留原剪辑" : " · 手动或其他版本剪辑保留，不新增"}{item.textMismatch ? " · 来源文字与当前脚本不同" : ""}</p>
                            <details className="text-xs">
                                <summary>查看对应记录与保留剪辑</summary>
                                <p className="break-all">段落 {item.segmentId} ·
                                    所选录音 {item.takeId}</p>{proposal.before.filter(clip => item.preservedClipIds.includes(clip.id)).slice(0, 20).map(clip =>
                                <p key={clip.id} className="break-all">保留片段 {clip.id} · 录音 {clip.takeId} ·
                                    音轨 {clip.trackId} · 位置 {clip.startSec.toFixed(3)} 秒 ·
                                    源裁剪 {clip.trimStartSec.toFixed(3)}–{clip.trimEndSec.toFixed(3)} 秒 ·
                                    实际播放 {(clip.trimEndSec - clip.trimStartSec).toFixed(3)} 秒 · 音量 {clip.gain} ·
                                    淡入/淡出 {clip.fadeInSec}/{clip.fadeOutSec} 秒</p>)}{item.preservedClipIds.length > 20 &&
                                <p>另有 {item.preservedClipIds.length - 20} 个剪辑保持原样；可在时间线查看。</p>}
                            </details>
                        </div>)}
                        <details className="text-xs text-muted-foreground">
                            <summary>预览身份与冲突规则</summary>
                            <p className="break-all">{proposal.id}</p>
                            <p>内容改变后需要重新预览。</p></details>
                    </div>}
                    {error && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}
                </div>
        </SidePanel>
    </div>;
}
