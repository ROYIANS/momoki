# R9 audit: left-border / inset accents

Replaced (selected-state accents):
- `agentChat.css` `.agent-model-row.is-selected`: `inset 2px` bar -> `background: var(--surface-selected)` + weight 600 + trailing Check (now `currentColor`, no hard-coded `#aaa`, in `ModelSelectTrigger.tsx`).
- New token `--surface-selected` (and `--foreground-secondary`) in `ui/theme.css` (theme is single dark scheme; no light block exists).

Audited and kept (structural dividers, not selection): `agent-run-steps`, `agent-tool-group-calls`, expanded-step connector, docked context panel, `mw-details`, `as-inspector`, task-review-source, task columns/inspector, topic-sheet divider, timeline ruler/playhead (data marks).
No selected state in sidebar/settings/module nav/tabs used border-left or `::before` bars (grep over studio CSS/TSX found none; `agent-composer-dock::before` is a surface layer).

R12: `.agent-tool-verb` now `--foreground-secondary` (12px, line-height 1.4, 3px row padding), full foreground on hover/expanded/running/awaiting_approval; failed stays destructive; object stays muted.
