# Fix E01-E11/E16 review findings

## Source

Findings: `.trellis/tasks/archive/2026-10/10-16-e-series-delivery-review/research/review-*.md` (summary in `review-summary.md`). Each item below cites that review as `R-E<id>`. Reference project: `/Users/xiaomengdao/WebstormProjects/deepseek-harness` (dsh).

## Owner decisions (2026-10-16)

- Scope: all **P1 and P2** code defects. P3 items and acceptance gaps that need real hardware are recorded, not fixed.
- One task, no child split.
- E11 design: process boundary follows dsh's Host model, implemented in **Rust** (option A in `research/our-execution-ownership.md`). It is the **last batch**; all simpler fixes land first. Before that batch starts, a dedicated design review (scope of the Rust port, how the Web build keeps working, tool/browser-bound API handling) must be approved by the owner.
- Commits go on `codex/agent-background-host`, batched per theme.

## Requirements

### A. Correctness / P1

1. **E07 stale tests**: update `tests/d05ToolCatalog.test.ts` for `load_skill` and `read_skill_resource`; re-confirm the E07 suite.
2. **E06 authority**: `complete_todo` and `list_todos` go through `ResourceGrantPort` like create, or the contract states and tests why not. Core calls `assertCurrent` (or the contract removes it). E10 MCP binding moves onto the E06 registry, or the divergence is removed from the PRD claim with a test proving equal guarantees.
3. **E08 Windows**: scan skips aliases and reparse points instead of failing; map the `nativeFilesystem` error to a scoped user message; decoder runs under a kill-on-close Job Object; hash-verify and execute use the same handle/path (no gap).
4. **E11 host (interim)**: a WebView crash/terminate while hidden is detected natively; the window is recreated, drafts and attempts are restored from persistence, interrupted runs are marked interrupted without effect replay. Runs do not survive the crash (that needs the follow-up process boundary). Quit-with-active-runs path has a real (non-fake-port) test where the platform allows.

### B. Robustness / P2

5. **E01**: shot selection controls use the field/baseline contract; detail provider lifetime follows the thread/host, not the page; responsive ACs run in a gate.
6. **E02**: explicit retry carries `modelMetadata`; `uncertain` send has a user exit; orphan empty thread on failure-then-restore is removed.
7. **E03**: output-commit sampling stops after the first confirmed checkpoint; timing marks have a collection path (test hook or dev log).
8. **E04**: PRD AC1 updated to reality (departure removed by E11) or the behavior restored; control snapshot key growth bounded.
9. **E05**: unknown create has an exit; import queue survives or visibly reports unmount; failed head item retry does not re-parse the whole `File`; unknown outcome does not block unrelated items unnecessarily.
10. **E16**: handoff has a fallback when `onCloseAutoFocus` does not fire; `replaced` with dirty draft is not silent; residual entity families recorded in a follow-up backlog note.
11. **E07**: readback pages do not re-read the whole report; clearing releases job slots and the inline preview; recovery handles runs no longer `running`.
12. **E09**: browser import excludes the same files native import excludes; revision cap offers a remedy beyond deleting chats; Windows placeholder files are skipped with a notice.
13. **E10**: OAuth loopback survives empty/slow/closed connections; long tool calls use a deadline consistent with the call policy; native consent for starting a stdio server; OAuth discovery rejects private/loopback endpoints (except explicit test fixtures); stdio env keeps `PATH`/`SystemRoot`.
14. **E11**: Quit never skips the draft decision on slow renderer; Quit/close warns when runs are active and on first hide; Windows session-end and macOS fullscreen are handled before hide; drafts and failed/uncertain attempts persist across reload; startup reconciliation is per-thread and does not block boot; `claim()` cannot leak a reservation; relaunch during `Closing` retries or reports.

### C. Bookkeeping

15. Archived task metadata (`task.json` status/commits) for E08, E10, E11 corrected to say pending acceptance; commit lists completed.

## Last batch note

The Rust Host is a large architectural change (about 60k lines of TS agent loop/tools have no Rust equivalent; browser-bound tools exist). Batch 8 therefore has its own design gate and may be split into a follow-up task if the owner agrees after seeing the design. Interim persistence/recovery items (14) are still done earlier and are kept compatible.

## Acceptance Criteria

- [ ] Every P1/P2 item above has a code change plus a test, or a documented reason it cannot be tested here.
- [ ] Studio/desktop affected suites pass; `d05ToolCatalog` passes; lint/type-check clean for touched packages.
- [ ] Rust changes compile on macOS; Windows-only changes are marked as not executed here.
- [ ] No regression of E01-E11/E16 acceptance criteria; PRD drift is fixed in archived task records.
- [ ] P3 and unverified-platform items listed in `research/deferred.md`.

## Out of scope

- P3 findings; real Windows / installed-app / Keychain acceptance (owner's); full production build and packaging.
