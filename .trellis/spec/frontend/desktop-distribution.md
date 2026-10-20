# Desktop installer and draft-release contract

## 1. Scope / Trigger

Read before modifying desktop build tools, installer packaging, external product
smoke, artifact receipts or `.github/workflows/desktop-release.yml`. The normal
installer ships the shared React/business/Agent product with `product-sqlite`.
Keep [Native Product Runtime](./native-product-runtime.md),
[Shared Product Storage](./shared-product-storage.md) and filesystem certainty
contracts authoritative. Reference IndexedDB and fixture acceptance are distinct
lanes, never a normal-product fallback. These contracts describe source behavior;
actual corresponding-host acceptance remains separately recorded. The owner
explicitly chose packaging-only delivery on 2026-10-12: this Actions workflow
does not run tests, lint, quality checks or application-launch acceptance. The
owner validates functionality before public release. Do not infer successful
runtime validation from a successful package build.

## 2. Signatures / Owners

E11's application lifetime adds native tray/lifecycle code using the existing Tauri dependency closure, with no new JavaScript runtime binary or single-instance plugin. Its targeted native debug/fixture compile and more-than-six-minute available-host hidden-progress probe are necessary source-stage feasibility evidence. They do not replace the final full build, signed installed macOS/Windows, WebView2/Job Object/firewall or installer-footprint checks. Keep those pending until actually performed; do not run release packaging at each source stage.

Owners are `apps/desktop/scripts/tool-resolver.mjs`, `release-policy.mjs`,
`build-release.mjs`, `release-source-hashes.mjs`, `release-artifacts.mjs`, `finalize-release.mjs`,
`collect-release.mjs`, `publish-draft.mjs`, the dedicated workflow, and the external
`tooling/release-product-smoke.mjs` / `verify-release-smoke-store.py` harness.

```text
build:release --target TARGET --output FRESH_ABSOLUTE_DIRECTORY
finalize-release.mjs --receipt PATH --checks PATH [--checks PATH ...]
collect-release.mjs --input PATH --selection PATH --output FRESH_ABSOLUTE_DIRECTORY
publish-draft.mjs --directory PATH
release-product-smoke.mjs --target TARGET --package PATH --receipt PATH --evidence-dir FRESH_DIRECTORY
```

`TARGET` is closed to `macos-arm64`, `macos-x64`, `windows-x64`, `linux-x64`.
The first two each own one DMG; Windows owns one NSIS EXE; Linux owns one AppImage
and one DEB. The collector requires four targets and five installers.

## 3. Contracts: tools, source, checks and publication

Local Mac mode resolves the user's explicitly approved pnpm path and the
workspace-local Rust homes. Hosted mode is explicit (`MOMOKI_TOOL_MODE=hosted`)
and receives absolute approved `MOMOKI_CARGO_PATH`, `MOMOKI_RUSTC_PATH`,
`MOMOKI_RUSTUP_PATH`, `MOMOKI_RUSTFMT_PATH` and `MOMOKI_PNPM_PATH`.
Pinned versions are Node24.11.0, pnpm10.15.0, Rust1.99.0 and TauriCLI2.12.1.
Reject Codex runtime tool paths. On Windows invoke the pinned pnpm JavaScript
entry through Node, retaining argument boundaries; do not enable a shell or
interpolate paths into command strings. Native probe resolution honors the
explicit target directory/triple and `.exe` suffix.

`build-frontend.mjs` owns the frontend-only Node old-space budget: it spawns the
same Node executable with `--max-old-space-size=4096` and the unchanged Vite
configuration in `build-frontend-worker.mjs`. All package/app/release/native-check
callers enter this launcher. Passing a heap flag only to a parent Node process
does not configure a separately spawned Node child. Preserve argv, cwd,
environment, inherited output and nonzero/signal failure; no shell or global
Vitest/Rust budget. Node24 percentage heap options override a numeric budget, so
a conflicting `NODE_OPTIONS` percentage option fails explicitly. A measured local
build is evidence for its host only; retain peak memory/duration and validate
against corresponding runner resources before claiming hosted success.

The desktop delivery workflow contains only prepare, build, collect and
tag-only draft publication. It has no quality job, native/storage test command,
external driver or payload-smoke step. Build jobs depend on prepare; collection
depends on the four build outcomes. Do not restore automated tests as a delivery
prerequisite without an owner decision. Keep independent daily GHCR quality
unchanged.

Any independent root quality job runs real Rust SQLite bridge tests. Its own job
must install pinned Rust and call the shared
`tooling/prepare-native-test-probe.mjs` with actual Cargo/rustc paths, a fresh
target/evidence directory and `GITHUB_ENV` before the full root suite. The probe
must build locked with no default features/test-hooks, acknowledge ready/close
and exit before its exact path is exported. GHCR's full root suite has the same
prerequisite while retaining Node22. Follow the executable cold-test contract
in [Quality Guidelines](./quality-guidelines.md); downstream native matrix
setup, warm ignored output and skipped native assertions are insufficient.

`sourceVersion()` also executes the released-storage compatibility preflight
(`scripts/storage-compatibility.mjs`) before prepare emits its build matrix or
packaging begins. It validates immutable raw legacy registry snapshots, strict
native JSON definitions and their additive compatibility with the current source.
Pure additions need no registered target, handwritten hash or table recipe.
This is source compatibility validation against the catalogued sources; it does
not prove compatibility against later releases absent from that catalog, run tests
or claim runtime acceptance. Retain immutable release snapshots when extending the
release gate's historical coverage. The native build includes the same directory via
`build.rs`, avoiding a second manually maintained file list or table count.
See [released upgrades](./native-product-runtime.md#workspace-registry-identity-and-released-upgrades).

Normal product identity is Momoki / `design.tulai.momoki` /
`momoki`, profile normal, storage sqlite, features product-sqlite.
Visible branding retains the committed cream-tile PNG/ICO/ICNS assets. Versions in root package,
desktop package, Cargo and Tauri config must match a numeric three-part version;
a tag must be `desktop-v<that version>`. Mac minimum is14, ad-hoc signing and no
notarization; Windows is unsigned; Ubuntu22.04 is the Linux build baseline.
No updater, signing credential or old-data importer belongs in this lane. Windows
uses the explicitly owner-approved regular-file flush / NTFS no-overwrite /
process-recovery contract; new namespace survival after sudden OS crash or power
loss is unpromised. Retain corresponding-host test commands for explicit local
development; their execution is not required by the packaging workflow.

Build-time media downloads use `same-origin` fetch mode only for the exact
`https://code.videolan.org` origin: its pinned dav1d archive rejects Node24's
default `Sec-Fetch-Mode: cors` with HTTP406. Other origins retain the default mode
and cross-origin redirects required by GitHub release assets. Keep the original
archive URLs, byte lengths, hashes and deadlines; report the trusted source URL
and HTTP status on a rejected response and cancel its body. Loopback regressions
exercise actual Node fetch metadata and cross-origin redirect behavior.

The libaom Gitiles archive regenerates per-member timestamps even at a fixed
commit. Its source-lock entry selects the tracked `archiveFile` under
`apps/desktop/media/sources/`, containing the original pinned archive bytes.
Verify that file against the same length/hash before copying it into the source
cache; missing or changed tracked input must fail without a network fallback.
Retain the upstream URL as provenance and the unchanged source archive in each
target's bundled inventory. New downloads cannot be accepted by updating a pin
to each request's newly generated timestamp bytes.

Windows `pin_directory` opens an ordinary local NTFS directory with
`FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES`, read/write sharing and no delete
sharing, retaining no-follow/backup flags and real handle identity checks.
Metadata-only `FILE_READ_ATTRIBUTES` opens do not participate in the required
sharing conflict and therefore cannot enforce a rename/delete guard. Keep
ordinary stat inspection metadata-only with delete sharing. Require real
DELETE-access/rename rejection while pinned and success after release on Windows;
cross-compilation or Unix tests do not prove these Win32 semantics.

Eligible release builds require a clean exact checked source commit, native
host/architecture, verified tool versions, a fresh output and fresh bundle
namespace. Snapshot tracked source hashes before/after packaging. Never seal an
eligible receipt from a dirty candidate build, stale installer or fixture
frontend. Local pre-commit candidate app checks stay separately labeled.

`releaseSourceHashes(root)` owns the exact tracked-source snapshot. Enumerate
through asynchronous Git `ls-files -z` with root-relative exclusions for the
existing `.trellis/`, `.agents/` and `.codex/` descendants before stdout reaches
Node. Task/evidence paths can exceed the synchronous default 1 MiB buffer even
when eligible source paths are small. Retain all other tracked paths, UTF-8/NUL
framing including spaces and embedded newlines, and JavaScript `.sort()` order
before creating the map with the existing file digests. Drain stdout/stderr and
await successful child close; spawn/stream/nonzero/signal or incomplete output
must reject the snapshot rather than accept partial hashes. Do not fix list
growth by enlarging an arbitrary buffer, removing history, excluding additional
source or weakening source-before/source-after comparisons. Small HEAD/status
Git calls remain separate from the streamed path list.

The pinned Tauri CLI patches bundle-type markers into Windows/Linux executables
and restores the unpatched build executable afterward. This release lane passes
`--no-binary-patching`, preventing those bundle-type mutations. Packaging records
the build executable hash; without extraction it does not prove installed
payload parity. The updater is outside this lane. On Mac request
`app,dmg` internally so Tauri retains the signed `.app` for hash verification;
only the DMG is an eligible downloadable asset. Do not add `.app` as a sixth
installer or substitute an unverified post-build executable hash.

Successful packaging writes `state: packaged` with strictly empty `checks` and
`evidenceFiles`. It records policy hash, immutable
repository/workflow/source/run/attempt/version context, target, normal product,
resolved tools/host, matching source hashes, exact executable/frontend identity,
installer length/hash. Collection accepts this truthful package-only outcome;
never synthesize passed test rows or evidence from a successful build. Resolved
host and target metadata do not establish installed/extracted architecture or
runtime behavior. If the retained standalone verification tools are explicitly
run, a fresh packaged receipt can become `verified` only with the exact actual
native/storage/payload checks and hashed closed evidence. These tools are not
invoked by the delivery workflow.

The optional standalone Windows/Linux smoke runs the normal installed/extracted
executable, verifies payload architecture/hash and trusted origin/profile, creates/imports/previews
through existing UI, observes actual process exit, removes only its fixture
source, and reopens. A read-only external SQLite verifier asserts project,
material/version, committed binary reference and exact managed bytes. Each
Linux format has independent fresh state and complete evidence. No SQL seeding,
mock bridge, embedded WebDriver plugin or acceptance IPC is permitted. Mac
package/signature/bounded-launch checks do not claim UI/store persistence.
Hardware, system dialogs, providers, FUSE launch and other distributions remain
explicit residual limits where unexercised.

Standalone native checks and their nested storage runner retain original
per-command logs and forward actual stdout/stderr to the caller. Await child close and writable
log completion before reporting a result; a spawn, signal, stream or log failure
cannot become success. Rust test output is uncaptured so an abnormal executable
exit does not erase earlier panic diagnostics. Upload existing finite build
diagnostics on failure or cancellation, keeping installer upload/collection
success gates unchanged. Cancellation with an absent nested error is an unknown
cause, not proof of a specific storage bug.

`product_records.row_key` is canonical WireText storage text: lowercase four-hex
UTF-16 code units, not a plaintext payload ID. External verifiers must decode
that production format before comparing a row key with `payload.id`, reject
malformed encodings and mismatched IDs, and use production-encoded keys in
synthetic fixtures. A GUI-visible record plus a verifier mismatch requires
inspection of both contracts; never rewrite SQLite rows to satisfy a test.

The bootstrap exact branch push and manual dispatch are build-only. Manual
availability requires the workflow on the default branch. Desktop tag mode can
create/resume only a pipeline-owned draft prerelease after all targets package;
only its final publisher receives `contents: write`. Existing GHCR triggers and
permissions remain separate. Implementation approval does not authorize push,
tag creation, remote dispatch or Release mutation.

Artifact selection is explicit and bound to this run, target and original
attempt. Reject ambiguous candidates and future attempts. Do not flatten loose
globs. Verify regular files, path containment, exact whitelist, sizes/hashes,
source equality and the declared receipt state before producing canonical
SHA256SUMS and release-manifest.json. The manifest and draft notes must say that
automated tests, launch and storage smokes were not performed and owner
functional verification is pending; never claim the owner already tested the
build. Retain original immutable artifacts for draft retries.

Publisher uses authenticated paginated draft discovery and an ownership marker
bound to workflow/repository/tag/source/payload. The tag must already exist and
resolve to the checked source; never create/move it. Reject published, immutable,
duplicate, unowned or changed-payload releases. Uploads are non-atomic: a partial
owned draft remains visibly incomplete. Resume identical original assets only;
unknown extras or changed bytes stop. Reverify the full remote asset set before
marking complete. Owner publication follows completion; REST read-before-write
checks do not prevent concurrent external publication.

The completion `PATCH /repos/{repository}/releases/{id}` must explicitly retain
`tag_name: manifest.context.tag` and
`target_commitish: manifest.context.sourceSha`, alongside the complete body,
`draft: true`, `prerelease: true` and `make_latest: false`. A reached hosted draft
kept its complete assets/body but returned a persisted `untagged-*` tag after
the former completion request omitted tag/source. GitHub documents those fields
as optional; this observation is not a universal omission-reset guarantee.
Keep the strict post-PATCH ownership/mode/tag check. Never accept an unexpected
tag, published state or immutable response merely because assets uploaded.
Recovery of that particular complete draft is an owner-authorized tag association
repair only after verifying its ID, original marker, exact seven asset hashes and
current remote tag. Do not broaden discovery to arbitrary untagged drafts or
delete/reupload existing complete assets.

`githubApi(token, fetchImpl).upload(url, path)` streams raw installer bytes to
the validated GitHub upload URL with `Content-Type: application/octet-stream`
and an explicit decimal `Content-Length`. Open the file once, obtain its size
with that FileHandle's `stat()` and stream that same descriptor; a Node file
stream alone sends chunked transfer encoding without the length GitHub requires.
Retain `duplex: half` and destroy/close the stream and descriptor in `finally`
after success, HTTP rejection or transport rejection. JSON requests and binary
downloads keep their separate behavior. A local HTTP fixture establishes request
framing, not the cause recorded in an unavailable GitHub response body or hosted
upload success.

A publisher-only repair can resume the original sealed set using the corrected
local publisher and original `GITHUB_REPOSITORY`, `GITHUB_SHA`, `GITHUB_REF`,
`GITHUB_EVENT_NAME=push`, `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`. Preserve the
original manifest, receipt bytes, source/tag and payload identity; retain the
usual policy, tag, ownership and remote-asset checks. The package verifier does
not require the publisher's current Git HEAD to equal the package source.
Verify that policy/collection semantics are unchanged before choosing this
recovery. Re-running an old Actions job checks out its original SHA/ref and
does not load a later publisher correction. No tag movement, artifact rewrite
or remote mutation is implied by local implementation approval.

## 4. Validation & Error Matrix

| Trigger | Required result |
| --- | --- |
| Unknown target/format, mismatched version/tag/tools/host | Fail before producing eligible output |
| Dirty source, source changes or existing bundle namespace | Reject receipt; retain finite diagnostics |
| Tracked paths exceed 1 MiB / excluded metadata dominates | Stream the exact eligible scope; no truncated source snapshot |
| Git enumeration fails or leaves incomplete NUL output | Reject source proof before any eligible receipt |
| Acceptance frontend, test hooks or wrong product/profile | Reject normal package proof |
| Packaged receipt with check rows or evidence | Reject; build output cannot claim test success |
| Failed/missing/duplicate/unknown check or absent evidence | Cannot seal verified receipt |
| Wrong executable, architecture or trusted startup profile | Fail actual payload smoke |
| UI import/reopen lacks exact committed row/file bytes | Fail storage smoke; no SQL/mock repair |
| One Linux installer format absent | Required package set remains incomplete |
| Link, path escape, stale/wrong-source/hash or extra file | Collector fails; no complete draft |
| Manual/branch mode | Build-only; no tag/Release mutation |
| Existing published/immutable/unowned/duplicate release | Reject without mutation |
| Upload interrupted / identical original retry | Incomplete owned draft / exact conservative resume |
| File stream without explicit byte length | Invalid upload framing; send the opened file's exact Content-Length |
| Upload HTTP/transport rejection | Propagate failure and close file resources; keep the draft incomplete |
| Completion response loses tag or changes draft mode | Reject; retain assets and diagnose actual fields before owner-authorized recovery |
| Changed payload or unknown remote asset | Stop; owner recovery/new version needed |
| Successful package build | Record packaged-only state; owner runtime validation remains separate |
| Frontend default heap OOM / percentage option conflict | Dedicated bounded child budget / explicit conflict error; no global CI relaxation |
| Windows metadata-only directory guard | Insufficient rename authority; retain actual list-access guard and release checks |
| Nested process failure or cancellation | Keep failure/cancel status, exact logs and useful live diagnostics |

## 5. Good / Base / Bad Cases

Good: owner initiates packaging, four native hosts build, and a later version
tag collects five exact installers into one complete draft whose notes disclose
the absence of automated runtime tests. The owner validates before publishing.
Base: local source and fake-API failure tests pass while actual package/draft
delivery remains pending; task stays active. Bad: describe packaging as runtime
acceptance, drop a failing target, reuse a stale installer, automatically publish the draft
or overwrite an unrelated Release.

## 6. Tests Required

Use actual injected malformed/missing/duplicate/wrong-source/wrong-hash files and
manifests to exercise collector rejection. Controlled fake GitHub API tests must
exercise paginated drafts, published/unowned/duplicate rejection, partial upload,
identical resume and changed/unknown assets. These are protocol tests, not real
GitHub delivery. Verify tool paths, Windows argument handling and exact policy.
Upload-adapter regressions must use actual Node fetch and a loopback HTTP server:
reproduce the former chunked request's HTTP rejection, then assert explicit
length, no chunked framing and full multichunk binary parity. Cover encoded
asset names, zero/missing files, early HTTP rejection, actual socket failure,
closed file resources and unchanged JSON/download behavior. Do not substitute a
high-level fake `upload` method for this wire boundary.
Completion regressions exercise a draft API fixture that resets an omitted
tag_name, then require explicit tag/source, unchanged draft/prerelease mode and
seven exact assets. Even an explicit correct request must reject a wrong-tag,
published, non-prerelease, immutable or ownership-conflicting final response.
An Object.assign-only PATCH fake that retains every omitted field cannot expose
the reached tag-retention defect.
External SQLite verifier regressions must include production-encoded ASCII and
Unicode row keys, malformed encodings, and valid encodings with mismatched IDs.

Source enumeration regressions use actual temporary Git indexes with total and
eligible path output exceeding 1 MiB. Compare the exact sorted set and resulting
hash map with the original three-prefix filter, including Unicode, spaces and
newlines. Hash real files, verify an eligible mutation changes the snapshot and
an excluded file does not, and reject actual Git failures. Keep synthetic index
fixtures temporary; do not commit large lists or rerun unrelated native/Agent
suites for a precompile enumeration correction. A current-repository snapshot
parity check is local proof, not a hosted installer build.

For delivery-tool changes run relevant local desktop types, lint, quality and
protocol regressions, including packaged receipt collection/publication and
negative source/hash/path/state cases. This local development verification is
separate from the packaging-only Actions workflow. Keep product/native suites
and optional smoke tools intact for explicit use; do not weaken their assertions
or deadlines to bypass delivery. Actual four-target package collection and
tag/draft upload evidence close the hosted delivery gates; archive only after
those required criteria have actual outcomes. Automated host-test/smoke gates
from the earlier plan were waived by the owner's packaging-only decision.

Launcher regressions must run the actual launcher with a tiny fixture worker:
argument/environment/cwd identity, explicit heap precedence, output, nonzero,
spawn failure and supported-host signals. Logged-process regressions require
real children producing both streams past a pipe buffer, full EOF/log parity and
nonzero/spawn/signal/log failure behavior. Retain the full unchanged native suite
when modifying those native/launcher contracts; fixtures do not establish
renderer or installer proof.

## 7. Wrong vs Correct

Wrong: ignore a collector hash mismatch because download-artifact only warned,
mark all checks passed from a build exit code, or publish `draft: false` after a
partial upload. Correct: verify the exact file closure, label package-only
outcomes truthfully, require actual hashed outcomes only for an explicit
standalone verified receipt, keep an interrupted draft incomplete, and leave
publication to the owner after remote verification and functional validation.
