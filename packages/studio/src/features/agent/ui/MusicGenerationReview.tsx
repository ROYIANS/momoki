import {useId, useRef, useState} from "react";
import {useProductQuery} from "../../../platform/product/queries";
import {Link} from "@tanstack/react-router";
import {ChevronDown, LoaderCircle, Music2} from "../../../ui/icons";
import type {AgentToolCall} from "../models/agent";
import {Button} from "../../../ui/button";
import {
    approveMusicGenerationReview,
    parseMusicGenerationReview,
    readMusicGenerationReview
} from "../../music/agent/musicGenerationReview";
import {describeMusicReview} from "../../music/agent/musicReviewPresentation";
import type {RunAction} from "../models/chatRunAction";
import {ContextPanelFooter} from "../../../app/layout/context-panel";

function ReviewText({label, text}: { label: string; text: string }) {
    const [expanded, setExpanded] = useState(false);
    const id = useId();
    const long = text.length > 260 || text.split("\n").length > 5;
    return <section className="min-w-0 space-y-1">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div id={id}
             className={`whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere] ${long && !expanded ? "line-clamp-4" : ""}`}>{text}</div>
        {long && <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={id}
                         onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : `展开完整${label}`}<ChevronDown
            aria-hidden className={expanded ? "rotate-180" : ""}/></Button>}
    </section>;
}

/** Frozen readable proposal, shared by active review and historical tool details. */
export function MusicGenerationReview({call, busy, active, onAction}: {
    call: AgentToolCall; busy: boolean; active: boolean;
    onAction: (runId: string, action: RunAction, callId?: string) => void;
}) {
    const snapshot = parseMusicGenerationReview(call.preview?.music);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string>();
    const [details, setDetails] = useState(false);
    const [retry, setRetry] = useState(0);
    const savingRef = useRef(false);
    const detailsId = useId();
    const readiness = useProductQuery(async (db) => {
        if (!active) return null;
        try {
            return await readMusicGenerationReview(call, db);
        } catch {
            return {status: "unavailable" as const, message: "暂时无法核对当前版本，请重试。"};
        }
    }, [active, call.id, call.arguments, call.preview?.revision, retry]);
    const disabled = busy || saving;

    async function confirm() {
        if (disabled || savingRef.current || readiness?.status !== "ready") return;
        savingRef.current = true;
        setSaving(true);
        setError(undefined);
        try {
            await approveMusicGenerationReview(call);
            onAction(call.runId, "resume");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "确认失败，请重试。");
            setRetry(value => value + 1);
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    }

    if (!snapshot) return <div className="space-y-2 py-2">
        <p role={active ? "alert" : undefined}>{active ? "这条提案没有完整的版本摘要，请取消后让助手重新准备音乐生成。" : "这条记录未保存完整的音乐版本摘要，可在下方查看原始参数与结果。"}</p>
        {active && <Button variant="outline" size="sm" disabled={disabled}
                           onClick={() => onAction(call.runId, "reject", call.id)}>取消本次生成</Button>}
    </div>;
    const view = describeMusicReview(snapshot.settings);
    return <section aria-label="音乐生成确认" className="min-w-0 space-y-4 py-3 text-sm">
        <div className="flex items-start gap-2">
            <Music2 className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden/>
            <div className="min-w-0 space-y-1">
                <h4 className="break-words font-medium [overflow-wrap:anywhere]">{view.title}</h4>
                <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>{view.engine} · {view.mode}</span><span>{view.vocals}</span><span>{view.duration}</span>
                </div>
                <div className="break-words text-xs text-muted-foreground">{snapshot.projectName} ·
                    草稿版本 {snapshot.draftRevision}{!active && " · 当时待提交的内容"}</div>
            </div>
        </div>
        {view.sections.map(section => <ReviewText key={section.label} {...section} />)}
        {active && readiness?.status !== "ready" &&
            <div role="status" className="space-y-1 text-sm text-muted-foreground">
                <div>{readiness?.message ?? "正在核对草稿与连接…"}</div>
                {readiness?.status === "unavailable" && <Button variant="ghost" size="sm" disabled={disabled}
                                                                onClick={() => setRetry(value => value + 1)}>重新检查</Button>}
            </div>}
        {error && <div role="alert" className="text-sm text-destructive">{error}</div>}
        {active && <div className="space-y-2">
            <div
                className="text-xs text-muted-foreground">确认后通过 {snapshot.connectorLabel} 提交，可能消耗额度或产生费用；具体费用以服务商为准。
            </div>
            <div
                className="text-xs text-muted-foreground">如需修改，请先在项目中保存草稿，再取消本次提案，让助手按新版本准备。
            </div>
            <ContextPanelFooter className="flex-wrap justify-start">
                <Button size="sm" disabled={disabled || readiness?.status !== "ready"}
                        onClick={() => void confirm()}>{saving && <LoaderCircle aria-hidden
                                                                                className="animate-spin motion-reduce:animate-none"/>}确认并生成音乐</Button>
                <Button variant="outline" size="sm" disabled={disabled}
                        onClick={() => onAction(call.runId, "reject", call.id)}>取消本次生成</Button>
                <Button variant="ghost" size="sm" asChild><Link to="/p/$projectId"
                                                                params={{projectId: snapshot.projectId}}>查看项目</Link></Button>
            </ContextPanelFooter>
        </div>}
        <div className="min-w-0">
            <Button variant="ghost" size="sm" aria-expanded={details} aria-controls={detailsId}
                    onClick={() => setDetails(!details)}>提交详情<ChevronDown aria-hidden
                                                                              className={details ? "rotate-180" : ""}/></Button>
            {details && <div id={detailsId} className="min-w-0 space-y-3 pt-2">
                <div className="text-xs text-muted-foreground">{view.note}</div>
                {view.parameters.map(field => <ReviewText key={field.label} label={field.label} text={field.value}/>)}
                <dl className="space-y-1 break-all text-xs text-muted-foreground">
                    <div>
                        <dt className="inline">项目 ID：</dt>
                        <dd className="inline">{snapshot.projectId}</dd>
                    </div>
                    <div>
                        <dt className="inline">草稿 ID：</dt>
                        <dd className="inline">{snapshot.draftId}</dd>
                    </div>
                </dl>
                <div className="text-xs text-muted-foreground">本次提交参数（不含密钥）</div>
                <pre className="whitespace-pre-wrap break-all text-xs" tabIndex={0}
                     aria-label="完整音乐提交参数">{JSON.stringify(view.wire, null, 2)}</pre>
            </div>}
        </div>
    </section>;
}
