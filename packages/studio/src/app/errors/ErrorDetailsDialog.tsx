import {useMemo, useRef, useState, useSyncExternalStore} from "react";
import {Button} from "../../ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "../../ui/dialog";
import {buildDiagnosticReport, buildIssueUrl, collectDiagnosticContext} from "../../platform/diagnostics/errorReport";
import {getLatestError, subscribeLatestError} from "../../platform/diagnostics/reportError";
import {isTauriRuntime} from "../../platform/runtime/runtimeIdentity";
import {downloadBlob} from "../../platform/runtime/runtimeSave";
import {closeErrorDetails, getErrorDetailsOpen, subscribeErrorDetails} from "./errorDetailsStore";

export const NO_AUTO_SEND_NOTICE = "此信息不会自动发送，只在你点击时才复制、保存或打开。";

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

export function diagnosticFilename(date = new Date()): string {
    const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    return `momoki-diagnostic-${day}-${time}.txt`;
}

/**
 * Mounted once beside the application root (outside the router and the root error boundary),
 * so it works for route fallbacks, the root fallback and the storage-failure page alike.
 * Statuses are fixed strings and never echo error content.
 */
export function ErrorDetailsDialog() {
    const open = useSyncExternalStore(subscribeErrorDetails, getErrorDetailsOpen);
    const latest = useSyncExternalStore(subscribeLatestError, getLatestError);
    const [status, setStatus] = useState("");
    const textarea = useRef<HTMLTextAreaElement>(null);
    const report = useMemo(() => (open && latest ? buildDiagnosticReport(latest.info, collectDiagnosticContext()) : ""), [open, latest]);

    const selectAll = () => {
        textarea.current?.focus();
        textarea.current?.select();
    };
    const copy = async () => {
        try {
            if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
            await navigator.clipboard.writeText(report);
            setStatus("已复制到剪贴板");
        } catch {
            selectAll();
            setStatus("无法自动复制，已选中全文，请按 ⌘/Ctrl+C 手动复制");
        }
    };
    const save = async () => {
        try {
            const result = await downloadBlob(new Blob([report], {type: "text/plain;charset=utf-8"}), diagnosticFilename());
            setStatus(result === "saved" ? "已保存为文件" : "已取消保存");
        } catch {
            setStatus("保存失败，请改用复制");
        }
    };
    const openIssue = async () => {
        if (!latest) return;
        const url = buildIssueUrl(latest.info, collectDiagnosticContext());
        try {
            if (isTauriRuntime()) {
                const {nativeOpenExternalUrl} = await import("../../platform/runtime/nativeSystemServices");
                await nativeOpenExternalUrl(url);
            } else if (!window.open(url, "_blank", "noopener,noreferrer")) {
                throw new Error("blocked");
            }
            setStatus("已打开 GitHub，可粘贴完整诊断信息");
        } catch {
            setStatus("无法打开 GitHub，请先复制诊断信息后手动反馈");
        }
    };

    return (
        <Dialog open={open} onOpenChange={next => {
            if (!next) {
                setStatus("");
                closeErrorDetails();
            }
        }}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>错误详情</DialogTitle>
                    <DialogDescription>{NO_AUTO_SEND_NOTICE}</DialogDescription>
                </DialogHeader>
                {latest ? (
                    <textarea
                        ref={textarea}
                        readOnly
                        aria-label="诊断信息"
                        value={report}
                        className="h-64 w-full resize-none rounded-md border bg-background p-3 font-mono text-xs"
                    />
                ) : <p className="text-sm text-muted-foreground">暂无可导出的错误记录。</p>}
                <p role="status" className="min-h-5 text-sm text-muted-foreground">{status}</p>
                <DialogFooter>
                    <Button type="button" variant="outline" disabled={!latest} onClick={() => void openIssue()}>在
                        GitHub 反馈</Button>
                    <Button type="button" variant="outline" disabled={!latest}
                            onClick={() => void save()}>保存为文件</Button>
                    <Button type="button" disabled={!latest} onClick={() => void copy()}>复制诊断信息</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
