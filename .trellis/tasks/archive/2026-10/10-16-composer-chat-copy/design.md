# Design

Parent: `10-16-ui-ux-overhaul`. Reference: Cursor plus MCP sheet (back + search + Manage ↗, no title).

## Boundary

- In: `packages/studio` agent composer / chat UI only (`AgentControls`, `ContextParameters`, `ContextUsagePanel`, composer cards, stream chrome).
- Out: Settings pages themselves, MCP/skills data, context planner, execution.

## Plus secondary chrome

One `PlusSheetToolbar`: back icon, borderless search, optional `管理` + `ExternalLink`. Hosted inside `.agent-plus-sheet .agent-control-panel` which is a flex column with `overflow: hidden`. Only `.agent-skill-list` / `.agent-parameter-body` scrolls.

Parameters reuses the same toolbar classes. Search filters visible rows. Footer keeps `恢复默认` / `设为默认` as quiet actions; no “设置自动保存” caption (quiet success per `interaction-feedback.md`).

## Copy pass

Inventory first (composer plus, context card, cards, stream, sidebar leftovers), then delete or move to `title`/hint. Do not invent new helper paragraphs.

## Compatibility

Existing `updateContextPolicy` / skill toggles / MCP `toggle` stay. Tests that look for `恢复默认` / `设为默认` / compact aria-labels stay valid.
