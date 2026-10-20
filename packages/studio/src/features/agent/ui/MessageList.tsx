import {useObservedReadProbe} from "./threadReadVisibility";
import {AgentMarkdown as Markdown} from "./AgentMarkdown";
import {ReferenceMessageSources} from "./ReferenceAttachments";
import {ModelIcon} from "./ModelIcons";
import {ArrowDown, Coins, Gauge} from "../../../ui/icons";
import {formatTokenCount} from "../runtime/contextUsage";
import {AgentRunDetails} from "./AgentRunDetails";
import type {RunAction} from "../models/chatRunAction";
import type {AgentRun, AgentToolCall} from "../models/agent";
import {liveRoundEcho} from "../runtime/runPresentation";
import {useAgentActivityNavigation} from "./AgentActivityNavigation";
import {CopyButton, Text} from "@lobehub/ui";
import {Fragment, memo, type ReactNode, useCallback, useLayoutEffect, useRef, useState} from "react";
import type {ChatMessage} from "../models/chat";
import {isChatNearBottom, snapChatToBottom} from "../presentation/chatScroll";
import {ThinkingMatrix} from "./ThinkingMatrix";
import {ThinkingPanel} from "./ThinkingPanel";
import {MemoryRunHistory} from "./MemoryContextDetails";
import {TurnNavigation} from "./TurnNavigation";
import {SubmissionMessage} from "./SubmissionMessage";
import {submissionTranscript, type ChatSubmissionAttempt} from "../models/chatSubmissionAttempt";
import {PublicOutputCommit} from "./ExecutionFeedback";
import {SystemNoteLine} from "./SystemNoteLine";

/**
 * Failed/interrupted turns are told once, by the bubble above the composer. The stream keeps only a deliberate
 * stop, plus a bare marker when a failed turn left nothing else to read, so the reader can still acknowledge it.
 */
export function presentMessageStatus(message: Pick<ChatMessage, "status" | "content">): {text: string; tone: "muted"} | undefined {
    if (message.status === "aborted") return {text: "已停止", tone: "muted"};
    if ((message.status === "error" || message.status === "interrupted") && !message.content.trim()) return {text: "未完成", tone: "muted"};
    return undefined;
}

const EMPTY_CALLS: AgentToolCall[] = [];
const MARKDOWN_PROPS = {variant: "chat"} as const;

/**
 * Message list — assistant text is drawn directly (no avatar/title/bubble); users keep a right bubble.
 * Stick with `scrollTop` on this element (not `scrollIntoView` smooth).
 * History rows are memoized so Dexie liveQuery ticks only paint the streaming item.
 */
export function MessageList({threadId, messages, runs, calls = EMPTY_CALLS, observedRevision = 0, busy, readOnly, onRunAction, submissions = [], footer, onSubmissionObserved}: {
    threadId: string | undefined;
    messages: ChatMessage[] | undefined;
    runs?: AgentRun[];
    calls?: AgentToolCall[];
    observedRevision?: number;
    busy: boolean;
    readOnly?: boolean;
    onRunAction: (runId: string, action: RunAction, callId?: string) => void;
    submissions?: ChatSubmissionAttempt[];
    /** Turn footer: live run status or run error after the last message. */
    footer?: ReactNode;
    onSubmissionObserved?: (id: string) => void;
}) {
    const {request} = useAgentActivityNavigation();
    const listRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const stickToBottom = useRef(true);
    const manuallyNavigated = useRef(false);
    const observedSurface = useRef<HTMLDivElement | null>(null);
    useObservedReadProbe({threadId, revision: observedRevision, surface: observedSurface, viewport: listRef, following: stickToBottom});
    const [followingPaused, setFollowingPaused] = useState(false);
    const setFollowing = useCallback((following: boolean) => {
        if (stickToBottom.current === following) return;
        stickToBottom.current = following;
        setFollowingPaused(!following);
    }, []);
    const pauseFollowing = useCallback(() => {
        manuallyNavigated.current = true;
        setFollowing(false);
    }, [setFollowing]);
    const resumeFollowing = useCallback(() => {
        manuallyNavigated.current = false;
        setFollowing(true);
        if (listRef.current) snapChatToBottom(listRef.current);
    }, [setFollowing]);
    const list = messages ?? [];
    // A system event row is a user row for protocol/retry purposes, but not a turn the reader wrote.
    // A message steered into a run is shown inside that run's timeline, where the run took it in, not as its own row.
    // Only a run that is loaded can host it; otherwise the row stays a normal bubble rather than vanishing.
    const loadedRuns = new Set((runs ?? []).map(run => run.id));
    const hostedRuns = new Set(list.filter(message => message.role === "assistant" && message.runId && loadedRuns.has(message.runId)).map(message => message.runId));
    const isHostedSteer = (message: ChatMessage) => message.role === "user" && Boolean(message.steeredIntoRunId) && hostedRuns.has(message.steeredIntoRunId);
    const steeredByRun = new Map<string, ChatMessage[]>();
    for (const message of list) if (isHostedSteer(message)) steeredByRun.set(message.steeredIntoRunId!, [...steeredByRun.get(message.steeredIntoRunId!) ?? [], message]);
    const userMessages = list.filter((message) => message.role === "user" && message.origin !== "system" && !isHostedSteer(message));
    const entries = submissionTranscript(messages, submissions).filter(entry => entry.kind === "attempt" || !isHostedSteer(entry.message));
    const lastUser = entries.filter(entry => entry.kind === "attempt" || entry.message.role === "user").at(-1);
    const lastUserId = lastUser?.kind === "attempt" ? lastUser.attempt.admission.userMessageId : lastUser?.message.id;
    useLayoutEffect(() => {
        for (const attempt of submissions) {
            if (attempt.phase === "accepted" && !attempt.recoveryRequired && messages?.some(message => message.id === attempt.admission.userMessageId &&
                message.threadId === attempt.threadId && message.role === "user")) onSubmissionObserved?.(attempt.admission.userMessageId);
        }
    }, [submissions, messages, onSubmissionObserved]);
    useLayoutEffect(() => {
        resumeFollowing();
        const el = listRef.current;
        if (!el) return;
        const frame = requestAnimationFrame(() => {
            if (stickToBottom.current) snapChatToBottom(el);
        });
        return () => cancelAnimationFrame(frame);
    }, [threadId, resumeFollowing]);

    useLayoutEffect(() => {
        // A new user turn resumes following; streaming updates to an existing turn do not.
        if (lastUserId) resumeFollowing();
    }, [lastUserId, resumeFollowing]);

    useLayoutEffect(() => {
        if (request) pauseFollowing();
    }, [request, pauseFollowing]);

    useLayoutEffect(() => {
        const el = listRef.current;
        const content = contentRef.current;
        if (!el || !content) return;
        const ro = new ResizeObserver(() => {
            if (stickToBottom.current) snapChatToBottom(el);
        });
        ro.observe(content);
        return () => ro.disconnect();
    }, [threadId]);

    return (
        <div className={`agent-message-navigation-shell${userMessages.length >= 5 ? " has-turn-navigation" : ""}`}>
            <div
                ref={listRef}
                className="agent-message-list"
                tabIndex={-1}
                role="region"
                aria-label="对话消息"
                onPointerDownCapture={(event) => {
                    if (event.target === listRef.current) manuallyNavigated.current = false;
                    if (event.target instanceof Element && event.target.closest(".agent-execution-activity button, .agent-execution-activity summary")) pauseFollowing();
                }}
                onKeyDownCapture={(event) => {
                    if (["PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp"].includes(event.key)) manuallyNavigated.current = false;
                    if ((event.key === "Enter" || event.key === " ") && event.target instanceof Element && event.target.closest(".agent-execution-activity")) pauseFollowing();
                }}
                onWheel={() => {
                    manuallyNavigated.current = false;
                }}
                onTouchStart={() => {
                    manuallyNavigated.current = false;
                }}
                onScroll={() => {
                    const el = listRef.current;
                    if (el && !manuallyNavigated.current) setFollowing(isChatNearBottom(el));
                }}
            >
                <div ref={contentRef} className="agent-content">
                    {messages === undefined ? (
                        <Text type="secondary">加载中…</Text>
                    ) : (
                        entries.map(entry => {
                            if (entry.kind === "attempt") return <SubmissionMessage key={entry.attempt.admission.userMessageId}
                                attempt={entry.attempt}/>;
                            const message = entry.message;
                            if (message.role === "system") return null;
                            if (message.role === "user" && message.origin === "system") {
                                return <Fragment key={message.id}><SystemNoteLine message={message}/></Fragment>;
                            }
                            return (
                                <Fragment key={message.id}><div ref={message.role === "assistant" && message.publicRevision === observedRevision && observedRevision > 0 ? observedSurface : undefined}
                                    data-public-revision={message.publicRevision}><AgentChatMessageItem message={message}
                                                      run={runs?.find((run) => run.id === message.runId)} calls={calls.filter(call => call.runId === message.runId)}
                                                      steered={message.runId ? steeredByRun.get(message.runId) : undefined} busy={busy}
                                                      readOnly={readOnly} onRunAction={onRunAction}/></div></Fragment>
                            );
                        })
                    )}
                    {footer}
                </div>
            </div>
            <TurnNavigation messages={list} listRef={listRef} contentRef={contentRef} onNavigate={pauseFollowing}/>
            {followingPaused && <button type="button" className="agent-return-to-latest" aria-label="返回最新" onClick={() => {
                resumeFollowing();
                listRef.current?.focus({preventScroll: true});
            }}><ArrowDown size={18} aria-hidden/></button>}
        </div>
    );
}

function sameSteered(a: ChatMessage[] | undefined, b: ChatMessage[] | undefined) {
    if (a === b) return true;
    if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
    return (a ?? []).every((item, index) => item.id === b![index].id && item.content === b![index].content && item.steeredAfterStep === b![index].steeredAfterStep);
}

const AgentChatMessageItem = memo(
    function AgentChatMessageItem({
                                      message,
                                      run,
                                      calls,
                                      steered,
                                      busy,
                                      readOnly,
                                      onRunAction,
                                  }: {
        message: ChatMessage;
        run?: AgentRun;
        calls: AgentToolCall[];
        steered?: ChatMessage[];
        busy: boolean;
        readOnly?: boolean;
        onRunAction: (runId: string, action: RunAction, callId?: string) => void;
    }) {
        const isUser = message.role === "user";
        const echo = !isUser && run ? liveRoundEcho(run, message, calls) : undefined;
        // While the process is open, a sentence already in the timeline stays there.
        // A reasoning change must not print it again under the tools.
        const processOwnsContent = !isUser && !!run && (
            run.status === "running" ||
            (!!echo?.content && (echo.reasoning || run.status === "waiting_approval"))
        );
        const reasoningText = message.reasoning?.trim() ?? "";
        const hasReasoning = reasoningText.length > 0;
        const reasoningActive =
            !isUser &&
            message.status === "streaming" &&
            hasReasoning &&
            !message.content;
        const showMatrix =
            !isUser && !run &&
            message.status === "streaming" &&
            !message.content &&
            !hasReasoning;
        const showCopy = !isUser && !processOwnsContent && Boolean(message.content) && message.status !== "streaming";
        const text = showMatrix || processOwnsContent ? "" : message.content;
        const statusLine = presentMessageStatus(message);
        const time = new Date(message.createdAt);
        const timeLabel = Number.isNaN(time.getTime()) ? undefined : time.toLocaleString();

        if (isUser) {
            return (
                <div className="agent-transcript-item agent-transcript-user" data-turn-anchor={message.id}
                     title={timeLabel}>
                    <div className="agent-user-bubble">
                        <ReferenceMessageSources context={message.referenceContext} content={message.content}/>
                        <Markdown {...MARKDOWN_PROPS}>{message.content}</Markdown>
                    </div>
                </div>
            );
        }
        return (
            <div className="agent-transcript-item agent-assistant-transcript">
                {run && <AgentRunDetails run={run} message={message} calls={calls} steered={steered} busy={busy} readOnly={readOnly}
                                         onAction={onRunAction}/>}
                {!run && hasReasoning && <ThinkingPanel reasoning={message.reasoning ?? ""} active={reasoningActive}
                                                        durationMs={message.reasoningDurationMs}/>}
                {showMatrix && <ThinkingMatrix/>}
                {text && (run ? <PublicOutputCommit output={{runId: run.id, assistantMessageId: message.id}} text={text}>
                    <div data-agent-public="true"><Markdown {...MARKDOWN_PROPS}>{text}</Markdown></div></PublicOutputCommit> : <div data-agent-public="true"><Markdown {...MARKDOWN_PROPS}>{text}</Markdown></div>)}
                <div className="agent-message-footer">
                    <ReferenceMessageSources run={run} content={processOwnsContent ? "" : message.content}/>
                    <div className="agent-message-meta">
                        {showCopy && <CopyButton content={message.content} title="复制" size="small"/>}
                        {run && <MemoryRunHistory run={run} readOnly={readOnly}/>}
                        <span className="agent-message-hover-info">
                            {timeLabel && <span>{timeLabel}</span>}
                            {run?.model && <span className="agent-model-attribution" title={run.model}><ModelIcon
                                model={run.model} size={14}/>{run.model}</span>}
                            {run?.outputTokensPerSecond !== undefined && <span className="agent-model-attribution"
                                                                               title="生成速度：供应商返回的输出 token ÷ 流式生成耗时（不含工具和审批等待）"><Gauge
                                size={12}/>{run.outputTokensPerSecond.toFixed(1)} tok/s</span>}
                            {run?.usage?.totalTokens !== undefined && <span className="agent-model-attribution"
                                                                            title={`输入 ${run.usage.inputTokens?.toLocaleString() ?? "未知"}，输出 ${run.usage.outputTokens?.toLocaleString() ?? "未知"}`}><Coins
                                size={12}/>{formatTokenCount(run.usage.totalTokens)}</span>}
                        </span>
                    </div>
                    {statusLine && <div className="agent-message-status">
                        <span data-agent-public="true" role="status">{statusLine.text}</span>
                    </div>}
                </div>
            </div>
        );
    },
    (prev, next) =>
        JSON.stringify(prev.calls) === JSON.stringify(next.calls) &&
        prev.message.publicRevision === next.message.publicRevision &&
        prev.run?.id === next.run?.id &&
        prev.run?.updatedAt === next.run?.updatedAt &&
        prev.run?.status === next.run?.status &&
        prev.run?.pauseReason === next.run?.pauseReason &&
        prev.run?.usage?.totalTokens === next.run?.usage?.totalTokens &&
        prev.run?.usage?.inputTokens === next.run?.usage?.inputTokens &&
        prev.run?.usage?.outputTokens === next.run?.usage?.outputTokens &&
        prev.run?.outputTokensPerSecond === next.run?.outputTokensPerSecond &&
        prev.busy === next.busy &&
        prev.readOnly === next.readOnly &&
        prev.onRunAction === next.onRunAction &&
        prev.run?.referenceAudit?.length === next.run?.referenceAudit?.length &&
        prev.run?.referenceAudit?.at(-1)?.preparedAt === next.run?.referenceAudit?.at(-1)?.preparedAt &&
        prev.message.error === next.message.error &&
        prev.message.runId === next.message.runId &&
        prev.message.id === next.message.id &&
        prev.message.content === next.message.content &&
        prev.message.status === next.message.status &&
        prev.message.role === next.message.role &&
        prev.message.origin === next.message.origin &&
        prev.message.steeredIntoRunId === next.message.steeredIntoRunId &&
        sameSteered(prev.steered, next.steered) &&
        prev.message.createdAt === next.message.createdAt &&
        prev.message.reasoning === next.message.reasoning &&
        prev.message.reasoningDurationMs === next.message.reasoningDurationMs,
);
