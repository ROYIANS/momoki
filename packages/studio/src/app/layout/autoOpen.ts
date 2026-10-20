import {useCallback, useEffect} from "react";
import {type ContextPanelHostCloseReason, useContextPanelHost} from "./ContextPanelHost";
import {shouldAutoOpenPanel} from "./panelWidth";

/**
 * Opens a panel once when something needs the user, without taking focus: only if no other panel is open and it
 * fits beside the content. A thing is offered once; closing it, or being replaced, does not bring it back.
 * Returns the open-change handler to give the panel, which records a close the user chose.
 */
export function useAutoOpenPanel({key, ready, open, width, setOpen}: {
    /** Identifies the thing needing attention, e.g. `batch:<id>`; include a revision so changed content counts as new. */
    key: string | undefined; ready: boolean; open: boolean; width: number; setOpen: (open: boolean) => void;
}) {
    const host = useContextPanelHost();
    const wouldDock = host?.wouldDock, isOffered = host?.isOffered, markOffered = host?.markOffered, active = host?.active ?? null;
    useEffect(() => {
        if (!key || !wouldDock || !isOffered || !markOffered) return;
        if (!shouldAutoOpenPanel({ready, open, hasActivePanel: active !== null, offeredBefore: isOffered(key), fitsBesideContent: wouldDock(width)})) return;
        markOffered(key);
        setOpen(true);
    }, [key, ready, open, width, active, wouldDock, isOffered, markOffered, setOpen]);
    return useCallback((next: boolean, reason?: ContextPanelHostCloseReason) => {
        if (!next && key && (reason === undefined || reason === "user")) host?.markOffered(key);
        setOpen(next);
    }, [host, key, setOpen]);
}
