# Agent tools, permissions and continuation

## 1. Scope / Trigger
Read when changing tool protocol, Agent execution steps, approval UI, skills or configuration. This extends [execution foundation](./agent-execution.md); business CRUD and durable media execution follow [creative skills](./agent-creative-skills.md).

## 2. Signatures
- `AgentPermissionMode`: ask / assist / full.
- `AgentToolDefinition`: name/title/description/parameters/effect/parseArguments/highRisk/execute; optional prepare, atomic, recovery and requiresConfirmation.
- `requiresToolApproval(mode, tool, args): boolean` uses code-owned effect and risk.
- `getGeneralAgentConfig()` / `updateGeneralAgentConfig({permissionMode?, enabledSkillIds?})` in `features/agent/commands/agentSettings.ts`.
- `saveToolRound`, `transitionToolCall`, `pauseForApproval`, `resolveAgentToolApproval(runId, callId, decision)`, `resumeAgentRun`, `cancelAgentRun` in `features/agent/commands/agentTools.ts`.
- `resumeChatRun(runId, apiKey, controller, fetchImpl?, registry?)` runs under the thread Web Lock.
- Dexie v9 `agentToolCalls`: indexes include runId/threadId and unique run+providerCallId.

## 3. Contracts
- Run snapshots permissionMode, enabledToolNames and skill instructions. Later global changes affect only new runs, never pending approvals. Default is ask. Basic model transport and local plan/execution bookkeeping do not require tool approval.
- Ask gates business write/network tools; assist gates high-risk tools; full permits available validated tools without routine approval. Code-owned requiresConfirmation still gates paid submit_generation in every mode, so its configuration can be reviewed before spending. Risk/effect come from registry code, not model arguments. Effect/risk must match the approved durable call snapshot before execution.
- The two foundation tools remain: workspace_overview reads bounded project titles/counts; update_run_plan changes the current run checklist atomically with its result. Business, generation, reference, memory, web, IP and material capabilities are registered separately and offered on demand; see creative skills and agent-library-tools for the current surface. Eligible Task-mode runs additionally receive five current-task bookkeeping tools (task_read/create/update/record_read/record_write) and update_run_plan independent of optional skill switches; see agent-tasks.md.
- Tool arguments use strict runtime schemas before dispatch. Registry enabled names are frozen per run. Unknown/disabled tools, invalid arguments and owner mismatches cannot execute.
- One model round emits a complete assistant tool_calls envelope; persist it and immutable tool records before invoking any tool. Never execute argument fragments as they stream. Complete tool results append once to the continuation message chain before the next request.
- Allow 32 model requests per segment (MODEL_STEPS_PER_SEGMENT), max 16 calls per model response, 32,768 argument characters per call, 65,536 result characters. Cumulative modelStep remains monotonic for ledger ordering and usage. Optional modelStepSegmentStart defaults to zero for legacy runs. Before context preparation or a new request, pauseAtModelStepLimit atomically parks run/message as interrupted with pauseReason=model_step_limit, preserving output/results. Only explicit resume from that structured pause advances the segment start; approval, ordinary interruption and reload never refresh allowance. A final answer on request 32 completes normally.
- Approval binds runId+callId, is compare-and-set from awaiting_approval and survives reload. Reject saves a tool error result without executing. Multiple approvals remain parked until all decisions are made. UI saves decisions even if the connector is unavailable.
- A failed/interrupted run with durable awaiting calls may still accept explicit decisions if it remains latest and has no running/unknown effects. Keep its failure state and error visible; decisions alone never auto-execute. This also handles failure while saving the paused state.
- Recovery reconciles the crash window between saving awaiting_approval and parking the run: when no unknown tool outcome exists, restore waiting_approval so the original decision remains actionable. Unknown effects take precedence and still block continuation.
- Waiting for approval releases the Web Lock and is nonterminal; startup recovery does not auto-execute it. Explicit continuation reacquires ownership. Completed calls never replay. Ordinary Stop after tool steps produces interrupted state; explicit End execution cancels remaining work.
- Interrupted running side effects become unknown unless the code-owned atomic/repeatable contract or same-owner durable generation job proves safe recovery. Unknown generation status always blocks, including multiple remote task IDs. Users may end a run after checking results. A tool run cannot be restarted from the original prompt; use saved continuation context.
- Thread deletion cascades calls and runs; late results do not resurrect them. Saving failure is reported separately from Stop. Before the next request starts, failed resumption preserves already saved partial answer.
- Tool provider protocol accepts JSON or SSE indexed function fragments only when the tool is enabled. Require unique complete IDs, valid JSON-object arguments and finish_reason tool_calls. Post-finish payload, unknown tool or incomplete calls fail without execution. One POST per model round remains the transport contract.

## 4. Validation & Error Matrix
| Condition | Outcome |
| --- | --- |
| Unknown/disabled tool | No execution |
| Invalid args / injected approval field | Strict rejection, result explains error when safely recorded |
| Ask + write/network | Durable approval pause |
| Assist + high risk | Durable approval pause |
| Full | No routine approval, still validation/ownership checks; paid generation configuration requires confirmation |
| Double approve / cross-run call ID | Reject stale or mismatched decision |
| Approvals partly resolved | Keep parked; do not send another model request |
| Completed call on resume | Reuse result, no invocation |
| Unknown side effect | Block resume/retry; allow ending run |
| Model segment exhausted | Saved, non-error pause; explicit continue grants up to 32 more requests, completed tools never replay |
| Registry effect/risk changed after approval | Refuse old approval |
| Connector unavailable | Permit local rejection/end; model continuation waits |

## 5. Good / Base / Bad
Good: tool result saved → page closes → explicit continue reuses result → next model request.
Base: no tool response, ordinary text completes through the same runtime.
Bad: silently change ask to full for a pending call, retry completed paid work, or append duplicate tool results into history.

## 6. Tests Required

`executePendingTools` loads the current complete ledger snapshot and retains a
per-item Abort check in both passes. Current legal commands never reverse
completed/failed/rejected calls; the execution pass can skip those snapshot
terminal entries without another historical point read. Every snapshot that was
nonterminal still requires a fresh call read, fresh current run, metadata and
permission validation, and atomic pending/approved claim immediately before
execution. Never use a stale snapshot to dispatch or skip unknown-result checks.
The generic transition helper is not a universal immutable state graph; this
contract describes legitimate product commands under the thread lock.

Keep the original 64-tool/32-request continuation fixture, exact immutable call
and final-message assertions, and browser5s/native20s deadlines. Matched actual
SQLite profiling must demonstrate reduced historical point reads rather than
merely increasing a timeout. Preflight race regressions must settle or invalidate
a previously nonterminal candidate and assert no replay, retained result and
fresh current-run/claim behavior. Preserve Stop, metadata drift, approval and
uncertain-effect tests on both owners.

`agentTools.test.ts`: all permission branches with controlled definitions, immutable decision ownership, invalid arguments, original settings snapshot, 32-request segments across reload, repeated continuation without replay, approval/Stop without budget reset, old eight-step failures, final-step completion, duplicate call IDs, approve/reject continuation, uncertain effects, deletion, Stop and save failure, atomic plan result.
`agentToolsReview.test.ts`: approval-before-park crash, multi-approval ordering, live-tab ownership, late deletion result, unknown-effect precedence.
`chatStream.test.ts`: tool JSON/SSE assembly, disabled/invalid/truncated calls, finish reason, call limit, no fallback POST.
Browser local fixture: multiple tool steps and plan, refresh while awaiting approval, approve and reject to final response, inspect result details. Real paid APIs are not required.

## 7. Wrong vs Correct
Wrong: run a tool as soon as its streamed name becomes available, and prompt for approval afterward.
Correct: finish/validate the call envelope, persist it, evaluate code-owned permissions, then claim and execute only after any required decision.

Wrong: clone an interrupted tool run's original request to start over.
Correct: retain assistant/tool call-result chain and execute only unresolved safe steps before asking the model for the next step.

## Composer, metadata and diagnostics
- Composer has status above, plus/model/send inside, mode/permission and context ring below. Plus exposes searchable skills and real controls only. Popup interiors are flat (no nested card borders); model and context dismiss on outside click/Escape, restore trigger focus, and fit narrow viewports.
- Assistant messages are drawn directly (no `ChatItem`, avatar, title or time row): the process disclosure sits above the body; below it a quiet actions row (copy, regenerate) and one status line. Model, speed, tokens and time show only on hover/focus. Completed tools collapse; approvals, unknown outcomes and errors remain visible. See [agent-activity-ui](./agent-activity-ui.md) "Quiet transcript".
- Context preview shares `buildAgentRequestMessages` with run creation. Counts are explicitly heuristic estimates, never billing usage; provider limits override verified model specs, and unknown limits remain unknown. Provider metadata is connector-scoped and duplicate limits use the smallest known value. No output-limit-as-context fallback.
- Actual usage comes from response JSON/SSE. Persist per-step metrics idempotently; aggregate fields only when all rounds provided them. Generation throughput excludes approval/tool time and requires real output token counts plus streaming timing; historical/missing values are hidden.
- Composer dock measures its full height with ResizeObserver so controlbar and multiline input cannot cover final transcript content.

## Reasoning and Responses
- Model settings offer only verified connector/model effort values. Conversation selection is keyed by thread + connector identity/base URL + model, and saved in ChatThread; each run freezes the effective value. Default means omit the parameter. Retry/resume use the run snapshot.
- GPT-5.6 Luna + enabled functions + effort other than none (including default) uses Responses on supported OpenAI-compatible/AIHubMix connectors. `protocol` is selected before POST and saved; no automatic retry/fallback to another paid endpoint. Explicit legacy text-only retry may select the corrected protocol if no protocol was saved; existing snapshots stay fixed.
- Stateless Responses sends store:false and requests reasoning.encrypted_content. Save full output envelope with tool ledger atomically, and append paired function_call_output exactly once. Require complete terminal status and enabled/validated functions before dispatch. Preserve encrypted reasoning for continuation only; public UI renders summary text, never ciphertext or raw reasoning fields.
- `responseItems` consistency is checked before replaying side effects. Incomplete/error/aborted streams never cause partial tool execution. Terminal-only output does not create first-token timing.
- Source references: local LobeHub useReasoningEffortControl, modelExtendParams, contextBuilders/openai; official OpenAI reasoning/function-calling and AIHubMix Responses overview.
- Chat shell uses overflow:clip on its non-scrollable outer layer: the decorative grain extends outside its bounds, and hidden overflow can be programmatically scrolled by popup auto-focus. Transcript alone owns conversation scrolling; focus calls use preventScroll.
## LobeHub context metadata reference

LobeHub separates the model's advertised capacity from the live context estimate. The static fallback metadata is maintained in its `model-bank` package (`packages/model-bank/src/aiModels/openai.ts`), where GPT-5.6 Luna declares a `contextWindowTokens` value of `1_050_000`; the same model's pricing table has a separate `272_000` token tier boundary. Provider `/models` data is normalized in `packages/model-runtime/src/utils/modelParse.ts`, with provider values taking precedence over the model-bank fallback. The composer inspector uses `useTokenBreakdown → useTokenCount → packages/utils/src/tokenizer` (the `tokenx` npm estimator) to count sliced message text, draft, assistant instructions, tool definitions/prompts and history summary. Its runtime context-engine has a separate, richer accounting path for tool results, reasoning and provider usage. The popup is not reading a usage total from the model-list endpoint.

When matching this behavior locally, keep capacity (`contextWindowTokens`) and request usage as separate fields. A single maximum value is suitable for the progress denominator, while pricing thresholds should remain metadata for billing display and must not be presented as a second context limit.

## Composer surfaces

The home composer exposes only the conversation type (`Agent` / `任务`), the plus menu, model selection and send. The detail composer adds the execution surface (`智能` / `对话`), permission control, context inspector, expand editor, browser-supported voice input and send-shortcut menu. Conversation mode snapshots an empty tool list into the run; changing the UI mode affects only new runs.

- Expanded editor is an opaque, borderless surface scoped to the conversation column. Its dock fills the column and lifts the normal 800px width cap; textarea flexes to remaining height with autosize disabled, toolbar/controlbar stay at the bottom. Keep sidebar visible, hide/inert the covered transcript, preserve draft/selection, reset expansion when changing topics. Expanded Enter inserts a newline; Cmd/Ctrl+Enter sends, IME composition never sends.
- Home Agent/任务 switch is inside the lower-left toolbar, before plus. Detail's smart/conversation switch is bottom-left; permissions + context are bottom-right. The task board is still deferred and its menu item is labeled accordingly.
- Interaction mode is persisted per thread and frozen per run. Context preview uses the same empty skill/tool set in conversation mode. Legacy retries must retain empty missing tool snapshots instead of taking current global skills.
- Reference model capacity is independent of connector-specific reasoning support (e.g. APIMart). Label it as reference; a reported gateway limit still takes precedence. Pricing tiers are not alternate context capacities.

## Legacy atomic plan calls

`update_run_plan` is atomic bookkeeping because the plan mutation and tool result commit in one transaction. Frozen old calls lacking the atomic flag may be upgraded only by the explicit `isLegacyAtomicPlanCall` predicate under the thread lock; startup recovery also inspects previously parked unknown plan calls so Resume becomes available. Do not generalize this repair to arbitrary bookkeeping, network effects or calls with a stored result. Existing completed results stay completed; transaction or result-serialization failures roll back both business state and ledger.


## Actionable validation failures (2026-09-21)

`validateToolCall` throws `ToolValidationError` for schema/JSON/size rejection. The saved tool result contains `code: INVALID_TOOL_ARGUMENTS`, `executed: false`, bounded `issues` and model-facing recovery guidance. Reject before preparation, approval or execution; preserve the original call/arguments. Safe issue output uses schema-owned field paths, numeric received values and fixed Chinese type labels, never raw input strings, unknown keys or arbitrary thrown messages. Maximum six issues.

`business_read_text` uses a shared readable-path guard before execution. For episode text the script field is `story.script`; `limit` is an integer from 1 to 12000, with `nextOffset` pagination. The screenshot combination of `field: script` and `limit: 24000` returns both errors in one response. No silent argument correction or automatic retry is added. The model may issue a new corrected call; if other evidence suffices it is instructed to disclose the failed operation and relevant impact.

An unparsed local-read snapshot uses `highRisk: false` only for failure presentation; this does not permit execution. A new valid call recomputes its risk and goes through the normal permission matrix. Other effects retain a conservative fallback. Unknown results remain distinct and cannot be automatically replayed.

Error display and legacy revalidation follow [Agent Activity UI](./agent-activity-ui.md).

## Progressive capability loading

New runs separate the frozen permission ceiling from per-request offered schemas. Use `getOfferedToolNames` for request and budget assembly, and `toolNamesForCall` for execution. Library operations and exact contracts follow [Agent Library Tools](./agent-library-tools.md); legacy runs without `toolLoading` retain their original envelopes.

## D05 schema-linked tool protocol (2026-10-08)

### 1. Scope / Trigger

Maintain the schema-to-business-argument relation when defining or changing any built-in agent tool, family helper, registry entry, dispatch or durable approval metadata. Maintain the serializer envelope and source whitelist when changing memory selection wire text. Compile-time correctness and runtime validation have separate responsibilities.

### 2. Signatures / Owners

- `@momoki/agent-core` owns the neutral `ToolSpec<Args>`, `ToolContext<Preview>`, `ToolDefinition<Args, Context, Preview, Result, Name>`, `createToolFactory<Context, Preview>()`, `assertUniqueToolNames` and `toolMetadataMatches`. The factory infers arguments only from its parser specification; context, preview and result remain explicit host types. Neither the core tool contract nor its callbacks know ProductStore or creative entities.
- `features/agent/runtime/toolDefinition.ts` binds that factory to Studio's `AgentToolContext` / `AgentToolPreview` and owns `TypedToolDefinition<Args, Name>`, `AgentToolDefinition = TypedToolDefinition<unknown>`, `ToolBody<Args, Name>` and `defineTool`; it re-exports the core integrity and metadata helpers for actual callers. Studio alone supplies `projectId`, storage and the narrowed `generation` / `repeatable` recovery policy. `tools.ts` owns the assembled registry and its single justified argument erasure.
- `businessSchemas.ts` owns `Spec<T> extends ToolSpec<T>` with an explicit Zod parsed-output/unknown-input relation and the actual `text`, `trimmedText`, `defaulted`, choice/object/array/optional/nullable recipes. `defineTool<Args, const Name>(spec: Spec<Args>, body: ToolBody<NoInfer<Args>, Name>)` delegates to the core factory and infers business arguments only from the schema; callbacks cannot independently widen that inference.
- Prepare, risk and execute callbacks are function properties tied to that parsed argument type. Family arrays keep their heterogeneous typed definitions until the one justified registry erasure.
- `toolMetadataMatches<Args>` compares effect, computed risk, normalized atomic/recovery/confirmation against the persisted call. Both `runChat.ts` gates consume it. `generationProfiles.ts` owns the shared submit/job runtime specifications and their intentional advertised-schema ordering/projection; audio and existing business/library/task/memory helpers retain their actual domain schemas and commands. Existing `tools.ts` compatibility type exports remain for real consumers.
- `serializeMemoryEntries(entries)` retains its public readonly input/string result. A small exhaustive source projection owns summary/imported/manual source fields; empty entries return before constructing the envelope.

### 3. Contracts / Invariants

- Parsed schema output is the callback argument type throughout concrete tool definition and family helpers. Use literal names, discriminants and real typed projections where their domain relations are meaningful. Raw model arguments remain unknown until the selected tool's own parser succeeds.
- Only the central heterogeneous registry needs existential argument erasure. Record why dispatch remains sound: each erased definition carries its own parser and invokes its own callbacks on that parsed output. Do not cast raw arguments into business patches, suppress rules, introduce any, or scatter family assertions to satisfy the compiler.
- Advertised JSON schema, runtime parse/default/trim/refinement behavior, property order, tool names, catalogue membership and metadata remain compatible. Provider-specific generation limits and strict audio/default semantics are not rewritten for the type change.
- Schema construction may need a narrowly proved construction assertion where keys/optionality come from the same recipe. It is distinct from a coercion of untrusted data. Compile witnesses cover that recipe and callback mismatch.
- Effect, computed high risk, normalized atomic, recovery and normalized confirmation requirements are compared at both the approval/preparation boundary and execution-claim boundary. Invalid metadata cannot acquire permission from a presentation fallback. Preserve frozen offered-tool sets, durable ledger ownership, transaction rollback and paid unknown-outcome recovery.
- Argument validation failures remain actionable to the model. An invalid call does not execute; a newly issued corrected call may execute exactly once. Compiler rejection does not replace this runtime behavior.
- The serializer keeps the exact MEMORY_PREFIX/guidance/newline/JSON envelope, entry spread, source whitelist, field insertion order, empty/undefined/zero behavior and existing unknown-runtime fallback. Its entry spread is still deliberate compatibility; the source projection is not a claim that all extra entry fields are removed.

### 4. Validation / Error Matrix

| Condition | Required behavior |
| --- | --- |
| Callback expects a different schema output | Actual project compiler rejects the definition |
| Audio/default/transform schema | Callback receives its parsed output type; no inferred any |
| Duplicate/unreachable/missing registered name | Integrity check identifies the exact mismatch; dispatch/catalog remain complete |
| Raw model argument parse fails | No business execution/claim; model sees useful field/limit diagnostics |
| Any of five metadata fields differs before approval or claim | Reject at the corresponding gate; no partial business write or paid replay |
| Serializer input empty | Exact empty string |
| Summary/imported/manual/mixed input | Byte-compatible envelope and field order |
| Malformed unknown runtime source kind | Preserve the existing manual fallback without weakening typed exhaustiveness |

### 5. Good / Base / Bad Cases

- Base: one schema produces advertised parameters, parser and typed callbacks; registry dispatch parses its own unknown arguments then runs its own callback.
- Good: actual compile-negative fixtures reject wrong prepare/risk/execute arguments; the runtime validates both metadata gates and returns actionable correction diagnostics.
- Good: all current registered families/catalogue entries have matching names and no duplicates; serializer old/new bytes agree on representative and edge inputs.
- Bad: annotating every family as unknown, adding bivariant callbacks, allowing inference to widen from callback arguments, coercing raw fields to repository patches, trusting catalogue types as approval permission, or changing wire field order while claiming serializer compatibility.

### 6. Tests Required

Compile positive and negative examples with the actual project compiler and preserve expected failure witnesses. Verify current global registry/family/catalogue/offered-set integrity and every metadata field at both phases. Compare actual original/current advertised bytes and a meaningful valid/invalid/default parser corpus; finite cases supplement source/schema review rather than proving all possible inputs. Retain actual schema/refinement/default behavior, atomic business and ledger rollback, original frozen retry/recovery and actionable model self-correction tests for both Chat Completions and Responses. Serializer tests compare old/new bytes and include empty, mixed variants, zeros/undefined, whitelist/order and unknown-runtime fallback. Native probes are required for a concrete changed transaction/lifecycle risk; reuse accepted real runner entry points where applicable and record their exact frozen inputs. No weakened assertions, timeouts or live paid-provider claims.

### 7. Migration / Limits

Migrate every actual current family/helper/consumer, preserving concrete D02 persistence owners, D01 preparation leaves and D03/D04 session/query boundaries. Typed tool results remain unknown unless an actual domain need requires more; no generic CRUD/framework/registry redesign. Ancillary EX01 is tracked separately and does not increase the 51-finding count. D06 capabilities, D07 transport and D08 text drafts have their own contracts in `asset-output-foundation.md`, `ai-connectors.md` and `state-management.md`; E/QG01 remain separate pending work. Remaining static debt and justified construction/registry assertions are explicit; a typed registry does not prove effect metadata or paid-provider behavior.
