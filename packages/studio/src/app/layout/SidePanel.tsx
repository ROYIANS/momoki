import type {ReactNode} from "react";
import type {ContextPanelHostCloseReason} from "./ContextPanelHost";
import {
    ContextPanel,
    ContextPanelContent,
    ContextPanelDescription,
    ContextPanelFooter,
    ContextPanelHeader,
    ContextPanelTitle
} from "./context-panel";

/**
 * The common shape of a form or picker that lives in the right side panel instead of a dialog: a heading, a body
 * that scrolls, and confirm/cancel pinned at the bottom. Pass `footer` only for something the user must decide.
 */
export function SidePanel({open, onOpenChange, onRequestDeparture, kind, title, description, width = 440, footer, children}: {
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
}) {
    return <ContextPanel open={open} onOpenChange={onOpenChange} onRequestDeparture={onRequestDeparture} kind={kind}
                         title={title} width={width}>
        <ContextPanelContent className="side-panel agent-chat-root css-var-agent-chat">
            <ContextPanelHeader className="side-panel-header">
                <ContextPanelTitle>{title}</ContextPanelTitle>
                {description ? <ContextPanelDescription>{description}</ContextPanelDescription> :
                    <ContextPanelDescription className="sr-only">{title}</ContextPanelDescription>}
            </ContextPanelHeader>
            <div className="side-panel-body">{children}</div>
            {footer ? <ContextPanelFooter>{footer}</ContextPanelFooter> : null}
        </ContextPanelContent>
    </ContextPanel>;
}
