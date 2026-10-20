/** Column widths of the three top-bar zones; the panel zone exists only while a panel is docked. */
export function topbarZones(input: {narrow: boolean; navigationWidth: number; panelWidth: number; panelDocked: boolean}) {
    const panelShown = !input.narrow && input.panelDocked && input.panelWidth > 0;
    return {
        navigation: input.narrow ? "0px" : `calc(var(--shell-rail-width) + ${Math.max(0, input.navigationWidth)}px)`,
        // The top bar spans the window; the panel column sits inside the frame's right inset and the surface border.
        panel: panelShown ? `calc(${input.panelWidth}px + var(--shell-inset) + 1px)` : "0px",
        panelShown,
    };
}
