# Agent Business Details

## 1. Scope / trigger

E01 establishes in-workspace single-shot inspection/editing from Agent links without route departure. E16 extends the finite supported set to character/scene/prop/style exact links in project and Studio ownership, with retained batch-review handoff. Application composition connects the retained Agent to existing feature editors. The shared ContextPanel presentation also applies to task, memory, material, audio and music panels; their collection/workflow URLs do not automatically become entity reads. See the E16 coverage inventory for intentional navigation and concrete future family work.

This contract changes app/feature APIs and draft departure reporting. It introduces no storage schema, new Agent execution host, router bypass or provider request.

## 2. Signatures and ownership

```ts
// features/video/models/shotDetailTarget.ts (declared feature entry)
type ShotDetailTarget = {projectId: string; episodeId: string; shotId: string};
shotDetailHref(target: ShotDetailTarget): string;

// app/details/shotDetailTarget.ts (private app parser)
readShotDetailTarget(href: string): ShotDetailTarget | undefined;

// app/details/ShotDetails.tsx (named feature-to-app composition entry)
ShotDetailsProvider({children: ReactNode});
ShotDetailLink({href, target?, ...anchorProps});
useShotDetailActivation(): (event: MouseEvent<HTMLElement>, target?: ShotDetailTarget) => void;

// features/library/models/assetDetailTarget.ts (declared feature entry)
type AssetDetailTarget = {
  kind: "character" | "scene" | "prop" | "style";
  owner: {kind: "studio"} | {kind: "project"; projectId: string};
  entityId: string;
};
assetDetailHref(target: AssetDetailTarget): string;

// app/details/BusinessDetails.tsx (named finite composition entry)
type BusinessDetailTarget =
  | {kind: "shot"; target: ShotDetailTarget}
  | {kind: "asset"; target: AssetDetailTarget};
readBusinessDetailTarget(href: string): BusinessDetailTarget | null;
type DetailReturnOrigin = {
  token: string; label: string;
  onEnd(event: {token: string; requestId: string; reason: "return" | "close" | "replaced"}): void;
};
type DetailOpenResult =
  | {status: "opened"; requestId: string}
  | {status: "refused"; requestId: string; reason: "guard" | "busy" | "superseded" | "unavailable"};
useBusinessDetails(): {
  open(target: BusinessDetailTarget, options?: {origin?: DetailReturnOrigin}): Promise<DetailOpenResult>;
  returnToOrigin(token: string): Promise<"returned" | "refused" | "stale">;
} | null;

// features/video/ui/ShotDetailPanel.tsx (declared feature entry)
ShotDetailPanel({request, onRequestOutcome, onClosed, closeRequest?, onCloseRefused?, returnLabel?});
// AssetDetailPanel uses the same session props with its own AssetDetailTarget.

// app/layout/detailPanelSession.ts: type-only layout composition contract
type DetailPanelRequest<T> = {id: string; target: T};
type DetailPanelOutcome =
  | {requestId: string; status: "presented"}
  | {requestId: string; status: "refused"; reason: "guard" | "busy"};
type DetailPanelClose = {requestId: string; reason: "close" | "return" | "replaced"};
type DetailPanelCloseRequest = {id: string; requestId: string; reason: "return"};

// Optional additions to existing field controls; existing callers remain valid.
TextDraftField.onDepartureState?: (state: ManualDraftState, discard: () => void) => void;
DurationInput.onDepartureState?: (state: ManualDraftState, discard: () => void) => void;
// ContextPanelContent returnLabel defaults to "返回工作区"; Agent uses "返回对话".
```

AgentChatPage retains its session/provider tree inside ShotDetailsProvider, a thin delegate to one finite BusinessDetails composition. The app retains independent shot and asset family slots until their guarded closes and coordinates request IDs/origin callbacks; it never switches a discriminated render in a way that unmounts an outgoing dirty editor. Video and Library own their respective record loading, exact target ownership, existing fields/commands and draft departure. Layout owns arbitration and committed presentation only. Keep exact entries synchronized in `quality/studio-ownership.json`; do not add a generic cross-feature registry or expose private implementations.

## 3. Contracts

Supported finite target coverage (E16), where `assetKind` is exactly `characters`, `scenes`, `props` or `styles`:

| Destination | Current behavior / owner |
| --- | --- |
| `/p/{p}/e/{e}/shots?shot={s}` and matching hash | Existing Video-owned single-shot editor |
| `/p/{p}/assets/{assetKind}/{id}` | Library-owned editable asset with exact project ownership |
| `/{assetKind}/{id}` | Same real Library fields with explicit Studio ownership |
| Batch review's two typed target links | Finite shot/asset detail with retained review and guarded return |
| Bare `/assets`, project/world/library collections | Keep collection navigation; an href without entity ID does not select a record |
| `/p/{p}` and `/p/{p}/e/{e}`, including current audio/music/beat producer links | Keep intentional workspace continuation; do not infer a chapter/take/beat/work ID |
| Exact IP/memory links | Existing navigation remains until their feature editor/session is explicitly extracted |
| Task opening, reveal originating call/batch, settings, external/citation links | Preserve the action's existing workflow/publisher meaning |

This is the supported shot/four-asset rollout, not a claim that every entity family has an inline editor. Later material/IP/memory/project/episode/audio/music work must establish exact identity, real editor reuse and complete draft ownership first.

- Recognized links have `/p/{projectId}/e/{episodeId}/shots?shot={shotId}` or its `#/…` form. Keep a canonical real anchor. Intercept only unmodified normal left/keyboard activation inside the provider and only if an explicitly supplied typed target matches the parsed target. Download, middle and modifier activation preserve native intent; arbitrary destinations, citations and footnotes retain publisher rendering and routing.
- Asset paths use only the four explicit plural mappings and the declared project/Studio discriminator. Match an explicitly supplied typed target against all parsed kind/owner/entity facts before interception. Resolve the Studio sentinel only in the Library owner, and verify an owned project for project targets. Never derive an entity ID from a label, list order, collection URL or unrelated result ID.
- Bound href to 2048 characters and each decoded ID to 256. Reject blank IDs, traversal IDs, path/control delimiters, malformed encodings, foreign/absolute URLs, extra/duplicate query keys and extra path/hash content. URL normalization must not expand the allowlist. This parser is not an ownership authorization check.
- Query through one explicit ProductStore readonly context, checking project, episode.projectId, shot.projectId and shot.episodeId. Return an envelope keyed by all three requested IDs even for a missing record. Loading, missing and genuine read errors have distinct local UI; no whole episode grid, filter change or throwing router loader.
- Library captures the requested kind, owner and entity ID inside its readonly query envelope and checks the returned record independently. Project-owned targets also require the project to exist; Studio targets resolve only the Library sentinel. The same real field/slot bodies serve route pages and embedded details, preserving their labels, touched-field commands and generation-slot baselines. A retained dirty snapshot belongs only to that exact target and disables writes while unavailable.
- An AssetTextField write returning typed `StorageError` with `certainty === "unknown"` quarantines only that exact owner/kind/entity/field intent. Keep its draft readable and suppress ordinary retry; backup, visibility/unmount flush and retained-controller resume must not repeat the command. Only explicit discard releases that intent for new editing. Observing a matching row is not acknowledgement of the original write.
- Reuse existing ShotTextField/DurationInput, relation commands and media-slot editors. Freeze each save to its original target and touched-field baseline. Existing field CAS, relation intent and slot baseline rules apply. No whole-record overwrite or implicit retry against a new revision.
- Report raw text/numeric input synchronously before queued React/controller updates. Aggregate dirty/error and pending state across fields, relations and operation editors. Read this live aggregate in close, return, replacement and same-registration A→B departure; effect-only reporting leaves an unsafe input-to-navigation gap.
- Invalid numeric raw text counts as dirty even when no command was started. Pending work blocks discard. Continue preserves draft, selection, focus/scroll and active target; explicit discard clears only the departing owner's drafts. A competing request cannot apply stale completion to a newer target.
- Media operation editors (the slot editor) open as a sheet over the detail panel (`SidePanel` nested in a panel) and retain their own route/departure guards and cleanup. The pane uses total dirty/pending for local close/replacement and delegates media route protection through the existing optional routeDirty/routePending flags. Route confirmation and before-unload read the route flags; aggregate render comparisons cover all four flags so an inline save settling while media stays open updates the confirmation.
- Retain a matching opened snapshot while dirty/pending when the target disappears or reading fails. Show a local explanation and keep drafts readable; unavailable text, number, relation, media and retry entry points cannot write. New targets cannot reuse that snapshot.
- Dock only when measured surface width fits active navigation + panel + 480px center. Full-width mode uses the same portal/editor DOM, preserves main geometry/reading state, hides/inerts only the main working subtree and provides a visible return action. Global chrome stays usable. Focus cannot remain in the hidden subtree or a newly hidden return bar; queued Agent autofocus must yield to inert ancestors.
- Preserve actual manual editor route-departure protection. Ordinary route changes and opening/returning from detail do not cancel application-owned Agent execution or require a stop-before-leaving bypass. Operation dialogs retain their purpose-specific modal behavior; batch-review target inspection yields only modal presentation while retaining its controller/draft/approval identity.
- Host replacement callbacks distinguish `replaced`, `guard-refused` and `busy`; existing boolean-only consumers remain compatible. ContextPanelContent consumes `onPresented` after the selected connected frame commits. This means frame commitment, including loading/missing, not entity availability or pixel paint. Features deduplicate by request ID; resizing and repeated callbacks cannot admit a request twice. `showReturnWhenDocked` and `onReturn` support an explicit origin action in both layouts without a second close owner.
- Same-family incoming refusal reports that incoming request and restores requested=accepted; it does not close the accepted editor. Serialize guarded open/return attempts; match every asynchronous outcome to its original request. Provider teardown is not a user close/return.
- A batch source captures stable control/caret/scroll bookmarks, hides/unmounts its modal content/overlay and lets the focus/inert boundary release before opening detail. Keep BatchSurface edits/revision/group/expanded/pending and router guard mounted. Never use force-mounted hidden modal content, or call persist/confirm/start merely to inspect.
- Arm the source token only after its exact detail request is presented. Refused admission restores the same source review without clearing the preexisting editor. Explicit return/ordinary close passes the detail guard, removes its presentation, then restores that token’s source bookmark exactly once. Successful replacement retires the old origin without reopening its modal over the new detail; stale callbacks/cleanup never reopen another review. Show `返回批量审阅` in both docked/full-width layouts. Existing revision/approval/apply checks remain authoritative after edits; inspection cannot renew consent or refresh an approved baseline.

## 4. Validation and error matrix

| Condition | Required behavior |
| --- | --- |
| Valid normal shot link during a stream | Open detail inside workspace; stream and chat owner continue |
| Modifier/middle/external/footnote/citation activation | Preserve anchor/publisher behavior |
| Parsed IDs belong to different owners | Local missing state; no editable record or filter repair |
| Initial record read fails | Local error with explicit read retry; no unhandled rejection |
| Target deleted with dirty/pending draft | Retain readable draft, disable all writes and retries until available |
| Another field changes remotely | Touched-field command can merge under its existing contract |
| Same touched field changes remotely | Retain local draft and current remote value; require explicit conflict recovery |
| Invalid numeric input then close/switch | Departure confirmation protects the raw input |
| Pending save then close/discard/switch | No discard and no retargeting of the pending command |
| Rapid A→B→C / canceled replacement | Current guard decides once; stale completion cannot replace a newer owner |
| Width changes with caret/reading position | Same editor DOM and draft survive; hidden chat continues running |
| Exact project/Studio asset link | Open the matching real asset fields; foreign/missing ownership stays local |
| Batch target inspection with unsaved review edits | Release the modal boundary; keep review controller, draft and approval identity |
| Return with dirty/pending detail | Detail guard decides; refused return leaves the same detail visible |
| Detail origin replaced or source token retired | Retire only that origin; never reopen its old modal over a new selection |

## 5. Good / base / bad cases

- Good: a streamed Markdown shot link opens an editable side panel; resizing replaces only workspace presentation, and returning restores the retained transcript position.
- Base: a missing historical link opens a local missing-state panel while the conversation continues.
- Bad: navigating to the episode grid to inspect one filtered-out shot, confirming a session stop, clearing filters, rendering a second chat owner, or showing a non-interactive pane behind an operation dialog.

## 6. Tests required

- `tests/shotDetailTarget.test.ts`: canonical/hash forms, bounded IDs, traversal/encoding, extra/duplicate keys and noncanonical destinations.
- `tests/shotDetailPanel.test.ts`: actual DOM controls and ProductStore; invalid numeric departure, pending frozen saves, A/B/C cancel/discard, touched-field CAS, deletion retention and missing/foreign scope.
- `tests/shotDetailQueryLifecycle.test.ts`: actual StoreTx reads with controlled observation delivery; new-target loading excludes previous data, retired late results are ignored, actual read failures stay local and explicit retry recovers while retaining readable dirty drafts.
- `tests/businessDetailTarget.test.ts` and `tests/businessDetails.test.ts`: finite asset parsing/activation, typed target matching, actual cross-family host arbitration, committed request/return outcomes, replacement and teardown token handling.
- `tests/e16AssetDetailPanel.test.ts` and `tests/e16AssetDetailQueries.test.ts`: actual Library query/field bodies, explicit project/Studio ownership, matching dirty snapshots, synchronous departure, frozen saves and uncertain-intent write isolation.
- `tests/e16BatchDetailHandoff.test.ts`: actual Radix presentation plus the facade/host/feature editor; modal release before inspection, exact retained review/bookmark restoration, refusal and retirement without implicit save/approval/generation.
- Shared ContextPanel coordinator/DOM/focus-return and manual-draft suites: replacement cancellation, stale completions, return/focus/scroll and pending protections remain intact.
- `tooling/agent-parallel-details-browser.mjs`: real AgentChatPage/controller/session, controlled streaming transport, actual ProductStore and business components. Assert pointer/keyboard link paths, modifier intent, responsive same-DOM caret/store state, hidden conversation reading/draft, pending/CAS behavior and real route departure. A fixture is not packaged WebView acceptance.
- Real isolated packaged app: open the persisted Agent shot link, inspect/edit detail, resize wide/narrow and return; verify committed native SQLite data. Record actual host coverage and any limitations separately.
- Use the local pnpm path from AGENTS.md. For the current multi-task delivery, the owner's 2026-10-15 instruction selects directly affected regressions, type checks and scoped code/architecture review per task. Full root suites, native-store integration, build and packaged acceptance are deferred to the end of the complete batch; task notes must distinguish passed checks from deferred checks.

## 7. Wrong versus correct

```tsx
// Wrong: route departure invokes the chat blocker, and changing the tree loses drafts.
onClick={() => navigate({to: shotDetailHref(target)})}
return narrow ? <Dialog><ShotEditor/></Dialog> : <aside><ShotEditor/></aside>;

// Correct: named app bridge retains real href; one Video-owned editor survives modes.
<ShotDetailLink href={shotDetailHref(target)} target={target}>查看镜头</ShotDetailLink>
<ContextPanelContent returnLabel="返回对话"><VideoOwnedFields/></ContextPanelContent>
```
