# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

Required gates include TypeScript, full Vitest, formal `quality`, its self-test, `models-dev:verify` and production build; the E07/QG contract below governs lint/architecture/unused evidence. `pnpm lint` still means `tsc -b`, not the formal ESLint gate. Current tests exercise pure helpers, business commands, production callback hosts and actual storage adapters. Read [Shared Product Storage](./shared-product-storage.md) for native transactions/binaries and acceptance boundaries.

---

## Commands

| Command | What it does |
| --- | --- |
| `pnpm lint` | `tsc -b --pretty false` (typecheck) |
| `pnpm test` | `vitest run` |
| `pnpm test:storage:native --evidence-dir <empty-directory>` | Rebuild the locked real Rust probe, run shared core/business suites on SQLite and record source/tool/table evidence |
| `pnpm build` | Build web/site separately and assemble their deployment output |
| `pnpm quality` | Formal ESLint, architecture and full-scope unused checks |
| `pnpm quality:self-test` | Regression of the quality gate and evidence identities |
| `pnpm dev` | Vite dev server |

Use the explicit approved machine pnpm path from AGENTS.md. Vitest defaults to the shared browser adapter and fresh `fake-indexeddb` lifecycle. The explicit `MOMOKI_STORAGE_TEST_OWNER=sqlite` lane resolves both alias and relative database imports to an actual disposable Rust probe facade and resets its workspace per test. An explicit native acceptance run must fail when the real executable is missing. Historical original/current comparisons select an isolated raw browser comparator; immutable snapshot bytes must remain unchanged.

The permanent native runner supports `--suite core|business|all`; `all` is the complete gate. It rejects a nonempty evidence directory, forces actual native capabilities, verifies unchanged source identities and records the current probe hash. Tool instrumentation calls the original recipes and records method/test outcomes; table instrumentation records confirmed commits without row values or tool arguments. Counts alone do not replace the assertions in those suites or actual packaged acceptance.

For the Agent epic's owner-selected necessary-only stage checks, explicitly
select `vitest.agent-source.config.ts` when changed reusable sources make
emitted packages stale. This independent Node >=24.11 profile exercises only
the affected core suites and actual Todo SQLite fixture through three exact
public source entries; it has no Studio database setup. Its strict noEmit type
project is `tests/typecheck/tsconfig.agent-source.json`; separately check the
core project's neutral `types: []` boundary and `tsconfig.node.json`. Scoped
ESLint retains its rules and may use that source type project. Root tests and
configuration files outside typed lint patterns are not claimed as linted.
Register the source runner as a precise static Knip plugin entry so ordinary
Node22 analysis does not execute its Node24 runtime guard; its helper is
reachable through the real config import, not a dummy entry. Keep the exact
root configuration in quality input identities. Default test/quality artifact
freshness and emitted/packed/native gates remain intact and deferred to the
owner's final batch acceptance; never rebuild implicitly or forge a receipt.
When the actual running app needs changed public library exports, explicitly
regenerate its library dependencies and verify the emitted entry/freshness before
handing the development workspace back. That necessary runtime repair is not a
full application build or proof of isolated packed-consumer acceptance. Source
aliases alone cannot establish that a browser using `dist` can load the change;
see [package boundaries](./monorepo-boundaries.md).

Studio consumers use the separate explicit `vitest.studio-source.config.ts`
profile and `tests/typecheck/tsconfig.studio-agent-source.json` when those same
public artifacts are stale. `tooling/vitest.studio.ts` owns the shared config
factory: preserve the actual historical snapshot/storage fixture/tool coverage
plugins, dependency resolution, `@` alias, fresh ProductStore setup and native
owner flags. The default config still checks artifact freshness before calling
the factory. The explicit source config selects only its finite affected suites
and three exact public Agent aliases; it neither imports the default config nor
adds production or dev source aliases. Preserve Studio's Node22 compatibility;
the neutral Todo SQLite source runner retains its separate Node24 requirement.
Register both explicit source configs as precise static Vitest plugin entries,
their exact noEmit projects in TypeScript discovery, and consumed root configs
in quality input identities. The factory is reached by real imports, never a
dummy entry. Source tests do not establish current emitted or native execution.

---

## Required Patterns

- Durable mutations only through concrete `packages/studio/src/features/<feature>/commands/` owners (see the D02 map in state-management), including `features/video/commands/proposals.ts` and the Agent command repositories (`add*` / `patch*` / `delete*` / `set*Slot` / reorder helpers).
- Live reads with `useProductQuery(tx => ...)`; detail `get` queries use `?? null`. Propagate readonly context to nested readers (see hook-guidelines).
- Shot picture / generation data through `parseShotPictureSlots` / `parseGenerationSlot` so legacy fields stay readable.
- Filter, reorder, undo, draft, delivery, and shortcut-gating logic live with their owning feature or the explicit `app/drafts` and neutral `platform` owners and are shared — UI calls helpers, does not reimplement:
  - `shotFilters`, `reorderIds`, `undo`, `debouncedDraft`, `episodeDelivery`, `formFieldFocus`, `shotKeyboard`
- Studio asset create stays on studio routes with `STUDIO_LIBRARY_ID`; `touchProject` no-ops for the studio owner.
- Episode-scoped shot queries and delivery exports filter by both `projectId` and `episodeId`.
- Keyboard shortcuts call `isFormFieldTarget` before handling (`ShotEditorPage`).

---

## Forbidden Patterns

| Forbidden | Why / do this instead |
| --- | --- |
| Studio create → project picker or `/p/$projectId/...` | Navigate to `/characters\|scenes\|props\|styles/$id` |
| `useEffect` + one-shot `db.*.get` for live detail pages | `useProductQuery(tx => ...)` + `?? null` |
| Global Redux/Zustand/etc. for durable tables | Shared query hook + repo mutations |
| Duplicating reorder/filter logic in the page | `reorderBeats` / `reorderShots` / shared filter helpers |
| Enabling export before live queries finish | Disable CSV/print until loaded (delivery-export) |
| Component RTL / Playwright as the default new test | Prefer `tests/*.test.ts` on lib + repo |
| Adding ESLint-only “fixes” without satisfying `tsc` | Both formal quality and TypeScript must pass |
| `window.prompt` / `alert` / `confirm` | In-app `Dialog` (input) / `AlertDialog` (destructive) from `packages/studio/src/ui/` |
| `scrollIntoView({ behavior: "smooth" })` on Agent messages | `snapChatToBottom` on `.agent-message-list` (see chat-performance) |

---

## Testing Requirements

- Place tests under `tests/` as `*.test.ts`.
- Repo / adapter behavior: use shared fresh setup. Transaction-bound table handles require actual backend or bound-table fault injection; root-table spies may never reach the write. Retain fault-reached, rollback and uncommitted-read assertions. Browser scope tests may inspect the actual underlying Dexie/IDB transaction; native cases inspect the real bridge/SQLite, not fabricated completed replies.
- Pure helpers: unit-test without mounting React (`tests/undo.test.ts`, `debouncedDraft.test.ts`, `shotFilters.test.ts`, `formFieldFocus.test.ts`, `reorderIds.test.ts`, `episodeDelivery.test.ts`, `projectPackage.test.ts`).
- Cover invariants called out in other specs when touching those areas: studio `touchProject`, snapshot copy reject-on-duplicate, episode-scoped reorder ownership, delivery CSV quoting, form-field shortcut gating, agent chat `snapChatToBottom` / `CHAT_AT_BOTTOM_PX`.
- Do not require new component snapshot/RTL tests unless the change is untestable at the lib/repo layer.

---

## Accessibility and UX quality

- Keep focus-visible rings on interactive primitives (`packages/studio/src/ui/*`).
- Mark decorative motion/graphics `aria-hidden` (`ClickSpark`).
- Prefer Chinese user-facing strings consistent with existing pages (加载中…, 找不到…).
- Honor `prefers-reduced-motion` for decorative animation (`ClickSpark`, `packages/studio/src/ui/theme.css`).

---

## Code Review Checklist

- [ ] TypeScript, full tests and formal quality pass for the final frozen scope
- [ ] Mutations go through their concrete business command owner; no ad-hoc `db.table.put` in components unless matching existing rare patterns
- [ ] Detail shared query uses `get(id) ?? null`; missing id shows 找不到, not infinite 加载中
- [ ] Studio vs project ownership and `back` discriminants are correct
- [ ] Shot/episode scoping preserved (filters, reorder, delete, delivery)
- [ ] Shared helpers reused for filter/reorder/draft/undo/shortcuts
- [ ] Types imported with `import type` where needed; domain types not duplicated
- [ ] New durable behavior has or updates a `tests/` case when logic is in lib/repo

---

## Examples

- Repo invariants: `tests/repo.test.ts`
- Shortcut gating helper: `packages/studio/src/ui/formFieldFocus.ts` + `tests/formFieldFocus.test.ts`
- Delivery pure logic: `packages/studio/src/features/video/services/episodeDelivery.ts` + `tests/episodeDelivery.test.ts`
- Typecheck gate: `package.json` script `lint`

---

## Anti-patterns

- Treating the TypeScript-only `lint` script as complete formal quality proof.
- Adding a second state library “just for this page.”
- Copy-pasting reorder or filter code into `ShotEditorPage` instead of extending its concrete feature command or pure helper owner.
- Shipping package-import changes without updating `tests/projectPackage.test.ts`.

---

## References

- `package.json` scripts
- `vitest.config.ts`, `tests/setup.ts`
- `features/projects/commands/projects.ts`, `features/video/commands/{episodes,shots}.ts`, `features/library/commands/{assets,media,assetReuse}.ts`, `features/settings/commands/connectors.ts`, `features/agent/commands/chat.ts`, and concrete `features/{projects,agent}/commands/lifecycle.ts`
- `ui/formFieldFocus.ts`, `platform/collections/reorderIds.ts`, `features/video/services/shotFilters.ts`, `features/video/services/episodeDelivery.ts`
- `.trellis/spec/frontend/hook-guidelines.md`, `state-management.md`, `delivery-export.md`

## Release gate

`.github/workflows/ghcr.yml` runs locked dependency installation, TypeScript, the full Vitest suite, model catalog baseline verification (`pnpm models-dev:verify`) and a production build on main pull requests, main pushes, release tags and manual runs. The Docker publication job depends on successful quality checks; pull requests never publish images. Only the publication job has package write permission. The pnpm setup uses the version pinned by `package.json`.

## Desktop distribution gate

`.github/workflows/desktop-release.yml` adds a separate four-host installer gate
under [Desktop Distribution](./desktop-distribution.md). By explicit owner
decision on 2026-10-12 it performs packaging only: no quality job, automated
tests, lint or application-launch/storage smoke. Hosted builds still use pinned
tools and locked dependencies; normal shipping features remain product-sqlite
only. Source/version/host/target/file/hash receipt closure remains mandatory.
Successful build output is `packaged` with no passed test rows or runtime
evidence. Owner functional validation is required before public release and is
not asserted by the workflow.

Keep independent GHCR quality and standalone native/storage/smoke commands
intact. Local collector/fake-GitHub regression tests verify changes to delivery
tools; they do not establish hosted delivery. Actual four-target package
collection and tag/draft upload still need outcomes before task archival.
Bootstrap/manual builds cannot mutate Releases; the final tag-only owned draft
publisher receives the only contents-write permission.

## Cold root-test native probe prerequisite

### 1. Scope / Trigger

Apply to every fresh CI job that runs the complete root Vitest suite, including
GHCR quality. Desktop package delivery is packaging-only by owner decision and
has no quality job or root-test invocation. Six ordinary root suites execute the
real Rust SQLite bridge even while the default database owner is browser. A
later matrix job or a developer's ignored `.tools` output cannot satisfy this
job's prerequisite.

### 2. Signatures / Owners

The shared preparation entry is `tooling/prepare-native-test-probe.mjs`:

```text
node tooling/prepare-native-test-probe.mjs --cargo ABSOLUTE_CARGO --rustc ABSOLUTE_RUSTC --target-dir FRESH_ABSOLUTE_TARGET --evidence-dir FRESH_ABSOLUTE_EVIDENCE --github-env EXISTING_REGULAR_ENV_FILE
```

`nativeProbeBuildArguments` and `nativeProbeOutputPath` in the existing desktop
tool resolver own the locked no-GUI build arguments and debug executable path.
The native acceptance runner shares those arguments while retaining its own
full storage/Agent evidence and explicit target triple.

### 3. Contracts

Install fixed Rust1.99.0 and pass actual Cargo and rustc executable paths. Verify
both versions, bind `RUSTC` explicitly and reject compiler wrappers. Build in a
fresh target directory with `--locked --no-default-features --features test-hooks
--bin product_store_probe`. This needs no desktop/product-sqlite feature,
frontend or GTK. Before appending `MOMOKI_NATIVE_STORE_PROBE` to `GITHUB_ENV`,
the produced binary must acknowledge ready and close in a disposable workspace
and exit successfully. Keep finite build/readiness evidence. Tests receive the
exact just-built path; a stale local default cannot count as proof.

GHCR retains its Node22 contract; explicit standalone desktop checks retain
their pinned Node24.11.0 lane.
Do not loosen the release hosted-tool validation to prepare the GHCR probe.
Do not set `MOMOKI_STORAGE_TEST_OWNER=sqlite` or
`MOMOKI_NATIVE_STORAGE_ACCEPTANCE=1` for ordinary root tests. Existing opt-in
binary acceptance and its skip behavior remain separate.

### 4. Validation / Error Matrix

| Input or outcome | Required behavior |
| --- | --- |
| Missing probe before preparation | Reached ENOENT; never silently skip native tests |
| Wrong compiler version, wrapper, stale target or invalid output | Fail preparation; do not export the probe path |
| Cargo failure, malformed readiness or unsuccessful exit | Stop before root tests |
| Fresh no-GUI probe ready and cleanly closed | Export exact path, then run unchanged full root suite |
| Build setup only in another job | Insufficient; each root-test job prepares its own probe |

### 5. Good / Base / Bad Cases

Good: a fresh quality job compiles and checks the actual probe before all root
workers start. Base: local existing probe allows development tests, with no
cold-CI success implied. Bad: passing only warm-cache tests, preparing after
Vitest, enabling a different database owner, or replacing native tests with
mocks/skips to resolve an ENOENT.

### 6. Tests Required

Reproduce missing-path failure, build into a genuinely fresh target and run the
affected native cases through that exact binary. Run the complete root suite
with unchanged owner/acceptance flags. Exercise preparation failure, stale
output, wrong tools and readiness rejection. Verify preparation precedes root
tests in each workflow that actually runs them. Local macOS cold proof does not
replace hosted Linux execution or cross-platform installer acceptance.

### 7. Wrong vs Correct

Wrong: treat the 92 missing-executable failures as 92 separate storage bugs or
assume a downstream platform build prepares a quality job. Correct: establish
the actual shared prerequisite in each job, preserve the tests, bind the exact
probe path and distinguish local verification from the next hosted run.

## Desktop Knip cross-package callers

### 1. Scope / Trigger

Apply when desktop scripts export helpers used by root CLI commands. Root formal
quality and desktop Knip are separate gates; neither implies the other passed.

### 2. Signatures / Owners

Run the desktop `quality` package command from `apps/desktop`.
`apps/desktop/knip.json` declares `.` for the original desktop entry/project
lists and `../..` for real root CLI ownership. The preparation CLI is an explicit
entry; `test:storage:native` in the root package supplies its actual CLI entry.

### 3. Contracts

Keep original desktop discovery and issue categories. The new parent workspace
has an empty project list and disables Node, TypeScript, Tailwind, TanStack
Router, Tauri, Vite, Vitest, ESLint and GitHub Actions auto-discovery. Do not make
the shared resolver itself an entry, ignore exports or add dummy consumers.
External path globs without a workspace owner do not establish caller usage.

Removing a workflow caller can expose genuinely unused CLI exports in root
quality even when the desktop graph passes. If a constant or `main` is used
only inside its retained standalone CLI, remove the unnecessary export keyword
and preserve its implementation. Do not add dummy entries or suppressions to
keep the old workflow's apparent usage. When removing a job, update workflow
shape regressions while retaining the assertions for independent active jobs.

### 4. Validation / Error Matrix

| Condition | Required outcome |
| --- | --- |
| Real root CLI imports a shared desktop helper | Resolve and analyze that actual caller |
| A genuinely unused resolver export is added | Desktop Knip fails with that export |
| Root caller ownership is removed | The missing-use findings return |
| Parent discovery expands unrelated root UI/archive/dependency tests | Reject that configuration even if Knip exits zero |

### 5. Good / Base / Bad Cases

Good: precise owned workspaces plus actual CLI import closure. Base: desktop-only
scope when all consumers live there. Bad: broader entry discovery makes unused
source appear reachable or root quality is reported as desktop quality proof.

### 6. Tests Required

Run both actual quality commands. Inspect final caller traces and workspace
plugins. In a disposable source copy, add an unused resolver export and remove
the parent caller workspace; both must fail. Keep original source untouched.

### 7. Wrong vs Correct

Wrong: add external root tooling globs alone or suppress the two export names.
Correct: establish their real workspace owners, preserve the original desktop
scope and verify a newly unused export is still rejected.

## Optional analytics deployment

`VITE_UMAMI_SCRIPT_URL` and `VITE_UMAMI_WEBSITE_ID` are public build-time settings supplied by GitHub Actions repository variables. Keep the workflow's Vite build environment and Docker build arguments aligned. The Docker arguments belong only to the build stage; Compose and the Nginx runtime need no analytics environment variables. Local `.env` files are excluded from Git and Docker contexts, with `.env.example` as the documented template.

Initialize Umami once from `packages/studio/src/app/bootstrap.tsx` outside React lifecycles, only for production builds with both settings. Use the tracker’s own SPA pageviews; adding router listeners or manual pageview calls would duplicate visits. Analytics loading must not block React rendering. Do not attach project contents, prompts, or provider credentials to analytics events. Clearing configuration takes effect only after rebuilding and redeploying the image.


## Audit evidence contract (2026-09-30)

A full-source audit must maintain a fixed file manifest and an explicit review ledger.
Tool success, passing tests and long-file inspection alone do not establish full coverage.

- Manifest records `baseRevision`, every scoped path and its content `sha256`; detect source changes before finalizing findings.
- Per-file coverage uses `{ path, status, note, findings }`. Status is `reviewed`, `generated-verified`, or `blocked`; a blocked or missing file prevents a claim of complete coverage.
- Review ordinary code in full. For generated data/code, state the generator/source and exact verification performed; do not claim manual line review of generated JSON.
- Confirmed findings need location, triggering input/call sequence, mechanism, impact, recommendation and behavior validation. Label untested runtime/browser concerns as risk; structural debt alone does not prove a current failure.
- Separate type-only edges from value imports when reporting cycles. A cycle reporter may filter its first edge yet include type edges later in the path; validate the complete value cycle.
- Knip export/file candidates require entry-point, ambient declaration, CSS import and test-only usage checks. In this project `packages/studio/src/features/references/documents/mammoth.d.ts` contributes the declaration for the browser import and must not be removed solely because no runtime import points at it.
- React rule matches for ordinary business functions named `useX` require inspecting whether they actually call React Hooks; naming matches alone are not runtime Hook evidence.
- Clone/complexity counts are locating signals. Compare business contracts before consolidating retries, validators or CRUD; do not reduce complexity by removing safety checks or adding forwarding abstractions.
- Preserve raw commands, versions, exit status and diagnostics. JSON reporters can exit zero while their summary contains violations; inspect both.
- An audit report is not a product fix. State whether tools/rules were merely run, permanently configured, or connected to CI; recommendations do not imply adoption.

The 2026-09-30 source audit and proposed architecture/tool gates are recorded in
`.trellis/tasks/archive/2026-10/09-30-src-quality-architecture-audit/`. The existing project quality
commands above remain the installed gates until a subsequent implementation changes them.

## Durable original-source comparison fixtures (2026-10-08)

## 1. Scope / Trigger
Use this rule when a permanent regression compares current behavior with immutable original code captured during a task. Archiving task records must not remove test inputs or make tests write into archived directories.

## 2. Signatures / Owners
Permanent tests consume the minimal required original module closure under `tests/fixtures/sourceSnapshots/{d05,d06,d07}`. Preserve snapshot bytes and relative import hierarchy, with original-path/hash provenance. Task research/reviews remain immutable evidence, not runtime test dependencies.

## 3. Contracts / Invariants
Copy needed modules; do not move or edit historical evidence. Resolve relative imports within each snapshot closure. Existing alias imports and intentionally shared untouched dependencies retain their original comparator semantics. Tests remain read-only with respect to task reports. Remove a redundant report write only while keeping its behavioral assertions. Original-versus-current comparison must still execute real parsers/adapters, not canned expected outputs.

## 4. Validation / Error Matrix
| Condition | Required behavior |
| --- | --- |
| Active task folder unavailable after archive | Permanent regression still resolves and executes |
| Missing transitive snapshot import | Fail fixture completeness proof/test |
| Snapshot byte differs from recorded original | Fail provenance proof |
| Test writes task report | Remove side effect, retain asserted behavior |

## 5. Good / Base / Bad Cases
Base: stable test fixture imports with original bytes. Good: archive-unavailable execution verifies all affected comparisons. Bad: a permanent test imports an active dated task folder, rewrites accepted evidence, or relies on an assertion-free report generator.

## 6. Tests Required
Run affected original/current behavioral comparisons and demonstrate execution/resolution with the active task directory unavailable in an isolated environment. Verify the minimal relative import closure and original byte hashes; retain any failed attempt and state finite limits.

## 7. Migration / Limits
This correction preserves comparison semantics and evidence while making test inputs durable. It does not claim snapshot source satisfies current production rules, replace current production owners, or close E/QG01 debt. Archived native research scripts are historical evidence unless separately adopted as stable regression entry points.

## B01 native harness isolation and failure authority (2026-10-08)

### 1. Scope / Trigger
Maintain when changing the standalone B01 browser runner or its local Vite setup, particularly repeated runs across different fixture configurations.

### 2. Signatures / Owners
`tooling/b01-browser-regression.mjs` creates a fresh temporary `cacheDir`, explicitly scans the actual B01 fixture HTML via `optimizeDeps.entries`, and removes its cache after closing Vite. Main-frame document requests are counted; only initial fixture loading is allowed during the SPA regression sequence.

### 3. Contracts / Invariants
Keep every existing business assertion and timeout. Unexpected full-document reload is a failure, not authority to reinitialize fixtures, retry interactions, ignore missing bridge objects or increase waits. Cache separation is test isolation, not a product fix or proof of the original failure cause. Keep prior failures and configuration/runtime inputs.

### 4. Validation / Error Matrix
| Condition | Required result |
| --- | --- |
| Initial fixture document | One allowed main-frame document request |
| SPA route/history and dialogs | All existing assertions; no extra document request |
| Extra document navigation/reload | Explicit test failure |
| Consecutive cold runner instances | Separate temporary caches, same semantic assertions |

### 5. Good / Base / Bad Cases
Base: all19 scenarios pass from a fresh isolated cache. Good: an unexpected reload fails instead of silently recreating controls. Bad: calling a warm rerun proof that an unobserved root cause was fixed.

### 6. Tests Required
Preserve exact before/after assertion/timeout comparison and actual consecutive cold runs. Final current-source batch must include this runner. Retain failed logs and distinguish observed behavior from causal inference.

### 7. Migration / Limits
This scoped correction does not establish why earlier blank-page/bridge failures occurred; observational isolated and forced-cold shared controls both passed. It does not modify product behavior, install dependencies, migrate every other historical native program or close formal E/QG01 work. Local Chromium fixtures do not prove full-product or live-provider behavior.

## E07 formal source quality contract

Independent E07 integration accepted on 2026-10-09.

### 1. Scope / Trigger

All authored src changes and necessary regression runners/configuration use the root type check, formal quality CLI, meaningful tests and build/model gates. Imported vendor stays outside manual review but remains compiler/build input. Generated route is excluded from typed lint; generated icon data is included. SonarJS supplies local ESLint rules; no SonarQube service is required.

### 2. Signatures / Owners

`quality` runs `tooling/quality-check.mjs`; `quality:self-test` runs its actual CLI synthetic contracts. Root `eslint.config.mjs`, `knip.json`, pinned package/lock, exact `quality/debt.json` and `quality/unused-contracts.json` own policy. CI runs both commands before tests while retaining Node22, existing triggers, image publication and permissions. Local commands use the authorized explicit machine pnpm executable.

### 3. Contracts / Invariants

Typed recommended, Hook rules/dependencies, exhaustive switches and duplicated branches/conditions block new errors. Only individually reviewed error nodes with exact rule/file/parser tokens/semantic owner/count/reason may pass; producer hash and TypeScript version changes require review. Strict unknown/any throws fail; recognized caught rethrows and package-origin TanStack Redirect retain their contracts. Static value cycles and Domain→DB/UI or DB→UI value edges fail. Dynamic literal edges obey boundaries but do not create static cycles. Full-scope owned unused findings require precise retained API/import/declaration/runtime evidence. Any remaining nonzero Knip tool/config exit fails. Repair leaves stale debt/contracts until explicitly shrunk. Inline lint directives do not authorize exceptions.

### 4. Validation / Error Matrix

Mutation/owner transfer, changed multiplicity, duplicated JSON keys, stale removal, producer/evidence changes and unsupported tool outputs fail. Formatting/line relocation, exact parser tokens, type-only edges, supported retained APIs and caught error identity pass. Anonymous and named expression callback ownership binds actual call/new kind, optional call, argument role, other arguments, callback flavor/self-binding and control-flow owner. Indistinguishable callback/control boundaries cannot receive debt. Complexities, depth and nested ternary are visible review warnings; they cannot be baselined as debt.

### 5. Good / Base / Bad Cases

Good: narrow unknown values at actual boundaries and remove unused internal exports without changing bodies. The original baseline had thirteen reviewed diagnostics. Shared-storage certainty handling removed the cause-discarding ambiguous-tool node in runChat, so its stale exact allowance was removed; the current eleven retain four sanitized wrappers, six original failure/cancellation transports and one guarded every-render draft reconciliation.

Workspace discovery currently has sixteen exact unused contracts: six retained contracts (one icon-generator companion declaration, two explicit optional-runtime/virtual imports, two documented audio deletion APIs without current UI callers, and the development-only Lucide dependency), eight individual projection companion declaration symbols, the pinned desktop Tauri CLI dependency invoked through the actual package scripts, and the host OpenSSL command used only to generate the standalone MCP regression's temporary localhost TLS certificate. Projection contracts bind real `.mjs` implementation/consumer hashes and TypeScript's `.d.mts` resolution; they are not dummy consumers. The Lucide contract is tied to unchanged historical comparison sources and the real E02/E04 loaders; it does not permit application Lucide use. Former stylesheet allowances are no longer needed by the actual workspace graph and were removed. Counts describe reviewed findings, not a target or permission to broaden scope. Bad: blanket ignores, automatic import of all baseline errors, every-source-as-entry reachability, arbitrary test deletion or assertions that hide unsafe inputs.

New Studio files need exact `file`/`target`/`owner` rows in `quality/studio-ownership.json`, including feature-private runtime files. A missing owner can also produce a private-feature import finding between two files in the same feature; repair the ownership row before widening public types. Standalone native fixtures built with an explicit Vite HTML root need their actual module script entry in both root and desktop Knip configurations (`ui/e11Background.ts` for E11); do not mark unrelated UI files as entries.

Before removing a reported export/type, inspect actual consumers, including inline `import("module").Type` references. Preserve genuine API types with ordinary named type imports so Knip sees the existing relationship. Local-only declarations can lose `export` without changing their implementation. When a release bump changes a hash-bound manifest such as `apps/desktop/package.json`, review its diff and refresh only the corresponding retained-contract evidence; a version-only edit still invalidates the previous complete-file hash.

### 6. Required Tests

Actual production CLI must reject sibling callback and branch debt transfers, support formatting/recursion, detect stale/decreased debt and exact evidence changes, and preserve Knip exit authority. Accepted E07 runs 88 such cases. Run actual strict app types, full tests, model verification, build and Node22 fresh locked installation. Native draft test requires explicitly injected browser/runtime and proves stable primitive and memoized external values after in-flight persistence. Default CI skip is explicit; an opt-in acceptance run must prove execution. Current E07 exact local verification: 172 files/3028 tests, 419 owned graph files/1644 static value edges/6 literal dynamic edges, zero cycles/forbidden/unallowed findings, 512 visible review warnings. These are dated proof counts, not fixed acceptance thresholds.

### 7. Wrong vs Correct / Attribution and Limits

Wrong: zero warnings claim, counted unresolved historical metadata imports as repairs, normalized an unexplained tool exit into success, or treated source counts as user-visible performance. Correct: complete historical imported vendor/dependency closure, individual before/current rule interpretation, exact independent coverage, explicit generated-route token equivalence/restoration and real source hashes. Local macOS Node22 proof is not Linux GitHub execution; offline/generated-media native tests do not establish paid providers, mobile/device/OS scheduling, battery or latency behavior.

## Error diagnostics and redaction (2026-10-14)

### 1. Scope / Trigger
Read before adding any UI error output, changing `packages/studio/src/platform/diagnostics/` or `packages/studio/src/app/errors/`, or putting new data into a diagnostic report. Diagnostics are user-initiated only: nothing is persisted or sent automatically.

### 2. Signatures
`sanitizeText(input, limit?)`, `sanitizePath(pathname)` (`sanitize.ts`); `addBreadcrumb(kind: "route" | "action", label)`, `getBreadcrumbs()` (ring of 30, memory only); `toErrorInfo(cause)`, `buildDiagnosticReport(info, context)`, `buildIssueUrl(info, context)` (`errorReport.ts`); `friendlyMessage(cause)`; `reportError(cause, {source: "boundary" | "global" | "action", actionName?})`, `getLatestError()`, `subscribeLatestError` (`reportError.ts`); `showError({title?, cause, actionName?, detail?})`, `installGlobalErrorHandlers()` (`showError.ts`); `openErrorDetails()` / `ErrorDetailsDialog`. Browser Vite config and `apps/desktop/scripts/build-frontend-worker.mjs` define `__APP_VERSION__` from the root app release version; `appVersion()` falls back to `"dev"`.

### 3. Contracts
- One export point: every displayed, copied, saved or URL-embedded string goes through `sanitizeText`; a failure inside sanitizing returns the placeholder, never the raw text. Patterns cover URLs (userinfo and query removed), `sk-` keys, Bearer/Authorization/Cookie, generic `token|secret|password|api_key` pairs, JWTs, local paths (including user names with spaces), 32+ character random runs.
- `toErrorInfo` reads only `name`, `message`, `stack` (20 lines), `certainty`/`code` and `failure.effectCertainty/code`. It never reads arbitrary own properties (`request`, `config`) and never walks `cause` for content.
- Breadcrumb labels are route paths or fixed action names. Never pass user input, prompts or content.
- `actionName` is a fixed literal at the call site. `detail` is actionable business text and is sanitized and truncated to 200 characters before display; it must never be raw provider output that echoes a prompt.
- `AbortError` anywhere in a short `cause` chain is a normal cancellation and is never reported. Identical fingerprints within 1 second are reported once (covers StrictMode and the three boundary callbacks).
- No automatic transmission: no `fetch`, `sendBeacon`, image beacon or analytics call may carry diagnostic data. The dialog states this and copy, save and GitHub open happen only on click. Clipboard failure falls back to selecting the textarea.
- Only the listed chat and connector failure sites use `showError`; other `toast.error` calls stay as they are until migrated deliberately.

### 4. Validation & Error Matrix
| Condition | Result |
| --- | --- |
| `AbortError` (or abort in cause chain) | Ignored |
| Same fingerprint within 1 s | Single report and toast |
| Sanitizer throws | Placeholder, never raw text |
| Clipboard missing or rejected | Select textarea, show manual-copy hint |
| Storage failed to open | Fixed friendly page plus details; never `cause.message` |
| Page render error | Only the workspace is replaced; nav and header stay |

### 5. Good / Base / Bad Cases
Good: a rejected send shows a friendly title with the sanitized original message and a "查看详情" action. Base: an unknown render error shows the generic page with retry, home and details. Bad: interpolating an error object or request config into a report, adding a prompt excerpt as a breadcrumb, or catching a cancellation as an error.

### 6. Tests Required
`diagnostics.test.ts` (each secret shape and its counter-example, ring size, dedupe window, wrapped abort, friendly classes, report has no content fields), `errorFallback.test.ts` (workspace-only replacement, root boundary, global handlers, AbortError not reported), `errorDetailsDialog.test.ts` (each action, clipboard fallback, redaction in text, saved Blob and issue URL, no `fetch`), `errorBoundaryChatUnmount.test.ts` (unmount cleanup, `recoverAbandonedRuns`). Real-window acceptance covers the crash page, 760px dialog layout and the packaged clipboard.

### 7. Wrong vs Correct
Wrong: `toast.error(String(error))` or putting `error.request` into a report. Correct: `showError({title, cause, actionName: "send-message", detail})` and let the report builder read the fixed fields.


## Landing page gates (2026-10-14)

After root `pnpm build`, run `pnpm landing:budget`: it checks the site's eager/lazy built dependency closure excludes studio, storage, Agent, Dexie, zod, antd, LobeHub, TanStack Router and Tauri. Retain gzip budgets (JS 120 KB, CSS 15 KB) and desktop site exclusion. Web/site build separately; deployment assembly merges complete manifests/module reports and rejects conflicting files/reports or missing references before replacing the output. Landing tests live in `tests/landing*.test.ts`; copy checks share `tests/fixtures/landing/forbiddenClaims.ts`. Details: component-guidelines "Landing page (standalone entry)".
