import {createContext, type ReactNode, useContext} from "react";
import {createPortal} from "react-dom";
import {useContextPanelHost} from "./ContextPanelHost";

/** Where a panel's own header actions go: the top bar's panel zone. */
export const PanelHeaderActionsContext = createContext<HTMLElement | null>(null);

/**
 * A panel keeps owning these actions; while docked they render in the top bar's panel zone. When the panel
 * covers the content instead (no panel zone exists), they stay at the top of the panel so they never vanish.
 */
export function ContextPanelHeaderActions({children}: { children: ReactNode }) {
    const target = useContext(PanelHeaderActionsContext);
    const host = useContextPanelHost();
    if (target && host?.headerZone && host.docked) return createPortal(children, target);
    return <div className="context-panel-actions-inline">{children}</div>;
}
