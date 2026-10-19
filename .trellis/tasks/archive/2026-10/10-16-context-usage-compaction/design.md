# Design

Inputs: `research/context-compaction-audit.md`.

## Measurement
- `contextUsage = lastReportedInputTokens (provider) + estimate(delta since that request)`; when no report exists (new thread, model switch, compaction just applied), full estimate with a flag `source: "estimated"`. Delta is computed over the wire-shaped payload per protocol (chat-completions vs responses), not internal JSON; remove double counting of `referenceInput`.
- Images: use provider-reported tokens when available, else a size-based estimate with a documented floor/cap instead of a flat 4096.
- Hide the percentage when the window is unknown. Ring and compaction trigger use the same figure (no 1.25 multiplier discrepancy: either the ring shows the compared value or the threshold is expressed on the displayed scale).

## Auto-compaction hardening
- One retry on compaction failure, then fall back to sending uncompressed only if still under the hard window, else a clear error.
- On provider context-overflow error: compact once and retry the request.
- Prune large current-turn tool results (bounded, with spill readback from E07) before summarizing.
- Summary request: reasoning effort off/low and an output cap derived from the summary budget; reject empty summaries.

## Manual compaction
- `compactThreadNow(threadId)` outside a run: acquires the thread work reservation (`reserveAgentThreadWork`), refuses when a run is active or an approval is pending, creates a run-less summary record whose coverage matches the next send's history, reuses `compactContext`/`CompactionHost`; result `{before, after}` measured on request-level estimates; typed failures (busy, nothing-to-compact, changed, summary, persistence) like dsh `/compact`.
- UI: a "Compact now" action in the context-usage popover with progress and cancel; result line "before -> after".

## Out of scope
Provider tokenizers; E11 process boundary.

## Popover simplification (owner feedback 2026-10-16; supersedes earlier popover detail)
Screenshots: `research/ours-context-popover.png` (too complex) vs `research/cursor-context-usage.png` (target).
- Header row: `已用 N%` left, `≈ used / window` right; a small `估算` tag only when the figure is estimated (no standalone disclaimer paragraphs).
- Progress bar, then only non-zero categories merged into at most 5 rows: 系统指令, 工具 (tool definitions + skill/capability catalog), 对话 (messages + history summary), 工具结果, 记忆与参考. Colour dot + name + value.
- One footer action: `压缩` with progress/cancel and a one-line `before -> after` result.
- Removed from the default view: model name, loaded-capability line, history count, output reserve, safe input budget, auto-compaction status text, request-structure bucket (folded into 系统指令), both explanatory paragraphs. An optional collapsed `详情` may hold budget numbers.
- Window unknown: show tokens only, no percent.
