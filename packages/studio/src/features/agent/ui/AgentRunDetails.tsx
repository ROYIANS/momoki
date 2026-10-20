import {AgentMarkdown as Markdown} from "./AgentMarkdown";
import {PublicOutputCommit} from "./ExecutionFeedback";
import {ShotDetailLink} from "../../../app/details/ShotDetails";
import {CreatedEntityLinks} from "./CreatedEntityLinks";
import {AgentWriteOutcomes} from "./AgentWriteOutcomes";
import {WebResearchSources} from "./WebResearchSources";
import {ProjectImageSources} from "./ProjectImageSources";
import {GenerationReview} from "./GenerationReview";
import {MusicGenerationReview} from "./MusicGenerationReview";
import {AgentGenerationResults} from "./AgentGenerationResults";
import {AgentDesktopMediaReport} from "./AgentDesktopMediaReport";
import {AgentJobReport} from "./AgentJobReport";

import {useEffect, useId, useMemo, useRef, useState} from "react";

import {Check, ChevronDown, Circle, CircleAlert, LoaderCircle, ShieldQuestion} from "../../../ui/icons";
import type {AgentRun, AgentToolCall} from "../models/agent";
import {isCardApproval, isReviewedCall, runActionState, type RunActionState} from "../runtime/runActionState";
import type {ChatMessage} from "../models/chat";
import {buildRunActivity, liveRoundEcho} from "../runtime/runPresentation";
import {readToolRecoveryFailure, readToolValidationFailure, type ToolRecoveryFailure} from "../runtime/toolErrors";
import {ThinkingPanel} from "./ThinkingPanel";
import {useAgentActivityNavigation} from "./AgentActivityNavigation";
import "./executionActivity.css";

const MARKDOWN_PROPS = {variant: "chat"} as const;
const NO_STEERED: ChatMessage[] = [];

import type {RunAction} from "../models/chatRunAction";
// Success is shown by its icon only; every other state gets a short word.
const STATUS: Partial<Record<AgentToolCall["status"], string>> = {
    pending: "准备执行", awaiting_approval: "等待批准", approved: "已批准，等待执行",
    running: "执行中", rejected: "已拒绝", unknown: "未确认",
};

function StepIcon({status, soft}: { status: AgentToolCall["status"]; soft?: boolean }) {
    if (status === "completed") return <Check size={15} className="text-green-500"/>;
    if (status === "running") return <LoaderCircle size={15} className="animate-spin motion-reduce:animate-none"/>;
    if (status === "awaiting_approval") return <ShieldQuestion size={15} className="text-amber-500"/>;
    if (status === "failed") return <CircleAlert size={15} className={soft ? "text-amber-500" : "text-destructive"}/>;
    if (status === "unknown") return <CircleAlert size={15} className="text-amber-500"/>;
    return <Circle size={15}/>;
}

/** Only an uncertain outcome keeps its own notice; certain failures fold into one error line. */
function RecoveryFailureNotice({failure}: { failure: ToolRecoveryFailure }) {
    return <div className="agent-tool-failure" role="alert">
        <strong>操作未确认</strong>
        <p>{failure.error}</p>
        <p className="agent-tool-failure-recovery">{failure.recovery}</p>
    </div>;
}

function failureLine(call: AgentToolCall, recovery?: ToolRecoveryFailure, validationError?: string): string {
    const prefix = recovery?.effectCertainty === "rolled_back" ? "已回滚：" : recovery?.effectCertainty === "not_started" || validationError ? "未执行：" : "";
    return prefix + (recovery?.error ?? call.error ?? validationError ?? "调用失败");
}

const OBJECT_LIMIT = 40;

/** Argument-validation failures are corrected by the model itself; they are not execution failures. */
function isValidationFailure(call: AgentToolCall, validationError?: string): boolean {
    return call.status === "failed" && (Boolean(validationError) || (call.error?.startsWith("工具") === true && call.error.includes("参数无效")));
}

/** Object of the call, read only from the validated preview: target label first, then a short summary. */
function callObject(call: AgentToolCall): string | undefined {
    const preview = call.generationOverride?.preview ?? call.preview;
    const raw = (preview?.target?.label || preview?.summary || "").replace(/\s+/g, " ").trim();
    if (!raw || call.title.includes(raw)) return undefined;
    const chars = [...raw];
    return chars.length > OBJECT_LIMIT ? `${chars.slice(0, OBJECT_LIMIT - 1).join("")}…` : raw;
}

/** Quiet fold for raw arguments and results; always the last item of an expanded call. */
function TechnicalDetails({call}: { call: AgentToolCall }) {
    const [open, setOpen] = useState(false);
    const panelId = useId();
    return <div className="agent-step-technical">
        <button type="button" className="agent-quiet-toggle" aria-expanded={open} aria-controls={panelId}
                onClick={() => setOpen((value) => !value)}>
            <span>参数与返回结果</span><ChevronDown size={12} className={open ? "rotate-180" : ""} aria-hidden/>
        </button>
        <div id={panelId} className="agent-step-technical-body" hidden={!open}>
            <div className="agent-step-payload-label">AI 原始参数</div>
            <pre>{call.arguments}</pre>
            {call.generationOverride && <>
                <div className="agent-step-payload-label">用户确认的参数</div>
                <pre>{call.generationOverride.arguments}</pre>
            </>}
            {call.result && <>
                <div className="agent-step-payload-label">返回结果</div>
                <pre>{call.result}</pre>
            </>}
        </div>
    </div>;
}

function ToolCallRow({run, call, busy, readOnly, actions, onAction}: {
    run: AgentRun; call: AgentToolCall; busy: boolean; readOnly?: boolean;
    actions: RunActionState;
    onAction: (runId: string, action: RunAction, callId?: string) => void;
}) {
    const {request} = useAgentActivityNavigation();
    const awaiting = call.status === "awaiting_approval";
    const [open, setOpen] = useState(awaiting || call.status === "unknown");
    const panelId = useId();
    useEffect(() => {
        if (request?.runId === run.id && request.callId === call.id) setOpen(true);
    }, [request, run.id, call.id]);
    useEffect(() => {
        if (awaiting) setOpen(true);
    }, [awaiting]);
    const reviewGeneration = !readOnly && call.name === "submit_generation" && awaiting && actions.canDecide;
    const musicReview = call.name === "music_generate";
    const activeMusicReview = musicReview && !readOnly && awaiting && actions.canDecide;
    const preview = call.generationOverride?.preview ?? call.preview;
    const validationError = useMemo(() => call.status === "failed" ? readToolValidationFailure(call.result)?.error : undefined, [call.status, call.result]);
    const recovery = useMemo(() => call.status === "failed" ? readToolRecoveryFailure(call.result) : undefined, [call.status, call.result]);
    // Plain approvals are decided on the composer card; the row only says so.
    const decide = !readOnly && !isReviewedCall(call) && isCardApproval(actions, call);
    const status = STATUS[call.status];
    const object = callObject(call);
    const soft = isValidationFailure(call, validationError);
    return <div className="agent-run-step" data-activity-call={call.id}>
        <button type="button" className="agent-tool-call-toggle" data-agent-public="true" aria-expanded={open} aria-controls={panelId}
                data-status={call.status} data-soft={soft ? "true" : undefined}
                onClick={() => setOpen((value) => !value)}>
            <StepIcon status={call.status} soft={soft}/><span className="agent-tool-verb">{call.title}{object &&
            <span className="agent-tool-object"> · {object}</span>}</span>{status &&
            <small>{status}</small>}<ChevronDown
            size={12} className={open ? "rotate-180" : ""} aria-hidden/>
        </button>
        {call.status === "failed" && (recovery?.effectCertainty === "unknown"
            ? <RecoveryFailureNotice failure={recovery}/>
            : <p className={soft ? "agent-call-error agent-call-error-soft" : "agent-call-error text-destructive"}
                 data-kind={soft ? "validation" : "failure"}
                 role="alert">{failureLine(call, recovery, validationError)}</p>)}
        {decide && <p className="agent-action-hint" data-agent-public="true">
            等待你在输入框上方批准{call.highRisk ? " · 高风险操作" : ""}</p>}
        <AgentJobReport run={run} call={call} readOnly={readOnly}/>
        <AgentDesktopMediaReport run={run} call={call} readOnly={readOnly}/>
        <div id={panelId} hidden={!open}>
            <div className="agent-step-payload">
                {musicReview ? <MusicGenerationReview key={call.id} call={call} busy={busy} active={activeMusicReview}
                                                      onAction={onAction}/> : reviewGeneration ?
                    <GenerationReview call={call} busy={busy} onAction={onAction}/> : preview &&
                    <div className="agent-change-preview" data-agent-public="true">
                        <strong>{preview.summary}</strong>
                        {preview.changes.length > 0 &&
                            <ul>{preview.changes.map((change, index) => <li key={index}>{change}</li>)}</ul>}
                        {preview.target && /^\/(?!\/)/.test(preview.target.href) && <ShotDetailLink href={preview.target.href}
                                                                                          className="agent-change-link">查看{preview.target.label} ↗</ShotDetailLink>}
                    </div>}
                <WebResearchSources call={call}/>
                <ProjectImageSources call={call}/>
            </div>
            {call.name !== "project_create" && <CreatedEntityLinks call={call} collapseDetails/>}
            <TechnicalDetails call={call}/>
        </div>
        {call.name === "project_create" && <CreatedEntityLinks call={call} allowProjectConversation={!readOnly}/>}
    </div>;
}

type RowProps = Omit<Parameters<typeof ToolCallRow>[0], "call">;

/** Consecutive successful calls of one kind collapse into one expandable line. */
function MergedCalls({calls, ...props}: RowProps & { calls: AgentToolCall[] }) {
    const {request} = useAgentActivityNavigation();
    const [open, setOpen] = useState(false);
    const panelId = useId();
    useEffect(() => {
        if (request?.runId === props.run.id && request.callId && calls.some((call) => call.id === request.callId)) setOpen(true);
    }, [request, props.run.id, calls]);
    return <div className="agent-tool-merged">
        <button type="button" className="agent-tool-call-toggle" data-agent-public="true" aria-expanded={open} aria-controls={panelId}
                onClick={() => setOpen((value) => !value)}>
            <Check size={15} className="text-green-500" aria-hidden/><span
            className="agent-tool-verb">{calls[0].title} · {calls.length} 项</span><ChevronDown
            size={12} className={open ? "rotate-180" : ""} aria-hidden/>
        </button>
        <div id={panelId} className="agent-tool-group-calls" hidden={!open}>
            {calls.map((call) => <ToolCallRow key={call.id} {...props} call={call}/>)}
        </div>
    </div>;
}

const mergeable = (call: AgentToolCall) => call.status === "completed" && call.name !== "project_create";

function ToolGroup({calls, ...props}: RowProps & { calls: AgentToolCall[] }) {
    const segments: AgentToolCall[][] = [];
    for (const call of calls) {
        const last = segments.at(-1);
        const head = last?.[0];
        if (last && head && mergeable(head) && mergeable(call) && (head.title === call.title || head.name === call.name)) last.push(call);
        else segments.push([call]);
    }
    return <div className="agent-tool-group">
        {segments.map((segment) => segment.length > 1
            ? <MergedCalls key={segment[0].id} calls={segment} {...props}/>
            : <ToolCallRow key={segment[0].id} {...props} call={segment[0]}/>)}
    </div>;
}

// A run waiting for approval keeps its process open so the decision is never folded away.
const opensProcess = (status: AgentRun["status"]) => status === "running" || status === "waiting_approval";

/** A message the user sent while the run was working, shown where the run took it in. */
function SteeredMessage({message}: {message: ChatMessage}) {
    const time = new Date(message.createdAt);
    return <div className="agent-transcript-item agent-transcript-user agent-steered-message"
                title={Number.isNaN(time.getTime()) ? undefined : time.toLocaleString()}>
        <div className="agent-user-bubble"><Markdown {...MARKDOWN_PROPS}>{message.content}</Markdown></div>
    </div>;
}

export function AgentRunDetails({run, message, calls, steered = NO_STEERED, busy, readOnly, onAction}: {
    run: AgentRun; message: ChatMessage; calls: AgentToolCall[];
    /** Messages the user sent mid-run that this run took in. */
    steered?: ChatMessage[];
    busy: boolean; readOnly?: boolean;
    onAction: (runId: string, action: RunAction, callId?: string) => void;
}) {
    const {request} = useAgentActivityNavigation();
    const [expanded, setExpanded] = useState(opensProcess(run.status));
    const [hasExpanded, setHasExpanded] = useState(opensProcess(run.status));
    const previousStatus = useRef(run.status);
    const sectionRef = useRef<HTMLElement>(null);
    const positionedRequest = useRef<number | undefined>(undefined);
    const panelId = useId();
    const ownedCalls = useMemo(() => calls.filter((call) => call.runId === run.id && call.threadId === run.threadId), [run.id, run.threadId, calls]);
    const activity = useMemo(() => buildRunActivity(run, ownedCalls, steered), [run, ownedCalls, steered]);
    const actions = useMemo(() => runActionState(run, ownedCalls), [run, ownedCalls]);
    const {recoverable, pendingApproval, budgetPaused} = actions;
    const echo = liveRoundEcho(run, message, ownedCalls);
    const currentReasoning = echo.reasoning ? "" : message.reasoning?.trim();
    const currentContent = run.status === "running" && !echo.content ? message.content : "";
    const reasoningActive = run.status === "running" && !!currentReasoning && !currentContent;
    const toolCount = ownedCalls.filter((call) => call.effect !== "bookkeeping").length;
    const running = run.status === "running";
    // Plain replies without tools, reasoning or plan have no process to disclose.
    const hasProcess = running || ownedCalls.length > 0 || activity.length > 0 || Boolean(currentReasoning) || Boolean(run.plan?.length);

    useEffect(() => {
        if (expanded) setHasExpanded(true);
    }, [expanded]);

    useEffect(() => {
        if (previousStatus.current !== run.status) {
            // Transition only: database updates must never undo a manual toggle.
            if (opensProcess(run.status)) setExpanded(true);
            else if (["completed", "cancelled", "failed", "interrupted"].includes(run.status)) setExpanded(false);
            previousStatus.current = run.status;
        }
    }, [run.status]);

    useEffect(() => {
        if (request?.runId !== run.id || positionedRequest.current === request.key) return;
        setExpanded(true);
        if (request.callId && !calls.some((call) => call.id === request.callId)) return;
        const frame = requestAnimationFrame(() => {
            const section = sectionRef.current;
            if (!section || section.closest("[inert]")) return;
            positionedRequest.current = request.key;
            const target = request.callId
                ? [...section.querySelectorAll<HTMLElement>("[data-activity-call]")].find((element) => element.dataset.activityCall === request.callId) ?? section
                : section;
            const list = section.closest<HTMLElement>(".agent-message-list");
            if (list) list.scrollTop += target.getBoundingClientRect().top - list.getBoundingClientRect().top - 64;
            // Batch dialog manages its own focus. Approval/recovery navigation focuses the visible control.
            if (!request.batchId) target.querySelector<HTMLElement>("button:not([disabled])")?.focus({preventScroll: true});
        });
        return () => cancelAnimationFrame(frame);
    }, [request, run.id, calls]);

    return <section ref={sectionRef} className="agent-run-activity agent-execution-activity" aria-label="执行过程"
                    data-activity-run={run.id}>
        {hasProcess && <button type="button" className="agent-run-summary agent-execution-summary"
                               aria-expanded={expanded} aria-controls={panelId}
                               onClick={() => setExpanded((value) => !value)}>
            {running && <LoaderCircle size={12} className="animate-spin motion-reduce:animate-none" aria-hidden/>}
            <span>{running ? (toolCount > 0 ? `进行中 · 已用 ${toolCount} 个工具` : "进行中") : toolCount > 0 ? `用了 ${toolCount} 个工具` : "过程记录"}</span>
            <ChevronDown size={14} className={expanded ? "rotate-180" : ""} aria-hidden/>
        </button>}
        <AgentWriteOutcomes run={run} calls={ownedCalls}/>
        {hasProcess && !expanded && steered.map(item => <SteeredMessage key={item.id} message={item}/>)}
        <div id={panelId} className="agent-execution-timeline" hidden={hasProcess && !expanded}>
            {(expanded || hasExpanded) && <>
                {activity.map((item) => item.kind === "user"
                    ? <SteeredMessage key={item.id} message={item.message}/>
                    : item.kind === "text"
                    ? <div key={item.id} data-agent-public="true"><Markdown {...MARKDOWN_PROPS}
                                className="agent-activity-narrative">{item.content}</Markdown></div>
                    : item.kind === "reasoning"
                        ? <ThinkingPanel key={item.id} reasoning={item.content} active={false}
                                         durationMs={item.durationMs}/>
                        : <ToolGroup key={item.id} calls={item.calls} run={run} busy={busy} readOnly={readOnly}
                                     actions={actions} onAction={onAction}/>)}
                {currentReasoning && <ThinkingPanel reasoning={currentReasoning} active={reasoningActive}
                                                    output={{runId: run.id, assistantMessageId: message.id}}
                                                    durationMs={message.reasoningDurationMs}/>}
                {currentContent &&
                    <PublicOutputCommit output={{runId: run.id, assistantMessageId: message.id}} text={currentContent}>
                        <div data-agent-public="true"><Markdown {...MARKDOWN_PROPS} className="agent-activity-narrative">{currentContent}</Markdown></div></PublicOutputCommit>}
                {run.plan && run.plan.length > 0 && <details className="agent-activity-plan">
                    <summary>执行计划
                        · {run.plan.filter((step) => step.status === "completed").length}/{run.plan.length}<ChevronDown
                            size={12} aria-hidden/></summary>
                    <ol className="agent-run-plan" aria-label="本次执行计划">{run.plan.map((step) => <li key={step.id}>
                        <StepIcon
                            status={step.status === "completed" ? "completed" : step.status === "in_progress" ? "running" : "pending"}/>
                        <span>{step.title}{step.status !== "completed" &&
                            <small>{step.status === "in_progress" ? "进行中" : "待办"}</small>}</span>
                    </li>)}</ol>
                </details>}
            </>}
            {/* Keep mounted: review dialogs own unsaved drafts and navigation guards. */}
            <AgentGenerationResults runId={run.id}/>
            {!readOnly && recoverable && !pendingApproval && <p className="agent-action-hint">
                {budgetPaused ? "已暂停，可在输入框上方继续" : "执行未完成，可在输入框上方继续或结束"}</p>}
        </div>
    </section>;
}
