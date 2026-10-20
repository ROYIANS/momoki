import {GITHUB_URL} from "@momoki/distribution/brand";
import {isTauriRuntime} from "../runtime/runtimeIdentity";
import {getBreadcrumbs} from "./breadcrumbs";
import {sanitizePath, sanitizeText} from "./sanitize";

export type ErrorInfo = {
    name: string;
    message: string;
    stack?: string;
    certainty?: "rollback" | "unknown";
    code?: string;
};

export type DiagnosticContext = {
    version: string;
    environment: "browser" | "tauri";
    platform: string;
    route: string;
    time: string;
};

const MAX_STACK_LINES = 20;

function field(value: unknown, key: string): unknown {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function certaintyOf(cause: unknown): ErrorInfo["certainty"] {
    const direct = field(cause, "certainty");
    if (direct === "rollback" || direct === "unknown") return direct;
    const effect = field(field(cause, "failure"), "effectCertainty") ?? field(cause, "effectCertainty");
    return effect === "unknown" ? "unknown" : undefined;
}

/** Normalizes any thrown value; every string passes through sanitizeText. Properties other than the known ones are never read. */
export function toErrorInfo(cause: unknown): ErrorInfo {
    try {
        const isError = cause instanceof Error;
        const name = isError ? cause.name : "NonError";
        const message = isError ? cause.message : typeof cause === "string" ? cause : "非 Error 对象被抛出";
        const stack = isError && cause.stack ? cause.stack.split("\n").slice(0, MAX_STACK_LINES).join("\n") : undefined;
        const rawCode = field(cause, "code") ?? field(field(cause, "failure"), "code");
        const info: ErrorInfo = {name: sanitizeText(name, 100), message: sanitizeText(message)};
        if (stack) info.stack = sanitizeText(stack, 4000);
        const certainty = certaintyOf(cause);
        if (certainty) info.certainty = certainty;
        if (typeof rawCode === "string") info.code = sanitizeText(rawCode, 100);
        return info;
    } catch {
        return {name: "Error", message: "[已隐藏]"};
    }
}

/** Version is injected by Vite `define`; tests and fixtures fall back to "dev". */
function appVersion(): string {
    return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
}

export function collectDiagnosticContext(): DiagnosticContext {
    const nav = typeof navigator === "undefined" ? undefined : navigator;
    const route = typeof window === "undefined" ? "" : window.location.pathname;
    return {
        version: appVersion(),
        environment: isTauriRuntime() ? "tauri" : "browser",
        platform: sanitizeText(nav?.userAgent ?? "unknown", 300),
        route: sanitizePath(route),
        time: new Date().toISOString(),
    };
}

/** Plain-text report. Contains no chat, prompt or creative content: only the sanitized error and operation trail. */
export function buildDiagnosticReport(info: ErrorInfo, context: DiagnosticContext): string {
    const lines = [
        "Momoki 诊断信息",
        `版本: ${context.version}`,
        `环境: ${context.environment}`,
        `平台: ${context.platform}`,
        `路由: ${context.route}`,
        `时间: ${context.time}`,
        "",
        `错误: ${info.name}`,
        `消息: ${info.message}`,
    ];
    if (info.code) lines.push(`代码: ${info.code}`);
    if (info.certainty) lines.push(`结果确定性: ${info.certainty}`);
    if (info.stack) lines.push("", "堆栈:", info.stack);
    const crumbs = getBreadcrumbs();
    lines.push("", `最近操作 (${crumbs.length}):`);
    for (const crumb of crumbs) lines.push(`- ${crumb.at} ${crumb.kind} ${crumb.label}`);
    return lines.join("\n");
}

export const ISSUE_URL_LIMIT = 1800;

/** Prefilled issue: sanitized summary and version only, never the full stack. */
export function buildIssueUrl(info: ErrorInfo, context: DiagnosticContext): string {
    const title = `[错误] ${info.name}: ${info.message.split("\n")[0] ?? ""}`;
    const bodyOf = (message: string) => [
        `版本: ${context.version}`,
        `环境: ${context.environment}`,
        `路由: ${context.route}`,
        `错误: ${info.name}`,
        `摘要: ${message}`,
        "",
        "完整诊断信息可在应用的错误详情中复制后粘贴到此处。",
    ].join("\n");
    let message = (info.message.split("\n")[0] ?? "").slice(0, 300);
    const make = () => `${GITHUB_URL}/issues/new?title=${encodeURIComponent(title.slice(0, 120))}&body=${encodeURIComponent(bodyOf(message))}`;
    let url = make();
    while (url.length > ISSUE_URL_LIMIT && message.length > 0) {
        message = message.slice(0, Math.floor(message.length / 2));
        url = make();
    }
    return url;
}
