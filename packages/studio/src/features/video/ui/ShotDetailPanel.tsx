import {useCallback, useEffect, useRef, useState} from "react";
import type {ShotDetailTarget} from "../models/shotDetailTarget";
import type {DetailPanelClose, DetailPanelCloseRequest, DetailPanelOutcome, DetailPanelRequest} from "../../../app/layout/detailPanelSession";
import {useProductQueryState} from "../../../platform/product/queries";
import {type ManualDraftState, useManualDraftDeparture} from "../../../app/drafts/useManualDraftGuard";
import {ContextPanel, ContextPanelContent, ContextPanelDescription, ContextPanelHeader, ContextPanelTitle} from "../../../app/layout/context-panel";
import {PageState} from "../../../app/layout/PageLayout";
import {Button} from "../../../ui/button";
import {Field} from "../../../ui/field";
import {Checkbox} from "../../../ui/checkbox";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "../../../ui/select";
import {useVideoWorkspaceRepository} from "../services/workspaceRepository";
import {normalizeShotStatus, SHOT_STATUSES, SHOT_STATUS_LABELS, type Shot} from "../models/shots";
import {parseShotPictureSlots} from "../../library/models/slot";
import {EditableGenerationSlot} from "../../library/ui/GenerationSlotCard";
import {ShotTextField} from "./ShotTextField";
import {TEXT_SHOT_FIELDS, type TextShotField} from "./shotColumnFields";
import {SHOT_COLUMNS} from "../models/columns";
import {DurationInput} from "./DurationInput";
import {ShotRelationsEditor} from "./ShotRelationsEditor";
import type {Project} from "../../projects/models/project";
import type {Episode} from "../models/episodes";
import type {Character, Scene, Prop, VisualStyle} from "../../library/models/assets";
import {sanitizeText} from "../../../platform/diagnostics/sanitize";
import {DraftConflictError} from "../../../platform/product/draftConflict";
import {shotSceneCommit, shotStatusCommit, type ShotSelectionCommit} from "./shotSelectionCommit";

type DraftEntry = ManualDraftState & {discard?: () => void};
type ReportDraft = (key: string, state: ManualDraftState, discard?: () => void) => void;
const targetKey = (target: ShotDetailTarget) => JSON.stringify([target.projectId, target.episodeId, target.shotId]);

/** Video retains its editor until its own departure guard accepts a selection. */
export function ShotDetailPanel({request, onRequestOutcome, onClosed, closeRequest, onCloseRefused, returnLabel}: {
    request: DetailPanelRequest<ShotDetailTarget>;
    onRequestOutcome: (outcome: DetailPanelOutcome) => void;
    onClosed: (event: DetailPanelClose) => void;
    closeRequest?: DetailPanelCloseRequest;
    onCloseRefused?: (closeRequestId: string) => void;
    returnLabel?: string;
}) {
    const [active, setActive] = useState(request);
    const entries = useRef(new Map<string, DraftEntry>());
    const [state, setState] = useState<ManualDraftState>({dirty: false, pending: false});
    const readState = useCallback(() => {
        const all = [...entries.current.values()];
        // Slot dialogs own their existing route blocker and media cleanup. The pane
        // retains them during local replacement without installing a permanent route lock.
        const inline = [...entries.current].filter(([key]) => !["firstFrame", "lastFrame", "clip"].includes(key)).map(([, entry]) => entry);
        return {dirty: all.some(entry => entry.dirty), pending: all.some(entry => entry.pending),
            routeDirty: inline.some(entry => entry.dirty), routePending: inline.some(entry => entry.pending)};
    }, []);
    const report = useCallback<ReportDraft>((key, next, discard) => {
        entries.current.set(key, {...next, discard});
        const current = readState();
        setState(previous => previous.dirty === current.dirty && previous.pending === current.pending &&
            previous.routeDirty === current.routeDirty && previous.routePending === current.routePending ? previous : current);
    }, [readState]);
    const discard = useCallback(() => {
        for (const entry of entries.current.values()) entry.discard?.();
        entries.current.clear();
        setState({dirty: false, pending: false});
    }, []);
    const {requestDeparture, confirmation} = useManualDraftDeparture(state.dirty, state.pending, discard, {readState});
    const callbacks = useRef({onRequestOutcome, onClosed, onCloseRefused});
    callbacks.current = {onRequestOutcome, onClosed, onCloseRefused};
    const handled = useRef(request.id);
    const presented = useRef<string | undefined>(undefined);
    const switching = useRef(false);
    useEffect(() => {
        if (request.id === handled.current) return;
        handled.current = request.id;
        if (switching.current) {
            callbacks.current.onRequestOutcome({requestId: request.id, status: "refused", reason: "busy"});
            return;
        }
        if (targetKey(request.target) === targetKey(active.target)) {
            setActive(request);
            return;
        }
        switching.current = true;
        requestDeparture(() => {
            switching.current = false;
            entries.current.clear();
            setState({dirty: false, pending: false});
            setActive(request);
        }, discard, () => {
            switching.current = false;
            callbacks.current.onRequestOutcome({requestId: request.id, status: "refused", reason: "guard"});
        });
    }, [request, active, requestDeparture, discard]);
    const close = useCallback((reason: "return", closeRequestId?: string) => {
        if (switching.current) {
            if (closeRequestId) callbacks.current.onCloseRefused?.(closeRequestId);
            return;
        }
        switching.current = true;
        requestDeparture(() => {
            switching.current = false;
            callbacks.current.onClosed({requestId: active.id, reason});
        }, discard, () => {
            switching.current = false;
            if (closeRequestId) callbacks.current.onCloseRefused?.(closeRequestId);
        });
    }, [active.id, requestDeparture, discard]);
    const handledClose = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (!closeRequest || handledClose.current === closeRequest.id) return;
        handledClose.current = closeRequest.id;
        if (closeRequest.requestId !== active.id) {
            callbacks.current.onCloseRefused?.(closeRequest.id);
            return;
        }
        close(closeRequest.reason, closeRequest.id);
    }, [closeRequest, active.id, close]);
    return <><ContextPanel open onOpenChange={(open, reason) => {
        if (open) return;
        if (reason === "guard-refused" || reason === "busy") {
            callbacks.current.onRequestOutcome({requestId: active.id, status: "refused", reason: reason === "busy" ? "busy" : "guard"});
        } else callbacks.current.onClosed({requestId: active.id, reason: reason === "replaced" ? "replaced" : "close"});
    }} onRequestDeparture={(proceed, cancel) => requestDeparture(proceed, discard, cancel)}>
        <ContextPanelContent returnLabel={returnLabel ?? "返回对话"} showReturnWhenDocked={!!returnLabel}
            onReturn={returnLabel ? () => close("return") : undefined}
            onPresented={() => {
                if (presented.current === active.id) return;
                presented.current = active.id;
                callbacks.current.onRequestOutcome({requestId: active.id, status: "presented"});
            }} className="flex min-h-0 flex-col" data-shot-detail={active.target.shotId}
            aria-busy={state.pending} data-unsaved-fields={[...entries.current].filter(([, entry]) => entry.dirty).map(([key]) => key).join(",")}>
            <ContextPanelHeader><ContextPanelTitle>镜头详情</ContextPanelTitle>
                <ContextPanelDescription>查看与编辑镜头，对话会继续运行。</ContextPanelDescription></ContextPanelHeader>
            <ShotDetailContent key={targetKey(active.target)} target={active.target} report={report} readState={readState}/>
        </ContextPanelContent>
    </ContextPanel>{confirmation}</>;
}

function ShotDetailContent({target, report, readState}: {target: ShotDetailTarget; report: ReportDraft; readState: () => ManualDraftState}) {
    const [attempt, setAttempt] = useState(0);
    const key = targetKey(target);
    const query = useProductQueryState(async tx => {
        const [project, episode, shot, characters, scenes, props, styles] = await Promise.all([
            tx.projects.get(target.projectId), tx.episodes.get(target.episodeId), tx.shots.get(target.shotId),
            tx.characters.where("projectId").equals(target.projectId).toArray(),
            tx.scenes.where("projectId").equals(target.projectId).toArray(),
            tx.props.where("projectId").equals(target.projectId).toArray(),
            tx.styles.where("projectId").equals(target.projectId).toArray(),
        ]);
        const owned = project && episode?.projectId === target.projectId && shot?.projectId === target.projectId && shot.episodeId === target.episodeId;
        return {key, value: owned ? {project, episode, shot, characters, scenes, props, styles} : null};
    }, [key, attempt]);
    const matched = query.value?.key === key ? query.value.value : undefined;
    const retained = useRef<NonNullable<typeof matched> | undefined>(undefined);
    if (matched) retained.current = matched;
    const snapshot = matched ?? (readState().dirty || readState().pending ? retained.current : undefined);
    const unavailable = !!query.error || matched === null;
    return <div className="app-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-5" data-shot-detail-scroll>
        {query.error && <div role="alert" className="mb-4 space-y-2 text-sm"><p>镜头读取失败。已打开的草稿仍保留，请重试。</p>
            <Button size="sm" variant="outline" onClick={() => setAttempt(value => value + 1)}>重试读取镜头</Button></div>}
        {matched === undefined && !query.error && !snapshot && <PageState compact kind="loading" title="正在读取镜头…"/>}
        {matched === null && <PageState compact kind="missing" title="找不到这个镜头" description={snapshot ? "当前编辑内容已保留，目标不可用，暂时不能保存。" : "镜头可能已被删除，或不属于指定的项目与集。"}/>}
        {snapshot && <ShotDetailFields {...snapshot} unavailable={unavailable} report={report}/>}
    </div>;
}

type DetailData = {
    project: Project;
    episode: Episode;
    shot: Shot;
    characters: Character[];
    scenes: Scene[];
    props: Prop[];
    styles: VisualStyle[];
};

function ShotDetailFields({project, episode, shot, characters, scenes, props, styles, unavailable, report}: DetailData & {unavailable: boolean; report: ReportDraft}) {
    const repository = useVideoWorkspaceRepository();
    const lock = useRef(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string>();
    const retry = useRef<(() => Promise<void>) | undefined>(undefined);
    async function commit(action: () => Promise<void>) {
        if (lock.current || unavailable) return;
        lock.current = true;
        setPending(true);
        setError(undefined);
        retry.current = action;
        report("selection", {dirty: true, pending: true});
        try {
            await action();
            retry.current = undefined;
            report("selection", {dirty: false, pending: false});
        } catch (cause) {
            if (cause instanceof DraftConflictError) {
                // The control re-reads the latest row; replaying the stale baseline could only conflict again.
                retry.current = undefined;
                setError("该镜头已被其他操作更改，已显示最新值，请重新选择。");
                report("selection", {dirty: false, pending: false});
                return;
            }
            setError(cause instanceof Error ? sanitizeText(cause.message, 200) : "保存选择失败，请重试");
            report("selection", {dirty: true, pending: false});
        } finally {
            lock.current = false;
            setPending(false);
        }
    }
    const commitSelection = ({patch, baseline}: ShotSelectionCommit) => void commit(() => repository.patchShot(shot.id, patch, baseline));
    const slots = parseShotPictureSlots(shot as unknown as Record<string, unknown>);
    const textFields = Object.values(TEXT_SHOT_FIELDS) as TextShotField[];
    return <div className="space-y-5" data-shot-editor={shot.id}>
        <p className="text-muted-foreground text-xs">{project.name} · {episode.title} · 第 {shot.order} 个镜头{shot.beatId ? ` · ${episode.story.beats.find(beat => beat.id === shot.beatId)?.title ?? "节拍已失效"}` : " · 未分配节拍"}</p>
        <div className="grid grid-cols-2 gap-4">
            <Field label="镜号"><ShotTextField shot={shot} field="shotNumber" ariaLabel="镜号" unavailable={unavailable}
                onDepartureState={(state, discard) => report("shotNumber", state, discard)}/></Field>
            <Field label="时长（秒）"><DurationInput projectId={project.id} shotId={shot.id} value={shot.durationSec} unavailable={unavailable}
                onDepartureState={(state, discard) => report("durationSec", state, discard)}/></Field>
        </div>
        <Field label="状态"><Select value={normalizeShotStatus(shot.status)} disabled={pending || unavailable}
            onValueChange={value => commitSelection(shotStatusCommit(shot, value))}>
            <SelectTrigger aria-label="镜头状态" className="w-full"><SelectValue/></SelectTrigger>
            <SelectContent>{SHOT_STATUSES.map(status => <SelectItem key={status} value={status}>{SHOT_STATUS_LABELS[status]}</SelectItem>)}</SelectContent>
        </Select></Field>
        {textFields.map(field => <Field key={field} label={field === "content" ? "镜头内容" : SHOT_COLUMNS.find(column => column.id === field)?.label ?? field}>
            <ShotTextField shot={shot} field={field} ariaLabel={field === "content" ? "镜头内容" : SHOT_COLUMNS.find(column => column.id === field)?.label ?? field}
                multiline={field === "content" || field === "notes"} rows={field === "content" ? 4 : 2} unavailable={unavailable}
                onDepartureState={(state, discard) => report(field, state, discard)}/></Field>)}
        <Field label="场景"><Select value={shot.sceneId ?? "none"} disabled={pending || unavailable}
            onValueChange={value => commitSelection(shotSceneCommit(shot, value))}>
            <SelectTrigger aria-label="镜头场景" className="w-full"><SelectValue/></SelectTrigger><SelectContent>
                <SelectItem value="none">未选择场景</SelectItem>
                {shot.sceneId && !scenes.some(scene => scene.id === shot.sceneId) && <SelectItem value={shot.sceneId} disabled>已失效的场景</SelectItem>}
                {scenes.map(scene => <SelectItem key={scene.id} value={scene.id}>{scene.name || "未命名场景"}</SelectItem>)}
            </SelectContent></Select></Field>
        <fieldset disabled={pending || unavailable} className="space-y-2"><legend className="mb-2 text-sm font-medium">镜头角色</legend>
            {characters.length ? characters.map(character => <label key={character.id} className="flex items-center gap-3 py-1 text-sm">
                <Checkbox disabled={pending || unavailable} checked={shot.characterIds.includes(character.id)}
                    onCheckedChange={checked => void commit(() => repository.setShotCharacterSelected(shot.id, character.id, checked === true))}/>{character.name || "未命名角色"}</label>) : <p className="text-muted-foreground text-xs">先在世界里添加角色。</p>}
        </fieldset>
        {(pending || error) && <div role={error ? "alert" : "status"} className="space-y-2 text-sm"><p>{pending ? "保存选择中…" : error}</p>
            {error && <><Button size="sm" variant="outline" disabled={unavailable} onClick={() => retry.current && void commit(retry.current)}>重试保存选择</Button>
                <Button size="sm" variant="ghost" onClick={() => {setError(undefined); retry.current = undefined; report("selection", {dirty: false, pending: false});}}>放弃未保存的选择</Button></>}</div>}
        <ShotRelationsEditor project={project} shot={shot} props={props} styles={styles} unavailable={unavailable}
            onStatusChange={status => report("relations", {dirty: status !== "saved", pending: status === "saving"})}/>
        <section className="space-y-3" aria-label="镜头媒体"><h3 className="text-sm font-medium">画面与成片</h3>
            {(["firstFrame", "lastFrame", "clip"] as const).map(field => <div key={field} className="space-y-2">
                <p className="text-muted-foreground text-xs">{{firstFrame: "首帧", lastFrame: "尾帧", clip: "成片"}[field]}</p>
                <EditableGenerationSlot projectId={project.id} targetKey={`shot:${shot.id}:${field}`} slot={slots[field]}
                    variant={field === "clip" ? "clip" : "frame"} title={`镜头 ${shot.shotNumber} · ${{firstFrame: "首帧", lastFrame: "尾帧", clip: "成片"}[field]}`}
                    unavailable={unavailable} onEditorOpenChange={open => report(field, {dirty: open, pending: open})}
                    onSave={(slot, baseline) => repository.setShotSlot(shot.id, field, slot, baseline)}/>
            </div>)}
        </section>
    </div>;
}
