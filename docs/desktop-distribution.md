# Desktop distribution

Momoki's desktop application loads the same React interface, business commands
and Agent as the browser. Normal desktop packaging selects `product-sqlite`: all
ProductStore tables live in the application workspace's SQLite database, and
imported media is copied into managed files. The browser keeps a separate
IndexedDB adapter. Desktop and browser profiles do not synchronize automatically.
Released native workspaces retain their data through automatic additive registry
upgrades. Existing table definitions must remain compatible; incompatible changes
require a separately designed data migration. This does not import browser data.

## Initial installer matrix

| Target | Installer | Baseline | Signing |
| --- | --- | --- | --- |
| macOS ARM64 | DMG | macOS 14 or later | Ad-hoc signature; no Apple notarization |
| macOS Intel x64 | DMG | macOS 14 or later | Ad-hoc signature; no Apple notarization |
| Windows x64 | NSIS EXE | Local NTFS application workspace; WebView2 | Unsigned test package |
| Linux x64 | AppImage and DEB | Ubuntu 22.04 build baseline; WebKitGTK/GStreamer | No distribution signing |

This is the first test-package matrix. Windows ARM64, Linux ARM64, a universal
Mac binary, MSI, RPM and mobile packages are outside it. The normal display name
is **Momoki**, the window title is **默默 Momoki**, and the existing dark
application icons are reused. The internal bundle identifier remains
`design.tulai.momoki`; the executable remains `momoki`.
Changing visible branding must not create a new data profile.

The current source version is `0.1.6`. Root package, desktop package, Cargo and
Tauri versions must agree. Distribution tags use `desktop-vMAJOR.MINOR.PATCH`
with that exact source version. The separate container workflow retains its
existing `v*` tags.

## In-app version checks and installer downloads

From source version 0.1.3, Settings contains an About and Updates section with
manual public GitHub release checks, version comparison and installer downloads.
Automatic startup checks are device-local and opt-in, with a 24-hour cooldown
after a successful check; the default is off. Failed checks may retry at a later
startup. Downloads within the 64 MiB limit require exact size and
SHA-256 verification before the existing native Save dialog receives bytes.
Oversized or digest-less installers use an explicit browser download option.
Saving an installer does not install it or restart the product: the owner follows
the [installation guide](desktop-installation.md). No Tauri updater, signing
credentials, new native command or CSP allowance is introduced. Browser and
unit checks do not establish packaged GitHub reachability or system Save behavior.

## Packaging and functional testing

The desktop workflow only compiles and packages the application. It performs no
Vitest, Rust test, lint, type, models-dev or quality suite, and does not launch
the application or run UI, storage or payload smoke tests. The owner performs
functional testing before publication. A successful workflow proves that all
five installer files were produced and their source and file hashes match; it
does not establish installation, startup, SQLite recovery, media, microphone,
printing or provider behavior on a user's device.

Each successful target receipt is marked `state: packaged` with empty test
checks and evidence. The receipt records the native build host, declared target,
normal SQLite product, tools, unchanged source hashes, built executable/frontend
hashes and installer sizes/hashes. Collection checks these records and the exact
installer set. Installed or extracted payload architecture and runtime behavior
are not exercised by this workflow.

Existing local tests and standalone installer smoke tools remain available for
explicit developer use. The separate GHCR workflow retains its existing quality
and test jobs. Historical test results stay distinct from current packaging
results. The known 64-turn Agent continuation test can still exceed its
20-second native CI limit; removing tests from delivery does not fix that
performance issue.

## Build and release ownership

The dedicated workflow is `.github/workflows/desktop-release.yml`. Its activation
modes are intentionally distinct:

1. Pushing the exact `codex/desktop-release-pipeline` branch bootstraps the new
   workflow with packaging only. This allows building before it exists
   on the repository's default branch.
2. Manual **Run workflow** is build-only. GitHub requires the workflow to exist
   on the default branch before manual dispatch becomes available.
3. An owner-created `desktop-vMAJOR.MINOR.PATCH` tag requests a draft prerelease.
   Every target build and the complete source/installer collection must succeed.
   Only the final publisher receives release-write permission; collection is read-only.

The desktop flow is prepare → four native package builds → exact collection →
tag-only draft delivery. It keeps frozen JavaScript installs, locked Cargo
dependencies and the required native bundling libraries. External WebDriver and
Xvfb setup are absent. Rustfmt remains installed because the shared tool
resolver requires its executable path; no formatter or Clippy check runs.
The GHCR workflow still prepares its real no-GUI SQLite test probe before the
root suite and retains Node22. Desktop builds use Node24.11.0.

Implementation approval does not authorize a Git push, tag creation, workflow
dispatch or GitHub Release mutation. First review the concrete local work-commit
plan; then the repository owner pushes the bootstrap branch, or pushes the
reviewed main and manually runs this workflow on main. Resolve actual
build failures before creating a version tag. Source fixes require new reviewed
source and, after a tagged attempt, a new version/tag; do not move tags to replace
failed payloads.

The final draft has exactly four target receipts and five installer files, plus
canonical `SHA256SUMS` and `release-manifest.json`. Collection verifies source
commit, source tree stability, version, normal SQLite owner, target/architecture,
package-only receipt state, run/attempt identity, file names, lengths and hashes.
Missing, stale, ambiguous or unexpected payloads prevent completion.

The publisher creates or resumes only its own draft prerelease, using a closed
ownership marker. It never publishes automatically or overwrites a published,
immutable or unrelated release. Uploading assets is not atomic: an interrupted
upload leaves an incomplete draft. A retry can reuse the identical original
payload; different bytes or unknown remote assets stop the retry. Completion is
recorded only after the full remote asset set is verified. Retain the original
workflow artifacts for retries before their configured retention expires.

Target and combined installer artifacts are retained for 30 days; separate
failure diagnostics are retained for 14 days. A retry after the original
packaged payload expires requires explicit recovery rather than a rebuild that
pretends to have identical installer bytes.

The owner tests the installers and reviews the completed draft and checksums before
making it public. Repository workflow permission for the normal `GITHUB_TOKEN`
is sufficient for draft delivery; no signing certificates or personal access
token are part of this first package flow.

## Refresh the model catalog baseline before each release

The bundled Models.dev baseline (`packages/studio/src/lib/ai/modelCatalog/baseline.generated.json`)
is a projection of the pinned `@opencode-ai/models` package. Before every release:

1. `pnpm add -D -E @opencode-ai/models@latest` (exact version, no range).
2. `pnpm models-dev:baseline` to regenerate the projection.
3. `pnpm models-dev:verify` to confirm the committed file matches.
4. Commit `package.json`, the lockfile and the baseline together; record the
   package version in the commit message.

The package is never upgraded automatically between releases. The baseline is
currently about 10 KB gzipped; if it grows past a few tens of KB, review the
projection scope before committing.

## Local development and data isolation

On the project owner's Mac, use the approved local pnpm explicitly:

```sh
/Users/xiaomengdao/.nvm/versions/node/v24.11.0/bin/pnpm --dir apps/desktop build:app
```

The dedicated release helpers have closed named arguments:

```text
build:release --target TARGET_ID --output ABSOLUTE_FRESH_DIRECTORY
node apps/desktop/scripts/collect-release.mjs --input DOWNLOAD_DIRECTORY --selection SELECTION_PATH --output ABSOLUTE_FRESH_DIRECTORY
node apps/desktop/scripts/publish-draft.mjs --directory COLLECTED_RELEASE_DIRECTORY
```

`TARGET_ID` is `macos-arm64`, `macos-x64`, `windows-x64` or `linux-x64`.
The build helper emits a `packaged` receipt directly. Collection uses an
explicit artifact selection; it does not infer a target from loose installer
files. Publishing is tag-only
and needs the reviewed workflow context/token; it is not a local build action.
The workflow supplies exact source, run and attempt identity. Target artifact
names are `desktop-<target>-<runId>-<attempt>`; the combined artifact is
`desktop-set-<runId>-<attempt>`. Diagnostic artifacts remain separate.

The existing `finalize-release.mjs --receipt RECEIPT_PATH --checks CHECK_REPORT_PATH`
and external smoke tools are standalone test utilities. They accept actual
check reports when invoked explicitly and are not part of packaging or draft
delivery. Developer quality and test commands are documented in the
[desktop README](../apps/desktop/README.md).

The release helper disables Tauri's bundle-type binary patching to prevent
bundle-type mutations and records the built executable's hash. Packaging does
not extract or install the packages to reverify their executable contents.
Automatic updating is outside this package flow. On macOS it requests both the
app and DMG internally to retain the signed app for hashing; the DMG is the only
downloadable installer. These choices follow the behavior of the
[pinned Tauri bundler](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.1/crates/tauri-bundler/src/bundle.rs).

Local tool homes remain under `apps/desktop/.tools`; no shell profile or global
Cargo/Rust home is changed. Hosted tool resolution is an explicit CI mode with
pinned versions. Test hooks, storage probes, fixture acceptance assets and
runner evidence do not belong in normal installer payloads.

The normal product, isolated SQLite review and IndexedDB reference lanes have
separate fixed identities. An isolated IndexedDB build is an intentional test
reference, not a fallback for normal SQLite startup. A storage initialization
failure remains visible and cannot silently change the data owner.

For project backups, use the existing ZIP export/import UI. Server containers
and browser storage do not back up desktop profiles. Never replace the live
SQLite file with a cloud-drive copy while the application is running; live
cross-device synchronization is separate future work.

## Installing test packages

The user-facing [illustrated installation guide](desktop-installation.md) explains
installer selection and the first-launch prompts. Maintainers can fill in the
[Release body template](desktop-release-template.md) before publication. This is
a manual document template; the current publisher does not load it. It changes
neither the signing policy nor the draft/ownership/upload gates.

Use the template only after uploads complete and the owner performs functional
testing. Do not edit notes during a running workflow or retry: the publisher's
completion step can rewrite the draft body. Preserve the existing upload-status
notice and ownership marker when
editing an owned draft, retain every release-specific manifest limitation, and
replace the version/tag/source/change placeholders. The linked PNG illustrations
and guide must exist at the release tag before their URLs are used. A tag created
before these files were added cannot serve those links; for that older release,
use a verified documentation commit URL and keep the installer/source links tied
to the actual release. Recheck the concrete links before making the draft public.

Download the installer for the device's architecture from a completed Release
and compare its SHA-256 with `SHA256SUMS`. These initial packages do not have
formal developer certificates. macOS and Windows may therefore show security
prompts; review the release provenance and the operating system's own options
before opening them. Formal signing/notarization can be added in a later task.

Windows needs WebView2. The NSIS installer downloads its bootstrapper when the
runtime is absent, so that first installation requires an internet connection;
packaging does not test WebView2 installation or a clean offline install.
Linux needs the declared WebKitGTK/GStreamer runtime libraries. The AppImage
bundles its configured media framework; packaging success does not test FUSE,
desktop integration, available codecs or the device's audio system. Test these
behaviors on the intended device before publication.

Filesystem identity, link and reparse-point validation apply to managed files.
Windows requires local NTFS and rejects unsupported filesystem or reparse
outcomes. Its first test-package contract flushes written ordinary-file bytes
and metadata, publishes without overwriting existing files, and defines
intent/SQLite recovery after process termination. That recovery remains a
functional test responsibility. It does not promise that new
directory or file names, stage unlink operations or completion-marker names
survive sudden OS crash or power loss. macOS/Linux keep the existing directory
fsync policy. Process-recovery tests must never be described as physical
power-loss proof. Packaging success is separate from functional acceptance;
use the owner's test results to assess runtime behavior.
