# Execution plan

Batches in order; each ends with targeted tests + lint/type-check for touched packages, then one commit (batch commits per Phase 3.4, confirmed once).

1. Stale test + E06/E07 contracts (items 1, 2, 11).
2. E08 native Windows/Job Object/decoder (item 3).
3. E10 OAuth/transport/consent/env (item 13).
4. Chat UI: E01-E05, E16 (items 5-10).
5. E09 import (item 12).
6. E11 interim persistence, reconcile, claim, quit/close, WebView-crash recovery (items 4, 14).
7. Bookkeeping: archived task.json/PRD corrections (item 15), `research/deferred.md`.
8. **Last**: E11 Rust Host (process boundary). Starts only after a design.md section is approved by the owner; Windows parts unexecuted here.
9. Final: trellis-check full-scope on touched packages; Rust `cargo check` on macOS; update spec.

Rollback: each batch is a separate commit on `codex/agent-background-host`.
Sub-agents: `trellis-implement` per batch, `trellis-check` after batches 3, 6 and the final pass.
