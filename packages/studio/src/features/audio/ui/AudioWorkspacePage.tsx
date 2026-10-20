import {type AudioSelectionIntent, deriveAudioSelection} from "./audioSelection";
import {useEffect, useMemo, useRef, useState} from "react";
import {toast} from "sonner";
import {useProductQuery} from "../../../platform/product/queries";
import {Check, Headphones, Mic, PanelRightClose, PanelRightOpen, Plus, Sparkles, X} from "../../../ui/icons";
import {db} from "../../../platform/product/store";
import {addAudioChapter,
    addAudioTrack,

    patchAudioChapter,
    patchAudioSegment} from "../commands/audio";
import {getAudioProjectSnapshot} from "../queries/snapshot";
import {AUDIO_TRANSACTION_TABLES} from "../../../platform/product/scopes";
import type {AudioSegment, AudioTake} from "../models/audio";
import {Button} from "../../../ui/button";
import {PageHeader, PageState, PageToolbar} from "../../../app/layout/PageLayout";
import {ModuleLayout} from "../../../app/layout/ModuleLayout";
import {ProjectWorkspaceNavigation} from "../../../app/workspace/ProjectWorkspaceNavigation";
import {
    ContextPanel,
    ContextPanelContent,
    ContextPanelDescription,
    ContextPanelHeader,
    ContextPanelTitle
} from "../../../app/layout/context-panel";
import {DraftConflictError} from "../../../platform/product/draftConflict";
import {errorText, SavedText, useProjectAudioJobs} from "../presentation/shared";
import {AudioSources} from "./AudioSources";
import {AudioInspector} from "./AudioInspector";
import {ScriptDocument} from "./ScriptDocument";
import {VoiceLibrary} from "./VoiceLibrary";
import {flushPendingDrafts} from "../../../platform/product/drafts";
import {AudioTimeline} from "./AudioTimeline";
import {AudioBatchActions, AudioChapterBatches} from "./AudioGenerationBatches";
import {pauseAudioGenerationBatches} from "../generation/batchRuntime";
import {AudioArrangementActions} from "./AudioArrangementActions";
import {AudioClipHistory} from "../engine/commands";
import "./story-workspace.css";

export function AudioWorkspacePage({projectId}: { projectId: string }) {
    useProjectAudioJobs(projectId);
    useEffect(() => {
        const pause = () => pauseAudioGenerationBatches({projectId, projectOnly: true});
        window.addEventListener("pagehide", pause);
        return () => {
            window.removeEventListener("pagehide", pause);
            pause();
        };
    }, [projectId]);
    const data = useProductQuery(async (db) => {
        const project = await db.projects.get(projectId) ?? null;
        return {
            project,
            snapshot: project?.kind === "audio" ? await getAudioProjectSnapshot(projectId, db) : null,
            projectId
        };
    }, [projectId]);
    const [chapterId, setChapterId] = useState("");
    const [segmentId, setSegmentId] = useState("");
    const [takeId, setTakeId] = useState("");
    const [clipId, setClipId] = useState("");
    const [mode, setMode] = useState<"script" | "timeline">("script");
    const [inspectorOpen, setInspectorOpen] = useState(false);
    const [inspectorTab, setInspectorTab] = useState<"voice" | "sources" | "exports">("voice");
    const [sourceRequest, setSourceRequest] = useState<{ id: string; segmentId?: string }>();
    const [voicesOpen, setVoicesOpen] = useState(false);
    const [voiceTarget, setVoiceTarget] = useState<AudioSegment>();
    const [seekRequest, setSeekRequest] = useState<{ id: string; position: number }>();
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const pending = useRef(false);
    const [, updateHistory] = useState(0);
    const historyChapterId = data?.snapshot?.chapters.find(row => row.id === chapterId)?.id ?? data?.snapshot?.chapters[0]?.id;
    const clipHistory = useMemo(() => historyChapterId ? new AudioClipHistory(projectId, historyChapterId, () => updateHistory(value => value + 1)) : undefined, [projectId, historyChapterId]);

    async function action(fn: () => Promise<unknown>) {
        if (pending.current) return;
        pending.current = true;
        setBusy(true);
        setError("");
        try {
            await fn();
        } catch (reason) {
            const message = errorText(reason);
            setError(message);
            toast.error(message);
        } finally {
            pending.current = false;
            setBusy(false);
        }
    }

    if (!data || data.projectId !== projectId) return <PageState kind="loading" title="加载音频项目…"/>;
    if (!data.project || !data.snapshot) return <PageState kind="missing" title="找不到这个音频项目"/>;
    const {snapshot, project} = data;
    const chapter = snapshot.chapters.find((row) => row.id === chapterId) ?? snapshot.chapters[0];
    if (!chapter) return <PageState kind="error" title="项目缺少音频章节" description="请重新打开项目。"/>;
    const segment = snapshot.segments.find((row) => row.id === segmentId && row.chapterId === chapter.id);

    function applySelection(intent: AudioSelectionIntent) {
        const result = deriveAudioSelection(snapshot, {chapterId: chapter.id, segmentId, takeId, clipId}, intent);
        if (result.patch.chapterId !== undefined) setChapterId(result.patch.chapterId);
        if (result.patch.segmentId !== undefined) setSegmentId(result.patch.segmentId);
        if (result.patch.takeId !== undefined) setTakeId(result.patch.takeId);
        if (result.patch.clipId !== undefined) setClipId(result.patch.clipId);
        if (result.seek) setSeekRequest({id: `${result.seek.clipId}:${Date.now()}`, position: result.seek.position});
    }

    function selectSegment(row: AudioSegment) {
        applySelection({kind: "segment", row});
    }

    function selectClip(id: string) {
        applySelection({kind: "clip", id});
    }

    function selectTake(id: string) {
        applySelection({kind: "take", id});
    }

    function inspect(row?: AudioSegment) {
        if (row) selectSegment(row);
        setInspectorTab(row ? "voice" : "sources");
        setInspectorOpen(true);
    }

    function saved(take: AudioTake) {
        applySelection({kind: "saved", take});
        setInspectorTab(take.segmentId ? "voice" : "sources");
        setInspectorOpen(true);
    }

    function openVoices(row?: AudioSegment) {
        if (row) selectSegment(row);
        setVoiceTarget(row ?? segment);
        setVoicesOpen(true);
    }

    const inspector = <AudioInspector projectId={projectId} chapterId={chapter.id} snapshot={snapshot} segment={segment}
                                      takeId={takeId} tab={inspectorTab} onTabChange={setInspectorTab}
                                      onTake={selectTake} onClip={selectClip} onAddSources={(target) => {
        setSourceRequest({id: String(Date.now()), segmentId: target});
    }} action={action} busy={busy} onVoices={openVoices}/>;
    const navigation = <>
        <ProjectWorkspaceNavigation projectId={projectId} projectName={project.name} kind="audio"/>
        <div className="module-navigation-section as-chapter-navigation">
            <div className="as-menu-heading">项目章节</div>
            <div className="mb-3"><SavedText key={`${chapter.id}:title`} projectId={projectId} rowId={chapter.id}
                                             field="title" value={chapter.title} label="当前章节名称"
                                             save={async (title, baseline) => {
                                                 const current = await db.audioChapters.get(chapter.id);
                                                 if (!current || current.title !== baseline) throw new DraftConflictError();
                                                 await patchAudioChapter(projectId, current.id, current.revision, {title});
                                             }}/></div>
            {snapshot.chapters.map((row, index) => <Button key={row.id}
                                                           variant={chapter.id === row.id ? "secondary" : "ghost"}
                                                           className="w-full justify-start" onClick={() => {
                setChapterId(row.id);
                setSegmentId("");
                setTakeId("");
                setClipId("");
            }}><span className="text-muted-foreground text-xs">{String(index + 1).padStart(2, "0")}</span><span
                className="truncate">{row.title}</span>{chapter.id === row.id &&
                <Check size={14} className="ml-auto"/>}</Button>)}<Button variant="ghost" size="sm"
                                                                          className="mt-2 w-full justify-start"
                                                                          disabled={busy}
                                                                          onClick={() => void action(async () => {
                                                                              const row = await db.transaction("rw", AUDIO_TRANSACTION_TABLES, async (db) => {
                                                                                  const created = await addAudioChapter(projectId, {
                                                                                      title: `章节 ${snapshot.chapters.length + 1}`,
                                                                                      order: Math.max(0, ...snapshot.chapters.map((item) => item.order)) + 1
                                                                                  }, db);
                                                                                  await addAudioTrack(projectId, {
                                                                                      chapterId: created.id,
                                                                                      role: "voice",
                                                                                      name: "人声",
                                                                                      order: 0,
                                                                                      gain: 1,
                                                                                      muted: false,
                                                                                      solo: false
                                                                                  }, db);
                                                                                  return created;
                                                                              });
                                                                              setChapterId(row.id);
                                                                              setSegmentId("");
                                                                              setTakeId("");
                                                                              setClipId("");
                                                                          })}><Plus
            size={14}/>新增章节</Button>
        </div>
    </>;
    return <ModuleLayout navigation={navigation} navigationLabel="音频章节" mainClassName="overflow-hidden">
        <div className="as-workspace" data-mode={mode}>
            <PageHeader dense title="音频制作" className="as-page-header"/>
            <PageToolbar className="as-toolbar">
                <div className="as-chapter-selector"><span className="truncate font-medium">{chapter.title}</span></div>
                <nav className="as-view-modes" aria-label="音频制作模式"><Button size="sm"
                                                                                 variant={mode === "script" ? "secondary" : "ghost"}
                                                                                 aria-pressed={mode === "script"}
                                                                                 onClick={() => setMode("script")}>脚本</Button><Button
                    size="sm" variant={mode === "timeline" ? "secondary" : "ghost"} aria-pressed={mode === "timeline"}
                    onClick={() => setMode("timeline")}>剪辑</Button></nav>
                <div className="as-toolbar-actions"><Button size="sm" variant="ghost" onClick={() => openVoices()}><Mic
                    size={15}/>音色</Button><Button size="sm" variant="secondary"
                                                    disabled={!snapshot.segments.some(row => row.chapterId === chapter.id)}
                                                    onClick={() => {
                                                        const target = segment ?? snapshot.segments.find(row => row.chapterId === chapter.id);
                                                        if (target) inspect(target);
                                                    }}><Sparkles size={15}/>配音</Button><AudioBatchActions
                    projectId={projectId} chapterId={chapter.id} snapshot={snapshot}/><AudioArrangementActions
                    projectId={projectId} chapterId={chapter.id} snapshot={snapshot}
                    history={clipHistory}/><AudioSources
                    request={sourceRequest} compact projectId={projectId} segmentId={segment?.id}
                    onSaved={saved}/><Button
                    variant="ghost" size="sm" aria-label={inspectorOpen ? "收起声音面板" : "打开声音面板"}
                    onClick={() => {
                        if (!segment) setInspectorTab("sources");
                        if (!pending.current) setInspectorOpen(!inspectorOpen);
                    }}>{inspectorOpen ? <PanelRightClose size={16}/> : <PanelRightOpen size={16}/>}<span
                    className="as-panel-button-label">声音</span></Button></div>
            </PageToolbar>
            {error && <div className="as-error" role="alert"><span>{error}</span><Button variant="ghost" size="icon-sm"
                                                                                         aria-label="关闭错误提示"
                                                                                         onClick={() => setError("")}><X/></Button>
            </div>}
            <div className="as-main">
                <main className="as-script-scroll"><ScriptDocument key={chapter.id} chapter={chapter}
                                                                   snapshot={snapshot}
                                                                   selectedId={segment?.id ?? ""} busy={busy}
                                                                   action={action} onSelect={selectSegment}
                                                                   onInspect={(row) => inspect(row)}
                                                                   onVoices={openVoices}/>
                    <div className="px-4 pb-4"><AudioChapterBatches projectId={projectId} chapterId={chapter.id}/></div>
                </main>
            </div>
            <VoiceLibrary key={projectId} projectId={projectId} open={voicesOpen} onOpenChange={setVoicesOpen}
                          speakers={snapshot.speakers} takes={snapshot.takes} selectedId={voiceTarget?.speakerId}
                          onChoose={voiceTarget ? async (id) => {
                              await flushPendingDrafts(projectId);
                              const current = await db.audioSegments.get(voiceTarget.id);
                              if (!current || current.projectId !== projectId || current.speakerId !== voiceTarget.speakerId) throw new Error("段落已改变，请重新选择后应用音色");
                              await patchAudioSegment(projectId, current.id, current.revision, {speakerId: id});
                              setSegmentId(current.id);
                              setInspectorTab("voice");
                              setInspectorOpen(true);
                          } : undefined}/>
            <AudioTimeline projectId={projectId} projectName={project.name} chapterId={chapter.id} snapshot={snapshot}
                           clipHistory={clipHistory}
                           selectedId={clipId} onSelect={selectClip} mobileMode={mode} seekRequest={seekRequest}
                           onOpenSources={() => inspect()}/>
            <ContextPanel kind="audio-inspector" open={inspectorOpen} onOpenChange={(open) => {
                if (!pending.current) setInspectorOpen(open);
            }} width={320}
                          onRequestDeparture={(proceed, cancel) => {
                              if (!pending.current) proceed(); else cancel?.();
                          }}>
                <ContextPanelContent className="as-context-panel">
                    <ContextPanelHeader><ContextPanelTitle><span className="flex items-center gap-2"><Headphones
                        size={16}/>声音与版本</span></ContextPanelTitle>
                        <ContextPanelDescription>{segment ? "当前段落的声音、生成版本和剪辑来源" : "管理项目声音与导出成品"}</ContextPanelDescription>
                    </ContextPanelHeader>
                    <div className="as-sheet-scroll">{inspector}</div>
                </ContextPanelContent>
            </ContextPanel>
        </div>
    </ModuleLayout>;
}
