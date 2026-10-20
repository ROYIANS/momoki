import {type ReactNode, useEffect, useRef} from "react";
import {MoreHorizontal} from "../../../ui/icons";
import "./composerPanel.css";

type DataAttributes = {[key: `data-${string}`]: string | undefined};

/**
 * A panel attached to the top of the composer: rounded, its lower edge tucked behind the input, one
 * quiet row per item. The pending-send queue and the decision cards share it so they read as one family.
 */
export function ComposerPanel({label, note, noteRole, className, children, ...data}: {
    label: string;
    /** One muted line above the rows (mode explanation, notice). */
    note?: string;
    noteRole?: "status" | "alert";
    className?: string;
    children: ReactNode;
} & DataAttributes) {
    return <section className={className ? `composer-panel ${className}` : "composer-panel"} aria-label={label} {...data}>
        {note ? <p className="composer-panel-note" role={noteRole ?? "status"}>{note}</p> : null}
        <ul className="composer-panel-rows">{children}</ul>
    </section>;
}

/** Leading glyph, one flexible line of content, and trailing actions. */
export function ComposerRow({icon, tone, className, actions, children, ...data}: {
    icon: ReactNode;
    tone?: "warn";
    className?: string;
    actions?: ReactNode;
    children: ReactNode;
} & DataAttributes) {
    return <li className={className ? `composer-row ${className}` : "composer-row"} data-tone={tone} {...data}>
        <span className="composer-row-icon" aria-hidden>{icon}</span>
        <div className="composer-row-body">{children}</div>
        {actions ? <div className="composer-row-actions">{actions}</div> : null}
    </li>;
}

/** Ghost action: a glyph with an optional short label. An icon-only action must carry an ariaLabel. */
export function RowAction({icon, label, ariaLabel, title, primary, disabled, expanded, onClick}: {
    icon: ReactNode;
    label?: string;
    ariaLabel?: string;
    title?: string;
    primary?: boolean;
    disabled?: boolean;
    expanded?: boolean;
    onClick: () => void;
}) {
    return <button type="button" className="composer-row-action" data-primary={primary ? "true" : undefined}
                   data-icon-only={label ? undefined : "true"} aria-label={ariaLabel} title={title ?? ariaLabel}
                   aria-expanded={expanded} disabled={disabled} onClick={onClick}>
        {icon}{label ? <span>{label}</span> : null}
    </button>;
}

export function MenuItem({icon, label, disabled, onClick}: {icon?: ReactNode; label: string; disabled?: boolean; onClick: () => void}) {
    return <button type="button" role="menuitem" className="composer-menu-item" disabled={disabled} onClick={onClick}>
        {icon}<span>{label}</span>
    </button>;
}

/** The "…" action with a small popover; closes on outside press and Escape. */
export function RowMenu({open, onOpenChange, children}: {open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode}) {
    const anchor = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        if (!open) return;
        const press = (event: MouseEvent) => {
            if (!anchor.current?.contains(event.target as Node)) onOpenChange(false);
        };
        const key = (event: KeyboardEvent) => {
            if (event.key === "Escape") onOpenChange(false);
        };
        document.addEventListener("mousedown", press);
        document.addEventListener("keydown", key);
        return () => {
            document.removeEventListener("mousedown", press);
            document.removeEventListener("keydown", key);
        };
    }, [open, onOpenChange]);
    return <span className="composer-row-menu-anchor" ref={anchor}>
        <RowAction icon={<MoreHorizontal size={16} aria-hidden/>} ariaLabel="更多" expanded={open} onClick={() => onOpenChange(!open)}/>
        {open ? <div className="composer-row-menu" role="menu">{children}</div> : null}
    </span>;
}
