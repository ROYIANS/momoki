# Agent protocol library

## Scope

`packages/agent-providers` owns the existing Chat Completions and Responses
implementation and neutral HTTP mechanisms. It consumes core types and exposes
emitted ESM/declarations at `@momoki/agent-providers` and its explicit `/http`
entry. Hosts supply transport, credentials and materialized wire content.

## Guidelines Index

| Guide | Description |
| --- | --- |
| [Protocols and HTTP](./protocols.md) | Transport injection, continuation, bounded reads, abort, diagnostics and product bindings. |

## Pre-Development Checklist

- Read [protocols](./protocols.md),
  [package boundaries](../../frontend/monorepo-boundaries.md),
  [type safety](../../frontend/type-safety.md) and
  [shared guides](../../guides/index.md).
- Read the current protocol, C06 and D07 contracts in
  [AI connectors](../../frontend/ai-connectors.md), including their actual
  optional-diagnostic, native JSON and paid-submission policies.
- Read [core runtime](../../agent-core/library/runtime.md) and
  [execution](../../frontend/agent-execution.md) before changing continuation,
  current credentials, request budgets or host settlement behavior.
- Trace Studio's real reference materializer and runtime HTTP policy before
  changing the adapter. Provider reuse cannot bypass their current scope checks.

## Quality Check

- No Studio/apps, connector definition, reference entity, concrete storage,
  native runtime, React or Node-only import. Core remains an allowed dependency.
- Consume exact emitted exports; register root and `/http` source/artifact maps
  without production aliases or wildcard private access.
- Preserve one actual protocol implementation and one bounded reader/SSE/error
  class owner. A host adapter must perform real policy/materialization work.
- Verify actual request bodies/counts, opaque continuation, abort/reader cleanup,
  credential redaction and each caller's native/bounded JSON policy. Keep native
  transport integration and outside-workspace emitted-consumer checks.
