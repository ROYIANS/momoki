# Implement

1. Shared plus-sheet toolbar + single scroller on Skills / MCP / parameters.
2. Remove titles, counts, section captions, and parameter helper paragraphs.
3. Inventory remaining composer/chat copy; delete decorative status.
4. Update tests that assert old labels (`contextCompactAction`, `b03IntentBoundaries`, plus-menu tests).
5. `tsc -b` + affected vitest. Visual check of the three secondary sheets.

Rollback: revert the plus-sheet / ContextParameters UI files only; policy and MCP commands are unchanged.
