# Composer and chat copy audit

## Goal

Make every composer and chat surface as quiet as Cursor: no tutorial sentences, no decorative status, no second scrollbar, and every plus-sheet secondary page sharing one toolbar.

## Requirements

### R1. Plus secondary pages share one chrome
- Skills, MCP, and conversation parameters use the same top row: back, search, optional manage link.
- No page title, count, or “当前对话 / 内置能力 / 已启用” captions in that chrome.
- Manage is a text link that opens the existing Settings section. Parameters has no Settings destination, so it keeps only back + search.
- One scroll region per sheet. The outer card does not also scroll.

### R2. Strip leftover chat and composer copy
Walk the composer, plus sheets, context meter, message stream, turn footers, and topic sidebar. Remove text that restates the control, explains an automatic save, or names an internal phase. Keep one short line only when the user must act (error, empty searchable list, blocked compress).

### R3. Align remaining surfaces to Cursor density
Row height, muted labels, and icon-only actions stay consistent across plus home, secondary sheets, and the context card. Hidden single-line fullscreen, segmented effort, and icon context footer from the parent task stay.

## Constraints

- No change to MCP/skills persistence, context-policy writes, or send/recovery behavior.
- Accessibility names stay on icon and back controls.
- Parent task `10-16-ui-ux-overhaul` remains the integration owner.

## Acceptance Criteria

- [ ] Skills / MCP / parameters sheets all use the shared toolbar; screenshots show no title and one scrollbar.
- [ ] Manage on Skills and MCP opens `/settings?section=…`; parameters still save as default / restore default without extra “自动保存” copy.
- [ ] A written inventory lists every remaining composer/chat string that was removed or explicitly kept.
- [ ] Affected vitest lanes and `tsc -b` pass.
