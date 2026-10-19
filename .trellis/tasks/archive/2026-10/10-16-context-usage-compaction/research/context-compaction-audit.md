# Research: context usage figure, auto-compaction, dsh comparison, manual-compact hook points

- **Query**: How the composer context-usage figure is computed and why it is inaccurate; whether auto-compaction works; how deepseek-harness (dsh) does it; where a manual compact action can hook in.
- **Scope**: internal (aifenjing + /Users/xiaomengdao/WebstormProjects/deepseek-harness), read-only
- **Date**: 2026-10-16
- Paths are relative to `aifenjing/` unless prefixed `dsh:` (= `deepseek-harness/`). Line numbers are from the files as read today (working tree has uncommitted edits).
- Tests run (no builds): `npx vitest run tests/contextUsage.test.ts tests/contextManagement.test.ts packages/agent-core/src/compaction.test.ts tests/contextPreviewSnapshot.test.ts` -> 4 files, 41 tests, all passed.

---

## 1. How the composer's context-usage figure is computed today

### Files

| File | Role |
|---|---|
| `packages/studio/src/features/agent/ui/ContextUsagePanel.tsx` | `useContextUsage` (L39-176), popover panel, ring trigger (L348-430) |
| `packages/studio/src/features/agent/runtime/contextUsage.ts` | `estimateContextUsage` category split (L11-45); re-exports `estimateTokens` |
| `packages/agent-core/src/contextBudget.ts` | `estimateTokens` (L14-18), `budgetEnvelope` (L21-28), policy defaults |
| `packages/studio/src/features/agent/runtime/contextPlanner.ts` | `buildContextMessages` (L35-57), `budgetContext` (L60-62), `selectContextHistory`, `findApplicableSummary` |
| `packages/studio/src/features/agent/runtime/contextPolicy.ts` | `resolveContextCapacity` (L6-14) |
| `packages/studio/src/features/agent/commands/agentContextPreview.ts` | Reads coherent snapshot (messages, summaries, active run, skills/MCP tool schemas, memory, references) |
| `packages/studio/src/features/settings/models/modelMetadata.ts` | `resolveModelMetadata` -> `contextWindow` (L19-30, L41-61) |
| `packages/agent-providers/src/continuation.ts` | `responseContinuationTokens` (L23-25) |
| `packages/studio/src/features/agent/ui/AgentChatPage.tsx` L516-521 | Mounts `ContextUsageTrigger` with draft, model, connector, modelMetadata |

### Computation (idle thread, i.e. no running / waiting_approval / recoverable run)

1. `agentContextPreview.readFacts` reads thread messages, runs, compaction records, agent config, task context, skill surface, MCP snapshot -> `toolSchemas` (L106-135), plus memory selection and reference selection (L96-103).
2. `useContextUsage` (ContextUsagePanel L82-139):
   - `selected = selectContextHistory(messages, policy)` (only `complete`/legacy-no-status messages, optional `limitHistory` by whole turns; contextPlanner L9-22).
   - `summary = findApplicableSummary(...)` only when `!activeRun && policy.autoCompress` (L88-93).
   - `request = withMemoryContext(buildContextMessages(instructions, skillInstructions, selected, requestDraft, summary, undefined, selectedReferences), memorySelection)` (L112-125). Draft is trimmed; with attachments and empty draft the literal `请结合附加的参考资料协助我。` is used (L50).
   - `budget = budgetContext(request, tools, capacity, hasSummary, extraTokens)` -> `budgetEnvelope` (contextBudget L21-28): `estimatedTokens = estimateTokens(JSON.stringify(messages)) + estimateTokens(JSON.stringify(tools)) + extraTokens`, where Studio's `extraTokens` includes `images.length * 4096` (contextPlanner L61).
   - `usage = estimateContextUsage({instructions, skillInstructions, messages: request, tools})` splits per category (assistant, skills, messages, summary, memory, references+images, results, tool-schemas).
   - `overhead = max(0, budget.estimatedTokens - usage.total)` is pushed as a gray "请求结构与续接状态" category and added to `usage.total` (L143-150). So **displayed total ≈ `budget.estimatedTokens`** (JSON-serialized messages + tools + image constant + reasoning continuation), not the sum of raw contents.
   - `percent = min(100, usage.total / capacity * 100)` (L151-153). The ring and title use `usage.total / capacity` (L365-369, L381-391); no capacity -> dot instead of ring.
3. Estimator: `estimateTokens` = per code point `<=0x7f` -> 0.25, else 1.5, ceil (contextBudget L14-18). Explicitly "a character heuristic, never a provider tokenizer".
4. Model window source: `resolveContextCapacity` (contextPolicy L6-14): `resolveModelMetadata(model, metadata, providerId).contextWindow` (`source: "provider"` -> "供应商", else "模型目录"), but a thread-level `customContextTokens` wins when smaller than the limit -> "本地预算". No fallback when unknown -> `capacity` undefined.

### Computation (active / recoverable run)

- Source of the request is the saved run: `activeRun.continuationMessages ?? activeRun.requestMessages` (L112-113); capacity is the **frozen** `activeRun.context.capacity` (L94-97), policy frozen too (L83). Tool schemas are re-derived from the saved run's `enabledToolNames/toolLoading/mcpSnapshot` (agentContextPreview L79-85), `extraTokens = continuationExtraTokens(activeRun)` = estimate of Responses `reasoning` items only (continuation.ts L23-25).
- Provider-reported usage is shown only as a sentence in the panel footer (`最近一次请求实际输入 N tokens，其中缓存命中 M`, L335-337) from `activeRun.modelMetrics.at(-1).usage.inputTokens`. It is **not** used for the ring/percent. The footer also states "当前输出及未回填的工具结果尚未计入" (L334).
- `currentSavedRun` (agentContextPreview L66-72) treats the latest run as active only when `running|waiting_approval` or `(hasToolCalls && failed|interrupted)`.

### Behaviour matrix

| Situation | Current behaviour (evidence) |
|---|---|
| Provider-reported usage | Never used as the figure. Only displayed as text for an active run (ContextUsagePanel L335-337). Idle thread: ignored entirely. Usage is stored per step in `AgentRun.modelMetrics` (`recordAgentModelMetrics`, commands/agentRuns.ts L309-335; only summed when every step has it). |
| Source label | Panel copy says estimated: "文本按长度粗略估算；每张图片按 4096 tokens 保守估算，非模型实际用量" (L327). Trigger title "上下文预计占用 x%" / "上下文明细（估算）". No reported/estimated switch. |
| Model switch (idle) | Recomputed from the new `model`/`connector`/`modelMetadata` props; capacity changes; no stale usage because usage is not used. Text estimate does not depend on model. `initModelCatalog()` awaited in `prepareAgentContextPreview` (L144-147). |
| Model switch (active run) | Ring keeps the run's frozen capacity and frozen request; composer model change does not affect it. |
| Resume / reload | Idle thread rebuilt from persisted `chatMessages`; ignores the previous runs' tool calls/results (they are not in `ChatMessage` history, same as send path `agentRuns.ts` L149-150). Active/recoverable run uses saved continuation. |
| Streaming | Streaming assistant messages (`status: streaming`) are excluded from history (contextPlanner L10); active run's output tokens not counted. Preview re-reads when `contextPreviewTables` change (agentContextPreview L43-48). |
| Compaction summary | Idle: counted via `findApplicableSummary` (only completed + `activatedAt` + coverage is exact prefix). Rendered as assistant message `[历史摘要 · ...]` so lands in "历史摘要" category (contextUsage L39). |
| Attachments / images | Text envelope counted via `content`; each `referenceInput.images` entry counted as flat 4096 (contextUsage L40; contextPlanner L61). Draft-time `selectedReferences` come from `selectReferenceContext` with a char budget (agentContextPreview L101). |
| Tool results / spilled results | In an active run, tool messages counted from `continuationMessages` as stored (clipped/spilled content is whatever was persisted). Idle: none (not in history). I did not trace E07 spill formats; not confirmed. |
| Reasoning | Only Responses `reasoning` items (via `responseContinuationTokens`), estimated with the char heuristic. Chat-completions reasoning text is not part of the request (no replay found in `providers/chatStream.ts`; grep for "reasoning" there only shows effort validation). |
| Tools/skills/MCP schemas | Counted: `JSON.stringify(tools)` once; skill instructions counted inside the system message (split via exact-match of `instructions + "\n" + skillInstructions`, contextUsage L32-37). |

### Concrete inaccuracy causes (ranked) and verification ideas

1. **Heuristic tokenizer is the only source; provider usage is not used.** `estimateTokens` is 0.25/char ASCII, 1.5/char non-ASCII. Real ratios vary by provider/tokenizer (CJK often 0.6-1.5 per char; JSON/code/URLs ASCII typically 0.3-0.4 per char; astral emoji count as 1.5 per code point). The error is systematic per content type and could be large for CJK-heavy or JSON-heavy threads. Verify: fixture pairs of (messages payload, recorded provider `usage.inputTokens`) for ASCII prose, Chinese prose, JSON tool results, code; assert `|estimate/actual - 1|` within a stated tolerance, and record the per-class ratio. Existing `tests/contextUsage.test.ts` only checks category arithmetic (L22-37), never a real payload.
2. **Idle preview ignores the last response's reported prompt size.** After any completed run `modelMetrics` exists, but the ring is recomputed from the estimator. Verify: fixture thread with a completed run whose `usage.inputTokens` is far from the estimate; assert which value the ring shows (currently the estimate).
3. **Displayed total is the JSON-serialized envelope, not the wire payload.** `budgetEnvelope` stringifies the internal `AgentRequestMessage[]` (including `referenceInput` objects, `tool_calls`, role keys) and the tool list; actual Chat Completions / Responses wire shapes differ (`referenceWire.ts` L48-101 maps images to `image_url`/`input_image` with base64; Responses flattens tools/items via `toResponseInput`). `referenceInput` metadata (coverage, locators) is serialized into the estimate on top of `content` (which already holds `envelope`) -> likely double counting, shown in the gray "请求结构与续接状态" bucket (ContextUsagePanel L143-150). Verify: build a request with a reference attachment, convert via the real transport body builder, estimate the wire JSON, compare to `usage.total`; assert envelope-overhead bucket size.
4. **Images flat 4096 tokens.** Independent of image dimensions, `detail: "auto"`, or provider pricing (contextPlanner L61; contextUsage L40). Verify: fixtures with 1 small and 1 large image; compare to provider-reported `inputTokens` deltas.
5. **Tool-schema / skill / MCP accuracy.** Counted once as `JSON.stringify(tools)`; actual serialization differs per protocol (Responses flat tool objects vs chat `{type:function,function:{...}}`); skill text is in the system message. MCP schemas depend on `assertMcpSnapshotCurrent` and the offered set (`getOfferedToolNames`); deferred/loaded capability groups change the count. Verify: for chat and responses protocols, serialize `toolSchemas(...)` as the transport does and compare with the estimate; fixture with MCP groups loaded vs unloaded.
6. **Reasoning continuation estimated from JSON of reasoning items.** `responseContinuationTokens` JSON-stringifies the whole item (opaque/encrypted content is ASCII-like -> 0.25/char). Verify: fixture with a Responses reasoning item vs the provider's reported `reasoning_tokens`/input delta.
7. **Active run: preview excludes the pending draft and un-recorded tool results, and uses frozen capacity.** Panel admits this in the footer (L334). Because the ring shows the in-flight request, typing a new draft does not change it during a run. Verify: component/DOM fixture with active run + changed draft; assert unchanged.
8. **Idle preview vs actual send divergence in memory/summary selection.** Send recomputes `getMemorySelection` with `draft: content` and `recentUserTurns` (agentRuns.ts L151-158); preview does the same with `requestDraft` (agentContextPreview L96-100) but always passes `undefined` memory envelope into `buildContextMessages` and inserts it via `withMemoryContext` instead (ContextUsagePanel L121-124). Order is equivalent for the memory-only case but differs from the send path when a summary exists: send puts `memoryEnvelope` then summary (contextPlanner L39-47); preview inserts memory directly after system too (retrieval.ts L186-197), so same order; low risk. Verify with a fixture comparing `buildContextMessages(..., memoryEnvelope)` against `withMemoryContext(buildContextMessages(...))`.
9. **Summary record counters are not request-size comparable.** `beforeTokens` = estimate of `previousSummary + JSON(selected role/content)` only (contextCompaction L100); `afterTokens` = `estimateTokens(content)` of the summary text only (L57). The "约 X → Y tokens" copy in `ContextCompactionDetails.tsx` L13 therefore excludes envelope/tools/reference sources and is not "tokens before/after the request".
10. **Capacity edge cases.** `customContextTokens` only lowers capacity (contextPolicy L9); unknown window -> no percent (ring dot). Catalog merging uses `Math.min` of context windows (modelMetadata L56). No check that capacity relates to input vs input+output.

---

## 2. Automatic compaction pipeline

### Files

| File | Role |
|---|---|
| `packages/agent-core/src/compaction.ts` | Neutral algorithm `compactContext` (L45-83), grouping, `replaceContinuationBase` (L86-89) |
| `packages/agent-core/src/contextBudget.ts` | Thresholds (`budgetEnvelope`, L21-28) |
| `packages/studio/src/features/agent/runtime/contextCompaction.ts` | Studio host: `prepareRunContext` (L80-128), `activate` (L39-77), `summaryInput` (L18-30) |
| `packages/studio/src/features/agent/runtime/runChat.ts` L72-81 | `prepareContext` host hook: refresh tool loading/project/memory -> `prepareRunContext` -> refresh memory -> over-budget re-check |
| `packages/agent-core/src/runtime.ts` L230 | `run=await host.prepareContext(run,controller.signal)` immediately before `admitModelStep` and the request, each loop iteration |
| `packages/studio/src/features/agent/commands/agentRuns.ts` L149-185, L276-290 | Run admission (summary reuse, frozen `context`) and interruption of `running` summary records |
| `packages/studio/src/features/agent/models/context.ts` | `ContextSnapshot`, `ContextCompaction` shapes |
| `packages/studio/src/features/agent/ui/ContextCompactionDetails.tsx` | Summary status UI |
| `tests/contextManagement.test.ts`, `packages/agent-core/src/compaction.test.ts` | Existing tests |

### Triggers / thresholds (contextBudget L21-28)

- `adjustedTokens = ceil(estimatedTokens * 1.25)`.
- `outputReserve = capacity ? min(8192, max(256, floor(capacity*0.15))) : 0`; `inputBudget = capacity - outputReserve - ceil(capacity*0.05)`.
- `threshold = min(inputBudget, floor(capacity * (hasSummary ? 0.65 : 0.5)))`; `needsCompression = adjusted >= threshold`; `overBudget = adjusted > inputBudget`.
- So compaction effectively triggers at ~40% (no summary) / ~52% (with summary) of the window by the raw estimate. The panel copy states "整理触发基于上限的 50%（已有摘要时为 65%）" but does not mention the 1.25 multiplier is applied to the estimate before comparing (the ring shows the unmultiplied estimate; ContextUsagePanel L329 mentions "另计 25% 估算余量").
- No capacity (unknown window) -> `threshold` undefined -> never compacts and never over-budget (confirmed by test `contextManagement.test.ts` "does not send auxiliary requests with unknown capacity or when compression is disabled", L221).
- `autoCompress=false` -> skips compaction; throws only when `overBudget` (compaction.ts L53-56).

### Trigger point

- **Before each model request** (every step of the loop, including after tool results), under the thread's Web Lock and after tool calls are settled: `assertSettled` requires all `agentToolCalls` of the run in `completed|failed|rejected` (contextCompaction L88-91). Comment L79: "Runs only under the thread Web Lock, between fully settled tool rounds".
- **No on-overflow trigger**: I searched `packages/agent-core/src`, `packages/agent-providers/src`, `studio/features/agent/providers` and `runtime` for overflow/context_length/"maximum context"/"too long" handling and found none. A provider context-length error ends the run through the ordinary failure path (not confirmed by test; no test found).
- A second guard in `runChat.ts` L80 re-checks `overBudget` after memory refresh and throws a Chinese error.

### What is compacted / preserved

- Only `run.context.history` (visible chat `ChatMessage`s selected at admission) is summarized, in whole-turn groups (`groupContextHistory`: a group starts at each `user` message; compaction.ts L22-29). The **last group is excluded** unless `overBudget` (L60). The current draft, memory envelope, selected references, system/skill text, tool results of the current run, and Responses continuation items are never summarized; they are retained byte-for-byte via `replaceContinuationBase` (L86-89) and the exact-prefix checks in `activate` (contextCompaction L48-50, L63).
- Each pass picks groups while `fits(run, input(previous, selected+group))` (summary request must itself fit the window with no tools; contextCompaction L97). Max 8 passes per prepare (L49), then `已完成本轮 8 次历史整理...` error unless budget no longer needs compression (L81-82).
- Incremental: new record `coverage = [...previous.coverage, ...selected]` and the prior summary is passed as `previousSummary` (L24, L100). Reference sources: `referenceContext` kept as exact metadata; image pixels are not replayed in the summary request or after summary (contextPlanner L43-47; contextCompaction L25-29).
- Summary prompt: `SUMMARY_INSTRUCTIONS` (contextCompaction L16) with untrusted-data notice; request `maxOutputTokens = min(outputReserve, 4096)`, same model, same connector, same `reasoningEffort` as the run (L115).

### Failure / retry / idempotency

- Record persisted as `status: running` **before** HTTP (`begin`, L102-108); test confirms (`compaction.test.ts` L27; contextManagement L84, L142).
- Success only if content non-empty, no tool calls, `tokens(content)+32 < beforeTokens` (compaction.ts L77) and the rebuilt continuation is shorter by estimate (contextCompaction L71). `activate` runs in one transaction asserting the run is still `running`, the saved record still `running`, thread exists, `context` unchanged, frozen project scope, base/response-item prefix unchanged (L41-50, L63); aborted signal throws inside the transaction (L42, L72).
- Failure: `fail` marks the record `failed` or `interrupted` (abort), with redacted/truncated error (L121-126), and the error is **rethrown, failing the whole `prepareContext` and therefore the run step** (compaction.ts L79). There is no automatic retry and no fallback to sending the uncompressed request; recovery is by regenerate/continue (UI copy in ContextCompactionDetails L13). A crash/reload with a `running` record -> `interruptThreadRuns` marks it `interrupted` without a network call (agentRuns.ts L282-286; test contextManagement L142).
- Idempotent re-entry: `findApplicableSummary` (contextPlanner L28-31) reuses a completed, activated record whose coverage is an exact prefix of the next history (id, role, content, referenceContext), preferring larger coverage then newest update. Edited/truncated history invalidates (test L110). A stale `summaryId` during a run throws `历史摘要已失效...` (compaction.ts L58).
- Summary is not applied at admission when `autoCompress` is off (agentRuns.ts L150).

### Concurrency with other features

- Thread Web Lock / `AgentThreadWork` reservation (`runtime/threadWork.ts` L37-44) prevents another model/batch/wrapup owner on the same thread; `ownership.assertHeld()` brackets `prepareContext` (runChat L73).
- Pending approvals: `assertSettled` rejects `awaiting_approval`/`running`/`unknown` calls with `请先完成或核实工具调用，再整理上下文` (L89-91); compaction therefore cannot run while approvals pend.
- E07/E09/E10: tool-loading, project context, memory refresh happen before compaction (`runChat` L75-77); tool schemas passed to the budget are the currently offered schemas (L78). Skill instructions and MCP schemas count in the budget but cannot be reduced by compaction. I did not trace E07 result spilling into `continuationMessages`; if spilled previews are in the continuation they count, full spilled payloads do not (not verified).
- E11 background runs: no reference found in `contextCompaction.ts`/`runChat.ts`; not confirmed.

### Is it working correctly?

- Confirmed (by running the existing tests, 41 passed, and by reading): threshold arithmetic; separate summary request; activation/reuse; invalidation on history edits; reload recovery without network; Responses reasoning/tool-pair byte preservation; rechecks after tool results and never replays completed tools; incremental bounded requests; transactional rollback on persistence failure and unsettled calls; refusing an oversized indivisible question; no summary when capacity unknown or compression disabled.
- Not confirmed / observations (no defect has been reproduced):
  - Summary quality is untested beyond prompt text; no fixture evaluates content.
  - `needsCompression` but `selected` empty and not `overBudget` -> returns silently without compacting (compaction.ts L66-69); the request goes out above the threshold up to `inputBudget`.
  - Large current-turn tool results cannot be compacted (not in `history`), and there is no tool-result pruning; the only outcome is `overBudget` error (compaction.ts L67).
  - No overflow-recovery path (above).
  - Summary request uses run `reasoningEffort` with `maxOutputTokens <= 4096`; reasoning models could exhaust the cap and yield empty content -> `摘要未能有效缩短...` failure (plausible, unverified).
  - `beforeTokens/afterTokens` are partial (see 1.9).
  - Failure ends the run rather than degrading to uncompressed send.
  - Display and trigger disagree on measure (ring shows the raw estimate; trigger uses x1.25).
  - Untested paths I could not find tests for: provider-reported usage reconciliation, image-heavy history, Chat protocol vs Responses protocol token differences, multi-tab Web Lock contention during `prepareRunContext`, manual compaction (does not exist).

---

## 3. dsh (deepseek-harness) comparison

### Files

| File | Role |
|---|---|
| `dsh:packages/llm/token-meter/src/{index,usage-projection,projection,estimate,breakdown-projection,surface-fold,route-pricing}.ts` | Meter service: provider-anchored pressure + heuristic delta, breakdown projection |
| `dsh:docs/subsystems/token-meter.md` | `TokenMeasurement` contract (baseline usage vs estimated) |
| `dsh:packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx`, `.../context-occupancy.ts` | Composer ring + panel |
| `dsh:packages/compaction/compaction-basic/src/{index,config,region,summarizer}.ts` | Auto compaction, thresholds, `compactNow` |
| `dsh:packages/compaction/command-compact/src/index.ts` | `/compact` command |
| `dsh:packages/compaction/compaction/src/{index,types,checkpoint,tool-pairing}.ts` | Seam contract |
| `dsh:packages/compaction/compaction-tool-result-pruner`, `compaction-image-offload` | Model-free reduction, image placeholders on overflow |
| `dsh:docs/subsystems/compaction.md` | Events, results, failure codes |

### Usage measurement

- `ContextPressureProjection` (`dsh:.../projection.ts`): `pressureTokens` = provider-reported prompt size of the last request (uncached + cache read + cache write; response output excluded); `projectedTokens` = `pressureTokens` + heuristic **delta** of the surface changed since that sample (so compaction is reflected immediately); `contextWindow` newest route capacity. Absent until a provider reports usage.
- UI `contextOccupancy` (`context-occupancy.ts`): `usedTokens = projectedTokens ?? pressureTokens`; returns null (renders nothing) until both numerator and capacity are known; percent clamped to 100 and rounded.
- `TokenMeasurement.baseline.kind` is `usage` (anchor reused only if the latest successful call's canonical request envelope matches and the total is >= the anchor's route-priced total) or `estimated` (full heuristic). Image pricing is route-declared via `route-pricing.ts`, fixed heuristic otherwise.
- Heuristic: 4 chars/token flat plus 4 per block/role overhead (`estimate.ts` L13-19); the docs state it underprices CJK/JSON and that anchoring to provider usage removes that error. The panel shows only a 3-way heuristic breakdown (system, tools, messages) explicitly "not a total" (`projection.ts` ContextBreakdownProjection docs; `ContextMeter.tsx` ROWS L33-37).
- Known trade-off documented: model switch can pair fresh capacity with previous route's pressure until the next request.

### Thresholds / automatic compaction (`dsh:compaction-basic`)

- `thresholdRatio` 0.8 (config.ts L20), `headroomTokens` 65 536 (L75), `retainRatio` 0.16 (L23), `compactionRetries` 1 (L105), `maxOverflowRetries` 1 (L106), per-model overrides via `modelPolicies`.
- Pressure trigger at `agent/pre-step` (index.ts L158-165) before request derivation; `agent/request-error` handler (L190) handles confirmed overflow, bypassing threshold/retained tail; returns a retry action only when the surface replacement generation advanced.
- On qualification: optional `toolResultPruner` first (model-free), remeasure, then `selectCompactableRange(session, measurement, retainTokens)`, loop up to `compactionRetries+1`, throws if still above threshold (index.ts L305-345). Region boundaries keep tool-call/result pairs (`tool-pairing.ts`) but do not require whole turns.
- Log-bracketed lock: `compaction/start` -> summary -> replacement -> `compaction/end`; orphan start = busy (docs/subsystems/compaction.md).

### Manual compaction (command/UI)

- `/compact` (`command-compact/src/index.ts`): no arguments; calls `ctx.compaction.compactNow(agent, signal, commandId)`. Results: `null` -> "No compactable history yet."; success text "Compacted N history items (~T tokens)." with the summary event seq. Expected failures via `ManualCompactionError.code`: `busy` (active compaction or agent not idle), `cancelled`, `changed` (selected history changed), `summary` (no useful summary), `commit` (partial mutation), `persistence` (closed but not saved) (index.ts L24-56). Abort handled explicitly (L70). Active handlers drained on teardown (L96-108).
- `compactNow` runs between turns, writes nothing when no useful range exists, records a standalone `turn: null` bracket, flushes before later queued prompts (docs/subsystems/compaction.md). Tests: `compaction-basic/tests/manual-compaction.spec.ts` (hold prompts during summarization, injected context preserved, busy cases, failed summarizer releases admission, null without a bracket, stale orphan scans).
- No dedicated button in the context meter panel (ContextMeter has read-only composition rows); manual compaction is a command surface only.

### What the dsh design offers that aifenjing lacks today (observations, not recommendations)

- Provider usage anchor + delta projection for the figure; hide when unknown.
- Overflow-triggered compaction with retry cap; model-free tool-result pruning before summarization; image-offload on overflow.
- Typed manual-compaction failure codes and `null` "nothing to compact" result.
- Capacity-relative headroom rather than fixed fractions.
- Heuristic breakdown explicitly labeled as composition, not total.

---

## 4. Where a manual compact action could hook in (existing APIs to reuse) and risks

### Reusable pieces

- Neutral algorithm: `compactContext(host, signal)` (`packages/agent-core/src/compaction.ts` L45-83). Host contract `CompactionHost` (L5-20): `read`, `assertSettled`, `context`, `budget`, `readSummary`, `sameSource`, `input`, `fits`, `create`, `begin`, `request`, `tokens`, `activate`, `fail`.
- Studio host: `prepareRunContext` (contextCompaction.ts L80-128) builds that host. **It requires an existing `agentRuns` row with `status === "running"` and `run.context`** (read L85; `begin` L105; `activate` L45), and writes `contextCompactions.runId`. On an idle thread there is no run; summaries are only created inside a run, then reused by later runs through `findApplicableSummary`. A manual compaction on an idle thread therefore has no existing host target (the `ContextCompaction.runId` field and `activate`'s run-replacement are run-bound).
- Persisted, reusable output: `contextCompactions` table (`id, threadId, runId, status, createdAt` index, `browserDatabase.ts` L242), already read by `readAgentContextPreview` (L59), `threadReading.ts` L75, deletion on thread delete (`lifecycle.ts` L47), and by `findApplicableSummary` at admission (`agentRuns.ts` L150).
- Budget/estimate: `budgetContext` / `budgetEnvelope` (before/after request size), `resolveContextCapacity`, `buildContextMessages`, `summaryInput`/`SUMMARY_INSTRUCTIONS`, `streamChatCompletions` / `streamResponses` + `selectAgentProtocol`, `resolveConnector` (see how `taskWrapup.ts` L40-110 makes a non-run model call).
- Non-run model-call precedent: `runtime/taskWrapup.ts` (thread Web Lock `cuepoint:agent:<threadId>` via `ThreadLockManager`, `reserveAgentThreadWork` identity kind `taskWrapup`, `stopTaskWrapup` interrupted/failed records, `recoverTaskWrapups` after reload, connector re-resolve and key redaction, abort via `AbortController`).
- Work ownership: `reserveAgentThreadWork(store, identity, controller)` (`runtime/threadWork.ts` L37-44) — finite identity union (`model|videoBatch|audioBatch|taskWrapup`); throws if the thread already has work; subscription via `subscribeAgentThreadWork` for UI disabling; `shutdownAgentThreadWork` aborts everything on exit.
- Interruption/recovery: `interruptThreadRuns` (agentRuns.ts L272-295) marks `running` compaction records interrupted when owning a thread lock; no equivalent for run-less records (taskWrapup has its own).
- UI: `ContextUsagePanel`/`ContextUsageTrigger` (popover, `ContextCompactionDetails` shows `lastRecord`, `activeRun`, `available` flag for read-only), `ContextCompactionDetails.tsx`.
- dsh reference for command-level semantics: `ManualCompactionError` codes, `null` = nothing to compact.

### Risks / constraints observed

- **Run-bound pipeline**: `activate` swaps `run.context.baseMessages`, `continuationMessages`, `responseItems`; a thread with no run has none of that. A manual action on an idle thread must create a persisted summary record that `findApplicableSummary` can later match (coverage must be an exact prefix of the history selected at the next send, including `referenceContext`), and must not be created from a different `selectContextHistory` policy than the next send uses (policy is frozen per run from `thread.contextPolicy`).
- **Active run / approvals**: `assertSettled` forbids pending tool calls (L88-91); manual compaction during a `running` run would contend for the Web Lock and for `context` equality in `activate` (L45). During `waiting_approval` the run is not `running`, so `prepareRunContext.read` throws `执行已结束或不存在`.
- **Concurrency**: needs thread-level exclusion with model runs, video/audio batches, task wrapups (`reserveAgentThreadWork`) and background E11/MCP work; `currentAgentThreadWork` gates UI.
- **Last-turn exclusion**: auto path leaves the last group unsummarized unless over budget (compaction.ts L60); a manual action would have to define its own candidate selection (or accept the same rule), and `fits` requires the summary request to fit the window.
- **Counters**: `beforeTokens/afterTokens` are summary-only estimates (see 1.9); "tokens before/after" for the user would need request-level budgets (`budgetContext` before/after) rather than these fields.
- **Credentials/scope**: summary request resolves credentials per run (`credentials.resolve(run)`) and checks `frozenProjectScope`; a run-less path needs the thread's connector identity (taskWrapup uses `identity` + `resolveConnector` and re-validates `baseUrl/definitionId`).
- **Preview coherence**: `readAgentContextPreview` observes `db.contextCompactions` in its table set (L45), so a new record refreshes the panel without extra wiring; `currentSavedRun` treats a `running` summary on an idle thread as nothing (summary only shown via `lastRecord = records.at(-1)`, ContextUsagePanel L173).
- **Cancel semantics**: existing auto path cancels via the run's `AbortController`; summaries never activate when aborted (`signal.throwIfAborted()` in `activate`, L42/L72) and failed records are marked `interrupted`.
- **Tests/fixtures to extend**: `tests/contextManagement.test.ts` uses a store + fetch fake (L84-110, L142-231) usable as a base; `tests/contextUsage.test.ts`, `contextPreviewSnapshot.test.ts`, `contextPanelDom.test.ts`, `contextPanelCoordinator.test.ts` cover panel; `agentJobsUi`/`threadWork` tests not examined.

### Related specs not read in full
- `.trellis/spec/agent-core/library/*`, `.trellis/spec/studio/*` (Studio ownership manifest `quality/studio-ownership.json` governs new files; not inspected).

## Caveats / Not Found

- No overflow-recovery path, no tool-result pruner, no manual compaction in aifenjing (searched agent-core, agent-providers, studio agent runtime/providers).
- Did not trace E07 spill formats, E09 skill prompt composition internals, E10 MCP snapshot token impact, or E11 background interaction with `prepareRunContext`; the statements about them are limited to what the code in `runChat.ts`/`contextCompaction.ts` shows.
- Provider tokenizer ratios quoted (CJK etc.) are general knowledge, not measured in this repo; no fixture comparing estimates to real provider usage exists today.
- Active task per `task.py current` is empty; output was written to the task directory given in the request.
