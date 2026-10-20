import {type ReactNode, useEffect, useRef} from "react";
import {createPortal} from "react-dom";
import type {ContextPanelHostCloseReason} from "./ContextPanelHost";
import {useContextPanelHost} from "./ContextPanelHost";
import {
    ContextPanel,
    ContextPanelContent,
    ContextPanelDescription,
    ContextPanelFooter,
    ContextPanelHeader,
    ContextPanelTitle,
    useInsidePanel
} from "./context-panel";
import {ArrowLeft} from "../../ui/icons";

type SidePanelProps = {
    open: boolean;
    onOpenChange: (open: boolean, reason?: ContextPanelHostCloseReason) => void;
    onRequestDeparture?: (proceed: () => void, cancel?: () => void) => void;
    /** Names the panel type so a dragged width is remembered for it. */
    kind: string;
    title: string;
    description?: ReactNode;
    width?: number;
    footer?: ReactNode;
    children: ReactNode;
};

/** A sheet laid over the panel it was opened from, so that panel stays mounted and keeps its state. */
function PanelSheet({open, onOpenChange, title, description, footer, children}: SidePanelProps) {
    const host = useContextPanelHost();
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (open) ref.current?.focus({preventScroll: true});
    }, [open]);
    if (!open) return null;
    const sheet = <div ref={ref} className="side-panel-sheet agent-chat-root css-var-agent-chat" role="region" aria-label={title}
                       tabIndex={-1} onKeyDown={event => {
        if (event.key === "Escape" && !event.defaultPrevented) {
            event.stopPropagation();
            onOpenChange(false, "user");
        }
    }}>
        <button type="button" className="side-panel-sheet-back" onClick={() => onOpenChange(false, "user")}>
            <ArrowLeft className="size-4" aria-hidden/>返回
        </button>
        <div className="side-panel-header">
            <h2 className="text-foreground font-semibold">{title}</h2>
            {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
        </div>
        <div className="side-panel-body">{children}</div>
        {footer ? <div className="context-panel-footer">{footer}</div> : null}
    </div>;
    return host?.target ? createPortal(sheet, host.target) : sheet;
}

/**
 * The common shape of a form or picker that lives in the right side panel instead of a dialog: a heading, a body
 * that scrolls, and confirm/cancel pinned at the bottom. Opened from inside another panel it becomes a sheet over
 * that panel instead of replacing it. Pass `footer` only for something the user must decide.
 */
export function SidePanel(props: SidePanelProps) {
    const nested = useInsidePanel();
    const host = useContextPanelHost();
    // The top bar already names a docked panel; keep the heading for screen readers and for the overlay.
    const titleInTopbar = Boolean(host?.headerZone && host.docked);
    if (nested) return <PanelSheet {...props}/>;
    const {open, onOpenChange, onRequestDeparture, kind, title, description, width = 440, footer, children} = props;
    return <ContextPanel open={open} onOpenChange={onOpenChange} onRequestDeparture={onRequestDeparture} kind={kind}
                         title={title} width={width}>
        <ContextPanelContent className="side-panel agent-chat-root css-var-agent-chat">
            <ContextPanelHeader className="side-panel-header">
                <ContextPanelTitle className={titleInTopbar ? "sr-only" : undefined}>{title}</ContextPanelTitle>
                {description ? <ContextPanelDescription>{description}</ContextPanelDescription> :
                    <ContextPanelDescription className="sr-only">{title}</ContextPanelDescription>}
            </ContextPanelHeader>
            <div className="side-panel-body">{children}</div>
            {footer ? <ContextPanelFooter>{footer}</ContextPanelFooter> : null}
        </ContextPanelContent>
    </ContextPanel>;
}
