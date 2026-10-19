# Execution plan (batches; one commit each)

1. Shared foundations: `statusCopy`, shared ticker + dot-matrix marker, popover surface contract.
2. Sidebar item (R1) + tests/screenshots.
3. Popover migration + truncation fixes (R6).
4. Model + effort popover and reasoning capability (R7) with transport tests.
5. Composer strip relocation and error placement (R4, R8).
6. Copy cleanup passes by area: chat/agent, library/assets, settings, shot editor (R2, R3).
7. Refined surfaces (R9), settings button (R10), MCP/Skills settings sections (R11).
7b. Tool-call row styling (R12).
8. Visual verification: seeded browser fixture (connector + threads in every sidebar state) for screenshots of sidebar, popovers at 560-720px, composer, settings.
9. Final: trellis-check full scope, tsc, affected vitest lanes, real-UI screenshots, spec update.

Sub-agents: trellis-implement per batch (sequential where files overlap: 2/3/4/5 touch agent UI), trellis-check after 4, 5 and the end.
