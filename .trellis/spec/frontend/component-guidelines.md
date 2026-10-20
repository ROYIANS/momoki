# Component Guidelines

> How components are built in this project.

---

## Overview

Routes are thin. Feature pages under `packages/studio/src/features/<feature>/ui/` own UI and data wiring. Application routes and layout live in `packages/studio/src/app/`. Primitives live in `packages/studio/src/ui/` (shadcn new-york + Radix + CVA). Chinese UI copy is normal.

---

## Layering

| Layer | Responsibility | Example |
| --- | --- | --- |
| Route | Params + discriminant props only | `packages/studio/src/app/routes/_studio.characters.$characterId.tsx` → `CharacterDetailPage` with `back={{ kind: "studio" }}` |
| Feature page | Live queries, layout, mutations | `packages/studio/src/features/library/ui/CharacterDetailPage.tsx` |
| Shared feature widget | Reused editors/tiles | `EditableGenerationSlot` in `packages/studio/src/features/library/ui/GenerationSlotCard.tsx` |
| UI primitive | Presentational, no ProductStore or adapter access | `packages/studio/src/ui/button.tsx`, `field.tsx` |

Do not put library grids and detail editors in the same route file. Do not put durable writes in route files — call the concrete business command owner in `packages/studio/src/features/<feature>/commands/` from the feature page / widget (see the D02 owner map in state-management).

---

## Component Structure

Typical feature page shape (see `CharacterDetailPage`):

1. Props with route discriminants (`characterId`, `back`).
2. `useProductQuery` with an explicit readonly context, query identity and `get(id) ?? null`.
3. Loading / missing early returns (Chinese: 加载中… / 找不到这个角色).
4. Ownership check for both contexts: project IDs must match `back.projectId`; studio routes require `STUDIO_LIBRARY_ID`.
5. Layout + `Field` / `EditableGenerationSlot` / inline `void patch*(...)`.

```tsx
export function CharacterDetailPage({
  characterId,
  back,
}: {
  characterId: string;
  back: { kind: "studio" } | { kind: "project"; projectId: string };
}) {
  const ownerId = back.kind === "project" ? back.projectId : STUDIO_LIBRARY_ID;
  const result = useProductQuery(
    async tx => ({ownerId, id: characterId, value: (await tx.characters.get(characterId)) ?? null}),
    [ownerId, characterId],
  );
  const character = result?.ownerId === ownerId && result.id === characterId
    ? result.value : undefined;
  // loading / missing / render…
}
```

Primitives export named functions (not default exports): `Button`, `Field`, `buttonVariants`.

---

## Props Conventions

- Prefer inline prop types on the function signature for page/widget props (as in `CharacterDetailPage`, `EditableGenerationSlot`).
- Discriminated unions for context: `back: { kind: "studio" } | { kind: "project"; projectId: string }`.
- Callbacks that persist: `onSave: (slot: GenerationSlot) => Promise<void>` — return the repo promise. Await success before close; keep failed drafts open for retry.
- UI primitives extend host element props: `React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }` (`button.tsx`).
- Use `asChild` + Radix `Slot` when a primitive should render as another element.

---

## Interaction feedback

Follow [Interaction Feedback](./interaction-feedback.md) before adding pending/progress/success copy. Normal success stays quiet when the result is already visible. Reuse the relevant control or operation surface, and reserve extra text for meaningful waiting, failure or a necessary action. Never turn every internal async phase into user-facing status text.

## Forms and Generation Slots

- Label + control: wrap with `Field` from `packages/studio/src/ui/field.tsx` (`label` + `children`).
- Asset text uses `AssetTextField` with a scoped keyed `useDebouncedDraft`, saving/error/retry feedback, and field-only repo patches. Freeze persistence to that field's original target; report input departure state synchronously and block writes while its record is unavailable. A typed unknown submission preserves the draft and quarantines that intent from retry/background flush until explicit discard. Do not bind an actively edited input directly to a live database row. `Field` associates label and child control IDs.
- Slot dialogs track only uploads they created; cancellation/replacement cleans orphan uploads, including late completion after unmount. Disable overlapping save/upload/close while a commit is pending. Never delete shared committed media.
- Preview tiles remain buttons; inspection inside dialogs uses full-image `object-contain` or video controls outside clickable tile buttons. Removal controls must remain keyboard-focusable and visible on touch devices.
- Image/video generation tiles use `EditableGenerationSlot` (`projectId`, `slot`, `variant`, `title`, `onSave`). Do not fork a second slot editor for assets/shots.

---

## Styling Patterns

- Explicit user preference (2026-09-22): build new audio/music and other workspaces with the existing `packages/studio/src/ui/` component library and shared theme tokens. Avoid a parallel visual system for one feature.
- Do not use decorative left-border accent strips on panels, script rows, cards or selected list items. Communicate grouping/selection with typography, spacing, neutral separators and restrained surface changes. Functional track colors and visible keyboard focus remain meaningful UI.
- Avoid excessive nested rounded rectangles and oversized corner radii by reducing redundant card wrappers. Keep the existing shadcn Button/Input/Textarea/Select default radius, borders, shadows and focus styling; do not flatten controls into sharp rectangles or override all controls with feature-level radius rules. User clarified this explicitly on 2026-09-22. Existing application-shell geometry remains its own contract.

- Tailwind v4 + CSS variables in `packages/studio/src/ui/theme.css`. Merge classes with `cn` from `packages/studio/src/ui/cn.ts`.
- Variants via `cva` on primitives (`buttonVariants` in `button.tsx`). Pass `className` through `cn(buttonVariants({ variant, size, className }))`.
- General UI icons: the explicit Phosphor semantic mapping in `packages/studio/src/ui/icons.tsx`, backed by pinned `@phosphor-icons/react`. Use Regular/Fill weights on the same glyph for selection. Model/provider logos remain `@lobehub/icons`; Lucide is retained only for immutable historical development comparisons.
- shadcn config: `components.json` (style `new-york`, `cssVariables: true`, alias `@/ui`).
- Shared frame and page presentation follow [Shared Desktop UI](./desktop-ui.md). Decorative motion respects reduced motion. `ClickSpark` remains only an immutable browser-regression fixture dependency; it is not mounted in the application shell.
- Agent chat (`packages/studio/src/features/agent/ui/`) is the only place that uses `@lobehub/ui` + antd ThemeProvider. Do not wrap StudioShell. Spacing uses the 4px scale (4 / 8 / 12 / 16 / 24 / 32). Body text is 12 / 14 / 16 — do not introduce 13px. Model chips in the composer use `@lobehub/icons` `ModelIcon`. Agent canvases are transparent and inherit AppFrame's single rounded working surface; do not add another rounded frame to the chat column. Its portalled header retains Agent provider context and a dedicated scoped popup host. Studio highlight tokens (`--brand` / `--primary` / `--ring`) are white, not teal.
- Composer inset lives on native `.agent-composer` in `agentChat.css` (`padding: … !important`). Do **not** put that inset on `--lobe-flex-padding` / `.lobe-flex`: Tailwind v4 `* { padding: 0 }` and `:where(.lobe-flex) { padding: var(--lobe-flex-padding) }` both have zero specificity, so they cancel and the send control sits flush on the card. `ChatInputArea.Inner` also used `padding-block: 0` + `height: 100%` and made it worse. Host antd/lobe dropdowns with `getPopupContainer` → `.agent-chat-root` (theme CSS + ChatWorkspace `pointer-events: none` overlay).
- Expanded `FloatingComposer` uses the same AntD `Input.TextArea` with `autoSize=false`. In `composerControls.css`, its direct flex item uses `flex: 1 1 auto; height: 100% !important; min-height: 0 !important` inside the existing full-height stack; footer/control rows stay nonshrinking and textarea owns overflow. `height: 0 !important` compressed the real WebKit editor to its padding at 760×520. Collapse removes the expanded selector and restores ordinary `autoSize`, without recreating the input or draft owner. Verify actual editable text and expand/collapse draft preservation in the macOS app; CSS parsing and a browser screenshot alone do not establish native layout.
- Conversation detail (`ChatWorkspace`) and home use `AgentHeader` through the stable `AppHeaderPortal` target. Header DOM sits outside the working surface; do not retain the old absolute 52px ChatHeader mask/transcript offset. Header menus use an explicit `[data-agent-header-popup]` popup host marked `data-tauri-drag-region="false"`, avoiding an ambiguous first `.agent-chat-root` selector. `.agent-chat-column` fills its parent without additional margins, borders or corner rounding; expanded editing stays inside this same column. Agent containers use parent-relative heights, not viewport minimum heights. Body popovers retain their original `.agent-chat-root` host. Message list and `.agent-composer-dock` share `.agent-content` (`max-width: 800px`, centered) as the safe-width column — do not let the composer go full-bleed. Topic navigation uses the existing sessionStorage `momoki.agent.topicSidebarCollapsed`; collapse hides/inerts the retained topic body rather than remounting feature/runtime owners. Below `md`, open `TopicListBody` in a right Sheet. The external panel control is the single topic toggle. 「开启新话题」creates an empty thread via `createChatThread` and navigates to `/agent/$threadId` (not HomeWelcome). 「搜索」filters thread **titles** with `filterThreadsByTitle`. Existing header actions retain their real callbacks; no 分享 / 分栏 / 助理档案 stubs. Active thread is the route `/agent/$threadId` (home is `/agent`); do not keep it only in React state. Missing `$threadId` uses liveQuery `get() ?? null` and only redirects for the matching route ID. Empty streaming assistant rows use `ThinkingMatrix` through `renderMessage` (`message=""`) and ChatItem avatar loading while waiting for initial content. Run-backed reasoning stays in the unified execution process; legacy reasoning retains `ThinkingPanel`. Process folding, reminders and turn navigation follow [Agent Activity UI](./agent-activity-ui.md); transcript scroll, memo and avatars follow [Chat Performance](./chat-performance.md).
- `StudioShell` and `WorkspaceChrome` share `AppFrame` from `packages/studio/src/app/layout/`. It owns one external top bar, a fixed 56px global icon rail at >=768, a left Sheet below 768 and one inset/rounded working surface. General application icons use the shared Phosphor mapping; selected navigation uses matching Regular/Fill weights; preserve route predicates and accessible labels. AppHeaderPortal moves actual Agent/project header presentation while retaining feature providers/callbacks. macOS uses real native traffic lights/Overlay; browser has no traffic-light placeholders and Windows/Linux retain their native title bars. `PageHeader`/`PageToolbar`/`PageContent`/`PageState` own typography/layout only; feature owners retain guards, commands, drafts and scrollports. See [Shared Desktop UI](./desktop-ui.md) for executable chrome, focus, theme and print contracts.
- Model dropdown groups by vendor via `groupModelsByVendor` in `packages/studio/src/features/settings/models/modelVendors.ts`. Catalog ids are often `cc-gpt-4o` / `cc-gemini-…` — do **not** `^`-anchor `gpt-` / `gemini`. Keep o-series on a word boundary (`/\bo[1-9]/`) so `photo1` stays 其他. Connector chips (not a footer Select) switch the BYOK connector inside that same panel.

---

## Accessibility

- Studio utility navigation opens the real `/settings` page on desktop and mobile. Its five sections include connections and desktop update information; legacy `/connectors` redirects to `/settings?section=connections`. `/about` remains available and owns sponsorship links and the original appreciation-code image, shown through the shared Dialog with a download link. See [Settings and desktop updates](./settings-update.md).

- Interactive primitives keep `focus-visible` ring tokens (`focus-visible:ring-ring/50 focus-visible:ring-[3px]` on `Button`, `Input`, `Select`, etc.).
- Decorative canvases / icons that must not be announced: `aria-hidden` (`ClickSpark` canvas; shell SVG in `StudioShell`).
- Slot tiles expose an accessible name via `ariaLabel` / `title` into `GenerationSlotTile`.
- Keyboard shortcuts in shot UI must yield when focus is in a form/overlay: gate with `isFormFieldTarget` from `packages/studio/src/ui/formFieldFocus.ts` (see `ShotEditorPage`).

---

## Examples

- Thin studio route: `packages/studio/src/app/routes/_studio.characters.$characterId.tsx`
- Shared asset editor: `packages/studio/src/features/library/ui/CharacterDetailPage.tsx` (also Scene/Prop/Style detail pages)
- Generation UI: `EditableGenerationSlot` in `packages/studio/src/features/library/ui/GenerationSlotCard.tsx`
- Primitive + CVA: `packages/studio/src/ui/button.tsx`
- Form label wrapper: `packages/studio/src/ui/field.tsx`

---

## Anti-patterns

- Fat routes that inline Dexie queries and full page markup instead of a `*DetailPage` / feature component.
- Studio create that opens a project picker or navigates to `/p/$projectId/...` (see state-management).
- New global form library or Zod schemas for every input — forms patch repo directly.
- Duplicating generation-slot dialogs instead of `EditableGenerationSlot`.
- Importing `antd/dist/reset.css` from Agent chat (leaks into studio `html`).
- Passing a React node as `@lobehub/ui/chat` `ChatItem.message` (it `String()`s to `[object Object]` — pass a string + `markdownProps`; for empty streaming use `renderMessage` → `ThinkingMatrix`).
- Putting model shortcut chips inside the composer box; the toolbar is left Agent/任务 + `+`, right ModelIcon trigger + send. Connector/vendor switching belongs inside the model dropdown.
- Putting composer inset on `.lobe-flex` padding vars (or `ChatInputArea` inner `padding-block: 0`) — send sits flush. Use `.agent-composer` native chrome.
- Toast stubs for Agent 「搜索」/ 分享 / 分栏 / 助理档案 — search filters titles; the others are removed, not placeholders.
- English-only loading/empty strings when neighboring copy is Chinese.
- Ignoring `isFormFieldTarget` when adding shot keyboard shortcuts.
- `window.prompt` / `window.alert` / `window.confirm` (native browser chrome titled like “localhost:5173 显示”). Use `Dialog` for rename/input and `AlertDialog` for destructive confirm — same pattern as `ProjectGalleryPage`.
- Wrapping Agent native `ActionIcon` (`@lobehub/ui/base-ui`) in `Link` / `<a>` creates nested interactive elements. Navigate from `onClick` instead. The deprecated root export renders a div without native Enter/Space activation; do not introduce it for new keyboard controls.

---

## References

- `packages/studio/src/features/library/ui/CharacterDetailPage.tsx`
- `packages/studio/src/features/library/ui/GenerationSlotCard.tsx`
- `packages/studio/src/ui/button.tsx`, `field.tsx`
- `packages/studio/src/ui/formFieldFocus.ts`
- `components.json`


Optional creative fields, output settings, props/style dialogs and media reuse follow [Asset / Output Foundation](./asset-output-foundation.md). Do not add duplicate per-provider selectors or make optional metadata required at creation.

## Shot editor interaction and rendering (2026-09-21)

- Duration text retains decimal punctuation while focused; valid numeric drafts use serialized persistence and the project backup barrier. Invalid text remains editable, and failed writes expose retry.
- Global shot shortcuts yield to native buttons/links/summaries, ARIA button/link controls, inputs, overlays, and DnD handles. Do not cancel an event until the shortcut has a valid target.
- Shot rows keep 160px anchors and DnD registration for all filtered records. A shared IntersectionObserver mounts editing controls within 640px of the scrollport; active/focused/dragging rows stay mounted. Placeholder focus must reveal controls and preserve Tab access. Deep links scroll directly to the existing anchor; filters, ordering, exports, and selection use the full scoped data.
- When adjusting this behavior, check last-row deep links, Tab across unloaded rows, keyboard drag, and pointer drag across a scrolling boundary. The ready benchmark measures the complete anchor shell and first editable row, not eagerly mounted offscreen controls.


## D03 feature responsibility contract (2026-10-08)

### 1. Scope / Trigger

Maintain these boundaries when changing shot editing, audio/music workspace commands, chat execution/selection, project landing, or ZIP package import/export. Feature pages own routing, visible feedback and UI interaction lifetimes. Named commands own an actual business sequence; pure codecs own data validation/remapping without persistence. Do not introduce an action registry or factory solely to reduce a file's line count.

### 2. Signatures / Owners

- `features/video/ui/shotEditorCommands.ts`: `applyShotBulkCommand({episodeId, selectedIds, patch, label})`, `deleteShotSelectionCommand({episodeId, selectedIds})`, and `reorderShotGroupCommand({episodeId, fullOrder, groupIds, activeId, overId})` return `Promise<UndoAction | undefined>`.
- `useShotEditorKeyboard(input)` owns its capture listener and typed callbacks. `ShotRow.tsx` owns row/sortable/viewport/slot presentation; `ShotRelationsEditor.tsx` owns relationship pending/error/retry state. `shotColumnFields.ts` maps nine text columns to their actual string fields and builds typed patches; duration/characters/scene use their dedicated editors.
- `features/audio/ui/audioSelection.ts`: `deriveAudioSelection(snapshot, previous, intent)` returns a partial selection patch and optional seek data. Its named segment/clip/take/saved cases retain their distinct rules. The page produces seek-request tokens and owns displayed state.
- `features/audio/engine/buffers.ts`: `loadBuffers(schedule)` and `loadAudioBuffer(mediaId)` share playback, waveform and export decoding/cache. `exportAudioMix({projectId, projectName, chapterId, scope})` accepts `NonNullable<AudioExport["scope"]>` (chapter/project) and returns the persisted WAV Blob/name/attenuation result; the UI owns download/notice.
- `features/music/ui/switchMusicVariant.ts`: `switchMusicVariant({projectId, draftId, target, links})` returns the resulting draft ID and variant links. The page owns synchronous action/submission locks and best-effort storage of links.
- `useChatExecutionSession(threadId, scope)` observes the application-owned execution service; it does not expose page-owned acquire/release/controllers. Runtime `chatExecutionFlows.ts` owns the three headless send/retry/decision flows. `useChatSelection(...)` retains current selection; `useReferenceDraft` adapts the retained feature-owned `chatDrafts` model. See E11 execution/reference contracts for exact lifetimes.
- `importStudioProject(file)` is the shared import feedback adapter for gallery/shell. `ProjectHomePage({projectId})` owns keyed landing queries, project-kind routing and film first-episode repair. Route files remain adapters.
- `app/workflows/packages/projectPackageCodec.ts` parses/remaps project rows; `features/audio/packages/audioPackageCodec.ts` parses/remaps audio/music rows. Shared `PackageError` has one constructor in `platform/data/packageError.ts`; the application package export preserves that identity. `app/workflows/packages/projectPackage.ts` owns ZIP/media IO and the whole import transaction; `features/audio/services/audioProjectPackage.ts` owns audio snapshot/insertion inside the supplied store.

### 3. Contracts / Invariants

- Bulk undo uses the repository's atomic inverse; deletion undo uses its actually deleted rows and retained Blobs. UI render snapshots cannot replace those results. Reordering retains its full-order inverse and filtered-group behavior; it does not invent a new revision protocol.
- Row extraction retains active/drag/viewport keep-alive and slot identity. Relationship checkboxes remain explicit membership intent; clear/bulk replacement stay distinct. Pending/error state still protects departure. D03 keeps the existing text-cell commit policy; D08 separately owns draft/baseline/retry behavior.
- Audio selection is a partial patch, not universal resetting. Repeated segment, missing clip/take, owner/chapter and saved-take transitions remain asymmetric. Player epoch/disposal, audition/seek/composition cleanup, pointer capture, Alt snapping and undo history remain Timeline-owned.
- Export executes flush → fresh immutable repository snapshot → schedule/decode/render outside writes → atomic `addAudioExport` → UI download. A render result is not persisted from live component data. Current fingerprint/scope/duration/evidence validation remains in the persistence command.
- Variant switching flushes, rereads the current draft, validates its project, reuses a legal target or creates one, then links it. Synchronous page action/submission locks cover the whole command. Storage failure does not retroactively turn a successful database command into failure.
- Chat claims the application service synchronously before awaiting. An exact invocation owns release after its original final flush; view effect cleanup only unsubscribes. Home creation navigates only through the matching attachment generation; submitted content is consumed immediately, canonical acceptance joins by reserved ID, and whole-draft restoration cannot overwrite later edits.
- Retry uses the original frozen run connector/model. Run decisions are persisted before credential checks; cancellation does not require a connector. Selection reconciliation retains connector/base-URL/model/thread identity and increments mutation revision before awaiting. Optimistic field persistence remains field-local; no all-field rollback policy is added.
- ZIP parsing, raw modern-ID/FK validation, full audio metadata freshness, legacy normalization, remapping, hashing and compression remain outside writes where required. Modern raw relationships are checked before tolerant parsers can repair/drop them; full fingerprint validation precedes schema allowlisting. The root import saves the entire project/media/production/audio graph in one complete transaction. A late audio relationship failure rolls back earlier inserted rows and Blobs.
- Imported paid-job history remains sanitized/manual/dormant; mounting, focusing and polling an imported project cannot resume paid work. Snapshotting and export history retention stay compatible with the existing C contracts.

### 4. Validation / Error Matrix

| Condition | Required behavior |
| --- | --- |
| No effective bulk/delete/reorder result | No fabricated undo action |
| Save/relation/variant/export failure | Existing visible feedback/retry/draft guard remains; no partial success notice |
| Decode/render failure | No export/media rows and no download |
| Route/effect replay during chat | Detach only; explicit Stop signals the exact application owner and retains the lock until final flush |
| Begin fails after home navigation | Keep transferred owner and a visible retry without creating a second topic |
| Missing connector after approval decision | Persist the decision, expose recoverable error; do not replay a paid request |
| Invalid raw package FK, stale fingerprint, or late audio relation | Actionable public package error; no partial imported graph |
| Imported running history | Sanitize to dormant/manual; no provider call on mount/focus/poll |

### 5. Good / Base / Bad Cases

- Base: a bulk shot patch returns its atomic inverse and produces one undo action; repeated audio segment selection retains the existing take/seek behavior.
- Good: a home chat navigation transfers the frozen reference payload while later home edits survive; an abort still holds the execution lock until final flush completes.
- Good: native video/audio/music ZIP round-trips preserve accepted rows; a forced late audio validation failure observes earlier inserts and then rolls them all back.
- Bad: rebuilding an inverse from rendered rows, acknowledging references before begin, releasing on abort before flush, saving a live audio snapshot, validating only allowlisted fingerprints, or importing table groups in separate transactions.

### 6. Tests Required

Use the real command/controllers and actual module mock identities. Cover repository-result undo, typed selection intent, lock/epoch/effect replay and frozen retry/approval sequencing. Retain B01 unavailable/dirty navigation and B07 actual history/reference-owner cases. Package regressions must use real ZIP bytes, current raw relationships, fingerprint boundaries, observed pre-fault writes and all-table rollback. Native audio verifies decode/render/cache/persistence, not acoustic quality. Preserve failed fixture attempts and prove a fault was reached; do not weaken assertions or increase timeouts to hide setup errors.

### 7. Migration / Limits

Every moved owner has an actual caller. `productionContext.ts` and `generationIntent.ts` receive comment-only historical boundary markers. Their bodies/public APIs are unchanged, and their only current value consumers are the two corresponding test files; the latter also type-imports `ProductionContext`. They are not claimed as active production owners. Active paid/resumable execution remains in the existing agent runtimes; E07 separately owns dead-export/reference cleanup. The audio persistence root also retains pre-existing parse/remap compatibility exports without inventing consumers; the project codec calls the pure audio codec directly. No D04 context snapshot, D05 schema/serializer, D06 capability, D07 transport or D08 text-draft contract is advanced by D03. Existing page/import/keyboard complexity remains explicitly measured; improved inherited metrics are not a claim of a clean formal static gate. Browser fixtures use controlled local transport, with zero external/provider requests, and do not establish full live-provider E2E coverage.

Shot and beat scalar text uses `TextDraftField` through `ShotTextField`/`BeatTextField`; see `state-management.md` D08. Key the captured persistence callback by project/entity/field, retain immediate local text and visible retry/latest state, and preserve existing duration/relationship/slot/reorder owners. Pending missing/virtualized rows retain readability and existing route/backup barriers.

## E01 manual editor departure ownership (2026-10-09)

### 1. Scope / Trigger
Manual dialogs/sheets whose draft must survive Escape, dismissal, owner replacement and route history changes; pending mutations must retain their owning UI. Source contracts live in `packages/studio/src/app/drafts/useManualDraftGuard.tsx`.

### 2. Signatures
`ManualDraftState = {dirty: boolean; pending: boolean; routeDirty?: boolean; routePending?: boolean}`. `ManualDraftDeparture = (leave: () => void, discard?: () => void | Promise<void>, onCancel?: () => void) => void`. `useManualDraftDeparture(dirty, pending, onDiscard, {readState?, route?})` returns stable `requestDeparture` and JSX `confirmation`. `useManualDraftGuard(dirty, pending, onDiscard)` retains its route-only JSX API.

### 3. Contracts
Freeze the editor opening identity, revision and input baseline. Publish current dirty/pending through synchronous refs before close/duplicate actions, not only passive effects. Clean/reverted input can leave; dirty input requires explicit continue/discard; pending cannot discard. Local child actions reuse the owner's arbiter and may supply scoped discard, preserving unrelated pending editors. The first local request freezes its discard/leave callbacks; a later POP is reset before the original local departure completes. Same-path search retains the owner; an actual same-path owner replacement still needs local interception. Optional route flags delegate a nested editor's existing route blocker without relinquishing local parent ownership. Effects use the stable destructured `requestDeparture`, not an unstable returned object. Restore connected focus/scroll; call caret APIs only for numeric non-null selection bounds supported by the original input/textarea.

E11 explicit desktop Quit aggregates mounted owners in `app/drafts/manualQuitGuards.ts`, including `route:false` overlays, and uses their same local confirmation. One original aggregate promise resolves the most recently mounted dirty/pending owner first. Accepted discard advances past that exact owner within the intent even if its React dirty state has not committed or its existing discard callback intentionally does nothing. Cancellation, a competing local request or unregistering the owner awaiting a decision must settle the original Quit attempt conservatively; it cannot leave a detached dialog promise waiting forever. Cancellation returns the native lifecycle to running before execution admission closes. Ordinary conversation navigation continues to use existing manual ownership without an execution-only Stop dialog.

### 4. Validation / Error Matrix
| Trigger | Outcome |
| --- | --- |
| Clean opening or edit then revert | Leave without dirty prompt |
| Dirty Escape/close/backdrop/SPA/POP | Continue retains exact draft and current owner; explicit discard may leave |
| Pending save/upload/audition | Keep owner mounted; reject discard and duplicate submission |
| Local confirmation followed by route attempt | Resolve one initiating request, reset overlapping router request |
| Old async owner completion | Preserve original authorized persistence, suppress newer-owner UI/navigation publication |
| Number/range/date/color/checkbox focus | No unsupported selection API call |
| Desktop Quit with dirty nested overlay | Same existing confirmation; cancel preserves execution, accepted owners are not selected again in the same intent |
| Quit confirmation owner unmounts | Original aggregate request settles conservatively; no permanently waiting native intent |

### 5. Good / Base / Bad Cases
Good: local close -> browser Back -> continue -> original draft remains; explicit discard resolves the original close. Base: an unchanged form closes immediately. Bad: clearing editing before departure resolves, treating every open form as dirty, or invoking setSelectionRange with null positions.

### 6. Tests Required
`tests/e01ManualDraftDeparture.test.ts` executes synchronous refs, stale callbacks, failure/retry and overlapping requests. `tooling/e01-drafts-browser-regression.mjs` executes actual Radix/TanStack/IndexedDB forms; preserve B01 compatibility when changing the shared guard. E01 independent supplements cover nested promotion and real goal/plan/CAS/delete ownership. Full E01 accepted input hashes and limits are in the E task's independent review.

### 7. Wrong vs Correct
Wrong: `void write(); close()` or a Dialog callback that unconditionally clears local editing. Correct: guard the frozen owner, await its command, retain rejected input, and close only its successful initiating session. Wrong: add the entire changing departure object to an effect. Correct: invoke/depend on its stable requestDeparture binding. Controlled Chromium evidence does not prove WebKit, OS unload UI or paid providers.

## E02 topic keyboard action ownership (2026-10-09)

### 1. Scope / Trigger
Read before changing TopicSidebar row selection, rename/delete actions, focus visibility or menu targeting.

### 2. Signatures / Owners
`TopicRow` owns a noninteractive `.agent-topic-row` container and sibling native `button type="button"` controls: `.agent-topic-row-title` selects, `.agent-topic-row-action` renames/deletes. Existing TopicSidebar/AgentChatPage callbacks retain mutation/navigation/departure ownership.

### 3. Contracts
Row actions must be in the Tab order even when the row is inactive and unhovered. CSS reveals them on hover, active or `:focus-within` (2026-10-13: the row's right-hand relative time is hidden at the same moment, and on `hover: none` the actions stay visible); every keyboard-focused control has a visible ring. Child Enter/Space activates only that native button and intended thread; it must not invoke row selection. The selection button retains native Enter/Space and pointer behavior. Actions are siblings, never interactive descendants of a row button. Preserve accessible names and pointer/context-menu target semantics. Explicit role attributes may support existing DOM-based test targeting; they do not replace native semantics.

### 4. Validation / Error Matrix
Inactive + unhovered + Tab → title focus reveals actions; next Tab reaches rename/delete. Child Enter/Space → correct target dialog, current selected thread and route unchanged. Title Enter/Space/pointer → intended selected thread without action dialog. Hover/active/context menu → existing visibility and intended owner. Failed/pending mutation → existing E01 owner guards remain responsible.

### 5. Good / Base / Bad Cases
Good: native sibling selection and action buttons, focus-within visibility. Base: inactive row initially hides action paint while retaining keyboard reachability. Bad: parent role-button handles bubbled keydown, child only stops click, or action DOM exists only on hover/active.

### 6. Tests Required
Real browser Tab from an external anchor into an unhovered inactive row, both activation keys for title/rename/delete, actual controlled dialogs/native persistence and selected-route assertions, hover/pointer/context menu, focus ring and E01 draft guard integration. Update old test targets to actual interactive buttons when semantics change, preserving assertions and timeouts. A programmatic callback behind an inert modal is limited callback integration evidence, not a physical pointer claim.

### 7. Wrong vs Correct
Wrong: put onSelect on a parent button-like row containing ActionIcon descendants and handle every bubbling key. Correct: make selection/actions independent native buttons and reveal actions from CSS focus ownership.

## Topic sidebar: project grouping (2026-10-13)

### 1. Scope / Trigger
Read before changing `TopicSidebar`, the grouping preference or new-topic entry points.

### 2. Signatures / Owners
`topicGrouping.ts`: `groupThreadsByProject(threads, projects, now?)`, `readTopicGrouping(storage?)`, `writeTopicGrouping(value, storage?)`, `formatRelativeShort(iso, now?)`, `UNLINKED_PROJECT_KEY`. Preference key `momoki.agent.topicGrouping` ("project" | "time"; sibling of `momoki.agent.sendShortcut`). `TopicSidebar` props add `projects?` and `onNewTopicInProject?(projectId)`. `AgentChatPage.createTopic(projectOverride?)` is the one creation path; `handleNewTopic` takes no argument so a click event is never read as a project id. Time grouping still uses `groupThreadsByTime`.

### 3. Contracts
Structure: brand row, "开启新话题" (primary), "搜索", "任务", then the list; no settings entry and no "话题 N" heading. Default grouping is by project: one collapsible section per project that has topics (newest topic first), topics in a section newest first, a project icon (Folder/FolderOpen) on each project and a Tray icon on "未关联项目", which collects threads without `projectId`, with a deleted project, and is last. "按时间" merges topics into the existing today/yesterday/month groups. A funnel button opens a menu with the two radio options; invalid or unreadable storage falls back to "project" and write failures are ignored. A "+" on each project section (hover/focus, always on touch; not for the unlinked section or an archived project) creates a topic bound to that project through `createTopic`, keeping the task inspector's manual departure guard without an execution-stop confirmation. Search filters by title in the current grouping and renders matching collapsed sections open without rewriting the user's fold state. If `projects` is undefined, group by time instead of flashing everything into "未关联项目". No pin/archive: no data model supports them.

### 4. Validation & Error Matrix
| Condition | Result |
| --- | --- |
| Thread references a deleted project | Listed under "未关联项目" |
| Project has no topics | Section not shown |
| Storage throws or holds junk | Default "project", no error |
| "+" clicked | Calls the callback with the project id; row selection not triggered |
| Archived project | No "+" |

### 5. Good / Base / Bad Cases
Good: one project, three topics, relative times right-aligned, "+" starts a bound topic after the usual confirmation. Base: no projects load yet, time grouping. Bad: calling creation with a click event, or showing deleted-project topics as an available project.

### 6. Tests Required
`topicGrouping.test.ts` (ordering, unlinked/deleted/empty projects, preference fallbacks, relative-time bands), `topicSidebar.test.ts` (default project render, fold, switching and persistence, search expansion and restore, hover/focus replacement markup, "+" callback and no row selection, no settings entry or count heading). Visual layout, tooltips and the portal menu in the narrow overlay need real-window acceptance.

### 7. Wrong vs Correct
Wrong: `onClick={onNewTopic}` on the plus (the event reaches `createTopic` as a project). Correct: `onClick={() => onNewTopicInProject(project.id)}` with the guarded creation path.

## Error display (2026-10-14)

- Crash and not-found pages are `ErrorFallback`/`NotFound` (`defaultErrorComponent`/`defaultNotFoundComponent` on the router). They render inside the workspace so the app frame and navigation stay usable; "重试" calls the router `reset()` (which remounts the same subtree and may fail again), "回到首页" navigates away. Under `/agent` the page states that saved run progress can be continued and unsent composer text may be lost.
- `RootErrorBoundary`/`RootErrorFallback` are hand-written (no new dependency), use plain elements, and do not depend on the router, the database or `AppFrame`. The storage-failure page uses the same fallback with fixed copy.
- Non-crash failures use `showError`, never a raw `toast.error(error.message)` for the listed sites. The details dialog is mounted as a sibling of `RootErrorBoundary` so it also opens when the root crashes; its action results are an inline `role="status"` line because the Toaster may not exist.
- Prefer `role="alert"` markup and `Dialog`/`AlertDialog`; `window.alert/prompt/confirm` stay forbidden.


## Model catalog page (2026-10-14)

### 1. Scope / Trigger
Read before changing the third connections subsection "模型目录" inside `/settings?section=connections`, the selection dialog, the pricing table or the model-detail price row.

### 2. Signatures / Owners
`ConnectorsSection` (retained in `features/settings/ui/ConnectorsPage.tsx`) mounts `<ModelCatalogSection/>` only while its subsection is active. Settings supplies its page shell. Section reads the catalog with `useSyncExternalStore(subscribeModelCatalog, getModelCatalog)` and the saved selection in an effect plus state; never in `useProductQuery` (no database-unrelated awaits, see hook-guidelines). `ModelCatalogPicker({entries, onClose})` is mounted only while open, so its draft and any downloaded full list are released on close. `ModelPriceTable({entries})` lists raw entry prices. `ModelSelectTrigger`'s `ModelDetail` shows the price row from the memory-only `lookupModel`, given the selected connector's `definitionId` and `baseUrl`.

### 3. Contracts
- Sync card: source ("内置基线 · 包版本" / "已同步 · 时间"), count, last result, the notice that only the public catalog is fetched and no local data is sent. "立即同步" becomes "取消" while running (one AbortController, cancel is not an error). Failures use `showError` with the fixed action name `sync-model-catalog` and the friendly sync message as `detail`; success uses `toast.success`. "恢复为内置数据" lives in the "…" menu behind an `AlertDialog` confirmation and is disabled for a baseline. There is no open-folder/reload-file action.
- Picker: the full list (about 8,800 models) is loaded only on the user's "加载完整清单" via `fetchCatalogIndex`, which downloads but never persists and never replaces the store snapshot. Until then it lists the current catalog only. Rows merge by the sync's normalized-id rule (`buildCatalogRows`, one function shared with the sync); ticking a row ticks every equivalent key. "全选/清空筛选结果" affect filtered rows only. Selection is capped at `MAX_SELECTION_KEYS` and refuses to exceed it. Save writes `putCatalogSelection`; cancel writes nothing.
- Windowing: `VirtualRows` mounts only rows near the viewport, with a fixed row height and a fixed viewport height prop (no layout measurement), `role=list`/`listitem` with `aria-setsize`/`aria-posinset`. The arithmetic is the pure `computeWindow`. No virtualization dependency. Rows use native-button checkboxes (Tab, Space).
- Prices: USD per million tokens; an unknown price is "—" in lists and "价格未知" in the detail pane, never `$0`; a known 0 stays `$0`. Original-vendor prices in the detail pane say "官方参考价" and name the source `provider/id`.

### 4. Tests Required
`tests/modelCatalogUiLogic.test.ts` (window bounds, filters, merged toggles, limit), `tests/modelCatalogUi.test.ts` (picker, price table, section sync/cancel/failure/restore), `tests/modelDetailPrice.test.ts`. jsdom cannot show real layout, scroll performance, or the 760 px dialog.

## Landing page (standalone entry) (2026-10-14)

### 1. Scope / Trigger
Read before touching `apps/site/landing.html`, `apps/site/src/**`, `tooling/landing-budget.mjs`, `apps/site/public/robots.txt|sitemap.xml` or nginx's `location = /` rule. The site builds separately from web; root build assembles both outputs. Production serves the site at `/` and the app at `/agent`. Desktop uses its own config and excludes the site.

### 2. Signatures / Owners
- `main.tsx` mounts `Landing` and calls `initUmami()`. `#root` in `landing.html` holds static markup equivalent to the React render; React renders beside it and swaps only after a successful commit, so a script or render failure leaves the readable static page (SEO included). There is no `<noscript>`; the static markup is the no-JS version.
- Film engine (`film/`): sticky 100svh stage inside a track of `TOTAL_WEIGHT x 100svh`; six stage scenes plus normal-flow credits (`scenes.ts`, `timeline.ts`). `useFilmProgress` measures the track rect and a damped driver writes `--film-progress`, `--scene-index`, `--scene-local`, `--stage-tone`, `--film-time` once per frame, running only while converging. Mode is film or static (`mode.ts`): reduced motion (live matchMedia), stored skip (`localStorage momoki.landing.skipFilm`), or no canvas2d.
- Playback (`playback.ts`, `usePlayback.ts`): `FILM_PLAY_SECONDS` (sum of per-scene beats: ease-in, hold, 1.6 s exit), `playbackToProgress`/`progressToPlaybackTime` are inverses; states idle|playing|paused|finished; wheel, touch, pointerdown and navigation keys interrupt, scroll events never do; Space toggles unless focus is on an interactive element; Esc pauses; programmatic `scrollTo({behavior:"instant"})`. HUD: play button, ARIA seek slider, aria-live scene announcements.
- Stage is picture-first: only the slate label and one subtitle are visible; titles, narration and bullets exist only in the sr-only reading layer and the static version. Stage is `aria-hidden`, inactive layers `inert`.
- Rendering (lazy chunk `film/renderers/stage.ts`): Canvas 2D particle pool (preallocated Float32Array, caps by quality tier, seeded RNG, never allocates per frame), per-scene `plan*`/`draw*`, adaptive tier downgrade on rolling p95 frame time (never upgrades), rAF only while needed. `renderers/filmLook.ts` is a separate canvas stepping at 24 fps (12 on low): grain tiles, dust, flicker, corner marks; gate weave moves only `.lp-picture`, never text; frozen when paused. Scene tone comes from `tone.ts` with contrast >= 4.5:1 asserted across progress.
- Download/GitHub (`download/`): `GET api.github.com/repos/ROYIANS/momoki/releases?per_page=30` (`releases/latest` 404s while only prereleases exist). Keep non-draft tags `^desktop-v\d+\.\d+\.\d+$`, numeric semver sort, assets matched by the strict names in `release-policy.mjs`, every URL must normalize (`new URL().href`) to under `https://github.com/ROYIANS/momoki/releases/download/` (or the releases page for `html_url`). 6 h `localStorage` cache (`momoki.landing.release`, `momoki.landing.stars`), 8 s timeout, fallback to the Releases page. Stars are shown only at `STAR_DISPLAY_THRESHOLD` (50) or more.

### 3. Contracts
- Imports stay inside site source or declared React and lightweight distribution exports. Never import studio, product storage, Agent, Dexie, zod, TanStack Router, Tauri, antd or LobeHub through any direct/transitive path. Studio's private `@/` alias is unavailable to site. Source boundary tests and `landing:budget` verify the real built closure; no motion dependency is needed by the current site.
- Token values in `landing.css` equal `packages/studio/src/ui/theme.css` (`tests/landingTokens.test.ts`). Every copy entry is `{text, evidence}` with an existing evidence path; no text may contain a phrase from `tests/fixtures/landing/forbiddenClaims.ts`.
- External requests: only `api.github.com` (releases, repo stars) and Google Fonts (`text=` subset); no application or storage requests. Storage use: the three `momoki.landing.*` keys above, always inside try/catch.
- Budgets: first-screen JS <= 120 KB gzip, CSS <= 15 KB gzip; the film renderers are a lazy chunk; the budget script also fails if the desktop output contains landing files.

### 4. Degradation matrix
| Condition | Presentation |
| --- | --- |
| No JS / script or render failure | Static markup in `#root` |
| `prefers-reduced-motion: reduce`, stored skip, or no canvas2d | Static stacked version, all information and links kept |
| Slow frames (p95 > 22 ms) | Particle tier steps down, film look to 12 fps; never back up |
| GitHub API failure, timeout or invalid payload | Download card links to the Releases page |
| Unknown or ambiguous platform | Show all matching installers (e.g. both Mac chips); never recommend x64 for ARM Windows/Linux |
| Page hidden or paused | No rAF, film look frozen |

### 5. Tests Required
`landingTokens`, `landingEntry`, `landingBoundary`, `landingCopy` (evidence paths, forbidden claims), `landingFilm` (progress, modes), `landingPlayback` (inverse mapping, interrupts, Space/Esc), `landingParticles` and `landingStage` (pool, tier downgrade by p95), `landingScenes45`, `landingFilmLook`, `landingTone` (contrast), `landingPlatform`, `landingReleases` (filter, sort, asset names, URL escape via `../` and `%2e%2e`, cache validation), `landingDownloadCard`. Frame rate, iOS Safari sticky, trackpad/touch interruption, scrollbar dragging, grain intensity and web fonts need real devices.

### 6. Wrong vs Correct
Wrong: `url.startsWith(PREFIX)` on a server-provided address (`.../releases/download/../../x` passes). Correct: compare `new URL(url).href` to the prefix.
Wrong: showing scene titles on the stage or reading `scrollY` events to interrupt playback. Correct: titles in the sr-only layer, interrupts only from wheel/touch/pointer/keys.

## Popover surfaces

- Every floating surface (`ui/popover`, `ui/dropdown-menu` content and sub-content, `ui/select`, raw-Radix feature popovers, antd composer menus) caps height at the Radix `--radix-*-content-available-height` (antd menus: `100dvh - 68px`), scrolls internally and caps width at the available width. Sub-menus scroll too; none may use `overflow-hidden` as the only overflow rule.
- Collision padding always comes from `ui/popupCollision.ts` (`popupCollisionPadding`, 52px top-bar clearance); do not hand-write padding.
- Z-index scale: `ui/` wrappers portal to body at `z-50`; chat popovers inside `.agent-chat-root` use 80 (pickers) / 1100 (model, context). Do not add other layers; portal into the nearest `[role=dialog]` or `.agent-chat-root`.
- Truncated labels (model ids, project names, titles) expose the full text through `title` or a `ui/tooltip`; tooltips wrap at 20rem.
