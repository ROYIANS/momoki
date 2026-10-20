import {createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState} from "react";
import {canDockPanel, clampPanelWidth, readPanelWidth, writePanelWidth} from "./panelWidth";

export type ContextPanelHostCloseReason = "replaced" | "guard-refused" | "busy" | "user";
type Registration = {
    id: string;
    width: number;
    /** Shown in the top bar's panel zone. */
    title?: string;
    /** Names the panel type so a width the user dragged to is remembered per type. */
    kind?: string;
    /** Opens the panel again from the top bar toggle; the feature still owns its open state. */
    reopen?: () => void;
    depart: (proceed: () => void, cancel: () => void) => void;
    close: (reason: ContextPanelHostCloseReason) => void
};
type Host = {
    target: HTMLElement | null; width: number; docked: boolean; fullWidth: boolean; active: string | null;
    /** Whether a panel of this width would sit beside the content rather than cover it. */
    wouldDock: (width: number) => boolean;
    /** Remember that a thing was already offered or closed, so it is not opened automatically again. */
    markOffered: (key: string) => void;
    isOffered: (key: string) => boolean;
    /** Sets the active panel's width, within its limits, and remembers it for its kind. */
    setPanelWidth: (width: number) => void;
    /** True when the top bar draws the panel's header and close button, so the panel must not draw its own. */
    headerZone: boolean;
    /** Title of the active panel, for the top bar's panel zone. */
    activeTitle: string | null;
    /** True while a panel is open or one was opened before and can be reopened. */
    canToggle: boolean;
    /** Closes the active panel through its own departure guard, like its own close button. */
    closeActive: () => void;
    /** Closes the active panel, or reopens the last one. */
    toggle: () => void;
    register: (registration: Registration) => () => void; request: (id: string) => void; release: (id: string) => void
};
const ContextPanelHostContext = createContext<Host | null>(null);

export function useContextPanelHost() {
    return useContext(ContextPanelHostContext);
}

export function ContextPanelHostProvider({children, target, surfaceWidth, navigationWidth, headerZone = false}: {
    children: ReactNode; target: HTMLElement | null; surfaceWidth: number; navigationWidth: number;
    /** Set by the frame that renders the top bar's panel zone. */
    headerZone?: boolean;
}) {
    const registrations = useRef(new Map<string, Registration>());
    const [active, setActive] = useState<string | null>(null);
    const activeRef = useRef<string | null>(null);
    const generation = useRef(0);
    const pending = useRef<string | null>(null);
    const [width, setWidth] = useState(400);
    const offered = useRef(new Set<string>());
    const space = useRef({surfaceWidth, navigationWidth});
    space.current = {surfaceWidth, navigationWidth};
    const [activeTitle, setActiveTitle] = useState<string | null>(null);
    const lastId = useRef<string | null>(null);
    const [reopenable, setReopenable] = useState(false);
    const activate = useCallback((id: string) => {
        const entry = registrations.current.get(id);
        if (!entry) return;
        activeRef.current = id;
        lastId.current = id;
        setReopenable(true);
        setActive(id);
        setActiveTitle(entry.title ?? null);
        // A width the user chose for this kind of panel wins over the default, within what fits today.
        const saved = readPanelWidth(entry.kind);
        setWidth(saved !== undefined ? clampPanelWidth(saved, space.current) : entry.width);
    }, []);
    const wouldDock = useCallback((candidate: number) => canDockPanel(candidate, space.current), []);
    const markOffered = useCallback((key: string) => {offered.current.add(key);}, []);
    const isOffered = useCallback((key: string) => offered.current.has(key), []);
    const setPanelWidth = useCallback((next: number) => {
        const id = activeRef.current;
        if (!id) return;
        const clamped = clampPanelWidth(next, space.current);
        setWidth(clamped);
        writePanelWidth(registrations.current.get(id)?.kind, clamped);
    }, []);
    const release = useCallback((id: string) => {
        if (activeRef.current !== id) return;
        activeRef.current = null;
        setActive(null);
        setActiveTitle(null);
    }, []);
    const closeActive = useCallback(() => {
        const entry = activeRef.current ? registrations.current.get(activeRef.current) : undefined;
        if (!entry) return;
        entry.depart(() => entry.close("user"), () => undefined);
    }, []);
    const toggle = useCallback(() => {
        if (activeRef.current) {closeActive(); return;}
        const entry = lastId.current ? registrations.current.get(lastId.current) : undefined;
        entry?.reopen?.();
    }, [closeActive]);
    const register = useCallback((entry: Registration) => {
        registrations.current.set(entry.id, entry);
        return () => {
            registrations.current.delete(entry.id);
            release(entry.id);
            if (pending.current === entry.id) {
                pending.current = null;
                generation.current++;
            }
        };
    }, [release]);
    const request = useCallback((id: string) => {
        if (activeRef.current === id) return;
        if (pending.current) {
            if (pending.current !== id) registrations.current.get(id)?.close("busy");
            return;
        }
        const attempt = ++generation.current;
        const outgoing = activeRef.current && registrations.current.get(activeRef.current);
        if (!outgoing) {
            activate(id);
            return;
        }
        pending.current = id;
        outgoing.depart(() => {
            if (attempt !== generation.current || !registrations.current.has(id)) return;
            pending.current = null;
            generation.current++;
            outgoing.close("replaced");
            activate(id);
        }, () => {
            if (attempt !== generation.current) return;
            pending.current = null;
            generation.current++;
            registrations.current.get(id)?.close("guard-refused");
        });
    }, [activate]);
    const docked = surfaceWidth >= navigationWidth + width + 480;
    const fullWidth = !!active && !docked;
    const value = useMemo(() => ({
        target,
        width,
        docked,
        fullWidth,
        active,
        wouldDock,
        markOffered,
        isOffered,
        setPanelWidth,
        headerZone,
        activeTitle,
        canToggle: !!active || reopenable,
        closeActive,
        toggle,
        register,
        request,
        release
    }), [target, width, docked, fullWidth, active, wouldDock, markOffered, isOffered, setPanelWidth, headerZone, activeTitle, reopenable, closeActive, toggle, register, request, release]);
    return <ContextPanelHostContext value={value}>{children}</ContextPanelHostContext>;
}
