# Research: reference-ux-patterns

- **Query**: UI/UX conventions of deepseek-harness (DSH), Cursor and OpenAI Codex to guide cleanup of an agent-chat + creative-studio desktop app (conversation-list leading marker, running indicator, status wording, error placement, empty states, text volume, approval wording).
- **Scope**: mixed (internal read-only of `/Users/xiaomengdao/WebstormProjects/deepseek-harness`; external web)
- **Date**: 2026-10-16

Legend: **[code]** = read directly from DSH source; **[doc]** = stated in an official/primary document; **[forum-staff]** = stated by Cursor staff on forum.cursor.com or release notes; **[community]** = third-party/issue text; **[inference]** = my deduction, not stated by a source.

DSH paths below are relative to `deepseek-harness/packages/client/`.

---

## 1. DSH (deepseek-harness) findings

Note: `apps/web/src` is only a bootstrap (`main.ts`, `preview.ts`); the UI lives in `packages/client/ui-*`. Styling rules: `docs/web-styling.md`.

### 1.1 Conversation (session) list row

| Aspect | Finding | Source |
|---|---|---|
| Row geometry | One top-level session row is 32px: a leading 16px cell (status dot, or an occupant), a 4px gap, title, then trailing cell (relative time; swaps to hover action buttons). | `ui-workspace/src/client/rows/Rows.tsx:526-531, 586`; `Rows.module.css` `.rowActions`, `.sessionRow:hover .time` (~l.251-300) |
| Leading marker | The leading cell holds the **status dot** only. A plugin "leading seat" (`sidebar.session.row.leading`, e.g. schedule clock) renders **only when the primary status is idle**, never beside a status dot. | `ui-workspace/README.md:66, 70, 94` |
| Status model | Closed set `done | warning | ongoing | error | idle`. Colors: green done / amber needs-user / tertiary-grey loading / red error / neutral-grey idle. | `ui-primitives/src/StateDot.tsx:5-9` |
| Dot size | Solid dots: 10px slot with 6px core (`inset:20%`); ongoing loader 14px. | `StateDot.tsx:50`; `StateDot.module.css:1-15` |
| Precedence | pending interaction (warning) > running (ongoing) > running subagents > completed-unviewed (done) > idle. | `Rows.tsx:345-398` |
| Idle | **Dot-free in the row**; idle dot only appears in hover card. | `ui-workspace/README.md:66` |
| Archived | Cell blank; title drops to caption color; live status on hover card only. | `README.md:66`; `Rows.module.css:~239-249` |
| Trailing cell | Relative time (`now`, `5min`, `2h`, `3d`, `1mo`, `1y`); while pending interaction it is replaced by a compact word: **Approval / Plan review / Answer**. On hover it swaps to icon-only actions (pin/archive). | `ui-workspace/src/client/locales.ts:233-262`; `Rows.module.css` (`.sessionRow:hover .time {display:none}`) |
| Title overflow | Ellipsis at rest; hover scrolls to far end (marquee). | `README.md:~62` (paragraph after archive description) |
| Hover detail | Hover card carries full status labels + time; each status = `StateDot` + text. | `Rows.tsx:424-447` |
| Visibility cap | Only first 5 non-blank sessions per workspace; watermark extends to cover last running / awaiting-user / unread-completion / open session; "Show more" +5. | `ui-workspace/README.md:30` |
| Unread | "Unread" = completion time > last-seen, **local viewing state only**, rendered as `done` (green) dot. | `ui-sidebar/README.md` Known Limitations; `ui-workspace/README.md:66` |

### 1.2 Running animation

- `ongoing` is the **only non-dot** state: SVG ring (track at 25% opacity) + a "breathing" arc (dasharray 12→24→12) with the whole glyph rotating; both on a shared **1.5s** period. `StateDot.module.css:34-83`.
- All loaders are pinned to document time 0 (`animation.startTime = 0`) so multiple spinners stay in phase. `StateDot.tsx:11-34`.
- Reduced motion: both animations off; arc becomes static (`18 150`, offset -3). `StateDot.module.css:85-95`.
- Color is `--dsw-alias-label-tertiary` (grey, not accent). `StateDot.module.css:37-40`.
- **No dot-matrix animation exists in DSH** (searched `dot-matrix|dotmatrix|matrix`: none in ui-workspace/ui-primitives). Text-level running uses `TextShimmer` (left-to-right highlight sweep) on group titles, reasoning previews, tool rows, retry line, bottom running status. `ui-chat/README.md:112`.

### 1.3 Status wording (en)

`ui-workspace/src/client/locales.ts:233-243`:
`Running` · `{n} subagent(s) running` · `Idle` · `Waiting for approval` · `Plan awaiting review` · `Waiting for answer` · compact `Approval` / `Plan review` / `Answer` · `Completed`.
Pattern: 1-3 words; long form in hover/aria, compact noun form in the trailing cell. Each status also emits a visually-hidden text label for screen readers (`Rows.tsx:400-410`).

### 1.4 Turn status / error presentation

- Every terminal turn failure renders an **inline row with red dot** in the transcript (not a modal). `ui-chat/README.md:60`.
- Output-token-limit uses **amber** dot (warning, not error). `ui-chat/README.md:60`; copy `Output token limit reached` (`ui-chat/src/client/locale.ts` ~l.372).
- Generic copy: `This turn failed`, `Task stopped`. Specific failures are short single sentences: `API key is invalid` · `Request quota exhausted.` · `Stopped because you signed out of DeepSeek.` · `Sign in to DeepSeek and ensure the request destination supports account authentication.` (`locale.ts:358-372`). The one long message is the process-crash `interrupted` text (~230 chars) (`locale.ts:368`), rendered with no code chip and summary "Stopped".
- Quota: persistent inline row (neutral copy, not raw provider message) **plus** a transient warning `Toast` from a frame-wide overlay entry (top-center, held `holdMs`); newer notice replaces older; notice never replays history; persistent row is the source of truth. `ui-chat/README.md:60`; `ui-primitives/README.md:64` (`Toast`: "Transient top-center banner held for the owner's holdMs").
- Retry is shown **inline in the transcript** as a shimmering line: `Retrying model request`, `Waiting to retry model request`, `{label} ({retry}/{max}) · {seconds}s`, `Model request retry cancelled`; intermediate retries do not produce a terminal row. `locale.ts:358-364`; `ui-chat/README.md:60, 112`.
- Failed command/tool rows keep their normal glyph; failure expressed via row state + summary + semantic text color (error/warning text keeps semantic color, others tertiary). `ui-chat/README.md:60, 124`.
- Sidebar: archive/fork failure feedback is a single frame-wide workspace notice (only latest visible) with undo/retry actions. `ui-workspace/README.md:~58, ~62`.

### 1.5 Empty states

- Session list: centered glyph-over-text placeholder; copy `No sessions yet` / `No archived sessions yet` / `No matches`; only the archived view adds a text action `View other sessions`. `ui-workspace/src/client/locales.ts:162-165`; `README.md:~58`.
- No explanatory paragraphs; one line + at most one action.

### 1.6 Approval prompt

- Composer **takeover** (replaces input area): title `Waiting for approval`, line `Tool {toolName} requests privileged execution`, buttons `Reject` / `Allow once`; Enter = allow once, Esc = reject (ignored while IME composing or focus in input); `aria-busy` after answering; re-enabled if answer promise rejects. Tool-owned detail rendered via slot `conversation.approval.detail`. `ui-approval/src/client/locales.ts:17-21`; `ApprovalPanel.tsx:1-60`.
- Same state echoes in sidebar as amber dot + `Approval`.

### 1.7 Copy-length / style norms in DSH

- Labels: sentence case, no trailing period for status; periods appear on full-sentence failures.
- Hover-only controls, hairline 0.5px borders, tooltips with shortcut keycaps (`docs/web-styling.md`; `ui-sidebar/README.md`).
- Reduced-motion + focus visibility mandated for every transition (`docs/web-styling.md` "Component rules").

---

## 2. Cursor (external)

| # | Point | Type | URL |
|---|---|---|---|
| C1 | Agents sidebar rows: **spinner** = agent working; **orange/amber dot** = waiting for you (asked a question or plan ready); **blue dot** = work done but not opened yet. | forum-staff (Cursor team reply) | https://forum.cursor.com/t/agent-tags-t-indicate-agent-state-beyond-simply-stating-where-its-working-or-not/163927 |
| C2 | Full vocabulary as seen by users: spinner/animated matrix = running; amber = blocked for input/approval/tool confirm; blue = finished, unread; gray = finished & viewed. The "animated matrix" name is the requester's wording. | community (feature request) + staff confirmation of pieces | https://forum.cursor.com/t/show-error-warning-indicator-on-session-in-left-sidebar-when-agent-stops-due-to-an-error/173958 |
| C3 | **Red dot** on sidebar row exists for cloud agents ending in error; **local agents that stop on error show as "finished"** (gap acknowledged). Filtering/grouping by status (`Customize > Show > Status > Error`, `Group by Status`). | forum-staff | same as C2 |
| C4 | "Group by Status" yields a **Needs Attention** section listing every blocked agent/subagent across workspaces; system notifications + completion sound toggles in Settings > General. Blocked subagent shows only "Waiting for subagent". | forum-staff | https://forum.cursor.com/t/notification-missing-for-action-needed-in-subagent-s/170906 |
| C5 | Unread agents drive Dock/menu-bar badge; unread agents take the first menu slots with an "N more unread" entry; a Project row shows the unread dot even while child agents are still working; badge counts only what the sidebar shows. User can mark agents unread. | doc (release notes) | https://cursor.com/docs/release-notes |
| C6 | Cloud-agent errors show **in a tray above the input** (also while auto-retrying or after session expiry); the error offers **a single next step** where applicable: `Retry`, `Manage Usage`, `Manage Environments`. | doc (release notes) | https://cursor.com/docs/release-notes |
| C7 | A prompt that fails to start a cloud agent **comes back into the composer** so the user can retry (no lost draft). Create-project failure dialog shows the actual reason instead of a generic retry message; plan-blocked failure adds an `Upgrade` button on the notification. | doc (release notes) | https://cursor.com/docs/release-notes |
| C8 | Failure copy style: single sentence naming cause + action, e.g. "Cloud Agent could not get a worker to start your session; please retry in a few minutes." Run history says whether to retry or contact admin. Media load failures offer `Retry`. | doc (release notes) | https://cursor.com/docs/release-notes |
| C9 | Cloud subagents waiting on user: Agents pill shows a **yellow status dot** and the tray row is marked "needing attention"; a stopped subagent must NOT show as needing attention. Waiting for MCP sign-in shows "Needs Attention" until Skip/Authenticate. | doc (release notes) | https://cursor.com/docs/release-notes |
| C10 | Agents Window overview (multi-workspace, parallel agents) | doc | https://cursor.com/docs/agent/agents-window |

Inference (not stated): Cursor keeps the row title as the only text and puts state in a small leading glyph; sidebar can be grouped by status instead of adding badges/text.

## 3. OpenAI Codex (external)

| # | Point | Type | URL |
|---|---|---|---|
| X1 | Desktop **Activity view** (bell in sidebar; Cmd+Option+U / Ctrl+Alt+U) lists chats that are **unread, running, or waiting for your response**; filters Work/Chat/Pinned/Scheduled; `Mark all as read`. | doc mirror (docs summarising ChatGPT/Codex app; verify against developers.openai.com) | https://www.codex-docs.com/en/docs/notifications ; https://codexhandbook.com/en/guide/desktop-app/notifications/ |
| X2 | Notifications are configured separately for turn-completion (never / background only / always), permission requests, and questions. | doc mirror | same as X1 |
| X3 | Floating "pet" status vocabulary: **Running, Needs input, Ready, Blocked**. | doc mirror | https://www.codex-docs.com/en/docs/notifications |
| X4 | Handbook triage order: awaiting permission/input → failed → completed awaiting review → still running. | community handbook (recommendation) | https://codexhandbook.com/en/guide/desktop-app/notifications/ |
| X5 | Desktop sidebar already shows a **green status indicator** on recently finished chats; users request "needs attention first" sort/section; unread tasks are auto-prioritised within a project with no visible filter. | community issues | https://github.com/openai/codex/issues/20817 ; https://codexissues.com/issue/33123-add-an-unread-only-sidebar-filter-with-a-keyboard-shortcut |
| X6 | Thread-level unread dot cannot tell which turns need review; asks that failed/interrupted turns keep their actual status separate from completed-unreviewed; window focus must not count as "reviewed". | community issue | https://github.com/openai/codex/issues/43065 |
| X7 | CLI/TUI loading+error: status header `Reconnecting... n/5 (42s • esc to interrupt)` with the upstream error beneath as detail line; after exhaustion a warning "Falling back from WebSockets to HTTPS transport." then `Turn failed`. Retry progress is shown as counter + elapsed, with interrupt hint. | source code + issues | https://github.com/openai/codex/blob/main/codex-rs/core/src/responses_retry.rs ; https://github.com/openai/codex/pull/8307 ; https://github.com/openai/codex/issues/30933 |
| X8 | Reported UX gap: long reconnect loop leaves user unsure whether to wait/interrupt/retry; wants a clear terminal state ("turn failed and no work is continuing"). | community issue | https://github.com/openai/codex/issues/30933 |
| X9 | IDE extension has no separate notification settings; CLI uses `notify` config. Surface-specific behaviour. | doc mirror | https://www.codex-docs.com/en/docs/notifications |

Caveat: X1-X4 come from third-party mirrors of the docs; official page on developers.openai.com was not fetched.

---

## 4. Distilled adoptable rules

Each rule lists its basis.

**R1 Leading marker (one slot, one meaning).** A fixed ~16px leading cell on every conversation row holding exactly one status marker; any secondary decoration (schedule clock, pin) only appears when the marker is idle/blank. Basis: DSH [code] `README.md:66,70`; Cursor C1 [forum-staff].

**R2 Marker vocabulary (5 states, color-coded, shape-light).**
`running` = animated glyph (grey) · `needs you` = amber dot · `unread/done` = blue (Cursor) or green (DSH/Codex) dot · `error` = red dot · `idle/read` = **no marker** (DSH) or grey (Cursor). Pick one of blue/green for "finished unread" and keep it consistent. Basis: DSH `StateDot.tsx:5-9`; Cursor C1/C2; Codex X5.

**R3 Precedence.** needs-you > running > error-unseen > done-unread > idle. Needs-you must beat the running spinner. Basis: DSH `Rows.tsx:345-398`; Cursor C9 (stopped subagent must not look "needing attention"). Error is not in DSH's precedence list; placing it above done is **[inference]** from Cursor C3 gap and Codex X6.

**R4 Error must be its own sidebar state.** Do not collapse errored runs into "finished/unread". Show red dot until viewed; hover shows 1-line reason. Basis: Cursor C3 (gap acknowledged), Codex X6 [community]; DSH has `error` state in the enum but no list-row mapping `Rows.tsx:345-398` (error is only inline in transcript).

**R5 Running animation.** Small (~14px), grey/tertiary, ≈1.5s period, ring + rotating/breathing arc **or** a dot-matrix (3×3) pulse; sync all instances to a shared clock (`animation.startTime = 0` trick); `prefers-reduced-motion` → static glyph. For in-transcript running text use a left-to-right text shimmer rather than extra spinners. Basis: DSH [code] `StateDot.module.css:34-95`, `ui-chat/README.md:112`; Cursor describes "spinner / animated matrix" [community C2]. A dot-matrix variant is a style choice [inference]; no reference product source documents its exact geometry.

**R6 Status vocabulary (short, noun-ish, 1-3 words).** Long: `Running`, `Waiting for approval`, `Plan awaiting review`, `Waiting for answer`, `Completed`, `Idle`, `Failed`/`Stopped`. Compact trailing: `Approval`, `Plan review`, `Answer`. Long form → tooltip/aria; compact form replaces the timestamp in the row. Codex pet adds `Needs input / Ready / Blocked` (X3). Basis: DSH [code] `locales.ts:233-243`; Codex X3.

**R7 Trailing cell.** Relative time by default (`now`, `5min`, `2h`, `3d`); swap to action icons on hover; swap to compact status word when user action is pending. Basis: DSH [code].

**R8 Error placement hierarchy.**
1. Turn/run failure → **inline row in the transcript** with a red dot and a one-line cause; persistent (DSH `ui-chat/README.md:60`).
2. Needs-retry on send/start failure → keep the user's draft in the composer and show the error in a **tray directly above the input** with one primary action (`Retry` / `Manage …` / `Upgrade`) (Cursor C6, C7).
3. Transient/out-of-view events (quota, archive done, fork failed) → single **top-center toast**, latest-wins, never the only record (DSH `ui-chat/README.md:60`, `ui-primitives/README.md:64`).
4. Auto-retry → inline shimmer line `Retrying…` with counter/elapsed (DSH `locale.ts:358-364`; Codex X7); end in a explicit terminal state (Codex X8 complaint).
5. Blocking modal/banner: not used by any reference for run errors; reserve for auth/account-level states ([inference]).

**R9 Error copy.** One sentence: cause + (if useful) next step; no raw provider payloads in the primary line (show as expandable detail, Codex PR #8307 puts upstream error on a detail line); neutral wording for quota/auth (`API key is invalid`, `Request quota exhausted.`). Keep ≤ ~80 chars for the primary line; the only DSH message over that (`interrupted`, ~230 chars) is the exception. Offer at most one action button. Basis: DSH `locale.ts:358-372`; Cursor C6-C8.

**R10 Empty states.** Glyph + one line (`No sessions yet`, `No matches`); add one text action only when a different filter would show content (`View other sessions`). No explanatory paragraph. Basis: DSH `locales.ts:162-165`, `README.md:~58`.

**R11 Approval prompt.** Takeover of composer area; heading `Waiting for approval` + one sentence naming the tool/action + two buttons `Reject` / `Allow once` (negative left, primary right); keyboard Enter/Esc; tool-specific detail below via slot; busy state after click and recover on failure. Sidebar echo: amber dot + `Approval`. Basis: DSH `ui-approval/src/client/locales.ts:17-21`, `ApprovalPanel.tsx:1-60`; Cursor C1 (amber).

**R12 Amount of explanatory text.** In all three references, state is conveyed by glyph + color + ≤3-word label; sentences appear only for failures and approvals, and long form moves to hover/aria. Basis: DSH [code] (all of the above); Cursor C1/C4; Codex X3. "Less text in list rows" as a general principle is **[inference]**.

**R13 Attention aggregation.** Offer a "needs attention" grouping/filter (Cursor "Group by Status → Needs Attention"; Codex Activity view) and an unread count on app icon; count must equal what the list shows. Basis: Cursor C4, C5; Codex X1.

**R14 Unread semantics.** Opening the thread (not merely window focus) clears unread; user can mark unread; project/parent rows show the dot even when children still run. Basis: Cursor C5; Codex X6 [community].

**R15 Accessibility.** Every dot is aria-hidden with an adjacent visually-hidden text label; reduced-motion support; focus-visible. Basis: DSH `StateDot.tsx:42`, `Rows.tsx:400-410`, `docs/web-styling.md`.

---

## Related Specs (aifenjing)

Not read in this pass (scope was reference products). Task PRD: `.trellis/tasks/10-16-ui-ux-overhaul/prd.md`.

## Caveats / Not Found

- No dot-matrix running animation in DSH; Cursor "animated matrix" wording comes from a user feature request, not official docs. Cursor's official docs page `agents-window` returned only overview text in search; status-indicator semantics rely on Cursor staff forum replies.
- DSH has no list-row mapping for `error`; errors only inline in transcript.
- Codex status/Activity details come from third-party doc mirrors and GitHub issues; official developers.openai.com pages not fetched. Codex app sidebar's exact unread/running glyph shapes are not documented in what I found.
- Line numbers for `ui-workspace/README.md` ~58/62 and `Rows.module.css` ~239-300 are approximate (long paragraph lines); other cites exact.
- Not searched: DSH `apps/desktop` renderer and `docs` UX notes beyond `web-styling.md`; no i18n yaml reviewed besides `locales.ts` files.
