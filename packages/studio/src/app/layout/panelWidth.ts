export const PANEL_MIN_WIDTH = 320;
export const PANEL_MAX_WIDTH = 720;
/** The content column never gets narrower than this, whatever the panel's width. */
const CONTENT_MIN_WIDTH = 480;
export const PANEL_KEYBOARD_STEP = 16;

/** A panel is as wide as asked, within its own limits and without squeezing the content below its minimum. */
export function clampPanelWidth(width: number, space: {surfaceWidth: number; navigationWidth: number}): number {
    const room = space.surfaceWidth - space.navigationWidth - CONTENT_MIN_WIDTH;
    const upper = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, room));
    return Math.round(Math.min(upper, Math.max(PANEL_MIN_WIDTH, width)));
}

/** Whether a panel of this width can sit beside the content (otherwise it covers it). */
export function canDockPanel(width: number, space: {surfaceWidth: number; navigationWidth: number}): boolean {
    return space.surfaceWidth >= space.navigationWidth + width + CONTENT_MIN_WIDTH;
}

const storageKey = (kind: string) => `cuepoint.panel-width.${kind}`;

/** A per-device convenience only: unavailable storage just means the default width. */
export function readPanelWidth(kind: string | undefined): number | undefined {
    if (!kind) return undefined;
    try {
        const value = Number(localStorage.getItem(storageKey(kind)));
        return Number.isFinite(value) && value > 0 ? value : undefined;
    } catch {
        return undefined;
    }
}

export function writePanelWidth(kind: string | undefined, width: number): void {
    if (!kind) return;
    try {
        localStorage.setItem(storageKey(kind), String(width));
    } catch { /* The width stays for this session only. */ }
}

/** Auto-open only offers a panel that fits beside the content, is not already open and was not offered or closed before. */
export function shouldAutoOpenPanel(input: {
    ready: boolean; open: boolean; hasActivePanel: boolean; offeredBefore: boolean; fitsBesideContent: boolean;
}): boolean {
    return input.ready && !input.open && !input.hasActivePanel && !input.offeredBefore && input.fitsBesideContent;
}
