# Shared execution and host bindings

## 1. Scope / Trigger

Read before changing the public core runtime, a host binding, tool commitment,
context compaction, capability loading or execution ownership. The core package
owns the actual model/tool and compaction algorithms; Studio and the independent
SQLite example supply their own persistence and policies. Follow the canonical
[execution](../../frontend/agent-execution.md),
[tools](../../frontend/agent-tools.md),
[context](../../frontend/agent-context.md) and
[transaction certainty](../../frontend/shared-product-storage.md) contracts for
the existing product behavior. No public API stability or publication is implied
by these private workspace packages.

## 2. Signatures and Owners

- The public `executeRun(initialRun, controller, host): Promise<void>` and its
  internal `executePendingTools` algorithm are implemented in
  `packages/agent-core/src/runtime.ts`. Their shared type parameters are
  `Run extends RuntimeRun`, `Call extends RuntimeCall<Preview>`,
  `Context extends ToolContext<Preview>`, `Preview` and `Continuation`.
- `RuntimeHost<Run, Call, Context, Preview, Continuation>` supplies held ownership,
  named persistence operations, context preparation, one model request, tool
  bindings, error classification and terminal settlement. `RuntimeRun` carries
  execution identity/status/checkpoint and model-step/permission state, without
  product fields or a concrete database.
- Its model `request(run, signal, onDelta, offeredDefinitions)` receives the
  exact copied/frozen definitions selected before the request. Dynamic hosts
  advertise that offer; metadata and execution remain bound to it. See
  [capabilities and grants](./capabilities.md) for registration generations and
  the distinction between tool approval and concrete resource authority.
- `RuntimeHost.checkpoint(...): Promise<boolean>` returns whether the requested
  checkpoint was actually applied. `settle(...): Promise<AgentRunStatus>` returns
  the durable retained status, which can differ from a late requested transition.
  Keep Studio's original conditional/no-op writers as the transaction authority.
- `createToolFactory<Context, Preview>()` binds typed host services and preview
  once; each definition infers parsed arguments from `ToolSpec<Args>` and keeps
  its own typed result. Only heterogeneous dispatch erases argument types, with
  each definition retaining its own parser and callbacks.
- `validateToolInput(name, raw, enabled, registry, errors)` owns duplicate-name
  rejection, lookup/offered-name enforcement, the 32768-character raw bound and
  JSON/schema dispatch in that order. Typed host error constructors retain
  unavailable/size/domain diagnostics and the parsed value/original cause;
  Studio's safe Zod presentation does not enter core.
- `requiresToolApproval(mode, tool, args)` owns the shared ask/assist/full
  matrix, including explicit confirmation. `modelStepLimitReached(run, limit?)`
  and `canSettleRun(status, allowedFrom?)` own shared segment/terminal predicates;
  hosts revalidate and apply them inside their existing transactions.
- `compactContext(host, signal)` and `CompactionHost<Run, Source, Record, Input,
  Usage>` in `compaction.ts` own the bounded eight-pass summary loop.
  `groupContextHistory(history)` and `selectHistoryByCount(history, count)`
  preserve complete user turns. `isContextSourcePrefix(prefix, history,
  sameMetadata)` checks exact ID/role/content plus host-specific provenance;
  `replaceContinuationBase(current, previous, next)` verifies the old base and
  retains the complete opaque suffix.
- `normalizeContextPolicy`, `estimateTokens` and `budgetEnvelope` in
  `contextBudget.ts` own deterministic defaults and shared budget arithmetic.
  Hosts supply verified capacity and explicit materialization costs; Studio adds
  its existing per-reference-image cost without exposing reference entities.
- `createCapabilityLoading`, `selectCapabilityGroups`, `offeredToolNames` and
  `offeredToolNamesForCall` in `capabilities.ts` own neutral catalog selection,
  the 36-tool loading ceiling and exact per-step offers. Catalog content and
  durable loading/result commitment belong to the host.
- Studio's `createStudioRuntimeHost` binds these contracts to its existing
  ProductStore. `executeChatRun` / `resumeChatRun` compose that host with the
  shared core loop. `runOwnership.ts` owns `ThreadOwnership`,
  `withExecutionOwnership`, `withOwnedExecution` and `withThreadRunLock`.

## 3. Contracts

- Core has no Studio/provider import, product entity/schema, React, Dexie,
  Tauri, Node-only API or concrete storage. Generic parameters preserve real
  typed host context, preview, summary source and continuation relationships;
  an extension dictionary or service locator cannot hide those dependencies.
- The pending-tool algorithm first validates the complete approval barrier,
  then freshly reads and claims each execution candidate. Both passes check
  AbortSignal for every item. Completed/failed/rejected snapshot entries remain
  immutable history and need no extra point read. Original nonterminal
  candidates require current call/run, metadata, offers and permission checks.
- Host claims check the expected current execution/call/step/approval/offer
  predicates in the same transaction that moves pending/approved to running.
  The complete frozen wire arguments and user-reviewed override stay distinct.
  Studio has no general run revision/owner column: its opaque capability is
  bound to the actually held thread lock, expires with that callback and admits
  one execution at a time. Preserve the product schema. Another host may own
  explicit durable revisions in its independent schema.
- Local atomic tools validate/serialize their result and evidence inside the
  business transaction and save completed there. Core consumes that confirmed
  completion once. A missing atomic completion cannot be repaired by a second
  unrelated success transaction. A later throw first reconciles durable
  completion; a failed confirmation read preserves unknown certainty. Only a
  proven transaction rollback authorizes `rolled_back`.
- External intent/job identity is durable before dispatch. Unknown submission
  never permits automatic replay; cancellation cannot claim remote cancellation.
  Recovery runs under actual ownership and makes zero network submissions.
  Explicit resume reuses confirmed calls and frozen approvals/settings.
- Pending user input is admitted only at that loop-top seam: every tool result
  of the previous round is already saved (or no request has been made yet).
  Never insert a user turn between an assistant `tool_calls` message and its
  tool results (it breaks both chat-completions and Responses envelopes), inside
  an open round (`commitRound` before `appendResults`), while the run is not
  `running` (approval parking, interrupted), while any call is `running` or
  `unknown`, into the frozen base prefix or before an already persisted
  assistant round. Studio's `injectSteerInputs` mirrors each admitted message
  into `continuationMessages` and `responseItems` and stamps it with
  `sourceQueueItemId`, which every provider wire conversion strips.
  `responseRoundMatches`/`claimFingerprint` count only `function_call` items, so
  the extra `message` item does not disturb envelope validation.
- Core serializes/coalesces output and flushes before settlement. The host's
  sole conditional terminal writer owns run/message/ledger consistency, ignores
  late terminal attempts and preserves earlier visible output. Studio keeps
  `settleRun` as that existing writer. All model and finishing-check requests
  consume the same 32-step segment budget.
- After flushing provisional output, error cleanup rereads the durable run
  before marking tools unknown or settling. A successful read confirming
  absence ends cleanup without writes or a confirmed settlement event. A failed
  lookup is not evidence of deletion and must propagate. Existing runs retain
  the host's strict ownership/step/claim predicates and sole terminal writer;
  do not catch every guard failure as if the run had disappeared.
- Core compaction chooses whole historical turns, protects current input/live
  tool chains, verifies previous summary coverage, persists a summary job before
  HTTP, requires a shorter valid result and activates against the unchanged
  durable base. It never performs a ninth automatic summary request. Hosts own
  product source annotations, prompts, scope checks and activation transactions.
- Studio resolves each current credential at both main and auxiliary dispatch,
  validating the frozen connector identity/base URL. Keys and encrypted provider
  continuation never become public execution data. The provider/host validates
  continuation; core carries its exact typed value without reconstructing it
  from visible chat text.
- `RuntimeHost.executionId` identifies one invocation; optional `observe` receives
  `RuntimeEvent` with `runId`, `executionId` and an invocation-local increasing
  `sequence`. Sequence resets on a new invocation and is not a durable revision
  or a cross-restart counter. `output` is explicitly provisional. Checkpoint,
  tool-round/completion, approval and settlement notifications are confirmed
  only after their corresponding durable operation is known to have succeeded;
  an ignored/no-op write cannot confirm an unsaved payload. Settlement reports
  the actual retained status, including a prior terminal result. Observer
  failures cannot control execution or undo a committed result. No event carries
  credentials or opaque provider continuation.

## 4. Validation and Error Matrix

| Condition | Required outcome |
| --- | --- |
| Forged, expired, wrong-thread or concurrently reused Studio ownership | Refuse before resume/context writes or model/tool dispatch. |
| Call, approval, metadata or offered envelope changes before claim | Refuse the claim atomically; zero tool execution. |
| One call still awaits approval | Park the complete round; no later call executes. |
| Local result/receipt serialization fails before COMMIT | Business writes and completion roll back together. |
| Completed result exists after a late error | Preserve and reuse it; no second invocation or completion overwrite. |
| Commit acknowledgement or confirmation read is uncertain | Keep unknown; no invented rollback or external resubmission. |
| Durable run is confirmed absent during error cleanup | No cleanup write or confirmed settlement event; a failed read still propagates. |
| Thread/run/message is deleted or already terminal | No resurrection or late output overwrite. |
| Summary prefix/source/activation scope is stale | Refuse activation; preserve original base and opaque tail. |
| Eight summary passes still need compression | Save completed summaries and stop for explicit continuation. |
| A connector key rotates or frozen identity changes | Read the new current key; reject a changed identity before dispatch. |

## 5. Good, Base and Bad Cases

Base: a tool-free answer uses one shared core execution and one provider request.
Good: an independently defined todo tool commits its own entity and call result
together; process restart retains that result, and explicit resume asks only for
the next model step. Good: Studio supplies creative context and finishing policy
while the shared core still owns subsequent execution. Bad: a host callback
contains another model/tool loop, pretends a timeout proves death or treats a
caught external error as rollback.

## 6. Tests Required

- Direct neutral conformance exercises approval barriers, fresh claims,
  primitive typed previews, cancellation, atomic rollback/unknown/late committed
  results, output ordering/flush, terminal selection, capability pinning and
  exact compaction bounds/prefixes/continuation.
- Retain actual Studio deleted-run/tool/network regressions. Direct core
  negatives must distinguish a confirmed absent run from a rejected lookup:
  absence produces no cleanup/settlement event; failed reads propagate and
  cannot authorize a success notification or invented terminal status.
- `packages/agent-core/src/runtime.test.ts` covers neutral execution semantics;
  `tests/agentRuntimeOwnership.test.ts`, `agentRuntimeCredentials.test.ts` and
  `agentRuntimeClaimRaces.test.ts` exercise the actual Studio binding, including
  forged/released/reentrant ownership, last-moment claim races and current
  main/auxiliary credentials. Register new suites in formal browser/native
  discovery rather than inferring coverage from a standalone unit invocation.
- `runtime.test.ts` also covers the optional pending-input hook: call order
  (pause/limit, admit, prepare), the forwarded abort signal, the returned run
  reaching `prepareContext`, unchanged behavior when the host omits it, and no
  call after a limit pause. `tests/agentSteerInjection.test.ts` covers the real
  Studio binding for both protocols.
- Actual Studio regressions retain `agentRuns`, `agentTools`, ownership,
  credential rotation, contextual recovery, tool loading, context management,
  finishing and protocol assertions through browser and real native storage.
  Keep the 64-tool/32-request fixture and its original deadlines/concurrency.
- The independent SQLite host uses the same built core loop with its own tools,
  schema and approval model. Exercise actual process kill/reopen, zero-network
  startup recovery, explicit resume, duplicate/stale owners and unknown effects.
  Memory adapters and package compilation cannot establish durable acceptance.
- The outside-workspace consumer installs locally packed public artifacts,
  compiles their emitted declarations without source aliases and runs without
  Studio or workspace source access. Keep actual forbidden-import CLI negatives.

## 7. Wrong Versus Correct

Wrong: `host.execute()` contains the old Studio loop, and the example implements
its own similar loop. Correct: both hosts call the same `executeRun` and provide
named semantic operations for their own storage and policies.

```ts
import {executeRun} from '@momoki/agent-core';

// This caller has acquired the host's real execution ownership.
await executeRun(run, controller, host);
```

Wrong: `tool.execute()` returns, then core separately marks an atomic write
completed. Correct: the host commits effects/evidence/validated completion in
one transaction, and core consumes that confirmed result.

Wrong: a frozen `apiKey` argument serves every request in a multi-step run.
Correct: the Studio host resolves current credentials at each actual main and
summary request while preserving frozen connector identity and model settings.
