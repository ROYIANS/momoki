import {
    type ComponentProps,
    createContext,
    type ReactNode,
    useContext,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState
} from "react";
import {createPortal} from "react-dom";
import {FocusScope} from "@radix-ui/react-focus-scope";
import {DismissableLayer} from "@radix-ui/react-dismissable-layer";
import {useContextPanelHost, type ContextPanelHostCloseReason} from "./ContextPanelHost";
import {ArrowLeft, XIcon} from "../../ui/icons";
import {createOverlayFocusReturn} from "../../ui/overlayFocusReturn";
import {cn} from "../../ui/cn";

export {ContextPanelHeaderActions} from "./PanelHeader";

type PanelContext = {
    shown: boolean;
    fullWidth: boolean;
    titleId: string;
    descriptionId: string;
    close: () => void;
    focusReturn: ReturnType<typeof createOverlayFocusReturn>
};
const PanelContext = createContext<PanelContext | null>(null);

function usePanel() {
    const value = useContext(PanelContext);
    if (!value) throw new Error("ContextPanelContent requires ContextPanel");
    return value;
}

/** Feature-owned open/draft state; the frame arbitrates presentation only. */
export function ContextPanel({open, onOpenChange, width = 400, title, onRequestDeparture, children}: {
    open: boolean; onOpenChange: (open: boolean, reason?: ContextPanelHostCloseReason) => void; width?: number; children: ReactNode;
    /** Shown in the top bar's panel zone while this panel is active. */
    title?: string;
    onRequestDeparture?: (proceed: () => void, cancel?: () => void) => void;
}) {
    const id = useId();
    const [focusReturn] = useState(createOverlayFocusReturn);
    useLayoutEffect(() => {
        if (open) focusReturn.onOpenAutoFocus(new Event("context-panel-open"));
    }, [open, focusReturn]);
    const host = useContextPanelHost();
    const current = useRef({onOpenChange, onRequestDeparture});
    current.current = {onOpenChange, onRequestDeparture};
    const register = host?.register, request = host?.request, release = host?.release;
    const registrationLifetime = useRef({generation: 0});
    useEffect(() => {
        const lifetimeState = registrationLifetime.current;
        const lifetime = ++lifetimeState.generation;
        const unregister = register?.({
            id, width, title, reopen: () => current.current.onOpenChange(true), depart: (proceed, cancel) => {
                if (current.current.onRequestDeparture) current.current.onRequestDeparture(proceed, cancel); else proceed();
            }, close: reason => current.current.onOpenChange(false, reason)
        });
        return () => {
            // A setup replay replaces this registration before its cleanup runs.
            // Preserve the host's pending guard rather than request it twice.
            queueMicrotask(() => {if (lifetimeState.generation === lifetime) unregister?.();});
        };
    }, [register, id, width, title]);
    useEffect(() => {
        if (open) request?.(id); else release?.(id);
    }, [open, request, release, id]);
    const shown = open && (!host || host.active === id);
    return <PanelContext value={{
        shown, fullWidth: !host?.docked, titleId: `${id}-title`, descriptionId: `${id}-description`, focusReturn,
        close: () => {
            const close = () => current.current.onOpenChange(false);
            if (current.current.onRequestDeparture) current.current.onRequestDeparture(close); else close();
        }
    }}>{children}</PanelContext>;
}

/** This one subtree survives docking; never switch Dialog modal Content branches. */
export function ContextPanelContent({
                                        children,
                                        className,
                                        showCloseButton = true,
                                        returnLabel = "返回工作区",
                                        showReturnWhenDocked = false,
                                        onReturn,
                                        onPresented,
                                        onOpenAutoFocus,
                                        onCloseAutoFocus,
                                        side: _side,
                                        ...props
                                    }: ComponentProps<"div"> & {
    side?: "right" | "left"; showCloseButton?: boolean; returnLabel?: string;
    showReturnWhenDocked?: boolean; onReturn?: () => void; onPresented?: () => void;
    onOpenAutoFocus?: (event: Event) => void; onCloseAutoFocus?: (event: Event) => void;
}) {
    const panel = usePanel();
    const host = useContextPanelHost();
    const focusReturn = panel.focusReturn;
    const ref = useRef<HTMLDivElement>(null);
    const presented = useRef(onPresented);
    presented.current = onPresented;
    useLayoutEffect(() => {
        if (panel.shown && ref.current?.isConnected) presented.current?.();
    });
    const lastFullWidth = useRef(panel.fullWidth);
    useLayoutEffect(() => {
        const becameFullWidth = panel.fullWidth && !lastFullWidth.current;
        const becameDocked = !panel.fullWidth && lastFullWidth.current;
        lastFullWidth.current = panel.fullWidth;
        // A resize hides the retained workspace, never the app's header or navigation.
        // Move only focus that would otherwise remain inside that hidden workspace.
        const focused = document.activeElement;
        if (!panel.shown || !ref.current || !(focused instanceof Element)) return;
        const workspaceFocus = becameFullWidth && focused.closest("[data-context-panel-workspace]");
        const hiddenReturnFocus = becameDocked && ref.current.contains(focused) && focused.closest(".context-panel-return-bar[hidden]");
        if (workspaceFocus || hiddenReturnFocus) {
            const target = [...ref.current.querySelectorAll<HTMLElement>("[autofocus], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex='0']")]
                .find(element => !element.closest("[hidden], [inert], [aria-hidden=true]"));
            (target ?? ref.current).focus({preventScroll: true});
        }
    }, [panel.shown, panel.fullWidth]);
    if (!panel.shown || (host && !host.target)) return null;
    const target = host?.target ?? document.body;
    return createPortal(
        <FocusScope key="content" asChild
                    onMountAutoFocus={event => {
                        onOpenAutoFocus?.(event);
                        if (!panel.fullWidth) event.preventDefault();
                    }} onUnmountAutoFocus={event => {
            focusReturn.onCloseAutoFocus(event, onCloseAutoFocus);
            // Use the shared conditional fallback rather than stealing a valid new focus.
            event.preventDefault();
        }}>
            <DismissableLayer asChild
                              onEscapeKeyDown={event => {
                                  if (event.target instanceof Node && ref.current?.contains(event.target)) {
                                      event.preventDefault();
                                      panel.close();
                                  }
                              }}>
                <div {...props} ref={ref} data-slot="context-panel-content"
                     data-mode={panel.fullWidth ? "full-width" : "docked"}
                     className={cn("context-panel-content", className)}
                     role="complementary"
                     aria-labelledby={panel.titleId} aria-describedby={panel.descriptionId} tabIndex={-1}>
                    <div className="context-panel-return-bar" hidden={!panel.fullWidth && !showReturnWhenDocked}>
                        <button type="button" className="context-panel-return" onClick={onReturn ?? panel.close}>
                            <ArrowLeft className="size-4" aria-hidden/>{returnLabel}
                        </button>
                    </div>
                    {children}
                    {showCloseButton && !panel.fullWidth && !host?.headerZone &&
                        <button type="button" aria-label="关闭" className="context-panel-close" onClick={panel.close}>
                            <XIcon className="size-4" aria-hidden/></button>}
                </div>
            </DismissableLayer>
        </FocusScope>, target);
}

export function ContextPanelHeader({className, ...props}: ComponentProps<"div">) {
    return <div data-slot="context-panel-header"
                className={cn("shrink-0 flex flex-col gap-1.5 p-4 pr-10", className)} {...props}/>;
}

export function ContextPanelTitle({className, ...props}: ComponentProps<"h2">) {
    const panel = usePanel();
    return <h2 {...props} id={panel.titleId} data-slot="context-panel-title"
               className={cn("text-foreground font-semibold", className)}/>;
}

export function ContextPanelDescription({className, ...props}: ComponentProps<"p">) {
    const panel = usePanel();
    return <p {...props} id={panel.descriptionId} data-slot="context-panel-description"
              className={cn("text-muted-foreground text-sm", className)}/>;
}
