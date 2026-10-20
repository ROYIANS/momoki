import type {AgentRun} from "./agent";
import type {ChatSubmissionAttempt} from "./chatSubmissionAttempt";

type TurnProblemKind = "unsent" | "interrupted" | "failed" | "stopped";
/** Every action maps onto an existing owner behaviour; the bubble never invents recovery. */
export type TurnProblemActionKind = "retry-send" | "retry-run" | "continue" | "end" | "check" | "recover" | "confirm";

interface TurnProblemAction {kind: TurnProblemActionKind; label: string}

export interface TurnProblem {
    /** Dismissal identity: a new failure always has a new id. */
    id: string;
    kind: TurnProblemKind;
    /** One short reason from a small mapped set; never a status paragraph. */
    reason: string;
    /** Raw/unknown detail for a tooltip only. */
    detail?: string;
    action?: TurnProblemAction;
    secondary?: TurnProblemAction;
    submissionId?: string;
    runId?: string;
    /** Unresolved sends must stay actionable, so they cannot be closed. */
    dismissible: boolean;
    /** A check/recovery is in flight. */
    pending?: boolean;
}

export type TurnProblemRun = Pick<AgentRun, "id" | "status" | "hasToolCalls" | "pauseReason" | "error">;

const NETWORK = /网络|network|fetch|ECONN|ENOTFOUND|timeout|timed out|超时|offline|断开|连接失败/i;
const MODEL = /模型|model|provider|供应商|HTTP|\b[45]\d\d\b|返回|rate|quota|额度/i;
const RESTART = /已中断|上次生成|重启/;

/** Small mapped reason set; unknown text collapses into a generic reason with the raw text kept as detail. */
export function describeProblemReason(raw: string | undefined, fallback: string): {reason: string; detail?: string} {
    const text = raw?.trim();
    if (!text) return {reason: fallback};
    if (RESTART.test(text)) return {reason: "应用重启后已中断"};
    if (NETWORK.test(text)) return {reason: "网络中断", detail: text};
    if (MODEL.test(text)) return {reason: "模型返回错误", detail: text};
    return {reason: fallback, detail: text};
}

function attemptProblem(attempts: readonly ChatSubmissionAttempt[]): TurnProblem | undefined {
    const latest = [...attempts].filter(attempt => attempt.phase === "failed" || attempt.phase === "uncertain" ||
        attempt.phase === "checking" || (attempt.phase === "accepted" && attempt.recoveryRequired))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    if (!latest) return undefined;
    const id = latest.admission.userMessageId;
    const base = {submissionId: id};
    if (latest.phase === "checking") return {...base, id: `attempt:${id}:checking`, kind: "unsent", reason: "正在检查发送状态…",
        dismissible: false, pending: true};
    if (latest.phase === "uncertain") return {...base, id: `attempt:${id}:uncertain`, kind: "unsent", reason: "发送未确认",
        detail: latest.error && latest.error !== "发送未确认" ? latest.error : undefined, dismissible: false,
        action: {kind: "check", label: "检查"}, secondary: {kind: "confirm", label: "确认未发送"}};
    if (latest.phase === "accepted") return {...base, id: `attempt:${id}:recover`, kind: "interrupted", reason: "发送状态待恢复",
        dismissible: false, action: {kind: "recover", label: "恢复"}};
    const stopped = latest.error === "发送已停止";
    const detail = describeProblemReason(stopped ? undefined : latest.error, "消息未发送").detail;
    return {...base, id: `attempt:${id}:failed`, kind: stopped ? "stopped" : "unsent", reason: stopped ? "已停止发送" : "消息未发送",
        detail: detail && detail !== "未发送" ? detail : undefined, dismissible: true, action: {kind: "retry-send", label: "重试"}};
}

function runProblem(run: TurnProblemRun | undefined, readOnly: boolean): TurnProblem | undefined {
    if (!run || (run.status !== "failed" && run.status !== "interrupted")) return undefined;
    const paused = run.pauseReason === "model_step_limit";
    const failed = run.status === "failed";
    const mapped = paused ? {reason: "已暂停"} : describeProblemReason(run.error, failed ? "执行失败" : "执行已中断");
    const action: TurnProblemAction | undefined = readOnly ? undefined : run.hasToolCalls ?
        {kind: "continue", label: "继续"} : {kind: "retry-run", label: "重试"};
    // A run that already made tool calls holds the thread until it is continued or ended, so ending is offered too.
    const secondary: TurnProblemAction | undefined = !readOnly && run.hasToolCalls ? {kind: "end", label: "结束"} : undefined;
    return {id: `run:${run.id}:${run.status}`, runId: run.id, kind: failed ? "failed" : "interrupted",
        reason: mapped.reason, detail: "detail" in mapped ? mapped.detail : undefined, dismissible: true, action,
        ...(secondary ? {secondary} : {})};
}

/**
 * One problem per thread, latest wins: an unsent/unresolved send, then a freshly reported operation error,
 * then the latest run outcome. Nothing is derived while a model invocation owns the thread.
 */
export function deriveTurnProblem(input: {
    attempts: readonly ChatSubmissionAttempt[];
    run?: TurnProblemRun;
    executionError?: string;
    executionErrorId?: string;
    active: boolean;
    readOnly: boolean;
}): TurnProblem | undefined {
    if (input.active) return undefined;
    const attempt = attemptProblem(input.attempts);
    if (attempt) return attempt;
    const run = runProblem(input.run, input.readOnly);
    const error = input.executionError;
    // The generic owner error only says "something ended"; the run outcome carries the real reason and action.
    if (error && !(run && error === "执行未完成")) {
        const mapped = describeProblemReason(error, "执行未完成");
        return {id: input.executionErrorId ?? `error:${error}`, kind: "failed", reason: mapped.reason, detail: mapped.detail ?? (mapped.reason === error ? undefined : error),
            runId: run?.runId, dismissible: true, action: run?.action};
    }
    return run;
}
