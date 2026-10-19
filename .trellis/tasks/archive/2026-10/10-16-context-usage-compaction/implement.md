# Execution plan
1. Measurement: provider-reported baseline + wire-shaped delta, shared by ring and trigger; fixtures comparing against recorded provider inputTokens and wire payload.
2. Auto-compaction hardening (retry, overflow, pruning, summary params) with tests.
3. Manual compaction core (run-less summary record, typed failures) with tests for active-run, pending-approval, nothing-to-compact, failure.
4. Context popover UI: figure with source, Compact now, progress/cancel (follows ui-ux-overhaul rules).
5. Check, spec update, commit.
