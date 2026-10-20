# @momoki/agent-core

Runtime-neutral Agent mechanisms. The package root exports built ESM and TypeScript declarations from `dist`; it has no runtime dependencies. Build with the repository's `agent:build` command before importing it. Normal application, test and native entry points prepare and verify these artifacts automatically.

`executeRun(initialRun, controller, host)` owns the actual request loop and two-pass pending-tool state machine. `RuntimeHost` supplies named owned reads, conditional commits, typed tools, one model dispatch and the sole terminal writer. A host must hold real exclusive execution ownership for the entire invocation. Completed atomic tools are confirmed from durable storage; an absent completion stays uncertain rather than being invented by a second write.

`validateToolInput` shares registry uniqueness, offered-name enforcement, the 32768-character raw limit and JSON/schema dispatch. The host supplies safe error constructors and keeps its own domain diagnostics. `requiresToolApproval` implements the shared permission matrix. Segment and terminal predicates are also shared; a host applies them inside its own transactions.

`compactContext` owns the bounded eight-pass whole-turn compaction loop; hosts retain prompts, source annotations, summary records and activation transactions. `createCapabilityLoading` / `selectCapabilityGroups` own loading selection, pending-call pinning and the 36-tool ceiling. Context policy normalization, token estimation, budget arithmetic, prefix verification and continuation-base replacement are shared mechanisms.

The extracted primitives include `createRunWriter`, reasoning accumulation (`createReasoningAccum`, `accumulateStreamDelta`, `finalizeReasoningAccum`), schema-linked `createToolFactory`, tool metadata validation and neutral execution/wire types. Studio binds the same loop to its existing store. The [independent Todo host](../../examples/agent-todo/README.md) binds its own SQLite schema and tools; the root `agent:example:check` command verifies packed public consumption and real process restart. Protocol implementations live in the separate [provider package](../agent-providers/README.md).

`createRunWriter(persist, onFailure, initialSequence?)` coalesces provisional output while serializing monotonic persistence calls. `flush()` waits for all scheduled writes and rethrows the original persistence rejection. A failed writer stops accepting output and calls `onFailure`, allowing its owner to abort model streaming. A host must flush before terminal settlement.

`createToolFactory<Context, Preview>()` binds a host's typed context and preview once. Each tool's parser determines its argument type; `highRisk`, `prepare` and `execute` receive that parsed output. Host services belong in the host's context, while the base execution context carries run/thread/call identity, an AbortSignal and the typed preview. The package does not define a database, product entity or global service locator.

Reasoning accumulation accepts an explicit clock value. It separates provisional reasoning from answer content and closes its timing on the first answer delta or finalization. Provider-private continuation is separate from these public output values.

An optional observer receives `RuntimeEvent` with `runId`, a host-supplied invocation `executionId` and an invocation-local increasing sequence. Output events are provisional; persistence notifications require confirmed accepted writes. Sequence resets for a new invocation and is not a durable cross-restart counter. Observer errors do not control durability, and events contain no private provider continuation.

Only declared root exports are supported. Cross-package source traversal and private imports are rejected by the actual repository architecture gate. Source mapping used by quality and unused analysis covers this exact root only; applications and isolated consumers load emitted files.
