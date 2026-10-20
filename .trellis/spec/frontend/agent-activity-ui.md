# Agent execution transcript and conversation navigation

## 1. Scope / Trigger
Read before editing execution chronology, thinking/tool disclosure, composer action reminders or the turn navigation rail. These are presentation contracts; repository permissions, explicit paid confirmation and ambiguous-result recovery remain governed by agent-execution and agent-batch-generation.

Topic read identities, current-thread departure and the local return-to-latest action follow [Agent topic reading](./agent-thread-reading.md). Rail/activity navigation pauses following without changing runtime ownership.

## 2. Signatures
- `AgentRun.activitySteps?: AgentActivityStep[]`, where a step contains `step`, `content`, optional public `reasoning` and `reasoningDurationMs`.
- `saveToolRound(..., responseOutput?, publicOutput?)` stores the public snapshot in the same transaction as the tool ledger and continuation envelope.
- `buildRunActivity(run, calls)` returns chronological text/reasoning/tool groups; `isPersistedToolRound` distinguishes a retained tool-round message from a new model answer.
- `getRunElapsedMs(run, now?)` and `formatRunElapsed(ms)` remain pure helpers in `runPresentation.ts`; the transcript no longer shows a ticking elapsed label (2026-10-13).
- `useAgentActivityNavigation()` exposes `request` and `reveal({runId, callId?, batchId?})`. The provider scopes requests to the current thread without remounting the execution owner.
- `selectActivityAttention(input)` derives owned required actions from current-thread runs, calls, batches, items, jobs, tasks and messages.
- `buildChatTurns(messages)`, `turnExcerpt(text, limit?)`, `getActiveTurnIndex(offsets, readingPosition)` are pure helpers for the conversation rail.

## 3. Contracts
Follow [Interaction Feedback](./interaction-feedback.md) and [Agent Execution Feedback](./agent-execution-feedback.md) for meaningful existing-composer phase feedback and immediate Stop acknowledgement. Internal phases do not imply extra visible labels; keep normal user bubbles and advancing replies quiet.
Only public text belongs in the transcript. Never render encrypted Responses reasoning, raw request history or private provider envelopes as model thinking. Legacy rounds are recovered from the current continuation suffix and matched to the current run's tool identities. Missing historical reasoning cannot be reconstructed. A successful final answer stays visible even if it repeats a previous round's wording.

During execution, narrative, reasoning and tool-call rows are chronological. Completion/stop/failure transitions close the outer process once; a run that is `running` or `waiting_approval` opens it, and subsequent manual toggles survive live-query updates. Failure and pending approval must never disable folding, but a pending approval's buttons sit outside its call's collapsible panel so folding the row cannot hide the decision. The original permission and recovery controls remain inside the process.

Historical rich process content can defer mounting until first expansion. Batch results remain mounted under the hidden process so local edits and navigation blockers survive folding. A reveal opens the matching process/group/call or existing batch dialog; it never approves or sends a request. Expanded composer mode retains the status strip and exits when a process reveal arrives.

Reminders query the current thread independently of the latest model status. Draft generation batches remain visible after the model completes. Unknown results remain inspectable even when execution cannot resume. Approval/resume targets must be the latest eligible run, with no later user message and an open task/project. Task review opens the existing inspector. Multiple required actions remain individually accessible in a bounded list.

A user message anchors each navigation turn; later assistant attempts update that turn's preview. Previews are short plain text, not another Markdown renderer. Show the rail from five turns onward. Its internal viewport exposes at most ten ticks, with remaining turns reachable by rail scrolling. Resting lines are short; mouse-hovered neighbors grow in a distance-based wave; active state changes color only, all resting lines share the same short length and left edge and honor reduced-motion preferences. The rail owns its active/hover state so scrolling does not repaint all chat bodies. Hover and keyboard focus reveal previews; click/Enter changes only the transcript scroll position and pauses automatic following. Current turn comes from real message positions, including expanded-process height changes. Preserve the lazy MessageList import boundary.

## 4. Validation & Error Matrix
| Situation | Required behavior |
| --- | --- |
| Failed/awaiting tool | Outer process, group and tool row remain manually collapsible |
| Model completes with unconfirmed batch | Final answer visible, process collapsed, composer reminder persists |
| New DB tick after manual expansion | Do not force open/closed again |
| Running | Static "进行中" in the summary row; no per-second timer |
| Legacy continuation contains previous turns | Exclude the base envelope and validate owned tool identity |
| Batch has unsaved draft during fold | Keep component/state and leave protection mounted |
| Composer expanded then reminder clicked | Retain reminder; expose target without hidden/inert focus |
| Read failure | Show an explicit reminder-read error; do not silently imply no action |
| User jumps to an old round | Pause automatic following; never scroll the page or sidebar |
| Narrow viewport / long history | Bounded rail and preview; no page overflow; keyboard/touch targets remain usable |

## 5. Good / Base / Bad Cases
Good: a completed assistant answer has a compact elapsed disclosure and a visible batch-confirmation reminder; the user can open the batch directly, close it, and freely inspect the earlier process.

Base: a text-only run still shows its elapsed time and keeps final text readable. Old sessions without step snapshots recover available tool-round prose.

Bad: `expanded || needsAttention`, disabling the disclosure button, using every assistant request message as history, or hiding the reminder once `run.status === 'completed'`.

## 6. Tests Required
- `runPresentation.test.ts`: chronological merging, legacy ownership/history exclusion, final/tool round distinction and invalid timestamps.
- `agentActivityPersistence.test.ts`: Chat and Responses runtime snapshots and transaction safety, with opaque reasoning kept out of the public snapshot.
- `agentActivityAttention.test.ts`: completed-run batch draft, unknown/paused work, multiple priorities, stale/foreign/closed ownership.
- `toolValidationDiagnostics.test.ts` and `toolValidationSafety.test.ts`: screenshot limit/path errors, safe bounded diagnostics, both protocols receiving correction advice and invoking a new valid read, valid high-risk calls still requiring approval.
- `chatTurns.test.ts`: per-user grouping, retries, missing text, bounded Unicode excerpts and active reading offsets.
- Isolated browser evidence: repeated nested collapse, live/frozen timing, completion auto-close, batch shortcut + unsaved draft protection, expanded-editor reveal, multi-turn hover/focus/jump, preserved reading position and 390px layout.

## 7. Wrong vs Correct
Wrong: `const open = expanded || needsAttention`, or unmounting `AgentGenerationResults` with `{open && ...}`.

Correct: change disclosure state on an execution transition or explicit reveal/user action; keep batch review state mounted and surface required work in the composer independently.

## Tool validation diagnostics

Schema rejection is a pre-execution failure, not a successful read and not ambiguous paid submission. Preserve structured bounded field errors in the tool result sent to the model. For `business_read_text`, one request reads at most 12000 characters and episode scripts use `story.script`; pagination follows `nextOffset`. Never silently clamp requested input or rewrite the immutable call. Explain whether correction/new invocation is needed and that a final answer must disclose relevant missing evidence. The UI must not infer semantic recovery merely because another call succeeded later; the failure stays on its own call row with its reason visible without expanding. Validation failures the model can self-correct render as a muted single line (`data-kind="validation"`), reserved red is for real execution failures.

A failed parse must not label a local read as high-risk solely because argument parsing failed. Existing generic argument failures may display explicitly labelled diagnostics recomputed with current local schemas; do not rewrite historical records or fabricate what the old model received.

`CreatedEntityLinks` is a standalone lightweight component shared with TaskRecords. Do not import it from AgentRunDetails: that would eagerly pull process Markdown into the Agent route and bypass the MessageList lazy boundary.

## Composer footer occlusion

The bottom composer dock owns both the input card and its control footer. Its background-only `::before` mask reaches above the dock farther than the header mask and applies backdrop blur, so scrolled transcript text cannot remain legible behind the footer. Dock content stays in a higher stacking layer and remains interactive. Full-screen composer mode disables this pseudo-element so editing is not blurred.

## Execution ending is not business completion

No run verdict, completion label or claim review is shown. `describeRunExecution`, its execution-record popover, the "含 N 项失败" count and the read-only final-reply claim check were removed (2026-10-13); the single closed-state affordance is the summary row "用了 N 个工具" (bookkeeping calls such as plan updates and tool loading do not count; "过程记录" when only reasoning/plan/narrative exist; hidden for a plain reply with no process). No prose or error-message keyword detection decides whether the requested job is complete. `completed` network calls may return pending or failed jobs, so the UI must never imply saved assets or acoustic acceptance beyond what a write receipt shows.

Tests: `audioAgentExecution.test.ts` exercises both protocols with promise-only replies, loader-only completion, failed reads and real progression, asserting ledger rows and `run.modelStep` directly.

## Quiet transcript (2026-10-13)

### 1. Scope / Trigger
Read before changing what a finished or running assistant turn shows, the tool-call timeline, approval placement or the composer attention card. Principle: success is quiet; only states that need the user speak; one event appears fully in one place.

### 2. Signatures / Owners
`MessageList.tsx` draws messages (`agent-user-bubble` for users; assistant text has no bubble/avatar/title/time) and exports `presentMessageStatus` for the single status line. `AgentRunDetails.tsx` owns the summary row, timeline, `callObject(call)` (object after the verb from `(generationOverride?.preview ?? preview).target?.label`, else `preview.summary`, truncated to 40 characters, omitted when it repeats or is contained in the title), `TechnicalDetails` (quiet collapsed "参数与返回结果") and `opensProcess(status)`. `AgentWriteOutcomes` keeps the "本次已保存" row. `CreatedEntityLinks` takes an optional `collapseDetails`.

### 3. Contracts
- Default finished turn: body, quiet actions (copy; regenerate when retryable), optional "本次已保存：…" row (only when at least one valid receipt exists, entries link to records), and one summary row. Model, speed, tokens and time are hover/focus-only.
- Status line only for `error` (the error text, red), `aborted` ("已停止") and `interrupted` (notice, or "执行已暂停"/"生成中断"). No body placeholder "（已停止）".
- Timeline: one row per call (icon + verb [+ muted object]); success shows an icon only; consecutive `completed` calls of the same tool merge into "title · N 项" (`project_create` never merges). A failed call shows its reason on the row. Detail lives in an indented panel with a left guide line; parameters/results are the last, collapsed row. No horizontal rule under the summary, no underline, no hover background; hover only darkens text and reveals chevrons (always visible on touch/reduced motion; focus ring kept).
- Entity links: the preview target is the only default-visible link; other per-entity links collapse behind an "N 项明细" row when `collapseDetails` is set (task records keep the flat list).
- Approval: a pending call stays expanded with 批准/拒绝 beside it, outside the collapsible panel. Generation and music review and batch dialogs keep their own confirmation and stay mounted. The composer attention card only points ("待批准 · 查看") and calls `reveal`; it never carries a second approve/reject pair. Other cards keep their actionable buttons.
- The composer status strip shows only the running state (with 停止). Interrupted/failed/waiting-approval are carried by the card and the message status line.
- Plan: one place, a collapsed "执行计划 · n/m"; state text only for in-progress and pending steps.

### 4. Validation & Error Matrix
| Situation | Required behavior |
| --- | --- |
| Plain reply, no tools/reasoning/plan | No summary row |
| Only reasoning/plan/narrative | Summary row "过程记录" |
| Write calls without receipts | No saved row, no disclaimer |
| Failed call | Reason visible on the row, not in the header |
| Validation failure | Muted single line, still visible |
| Waiting approval | Process open; buttons visible when the row is folded |
| Interrupted/failed run with tools | Card + status line carry resume/end; no strip text |
| Several entities created | One preview link + collapsed "N 项明细" |

### 5. Good / Base / Bad Cases
Good: a successful write turn reads as body + "本次已保存：镜头 3 项" + "用了 2 个工具". Base: a plain chat reply is just text and actions. Bad: a header label such as "工具调用已结束", a disclaimer that the turn "does not prove completion", per-entity link walls, or a second approve button on the composer card.

### 6. Tests Required
`agentMessagePresentation.test.ts` (quiet defaults, absent removed copy, single error/stop line, hover-only metadata), `agentToolTimeline.test.ts` (one line per call, merging, failure reason, auto-open approval and `onAction`, card points without buttons, review components stay mounted, object dedupe/truncation, `aria-expanded`), `createdEntityLinksCollapse.test.ts` (collapse, single link, default flat behavior). Visuals (indent, guide line, hover, chevrons, 760px) need real-window acceptance.

### 7. Wrong vs Correct
Wrong: surface every state as text in the header, strip, card and footer; put approve buttons only inside a folded panel or twice. Correct: one full statement per event; approval beside its call; the card only reveals it.

### Steered messages sit in the run's timeline (queue task)
A message steered into a running turn is delivered at a tool-round boundary and records `steeredAfterStep` (the model step the run had completed). It is not drawn as its own row after the answer: `buildRunActivity(run, calls, steered)` places it between step `steeredAfterStep` and the next, and `AgentRunDetails` draws it as an ordinary user bubble inside the timeline. A collapsed (finished) run still lists what the user said, once, above the collapsed panel. There is no "steered" badge. A steered row whose run is not loaded stays a normal bubble, so it never disappears. Steered rows are excluded from turn navigation and the last-turn retry anchor, since they are not turns of their own.
