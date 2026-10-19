# Research: our-execution-ownership (where Agent execution lives today; process-boundary options)

- **Query**: Map what lives in WebView module state for Agent execution, where ProductStore/SQLite/native storage live, which Rust/Tauri processes exist, what the Agent runtime needs; identify smallest viable process-boundary options (A in-Rust host, B Node/other sidecar, C hidden persistent WebView with crash recovery + persistence) with cost/risk and effect on PRD P1/P2 items.
- **Scope**: internal (repo `aifenjing`, branch `codex/agent-background-host`); dsh (`deepseek-harness`) read only for comparison
- **Date**: 2026-10-16
- Paths: `S/` = `packages/studio/src/`, `R/` = `apps/desktop/src-tauri/src/`. Evidence is from reading code; nothing was built or run.

## Findings

### 1. What lives in WebView module state for execution

| Owner | File | State / what it holds |
|---|---|---|
| Execution service singleton | `S/features/agent/runtime/agentExecution.ts:5` (`createAgentExecutionService({store: db})`), impl `agentExecutionService.ts` (397 lines) | Per-thread owner map (invocation token, AbortController, feedback controller, `done` promise), submission `attempts[]` (memory-only), `lastFeedback`, listeners, memoized `initialize()` / `shutdown()` |
| Thread work registry | `S/features/agent/runtime/threadWork.ts` (66 lines), `WeakMap<ProductStore, Owners>` | live `Map<threadId, AgentThreadWork>` of kinds `model`, `videoBatch`, `audioBatch`, `taskWrapup`; `closed` flag; listeners. Never reconstructed from stored IDs (comment line 4) |
| Draft store | `S/features/agent/runtime/chatDraftStore.ts` (245 lines), `drafts` plain object (line ~14), `controllers`, `imports` Set of promises, `File`/Blob objects of reference imports | memory only, no persistence, no eviction for deleted threads |
| Thread lock capability | `S/features/agent/runtime/runOwnership.ts:11-60` | `navigator.locks.request("cuepoint:agent:<threadId>", {ifAvailable:true})` (Web Locks, per origin/WebView), `WeakMap<ThreadOwnership, CapabilityState>`; `recoverAbandonedRuns` (`:76-97`) |
| Effect admission | `S/platform/runtime/effectAdmission.ts` `productEffectAdmission` | module boolean `open`; closed by Quit |
| Run credentials | `S/features/agent/runtime/runCredentials.ts` | API key resolved at each dispatch from `connectors` table (`resolveConnector`); `seen` Set for redaction; `connectors` is a `device`-scope table (`S/platform/storage/schema.json:171`) |
| Studio host binding | `S/features/agent/runtime/runChat.ts:37-` `createStudioRuntimeHost(db, ownership, apiKey, fetchImpl, materialized, signal, ...)` | builds `RuntimeHost` for `executeRun` from `@cuepoint/agent-core`; all transactions via `db.transaction('rw', scope, ...)` over ~12 tables |
| Tool registry | `S/features/agent/runtime/tools.ts:~100-141` `BUILTIN_TOOLS` (spread of IP, audio, music, audio gen/batch/arrangement, material, discovery, installed-skill, task, business, video generation, memory, reference, web, media-check, job, desktop-media tool arrays) | static, imported into the same bundle as React UI features |
| MCP connection owner | `S/features/agent/mcp/runtime/owner.ts` (`installed` singleton) + `connections.ts` | `generations` Map (server -> `McpRunGeneration`), `pending` connection controllers, `epochs`, `logins`/`pendingLogins` (OAuth), `revision`, `closed`; `dispose()` only at Quit (`disposeMcpRuntime`) |
| MCP run registry | `S/features/agent/mcp/runtime/runRegistry.ts` | per-run `createCapabilityRegistry` (from `@cuepoint/agent-core`), `assertBinding`, `mcpCapabilityBinding`; frozen from saved `McpRunSnapshot` |
| MCP host services | `S/platform/runtime/mcpServices.ts`, `nativeMcp.ts`, `browserMcp*.ts` | installed once at store selection (`S/platform/product/store.ts:30-33`): native -> Tauri `mcp_service_request`; browser -> in-page MCP client + OAuth popup |
| E07 job/report store | **ProductStore tables** `agentJobs`, `agentJobResultChunks` (`S/features/agent/commands/agentJobs.ts`, 368 lines; limits `AGENT_JOB_LIMITS` line 16: 2 MiB/output, 16 MiB/thread, 128 MiB total, 128 jobs/thread, 1024 total) | durable rows; every mutator calls `assertThreadOwnership(ownership, threadId)` (`:~30` `owner()`; `recoverAgentJobs` takes a `ThreadOwnership`). No in-memory job queue besides the tool call that is running |
| E06 grants | **Studio does not use `ResourceGrantPort`/`createCapabilityRegistry` grants.** Only `createCapabilityRegistry` is used, by MCP (`runRegistry.ts`); grant port has a single consumer, the Todo example (`review-E06.md` F3). Studio's "authority" = per-call approval rows (`agentToolCalls.decision/preview`) + MCP single-use authority validated in Rust `mcp/service.rs:~1190-1201` | approval rows durable in SQLite |
| Activity / unread | `S/features/agent/commands/threadActivity.ts`, `queries/threadActivity.ts` | durable in `deviceSettings`; busy state derived from live owner (not DB) |
| Video/audio batch workers, task wrapup | `S/features/video/agent/generationBatchRuntime.ts`, `S/features/audio/generation/batchRuntime.ts`, `S/features/agent/runtime/taskWrapup.ts` | live AbortControllers + `done` promises registered into `threadWork` |
| Network (model) | `S/platform/runtime/runtimeFetch.ts` -> `tauri-plugin-http` (vendored patch `R/../vendor/tauri-plugin-http`) with `authorize_http_origin` (Rust grants per origin at runtime, `httpPolicy.ts:configuredOrigins` reads `connectors`/`searchConnections` via the store); redirects, 30 s connect timeout, in-flight controllers aborted on `pagehide`/`beforeunload` (`runtimeFetch.ts:19-41`) | page-lifecycle coupled |
| Providers | `packages/agent-providers/src/{chatCompletions,responses,wire,http/*}` | uses `fetch` injected; `@cuepoint/agent-providers/http` has `requestBoundary.ts` |

Size context (non-test source lines): studio `features/agent` 23,648; `features/video` 12,251; `features/audio` 9,662; `features/library` 8,035; `platform` 8,511 (incl. 4,496 in `platform/storage`); `app` 6,608; `references` 2,048; `memory` 2,631; `music` 1,064. `packages/agent-core` ~1,767 lines in `src/*.ts` incl. tests; `agent-providers` is small.

### 2. Where the product data live

- **Authoritative SQLite is owned by Rust**: `R/full_product_store/` (mod.rs 1,585; protocol.rs; query.rs; registry.rs; tests.rs 859) runs on a dedicated std thread `StorageWorker` (`R/worker.rs`, `ProductJob::{Store, Validate, McpCatalogue, Binary}`). Table/index allowlist is the shared `S/platform/storage/schema.json` (`include_str!` in `R/full_product_store/registry.rs:25`; 53 tables, scopes content/device/mixed). `rusqlite` bundled with backup feature (`Cargo.toml`).
- **The transaction/query model is JS**: `S/platform/storage/{store.ts (288), native.ts (587), nativeBridge.ts (201), codec.ts, rowCodec.ts, validate.ts, protocol.ts}` implement the Dexie-like `ProductStore` API on top of a Tauri IPC row protocol (`begin/get/query/count/prepare/seal/commit/validate/abort/status/changes`; chunked at 256 KiB, `QUERY_PAGE_SIZE` 256; ≤64 live contexts native, 32 reads in JS `native.ts:~52`). Business logic (all commands/tools/queries) is TypeScript against this API; Rust sees rows and tables, not domain semantics. Binary media: `S/platform/storage/nativeBinary.ts` + `R/product_binary.rs` (1,249) + `R/product_media.rs`.
- **Browser (Web) build**: `S/platform/storage/browser.ts` + `browserDatabase.ts` over IndexedDB; selected by `getProductStorage().storage === "indexeddb"` (`S/platform/product/store.ts:21`). `apps/web` shares `@cuepoint/studio`. So the same TypeScript execution code runs in both (Web has no native process available).
- **Single-owner/session model**: every request carries `{session, workspaceId, generation}` (`protocol.ts` `NativeSession`). `product_store_request` with `Open` runs `lifecycle.detach(); invalidate_mcp; skill_import.invalidate; previews.clear; local_media.stop_all` (`R/desktop.rs:364-380`); `on_page_load Started` does the same (`R/desktop.rs:2037-2054`). A second opener or reload therefore invalidates the current session authority (MCP, previews, local media). `trusted(&window)` requires window label `"main"` and a bundled-origin URL (`R/desktop.rs:877-892`); capability file `capabilities/main.json` lists commands for window `main` only. `tauri.conf.json` has `"create": false`; the main window is built manually (`R/desktop.rs:1989-2008`) with macOS `BackgroundThrottlingPolicy::Disabled`.
- **Connector secrets**: API keys are plain rows in `connectors` (device scope) in the same SQLite, read in JS. MCP credentials are different: OS keychain via `R/mcp/vault.rs` (immutable chunked revisions, one namespace per app/profile/store/server hash).
- **Native workspace storage (reference path)**: `R/workspace.rs` (1,888) + `R/database.rs` (917) + `R/paths.rs`: prototype "reference" workspace storage with `Workspace` owner (`worker.rs` `Owner::Reference`); product SQLite is `Owner::Product`. Feature flags `product-sqlite` / `acceptance` select (`Cargo.toml`).

### 3. Rust / Tauri processes and native modules that already exist

- **One Tauri process, one WebView window (`main`)**. No second window, no Tauri sidecar/`externalBin`, no `tauri-plugin-shell`, no embedded JS engine (`rg` of `Cargo.lock` finds only `wry`, no `deno_core`/`boa`/`rquickjs`/`v8`). `bundle.targets: ["app"]` (macOS bundle only in config; Windows NSIS settings also present). Rust toolchain 1.99, edition 2024, tauri `=2.12.2` with `tray-icon`.
- **Threads/tasks**: `StorageWorker` thread (`R/worker.rs:114`), tokio multi-thread runtime for MCP (`R/mcp/*`), `spawn_blocking` for product requests.
- **Child processes spawned from Rust**: (1) MCP stdio servers via `process-wrap` with process group (Unix) / Job Object (Windows) and kill-on-drop (`R/mcp/process.rs`); (2) local media decoder executable (`R/media_decoder.rs` verifying hash from `apps/desktop/media/decoder-lock.json`, spawned by `R/desktop_media_process.rs`); these are the only child processes.
- **Native services (Tauri commands, `R/desktop.rs:2066-2109`)**: `product_lifecycle_request`, `workspace_request/cancel`, `product_store_request`, `mcp_service_request`, `product_binary_request/read/write`, `desktop_media_request`, `skill_import_directory`, `product_media_preview/release`, `authorize_http_origin`, `product_save_*`, `product_print_storyboard`, `product_open_external` (+ `acceptance_request` under feature).
- **MCP native service**: `R/mcp/service.rs` (1,708): rmcp client, streamable HTTP, stdio, OAuth loopback listener (`oauth.rs`), vault; keyed by `Session` (`matches_session`), `lifecycle.admit_effect()` gate for Prepare/Invoke/Connect/OauthBegin (`R/desktop.rs:~188-205`).
- **Lifecycle**: `R/desktop_lifecycle/{mod.rs (state machine), native.rs (tray, hide/show, Quit drain 1 s guard / 5 s drain / 2 s native), singleton.rs (file lock + loopback activation)}`; close -> `prevent_close` + `hide` (`R/desktop.rs:2016-2022`). `RunEvent::ExitRequested` is intercepted and routed to `request_quit` (`:2114-2125`). No handler for WebView process termination found (`rg ProcessFailed|content process` over `R/`: none; consistent with `review-E11.md` P1-1).
- **Evidence from E11**: macOS debug probe 370,429 ms hidden, runs advanced and completed, same session/generation (`archive/.../10-15-agent-background-host/results.md`, Stage 3). Windows/WebView2: no execution evidence. A second probe (`e11-native-background-if5hwj`) exited with code 0 after ~205 s, cause unproven.

### 4. What the Agent runtime needs (current dependencies)

1. **Model/provider network** — `fetch` through `runtimeFetchFor` (Tauri HTTP plugin in native, browser `fetch` on Web); origin authorization via Rust (`authorize_http_origin`, `httpPolicy.ts`). Provider code in `packages/agent-providers` is environment-neutral (accepts a fetch).
2. **ProductStore** — `db.transaction('rw', [...12+ tables])` inside `createStudioRuntimeHost` (`runChat.ts`), plus run/call/message/checkpoint/job/task/generation/memory/skill tables; reads of `connectors`, `projects`, project content, media metadata.
3. **Tool executors that touch ProductStore** — essentially all of `BUILTIN_TOOLS` (`workspace_overview` shown in `tools.ts:43-75` reads projects/characters/scenes/props/styles via `context.store ?? productDb`; `update_run_plan` -> `updateRunPlanAndComplete`); tool files per family: audio (7+4+2+4 tools), music (4), video generation (7), reference (4), business tools (1,077 lines), memory (435), material (541), IP, task, job, skill, desktop media (4).
4. **Browser/UI-bound pieces inside execution paths** (found by `rg` over non-UI feature code):
   - Web Audio: `S/features/audio/engine/engine.ts` (`OfflineAudioContext`, `decodeAudioData`, `AudioContext`), `engine/recorder.ts`; used by `S/features/audio/generation/runtime.ts:31` (`decodeAudioBlob`, `audioBufferMetadata`) and `audio/agent/audioTools.ts:21` (`splitAudioClip`).
   - `createImageBitmap`, `new Worker(docx.worker.ts)` in `S/features/references/documents/import.ts:20,48` (reference import, owned by `chatDraftStore`).
   - `URL.createObjectURL` and `document.createElement("input")` in `S/features/library/services/media.ts:71,168`, `library.ts:19`; `S/features/agent/skills/runtime/browserImport.ts` (browser directory picker).
   - `Blob`/`File`/`TextEncoder`/`AbortController`/Web Locks (`navigator.locks`) used pervasively.
   - Native bridges via `invoke` from `@tauri-apps/api/core`: media (`desktopMedia.ts`), binary (`nativeBinary.ts`), skill import, MCP, save/print/open-external (some require user gesture/native dialog, `R/desktop.rs` `product_save_*`, `product_open_external`, `tauri-plugin-dialog`).
5. **UI-bound interactions** — approval and Stop flow through the service (`submit`, `resolveRunAction`, `requestStop`, snapshot/subscribe); `afterOptimisticPaint` hook (`agentExecutionService.ts:243,250`); view generation for first-send navigation; E03 feedback controller; read-visibility ack (`ui/threadReadVisibility.ts`) stays in UI.
6. **Native lifecycle coupling** — Quit drain protocol (JS `applicationQuit.ts` ack -> `Lifecycle::acknowledge`, validated against product store generation/session `R/desktop.rs:73-110`).

### 5. dsh reference (read-only)

- dsh runs the Agent in a Node **Host process** spawned from Electron (`/Users/xiaomengdao/WebstormProjects/deepseek-harness/apps/desktop/src/host-process.ts`, 322 lines; `apps/desktop-host/src/{index,quit-inspection,update-tasks,cli,...}.ts`). IPC events: `ready`, `fatal`, `platform-session`, `shutdown-complete`, `update-tasks`, `quit-inspection` (with 2 s deadline `QUIT_INSPECTION_DEADLINE_MS`). Storage in dsh is not ProductStore (file/SQLite owned by the Node host), so ownership is natural there; Cuepoint's equivalent store owner is Rust.

### 6. Process-boundary options (descriptive; cost / risk / effect on PRD items)

PRD items referenced (from `.trellis/tasks/10-16-e-series-review-fixes/prd.md`): item 4 (P1 E11 host survive WebView crash; real Quit test); item 14 (P2 E11: Quit never skips draft decision on slow renderer; Quit/close warns when runs active and first hide; session-end/fullscreen; drafts and failed/uncertain attempts persist across reload; per-thread startup reconciliation non-blocking; `claim()` cannot leak a reservation; relaunch during `Closing`); item 2 (E06: `complete_todo`/`list_todos` via grant port; `assertCurrent` in core; E10 MCP binding on E06 registry); item 11 (E07 readback/clear/recovery); item 13 (E10). Items 1, 3 (E08 Windows), 5, 7, 8, 9, 10, 12, 15 are mostly orthogonal to where execution lives.

#### A. In-Rust-process host (Rust owns the Agent loop and tool execution)

- **What it means in this repo**: no JS engine exists in the Rust crate. The loop (`packages/agent-core/src/runtime.ts`), providers, `createStudioRuntimeHost`, ~23.6k lines of `features/agent` plus all tool families (audio/video/library/memory/references; ~60k+ lines of feature code) are TypeScript on the JS ProductStore API; only rows, SQLite, MCP and media are Rust. Real A requires either porting loop + tools + domain commands to Rust (domain logic currently expressed against the JS `ProductStore` transaction API) or embedding a JS runtime (new dependency, not present in `Cargo.lock`).
- **Cost**: highest; port of core loop/providers (~1.8k lines core + providers), Studio host binding, run/call/job/checkpoint commands (`features/agent/commands` 3,448 lines) and every tool family; or embed engine + ports for fetch/Blob/crypto/locks; Web build would keep a separate TS path (duplicate implementation) because browser has no Rust.
- **Risk**: two implementations of the loop (Web TS vs desktop Rust) or an embedded engine without Web Audio/Workers/`createImageBitmap`; tools using Web Audio decode/docx worker (see §4.4) have no Rust counterpart (decoder executable exists only for video media). Highest drift risk against `agent-core` public contract.
- **Effect on items**: item 4 satisfied structurally (no WebView dependency); items 14 (hide/quit warnings, startup reconciliation, `claim` leak, persisted drafts) become Rust-side designs; drafts/attempts could be SQLite-persisted; MCP authority already in Rust (`mcp/service.rs`), so item 13/E10 authority is local; item 2 grant port would need a Rust analogue (current port is TS in `agent-core`). Does not by itself change items 1, 5, 9 (UI/import in WebView).

#### B. Node (or other) sidecar

- **What it means in this repo**: no sidecar mechanism or `externalBin` entry exists; Node is used only for tooling (`tooling/build-agent-packages.mjs`, scripts) and is not bundled; dist `bundle.targets: ["app"]`. `agent-core` and `agent-providers` are plain TS packages (`type: module`, `exports ./dist`) and reusable in Node. Studio's tool binding is not (it imports `platform/product/store` which `invoke`s Tauri, uses Web Locks, Web Audio, Workers).
- **Cost**: new packaged runtime (Node/other binary per OS/arch, signing/notarization, footprint measured only by owner at packaging; E11 design explicitly lists "packaged runtime" as cost, `design.md` "Selected architecture" table), authenticated IPC protocol, a ProductStore transport usable from the sidecar (currently only `main` WebView can call `product_store_request`; `trusted()` requires label `main`; second opener invalidates session), credential/reference/transport/media ports, subscription protocol to UI, Web-compatibility path (browser still runs in-page).
- **Risk**: session model (`Open` invalidates MCP/previews/media; single `generation`); two clients of one store would require Rust to support multi-client sessions or route the WebView through the sidecar. Tool families touching browser APIs (§4.4) would not run in Node as-is. Windows Job Object/kill-on-close and lifecycle orchestration become Rust-side supervisor work (similar to `host-process.ts` + `quit-inspection`).
- **Effect on items**: item 4 solved if sidecar survives WebView termination and Rust restarts/keeps connection; item 14 can mirror dsh behaviors (active-run inspection for Quit warning); persisted drafts/attempts can live with the host/store; item 2 can reuse `agent-core` grant port in Node; item 13 stdio/OAuth authority stays in Rust MCP unless moved. Largest unknown: which tools can run outside the WebView.

#### C. Hidden persistent WebView with crash recovery + persistence

- **What it means in this repo**: today the sole `main` WebView is hidden on close (`R/desktop.rs:2016-2022`) with throttling disabled on macOS, and execution already runs there. Option C keeps TS execution as is and adds: (a) native detection of WebView content-process termination (not present; `rg` over `R/` found none) and restart/reload while hidden with user-visible notice; (b) persistence of drafts and failed/uncertain attempts (today memory-only: `chatDraftStore.ts`, service `attempts`); (c) per-thread startup reconciliation (today `runOwnership.ts:76-97` loops without per-thread try/catch and `agentExecutionService.ts:135-142` memoizes rejection; `bootstrap.tsx:62-66` awaits it); (d) Quit/close notices and Rust-side Quit changes (`native.rs:180-199` 1 s timeout), session-end/fullscreen handling.
- **Variants visible in code**: `trusted()` allows only label `main` (`R/desktop.rs:877`), `capabilities/main.json` windows `["main"]`; a second hidden WebView would need a new label, capability, trust rule, and would collide with the single-session `Open` semantics (a second `Open` calls `lifecycle.detach(); invalidate_mcp` etc.). E11 design chose retaining the one main WebView over a second hidden WebView (`design.md` "no ... second hidden WebView ... planned").
- **Cost**: smallest; mostly TS plus Rust window-event handling and persistence tables (existing `deviceSettings` row pattern from E11 unread publication; "no new table/index/schema version" was E11's rule, `design.md`). Changes localized to `agentExecutionService.ts`, `chatDraftStore.ts`, `runOwnership.ts`, `bootstrap.tsx`, `R/desktop_lifecycle/native.rs`, `R/desktop.rs`.
- **Risk**: execution still depends on the WebView surviving; a crash stops all in-flight work (runs are reconciled to interrupted on restart, no auto-replay, per E11). Recovery restores state, not in-flight execution. Windows/WebView2 hidden behavior unverified. In-flight model/tool effects at crash time have unknown outcome (existing `unknown` semantics in `agentJobs`, tool calls).
- **Effect on items**: item 4: "survive a WebView crash/terminate while hidden" is satisfied only for drafts/attempts/records and honest recovery, not for running execution; item 14 fully addressable (all sub-items are TS/Rust-lifecycle edits); item 2 and 13 unchanged by boundary; item 11 recovery handled in TS.

### 7. Cross-cutting facts that apply to every option

- Web build uses the same TS execution code in a browser document (IndexedDB, in-page MCP client); any desktop-only boundary leaves the Web path on in-page execution.
- Rust-owned pieces already independent of the WebView document lifetime: SQLite file/worker, MCP service (but invalidated on page load Started/store Open, `R/desktop.rs:2037-2054`), keychain vault, media decoder child processes (stopped by `local_media.stop_all()` on page load/Open), single-instance lock, tray, Quit state machine.
- The model HTTP call is made via Tauri HTTP plugin invoked from the WebView; in-flight native fetches are aborted on `pagehide`/`beforeunload` (`runtimeFetch.ts:19-41`), i.e. page reload already cancels them.
- The session (`session`/`workspaceId`/`generation`) is the authority token across store, binary, MCP and lifecycle commands (`R/desktop.rs` `BinaryEnvelope`, `Envelope.session`, `validate_lifecycle_session`).
- E06 `ResourceGrantPort` is TS in `agent-core` (`resourceGrants.ts`); Studio has no grant consumer; MCP authority is validated in both TS (`runRegistry.assertBinding`, `tools.ts`) and Rust (`service.rs`). Which side owns "grants" after a boundary move is not decided in code today.

### Files Found

| File Path | Description |
|---|---|
| `packages/studio/src/features/agent/runtime/agentExecutionService.ts` | per-thread execution owner service (397 lines) |
| `packages/studio/src/features/agent/runtime/agentExecution.ts` | module singleton bound to `db` |
| `packages/studio/src/features/agent/runtime/threadWork.ts` | live per-thread work registry |
| `packages/studio/src/features/agent/runtime/chatDraftStore.ts` | memory-only draft/import store |
| `packages/studio/src/features/agent/runtime/runOwnership.ts` | Web Locks thread ownership, startup recovery |
| `packages/studio/src/features/agent/runtime/runChat.ts` | `createStudioRuntimeHost`, `executeRun` binding |
| `packages/studio/src/features/agent/runtime/tools.ts` | `BUILTIN_TOOLS` assembly |
| `packages/studio/src/features/agent/mcp/runtime/{owner,connections,runRegistry}.ts` | MCP connection owner and run registry |
| `packages/studio/src/features/agent/commands/agentJobs.ts` | E07 job/report store on ProductStore |
| `packages/studio/src/platform/product/store.ts` | store selection, MCP/media/binary service install |
| `packages/studio/src/platform/storage/{native,nativeBridge,protocol,browser,schema.json}` | JS transaction layer over Rust rows; browser IndexedDB variant; shared table registry |
| `packages/studio/src/platform/runtime/runtimeFetch.ts`, `product/httpPolicy.ts` | model network path and origin authorization |
| `packages/agent-core/src/{runtime,tools,capabilityRegistry,resourceGrants}.ts`, `packages/agent-providers/src/*` | neutral loop, registry, providers |
| `apps/desktop/src-tauri/src/desktop.rs` | Tauri commands, window build, close->hide, page-load detach, `trusted()` |
| `apps/desktop/src-tauri/src/desktop_lifecycle/{mod,native,singleton}.rs` | lifecycle state machine, tray, Quit, single-instance |
| `apps/desktop/src-tauri/src/full_product_store/*`, `worker.rs` | SQLite owner and worker thread |
| `apps/desktop/src-tauri/src/mcp/*` | native MCP service, OAuth, vault, stdio process control |
| `apps/desktop/src-tauri/src/{media_decoder,desktop_media_process}.rs`, `apps/desktop/media/decoder-lock.json` | only external child executable besides MCP stdio |
| `apps/desktop/src-tauri/{Cargo.toml,tauri.conf.json,capabilities/main.json}` | dependencies, single `main` window, capability scope |
| `.trellis/tasks/archive/2026-10/10-15-agent-background-host/{design,results}.md` | E11 chosen architecture and native probe evidence |
| `.trellis/tasks/archive/2026-10/10-16-e-series-delivery-review/research/review-{E06,E10,E11}.md` | review findings used here |

### Related Specs

- Spec dirs exist under `.trellis/spec/` (`agent-core`, `agent-providers`, `desktop`, `studio`, `distribution`, `guides`); not read in this pass beyond what the review files cite (`capabilities.md` §3, from `review-E06.md`).

## Caveats / Not Found

- No sidecar, `externalBin`, shell plugin, second window, or embedded JS engine exists anywhere in `apps/desktop/src-tauri`.
- No WebView process-termination handler found in Rust (`ProcessFailed`/content-process search = none); whether Tauri 2.12.2/wry exposes such an event on both platforms was not researched here.
- Size/footprint of a Node sidecar and Windows/WebView2 hidden-window behavior were not measured.
- I did not enumerate every table the runtime transaction scope touches (`runChat.ts` scope list is truncated in my read) nor read every tool family file; the Web-API usage list in §4.4 comes from a keyword search and may omit uses (e.g. `Blob`-only media handling).
- Line counts are non-test `.ts/.tsx` line totals from `rg -c ''`.
- `.trellis/spec/**` files were not read in detail; PRD item numbering follows the task `prd.md` as read.
