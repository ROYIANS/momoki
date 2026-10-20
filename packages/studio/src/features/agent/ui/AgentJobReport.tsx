import {useObservedReadProbe} from "./threadReadVisibility";
import {useEffect, useId, useRef, useState} from "react";
import {db} from "../../../platform/product/store";
import {useProductQueryState} from "../../../platform/product/queries";
import {StorageError} from "../../../platform/storage/errors";
import {Button} from "../../../ui/button";
import {ChevronDown} from "../../../ui/icons";
import {AGENT_JOB_LIMITS, clearAgentJobResult, readAgentJob, readAgentJobPage, selectionMatchesCall} from "../commands/agentJobs";
import type {AgentRun, AgentToolCall} from "../models/agent";
import type {AgentJob, AgentJobObservation, AgentJobReader} from "../models/agentJob";

const OBSERVATION_LABELS: Record<AgentJobObservation["status"], string> = {
    ready: "可用", missing: "文件缺失", corrupt: "文件损坏", read_error: "读取失败", changed: "来源已变化",
};

/** This bounded ledger message is presentation only; it never grants report access. */
function admissionFailure(call: AgentToolCall): string | undefined {
    if (call.name !== "web_read" || call.status !== "completed" || !call.result || call.result.length > AGENT_JOB_LIMITS.metadataUnits) return;
    try {
        const value: unknown = JSON.parse(call.result);
        if (value && typeof value === "object" && "ok" in value && value.ok === false &&
            "code" in value && value.code === "retention_unavailable" &&
            "serviceMayHaveRun" in value && value.serviceMayHaveRun === false &&
            "message" in value && typeof value.message === "string" && value.message.length <= 1000) return value.message;
    } catch { /* A malformed display payload cannot stand in for an owned report. */ }
}

function jobNotice(job: AgentJob): string | undefined {
    switch (job.status) {
        case "accepted":
        case "running":
        case "completed": return undefined;
        case "stopping": if (job.kind === "mcp") return "正在停止原 MCP 调用，外部结果未确认。"; return job.kind === "project_media_check" ? "等待当前检查结束，不再开始下一项。" : "正在结束本地网页读取。";
        case "stopped": if (job.kind === "mcp") return "原 MCP 调用已停止，保留已确认的资料。"; return job.kind === "project_media_check" ? "已停止，保留已检查的结果。" : "已停止本地网页读取。";
        case "failed": return job.error ?? "未能完成，请查看已保留的结果。";
        case "unknown": return job.kind === "mcp" ? "外部操作未确认。已保留记录，不会自动重新执行。" : "未确认，相关内容暂不可读取。";
    }
}

/** Counts and observations come only from the acknowledged job row, never a timer or local estimate. */
function JobProgress({job}: {job: AgentJob}) {
    const notice = jobNotice(job);
    const selectedMedia = job.selection.kind === "project_media_check" ? job.selection.media : [];
    const remaining = job.selected - job.completed;
    const surface = useRef<HTMLDivElement>(null);
    const meaningful = ["completed", "stopped", "failed", "unknown"].includes(job.status) && (job.kind === "project_media_check" || !!notice);
    useObservedReadProbe({threadId: job.threadId, jobId: job.id, revision: meaningful ? job.revision : 0, surface});
    if (job.kind !== "project_media_check" && !notice) return null;
    return <div ref={surface} className="agent-job-progress">
        {job.kind === "project_media_check" && <p>已检查 {job.completed} / {job.selected} 项</p>}
        {job.kind === "project_media_check" && job.selected === 0 && <p>没有可检查的视频。</p>}
        {notice && <p role={job.status === "failed" || job.status === "unknown" ? "alert" : undefined}>{notice}</p>}
        {job.kind === "project_media_check" && (job.status === "stopped" || job.status === "failed" || job.status === "unknown") && remaining > 0 &&
            <p>还有 {remaining} 项未检查。</p>}
        {(job.kind === "web_read" || job.kind === "mcp") && job.serviceMayHaveRun && job.status !== "completed" &&
            <p>服务可能已经执行，不会自动重新请求。</p>}
        {job.observations.length > 0 && <ul aria-label="最近检查结果">
            {job.observations.slice(-3).map(item => <li key={item.mediaId}>
                <span>{selectedMedia.find(media => media.id === item.mediaId)?.name ?? item.mediaId}</span>
                <span> · {OBSERVATION_LABELS[item.status]}</span>
            </li>)}
        </ul>}
    </div>;
}

function ReportPage({reader, job}: {reader: AgentJobReader; job: AgentJob}) {
    const [offsets, setOffsets] = useState([0]);
    const [retry, setRetry] = useState(0);
    const offset = offsets.at(-1)!;
    const revision = job.output!.revision;
    const key = JSON.stringify([reader.threadId, reader.projectId, reader.original?.runId, reader.original?.callId, job.id, revision, offset]);
    const state = useProductQueryState(async tx => ({key, page: await readAgentJobPage(reader, job.id, offset, AGENT_JOB_LIMITS.pageUnits, tx)}),
        [key, retry]);
    const page = state.value?.key === key ? state.value.page : undefined;
    const available = page?.available && page.jobId === job.id && page.revision === revision && page.offset === offset ? page : undefined;
    const surface = useRef<HTMLDivElement>(null);
    useObservedReadProbe({threadId: reader.threadId, jobId: job.id, revision: available ? job.revision : 0, surface});
    if (state.error) return <div className="agent-job-read-error" role="alert">
        <p>报告读取失败，请重试读取。</p>
        <Button size="sm" variant="ghost" onClick={() => setRetry(value => value + 1)}>重试读取报告</Button>
    </div>;
    return <div className="agent-job-reader" aria-busy={!page}>
        {!page ? <p>正在读取报告…</p> : !available ?
            <p>{!page.available && page.reason === "cleared" ? "保留结果已清理。" : "保留报告不可用。"}</p> : <>
                <div ref={surface}>{available.text ? <pre tabIndex={0} aria-label="报告正文">{available.text}</pre> : <p>报告没有正文内容。</p>}</div>
                <p className="agent-job-page-position">{available.length === 0 ? "0 字符" : `${available.offset + 1}–${available.offset + available.text.length} / ${available.length} 字符`}</p>
            </>}
        <div className="agent-job-page-actions" aria-label="报告分页">
            <Button size="sm" variant="ghost" disabled={offsets.length === 1 || !page}
                    onClick={() => setOffsets(previous => previous.slice(0, -1))}>上一页</Button>
            <Button size="sm" variant="ghost" disabled={!available || available.nextOffset === undefined}
                    onClick={() => {if (available?.nextOffset !== undefined) setOffsets(previous => [...previous, available.nextOffset!]);}}>下一页</Button>
        </div>
    </div>;
}

function reportTitle(job: AgentJob) {
    if (job.kind === "mcp") return "MCP 服务报告";
    return job.kind === "project_media_check" ? "视频检查报告" : "网页提取报告";
}
function OwnedJobReport({run, call, readOnly}: {run: AgentRun; call: AgentToolCall; readOnly?: boolean}) {
    const [retry, setRetry] = useState(0);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [clearError, setClearError] = useState<"failed" | "unknown">();
    const pending = useRef(false);
    const mounted = useRef(true);
    const readonlyRef = useRef(readOnly);
    readonlyRef.current = readOnly;
    const panelId = useId();
    const {threadId, projectId, id: runId} = run;
    const callId = call.id;
    const key = JSON.stringify([threadId, projectId, runId, callId]);
    const reader: AgentJobReader = {threadId, projectId, original: {runId, callId}};
    useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
    const state = useProductQueryState(async tx => {
        const admitted = await tx.agentJobs.where("callId").equals(callId).first();
        return {key, job: admitted ? await readAgentJob(reader, admitted.id, tx) ?? null : null};
    }, [key, retry]);
    const value = state.value?.key === key ? state.value.job : undefined;
    const job = value && value.threadId === threadId && value.projectId === projectId && value.runId === runId &&
        value.callId === callId && selectionMatchesCall(value.selection, call) ? value : null;
    const cleared = job?.output?.retention === "cleared";
    const terminal = job && ["completed", "stopped", "failed", "unknown"].includes(job.status);

    async function clear(current: AgentJob) {
        if (pending.current || readonlyRef.current || clearError === "unknown") return;
        pending.current = true; setBusy(true); setClearError(undefined);
        let uncertain = false;
        try {await clearAgentJobResult(reader, current.id, db);}
        catch (cause) {
            uncertain = cause instanceof StorageError && cause.certainty === "unknown";
            if (mounted.current) setClearError(uncertain ? "unknown" : "failed");
        } finally {
            // A captured pre-render callback must not repeat an uncertain clear either.
            pending.current = uncertain;
            if (mounted.current) setBusy(false);
        }
    }

    if (state.error) return <section className="agent-job-report" aria-label="保留报告" role="alert">
        <p>任务进度与报告读取失败。</p>
        <Button size="sm" variant="ghost" onClick={() => setRetry(value => value + 1)}>重试读取任务</Button>
    </section>;
    if (!job) {
        const failure = admissionFailure(call);
        if (failure) return <p className="agent-job-report" role="alert">{failure}</p>;
        return call.status === "completed" || call.status === "unknown"
            ? <p className="agent-job-report">{value === undefined ? "正在读取报告…" : "保留报告不可用。"}</p> : null;
    }
    return <section className="agent-job-report" aria-label={reportTitle(job)}
                    data-agent-job={job.id}>
        <JobProgress job={job}/>
        {cleared ? <p>保留结果已清理，原始调用记录仍可查看。</p> : <>
            {job.output?.retention === "retained" && <>
                <button type="button" className="agent-quiet-toggle" aria-expanded={open} aria-controls={panelId}
                        onClick={() => setOpen(value => !value)}>
                    <span>{open ? "收起报告" : "查看报告"}</span><ChevronDown size={12} className={open ? "rotate-180" : ""} aria-hidden/>
                </button>
                <div id={panelId} hidden={!open}>
                    {open && <ReportPage key={`${job.id}:${job.output.revision}`} reader={reader} job={job}/>}
                </div>
            </>}
            {terminal && !job.output && <p>完整报告暂不可读取。</p>}
            {terminal && !readOnly && <Button size="sm" variant="ghost" disabled={busy || clearError === "unknown"}
                                            aria-busy={busy} onClick={() => void clear(job)}>清理保留结果</Button>}
            {clearError && <div role="alert">
                <p>{clearError === "unknown" ? "清理结果未确认，请重新读取后核对。" : "清理未完成，请重新读取后核对。"}</p>
                <Button size="sm" variant="ghost" onClick={() => setRetry(value => value + 1)}>重新读取任务</Button>
            </div>}
        </>}
    </section>;
}

/** Historical reads use the original durable call identity; display JSON never supplies authority. */
export function AgentJobReport(props: {run: AgentRun; call: AgentToolCall; readOnly?: boolean}) {
    const {run, call} = props;
    if (call.runId !== run.id || call.threadId !== run.threadId || !["web_read", "project_media_check"].includes(call.name) && !call.preview?.mcp) return null;
    return <OwnedJobReport key={JSON.stringify([run.threadId, run.projectId, run.id, call.id])} {...props}/>;
}
