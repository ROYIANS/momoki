# Runtime-neutral Agent Library

## Scope

`packages/agent-core` owns the reusable execution implementation and neutral
contracts consumed through `@momoki/agent-core`. Its public root resolves to
emitted ESM JavaScript and declarations. Host-specific persistence, coordination,
credentials, product policies and tool implementations stay with each consumer.
Core imports neither Studio nor providers; another application must be able to
bind its own typed services without adopting Momoki entities or storage.

## Guidelines Index

| Guide | Description |
| --- | --- |
| [Shared Runtime](./runtime.md) | Actual loop, typed host ports, ownership, atomic certainty, compaction and independent durable reuse. |
| [Capabilities and resource grants](./capabilities.md) | Versioned registration, immutable offers and host-owned concrete resource authority. |
| [Portable text skills](./skills.md) | Pure document/metadata/path/catalogue helpers; host-owned installation and progressive reads without authority changes. |

## Pre-Development Checklist

- Read [package boundaries](../../frontend/monorepo-boundaries.md),
  [type safety](../../frontend/type-safety.md),
  [quality](../../frontend/quality-guidelines.md) and
  [shared guides](../../guides/index.md).
- Read [shared runtime](./runtime.md) before changing public core or host APIs.
- Read [capabilities and grants](./capabilities.md) before changing registration,
  offered definitions, tool binding metadata or resource authorization.
- Read [portable text skills](./skills.md) before changing document validation,
  installed descriptors, catalogue serialization or resource pagination.
- Preserve the executable semantics in [execution](../../frontend/agent-execution.md),
  [tools and permissions](../../frontend/agent-tools.md) and
  [context](../../frontend/agent-context.md). These documents also describe
  Studio-owned policy; their product fields are not permission to add product
  dependencies to a core interface.
- Read [shared transaction certainty](../../frontend/shared-product-storage.md)
  before changing tool commitment or persistence contracts. Hosts implement the
  storage boundary; core must retain confirmed completion and unknown outcomes.
- Inspect the actual root export, both host adapters and emitted declaration
  closure before changing a shared type. Keep argument parsing tied to typed
  callbacks and validated preview/result extensions.

## Quality Check

- Core owns the actual execution algorithms. A host callback containing a second
  model/tool loop cannot establish reuse.
- No Studio/providers/application, React/Dexie/Tauri or Node-only import, ambient
  storage owner, product entity, untyped service dictionary or copied schema.
- ESM imports use valid `.js` resolution; the public export has emitted runtime
  and type closure. Workspace analysis may map exact public exports to source;
  production consumers and the isolated packed consumer use built artifacts.
- Register every source in types, lint, architecture, unused analysis and tests.
  Keep forbidden core/provider/product/private-path negatives effective through
  the actual CLI; public entry points do not make every source reachable.
- Exercise the same core implementation through direct semantic conformance,
  Studio browser/real-native integration and the independent durable SQLite
  consumer. Compilation or an in-memory adapter alone cannot prove restart,
  ownership, approval, atomicity or unknown-effect behavior.
