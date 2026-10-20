# Agent Chat Performance

> Momoki-sized contracts distilled from LobeHub Conversation (external reference `src/features/Conversation/ChatList`), not a virtua port.

---

## Overview

LobeHub’s list is a `virtua` `VList` plus ConversationStore. Momoki threads are short, local Dexie rows. We copy the **scroll and render isolation** rules, not the virtualizer, spacer, or zustand.

Source of truth in LobeHub (do not vendor):

| LobeHub | Momoki |
| --- | --- |
| `VirtualizedList` + `virtua` | Plain `.agent-message-list` overflow |
| `overflowAnchor: 'none'` | Same CSS on `.agent-message-list` |
| `scrollToBottom(false)` while generating | `snapChatToBottom` (`scrollTop = scrollHeight`) |
| `AT_BOTTOM_THRESHOLD = 300` | `CHAT_AT_BOTTOM_PX` in `packages/studio/src/features/agent/presentation/chatScroll.ts` |
| AutoScroll only if `atBottom && isGenerating && !isScrolling` | `stickToBottom` ref; skip snap when user scrolled up |
| `paddingBottom` from composer overlay height | `--agent-chat-composer-safe` padding on the list |
| `MessageItem` keyed by id, `memo` + store selector | `AgentChatMessageItem` `memo` with field compare |
| `keepMounted` streaming rows (virtua recycle) | N/A until we virtualize |
| Conversation spacer (pin user turn to top) | Deferred |

---

## Signatures

```ts
// packages/studio/src/features/agent/presentation/chatScroll.ts
export const CHAT_AT_BOTTOM_PX = 300;

export function chatDistanceFromBottom(el: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}): number;

export function isChatNearBottom(
  el: { clientHeight: number; scrollHeight: number; scrollTop: number },
  thresholdPx?: number,
): boolean;

export function snapChatToBottom(el: { scrollHeight: number; scrollTop: number }): void;
```

`MessageList` owns the scroll element. Do not pass a sentinel `bottomRef` up to `AgentChatPage`.

See [Agent topic reading](./agent-thread-reading.md) for explicit requested topic identity, local paused/following state, the native return-to-latest action and same-ID optimistic acknowledgement. Query/loading/departure ownership is defined there; never infer the requested topic from the first returned message.

---

## Contracts

- **Pin target**: the scroll container’s `scrollHeight` (content + list `padding-bottom`). That padding is the composer overlay safe area — same job as LobeHub’s `overlayHeight + 12`.
- **Instant while streaming**: `snapChatToBottom` is assignment, never `{ behavior: "smooth" }` and never `scrollIntoView`. Smooth animations abort each other on every SSE token and undershoot the padding.
- **User intent**: `onScroll` updates `stickToBottom` via `isChatNearBottom`. Wheel / drag that leaves more than 300px of room cancels follow until the user returns to the bottom.
- **Layout settle**: `ResizeObserver` on `.agent-content` re-snaps while pinned (markdown / images growing). One `requestAnimationFrame` snap on thread change covers layout settle, but must recheck the live following ref so manual pause before that callback wins.
- **2026-10-13 note**: assistant and user messages are now drawn directly (`agent-user-bubble` for the user; no bubble, avatar, title or time row for the assistant). `ChatItem`, avatar meta and the avatar loading ring named in older bullets below no longer exist; the memo comparator, `ThinkingMatrix`, `markdownProps` hoisting, anchored scrolling and stick-to-bottom contracts are unchanged.
- **History isolation**: Full message/run/tool-call streaming queries live at the transcript-reader boundary below ChatWorkspace. AgentChatPage/composer consume equality-cached semantic control values; a token/checkpoint/metrics commit that does not change those semantics cannot re-render them or all topic titles. Shared `useProductQuery` still updates its actual reader after matching committed changes. `AgentChatMessageItem` compares `id/content/status/role/createdAt/reasoning/reasoningDurationMs` so completed rows skip markdown. Hoist `markdownProps`; do not allocate it in the map. See [Sidebar Activity / Read Revisions](./agent-thread-activity.md) for small row subscriptions and exact revision envelopes.
- **Navigation continuity**: A thread change resets its local transcript scope while retaining the sidebar's actual DOM, search, fold and scroll state. Do not key the enclosing workspace by thread ID or show a replacement workspace while the selected listed thread's detail snapshot reloads. Prove continuity with actual routed DOM identity while holding that read; memoization alone does not prevent a keyed remount.
- **Snapshot preparation**: Resolve model catalogue initialization and other external asynchronous preparation before entering an observed ProductStore transaction. `ContextUsagePanel` calls `prepareAgentContextPreview` outside observation and `readPreparedAgentContextPreview` inside the readonly snapshot. A catalog import/initialization awaited inside Dexie can close its transaction and trigger a workspace error; timers or query retries do not repair that boundary.
- **Empty streaming**: while `status === "streaming"` and both `content` and `reasoning` are empty, `renderMessage` swaps in `ThinkingMatrix` (3×3 square cells; per-column length-2 snakes in order 1→2→3, bounce at top, may exit bottom; ~220ms tick); pass `message=""` so EditableMessage does not coerce a React node. Avatar `loading` stays on until the first answer token — ChatItem’s corner badge must be a hollow ring (transparent fill), not a solid `colorPrimary` disc. For run-backed messages, the execution process owns the current public reasoning/content and working indicator; the standalone matrix/ThinkingPanel path remains for legacy messages without a run.
- **Avatars**: none. Assistant text is drawn flat; user messages keep a right bubble without an avatar (2026-10-13).

---

## Validation & Error Matrix

| Condition | Behavior |
| --- | --- |
| Thread id changes | `stickToBottom = true`, snap + rAF snap |
| SSE token while pinned | ResizeObserver and/or memo row update → `scrollTop = scrollHeight` |
| User scrolled up > 300px | No snap; streaming continues off-screen |
| User returns within 300px | Pin resumes |
| `scrollIntoView({ behavior: "smooth" })` on a sentinel | Forbidden — wrong ancestor and undershoot |

---

## Good / Base / Bad

- **Good**: last token paints only the streaming `ChatItem`; list `scrollTop` tracks `scrollHeight`; user can scroll up mid-stream.
- **Base**: empty or short thread still snaps (padding-bottom keeps the last line above the composer).
- **Bad**: `useEffect` depending on `messages.at(-1).content` that calls `scrollIntoView({ behavior: "smooth" })` — jank + not at bottom.

---

## Tests Required

`tests/chatScroll.test.ts`:

- Distance 300px → `isChatNearBottom` true; 301px false at default threshold.
- `snapChatToBottom` sets `scrollTop` to `scrollHeight`.
- Scrolled to `0` on a tall list → not near bottom.

No RTL for MessageList (quality-guidelines).

---

## Wrong vs Correct

#### Wrong

```tsx
useEffect(() => {
  bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
}, [messages?.at(-1)?.content]);
```

#### Correct

```tsx
if (stickToBottom.current) snapChatToBottom(listEl);
// AgentChatMessageItem memo: historical content/status unchanged → skip
```

---

## Design Decision: no virtua yet

**Context**: LobeHub virtualizes because a topic can be thousands of tool/markdown rows; recycling would replay markdown animations unless `keepMounted` keeps the streaming index alive.

**Decision**: Momoki Agent MVP is local plain chat. Isolating the last row + `scrollTop` is enough. Do not add `virtua` / `react-virtuoso` until a thread is large enough that mounting every `ChatItem` is the measured cost.

**Extensibility**: If we virtualize later, copy LobeHub `keepMounted` for `status === "streaming"` and keep `overflowAnchor: "none"`. Still do not vendor ConversationStore.

---

## Anti-patterns

- New `markdownProps={{ variant: "chat" }}` object on every map iteration (breaks ChatItem memo).
- New `avatar={{ ... }}` object per row per tick (same).
- `overflow-anchor: auto` on the transcript (browser anchoring fights programmatic `scrollTop` during stream).
- Porting LobeHub’s spacer / send-scroll animation window — that exists to pin the user turn to the top of the viewport; Momoki has not adopted that UX.

## Rich transcript loading

`ChatWorkspace` dynamically loads `MessageList` only when the current thread has messages. The empty welcome/composer and task board must not eagerly load Markdown's diagram/math/syntax dependencies. Suspense occupies the same transcript container with a Chinese loading status. An E02 submitted attempt must remain visible through an eager lightweight row in both the workspace and this fallback; see [Agent Send Recovery](./agent-send-recovery.md). The provisional row does not import rich Markdown and joins its durable counterpart by canonical user ID. This boundary never remounts `AgentChatPage` or owns a run: generation continues while the transcript module loads. Once mounted, the existing scroll, ResizeObserver and memo contracts above remain unchanged.

The full vendor icon catalog is a separate lazy module behind `ModelIcons`; keep named re-exports in `ModelIconCatalog` so dynamic import does not retain every unrelated package export. The icon fallback reserves the requested dimensions and is decorative. Provider and model names remain visible while icons load.

E11's combined reader must preserve this lazy rich-transcript boundary and its
eager optimistic fallback. Isolate the complete execution-feedback subscription
with the transcript too: `outputRevision` changes are another streaming source,
even after message queries move below the page. Page/composer admission, Stop,
attempts and coarse feedback labels use semantic snapshots. Keep the original
per-invocation feedback controller and delayed DOM timing correlation; unread
acknowledgements do not replace E03 timing.

Measure renders at the actual app/page/workspace/composer/topic-list/topic-row
function boundaries while repeated public checkpoints and metrics still update
transcript text. React Profiler commits for a whole descendant subtree do not
prove that the named parent function re-rendered. Use fixture-only instrumentation
and keep counters out of the product API. Semantic transitions such as a new
owner, approval, unread boolean or completion can update their actual consumers;
unchanged output/internal revisions cannot invalidate all navigation rows.


## Execution and turn navigation

See [Agent Activity UI](./agent-activity-ui.md). Timers live in a small label component, never the list. Manual disclosure, required-action navigation and turn jumps pause automatic following. The rail derives active position inside its own component; it must not put per-scroll state into MessageList or remount message bodies. Keep batch review surfaces mounted while process content is hidden.

## E02 responsive conversation cascade (2026-10-09)

### 1. Scope / Trigger
Read before changing agentChat.css message/composer gutters, 767/768 breakpoint, safe area, expanded composer or turn rail.

### 2. Signatures / Owners
ChatWorkspace retains desktop inline variables `--agent-chat-safe-x`/`--agent-content-max` and measured `--agent-chat-composer-safe`. agentChat.css owns winning narrow overrides; MessageList scroll and TurnNavigation retain existing specialized rules.

### 3. Contracts
At width ≤767px, final computed message/dock horizontal padding is8px, `.agent-content` max-width none and horizontal margins0, dock bottom padding `max(12px, env(safe-area-inset-bottom, 0px))`. At768px and desktop preserve16px gutters/800px content maximum and16px dock bottom padding. Narrow rules must win against later same-specificity shorthand/base rules. Preserve header hamburger clearance44px, last-line composer/scroll clearance, the more-specific turn rail24px gutter, and expanded composer full-column padding0/max-width none.

### 4. Validation / Error Matrix
390/767 native zero-inset →8px/12px/no800px cap.768/desktop →16px/16px/800px cap. Narrow nonzero-inset surrogate32 →32px with actual max/cascade evaluated. Expanded mode → full column, underlying message surface inert. Long history → last paragraph above dock and no document horizontal overflow. Turn rail → dedicated24px gutter preserved.

### 5. Good / Base / Bad Cases
Good: winning responsive rules after the relevant base declarations, with specialized expanded/rail selectors preserved. Base: desktop variables remain unchanged. Bad: inspect an early media block without checking later shorthand/max-width declarations, or strengthen specificity globally and break expanded mode.

### 6. Tests Required
Actual ChatWorkspace computed styles/geometry at390/767/768/1440, final message scrolling, expanded composer, turn rail and screenshots. Baseline source counterfactual reproduces overwritten narrow styles. This installed Chromium exposes native safe-area bottom0 and does not support CDP setSafeAreaInsets; label32px env-to-custom-property testing as a CSS surrogate, never real iOS/device evidence.

### 7. Wrong vs Correct
Wrong: assume an early media query wins because viewport matches. Correct: assert final computed properties after the whole cascade, including shorthand, inline variables and specialized selectors.


## E06 demand icon loading and measured root contracts

Independent review accepted on 2026-10-09.

### Scope / Trigger

Apply when changing agent model/provider icons, rich-transcript loading or measuring actual root loading. Empty welcome/composer and current lazy transcript/run owners remain unchanged.

### Signatures / Owners

ModelIcons retains publisher props and dimensioned decorative Suspense. DemandModelIcons owns matching and dispatch; generated mapping data owns ordered keywords/props and literal brand loaders; e06-icon-data owns deterministic publisher AST extraction and upgrade checks.

### Contracts / Invariants

Preserve complete first-match regex/exact-provider order, mapped→caller precedence, size12/avatar defaults, original distinct fallback components, compound variant precedence and exact lobehub/forceMono behavior. Cache one lazy component per current brand. Use actual publisher compounds and avoid vendor patching or renderer clones.

### Validation / Error Matrix

Verify defaults/unknowns/mixed case/overlap/all types/caller size-shape-style-color-title, non-SVG brands, delayed decorative dimensions and retained composer/run ownership. Rich cases preserve clipboard, unknown fences, links/table/math/diagram/reasoning and manual/pinned stream following.

### Good / Base / Bad Cases

Good: complete data-only matching plus matched brand modules, verified on actual root. Base: rich library/highlighter cost remains explicitly measured. Bad: infer load from a dynamic declaration, narrow matching to popular brands, add overlapping scenario totals, or infer latency from bytes.

### Tests Required

Generator --check/data-order tests, application/fixture typing, full publisher identity and native render parity, four cold actual-root body/graph/union measurements, and bounded fresh native critical cases. Freeze producer/source/physical module/asset/body inputs; preserve failures and route/scanner qualifications.

### Migration / Limits

Publisher upgrades require version/renderer/AST-generation/subpath review and native parity. Decoded body/gzip/wire/timing scopes differ; initial scanner conditions and effective generated route bytes must be explicit. The 2,896,549-byte picker reduction does not prove rich-history or latency optimization. Temporary typed diagnostics are not formal debt acceptance.
