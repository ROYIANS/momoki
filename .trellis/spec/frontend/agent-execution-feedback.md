# Agent execution feedback and local timing

## 1. Scope / Trigger

Read before changing invocation phases, Stop acknowledgement, Studio runtime observation or response/DOM timing. Follow [Interaction Feedback](./interaction-feedback.md): use the existing composer/action surface, keep successful message bubbles quiet and show product language only when it helps the user. This feedback never authorizes execution or replaces durable state.

## 2. Signatures and owners

`features/agent/runtime/executionFeedback.ts` owns `createExecutionFeedbackController({onChange?, now?, timing?})`. `begin(invocationId, threadId?)` returns an invocation with `bindThread`, `admitted`, `provisionalCommitted`, `requestStop`, `release`, `publicCommitted` and a runtime observer. The controller supports `dispose`; a new invocation after StrictMode cleanup is valid, while old handles stay invalidated.

`publicCommitted({runId, assistantMessageId, kind, text}): boolean` returns true after this invocation's first eligible public commit has been recorded (including subsequent probes after that measurement). The UI remembers completion for that invocation and disconnects its observers, so later streaming text does not keep walking ancestors or reading computed styles. A false result leaves ownership/confirmation/visibility correlation pending.

`ExecutionFeedbackSnapshot` contains invocation/thread/run/assistant-message identity, a phase and an output revision. Phases are `preparing | waiting_model | receiving | working | waiting_approval | stopping`; they are internal projections, not instructions to display six labels.

Studio's `executeChatRun(..., ownership?, feedback?)` and `resumeChatRun(..., ownership?, feedback?)` accept the feature-private optional eighth `RuntimeExecutionFeedback` argument. Legacy callers remain unchanged. Studio adapts existing core output/checkpoint/tool/approval/settled events and its own actual preparation/main-request boundaries; no core or provider protocol is added.

E11 Stage 1's application service owns a separate feedback controller for each thread and begins feedback using that exact service invocation token. Feedback is prepared privately; only a fully initialized service reservation is published to synchronous subscribers. Unsubscribing a view neither disposes the controller nor requests Stop; application shutdown and exact explicit Stop are the lifetime owners. The foreground hook subscribes to the service. Keep its last exact feedback lineage available after release until replaced, so a delayed visible DOM acknowledgement is possible without another execution.

E11 separates the full transcript feedback reader from page/composer semantic
state. Subscribe `outputRevision` and public DOM lineage locally beneath the page
boundary; higher controls retain stable active/stopping/owner/attempt/coarse-label
projections. Moving only database queries is insufficient if a full feedback
snapshot still invalidates AgentChatPage on each token. Keep timing observations
independent from the durable observed-only read watermark.

## 3. Contracts

Invocation identity follows the existing synchronous execution token. Bind a newly created thread before navigation and admission. Ignore foreign run/thread/execution events, older core sequences and old invocation callbacks. Stop is a separate explicit user intent: publish `stopping` and disable repeat Stop before abort; do not infer user Stop from an aborted signal caused by persistence failure. Keep send/Web Locks until the original flush/settlement flow releases them. Existing conditional settlement is authoritative, including completed-before-late-Stop and unknown outcomes.

Preparing derives from captured intent/context preparation. Waiting starts when the actual selected main application fetch is invoked after validation/reference materialization. Receiving requires nonempty public answer/reasoning callbacks; tool fragments, empty frames and private reasoning do not count. Working/approval follow real operations and existing action owners. A new model/tool round can return to preparing/waiting. Reply advancement needs no additional per-message caption or timer.

Keep `preparing` internal: the immediate submitted message and existing pending/Stop control acknowledge the gesture. Do not show `正在准备…` or the rejected background `正在确认 APIMart 模型类型…` warning. A pending automatic model check remains silent while actual validation/send guards and resolved incompatibility errors are preserved.

Keep an owned invocation's normal post-reply flush/metrics/settlement quiet as well. Transport return alone does not emit `working`; actual tool-round/read operations own that phase. Historical `hasToolCalls` cannot prove current work. A retained query that still says `running` cannot resurrect the generic execution strip after this invocation releases. Existing actual tool/approval/compaction owners remain responsible for their meaningful actions; an unrelated/reloaded run follows its existing presentation. Show stopping text once in the strip and keep its disabled action label concise; the icon control retains its pending accessible name.

Wrap only the main transport, preserving the selected native/browser fetch, arguments, signal and current credential resolution. Auxiliary compaction cannot masquerade as the main request. Keep `createRunCredentials(..., !!originalFetchImpl)` based on the original explicit test transport; a diagnostic wrapper must not enable the injected-key fallback in production.

Timing is content-free and memory-only. Standard names start with an owner-local `momoki.agent.<trace>` prefix. Record separate marks for submitted intent, actual provisional DOM commit, known admission, main application fetch invocation, first public receipt, first confirmed output checkpoint, actual public DOM commit, Stop request, confirmed settlement and release. Missing facts stay missing. Existing provider metrics retain their original wall-clock/throughput meaning; do not subtract them from the monotonic diagnostic clock.

Retain at most eight traces and 256 owned marks/measures; evict/dispose exact owned names only. Feature-detect User Timing, contain sink/callback exceptions and never affect execution. No global application API, console dump, telemetry, storage table or new diagnostics screen. No content, credentials, URLs, references or raw error data enters timing names/detail. Ephemeral public text may be reduced to a local signature for correlation; never retain that text in the controller. Such signatures are diagnostic guards, not authorization or cryptographic identity.

First public DOM commit must match the current invocation's confirmed output lineage and actual run/message/kind. Resumed saved text cannot count as newly displayed output. Only current answer/reasoning owners participate; historical activity steps do not receive a probe identity. Otherwise an old step whose text happens to repeat the new checkpoint could create an early mark before the current query publishes. A probe checks the real rendered answer/open reasoning and its ancestor visibility/inert state. Folded or hidden chat behind narrow details cannot count until exposed; delayed observation after release can still record the matching commit until another invocation replaces its lineage. Sparse missing marks are preferable to invented display. A DOM commit/eligibility mark is not compositor pixel paint, remote receipt or proof of improved live latency.

Keep lightweight context/probe code free of eager rich Markdown dependencies. Define new dependency modules before wiring their consumers into a live working tree: an unresolved intermediate import can break the user's running Vite page even when final integration is planned. Verify module resolution directly when this seam changes; compilation/build packaging is a separate claim.

## 4. Validation & Error Matrix

| Situation | Required behavior |
| --- | --- |
| Held preparation | Exact E02 submitted content remains visible; existing control excludes duplicate sends; no preparation/model-confirmation caption |
| Main request invoked / no first public output | Existing owned waiting surface may explain actual waiting, without another bubble caption |
| Explicit Stop before admission or during output/flush | Immediate stopping acknowledgement, one abort/pause gesture, lock retained through actual result |
| Late phase event after Stop | Cannot replace stopping or release the lock |
| Plain answer returned; final flush pending, or released invocation with old running query | No generic execution caption flashes after the answer; current invocation ownership excludes stale fallback |
| Completed state committed before Stop | Actual completed outcome retained |
| Unknown admission/persistence | Existing E02 uncertainty and durable error contracts apply; no false settled mark |
| Same run resumed with old text | Old text is excluded from this invocation's first-public-display mark |
| New output repeats text in an older activity step | Historical step is not a sampling owner; only the current public body can count |
| Folded/inert/hidden public subtree | No display mark until actually eligible |
| Diagnostic clock/sink/observer fails | Execution and existing error handling continue unchanged |
| Another token/run/thread or stale sequence | Ignore diagnostic callback; never overwrite current feedback |
| View unmount or StrictMode effect replay | Detach observation only; original service flow and feedback remain owned. Only true owner disposal invalidates its handles |

## 5. Good / Base / Bad Cases

Good: Stop immediately disables its button and acknowledges waiting for the actual final flush; partial output and completed effects remain. Base: one main request records distinct receipt/checkpoint/DOM boundaries using the existing selected transport. Bad: label every user bubble with internal phases, use request construction as network dispatch, count old saved text as new first display or release ownership on the Stop click.

## 6. Necessary verification

Use deterministic controller clocks/sinks for token ownership, sparse marks, stop precedence, repeated model/tool rounds, bounded retention, exact cleanup and diagnostic failure isolation. Verify both protocol public callbacks and actual selected transport invocation without another request or changed credentials.

Exercise actual session/page callbacks with held preparation, begin and flush: immediate repeat-safe Stop, no post-abort admission/dispatch, newer draft retained and late terminal result authoritative. Actual DOM tests must distinguish matching confirmed output from old resume content and folded/inert/hidden subtrees. Preserve E02's no-normal-caption, canonical join and lazy fallback tests. Run necessary affected tests/types/lint/architecture under the owner's batch cadence; full builds/package/native/live timing evidence remain distinct.

## 7. Wrong vs Correct

Wrong: show waiting from `run.status === 'running'`, treat every abort as a user Stop, or report `metrics.firstTokenAt` as the first visible answer.

Correct: project actual invocation boundaries, track explicit user stop intent, retain original ownership until authoritative completion and record public receipt, confirmed checkpoint and visible DOM separately. Use those measurements to justify any future publication optimization; no live-text overlay is selected without evidence.
