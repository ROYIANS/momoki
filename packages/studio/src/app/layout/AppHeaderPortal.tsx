import {createContext, type ReactNode, useContext} from "react";
import {createPortal} from "react-dom";

export const AppHeaderContext = createContext<HTMLElement | null>(null);

/** Move presentation only; the feature's React context and action owners stay intact. */
export function AppHeaderPortal({children}: { children: ReactNode }) {
    const target = useContext(AppHeaderContext);
    return target ? createPortal(children, target) : null;
}

/** The top bar's right end of the middle zone: this page's quick actions. */
export const AppHeaderActionsContext = createContext<HTMLElement | null>(null);
