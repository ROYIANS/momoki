import {useCallback, useRef, type RefObject} from "react";
import {ContextPanel, ContextPanelContent, ContextPanelDescription, ContextPanelHeader, ContextPanelTitle} from "../../../app/layout/context-panel";
import {useManualDraftDeparture} from "../../../app/drafts/useManualDraftGuard";
import {useMcpManagement} from "../mcp/ui/management";
import {McpManagementBody} from "../mcp/ui/McpManagementBody";
import "../mcp/ui/mcpConnections.css";

export function McpConnectionsPanel({open, onOpenChange, returnFocus, returnLabel = "返回对话", inline = false}: {inline?: boolean; open: boolean; onOpenChange: (open: boolean) => void; returnFocus?: RefObject<HTMLButtonElement | null>; returnLabel?: string}) {
    const {owner, state} = useMcpManagement();
    const currentOpen = useRef(open); currentOpen.current = open;
    const discard = useCallback(() => owner?.discardDraft(), [owner]);
    const readState = useCallback(() => ({dirty: !!owner?.getSnapshot().draft?.dirty, pending: !!owner?.isPending()}), [owner]);
    const departure = useManualDraftDeparture(!!state.draft?.dirty, !!owner?.isPending(), discard, {readState});
    const back = () => departure.requestDeparture(() => {owner?.discardDraft(); owner?.select(undefined);}, discard);
    let title = "MCP 连接";
    if (state.draft) title = state.draft.replacement ? "替换连接配置" : "添加 MCP 连接";
    const restoreFocus = () => {
        // A draft confirmation may still own focus after the panel frame leaves.
        // Observe its actual removal and workspace inert release instead of racing animation frames.
        const target = returnFocus?.current;
        if (!target) return;
        const timeout = setTimeout(() => observer.disconnect(), 1000);
        const restore = () => {
            if (currentOpen.current || !target.isConnected) {observer.disconnect(); clearTimeout(timeout); return;}
            if (target.closest("[inert]") || document.querySelector('[role="alertdialog"]')) return;
            const active = document.activeElement;
            if (active && active !== document.body && active.isConnected) {
                if (active.closest('[data-slot="context-panel-content"]')) return;
                observer.disconnect(); clearTimeout(timeout); return;
            }
            target.focus({preventScroll: true});
            observer.disconnect(); clearTimeout(timeout);
        };
        const observer = new MutationObserver(restore);
        observer.observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ["inert"]});
        queueMicrotask(restore);
    };
    const content = <div className="mcp-scroll app-scroll">{owner ? <McpManagementBody owner={owner} state={state} onBack={back}/>
        : <p className="mcp-hint" role="alert">当前运行环境未提供 MCP 服务。请使用桌面端，或重新打开支持远程连接的浏览器工作区。</p>}</div>;
    if (inline) return <><div className="mcp-panel mcp-inline" data-mcp-management>{content}</div>{departure.confirmation}</>;
    return <><ContextPanel kind="mcp" open={open} width={520} onOpenChange={(next, reason) => {
        if (!next && reason !== "guard-refused" && reason !== "busy") owner?.discardDraft();
        onOpenChange(next);
    }} onRequestDeparture={(proceed, cancel) => departure.requestDeparture(proceed, discard, cancel)}>
        <ContextPanelContent className="mcp-panel" data-mcp-management returnLabel={returnLabel} onCloseAutoFocus={restoreFocus}>
            <ContextPanelHeader><ContextPanelTitle>{title}</ContextPanelTitle>
                <ContextPanelDescription>管理当前设备的外部工具与资源。连接变化对新执行生效。</ContextPanelDescription></ContextPanelHeader>
            {content}
        </ContextPanelContent>
    </ContextPanel>{departure.confirmation}</>;
}
