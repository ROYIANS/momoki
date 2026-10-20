# Complete shared product: native runtime contract

## 1. Scope / Trigger

Read before changing product storage selection, Tauri packaging, default provider
transport, shared exports/external links or Agent execution in a native WebView.
The complete React product, business commands and Agent loop/tools/approvals
remain shared. Current persistence uses the all-table ProductStore interface;
browser IndexedDB and full native SQLite/files implement the same commands.
Normal packaged SQLite activation requires actual isolated full-product
acceptance. Synchronization remains subsequent work. Do not reconstruct
per-domain native pages, commands or an alternate Agent loop.
Fresh development is the default; no old-data migration/backfill/import reader
or compatibility strategy is authorized without an explicit request.

The retained SQLite schema-4/filesystem adapter is an explicit reference/test
lane governed by native-workspace.md/video-workspace.md. It is not the full
SQLite product, a fallback, or a mirror. Browser behavior/namespace remain
shared source code with a separate data identity. Read
[Shared Product Storage](./shared-product-storage.md) before adapting commands,
explicit transaction contexts, reactive queries or managed binary consumers.

This document records executable source contracts, not acceptance status. Unit
or fixture proof alone never establishes actual packaged/provider/system-dialog
success. Record pending, failed, skipped and actual outcomes separately.
Shared native numeric controls must accept legal stored precision; see
[exact clip editing](./audio-music.md#exact-numeric-clip-editing-2026-10-11).

## 2. Signatures

Owners: `runtimeIdentity.ts`, `productStorage.ts`, `database.ts`,
`videoWorkspaceRepository.tsx`, `runtimeFetch.ts`, `runtimeHttpPolicy.ts`,
`runtimeSave.ts`, `nativeSystemServices.ts`, `runtimeExternalLinks.ts` and native
`runtime_services.rs` / `file_transfer.rs`.

```ts
isTauriRuntime(): boolean
resolveProductStorage(native: boolean, profile: unknown): Readonly<{
  runtime: "browser" | "tauri"; storage: "indexeddb" | "sqlite";
  profileId: string | null; databaseName: string;
}>
getProductStorage(): ReturnType<typeof resolveProductStorage>
usesSqliteProductStorage(): boolean

runtimeFetchFor(purpose?: "configured" | "result-download" | "search-probe" | "model-catalog" | "release-check" | "release-asset"): typeof fetch
type RuntimeHttpScope = {purpose: RuntimeHttpPurpose; probeOrigin?: string; redirected?: boolean}
connectorProbeFetch(baseUrl: string, fetchImpl?: typeof fetch): typeof fetch
authorizeRuntimeHttp(
  url: URL, method: string, headers: Headers,
  body: BodyInit | null | undefined, scope: RuntimeHttpScope,
): Promise<{origin: string; allowHttp: boolean}>

downloadBlob(blob: Blob, filename: string, signal?: AbortSignal): Promise<"saved" | "canceled">
nativeSaveFilename(filename: string): string
isPublishedSaveError(error: unknown): error is Error & {published: true}
saveNativeBlob(blob: Blob, filename: string, signal?: AbortSignal): Promise<"saved" | "canceled">
printStoryboard(): Promise<void>
nativeOpenExternalUrl(url: string): Promise<void>
installNativeExternalLinks(): void
```

`createRuntimeFetch(services, scope?)` retains an explicit injectable service
boundary for meaningful tests. Normal providers keep their existing protocols,
`requestOnce`, bounded parsers/SSE/readers, and explicit `fetchImpl` precedence.
The runtime wrapper chooses transport; it does not globally replace fetch.

## 3. Contracts: request / response / environment

### Fixed startup identity and one data owner

Rust installs a nonwritable/nonconfigurable frozen
`window.__MOMOKI_PRODUCT_PROFILE__ = {version:1,id,storage}` before frontend
module/database construction. Keys are closed. ID matches
`[A-Za-z0-9][A-Za-z0-9._-]{0,159}`; storage is indexeddb or sqlite. Genuine Tauri
with missing/invalid profile fails explicitly. Browser ignores any incidental
profile and keeps `aifenjing`. Normal desktop uses
`momoki-desktop:<profileId>:v1`, snapshots its owner once, and cannot change
owner through later preferences, globals, URLs or failed writes.

On macOS, WKWebView's stable, nonprivate data-store ID is the first 16 SHA-256 bytes of
`momoki-product-profile-v1:<bundle identifier>:<storage>`. Normal and isolated
products require distinct bundle/profile IDs **and** distinct WK store IDs/DB
namespaces. `build-app.mjs --isolated-product` requires
`MOMOKI_PRODUCT_IDENTIFIER=dev.momoki.review.<validated-suffix>` and uses the
same normal root frontend, desktop backend/CSP/services. Its archived app receipt
records identifier/storage/store ID. Historical `--acceptance` remains a separate
SQLite/probe frontend and cannot substitute for normal product evidence.

On Windows/Linux, Rust chooses a private ordinary data directory under
`<app_data_dir>/webview-profiles-v1/<32-hex store ID>` using the same fixed
bundle/storage digest. The renderer cannot supply it. Normal, review and
IndexedDB reference identities remain separate. Do not call the macOS-only WK
store API on those systems or enable private/incognito mode.

`bundled_origin::origin/accepts` is the one packaged-entry boundary:
`http://tauri.localhost` on Windows and `tauri://localhost` on macOS/Linux.
Navigation, trusted main-window IPC, microphone permission and media CORS reuse
it. Require the main label, canonical URL with no port/userinfo/query, and entry
path empty, `/` or `/index.html`; hash routes remain allowed. Do not broaden
trusted document paths to repair renderer routing. Corresponding-host startup
and fixed-profile acceptance remain independent from helper unit tests.

The official `pnpm --dir apps/desktop build:app` entry point defaults normal
packaging to `product-sqlite`. `--sqlite-product` is optional for that normal
lane. An explicit `--isolated-product` without it remains the IndexedDB reference;
adding it selects the complete isolated SQLite product. `--acceptance` rejects
either full-product SQLite or isolated-product flags before creating build output.
Keep Cargo default features and explicit `desktop` reference builds separate:
changing every desktop feature build to SQLite would contradict the deliberately
IndexedDB review lane and its receipt.

```js
const productSqlite = process.argv.includes('--sqlite-product') || (!acceptance && !isolated);
if (productSqlite && acceptance) throw new Error('Full-product SQLite and fixture acceptance are separate build lanes');
```

Normal SQLite uses bundle identifier `design.tulai.momoki` and WK
store `ed4550f181f509d050d0643fe7cb7ae0`, with server-owned
`product-workspace-v1/.local/state.sqlite` and internal `assets/`. This new
identity does not read/copy the previous IndexedDB WK store or schema-4 workspace.

The full product exposes the same routes, world/material/media features and
Agent on either adapter; no owner-dependent reduced feature gate belongs in
those pages. Genuine runtime detection remains authoritative for hash history,
trusted IPC and system services. IndexedDB startup never calls the native worker;
full SQLite startup opens its own all-table worker, not schema-4 ensure/state
to fabricate a catalog. Neither owner reads old profiles. Imports keep internal
Blobs or managed files, never external source authority.

One explicit ProductStore transaction commits Agent business writes and original
completed tool result/ledger/receipt atomically. HTTP stays outside that transaction.
Completed tool replay must reuse saved results; reopen never resends paid work.
Lost/malformed native commit acknowledgement requires durable outcome lookup;
an unresolved outcome is not a known rollback and must not authorize replay.
Keep ThreadLockManager/Web Locks and audio/task lock guards. Actual packaged
lock exclusivity/release needs proof; no bypass or unverified native fallback.

### E11: retained single-window application lifetime

The application owns one main WebView and one fixed ProductStore/session. Ordinary window close prevents destruction and hides that same main; Open, platform reopen and repeated launch show, unminimize and focus it. Hiding does not reload the document, reopen storage, repeat startup reconciliation, dispose MCP or dispatch a request. Actual destruction/reload remains an authority-retirement boundary. Browser support lasts for the existing document; explicit application Quit ends the desktop host.

Native singleton admission precedes NSApplication/event-loop construction as well as main-window construction and storage opening. Acquiring the lock only in Tauri setup is too late: an actual losing raw macOS process can stall before setup. Derive the fixed application-data profile from the configured identifier and verify it against Tauri's resolved path during setup. Hold a non-truncating profile-scoped `File::try_lock` descriptor through application cleanup; never unlink/recreate its lock path. Only acquisition permits product startup. A contender has a bounded activation-only path, even when activation fails. Private atomic metadata contains a fresh native nonce and loopback ephemeral port; the closed activation frame is at most 256 bytes, accepts at most eight concurrent readers, uses one-second connect/read deadlines and a three-second total readiness budget. Its only action is Show/Unminimize/Focus of the original main; accepted/closing/not_ready never grants a route, store, tool or execution action. Listener/readers terminate with the original lock owner. Preserve Unix private modes and Windows owner/SYSTEM protected permissions and no-reparse directory identity.

Install native Open/Quit tray/menu entry points before close-to-hide can make the window resident. macOS uses the pinned supported disabled inactive-scheduling policy on the supported 14.0+ baseline; Windows must not explicitly suspend WebView2. No production Chromium flags, second WebView, Node runtime or independent store is added. Process existence, object retention and browser Chromium tests do not establish background execution; the actual available native host must progress across output/checkpoint and a tool/generation boundary while hidden for more than six minutes, including a quiet interval. Both installed-platform acceptances remain separately recorded until performed.

### E11: explicit Quit and renderer/native handoff

`product_lifecycle_request` accepts a closed version-1 request with the actual `NativeSession` and an action: status; guardStatus with the original intent and clear/decision_required; guardDecision with that intent and proceed/cancel; or drained with that intent and drained/interrupted. Only the explicitly compiled native IndexedDB reference lane uses a null session. Full SQLite validates its real current session; saved IDs cannot replace it. The trusted bundled main sender and original quit intent are mandatory. `product-lifecycle` publishes version, intent, phase, actual session and visible/focused truth; `product-window-state` carries version and native visible/focused truth for local reading eligibility.

One native coordinator owns running → checking_drafts → quiescing → exiting. Repeated Quit joins the same intent, original completion and deadline. Before quiescing, aggregate the currently mounted manual dirty/pending/conflict owners, including overlays, and reuse their actual departure protection. A decision-required Quit shows/focuses the sole main. A responsive human cancellation returns to running without stopping work or closing admission. Bound the initial guard-status response to one second; an absent renderer falls back to bounded shutdown without inventing consent or saved-draft evidence.

After guard acceptance, close distinct **new-effect** admission and signal captured original model, task-wrapup, generation and import owners synchronously. Retain their original completion and allow final product checkpoint/result/ledger publication. New-effect admission is not MCP retirement/disposal and is not a blanket ProductStore-write ban: original Stop/status/readback must continue. Dispose shared MCP/resources after those original producers settle, then close storage. Native shutdown has one five-second cooperative budget followed by at most two seconds total forced cleanup, not a fresh timeout per owner. A timeout cannot be reported as drained, confirmed remote cancellation or rollback. Cold startup reconciles unfinished outcomes conservatively without replay.

Close the shared native effect gate synchronously before publishing quiescing. Each actual media/save/skill/MCP reservation rechecks that same gate under its final owner lock; validation before an await cannot admit a fresh effect after Quit. Reserve original MCP task-tracker tokens before releasing the state lock and spawning, so shutdown cannot observe an untracked dispatch gap. Keep original picker/process/write completion distinct from a stop flag. Move blocking fences, mutex cleanup and worker close off the async deadline coordinator; joining retained cleanup tasks still shares the one global forced-cleanup deadline.

### Official HTTP service and exact scope

Pin JS HTTP 2.8.2/API 2.12.2 and Rust HTTP `=2.8.2`, default-features false,
rustls-tls/http2/charset/system-proxy only. No cookie jar, tracing, unsafe-headers
or dangerous-settings. Config sets scopeRedirects true; main navigation/CSP stay
restricted. Official requests bypass WebView CORS, not the application policy.

Trusted IPC is `authorize_http_origin({origin,allowHttp}) -> {origin}`. Canonical
exact HTTP(S) origins only: no userinfo/path/query/fragment/glob input; HTTP needs
explicit current configuration/probe intent. Escaped URLPattern host components
preserve IPv6/ports; local-only main-window grants deduplicate and cap at 128.
Dynamic native ACL grants are additive until restart. The shared policy rechecks
current connection/search settings on **every** request; deletion blocks normal
product calls immediately but is not hard native ACL revocation.

Configured traffic uses current connector/search origins. Draft connector probes
are scoped to that operation; redirect destinations require existing config or
the same probe origin. Result downloads use no-auth GET with no body/credential
headers; HTTP result origins must be explicitly configured, while validated
HTTPS supplier/CDN origins can be independently granted. Never forward provider
auth or signed URL contents into logs. Relative/bundled PDF/font/worker resources
stay WebView fetch; no native-error fallback request occurs.

Supply fresh init/Headers because the official JS plugin mutates init and
buffers uploads. At most two body-bearing native calls buffer concurrently,
shared across configured/probe wrappers; queued cancellation removes waiters.
Blob/byte/FormData payload content is limited to 20 MiB; FormData counts fields
and Blob bytes, not MIME framing overhead. Direct string/URLSearchParams bodies
retain existing domain/vision JSON budgets instead of a new blanket 20 MiB text
cap. Request-object body extraction remains bounded; streaming upload bodies
reject rather than silently losing data. The official plugin is not a chunked
upload engine. Response limits remain shared per-domain reader contracts.

Native connectTimeout is 30000 ms. Existing caller total/idle/Stop signals remain
authoritative; do not introduce a shorter generic generation deadline. Automatic
native redirects are disabled (`maxRedirections:0`). Follow manually for at most
five hops, reauthorize each destination, apply 301/302 POST and 303 method/body
rules, strip sensitive headers cross-origin and cancel discarded bodies.
`redirect:error` rejects supported redirect statuses 301/302/303/307/308;
manual preserves the response. No automatic retry.

Caller abort reason identity survives headers/body. Track controllers through
EOF/error/cancel/header failure, abort pending work on pagehide/beforeunload and
prevent requests after pagehide; canceled beforeunload must not permanently
disable a surviving page. A later pageshow restores eligibility. Suppress late
chunks. Tauri ResourceTable clear alone
does **not** call Resource.close. The official dependency is patched narrowly:
response mutex/atomic/Notify interrupts pending reads and drops the response;
register_response closes resources immediately for JS null-body statuses
101/103/204/205/304 while preserving numeric rid. All other protocol APIs remain
official. Keep vendor licenses, exact patch, crate checksum/source hashes and
regressions; a JS rejected read alone is insufficient disconnect proof.
Provenance is recorded in
`apps/desktop/src-tauri/vendor/tauri-plugin-http/MOMOKI-PATCH.md`; task evidence
retains `http-cancellation.patch` and `http-upstream-provenance.json`. Update the
patch and hashes together whenever the vendored source changes.

### Models.dev catalog purpose (`model-catalog`)

`runtimeFetchFor("model-catalog")` allows exactly one request shape: `GET https://models.dev/api.json`, HTTPS, fixed host and path, no query, no `Authorization`/`Cookie`/credential headers and no body. Every redirect hop is reauthorized by the same rule. Its response ceiling (`MODEL_CATALOG_MAX_BYTES`, 8 MiB) and its 60 s total deadline are independent constants, not the 4 MiB ordinary-JSON limit. It needs no connector. Only user actions use it: `syncModelCatalog` (persists the chosen subset) and `fetchCatalogIndex` (selection dialog, persists nothing). Rust is unchanged: `https://models.dev` passes `validated_origin`; path and purpose limits live in JS. Packaged-window reachability and CSP for this origin have NOT been verified in a real Tauri window.

Official IPC rejection can be a string; sanitize it to an ordinary Error, without
inventing TypeError. Preserve genuine TypeError classification. The existing
connection test permits one chat probe only after unavailable /models 404/405 or
a GET-fetch TypeError. Native string/Error failure remains conservative and does
not trigger that paid probe; abort/body-decode failure also cannot trigger it.

### Native Save and external links

Desktop settings uses the `release-check` and `release-asset` purposes without expanding CSP or adding native commands. The former accepts only the fixed anonymous GitHub release-list GET; the latter accepts this repository's download prefix and, only on transport-followed redirects, the two exact GitHub asset CDN origins. `redirected` is transport-owned hop provenance (`hop > 0`), never inferred from an authored CDN URL. See [Settings and desktop updates](./settings-update.md) for limits, digest validation, cancellation and browser fallback.

Every command uses the trusted packaged main window. Save commands take a
closed `request` DTO; the external command takes a separately validated `url`:

| Command | Request | Result |
| --- | --- | --- |
| product_save_begin | `{version:1,operationId:UUID,fileName,mimeType,byteLength,contentHash?}` | canceled or ready with UUID session and chunkBytes 262144 |
| product_save_chunk | `{version:1,session:UUID,offset,bytes:number[]}` | verified next byte offset |
| product_save_finish | `{version:1,session:UUID,contentHash:lowercaseSHA256}` | canceled, saved or publishedWithError |
| product_save_cancel | `{version:1,session:UUID}` | boolean indicating a known transfer was found |
| product_open_external | `{url}` | unit success or safe error |

Begin's byteLength is a nonnegative JS safe integer. Suggested filename is
nonempty, at most 240 UTF-8 bytes, without path separators/control characters;
MIME is display metadata limited to 256 UTF-8 bytes without control characters.
Destination comes only from the OS Save panel.
No SQLite worker/project/generation is required. At most two transfers exist;
chunks are ordered, nonempty and at most 262144 bytes. Incremental SHA-256 and
observed/declared length must match. Zero-length files are valid, with no chunks;
there is no new 32 MiB/whole-ZIP cap. Staged transfers expire after two minutes
without progress, checked every two seconds; an open dialog does not idle-expire.
Cancel, window destruction and new page-load start release temporary state.

Stage in the selected canonical directory, flush ordinary-file bytes, publish by
no-overwrite hard link, verify and flush the final same-identity writable file,
perform the explicit platform namespace checkpoint and clean the stage. Unix
returns DirectorySynced; the owner-reviewed Windows test contract returns
ProcessRecoveryOnly after local-NTFS directory authority validation. Windows
does not promise new namespace persistence after sudden OS crash/power loss. Existing empty/nonempty files,
symlinks and a destination created during transfer remain untouched. `saved`
includes byteLength/contentHash. `publishedWithError` includes those fields and
code fileSync/directorySync/stageCleanup: publication already occurred, so UI must show a
saved-file warning. `isPublishedSaveError` guards Error plus published:true;
never use an ordinary failure toast or auto-retry that outcome. A late abort
cannot turn a published file into canceled. Unknown finish failure remains an
error/uncertain outcome; only prepublication interruption normalizes to canceled.

Every UI call site must classify this error **before** its generic failure handler,
including nested download callbacks inside a shared action wrapper. Catch locally
around `downloadBlob`, show `error.message` as a warning/status, and retain ordinary
error handling for all other errors. Actual examples are AboutPage, MaterialPreview,
AudioTimeline exportMix, AudioExports, shared AudioPlayer and MusicDetails in
MusicWorkspacePage. A completed internal mix remains available when external Save
is canceled or warns; never delete its owned media or repeat rendering/transfer to
repair a post-publication warning.

`downloadBlob` awaits native completion and translates only native suggestions
through `nativeSaveFilename`: well-formed/NFC text, forbidden-character cleanup,
UTF-8-safe 240-byte cap and extension preservation (including tar.gz family).
Browser anchor download receives the original filename unchanged. `saved`
feedback follows confirmed publication; canceled export has no success toast.
Native external HTTP(S) links open in the OS browser through the validated
official opener command; raw file/custom-scheme opening and broader main-window
navigation are not enabled. Reject credentials, control characters, missing host
and URL strings longer than 8192 bytes. Existing keyboard/link semantics remain
shared.

### Native storyboard print

`runtimePrint.ts` retains browser `window.print()`. Tauri uses the fixed
`product_print_storyboard()` command; no renderer paper/path/HTML or silent-print
options are consumed. `runtime_services.rs` checks the trusted packaged main
window. `native_print.rs` dispatches through `with_webview`, rechecks caller/main
thread, and borrows typed WKWebView/NSWindow handles only inside that callback.
The main capability and both normal/acceptance handler/build ACL lists register
the command. An already attached system sheet rejects another print dialog.

On macOS copy `NSPrintInfo::sharedPrintInfo()` rather than mutating app defaults.
Set A4 portrait base size `210*72/25.4` by `297*72/25.4` points, then Landscape,
with all four margins `10*72/25.4` points. Use the documented WKWebView print
operation and modal sheet API with no delegate/context pointer. Await the actual
main-thread callback Result; dispatch failure is not a successful queued command.
`void` success only means dialog initiation, never printed or saved PDF bytes.
User cancellation/no printer causes no printed-success feedback. Other desktop
systems retain their existing print delegate; their A4 behavior needs actual
platform acceptance. Do not fall back to default native print after failure.

Keep shared `ui/theme.css` A4-landscape/10mm, white content, released print overflow
and hidden chrome. The default Tauri/Wry macOS print path does not set native
paper/orientation; CSS presence alone cannot prove the system preview's geometry.

## 4. Validation & Error Matrix

| Trigger | Required result |
| --- | --- |
| Tauri missing/malformed/extra-field profile | Startup error; no browser/SQLite fallback |
| Normal official build / explicit normal SQLite flag | Compile product-sqlite; receipt and injected profile declare SQLite |
| Isolated build without / with SQLite flag | Distinct review identity; IndexedDB reference / complete SQLite respectively |
| Fixture acceptance combined with full-product SQLite or isolated flag | Reject before output-directory creation or build execution |
| Profile mutates after module construction | Existing fixed owner/namespace remain |
| Complete product query/write on either adapter | Existing shared command with explicit StoreTx; no schema-4 fallback |
| Removed connector / exhausted origin grants | Reject before native request; no fallback/retry |
| Result request carries auth/body or unconfigured HTTP | Reject; no credential forwarding |
| Redirect to unconfigured origin / more than five hops | Cancel discarded body and reject before next send |
| Unsupported/oversized binary upload | Reject; preserve existing JSON-domain budgets |
| Native IPC rejects with string / real TypeError | Sanitized Error / TypeError respectively; preserve conservative probe gate |
| Stop while headers/read stalled / page closes | Abort, release body/connection, suppress late chunks |
| 204/205/304 response | JS body null and native response resource already closed |
| Save canceled or checksum/order invalid | No claimed success/publication; release stage |
| Existing/raced target | Reject without modifying bytes |
| Publication succeeds then final-file flush, namespace checkpoint or stage cleanup fails | Every caller shows saved-file warning/status; no generic failure, cancel, rollback or automatic retry |
| Long native filename / browser download | Safe 240-byte suggestion / original browser name |
| Print dispatch/unsupported/missing native handle or open sheet | Safe UI error; no default-print fallback or printed-success claim |
| Print dialog initiated / canceled / no printer | No claim of printed or saved PDF bytes |
| Actual device/system/provider check unavailable | Record pending/skip/failure; no fabricated acceptance |

## 5. Good / Base / Bad Cases

Good: Tauri Agent writes a project through the existing shared tool transaction,
retains original history in the same fixed owner, streams using native transport,
and exports verified internal bytes through independent native Save. Browser
uses the same page/command code in its original namespace.

Base: an isolated full SQLite product uses all shared features with distinct
profile/store identity and the same compiled services. Schema-4 prototype
capability tests remain separate from full-product evidence.

Good: a standard normal build selects SQLite explicitly through build policy,
then opens its fresh full-product root. Base: a deliberately isolated IndexedDB
build stays a named reference. Bad: silently infer a new owner from the presence
of Tauri or open old profile data to populate an empty normal workspace.

Bad: infer SQLite from Tauri, hide full Agent routes, mirror projects for exports,
copy old keys/data, globally widen fetch/CSP, retry native failures through WebView,
call a rejected JS promise actual disconnect proof, or display success before
native publication. A file already published with a warning is never “canceled”.

Good: a MusicDetails download warns after confirmed publication and retains its
work/media. Base: canceled Save shows no success or failure, and an unpublished
write failure retains the ordinary error. Bad: a nested action catches every error
as “export failed” and encourages saving already-published bytes again.

## 6. Tests Required: assertion points

- productStorage/productStorageQueries: owner fixed before construction, fresh
  profile isolation, full media queries, browser sentinel unread, visible native
  open failure without fallback and no eager IndexedDB construction for SQLite.
- Packaging policy: verify normal no-flags/explicit SQLite, isolated
  IndexedDB/SQLite and both incompatible acceptance combinations. Do not import
  the executable build script merely to inspect flags: import would start builds.
  Build the official normal entry point and independently compare receipt,
  merged plist, executable and derived WK ID. Actual fresh SQLite writes,
  managed preview/Save and original Agent histories must survive a clean reopen
  without a chat/generation POST; model-catalog GET alone is not paid replay.
- videoWorkspaceRepository/shared page tests: both full adapters use existing
  commands/capabilities; explicit prototype retains separate generation/CAS
  reference tests. Sync remains unavailable until implemented.
- sharedStorageContract/sharedNativeStorageContract plus actual native business,
  binary and acknowledgement regressions in the shared storage contract.
- runtimeFetch/runtimeFetchIntegration/runtimeFetchLifecycle: native/default and
  injected fetch selection, FormData bytes/two-slot shared queue/20 MiB file,
  larger domain-authorized JSON, redirect rules/credential stripping/scopes,
  abort identity/late chunks/cleanup and no retry on string/Error/TypeError.
- Existing model-probe tests retain unavailable GET/TypeError fallback and
  prohibit POST on abort/body error/native string rejection. Agent transaction,
  execution/history/permission/replay and Web Locks regressions remain mandatory.
- Native vendor regression uses actual TCP/reqwest/Tauri ResourceTable for a
  pending read disconnect and repeated 204/205/304 resource absence while an
  unrelated 200 remains readable. 101/103 predicate checks are not live-network
  evidence. Exact URLPattern tests cover IPv6/ports/foreign host boundaries.
- runtimeSave/nativeSystemServices/runtimeExternalLinks: zero and ordered chunks,
  checksum mismatch, prepublication cancellation, late abort/publication winner,
  published warning, unknown finish errors, long Unicode/compound filenames,
  original browser names and OS-link interception.
- audioMusicSaveFeedback: exercise the actual four audio/music UI callbacks with
  fileSync/directorySync/stageCleanup, unpublished failure and cancel receipts through
  runtimeSave/saveNativeBlob. Require warning/status without generic error, one
  begin/finish without retry/cancel after publication, and unchanged owned records
  and source bytes. About/material UI regressions retain the same classification.
  Mocked final invoke/callback hosts do not prove actual OS dialog/publication.
- runtimePrint: actual shared storyboard callback and host seam retain browser
  print, wait for fixed native dispatch, surface safe failure without fallback,
  and never show printed success. Rust paper-policy tests verify points/A4/10mm
  and usable landscape area; normal and acceptance configurations must compile.
  Separately inspect real white/chrome-free landscape multipage preview and cancel.
  A saved PDF page box near 841.890 by 595.276 points verifies A4 orientation;
  mocks and a portrait/landscape thumbnail alone do not prove paper dimensions.
- Rust file_transfer/runtime_services: actual zero and 33 MiB+ disk bytes/hash,
  chunk/order limits, stage expiry/cancel/dialog capacity, empty/nonempty/raced
  target protection, truthful injected post-publication failure and closed DTOs.
- Actual normal isolated product: profile/WK store/namespace independence and
  reopen of text/managed bytes/original chat/tool history; native no-CORS HTTP/SSE/upload/CDN/Stop
  fixtures; user-configured real suppliers; genuine imports/Save/external browser,
  baseline microphone, media/documents and white A4-landscape print. Record exact
  build/source identities and do not replace actual evidence with the fixture
  WebView, mocks, synthetic Blobs or another platform's result.

Use the explicit approved machine pnpm and fixed Rust toolchain. Preserve raw
logs/source provenance and reviewed warning distinctions; no zero-warning or
all-platform claim follows from a passing unit test.

## 7. Wrong vs Correct

```ts
// Wrong: runtime is treated as a data owner, and export invents a second project.
if (isTauriRuntime()) await nativeWorkspace.ensure();
await nativeWorkspace.createProject(project.name);

// Correct: initialize the fixed shared owner before rendering product routes.
await initializeProductStorage();
// All existing business commands use that ProductStore; Save is independent.
const result = await downloadBlob(generatedBlob, authoredFilename);
if (result === "saved") showSavedFeedback();
// The caller separately handles isPublishedSaveError as a saved-file warning.
```

Wrong: label an official IPC string rejection TypeError so the connection test
attempts a paid fallback POST. Correct: sanitize its ordinary Error and preserve
only genuine TypeError classification; the shared existing probe gate decides.

```ts
// Wrong: all save errors are presented as unpublished failure.
try { await downloadBlob(blob, filename); }
catch (error) { showFailure(error); }

// Correct: keep the catch at the save call; ordinary mutation errors stay errors.
try {
  const result = await downloadBlob(blob, filename);
  if (result === "saved") showSavedFeedback();
} catch (error) {
  if (isPublishedSaveError(error)) showWarning(error.message);
  else throw error; // Existing outer error owner handles unpublished failures.
}
```

## Platform file authority and namespace checkpoints

`paths::NativeStat` reads actual path/opened-file identity rather than deriving
a Windows identity from length or mtime. Unix uses device/inode/link count;
Windows uses stable Win32 no-follow path handles and actual opened handles with
volume/index/link/reparse classification, requiring local fixed NTFS. Reject
reparse points, network volumes and unsupported identity results. Shared database
Boundary, product binary readers/writers/recovery and retained prototype imports
use the same seam. Windows holds ordinary ancestor directory handles without
delete sharing for active boundaries/leases/exports; release them with owner
lifecycle. Unix retains its repeated identity checks. Path-based APIs do not
provide a general hostile-OS-user race defense; retain that finite limit.

`namespace_checkpoint(path) -> Result<NamespaceCheckpoint>` distinguishes Unix
DirectorySynced from Windows ProcessRecoveryOnly. This Windows contract was
explicitly reviewed by the owner for first test packages: ordinary written file
bytes/metadata are flushed, NTFS publication does not overwrite and process-death
intent/SQLite recovery is tested. New directory/file names, unlink operations and
completion-marker names have no sudden OS/power-loss persistence promise. Real
file-flush failures remain errors, never a dummy namespace success.

`flush_published_file(path, identity, byte_length, owned_links)` verifies named
and actual handle identity, size and link count before/after the supported file
flush. Windows needs writable no-follow handles; a read-only File::open handle
cannot fulfill FlushFileBuffers. Preserve intents and ambiguous bytes if flush
fails after link creation. Normal Save returns publishedWithError/fileSync,
which every existing caller shows as a saved-file warning without retry. The
retained schema-4 export transports a typed published error with the same truth,
not a generic retry invitation; it is not a normal-product DTO redesign.

Required regressions: distinct files with equal size/mtime, root/database/writer
replacement, sidecar aliases, junction and ancestor replacement, stage alias or
replacement cleanup refusal, reachable final-file-flush failure, saved warnings
without replay, deterministic stage replacement at the post-publication namespace
checkpoint, and actual process termination/reopen with exact bytes/rows.

Immediately before successful-path stage unlink, revalidate the stage and final
names against the original open descriptor, expected size and owned link count.
Normal Save preserves a `stageCleanup` published warning on mismatch; binary or
manifest publication keeps its intent and foreign stage bytes rather than
manufacturing a sealed claim. Checking only before publication or in Drop is
insufficient because neither protects the explicit success-path unlink.

Unix helper tests do not execute Windows cfg branches; corresponding-host
results are mandatory for that target. Process tests never prove power-loss
survival. Wrong: manufacture a zero inode, ignore a flush error or erase an
unproven stage during cancel. Correct: retain real identity/provenance, keep
published status truthful and refuse ambiguous recovery.

## Workspace registry identity and released upgrades

`schema.json` (`packages/studio/src/platform/storage/schema.json`) is bundled into
Rust. Its raw-byte SHA-256 is stored in `product_workspace.registry_hash`.
Released native workspaces are persistent user data. The explicit user requirement
of 2026-10-17 is to preserve upgrades from every shipped desktop registry; the
[fresh-development default](../guides/development-change-policy.md) must not be
used to remove this contract or replace its regression tests with rejection tests.

The repeated startup incident on 2026-10-17 was change propagation plus a
compatibility policy/test gap: 0.1.3 repaired 49-to-50, but 0.1.4 added three
registry tables while the recipe still required the old 50-table target hash.
A test explicitly rejected 49-to-53, and updating only the current hash pin
could pass without any upgrade path. Do not restore that rejection expectation;
release compatibility must be exercised against the actual historical sources.

Immutable legacy bootstrap evidence lives in
`apps/desktop/src-tauri/src/full_product_store/registry-history/`:

| Source releases | Tables | Original SHA-256 prefix | Additions to current 53 |
| --- | --- | --- | --- |
| desktop-v0.1.0 / v0.1.1 | 49 | `a3405d19` | deviceSettings, agentJobs, agentJobResultChunks, desktopMediaImports |
| desktop-v0.1.2 / v0.1.3 | 50 | `3c897189` | agentJobs, agentJobResultChunks, desktopMediaImports |
| desktop-v0.1.4 | 53 | `bb3a9483` | none |

The JSON snapshots retain exact release-tag bytes. `catalog.json` records only
files, complete hashes and release identities; it must not contain a current
`target` or per-source `addTables` recipes. The raw current registry determines
the target hash and additions derive from a strict old/new definition comparison.
Native `build.rs` includes the snapshot directory without another manual file list.

Every newly created or upgraded workspace stores its exact raw registry in the
one-row SQL metadata table `product_registry(singleton, schema_json)`, alongside
`product_workspace.registry_hash`. This is storage metadata, not a business table
in `schema.json`. When metadata exists, its exact hash, strict registry shape,
physical SQL definition and singleton row are authoritative. Missing rows,
malformed JSON, duplicate keys, an empty registry or a hash mismatch must reject;
do not fall back to a historical snapshot. Only legacy databases without that SQL
table bootstrap from the immutable snapshots by exact known hash. An unknown
legacy hash still rejects. Once bootstrapped, future and development registries
can upgrade using their own persisted definitions without new catalog entries.

The behavior gap and change boundary are the native workspace opener, registry
parser, source-parameterized integrity validator, migration regressions, immutable
legacy history and release source preflight. Before migration, verify the source
identity/table set, schema/user_version/ready marker and full source integrity,
physical DDL, rows, primary/index projections, changes, receipts and binary
references against that source registry. Every old table must remain present
with exactly the same keyPath, scope and ordered index definitions/unique flags.
Only missing current table names may be added; SQL storage, binary schema, record
codec and query/index encoding stay unchanged.

Use one `BEGIN IMMEDIATE` for source validation, metadata bootstrap/update,
new `product_tables` rows at epoch zero and the new hash. Run the same full
validator against the target registry before COMMIT. Errors and interrupted
transactions roll back metadata, table rows and identity together. Preserve
workspace ID, sequence, old table epochs, record bytes/revisions, projections,
operation receipts and managed assets. Reopen validates without migrating again.
No clearing, reset, export/import replacement, browser migration or downgrade is
authorized. Updating a live database's metadata requires the matching new binary;
an older installed binary does not understand the additional SQL metadata table.

Adding a table still requires synchronized schema JSON/TypeScript, browser fresh
schema/version, lifecycle and transaction scopes. It does not require a migration
hash, target recipe, native count pin or release snapshot for runtime admission.
Formatting-only registry changes also update raw identity automatically. Changed
or removed keys, indexes, unique flags, scopes or tables require a separately
designed data migration; this automatic additive path must reject them.

`tests/storageRegistryHash.test.ts`, native migration regressions and
`scripts/storage-compatibility.test.mjs` check this contract. The shared preflight
runs from `sourceVersion()` before release matrix output or packaging. It blocks
modified legacy snapshots, malformed definitions and incompatibility with the
catalogued sources. It does not cover later released table definitions absent
from that catalog; add their immutable snapshots to extend release-time coverage.
The runtime still validates every workspace's own full source registry.

Acceptance includes 49/50/53 legacy bootstrap, unchanged-catalog successive
53-to-54-to-55 upgrades, records/indexes/receipts in the first future table,
formatting-only identity changes, reopen, failure rollback/retry, corrupt metadata
and bad source rejection. The actual prepare CLI must accept an added table with
an unchanged catalog and refuse incompatible legacy definitions before any matrix
output. A current-hash pin alone does not prove upgrade compatibility. Actual
user-data checks run on a backup/copy before any repair.

Bridge messages retain the native storage error code, for example
`原生存储连接失败（schema）`; do not diagnose this as an operating-system failure
without checking the stored registry identity.
