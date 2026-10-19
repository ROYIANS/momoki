# Design

Grouped by theme. Each theme is an independently checkable batch/commit. Evidence and file:line come from the archived review reports (`R-E<id>`), re-read by the implementer before editing.

## Contracts (E06, E07, E10)
- E06: grants for `complete_todo`/`list_todos` mirror create (same `ResourceGrantPort`, revocation re-check at dispatch). Core invokes `assertCurrent` at approve/claim/transaction points, or the contract text drops it with a test of the actual guarantee. E10 MCP authority is moved onto the registry only if equal tests pass; otherwise PRD wording is corrected and the divergence documented.
- E07: fix stale catalog test first; paged readback uses chunk offsets; clear frees job slots and removes the inline preview; recovery covers non-running runs.
- E10: bounded accept loop for OAuth loopback (per-connection timeout, ignore empty/closed, overall login deadline); tool-call deadline from the call policy rather than the 30 s client timeout; native consent token for stdio start; reject private/loopback OAuth discovery endpoints (test fixtures opt in explicitly); keep `PATH`/`SystemRoot` in cleared env via allowlist.

## Native (E08)
- Windows: `stat_file` returns alias classification; scan skips (counts skipped); map `nativeFilesystem` to scoped message; decoder spawned inside kill-on-close Job Object; verify-and-exec through one opened handle/copy owned by the app. Windows code is compiled only conditionally here and flagged unexecuted.

## Agent chat UI (E01-E05, E16)
- Small, local fixes per R-E reports; each gets a unit/UI test. E01 browser script is wired into an existing aggregate or a documented gate. E04/E16 PRD drift fixed in the archived records. E16 residual families go to `research/deferred.md`.

## Import (E05, E09)
- E09 browser import applies the same exclusion filter as native before counting/validating; revision-cap remedy lists a revision delete action; Windows placeholder files are skipped with a notice.

## E11 interim (boundary-independent)
- Persist drafts and failed/uncertain attempts (ProductStore device-level table or existing deviceSettings) with eviction.
- Per-thread startup reconciliation with isolated failures; boot not blocked.
- `claim()` ordering/cleanup so reservations never leak; explicit invariant for attempt lookup.
- Native: handle WebView termination (Tauri/WKWebView/WebView2 process-failed hook if exposed; else detect via heartbeat) -> recreate window, restore, mark interrupted. Verify Tauri 2.12.2 API first; fall back to heartbeat.
- Quit: never skip the draft decision on slow renderer (extend wait or persist drafts then proceed); confirm when runs are active; first-hide notice; Windows session-end bypasses confirmation; macOS fullscreen exits before hide; relaunch during `Closing` waits/retries.
- All of this is kept compatible with a later Host-process migration (persistence and interrupted-marking are Host responsibilities in dsh too).

## Risks
- Windows/WebView2 hooks cannot be executed here; mark claim-only.
- Tauri may lack a WebView-terminated event on one platform; heartbeat fallback adds a small timer cost.
