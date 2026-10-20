# Agent execution and recovery

## 1. Scope / Trigger
Read when changing Agent messages, execution lifecycle, retry, tool-loop integration or startup recovery. IndexedDB v8 adds studio-global agents and agentRuns; v9 adds the tool-call ledger. These records and credentials are excluded from project ZIPs.

Invocation-scoped presentation and optional Studio observation follow [Agent Execution Feedback](./agent-execution-feedback.md); Stop acknowledgement never releases ownership or claims terminal persistence.

Immediate local attempts and optional create-only admission identities follow [Agent Send Recovery](./agent-send-recovery.md). Unknown acknowledgement never authorizes another begin or dispatch.

Batch queue, selection and genuine generation-source evidence extend these contracts; read [Batch Generation](./agent-batch-generation.md) when touching those paths.

## 2. Signatures
- `beginAgentRun({threadId, connector, model, content?, attachments?, admission?, expectedOwner?, retryOfRunId?}): Promise<AgentRun>`
- `checkpointAgentRun(runId, sequence, output, store?): Promise<boolean>` returns true only when the conditional checkpoint was applied; stale/terminal no-ops return false.
- `finishAgentRun(runId, status, output?, error?, finishReason?): Promise<void>`
- `withThreadRunLock(threadId, execute: (ownership: ThreadOwnership) => Promise<T>, locks?, store?: ProductStore): Promise<T>`
- `withExecutionOwnership(threadId, execute, locks?)` acquires execution ownership without startup recovery; `withOwnedExecution(ownership, threadId, execute)` validates the held capability and excludes concurrent reuse.
- `recoverAbandonedRuns(locks?, store?: ProductStore): Promise<void>`
- `executeChatRun(run, apiKey, controller, fetchImpl?, registry?, store?, ownership?): Promise<void>` and `resumeChatRun(runId, apiKey, controller, fetchImpl?, registry?, store?, ownership?)` bind the real shared core `executeRun`. Production flows supply their already held ownership; direct consumers acquire execution-only ownership.
- `createRunWriter(persist, onFailure): {push(output), flush(): Promise<void>}`
- `AgentRunStatus`: running / waiting_approval / completed / failed / cancelled / interrupted.

## 3. Contracts
- An explicit store passed into `withThreadRunLock` must reach all lock-aware recovery readers/writers as well as the operation. Recovering through an ambient store while executing through a supplied store breaks ownership isolation.
- Caller owns the per-thread Web Lock from recovery through atomic begin, transport and final flush. Missing Web Locks fails closed. Recovery uses `ifAvailable`, never a heartbeat timeout that could invalidate a frozen live tab. `ThreadOwnership` is a private-identity capability, scoped to that actually held lock and exact thread; forged, released, foreign-thread or concurrent use must reject before resume/context writes. Keep current transactional run/call/step/approval/offer predicates; the product schema has no general durable run-owner/revision field.
- The actual model/tool loop and serialized writer are implemented once in `@cuepoint/agent-core`; Studio's runtime is a typed ProductStore/context/tool/credential binding. Keep creative finishing/scope policies in Studio and generic execution in core. See [shared runtime](../agent-core/library/runtime.md).
- Begin transaction creates input/output/run together and idempotently seeds a stable general Agent. Run snapshots agent instructions, request messages, connector identity and actual model. Never copy API keys into runs; reject URL credentials/query/fragment before saving connector identity.
- Chat history is read from the scoped database in the begin transaction, not stale React messages. Only complete or legacy status-less messages enter later context. Error copy is stored separately from answer content.
- Checkpoints use monotonically increasing sequence numbers. Writes coalesce and serialize; final transition awaits flush. Terminal executions cannot return to streaming. Local write failure aborts transport and is surfaced.
- Explicit retry creates a new run/assistant message and references its predecessor, while reusing the original user message and frozen request snapshot. Only the latest unsuccessful text-only attempt without later user turns can retry. Runs with tool calls use durable continuation instead; see [Agent Tools](./agent-tools.md). Connector ID/provider/base URL and model must match; current credentials may rotate. No startup network resubmission.
- Resolve the current saved connector/key at every actual main and auxiliary summary dispatch while preserving frozen identity. The entry-point key argument cannot freeze credentials for the whole run. Keep secrets out of snapshots/events and redact every credential used during that invocation before storing an error.
- Ordinary route/thread changes, browser Back/Forward and React cleanup detach the view while the application-owned operation continues. Only exact explicit Stop, intentional destructive owner actions and application shutdown signal cancellation. Keep the per-thread reservation and actual Web Lock until final persistence settles.
- The first new user message derives default thread titles in the begin transaction. Custom titles and retry titles remain unchanged.
- Thread deletion cascades executions; late writes cannot resurrect records. Legacy v7 pending/streaming messages become interrupted, retain partial text, and instruct the user to resend (they lack a request snapshot).
- Transport makes at most one POST. Original-response JSON is supported; invalid responses/HTTP rejection do not trigger an implicit non-stream request. SSE requires protocol completion and usable answer text; malformed/truncated output and length/filter termination fail explicitly, retaining partial deltas.
- A model-named tool that this request never offered — unregistered, or inside the frozen ceiling but outside `toolNamesForCall(run, step)` — is not a transport failure. It is persisted as one already-failed call (`status: "failed"`, `effect: "read"`, no preview, no `requiresConfirmation`, no approval) whose bounded `TOOL_NOT_AVAILABLE` envelope lists the names actually offered, and the run continues so the model can self-correct. Both transports therefore return such a name in `toolCalls` plus `unofferedToolNames` instead of rejecting it; duplicate, missing and oversized call identifiers still reject. Behaviour change: a round that mixes a valid `load_tool_groups` call with a never-offered call is no longer rejected atomically. The loader applies, the never-offered call is recorded as failed without executing, and that call cannot authorize the group it would have needed (`tests/toolLoading.test.ts`). The ledger's own round check keeps refusing a hand-crafted never-offered envelope that carries no pre-supplied failure (`saveToolRound` ~L118).
- Browser close can lose the last uncommitted tokens. Retry is a fresh model request, not exact restoration of an HTTP stream or hidden model state. Future remote jobs reconcile providerTaskId; never replay ambiguous paid submissions.

## 4. Validation & Error Matrix
| Condition | Result |
| --- | --- |
| Another tab owns thread | Refuse competing execution; preserve draft |
| Abandoned running record | Mark interrupted under acquired lock; retain checkpoint |
| Older checkpoint or terminal run | No overwrite |
| Missing run after delete | Reject checkpoint, no resurrection |
| Failed persistence | Abort and surface error; never report completion |
| Retry of old/completed/foreign run | Reject atomically |
| Changed provider/base URL or missing connector | Reject retry; invite a new message |
| Provider error contains key | Redact before persisting/displaying |
| Stream lacks completion | Failed with partial content retained |
| Model names a tool this request never offered | One failed call recorded, failure fed back to the model, run continues; no approval, no execution |
| Empty final attempt after a completed text step | Preserve the already-visible answer text instead of clearing it |
| Leaving a topic with an active run | Detach without execution confirmation/abort; preserve the original owner, saved output and explicit Stop |

## 5. Good / Base / Bad
Good: reopen an abandoned reply, see preserved partial text and a separate interruption notice, explicitly regenerate once.
Base: original response returns JSON; parse it without a second request.
Bad: mark every running row interrupted on mount, including a live tab's run; resend paid jobs after lost responses.

## One terminal writer `settleRun` (2026-10-13)

### 1. Scope / Trigger
Every path that ends an Agent execution: normal completion, model/transport failure, Stop, budget pause, explicit cancel and startup interruption. Read before adding a new terminal state or writing run/message status by hand.

### 2. Signatures
`settleRun(db: StoreTx, runId, status: Exclude<AgentRunStatus, "running" | "waiting_approval">, options): Promise<boolean>` in `features/agent/commands/agentRunTerminalState.ts`. `options` = `{output?, error?, finishReason?, pauseReason?, preserveOutput?, messageError?, allowedFrom?}`. `finishAgentRun` is the thin `agentRuns`/`chatMessages` wrapper over it.

### 3. Contracts
`settleRun` owns `status`, `error`, `finishReason`, `pauseReason`, `updatedAt`, `endedAt` and the assistant message's `content`/`reasoning`/`status`/`error`; it runs inside the caller's transaction so the ledger mutation, the run row and the message settle together. It applies the core `canSettleRun(status, allowedFrom?)` predicate, with default `running`/`waiting_approval`, so a second settlement never rewrites an ended run. `preserveOutput` keeps the visible text (cancel, budget pause); a supplied empty final attempt must not clear text already displayed by an earlier step, and the `SETTLED_MESSAGE_STATUS` map is the only run→message status mapping. `messageError` addresses the reader without inventing a run-level `error`; `pauseReason` is cleared unless explicitly supplied. `cancelAgentRun` and `pauseAtModelStepLimit` route through it, and cancel accepts the resumable states so a user can end interrupted/failed work. The core `modelStepLimitReached` predicate is shared by atomic pause/admission checks; `interrupted` vs `cancelled` is decided from one fresh `hasToolCalls` read.

### 4. Validation & Error Matrix
| Condition | Result |
| --- | --- |
| Already terminal run | No-op, no field rewritten |
| Missing assistant message / foreign runId | Reject; no partial write |
| Cancel of a running run | Reject and keep it running (Stop comes first) |
| Empty final output after a visible step | Keep the earlier text; do not blank the message |
| Budget pause | `pauseReason: "model_step_limit"` kept, run `error` unchanged, reader notice on the message |

### 5. Good / Base / Bad
Good: Stop, budget pause and explicit cancel all leave the same fields consistent and keep saved steps resumable. Base: a completed run ignores a later settle attempt. Bad: a second hand-written writer that sets run status without the message, or a new terminal path that forgets to clear `pauseReason`.

## E11 retained views and finite work owners (2026-10-16)

### 1. Scope / Trigger

Agent thread/page/history navigation and model, video batch, audio batch or AI task-wrapup ownership. This supersedes the earlier execution-only stop-before-leaving dialog and route-unmount abort. Manual dirty/pending/conflict and destructive deletion/clear protections remain independent.

### 2. Signatures

`runtime/threadWork.ts` defines the finite `AgentWorkIdentity` union (`model`, `videoBatch`, `audioBatch`, `taskWrapup`) and `reserveAgentThreadWork(store, identity, controller)`, `currentAgentThreadWork(store, threadId)`, `subscribeAgentThreadWork(store, listener)` and `shutdownAgentThreadWork(store)`. Batches use `reserveAgentBatchWork(store, identity, controller)` and `currentAgentBatchWorks(store, threadId)`, a separate registry keyed by batch id: a live batch does not make the thread `active`, does not block a model/wrapup reservation, and is stopped on conversation deletion via `stopBatchWork(threadId)` and on shutdown. A reservation follows the actual operation completion and exposes its exact owner, controller and `done`; it grants no durable execution capability.

`useChatExecutionSession(threadId, scope)` is a view adapter over the singleton's snapshots/attempt subscriptions. Named model/decision/recovery actions go through the application service. Existing generation runtimes retain their actual Web Lock and dispatch algorithms; do not acquire a second same-thread lock around them.

### 3. Contracts

Reserve a concrete thread before asynchronous preparation so different kinds of work cannot race within it. Different threads remain independent. Publish only a complete observable owner; exact Stop targets its original handle and cannot stop a newer operation. The original completion must include every worker, pending action and terminal publication; remove/publish the exact reservation before exposing completion to a next-command observer.

View cleanup only unsubscribes. Switching topics, opening settings/projects, new-topic creation and Back/Forward do not abort models, pause Agent batches, repeat startup recovery, approve work or dispatch a continuation. Project audio teardown pauses project-owned work only; it cannot adopt an Agent-owned batch. AI task-wrapup preparation belongs to the service rather than a mounted inspector; real manual edits and saves retain their existing guards.

First-thread creation records a receipt in the service. Navigation belongs to a still-matching view scope/attachment generation, never the service callback. A late A result may publish to A but cannot select it over B or restore/consume B's draft. A remount observes existing state without re-dispatch. Foreground optimistic presentation remains immediate and bounded; hidden work never waits for DOM/rAF acknowledgement.

### 4. Validation & Error Matrix

| Event | Required result |
| --- | --- |
| Navigate A to B/settings/project/history | A continues under the same original operation; B remains independent. |
| Stop A while B is active | Only exact A signalled; original A settlement awaited. |
| Model/wrapup/batch compete within A | Synchronous local refusal plus real held-lock exclusion; no second dispatch. |
| Agent audio batch while audio page unmounts | Agent owner continues; unrelated project-owned teardown remains. |
| AI preparation while inspector unmounts | Original request continues; no fake manual-pending navigation block. |
| Dirty/manual save/conflict on departure | Existing editor guard and original pending mutation remain authoritative. |
| Late first-thread receipt after attachment changes | Persist original receipt/output; no route or draft change in the new view. |

### 5. Good / Base / Bad Cases

Good: A's confirmed generation queue continues while B streams and the user edits settings; returning observes original identities. Base: an idle topic leaves without a prompt. Bad: hide the stop dialog while keeping a cleanup abort, recursively acquire the same Web Lock, or reconstruct a live Stop handle from saved IDs.

### 6. Tests Required

Retain requested-topic stale-read, optimistic canonical identity, whole-draft revision and manual editor tests. Exercise actual retained service/UI, held A/B model/tool operations, named wrapup/batch exclusion, exact Stop/original done and real generation runtimes. A finite real routed browser fixture must cover settings/project/Back/Forward and late creation without route stealing. Source callbacks are not proof of native background scheduling or installed OS behavior.

### 7. Wrong vs Correct

Wrong: an effect cleanup aborts `abortRef.current` or pauses all project batches when a view leaves. Correct: the view detaches; the finite original application owner keeps executing until explicit Stop/shutdown and actual settlement.

## 6. Tests Required
`agentRuns.test.ts`: atomic creation, no key snapshots, deterministic ordering, stale checkpoints, immutable retry context, incomplete history exclusion, deletion, exclusive ownership and abandoned recovery, v7 migration, write coalescing/failure and runtime terminal states.
`agentRunDefects.test.ts`: `settleRun` field parity and second-settlement refusal, the shared `runBlocksThread` predicate on both sides, budget pause, one-source interrupted/cancelled, and the start-hint append.
`agentUnavailableTool.test.ts`: an unregistered name and an offered-but-unloaded name each recorded as one failed call with the run continuing and the model receiving the bounded envelope.
`chatStream.test.ts`: split UTF-8/CRLF/events, protocol errors/completion, abort reader cleanup, exact POST count and redaction.
Existing connector/model-policy tests retain no-write-before-compatibility behavior. Browser smoke with a local fake provider must demonstrate interruption → explicit retry → reload with old and new answers preserved.

Transaction-aware fault injection must forward the complete typed command argument tuple. For example, a `transitionToolCall` spy may reject the completed transition, but every other transition must call `original(...args)`, preserving the caller's `StoreTx` and conditional claim callback. Forwarding only the former five arguments opens a second default-store transaction inside the actual held transaction on SQLite and can self-deadlock; an IndexedDB-only pass cannot establish that the seam is correct. Keep the original unknown-effect and zero-resubmission assertions and verify the whole affected file against the real native bridge without extending its deadline.

## 7. Wrong vs Correct
Wrong: `onDelta: () => void updateChatMessage(...)`, then independently save complete.
Correct: push snapshots into the serialized writer, await `flush()`, then atomically finalize message + run.

Wrong: `setTimeout` decides a background tab died and starts its request again.
Correct: probe the thread's Web Lock; if unavailable leave it alone; if available mark unfinished local execution interrupted without network traffic.

## E11 Stage 1: application execution owner (2026-10-16)

### 1. Scope / Trigger

Stage 1 introduced the headless service foundation. Stage 2 connects the foreground page and finite work owners under the retained-view contract above; navigation cancellation is removed together with actual ownership integration.

### 2. Signatures

`features/agent/runtime/agentExecutionService.ts` owns `createAgentExecutionService(binding: ChatExecutionBinding)`. The production singleton `agentExecution` is composed by `runtime/agentExecution.ts`; `initializeAgentExecution()` is called once after product storage and MCP initialization. The binding is `{store, locks?, fetchImpl?, registry?}` and invokes the existing Studio/core algorithm, not another scheduler or database.

Commands are `submit({attempt, modelMetadata?})`, `retrySubmission({threadId, userMessageId, modelMetadata?})`, `retry({threadId, runId})`, `resolveApproval({threadId, runId, callId, decision})`, `resume({threadId, runId})`, `cancelSavedRun({threadId, runId})`, `checkAdmission({threadId, userMessageId})` and `recoverAdmissionState({threadId, userMessageId})`. Execution commands return `{threadId, token, done: Promise<void>}`. `requestStop({threadId, token}): boolean` uses the exact opaque local token. `snapshot(threadId)` and `subscribe(threadId, listener)` expose immutable view state. `shutdown(): Promise<void>` closes admission and joins original work.

### 3. Contracts

Claim a thread synchronously before the first await, including model compatibility, first-thread creation and atomic admission. An observable reservation must support Stop even when subscribers react synchronously. Other threads may execute independently. Startup reconciliation is memoized for the actual service lifetime and is local/lock-aware; it never replays requests.

Keep the original `done` until transport, tools, writer flush and authoritative settlement finish. Stop publishes once, aborts only the matching invocation and retains the reservation until that original completion. Detaching listeners never aborts. A saved run/call must belong to the explicitly supplied thread. Approval refusal persists independently of connector availability; actual continuation resolves the current connector and credentials under the existing frozen-identity rules.

The service retains no API keys in snapshots or attempts. Errors exposed by snapshots use bounded product copy; actual errors remain with their original durable/result owner. A known pre-dispatch failure ends the local attempt instead of leaving it preparing. Unknown admission remains quarantined; a read, positive receipt or application startup cannot authorize dispatch.

### 4. Validation & Error Matrix

| Boundary | Required behavior |
| --- | --- |
| Same-tick second command for A | Refuse synchronously before dispatch; preserve the first owner. |
| A and B both held in model/tool work | Both original operations remain active; Stop A does not abort B. |
| Stop during compatibility/creation/begin | No late model dispatch; any already admitted run follows actual settlement. |
| Original terminal publication held | Reservation and Web Lock remain held until the publication settles. |
| Unknown admission followed by absent read | Stay uncertain; no begin/retry/dispatch. |
| Positive matching unknown receipt | Join accepted records and expose local recovery, with zero model requests. |
| Initialization fails before operation starts | Local submission becomes failed; release only the original claim. |
| Application shutdown called repeatedly | One closed admission state, exact Stops and one original drain promise. |

### 5. Good / Base / Bad Cases

Good: A finishes its actual held tool publication after its view detaches while B keeps receiving output. Base: an idle subscription returns the same snapshot until an actual service publication. Bad: use a route ID as execution identity, release on abort acknowledgement, or create another core loop for concurrency.

### 6. Tests Required

`tests/agentExecutionService.test.ts` must exercise actual Studio commands, ProductStore transactions, thread locks and shared runtime with held transports/tools/flushes. Cover synchronous admission, preparation Stop, detached creation, independent A/B, original completion, supplied-store recovery, approval association/refusal, unknown positive/absent reads and shutdown. The finite E11 source profile is `vitest.agent-background-source.config.ts`; full application/package/native acceptance remains separate.

### 7. Wrong vs Correct

Wrong: implement concurrency with an invented queue whose tests never invoke `beginAgentRun` or the actual writer. Correct: retain independent original Studio operations under their real per-thread capabilities, and prove held boundaries through the actual store/runtime binding.

## Bounded terminal finishing check (2026-10-10, narrowed 2026-10-13)

### 1. Scope / Trigger
A successful tool-free terminal answer from a smart run may receive one execution check only when the run already made tool calls, or has a validated plan with unfinished items. A plain Q&A reply (no tool calls, no unfinished plan) makes exactly one model request and is never moved into the process record. 2026-10-13 user decision: the earlier no-plan/no-tool fallback and the read-only final-reply claim review (`reviewFinalReply`, `AgentRun.finalReview`, `final_review` metric) cost extra paid requests and latency for ordinary chat, so the review chain was removed and the check was narrowed. Conversation, Stop, genuine input/approval boundaries and segment budgets remain authoritative.

### 2. Signatures
`saveAgentFinishingCheck(runId, expectedStep, output, responseOutput?, signal?): Promise<boolean>` persists `AgentRun.finishingCheck: {step, createdAt, reason: "unfinished_plan" | "terminal_reply"}`. `buildFinishingCheckPrompt(run, calls)` projects owned historical evidence. Historical records may still carry `finalReview` or `purpose: "final_review"` metrics; nothing reads or writes them.

### 3. Contracts
Require running smart mode, enabled tools, exact current model step, remaining segment budget and unchanged durable thread/project/task ownership. Every existing call must be completed and belong to this thread. New trigger rule: `calls.length > 0` or a validated plan with at least one non-completed item; otherwise return `false` without dispatch. If an `update_run_plan` exists, validate its atomic bookkeeping call, offered tool, original arguments and saved result against the current plan. A completed plan after tool calls can still be checked. The marker is durable once per run, including explicit resume.

Atomically preserve the original candidate as public activity plus assistant continuation and a fixed system check. Responses retains the exact validated envelope and opaque reasoning; public activity contains no encrypted content. Requests, permissions, Stop, metrics and normal tool loop remain intact. The prompt describes only the facts that tool calls happened or plan items remain unfinished; it adds no authorization, never reruns completed calls or resubmits generation. Project facts, direct receipts and plan steps are different evidence. Receipt projection caps at 20 entries and explicitly discloses omissions and uncovered calls. Advice/planning-only requests may finish without writes. This is bounded model self-checking, not guaranteed detection of every promise or false claim.

### 4. Validation & Error Matrix
| Condition | Result |
| --- | --- |
| Conversation, no tools, terminal/foreign/stale run or task | No check dispatch |
| No tool calls and no unfinished validated plan (plain Q&A) | No check dispatch; one request total |
| Failed/rejected/unsettled call or malformed/inconsistent saved plan | No check dispatch |
| Marker already exists or final segment step reached | No additional execution check |
| Tool calls exist (or unfinished plan), otherwise eligible | One normal-loop check allowed |
| Stop, persistence failure or invalid Responses envelope | No dispatch or partial mutation |

### 5. Good / Base / Bad Cases
Good: one user action request progresses from a premature candidate through an actual business tool. Base: plain Q&A finishes after a single request; advice-only prose after a plan finishes after explaining that no action was requested. Bad: ticking a plan counts as completion or bypasses generation approval; checking a plain chat answer.

### 6. Tests Required
`agentFinishingCheck.test.ts` and `agentFinishingCheckPrompt.test.ts`: both protocols, plain Q&A one request with no activity step, check once after tool calls, unfinished plan, advice, exact opaque envelope, once-only resumed runs, stale owner, final step and no replay. Runtime fixtures must assert the actual paid request count, usage and receipts; never turn the feature off or loosen assertions merely to preserve old counters.

### 7. Wrong vs Correct
Wrong: a no-call, no-plan answer always receives another request, or a saved plan authorizes more writes. Correct: persist one bounded evidence-based check only when tool calls or unfinished plan items exist, retain the original candidate, and let the normal permission/input/budget rules decide the next action.

## Contextual ownership and typed recovery (2026-10-10)

### 1. Scope / Trigger
Business and sound tools that omit project ownership, stale targets and execution failures across preparation, atomic local writes and paid submission.

### 2. Signatures
`frozenProjectScope(context)`, `resolveBusinessOwner(args, context)` and `requireBoundProjectScope(context, requestedProjectId?)` read durable run/thread scope. `ToolRecoveryError`, `toolFailureResult`, `readToolRecoveryFailure` carry `code`, `executed`, `effectCertainty`, `error`, `recovery`.

### 3. Contracts
An omitted owner/project resolves only from an exact validated durable run/thread binding. Explicit IDs are preserved and foreign targets reject; unbound business actions require an explicit owner, including `studio`. Never infer episode identity. Preserve raw model arguments and original approval envelopes; resolve a separate parsed argument copy.

Typed guard codes are PROJECT_REQUIRED/SCOPE_MISMATCH/NOT_FOUND, TARGET_NOT_FOUND/SCOPE_MISMATCH, EPISODE_REQUIRED/SCOPE_MISMATCH and STALE_TOOL_PREVIEW. Certainty comes from the actual boundary, never exception wording: preflight/read = `not_started`, proven atomic local rollback = `rolled_back`, ambiguous writes = `unknown`. Unknown effects have no invented success/failure result or automatic replay. A paid POST followed by a summary-read failure cannot be wrapped as atomic rollback. Stop is not a correction invitation.

### 4. Validation & Error Matrix
| Boundary | Result |
| --- | --- |
| Omitted owner, valid bound run | Resolve owner; original arguments unchanged |
| Explicit foreign owner or run/thread mismatch | Typed scope rejection before effects |
| Deleted project or target, absent episode | Typed actionable recovery; no replacement inference |
| Stale approved preview | Re-read/reprepare and renewed approval |
| POST may have happened, downstream read fails | Unknown; retain job/provenance, no resubmission |

### 5. Good / Base / Bad Cases
Good: correct an omitted bound project without asking to reopen the conversation. Base: studio action explicitly identifies studio. Bad: replacing a supplied foreign owner or assuming a caught paid error means nothing happened.

### 6. Tests Required
`agentContextualOwnerRecovery.test.ts`: bound/unbound/studio/foreign/deleted scope, no guessed episode, raw arguments and approvals retained, atomic result failure, real POST checkpoint followed by read failure, reopen and repeated resume with zero extra POST. Existing D05 historical schemas remain immutable with only explicit approved compatibility deltas.

### 7. Wrong vs Correct
Wrong: `catch (...) { throw new AtomicToolRollbackError(...) }` wraps the entire paid operation. Correct: wrap only actual preflight or atomic transactions; retain uncertain paid intent and expose its existing job for read-only recovery.

## D01 Agent query, selection and preparation boundaries

### 1. Scope / Trigger
Read when changing generation batch preparation/application, task edit commands or per-request tool offers. Command orchestration must not become the import owner of a read-only guard or pure selector. The three remaining value SCCs were removed on 2026-10-08; preserve this direction when adding callers. This was structural remediation, not a demonstrated initialization-crash fix.

### 2. Signatures
- `features/agent/models/agentToolSelection`: `getOfferedToolNames(run: Pick<AgentRun, "enabledToolNames" | "toolLoading" | "interactionMode">): string[]`, `toolNamesForCall(run: AgentRun, step: number): string[]`; discovery name `load_tool_groups`, loaded-tool ceiling `36`.
- `features/agent/commands/agentGenerationTarget`: `readGenerationTarget(target: ProductionTarget)` returns the owned entity, current slot, revision and label. It joins an existing caller transaction and opens none.
- `features/agent/commands/agentTaskGuards`: `editableAgentTask(id: string): Promise<AgentTask>` is a read-only guard; command owners supply their write transaction.
- `features/video/agent/generationPreparation`: `prepareGenerationSnapshot(raw: GenerationSubmitArgs, signal: AbortSignal)`, `loadGenerationInputs(job: AgentGenerationJob): Promise<MediaRecord[]>`, `resolveGenerationConnector(id: string, frozen?: Pick<AgentGenerationJob, "provider" | "baseUrl">)`. Batch uses `Awaited<ReturnType<typeof prepareGenerationSnapshot>>`; do not duplicate its structural return type.

### 3. Contracts
DB tool ledger, project creation and finishing check import the pure selector leaf directly. Discovery execution stays in `toolLoading`; its compatibility exports serve actual runtime/UI/test consumers, not DB reads. Conversation offers, legacy runs, dedup order, enabled ceilings and historical per-step offers remain unchanged.

Batch imports preparation and the DB target reader; runtime retains paid submit/poll/download/application and durable ownership. Task records and lifecycle commands import the task guard directly. Keep atomic ledger, record/history, batch and wrap-up commands in their existing owners rather than distributing them among readers.

Preparation performs abort/schema checks, draft flush and connector/profile validation before a short read-only target/media snapshot. Blob hashing and image-header inspection follow outside that snapshot and all write transactions. Application rechecks current targets inside the existing outer write transaction before nested slot writes and final ledger/history persistence. Readers must preserve Dexie transaction lifetime through every await.

### 4. Validation & Error Matrix
| Condition | Required behavior |
| --- | --- |
| Missing nonstudio project or foreign/missing entity | Reject before preparation/application mutation |
| Shot missing or foreign episode, missing slot | Preserve the existing target error; no inferred ownership |
| Missing task/thread, deleted project, preparing summary or busy run | Refuse manual edit; guard performs no writes |
| Missing/foreign/empty/wrong-kind input | Reject before hashing/transport; preserve existing message and check order |
| APIMart oversized reference or invalid MiniMax H3 format/header/dimensions | Preserve 20 MiB and model-specific checks outside writes |
| AIHubMix encoded inputs plus UTF-8 prompt and overhead exceed 32 MiB | Reject preparation without paid submission |
| Changed frozen provider/base URL or input revision | Preserve durable job and refuse replacement/replay |
| Abort or downstream ledger/history failure | Keep cancellation semantics or roll back the complete caller transaction |

### 5. Good / Base / Bad Cases
Good: prepare a confirmed batch outside writes, recheck targets in its application transaction, then commit slot/job/history together. Base: a studio asset has no project row and still uses the existing owner/slot checks. Bad: DB tool selection imports discovery registration, a target read imports the paid runtime, or a successful nested slot write survives a later ledger failure.

### 6. Tests Required
Use actual tool/loading/approval/finishing, generation/batch/recovery and task/record/wrap-up entry regressions. `d01DependencyBoundaries.test.ts` covers real leaf consumers; native `tests/fixtures/d01/harness.ts` proves hash/flush outside transactions, real single/batch application and guard recovery. Preserve native fault injection after nested slot/job writes, asserting shot/job/ledger/history rollback. AST must distinguish value/type edges and show no new static or literal-dynamic value SCC. Static comparison uses identical tool versions and separate complete baseline/current TypeScript programs; absent new baseline files are not source-rule errors. Native synthetic media proves exercised persistence, not decoding, providers or full product UI.

### 7. Wrong vs Correct
Wrong: move files while keeping DB callers importing the orchestration module, or hash a Blob inside the application write callback. Correct: import the meaningful reader/selector/preparation owner directly, prepare before writes, and preserve the existing atomic command and its final ledger/history validation.

## Typed tool and memory wire compatibility

Both preparation/approval and execution-claim boundaries use `toolMetadataMatches` for effect, computed risk, normalized atomic/recovery/confirmation. Typed tool arguments do not authorize metadata or replace durable ledger/transaction/paid recovery checks. Existing frozen offered sets and actionable model argument self-correction remain. See [D05](./agent-tools.md#d05-schema-linked-tool-protocol-2026-10-08).

## Shared generation capability boundary

Generation review, shared single/batch fields and project output settings use the actual dependency-free features/video/models/generationCapabilities.ts facts/projections. Request validation preserves provider lowering/error order and D05 typed schema output. Rendering cannot infer frame mode or silently repair an invalid proposal into authorization; target/input/revision/approval/paid-recovery owners remain. See [D06](./asset-output-foundation.md#d06-shared-generation-capability-contract-2026-10-08).

Provider transport sharing follows `ai-connectors.md` D07: explicit per-adapter browser/JSON policy, retained generic inline-image native parsing, HTTP authority and cancellation/redaction. Paid POST submission remains once-only; existing generic read/probe fallback and separately initiated GET recovery keep their own explicit policies. No shared request helper may replay an uncertain paid submission.
