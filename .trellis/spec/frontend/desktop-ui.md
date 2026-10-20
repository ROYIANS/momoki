# Shared Desktop UI Contract

## 1. Scope and trigger

All Studio and project pages share window chrome, neutral surfaces, typography and overlay behavior. The 2026-10-13 user-approved shell replaces the previous edge-to-edge/wide-navigation presentation with a fixed icon rail, separate top bar and one rounded working surface. It governs presentation; feature owners retain queries, mutation commands, drafts, playback, runtime sessions and persistence barriers.

## 2. Signatures and owners

`packages/studio/src/app/layout/AppFrame.tsx` exports:

```ts
AppFrame({children, onImport?, contentScroll = "auto"}: {
  children: ReactNode;
  onImport?: () => void;
  contentScroll?: "auto" | "hidden";
})
```

`StudioShell` and `WorkspaceChrome` supply their existing import handlers and guarded content. `AppFrame` does not create a router, data provider, project owner or Agent runtime. Its `NAV` owns destination labels and active state; `/agent/tasks` must never activate the chat destination.

`packages/studio/src/app/layout/AppHeaderPortal.tsx` exports `AppHeaderPortal({children}: {children: ReactNode})`. It portals actual feature-header presentation into AppFrame's stable DOM target while preserving the original React providers and callbacks. The target owns no business/query state; responsiveness changes CSS, not the target or feature owner tree. A custom header suppresses the fallback section label.

`packages/studio/src/platform/runtime/windowChrome.ts` exports `getWindowChromeKind(): "macos-overlay" | "native" | "browser"`. Genuine runtime detection precedes the frozen Rust-injected `window.__CUEPOINT_WINDOW_CHROME__ = {version:1,kind}` presentation marker. Browser ignores incidental markers; unknown native chrome does not reserve macOS traffic-light space. It calls no IPC and is separate from storage-profile selection.

`packages/studio/src/app/layout/PageLayout.tsx` exports:

```ts
PageHeader({title, description?, count?, back?, actions?, dense?, className?})
PageToolbar(props: ComponentProps<"div">)
PageContent(props: ComponentProps<"div"> & {
  mode?: "collection" | "detail" | "document" | "workbench";
})
PageState({title, description?, action?, kind?, compact?, className?})
// kind: "loading" | "empty" | "missing" | "error"
```

Header slots accept ReactNode. `PageContent` renders a div and adds width/padding classes; keep or explicitly supply the page's `main` landmark. These helpers do not fetch data or add a scrollport. `LibraryHeader` adapts collection title/count, actions, search and sort to the same primitives.

## 3. Presentation and lifecycle contracts

- Feedback follows [Interaction Feedback](./interaction-feedback.md): immediate visible results, quiet ordinary success, one relevant progress surface and user-action language. Do not add transient per-message captions for internal sending/storage/loading phases.
- `packages/studio/src/ui/theme.css` is the shared token owner: shell chrome `#242424`, application `#101010`, panel `#151515`, elevated `#202020`; the navigation token `#0c0c0c` remains for the mobile Sheet. Shared shell geometry is inset 8px, radius 16px, top row 44px and rail width 56px; mobile uses 4px inset and 12px radius. Desktop navigation targets are 36px with 16px glyphs; mobile navigation rows retain 44px targets. Header shortcuts default to muted foreground and brighten on enabled hover/press, keeping title text primary. Existing semantic foreground, border and focus tokens govern controls. Agent's LobeHub/antd adapter is scoped to its body or header theme host; never import antd reset CSS globally.
- The frame fills `100dvh`. AppFrame owns a separate top bar, a fixed approximately 56px desktop icon rail at all widths >=768, and one inset/rounded working surface. Below 768, application navigation opens in a left Sheet. Preserve route predicates, import callbacks, tooltips and accessible names. Global destinations use matching Phosphor Regular/Fill weights on the same component, with Fill only for the active destination; Creation Assistant uses House. Settings is the last rail entry, pointing to the real `/settings` page. It stays active for `/settings`, `/about` and legacy `/connectors`; connections live inside settings, with no separate global rail entry. Do not add a second shell around the chat column or a workbench.
- macOS Tauri retains real native traffic lights with decorated Overlay/hidden native title; the application top row reserves their space. Pure titlebar space drags/double-clicks through pinned Tauri drag-region support; interactive controls explicitly exclude dragging. Only allow-start-dragging and allow-internal-toggle-maximize window capabilities are required. Windows/Linux retain their native title bars in this contract; browser shows application chrome without fake traffic lights or native calls.
- Agent and project header JSX appears in the external top bar through AppHeaderPortal. Agent's scoped header theme/popup host stays distinct from the body `.agent-chat-root` so menus keep theme and escape working-surface clipping without changing other Agent popup lookup. The shared module toggle controls internal left navigation. Project sections live inside `ModuleLayout` navigation; the external header stays one 44px row, with compact overflow actions on narrow screens. Guards and callbacks remain with WorkspaceChrome. Collection/detail page headings retain their semantic content inside the surface.
- `ModuleLayout` publishes a persistent 260px left navigation (music reuses its 340px creation form). Collapsing changes CSS/inert state without remounting feature children. Below 768px it becomes a named left modal overlay; trap focus, isolate main/header/rail, and restore the opener on close.
- `ContextPanel` portals one stable editor subtree into AppFrame’s persistent sibling host. Dock only when measured surface width permits active left navigation + panel + 480px center; widths are 400px shot/task/material/memory, 320px audio and 300px music. Both modes are complementary regions. When space is insufficient, details occupy the working surface with a visible return action; the retained main subtree becomes inert and hidden while keeping its geometry, scroll and runtime ownership. Header/rail stay interactive. Keep the same FocusScope/DismissableLayer and portal target across modes; no business-detail drawer, backdrop or focus trap. Nested operation dialogs keep their own modal semantics. See [Agent business details](./agent-business-details.md).
- Features own panel open state, selected identities, drafts and pending locks. The frame coordinator asks outgoing departure before replacement, resets a canceled incoming request, and rejects stale/competing completion. `useManualDraftDeparture` accepts optional cancellation notification; Continue/pending never discards the active draft. Do not move mutation ownership into layout.
- `historyNavigation` is attached once to product router history. Arrows reflect proved accepted entries only, serialize traversal, and keep normal router blockers. Unknown/reloaded entry starts with both arrows disabled; parent links are ordinary internal navigation. `productRouterHistory` serializes public PUSH/REPLACE until original blockers accept/deny and flushes every accepted write, avoiding installed-history index gaps and incorrect canceled-POP rollback; rapid accepted pushes become real distinct entries. Reconcile accepted/canceled POP without pruning a valid forward branch.
- Functional page h1 is sans 24px/600/32px; narrow (<768) and dense workbench h1 are 20px/600/28px. Body is 14px/22px, metadata 12px/18px. Use restrained neutral grouping; avoid decorative accent strips and nested cards. Keep shadcn control geometry and focus styling (normal 36px, compact 32px), rather than flattening every control with feature CSS.
- Shared Radix Tabs use `packages/studio/src/ui/tabs.tsx`: 36px panel-colored track and 32px triggers, with elevated surface for the selected trigger. Selection adds no static border, ring or shadow; keyboard `focus-visible` retains the shared ring. Consumers may adjust wrapping, width and compact inline padding, but must not replace the selected surface, radius or focus treatment. Do not mix a feature-specific underline/transparent/rectangular skin with the shared selected state. Navigation links and independent filters retain their own semantics.
- Collection content uses available width, detail content caps at 1040px, reading documents at 880px, workbenches use available width. Shared padding is 24px; workbenches 16px 20px; narrow pages 16px. Header actions and toolbars wrap without widening the window. Tables and timelines may scroll horizontally within their own containers.
- Each page keeps one primary vertical scroll owner. `ModuleLayout` main/nav columns own independent scrolling; project details and workbenches preserve their existing feature scrollports. Do not wrap editors or media players in breakpoint-dependent alternate trees. Agent home/thread routes share the same `AgentChatPage` host; transcript and composer keep the 800px safe width. Topic navigation below 768 opens the shared **left** module overlay.
- Controlled `Dialog`, `Sheet` and `AlertDialog` integrate `createOverlayFocusReturn()` from `packages/studio/src/ui/overlayFocusReturn.ts`. It captures the opening focus, delegates caller autofocus handlers and queues a fallback only if the closing focus is body/null. It respects `preventDefault`, connectedness, a newer opening generation, Radix Trigger restoration and valid custom focus. It must not prevent AlertDialog's default initial Cancel focus.
- Every AlertDialog registers its safe cancellation control through `AlertDialogCancel`. Existing manual-close handlers may use `asChild` plus wrapper `onClick={event => event.preventDefault()}` so Slot runs the child owner once and suppresses duplicate primitive close behavior. Preserve disabled/pending/blocker behavior.
- Short-window overlays use bounded height, a scrollable body and reachable header/footer. Pending and failed writes retain existing owner rules and drafts. Escape and close restore focus after the closing animation, without scrolling the underlying page.
- The application navigation trigger uses `.app-header-shortcut.app-mobile-nav-trigger` to hide it at widths >=768; the narrow-window rule restores `display:flex`. The compound selector must outrank the general shortcut display rule. Shared Radix popover/dropdown/select/tooltip and custom context/model/project/audio popups call `popupCollisionPadding()` from `ui/popupCollision.ts`; its top clearance is 52px (44px bar plus gap). Keep the available-height scroll bounds as well as collision padding. Browser CSS proof does not replace short packaged-window acceptance.
- Application-owned general UI icons use pinned `@phosphor-icons/react` through static individual CSR imports in `packages/studio/src/ui/icons.tsx`. Ordinary controls use Regular and selected navigation uses Fill. Preserve color, size, class, aria and SVG ref while removing LobeHub geometry overrides; Phosphor uses a 256x256 viewBox. Provider/model logos and measurement SVG keep their own owners. Immutable historical comparisons retain Lucide only as a development dependency.
- Agent icon buttons requiring native keyboard activation import `ActionIcon` from `@lobehub/ui/base-ui`. The installed deprecated root export renders a focusable div without Enter/Space activation. Keep accessible labels and existing props/handlers; do not nest buttons in links.
- Print remains white A4 landscape with 10mm margins. `@media print` releases height/overflow of the frame/body/content surface/workspace ancestors, clears shell inset/border/radius, hides top bar/navigation/workspace header/print toolbar/toasts, and keeps storyboard cards together where possible. Screen theme changes must not recolor printable output.

## 4. Validation and error matrix

| Condition | Required behavior |
| --- | --- |
| Query is still loading | `PageState kind="loading"` exposes status; no retained owner row is rendered |
| Current owner is missing or mismatched | Existing missing/owner guard blocks edits; never relabel it as loading forever |
| Empty list or search has no results | Contextual empty state and available recovery action; no fake success |
| Mutation fails / revision conflicts | Owner's error/retry/conflict state stays visible and draft remains available |
| Long title / narrow viewport | Single external row truncates/overflows actions deliberately; document width stays within viewport |
| Short window / long dialog | Body scrolls; close, cancel and commit remain reachable |
| Overlay caller prevents autofocus | Helper respects caller; no forced focus return |
| Opener removed or another element already focused | No fallback focus theft |
| Window crosses 768 or 1200 | Sheet/rail presentation changes only at 768; desktop rail never expands; runtime, input and playback owners remain mounted |
| Measured surface cannot fit active navigation + detail + 480px center | Detail fills the working surface; return action is reachable, chat stays mounted/running and its saved reading position survives |
| Full-width detail returns to docking | Same editor/input DOM and draft survive; focus moves away from a return action that becomes hidden |
| Native marker missing or unrelated | Browser ignores it; genuine native uses ordinary native presentation, never changes storage owner |
| Titlebar control clicked | Original action executes; dragging/maximizing does not intercept controls or menus |

## 5. Good, base and bad cases

- Good: `PageContent mode="detail" role="main"` combines shared width with a feature's ownership guards; `PageHeader actions={<Button .../>}` keeps its existing command callback.
- Base: collection page uses `LibraryHeader`, `PageToolbar` and contextual `PageState`, preserving sort/search state and cards' keyboard menus.
- Bad: a new page adds a 36px marketing headline, feature-specific shell colors, a second rounded frame, or a scroll wrapper around an existing workbench. A controlled confirmation without `AlertDialogCancel` leaves initial focus outside the modal.

## 6. Verification and assertion points

- `tests/overlayFocusReturn.test.ts`: caller delegation/prevention, valid focus preservation, detached opener, current generation and fallback focus with preventScroll. Existing B01/B06 consumer harnesses must traverse presentation slots so query identity, revision guards, session ownership and redaction assertions still exercise actual controls.
- Native browser: all contextual pages' headers, landmarks and scroll ownership; widths 1440x900, 1280x720, 1024x640, 1280x600 and 390x844; both sides of 768/1200; dialog safe initial focus, Escape/close return after animation; Agent Space/Enter activation; draft and playback across resizing; long storyboard print layout.
- Tabs: verify Material media/settings, World query-backed categories and Music creator/workspace modes. Mouse selection has no permanent outline; arrow keys move selection and expose keyboard focus; narrow wrapping must not widen the document. Check settled content after route/draft changes before recording the selected state.
- Preserve meaningful business tests for asset ownership/drafts, shot filters/lazy rows/undo/episode delivery, audio arrangement and approvals, music variants/duration, memory CAS and Agent execution/context. Pure visual changes need native evidence, not implementation-mirroring snapshots.
- Full frontend gate: typecheck (`pnpm lint`), tests, quality, quality self-test, `models-dev:verify` and build. Use the explicit local pnpm path from AGENTS.md. Record actual failures and fixes before the passing run.
- `tests/windowChrome.test.ts`: incidental browser markers, no window/IPC, storage-independent native presentation and unknown-marker handling. Real macOS inspection additionally verifies traffic-light alignment, drag/control exclusion, double-click/fullscreen and minimum 760x520 size; browser/build proof cannot replace it. Report Windows/Linux runtime evidence separately.

## 7. Wrong versus correct

```tsx
// Wrong: a second scroll owner and a feature-specific headline system.
<div className="h-screen overflow-auto"><h1 className="text-4xl">Your creative universe</h1><ExistingWorkbench/></div>

// Correct: shared presentation inside the existing feature scroll owner.
<PageHeader title="音频制作" dense actions={existingActions}/>
<ExistingWorkbench/>
```

Do not derive desktop packaging, database migrations or provider behavior from this presentation contract. Those require their own implementation scope.

## Side panel, top bar and dialogs (2026-10-20)

Where UI goes: a dialog is only for an alert/confirmation (`AlertDialog`) or one field (rename, paste). Anything more — forms, pickers, editors, review — is a right side panel. The conversation stream holds status text only; things waiting on the user are rows above the composer (`ComposerActionCards`). `tests/dialogUsage.test.ts` fails when a file outside its allowlist imports `ui/dialog`; add to the list only with a reason.

- Use `app/layout/SidePanel.tsx` for a form or picker: heading, scrolling body, `footer` pinned at the bottom (confirm/cancel), `kind` names the panel so its dragged width is remembered. A form's submit button lives in the footer and points at the form with `form="<id>"`. Opened from inside another panel (e.g. a slot editor in a detail panel) it renders as a sheet over that panel instead of replacing it, so the parent keeps its state.
- One panel at a time. `ContextPanelHostProvider` arbitrates; replacing goes through the departure guard. Width is clamped 320–720 and the content column never drops below 480; below that the panel becomes a full-width overlay (the work area stays mounted, `inert`). Dragged width is stored per `kind` (`app/layout/panelWidth.ts`).
- Auto-open: when the agent has something that needs the user, `useAutoOpenPanel` opens the panel once, only if no other panel is open and it fits beside the content, and never takes keyboard focus. Closing it marks the thing as offered for the session; it can still be opened from the row above the composer.
- Top bar (`AppTopbar` in `AppFrame.tsx`) is three zones separated by short half-height dividers: left aligned with the navigation column (logo, back/forward, navigation toggle), centre aligned with the content (title, rename, page actions, side-panel toggle at the far right), right aligned with the docked panel (its title and `ContextPanelHeaderActions`, blank when none). Widths come from `topbarZones` so the zones track the navigation and panel widths exactly. When the panel is docked its heading is shown in the top bar, not repeated inside.
- Tests that walk React elements by hand must also walk a `SidePanel`'s `footer` prop, which is not part of `children`.

## Settings navigation (2026-10-14)

`features/settings/ui/SettingsPage.tsx` uses one `ModuleLayout` with a named settings navigation, labeled rounded search and five Phosphor-icon sections: general, appearance, connections, storage and update. The right pane supplies one `PageHeader` for the visible section and neutral rounded groups with divided rows, preserving the module's single primary main scrollport. All five headings share the same position and geometry; no generic settings description or independent connections heading is inserted. Do not wrap `ConnectorsSection` in another page shell. `/connectors` replaces history with `/settings?section=connections`; `/about` remains available. Search includes setting titles, descriptions and keywords, and exposes an empty state. See [Settings and desktop updates](./settings-update.md) for storage, HTTP and operation-lifetime contracts.
