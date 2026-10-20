# Reviewed batch generation and candidate selection

## 1. Scope / Trigger
Read before changing multi-target generation, paid dispatch, candidate comparison, media retention or task result evidence. This extends [creative tools](./agent-creative-skills.md), [execution ownership](./agent-execution.md) and [task wrap-up](./agent-task-wrapup.md). Source: `features/agent/models/agentGenerationBatch.ts`, `features/agent/commands/agentGenerationBatches.ts`, `features/video/agent/generationBatchRuntime.ts` and `features/agent/ui/AgentGenerationBatches.tsx`.

## 2. Signatures
- Tools: `prepare_generation_batch({title,candidates:GenerationSubmitArgs[]})` is atomic local bookkeeping; `read_generation_batch({batchId})` is a bounded read. They join the media-generation skill; conversation mode exposes no tools.
- Dexie v18 adds `agentGenerationBatches` and `agentGenerationBatchItems`. Jobs retain sparse unique `callId`, add sparse unique `batchItemId` and a `batchId` index. The job owner is a typed union: single call OR batch/item. Never create synthetic call IDs.
- Repository: `prepareGenerationBatch(title,candidates,context)`, `readGenerationBatch(id,threadId)`, `saveGenerationBatchDraft(id,threadId,revision,edits)`, `changeGenerationBatchItems(id,threadId,revision,itemId,'clone'|'remove')`, `confirmGenerationBatch(id,threadId,revision,signal)`.
- Review edits are `{id,draft,included}`. Read returns `{batch,items,jobs,currentMedia}`. Confirmation stores snapshots only; it performs no upload or POST.
- Execution: `batchUserAction(threadId,action,locks?)`, `startGenerationBatch(id,threadId,options?)`, `stopGenerationBatch(id,threadId,'pause'|'cancel',locks?)`. Aggregate Stop uses the current thread-work owner described in the E11 lifecycle contract below.
- Result actions: `selectBatchCandidate(id,threadId,itemId)`, `applyBatchSelections(id,threadId)` returning per-target `{targetKey,applied,error?}`, `retryFailedBatch(id,threadId)` returning a fresh unconfirmed draft.
- `TaskRecordSource` adds `{type:'generation',id:jobId}`; `taskGenerationSource(task,jobId)` returns owned current `{id,label,available,applied,body}`. Record and wrap-up transaction scopes must include jobs, batches, media and target tables.

## 3. Contracts
### Draft, identity and confirmation
One candidate means one independently tracked paid request. Constants are 20 requests per batch, four candidates per target slot and two active workers. All targets share an existing owner. Editable connector/model/prompt/parameters never change target/input identity. Validate the verified provider profile; no guessed fields or automatic provider fallback. Drafts are durable and revision-checked; original tool envelopes remain immutable. Full permission mode does not authorize paid batch submission.

Preparation writes the batch/items/tool result atomically with `submitted:false`; replay returns the saved batch. Confirmation revalidates current owners, targets, connector destination and input-byte revisions outside/inside the appropriate transaction, freezes all included snapshots or none, and preserves failed drafts. No network or Blob hashing inside IndexedDB transactions. Jobs contain no keys, Base64 or transient download URLs. Original batches uniquely own `sourceCallId`; retries retain `originCallId` and use a new batch/item identity.

Preparation preflight (limits, project scope, connector/profile, targets and input
snapshots) is part of the local failure contract: `prepareGenerationBatch` wraps
these failures in `AtomicToolRollbackError`, just like the final transaction.
The runtime returns the actual error as a failed tool result and lets the model
correct its next call in the same run. Do not classify a preflight rejection as
unknown paid acceptance. APIMart image aspect ratio belongs in `parameters.size`
(e.g. `"9:16"`); image requests reject `aspectRatio` and `mode` with correction
guidance. Never silently rewrite the original tool arguments.

`recoverBatchPreparationCalls(runId)` repairs only unknown, atomic,
non-high-risk `prepare_generation_batch` bookkeeping records without a saved
result or recovery/confirmation flags, under the thread Web Lock (this repair is about a tool call, not a batch worker). A matching,
complete owned batch restores the preparation result without creating anything.
An absent batch becomes a failed local preparation result with
`BATCH_PREPARATION_NOT_COMMITTED` and `submitted:false`; the original lost error
is not fabricated. A conflicting owner, incomplete batch or associated paid job
keeps the call unknown. Startup must discover parked failed/interrupted runs as
well as running ones; it reconciles local records without network or tool calls.
Cancelled/completed runs are not reopened. Resume still enforces latest-run and
ownership checks, and unknown network operations still block it.

Regression coverage: `agentBatchPreparationRecovery.test.ts` verifies actual
model-loop correction, no partial writes, result-ledger rollback, same-thread
historical recovery, existing-batch reuse, idempotency, foreign evidence,
network uncertainty, held locks and cancelled history.

### Queue and recovery
Hold the batch's own Web Lock (`cuepoint.generation-batch.<batchId>` for video/image, `cuepoint.audio-batch.<batchId>` for audio; `withGenerationBatchLock`) throughout dispatch, settling and pending UI actions. A batch never takes the conversation lock, so the conversation stays free to chat and its stop/pause/edit controls cannot be refused by a chat run. `batchUserAction(batchId, …)` and `stopGenerationBatch` are keyed by batch id. A local worker is eligible to host a UI action only after `ownsLock` is true. Merely registering a worker does not grant ownership. Claim item/job atomically and recheck immediately before paid POST. Reuse the shared single-generation transport; intentionally identical candidates may bypass equivalence blocking only within their confirmed batch.

Known failure may release a worker for independent work. Unknown acceptance pauses new dispatch. Set an in-memory pause latch before persisting the pause, so storage failure cannot permit further sends. Drain both workers with `Promise.allSettled` before releasing the lock; a rejected worker cannot abandon a sibling request. Once shared transport has been entered, a missing persisted provider ID is not proof of no POST. Never convert storage/transport ambiguity into a safe paid retry.

Reload/mount performs local reads and lock-aware recovery only. Explicit continuation queries/downloads known job IDs and dispatches only eligible saved unsent identities. Unknown attempts never POST again. Explicit pause retains the queue. E11 ordinary navigation detaches the view without pausing the application-owned queue; cancel marks unsent items cancelled while accepted/unknown jobs remain truthful. Retry definitively failed jobs into a new reviewed draft. No remote-cancel or refund promise.

### Selection, ownership and evidence
Selecting a candidate is local review, separate from writing it. Apply each entity's selected sibling slots in one transaction, recording previous/new result and before/after entity revisions. Trust only a continuous chain of this batch's own application writes. A→B→A and repeated same selection are supported; manual edits/deletion break the chain and block overwrite. Independent entity groups report separate outcomes. Single `apply_generation` and generic Agent result writes cannot bypass batch selection.

Retain all candidate outputs and application history. Stored batch drafts retain referenced input media, including cancelled history; cancellation resolves unsent work but does not erase records. Removing draft items or deleting the owning thread releases only those records' references; shared/selected business outputs remain protected. Deletion rejects late publication and includes new tables in transaction/cascade scopes. Execution history stays outside project ZIPs.

Draft bookkeeping never supports a result claim. Generation source evidence requires a task-owned batch job and real local media; current target media determines `applied`, so replaced candidates remain downloaded evidence. Open drafts, queued/active/unknown items block completion. Cancelled unsent history is resolved. Selection, queue, media and current-slot changes enter review fingerprints. A confirmed summary must be current before task completion.

### Interface
Use a persistent compact progress strip and a flat expanded review surface. Show exact request counts and fee warning; no invented price estimate. Save edits before confirming, preserve unsaved edits on errors, and separate pause/cancel/retrieve/retry actions. Keep video controls outside clickable preview buttons. Nested preview Escape closes only the preview; outer dialog Escape works after it closes. 390px layout must not overflow.

## 4. Validation & Error Matrix
| Condition | Required behavior |
| --- | --- |
| More than 20 items, five in one slot, foreign target/input | Reject before paid work |
| Stale draft/target/configuration/input revision | Preserve draft; reject confirmation atomically |
| Competing tab or unavailable Web Locks | Fail closed; no second dispatcher |
| Definite provider rejection | Mark failed; allow independent queued work |
| Lost POST response or acceptance write failure | Keep ambiguity; pause new dispatch; never automatic retry |
| Pause persistence failure | Local latch still blocks sends; drain workers before unlock |
| Accepted job interrupted/cancelled locally | Explicit GET/download continuation only |
| Manual target edit or missing target | Preserve candidate; report apply conflict |
| Deleted thread/project during remote work | No record/media resurrection |
| Missing result media or foreign task generation source | Reject verified result claim |

## 5. Good / Base / Bad Cases
Good: confirm four identical candidates, send exactly four requests with two active, reload with no HTTP, select A then B then A while retaining every output.

Base: one candidate works with the same reviewed provider fields as single generation; saved configuration is the actual submitted payload.

Bad: increase provider `n` to represent candidates, resume ambiguous POSTs, allow failed pause storage to advance the queue, or cite a successful draft tool call as delivered media.

## 6. Tests Required
- `agentGenerationBatch.test.ts`: strict limits, atomic preparation/confirmation, CAS, replay, identity, concurrency, unknown/retry, competing ownership, sibling slots/switching, manual conflicts, deletion/retention and task source provenance.
- `agentGenerationBatchSafety.test.ts`: acceptance/pause storage faults, sibling lock lifetime, accepted-job cancellation/retrieval and both provider video mappings with media bytes.
- Preserve all single-generation/recovery/review tests and migration/retention assertions.
- Native isolated IndexedDB fixtures: actual Chat/Responses tools; editable UI save/reload/confirm; exact POST counts; 20-item queue; 1440px/390px comparison; nested Escape; playable video; task A reviewed memory → actual task B request → batch evidence → reviewed completion.

## 7. Wrong vs Correct
```ts
// Wrong: durable pause may reject while another worker continues dispatching.
await persistPause();
await Promise.all(workers);
// Correct: stop locally first; retain ownership until every worker settles.
dispatchPaused = true;
await persistPause(); // Surface failure, retaining conservative persisted job state.
// The outer queue coordinator always drains with Promise.allSettled(workers).
```

Wrong: treat `job.status === 'applied'` or the original prepare tool response as proof of current target output. Correct: validate owned local media and compare the current target slot's media ID, then snapshot that evidence for review.

## Audit remediation contracts (2026-09-21)

Unsaved batch review edits and pending saves block SPA navigation as well as browser unload. An in-app dialog offers continue, discard, and save-before-proceed. Failed revision checks retain the local draft and route. Saving a draft never starts paid generation. Both single and batch result links use `generationTargetDestination`; shot destinations include the exact shot search parameter.


Audio voice batches use [their separate v24 contract](./audio-batch-arrangement.md), including the bounded existing clone-reference `Dexie.waitFor` check. This image/video spec retains outside-write Blob preparation.

## E11 retained Agent batch lifecycle (2026-10-16)

Use the finite batch-work reservation `reserveAgentBatchWork` from [execution ownership](./agent-execution.md) for actual video/audio Agent workers. It is keyed by batch id and never occupies the conversation's single execution slot (a conversation may chat while its batch dispatches; only one dispatching image/video batch per conversation is allowed). It is a synchronous local admission guard in addition to the batch's real Web Lock; it is not a second lock or authority reconstructed from a batch ID. Bind Stop and completion to the existing original worker/drain. Removing a subscriber, switching topics, unmounting Agent review and project-audio teardown cannot pause Agent-owned work. Project-owned audio keeps its existing separate teardown behavior.

Keep explicit confirmation/start/pause/cancel and existing original approval identity. Reattaching only reads current rows/owner state. Model and task-wrapup operations compete within one thread; batch operations do not compete with them, and independent threads proceed. The exposed completion cannot settle before siblings, pending review actions and final writes are finished and the exact reservation is removed. Actual generation/source and routed browser cases must prove these boundaries; native hidden-window scheduling remains a separate Stage 3 gate.

### Recovery under batch locks (queue task B5)
A batch still marked `running` is recovered (`recoverAbandonedGenerationBatch(batchId)`) only after probing its own lock with `ifAvailable`: a free lock proves no live worker anywhere, a held lock means the batch is alive and is left alone. This runs at startup (`recoverAbandonedRuns`) and when a conversation turn begins (`withThreadRunLock`); starting a turn never interrupts a live batch. An audio batch that is already confirmed stays dispatchable after the conversation moves on; only a draft must come from the newest turn.
