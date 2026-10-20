# Capability registration and resource authority

## 1. Scope / Trigger

Read before changing the neutral registry, offered definitions, persisted tool
binding metadata, resource grant ports or an actual host's effect admission.
The public owner is `@momoki/agent-core`; concrete authority, storage,
credentials and effects belong to each host. Follow [runtime](./runtime.md) and
[the independent Todo host](../../agent-todo/cli/durable-host.md).

## 2. Signatures and owners

- `ToolBindingIdentity` contains `capabilityId`, reviewed `version` and
  `registrationId`. Optional `binding` is carried by `ToolDefinition` and
  `ToolMetadata`, including `RuntimeCall` and committed round metadata.
- `createCapabilityRegistry<Context, Preview>()` returns `register`, `snapshot`
  and `assertCurrent`. Registration returns an idempotent `dispose` handle.
- Package-internal `snapshotToolDefinitions` copies/freezes definition envelopes, binding and
  JSON parameter trees. Parsers and callbacks remain trusted host code.
- `RuntimeHost.request` receives `(run, signal, onDelta, offeredDefinitions)`.
  Core freezes the actual definitions before awaiting this request. The host
  must advertise those definitions for dynamic capabilities, rather than
  independently looking up current same-name implementations.
- `ResourceGrantPort<Fact>` supplies `prepare(request)` and
  `assertCurrent(snapshot, signal)`. A version-1 `ResourceGrantSnapshot<Fact>`
  contains `subject: {runId, callId, scopeId}`, exact `binding`, concrete `facts`
  and `{id, revision}` grant references. A reference is evidence to check,
  never authorization by possession.

## 3. Contracts

- Registration requires bounded nonempty identities, unique active capability
  IDs and tool names, and a generation that has never been used in that live
  registry. Disposal invalidates only its original registration. Calling an
  old disposer cannot remove a replacement.
- Preserve parser-inferred arguments and callback/preview/result relationships.
  Erase argument types only at the existing heterogeneous registry boundary.
  Tool construction captures the parser function; a changed schema property
  cannot silently select a later parser for an already constructed tool.
- The same frozen offer supplies advertised schema, parsed metadata,
  preparation and execution for the current round. Persist its exact binding.
  Fresh current-definition checks can refuse stale work; they cannot retarget
  it to a newly installed same-name implementation.
- Matching compares all three binding fields and bound/unbound presence.
  Changing or removing any binding invalidates a pending call. After restart,
  the host may attach only the exact durable installation generation.
- `RuntimeHost.tools.assertBinding(binding, signal)` is the core-enforced
  live-registration check. Core calls it after `assertScope` at every scope
  check (admission, after preparation, before approval park, fresh claim
  candidate) for any call carrying a `binding`, and fails closed (the call is
  failed before execution) when a host with bound calls does not provide it.
  Revocation therefore does not depend on `assertScope` host convention.
  `ResourceGrantPort.assertCurrent` is still host-called: grant facts are host
  vocabulary, so core cannot enforce them. Hosts gate every effectful or
  readable tool of a bound family with its own action fact (the Todo example
  grants `create`, `complete` and `list` separately).
- Check current scope/registration around asynchronous preparation, throughout
  the complete approval barrier and again before fresh execution claim. The
  actual host transaction must also check its own predicates; a preflight
  callback followed by an unchecked effect is insufficient.
- Resource prepare resolves already issued authority. It does not mint access,
  execute work or treat model output/permission mode as resource consent. Host
  snapshots retain immutable serializable facts and exact subject/registration.
  Keep credentials, process/file handles and mutable selectors out of them.
- Derived authority is a subset with exact live parent revision/ancestry.
  Parent revocation or replacement invalidates descendants. Regranting creates
  a new generation and cannot revive old child references.
- Revalidate subject, facts, binding and live authority inside the transaction
  that owns local mutation/evidence/completion. Revocation prevents new
  admission; it cannot establish that an already started effect was undone.
- Retain the 36-tool/two-group discovery bounds, unsettled-call pinning,
  32-step budget, serial rounds, mandatory confirmation before `full` mode and
  unknown-result no-replay semantics. No second loop or parallel scheduler.
- Studio MCP (E10) intentionally uses `createCapabilityRegistry` and
  `assertBinding` (frozen per-run offers, exact binding match, registration and
  snapshot-generation recheck at scope and claim) but not `ResourceGrantPort`:
  its resource authority is the saved single-use MCP execution facts rechecked
  in the claim transaction and in the native service. This documented
  divergence has equal registration/revocation guarantees (covered by
  `tests/mcpAgentSurface.test.ts`) and no shared grant vocabulary.
- This registry does not sandbox arbitrary JavaScript. Filesystem containment,
  process ownership, network/redirect checks and MCP server trust require
  concrete backend enforcement before those families are enabled. Todo deny
  fixtures are policy tests, not OS confinement evidence.

## 4. Validation and error matrix

| Condition | Required outcome |
| --- | --- |
| Duplicate active name/ID or reused generation | Reject registration without changing the active registry. |
| Caller mutates original schema or binding | Existing advertised snapshot remains unchanged. |
| Registration changes while model request or approval waits | Refuse old call; zero replacement execution. |
| Binding becomes missing or changes one field | Metadata mismatch; never repair with current identity. |
| Missing, foreign, revoked, stale or widened resource authority | Deny before business mutation/effect dispatch. |
| Parent revoked/regranted | Old descendants remain invalid. |
| Authority changes between preview, claim and transaction | Recheck at the actual boundary; zero local effect. |
| Atomic completion exists after a late failure | Reconcile durable completion; preserve it once. |
| Outcome is unknown | Preserve unknown; no automatic replay. |
| Unsupported filesystem/process/network/server fact | Explicit denial with zero corresponding effect dispatch. |

## 5. Good, base and bad cases

Base: existing Studio static tools remain unbound and keep their original
ProductStore/credential/confirmation owners. Good: another product registers
its own tool through the public root, prepares one concrete list/create fact
and checks durable authority inside its own atomic effect transaction. Bad:
replacement code receives a pending approval solely because its name matches,
or a `full` permission setting silently grants a directory or network endpoint.

## 6. Necessary checks and evidence limits

- Core source cases exercise duplicate/disposal/replacement, immutable schema,
  actual pre-request offers, approval identity and existing loop semantics.
  `tests/typecheck/agentResourceContracts.ts` retains public-root positive and
  negative type witnesses; core's own `types: []` noEmit project proves the
  neutral ambient boundary separately.
- `tests/agentTodoSource.test.ts` runs the real independent host/core/SQLite
  through the explicitly selected `vitest.agent-source.config.ts` on Node
  >=24.11. It must actually execute, not count a skipped SQLite suite as proof.
  Exact three public-entry aliases are test-only; default artifact freshness,
  production exports and packed consumption remain unchanged.
- Source tests and same-process database reopening do not establish emitted
  declarations, offline packed installation, actual CLI SIGKILL/recovery,
  Tauri/native acceptance, OS confinement or live provider behavior. Run those
  deferred gates at the owner's batch-end cadence and report them separately.

## 7. Wrong versus correct

Wrong: after awaiting the model, use `registry.find(name)` to choose which new
implementation an old response meant. Correct: retain the exact offered
definitions and binding, then reject if that installation is no longer current.

Wrong: `prepare` finds no grant and creates one to let execution proceed.
Correct: trusted host setup explicitly issues authority; prepare reads it and
the real effect owner checks the same frozen facts again atomically.
