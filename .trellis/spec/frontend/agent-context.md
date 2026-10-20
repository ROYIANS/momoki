# Conversation context selection and compaction

## 1. Scope / Trigger
Read before changing composer parameters, history selection, token budgeting, summaries,
run retry/recovery, or model continuation. This is working conversation context, not
Trellis task retrospectives or verified cross-task memory. IndexedDB v11 adds
`contextCompactions` with `id, threadId, runId, status, createdAt` indexes.

## 2. Signatures
- `@momoki/agent-core` owns `ContextPolicy`, `DEFAULT_CONTEXT_POLICY`, `normalizeContextPolicy(value?)`, `estimateTokens(text)` and `budgetEnvelope(messages, tools, capacity?, hasSummary?, extraTokens?)`; Studio keeps its concrete source/materialization projections.
- `updateContextPolicy(threadId | undefined, policy)` — thread or new-thread defaults.
- `resetThreadContextPolicy(threadId)` / `saveContextPolicyAsDefault(threadId)`.
- `selectContextHistory(messages, policy): ContextSource[]`.
- `findApplicableSummary(history, versions): ContextCompaction | undefined`.
- `buildContextMessages(instructions, skills, history, draft, summary?)`.
- `budgetContext(messages, tools, capacity?, hasSummary?, extraTokens?)`.
- `prepareRunContext(runId, tools, apiKey, signal, fetchImpl?, store?, resolveCredentials?): Promise<AgentRun>` binds the core `compactContext` / `CompactionHost` to the current ProductStore. Production execution supplies the request-time credential resolver for every summary dispatch.
- Core also owns `groupContextHistory`, `selectHistoryByCount`, `isContextSourcePrefix(prefix, history, sameMetadata)` and `replaceContinuationBase`; Studio's metadata comparator retains exact reference provenance, and base replacement retains the opaque suffix. See the [shared runtime](../agent-core/library/runtime.md) for neutral execution/compaction contracts.
- `beginAgentRun` accepts provider `modelMetadata?` and freezes effective context policy,
  capacity/source, exact source history, draft, active summary ID and base envelope.

## 3. Contracts
Defaults: auto compression enabled, history cap disabled, preset count 20. New threads
snapshot global defaults, including manually created tasks. Existing missing policies
resolve to constants, not future global edits. Counts are safe integers 0–10000; optional
local budget is 2048–10000000 tokens. Local budget may reduce a known capacity, never
inflate it. Unknown capacity remains unknown without an explicit local budget.

Select complete/legacy display messages first; group each user turn with its replies.
Cap counts display messages, rounds down at the oldest group boundary, excludes current
draft/system envelope/tools. Zero drops history AND summaries. Errors/partial replies
are excluded. Source originals are never edited. A reusable completed/activated summary
must cover an exact ordered prefix (ID, role AND content equality) of selected history.
Disabling auto compression uses raw selected history instead of saved summaries.

Capacity uses provider metadata, then the local model catalog (Models.dev), with explicit local ceiling.
Budget uses serialized messages/tool definitions plus opaque reasoning continuation;
apply 25% estimation drift. Reserve min(8192, max(256, floor(capacity × 15%))) output
and ceil(capacity × 5%) safety margin. Trigger at min(input budget, 50% capacity), or
65% with an active summary. This is a heuristic, not a tokenizer/billing guarantee.
Studio's `budgetContext` adds its existing 4096-token cost per reference image as
explicit extra cost to the neutral core budget. Product image/reference types and
model catalog resolution remain outside core; keep the same budget for preview,
main dispatch and compaction rather than copying its arithmetic per host.

Preflight before each model step under the existing thread Web Lock. All tool calls
must be settled. Compact only historical base messages. Preserve the current question,
system/task/skill instructions, entire live tool chain, and Responses reasoning items.
Validate exact base prefix before replacing either protocol envelope. Do not edit ledger
records. Large indivisible turns or protected tool chains block explicitly when unsafe.

Summary requests use current connector/model/protocol, no tools, own instructions, own
usage, and an output cap (up to 4096, within reserved output budget). Serialize prior
summary and new source prefix as user data. Summaries are injected as assistant data,
not elevated system instructions. Chunk at complete turn boundaries so the summarizer
request also fits. At most eight passes per preflight. Preserve recent turn where possible.
No automatic failed-request retry or protocol fallback. Main reply metrics exclude these
auxiliary requests. Enabling auto compression plus Send authorizes auxiliary model usage;
parameter UI discloses this cost.

Persist job before HTTP; atomically activate terminal, nonempty, shorter summary AND
new continuation in one transaction after checking run/thread/version ownership.
Never activate partial output. Stop marks interrupted; restart recovery under the lock
marks abandoned jobs interrupted without network. Explicit retry keeps frozen policy and
successful base checkpoint; tool runs use existing explicit resume without replaying tools.
Changed settings apply to new sends, not old retries. Thread deletion cascades jobs and
late writes cannot resurrect data. Jobs and source copies are outside project exports.

## 4. Validation / Error Matrix
| Condition | Behavior |
| --- | --- |
| Cap 0 / odd count | No history or summary / complete newest groups only |
| Edited or excluded coverage | Ignore stale summary, rebuild from eligible source |
| Unknown capacity, no local budget | Display unknown; no automatic compression |
| Compression disabled and over budget | Fail before HTTP; suggest change then new send |
| Summary failure, empty, truncated, larger | Preserve prior checkpoint; explicit retry |
| Storage failure during activation | Atomic rollback; original request survives |
| Stop or reload | Interrupted summary, no automatic resubmission |
| Pending/unknown tool result | Refuse compaction until resolved |
| Base/Responses prefix mismatch | Refuse activation; retain provider continuation |
| New model/new send | Resolve new capacity; source-valid factual summary may be reused |
| Retry after successful summary then failure | Reuse saved working base, do not pay for it again |

## 5. Good / Base / Bad
Good: compress older discussion, retain recent dialogue/current tools, continue, and
inspect both summary and source text in context details.
Base: short chat uses the shared planner without additional HTTP.
Bad: truncate display records, call old summaries long-term memory, infer 128K for an
unknown model, drop tool results/opaque state, or auto-retry after losing a response.

## 6. Tests Required
`tests/contextManagement.test.ts`: scopes/defaults; 0/odd/large limits; exact source
applicability; output reservation; real request ordering; separate metrics; multichunk
summaries; failure/abort/delete; activation rollback; reload and explicit retry; Responses
opaque/pair retention; recheck after actual tool execution without replay; unknown/disabled
capacity and oversized current input. Existing run ownership, approval and task tests apply.
Browser fixtures: home/detail persistence, desktop/narrow layout, keyboard and outside
close, stop during summary, explicit regenerate, summary/source inspection, reload no HTTP.

## 7. Wrong vs Correct
Wrong: rebuild Responses history from display text after compression.
Correct: replace only the verified base envelope and retain the exact provider suffix.

Wrong: reuse any last summary after narrowing history to 20 messages.
Correct: require its entire exact ordered coverage to be a prefix of the selected history.

Wrong: store new defaults only globally so old conversations change silently.
Correct: snapshot when creating a thread and use deterministic defaults for legacy records.

## Task work records
New task runs and ContextUsagePanel both use getTaskContext from features/agent/runtime/taskContext.ts.
It assembles current goal/acceptance/Todo and up to eight current record excerpts
(1,200 body characters each), plus task tool definitions. These count in the shared
request budget. Current running/continuing requests retain their frozen snapshots;
new records arrive as tool results. Record history is neither compression nor cross-task
long-term memory. See agent-tasks.md for provenance and paged-read contracts.

## Project facts
See [Project Context](./agent-project-context.md). Project snapshots share the initial
instruction envelope; settled continuations append only visible fact differences.
Compaction must validate the frozen project before every request and activation.

## Project reference integration

See [Project References](./agent-references.md) for shared source ownership,
request materialization, withdrawal, source evidence and ZIP lifecycle contracts.

## D04 coherent preview snapshot contract (2026-10-08)

### 1. Scope / Trigger

Maintain this contract when changing the chat context preview, usage ring/tooltip/panel, memory details or context-policy editor. Displayed facts must come from one coherent current scope; historical frozen requests and the next-send editable policy are different views. Execution request construction remains in its existing owners.

### 2. Signatures / Owners

- `features/agent/commands/agentContextPreview.ts` owns `ContextPreviewInput`, `contextPreviewIdentity(input)`, `contextPreviewTables()` and `readAgentContextPreview(input): Promise<ContextPreviewRead>`.
- Observed callers use `prepareAgentContextPreview(input)` before opening their readonly snapshot, then `readPreparedAgentContextPreview(input, prepared, tx)` with that exact prepared identity inside it. The convenience `readAgentContextPreview` owns preparation plus a new root read; do not call it from an existing observed StoreTx.
- The input contains thread/project/interaction mode, normalized draft, attachments, model/provider and model metadata. Its identity includes those exact request-relevant values; credentials and retained parent-query results are excluded.
- `ContextUsageTrigger` owns one `useContextUsage`/live subscription and one display assembly. Ring, tooltip, `ContextUsagePanel` and preview memory details consume that same result. The panel receives a snapshot rather than querying/planning independently.
- `ContextParameters` retains its own lightweight policy-source query and existing field-intent write/reset/default-copy APIs. `MemoryContextDetails` separately reads current management availability/exclusions, without recomputing preview selection/budget. `MemoryRunHistory` supplies the frozen saved selection and existing readOnly contract.

### 3. Contracts / Invariants

- Resolve model-catalog vision preparation outside the database transaction. Durable fact reading uses one outer read-only transaction over the explicit deduplicated preview table list, including every nested task/project/memory/reference/IP/audio reader store. Do not use `db.tables` or add out-of-transaction durable reads to the preview.
- Passing an existing readonly StoreTx to a helper that internally awaits catalogue initialization does not move that initialization outside the transaction. Prepare before registering/entering the actual observation callback; keep the prepared identity gate when thread/draft/model inputs change. A deferred catalogue import must not cause Dexie `PrematureCommitError` or a replacement workspace.
- Validate agent/thread/project existence and requested binding. Missing, unavailable/foreign scope and read failure return explicit discriminated states, never ready defaults or fake empty selections. Loaded empty history/memory/reference data is a legitimate ready result. Unknown capacity remains unknown.
- The subscription's ready/error/missing/empty result is usable only for the current complete identity. A result retained from a previous thread, project, provider/model, metadata, draft or attachments cannot expose its percentage, budget, coverage or enabled memory action in a new scope.
- Parent transcript/status queries keep their actual consumers. They are not preview snapshot inputs; temporarily retained or empty parent data cannot be treated as complete durable context.
- Reuse the existing task/project/memory/reference selection functions and budgets. Current draft estimation uses the normalized current draft, not a deferred draft labeled current. No global cache/store, duplicate planner or new execution request policy is introduced.
- The latest active/recoverable saved run retains the existing predicate and frozen request interpretation. Its saved context/ref/memory/capacity/project inputs remain frozen; absent saved fields remain absent rather than acquiring new live selections. Historical summaries use the saved run's threshold even if the current policy changes. Editable current policy affects the next send and does not rewrite this audit view.
- Policy editing waits for a matching loaded source and disables controls for loading/missing/error/mismatch. Each callback submits only its changed field, including explicit `undefined` to clear a local token limit. Reset/default-copy remain separate commands. A synchronous scope-bound lock rejects callbacks from an old thread; late success/error/finally publication belongs to the initiating live session.
- Memory management keys include thread, run/preview and selection project. Its current availability envelope is also scope-bound. Historical selection text remains frozen while current availability/readOnly controls writes. Exclusion changes still use the original guarded `setThreadMemoryExcluded` transaction; they do not mutate the frozen request.

### 4. Validation / Error Matrix

| Condition | Required behavior |
| --- | --- |
| Initial query or complete identity changes | Loading state; hide retained budget/coverage and disable memory actions |
| Missing agent/thread/project | Explicit missing state, no ready budget |
| Requested project differs from thread binding | Unavailable state; no foreign-project preview |
| Durable read/vision input failure | Explicit error, not default policy/empty successful budget |
| Ready snapshot with no history/memory/references | Valid empty ready result |
| Saved run lacks optional request inputs/capacity | Keep absence/unknown, do not reconstruct from new live data |
| Current policy changed after saved run | Preserve saved threshold/audit selection; next-send policy remains editable |
| Thread changes during policy/memory write | Old callback/publication cannot affect the new owner; existing per-field command semantics remain |

### 5. Good / Base / Bad Cases

- Base: trigger, ring and opened panel use the same snapshot; ready empty data stays distinguishable from loading/error.
- Good: a concurrent writer cannot modify the facts between nested preview reads; all nested reads belong to one native read-only transaction.
- Good: switching from A to B hides A's ready/error/empty results until B's complete identity resolves; saved run summary threshold stays frozen after editing next-send policy.
- Bad: querying the panel again, planning from temporarily empty parent arrays, treating missing data as loaded defaults, using live policy to reinterpret a saved run, or publishing A's late write feedback in B.

### 6. Tests Required

Use actual trigger/panel/parameters/memory entry points and original per-field policy commands. Cover retained ready/error/empty states for every identity, loading/missing/foreign scope/error and legitimate empty results, frozen historical thresholds and absent optional inputs. Verify all nested durable readers and their store list. Native IndexedDB evidence must prove one actual transaction and the concurrent writer boundary, not merely inspect a table array. Retain B01 identity/navigation and B07 compose-session browser cases where applicable. Preserve failed fixture/setup attempts and demonstrate the fault or state was reached; no weakened assertions/timeouts or live-provider coverage claims.

### 7. Migration / Limits

AgentChatPage removes obsolete preview task/messages/runs props; its transcript/status and D03 execution/selection/reference owners remain. Five production files and their direct consumers are the bounded D04 migration; unrelated provider/tool/draft/capability policies stay with later units. The new semantic DB fact owner is independently linted; large UI functions retain measured complexity debt, including increases for explicit state/identity handling. Finite native fixtures validate local DB/UI boundaries with zero provider requests, not all browsers, paid services, image interpretation or performance. Whole-batch model/build/final review and formal E07/QG01 gates remain separate acceptance.
