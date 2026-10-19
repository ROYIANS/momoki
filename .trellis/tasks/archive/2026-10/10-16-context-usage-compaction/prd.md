# Context usage accuracy, manual compaction, auto-compaction audit

## Goal
The context-usage figure at the composer's lower right is inaccurate. Make it trustworthy, add a manual "compact" action, and verify the existing automatic compaction behaves correctly.

## Requirements
1. **Accuracy**: define what the figure measures (tokens actually sent next turn: system prompt, tool definitions, skills/MCP schemas, history, attachments, reasoning) versus the model's context window; use provider usage from the last response where available and a documented estimator otherwise; show source (reported / estimated). Cover multi-modal parts, tool results, spilled/clipped results, compaction summaries, model switch, and resumed threads.
2. **Manual compaction**: an action in the context-usage popover (and a command) that compacts the current thread on demand, with progress, cancel, result summary (tokens before/after), and safe behaviour while a run is active or approvals pend. Must reuse the existing compaction pipeline and its guarantees (reviewed memory, exact confirmations, no loss of pending tool results).
3. **Auto-compaction audit**: verify thresholds, trigger point (before request vs on overflow), failure/retry, summary quality inputs, idempotency, interaction with E07 results/E09 skills/E10 MCP/E11 background runs, and with the usage figure. Write findings with evidence; fix defects found; compare with deepseek-harness `packages/compaction` and `packages/context`.
4. Popover design follows the ui-ux-overhaul rules (concise copy, no clipping, no left-border accents).

## Acceptance Criteria
- [ ] Documented measurement definition; tests comparing displayed value to a known request payload within a stated tolerance for several fixtures.
- [ ] Manual compaction works from the UI, with tests for active-run, pending-approval and failure cases.
- [ ] Auto-compaction audit report with evidence; defects fixed with tests or listed with reasons.

## Out of scope
- Changing model providers' tokenization; E11 process boundary.
