import {useCallback, useEffect, useRef, useState, type RefObject} from "react";
import {ContextPanel, ContextPanelContent, ContextPanelDescription, ContextPanelHeader, ContextPanelTitle} from "../../../app/layout/context-panel";
import {useManualDraftDeparture} from "../../../app/drafts/useManualDraftGuard";
import {Button} from "../../../ui/button";
import {ArrowLeft, FolderOpen, Plus} from "../../../ui/icons";
import {createId} from "../../../platform/identity";
import {skillDirectoryImportServices} from "../../../platform/runtime/skillImport";
import {prepareSkillImport} from "../skills/runtime/package";
import {prepareBrowserSkillImport, supportsSkillDirectoryImport} from "../skills/runtime/browserImport";
import {getInstalledSkillManifest} from "../skills/queries/installedSkills";
import type {InstalledSkill, SkillImportCandidate, SkillManifest} from "../skills/models/installedSkill";
import type {InstalledSkillsController} from "./useInstalledSkills";
import {InstalledSkillDetail, SkillImportReview} from "./InstalledSkillsContent";
import "./installedSkills.css";

type Review = {readonly candidate: SkillImportCandidate; readonly target?: InstalledSkill; readonly previous?: SkillManifest; readonly token: object};

export function InstalledSkillMutationNotice({controller}: {controller: InstalledSkillsController}) {
    if (!controller.error) return null;
    return <div className="installed-skills-notice" role="alert"><p>{controller.error}</p>
        {controller.uncertain ? <Button type="button" size="sm" variant="outline" disabled={controller.pending}
            onClick={() => void (controller.uncertain?.conflicted ? controller.refresh() : controller.reconcile())}>
            {controller.uncertain.conflicted ? "重新查看当前列表" : "核对保存结果"}</Button> :
            <Button type="button" size="sm" variant="outline" disabled={controller.pending} onClick={() => void controller.refresh()}>刷新技能列表</Button>}
    </div>;
}

/** The panel owns only its ephemeral review. Catalogue mutations keep one owner. */
export function InstalledSkillsPanel({open, onOpenChange, controller, returnFocus, inline = false}: {
    open: boolean; onOpenChange: (open: boolean) => void; controller: InstalledSkillsController;
    returnFocus?: RefObject<HTMLButtonElement | null>;
    /** Settings renders the same management content in the page instead of a context panel. */
    inline?: boolean;
}) {
    const [selected, setSelected] = useState<InstalledSkill>();
    const [review, setReview] = useState<Review>();
    const [enabled, setEnabled] = useState(false);
    const [picking, setPicking] = useState(false);
    const [pickerError, setPickerError] = useState<string>();
    const [search, setSearch] = useState("");
    const input = useRef<HTMLInputElement>(null);
    const selection = useRef<{token: object; target?: InstalledSkill} | undefined>(undefined);
    const current = useRef({review, isPending: controller.isPending, open});
    current.current = {review, isPending: controller.isPending, open};
    const discard = useCallback(() => {current.current.review = undefined; setReview(undefined);}, []);
    const readState = useCallback(() => ({dirty: !!current.current.review, pending: current.current.isPending()}), []);
    const departure = useManualDraftDeparture(!!review, controller.pending || !!controller.uncertain, discard, {readState});
    const native = skillDirectoryImportServices();
    const browserSupported = supportsSkillDirectoryImport();
    useEffect(() => {
        if (!open) {selection.current = undefined; setPicking(false);}
        return () => {selection.current = undefined;};
    }, [open]);
    useEffect(() => {
        const cancel = (event: Event) => {
            if (event.target !== input.current) return;
            selection.current = undefined;
            setPicking(false);
        };
        document.addEventListener("cancel", cancel, true);
        return () => document.removeEventListener("cancel", cancel, true);
    }, []);
    const close = () => {
        selection.current = undefined;
        setPicking(false);
        setReview(undefined);
        setPickerError(undefined);
        onOpenChange(false);
    };
    async function acceptCandidate(candidate: SkillImportCandidate, ticket: NonNullable<typeof selection.current>) {
        const previous = ticket.target ? await getInstalledSkillManifest(ticket.target) : undefined;
        if (selection.current !== ticket || !current.current.open) return;
        const next = {candidate, target: ticket.target, previous, token: ticket.token};
        current.current.review = next;
        setReview(next);
        setEnabled(false);
        setPicking(false);
        selection.current = undefined;
    }
    async function choose(target?: InstalledSkill) {
        if (selection.current || controller.blocked) return;
        const ticket = {token: {}, target};
        selection.current = ticket;
        setPickerError(undefined);
        setPicking(true);
        if (!native) {
            if (browserSupported) {input.current?.click(); return;}
            selection.current = undefined;
            setPicking(false);
            setPickerError("当前浏览器不支持选择目录。请使用支持目录选择的浏览器或桌面端导入。");
            return;
        }
        try {
            const snapshot = await native.pickDirectory(createId("skillimport"));
            if (selection.current !== ticket || !current.current.open) return;
            if (snapshot.status === "canceled") {selection.current = undefined; setPicking(false); return;}
            const encoder = new TextEncoder();
            const candidate = prepareSkillImport(snapshot.directoryName, snapshot.files.map(file => ({path: file.path, bytes: encoder.encode(file.text)})), snapshot.exclusions);
            await acceptCandidate(candidate, ticket);
        } catch (cause) {
            if (selection.current !== ticket || !current.current.open) return;
            selection.current = undefined;
            setPicking(false);
            setPickerError(cause instanceof Error ? cause.message : "无法读取技能文件夹，请重新选择");
        }
    }
    const visible = controller.entries.filter(entry => `${entry.metadata.name} ${entry.metadata.description}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
    const currentSelection = selected && controller.entries.find(entry => entry.skillId === selected.skillId && entry.revision === selected.revision);
    function published(token: object) {
        if (current.current.review?.token !== token) return;
        setReview(undefined);
        setSelected(undefined);
    }
    const header = inline ? null
        : <ContextPanelHeader><ContextPanelTitle>{review ? review.target ? "审阅技能更新" : "审阅新技能" : selected ? "技能详情" : "技能管理"}</ContextPanelTitle>
            <ContextPanelDescription>技能保存在当前设备。启用和更新对新执行生效。</ContextPanelDescription></ContextPanelHeader>;
    const body = <>
            {header}
            <div className="installed-skills-scroll app-scroll">
                <InstalledSkillMutationNotice controller={controller}/>
                {pickerError && <p className="installed-skills-error" role="alert">{pickerError}</p>}
                {review ? <><Button type="button" size="sm" variant="ghost" disabled={controller.pending || !!controller.uncertain}
                    onClick={() => departure.requestDeparture(() => {setReview(undefined);}, discard)}><ArrowLeft/>返回技能列表</Button>
                    <SkillImportReview candidate={review.candidate} target={review.target} previous={review.previous}/>
                    {!review.target && <label className="installed-skills-enable"><input type="checkbox" checked={enabled} disabled={controller.blocked}
                        onChange={event => setEnabled(event.target.checked)}/>安装后启用</label>}
                    <div className="installed-skills-actions"><Button type="button" disabled={controller.blocked || (review.target !== undefined && review.candidate.manifest.metadata.name !== review.target.metadata.name)} aria-busy={controller.pending}
                        onClick={() => void (review.target ? controller.update(review.target, review.candidate, () => published(review.token)) : controller.install(review.candidate, enabled, () => published(review.token)))}>
                        {review.target ? "确认更新" : "确认安装"}</Button>
                        <Button type="button" variant="outline" disabled={controller.pending || !!controller.uncertain} onClick={() => departure.requestDeparture(() => {setReview(undefined);}, discard)}>取消</Button></div>
                </> : selected ? <><Button type="button" size="sm" variant="ghost" disabled={controller.pending}
                    onClick={() => {setSelected(undefined); setPickerError(undefined);}}><ArrowLeft/>全部技能</Button>
                    <InstalledSkillDetail descriptor={selected} current={currentSelection} controller={controller} picking={picking}
                        onUpdate={() => void choose(selected)} onUninstalled={() => setSelected(undefined)}/>
                </> : <><div className="installed-skills-toolbar"><input type="search" aria-label="搜索已安装技能" placeholder="搜索已安装技能…" value={search} onChange={event => setSearch(event.target.value)}/>
                    <Button type="button" size="sm" disabled={picking || controller.blocked || (!native && !browserSupported)} aria-busy={picking} onClick={() => void choose()}><Plus/>导入技能</Button></div>
                    {!native && !browserSupported && <p className="installed-skills-hint">当前浏览器不支持目录导入；可继续管理已安装技能，或使用支持目录选择的浏览器及桌面端导入。</p>}
                    {!controller.catalogue && !controller.error && <p className="installed-skills-hint">正在读取技能…</p>}
                    {controller.catalogue && !controller.entries.length && <div className="installed-skills-empty"><FolderOpen size={28}/><h3>把常用工作方法带进对话</h3><p>选择一个包含 SKILL.md 的文件夹，先审阅说明与文本资料，再决定是否启用。</p></div>}
                    {controller.entries.length > 0 && !visible.length && <p className="installed-skills-hint">没有匹配的已安装技能</p>}
                    <div className="installed-skills-list">{visible.map(entry => <div className="installed-skills-card" key={entry.skillId}>
                        <button type="button" className="installed-skills-open" onClick={() => {setSelected(entry); setPickerError(undefined);}}><strong>{entry.metadata.name}</strong><span>{entry.metadata.description}</span></button>
                        <input type="checkbox" role="switch" aria-label={`启用 ${entry.metadata.name}`} checked={entry.enabled} disabled={controller.blocked}
                            onChange={event => void controller.toggle(entry, event.target.checked)}/>
                    </div>)}</div>
                    {controller.notice && <p className="installed-skills-hint" role="status">{controller.notice}</p>}
                    {controller.retainedHistory > 0 && <div className="installed-skills-actions">
                        <p className="installed-skills-hint">旧对话保留了 {controller.retainedHistory} 个历史技能版本，占用上限（最多 128 个 / 64 MiB）。</p>
                        <Button type="button" size="sm" variant="outline" disabled={controller.blocked} onClick={() => void controller.releaseHistory()}>释放历史版本</Button></div>}
                    <p className="installed-skills-hint">技能提供工作说明与文本参考。工具权限、目录访问和付费操作仍按原有规则确认。</p>
                </>}
            </div>
            <input ref={input} type="file" multiple hidden aria-label="选择技能文件夹" {...{"webkitdirectory": ""}}
                onChange={event => {
                    const ticket = selection.current;
                    const files = Array.from(event.currentTarget.files ?? []);
                    event.currentTarget.value = "";
                    if (!ticket) return;
                    if (!files.length) {selection.current = undefined; setPicking(false); return;}
                    void prepareBrowserSkillImport(files).then(candidate => acceptCandidate(candidate, ticket)).catch((cause: unknown) => {
                        if (selection.current !== ticket || !current.current.open) return;
                        selection.current = undefined; setPicking(false);
                        setPickerError(cause instanceof Error ? cause.message : "技能文件夹读取失败");
                    });
                }}/>
    </>;
    if (inline) return <><div className="installed-skills-panel installed-skills-inline" data-installed-skills>{body}</div>{departure.confirmation}</>;
    return <><ContextPanel kind="skills" open={open} width={520} onOpenChange={(next, reason) => {
        if (next) return;
        if (reason === "guard-refused" || reason === "busy") {onOpenChange(false); return;}
        close();
    }} onRequestDeparture={(proceed, cancel) => departure.requestDeparture(proceed, discard, cancel)}>
        <ContextPanelContent returnLabel="返回对话" className="installed-skills-panel" data-installed-skills
            onCloseAutoFocus={() => {
                const active = document.activeElement;
                if (!active || active === document.body || !active.isConnected) returnFocus?.current?.focus({preventScroll: true});
            }}>{body}</ContextPanelContent>
    </ContextPanel>{departure.confirmation}</>;
}
