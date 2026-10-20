# Settings and desktop updates

## 1. Scope / trigger

Read before changing `/settings`, the embedded connections section, `settings.*` device preferences, shared release lookup or installer download/save. Browser and desktop share the page and manual version check; system installation remains a user action. This feature adds no Rust command, dependency, capability or CSP origin. Packaged reachability and system-dialog acceptance remain separate from browser/unit proof.

## 2. Signatures and owners

- `SettingsPage({section?, onSectionChange})`, `SETTINGS_SECTIONS`, `isSettingsSectionId(value)`, `filterSettings(sections, query)` own presentation, recognized section identities and search. Ids are `general | appearance | connections | storage | update`.
- `readSettings(tx)` owns the reactive preference snapshot; `readAutoCheckUpdates()`, `readLastUpdateCheckAt()`, `writeAutoCheckUpdates(enabled)`, `writeLastUpdateCheckAt(at)`, `dueForAutoCheck(lastCheckAt, now)` use `features/settings/commands/deviceSettings.ts`. Keys are `settings.autoCheckUpdates` (boolean, default false) and `settings.lastUpdateCheckAt` (positive safe integer milliseconds within the Date range, otherwise absent).
- Distribution exports `@momoki/distribution/releases`, `/platform` and `/version` own `fetchLatestDesktopRelease(deps)`, `fetchStars(deps)`, validated release metadata, `RELEASES_URL`/`INSTALL_GUIDE_URL`, `detectPlatform(nav)` and `pickAssets(release, platform)`. Preserve ambiguous Mac alternatives instead of guessing a CPU.
- The version export owns `parseVersion(value)` and `classifyUpdate(current, latest)`. Strict three-part safe integer versions compare numerically; outcomes are `update-available | up-to-date | ahead | unknown`.
- `downloadAsset({asset, fetchImpl, signal?, onProgress?, onVerifying?, maxBytes?, digest?})` returns verified bytes or cancellation; saving uses `downloadBlob(blob, filename, signal)` and the existing native transfer owner.
- `RuntimeHttpScope = {purpose, probeOrigin?, redirected?}`: `redirected` records a transport-followed hop, not user input. `runtimeFetchFor` supplies fixed `release-check` and `release-asset` wrappers.

## 3. Contracts

`/settings` renders a real `ModuleLayout`: labeled rounded search plus five icon sections on the left, one visible-section header and neutral rounded groups with divided rows on the right. The user-provided Codex settings reference governs spacing and grouping while existing application tokens/chrome remain shared. Every section title uses the same wrapper and top/left position; connections must not supply a nested `PageHeader`/`PageContent` or surplus description. `/settings?section=connections` embeds `ConnectorsSection`; legacy `/connectors` redirects there with replacement. `/about` remains available. AppFrame's settings entry covers all three paths; there is no separate connections rail item. Invalid section search values are ignored.

Search trims input, matches section/row titles, descriptions and keywords without case sensitivity, and keeps matching sections/rows. Populate the page's metadata with actual settings; empty `rows` makes the helper's row matching unreachable. Empty search restores sections, and no match exposes a labeled empty state. Native button semantics give the labeled switch Space/Enter activation with `role="switch"`, `aria-checked` and focus-visible treatment.

Connections' model/search/catalog selectors all carry shared Phosphor icons. Settings search is a named `type="search"` input with `autoComplete="off"`; API credentials have distinct names and `autoComplete="new-password"`. These hints alone do not prevent every browser/password-manager fill. `SearchConnection` and `ConnectorsSection` synchronously notify `onEditorOpenChange(true)` before mounting a credential dialog. Settings updates a ref and state: handlers reject search/navigation changes against that ref even before rerender, and the background controls are disabled while editing. Accepted close/success unlocks them. A background autofill must never filter away the editor subtree or discard its credential draft. Tavily async results, feedback, toasts and unlock callbacks belong to the mounted initiating component; an old save after navigation must not unlock a newly opened dialog. A synchronous pending ref guards duplicate operations and dismissal before the busy render.

General settings default automatic checks off and tolerate missing/invalid/read-failed preferences. Enabling the setting is a device-local write shared by both runtimes. Startup auto-check must survive StrictMode cleanup/setup and issue zero requests while off. A successful check records the timestamp and suppresses further automatic checks for 24 hours; a failed check does not record success and may retry at a later startup. Reactive preference reads use `useProductQueryState`: initial failure shows defaults and an error, later failure retains the last known value with accurate status text. Page operations guard duplicate invocation synchronously, cancel on departure, suppress obsolete progress/results and retain a busy state through verification and system Save. A failure to persist a preference is visible and cannot silently change the saved value.

Storage counts use the supplied `useProductQuery` transaction for every table, including nested helpers. Never call the global store from inside that callback: it can end the browser transaction early (`PrematureCommitError`). Keep non-database waits and HTTP outside transactions; loading/read failure must not masquerade as an empty successful inventory.

`release-check` permits only anonymous HTTPS `GET https://api.github.com/repos/ROYIANS/momoki/releases?per_page=30`, no body or credential headers. Release requests have an 8-second deadline and a 1 MiB JSON ceiling; discarded/aborted bodies are canceled. A validated localStorage cache expires after six hours and does not accept future timestamps. Drafts and non-desktop tags are ignored. Prereleases retain their label; metadata is not proof of installed behavior.

`release-asset` starts only under normalized `https://github.com/ROYIANS/momoki/releases/download/`. Only subsequent transport-followed hops may reach exact HTTPS origins `https://objects.githubusercontent.com` and `https://release-assets.githubusercontent.com`. No userinfo, body or credentials; every redirect is reauthorized. Connector configuration grants no exception to either purpose. Browser metadata checking retains the ordinary browser transport; native policy enforcement remains in the transport wrapper.

Installer reads never exceed the minimum of declared size, the configured smaller limit and the hard 64 MiB ceiling. Exact size and lowercase SHA-256 must match before any Save. Missing digest or oversized installer uses an explicit system-browser download option; it never bypasses in-app verification. macOS offers architecture choices when the navigator cannot identify the CPU. Cancellation, unpublished failure and a published file with a finalization warning have different UI outcomes. Release, download and installation-guide anchors are routed by the existing `installNativeExternalLinks` handler to `nativeOpenExternalUrl` in Tauri; ordinary browser links retain their usual behavior. Installation guide links use `INSTALL_GUIDE_URL`, distinct from the actual release's `htmlUrl` or `RELEASES_URL` fallback.

Site imports only declared lightweight distribution exports. Studio keeps `features/settings/updates/download.ts`, runtime HTTP, storage and settings outside that closure. Retain the first-screen budget guard on the built site, including the assembled deployment output.

## 4. Validation / error matrix

| Input or outcome | Required behavior |
| --- | --- |
| Missing, nonboolean or failed preference read | Auto-check remains off |
| Invalid timestamp | No accepted check timestamp |
| Auto-check off or recent successful check | No automatic GitHub request |
| Current version missing/dev/malformed | Unknown; never claim latest or recommend automatic upgrade |
| Current version numerically above latest | Show development/newer build message |
| No accepted desktop release, invalid JSON, network or rate limit | Actionable reason plus release-page recovery |
| CDN URL supplied as the first request or unrelated redirect | Reject before granting origin or sending the native request |
| Missing digest or oversized installer | Explain and offer browser download |
| Actual bytes exceed limit, size mismatch or digest mismatch | Cancel/discard; no Save |
| Repeated check/download during pending work | Reuse/ignore pending invocation; no second save |
| Background search autofill, including the same turn as opening a connection dialog | Keep the dialog/input/draft mounted; ignore filtering until close |
| User cancels Save or navigates away | No success claim; cancellation/cleanup stays explicit |
| Native Save reports publishedWithError | Preserve published-file certainty and finalization warning |

## 5. Good, base and bad cases

Good: a newer release with a matching, bounded installer is verified and handed to the existing Save owner, then the user follows the installation guide. Base: ambiguous Mac architecture shows Apple/Intel choices; unavailable network provides the official release page. Bad: a decorative disabled theme selector, guessed Mac CPU, unbounded `response.json()`, or changing a canceled transfer into a saved-file message.

## 6. Tests required

Cover search on real section metadata, defaults/illegal values and persistence on the actual device-settings repository, route validation/redirect and rail highlighting, each version verdict's visible text, off/default/interval startup behavior, StrictMode lifetime replay, duplicate/unmount operations, save cancellation/failure/published certainty, normalized purpose paths and redirect provenance, stream bounds and digest mismatch. `settingsConnectionEditors.test.ts` mounts real ReactDOM/Radix/Tavily: preserve dialog/input identity and draft after autofill and same-turn opening, resume manual search after close, and require the search selector icon. Existing landing release/platform/boundary tests and `landing:budget` remain gates. Run root types/full tests/formal quality/self-test/model verification/build plus desktop types/lint/quality with the approved machine pnpm. Real-device acceptance covers topbar/popup geometry, narrow settings layout, GitHub reachability, native Save, and installation.

## 7. Wrong versus correct

Wrong: `useProductQuery(() => db.projects.count(), [])` reaches the global store inside an observation transaction, or an effect sets a permanent `started` ref before scheduling work then cancels its timer during StrictMode cleanup.

Correct: `useProductQuery(tx => tx.projects.count(), [])` keeps reads on the callback's snapshot; effect setup creates its own timer/lifetime and cleanup cancels only that setup. Pending request controllers gate duplicate calls and pass the same signal through download and Save.
