# Native Workspace and Packaged Acceptance Contract

## 1. Scope / Trigger

Apply when changing the Tauri 2 shell, retained Rust SQLite workspace bridge, packaged compatibility checks or platform-sensitive browser APIs. The complete current product uses the shared UI/business/Agent and ProductStore boundary described in [Shared Product Storage](./shared-product-storage.md) and [Native Product Runtime](./native-product-runtime.md). The new full-product SQLite owner must pass actual isolated packaged acceptance before normal activation; pending validation keeps the accepted normal owner unchanged. The prototype persistence signatures below belong only to their explicit reference/test lane; navigation, trusted IPC, microphone and truthful evidence rules also govern the full product. Runtime detection chooses native services/hash history, while trusted startup selects one product database. No browser-to-native migration, legacy reader, compatibility alias or dual-owner mirror is implied.

## 2. Signatures

The retained prototype renderer owns the closed `workspace_request` envelope through `apps/desktop/ui/bridge.ts`. Full-product storage uses the separate closed `product_store_request` protocol and the shared adapter; it never routes Agent/business commands through the prototype video API. Independent exports use the system Save service:

```ts
nativeWorkspace.ensure(): Promise<NativeWorkspaceState>
nativeWorkspace.state(): Promise<NativeWorkspaceState>
nativeWorkspace.createProject(title): Promise<NativeProject>
nativeWorkspace.importAsset(projectId, displayName, mimeType): Promise<NativeAsset | null>
nativeWorkspace.availability(): Promise<NativeAvailability[]>
native.request(action: Action): Promise<Result>
native.save(blob, projectId, format, mode?, recordedMime?): Promise<Result>
acceptanceRequest({type: "setup" | "ready" | "report" | "openDeniedProbe", json?})
```

`nativeWorkspace` sends the closed `workspace_request` envelope through the Tauri runtime. It serializes requests, shares first-load initialization, and validates the entire reply with `nativeProductReplySchema` before accepting a monotonic `generation`. Explicit SQLite product-adapter tests and historical acceptance bridges import the same closed DTO schemas from `packages/studio/src/platform/runtime/reference/nativeWorkspaceContract.ts`. Common normal-product export uses the independent `product_save_*` service documented in native-product-runtime.md; it does not invent a SQLite project for `saveGenerated`.

Product video actions include `createVideoProject {project, video}`,
`patchVideoProject {projectId, patch, baseline?}`, `videoState {projectId}`,
`patchEpisode {episodeId, patch, baseline?}`,
`patchBeat {episodeId, beatId, patch, baseline?}`,
`patchShot {shotId, patch, baseline?}`, and atomic
`addShots {projectId, episodeId, count, atOrder?, beatId?}`. Owner-scoped reorder,
delete, duplicate and `videoUndo {receipt}` operations use closed typed actions.
The lower-level bridge additionally supports `create`, `open`, `reopen`, `close`,
`restore`, `backup`, `readStart`, `readChunk`, `readClose` and `saveGenerated`.
Rust dispatches DTOs in `src-tauri/src/desktop.rs`; unrecognized fields, paths and
commands are rejected before filesystem access. No mutation is automatically
reissued after a failure.

The SQLite/prototype generated export accepts `format: "csv" | "zip" | "wav" | "microphone"` and `mode: "retain" | "export"`. `retain` commits a workspace asset; `export` opens a native Save panel and publishes only to a fresh destination. `readChunk` is exactly 262,144 bytes at most.

## 3. Contracts

- Every `workspace_request` carries `version: 1`, a UUID `operationId`, and `expectedGeneration`. Replies carry the current generation and a discriminated result. A stale generation, extra envelope field, extra action field, unknown operation or unauthorized plugin command is an error. Independent `product_save_*` services have their own session envelopes, not workspace generation.
- Retained reference workspace state is SQLite-backed and uses fresh-development `schema: 4`. It includes `workspaceId`, project summaries, managed asset summaries, reference timings and `sqliteVersion`, plus the native video spine (`videoProjects`, `episodes`, `beats`, and `shots`). Imported bytes are copied into the managed workspace; original source paths are not live authorities. A schema change in this reference lane rejects an older reference workspace explicitly; it does not add a migration or legacy reader. Normal full-product desktop data instead follows the [released upgrade contract](./native-product-runtime.md#workspace-registry-identity-and-released-upgrades). Use an isolated application identifier for fresh packaged verification rather than deleting an existing developer workspace implicitly.
- `ensure` opens or creates `<app_data_dir>/workspace` and is idempotent while the current generation owns the worker. A first successful ensure creates the workspace identity and managed directories; a later ensure returns the existing state without changing generation. Product code must never choose an absolute root.
- The normal Tauri frontend is the root React/Vite application. The historical acceptance fixture is built only with `--acceptance`; changing the normal build must not silently replace it with the fixture or make the packaged product depend on a development server.
- `ProjectGalleryPage`, `WorkspaceChrome`, `ProjectHomePage`, `EpisodeListPage`, `StoryPage` and `ShotEditorPage` are the shared video product route tree. `videoWorkspaceRepository` selects Dexie or SQLite through the fixed storage profile; the simplified native gallery/workspace pages were removed. Normal desktop shares the full ProductStore SQLite/files product/media/library/Agent owner. The schema-4 SQLite lane is a retained reference with its own limited capability states; those states never restrict the full product, fall back or mirror into Dexie. See [Shared Video Workspace](./video-workspace.md).
- Tauri packaged entry navigation uses the shared `bundled_origin` boundary: `http://tauri.localhost` on Windows and `tauri://localhost` on macOS/Linux, with no canonical port, credentials or query and an entry path of `""`, `/` or `/index.html`. Hash routes are allowed. The empty path is required because packaged WebKit launches at `tauri://localhost`.
- `createProductRouterHistory()` selects TanStack `createHashHistory()` in the
  native runtime and `createBrowserHistory()` in the browser. Native product
  routes such as `/projects` and `/p/:id/e/:episodeId/shots` live in the fragment,
  keeping the actual document on the trusted packaged entry. Do not widen the
  Rust caller/navigation ACL to repair a renderer history mismatch. Verify
  actual navigation and reload, not merely a mocked repository render.
- The acceptance app uses its own identifier and `data_store_identifier`, but must not enable WebKit private/incognito mode: IndexedDB Blob persistence fails in private mode even when an isolated store is configured.
- Native generated files preserve renderer bytes and SHA-256. CSV is UTF-8 BOM text, ZIP begins with `PK`, and WAV is RIFF/WAVE. Existing destinations are rejected without changing workspace state.
- Native project deletion removes the project's SQLite records, asset records,
  references and video children in one transaction. Previously copied managed
  bytes remain in the workspace as unreferenced files; this command does not
  promise disk reclamation or physical erasure. Shared native confirmation text
  must state that behavior. Never unlink files inside a SQLite transaction and
  then claim rollback restores them; physical cleanup requires its own later
  recoverable file-lifecycle design.
- `MicrophoneRecorder` requests the Web standard baseline `{audio: true}` (or only an exact selected `deviceId`). Optional WebKit processing constraints are forbidden at this boundary because they produce `OverconstrainedError` on otherwise valid devices. The packaged acceptance may record an explicit, user-selected skip when the host has no input device; the final report keeps that item in `pending`.
- The acceptance report is written through `acceptance_request` and may finish only with no failed events, both storyboards inspected, print preview confirmed, and either actual denial evidence or an explicit no-input-device skip. A skipped microphone/denial check is never presented as a pass.

## 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Tauri navigation has a foreign scheme/host/port/query/path | Reject navigation and permission; do not widen to arbitrary local URLs |
| Packaged root path is empty, `/` or `/index.html` | Allow the entry document |
| Request has stale generation, extra field, SQL/path field or unknown action | Return a typed rejection; workspace state and generation remain unchanged |
| Read chunk exceeds 256 KiB or session/generation is invalid | Reject and require the caller to close the read session |
| Native export target already exists | Return `exists`; do not overwrite and do not mutate SQLite state |
| `ensure` has no opened worker | Create/open only under the application data directory, validate the ready marker and return a typed state |
| `ensure` is called with an already opened worker | Return the current state and keep the generation stable |
| Native project or asset owner is absent | Return `ownership`; do not create an orphan row or managed file |
| Product code runs in browser mode | Keep the existing Dexie implementation; do not invoke the native command or import local data |
| Native video row has a missing project, episode or beat owner | Reject the mutation; strict workspace reopen/ready validation rejects the workspace, while an already-open runtime may retain a diagnostic logical row from an external race |
| Native beat range is outside the episode's UTF-16 script length | Reject the mutation and workspace reopen |
| Native shot status or duration is unsupported | Reject the mutation; use the shared `draft/ready/framed/clipped/approved` status contract and a finite non-negative duration |
| Export is canceled | Return `canceled`; do not create an asset or destination |
| Renderer bytes/hash differ from native result | Fail the acceptance event; never report a successful export |
| WebKit rejects optional microphone constraints | Do not retry with more constraints; request baseline audio and surface device/permission failure |
| Host has no audio input and user chooses to continue other checks | Record an explicit skip with `requiresFollowUp: true`; keep microphone work in report `pending` |
| Print preview is not visibly white, A4 landscape, chrome-free and complete for both episodes | Do not mark print confirmation or finish the packaged report |

## 5. Good / Base / Bad Cases

- Good: call `native.save` with a verified Blob, choose a fresh native destination, compare returned byte length and hash, then leave workspace state unchanged.
- Good: in an explicitly selected SQLite reference lane, call `nativeWorkspace.ensure`, create a project, import through the native picker, refresh state, and navigate through the shared supported workspace. Reopening that lane reads SQLite state and reports missing managed bytes without deleting the row. Normal desktop instead uses the full shared ProductStore SQLite/files owner and independent system services.
- Base: use an isolated acceptance identifier and SQLite fixture workspace, project the same fixture into a temporary Dexie database for storyboards, and shut the app down after the persisted report is complete.
- Bad: allow `tauri://localhost/anything`, enable private WebKit mode, accept a client-supplied SQL/path field, overwrite an existing export, mirror native rows into Dexie, add a migration reader for the old IndexedDB schema, or mark a missing microphone as `NotAllowedError` evidence.

## 6. Tests Required

- Rust unit/integration tests cover closed DTO/envelope rejection, generation checks, path containment, chunk limits, SQLite state/reopen, backup/restore, byte hashes, existing-target rejection and cancel behavior.
- Explicit SQLite product tests cover idempotent `ensure`, project/asset round trips, source independence, missing-file reporting, duplicate managed targets and reopen identity. Renderer tests must cover the adapter's closed result handling, declared storage selection and generation regression without requiring a Tauri window. Normal full-product SQLite/files and independent services have the assertions in native-product-runtime.md; explicitly isolated IndexedDB remains a separate reference lane.
- Renderer tests cover `MicrophoneRecorder` lifecycle, final chunk handling, device loss, permission errors and the baseline `getUserMedia` shape.
- Packaged acceptance must run the real `.app` and record automatic bridge/media/document/stream checks, user-gesture playback, native CSV/ZIP/WAV byte equality, cancel and existing-target flows, both storyboard DOM/image/full-text checks, and actual system print previews.
- When no input device is available, the acceptance report must assert the explicit skip path and preserve the missing microphone checks in `pending`; it must not fabricate a Blob or denial result.
- Run the explicit local pnpm path for frontend typecheck/lint/tests and the Tauri Rust format, tests and clippy gates. Preserve `runner-receipt.json`, `report.json`, `server-events.json` and screenshots as evidence.

## 7. Wrong vs Correct

### Wrong

```ts
// Let the product renderer choose a database root or mirror native rows.
await db.projects.bulkPut(await nativeWorkspace.state().then(state => state.projects));
// Import an existing browser database into the first native workspace.
await migrateIndexedDbToSqlite();
```

### Correct

```ts
// Full-product routes use the same ProductStore command/query boundary.
// Trusted startup has already selected native SQLite/files or browser IndexedDB.
// Never route full-product Agent or pages through the schema-4 nativeWorkspace API.
const project = await productStore.transaction('r', ['projects'],
    tx => tx.projects.get(projectId));

await navigator.mediaDevices.getUserMedia({audio: deviceId ? {deviceId: {exact: deviceId}} : true});
// If there is no input device, record an explicit pending skip and preserve
// the requirement for a later real-device acceptance run.
```

## Native bundle icon

Native icon generation is an asset contract, not a change to the shared Web
artwork. The source is the dedicated committed opaque tile
`apps/desktop/assets/app-icon-cream-1024.png`: 1024 pixels, fully opaque,
full-bleed cream `#F4F0E8` with the frog character and no black disc. The Web logo is a
transparent stencil (black ink) and would vanish on a dark tile, so it is not a
native input and is never composited. `apps/desktop/scripts/generate-native-icons.py`
validates the tile, copies its pixels unmodified into the PNG set and ICNS (no
crop, resize, composite or reconstruction), then masks only the Windows ICO.
macOS applies its own squircle, so PNG and ICNS stay square and fully opaque.
Windows does not mask a square ICO, so each ICO frame gets a rounded-rect alpha
mask with radius 0.2237 of that frame's side: the four corners are transparent
and the middle of each straight edge stays `[244,240,232,255]`. The generator
uses the installed pinned Tauri CLI and installs only desktop PNG, ICO and ICNS
resources. The ICNS preserves the repository's eight modern PNG member types
(`ic07`-`ic14`); independently verify macOS decoding rather than accepting one
image library's interpretation.

Run the script with a Python runtime containing Pillow and the explicitly
approved local pnpm path. `--check` is read-only and verifies source equality
with the committed tile, opaque PNG/ICNS alpha and cream corners, transparent ICO
corners with a cream top edge, artwork presence and provenance hashes.
`--check --bundle /absolute/path/Application.app`
resolves `CFBundleIconFile` from the actual built app and requires its icon bytes
to match the tracked ICNS. Web brand hashes recorded during generation are
evidence, not permanent constraints on unrelated future Web artwork edits.

Required assertions: PNG and ICNS pixels have alpha 255 and corners
`[244,240,232,255]`; every ICO frame has transparent corners and a cream top-edge
pixel; dark mark ink is present (a blank tile fails); `source.png` has the
committed tile's pixels; rerunning generation produces identical native bytes;
the packaged ICNS matches. A transparent PNG or ICNS member, or a square ICO, is
a failed gate even if a larger member looks correct. Replacing the Web logo to
fix the native tile is wrong; changing the tile asset deliberately, regenerating
the native resources and checking the actual bundle is correct.
