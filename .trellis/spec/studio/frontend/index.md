# Shared Studio Frontend

## Scope

`packages/studio` owns the shared Momoki product used by browser and desktop. Existing canonical product contracts remain under [frontend](../../frontend/index.md); this index selects them without duplicating their content. Application boundaries are established; Studio sources follow [vertical feature ownership](../../frontend/feature-organization.md). Agent execution and protocols use the public [core](../../agent-core/library/index.md) and [provider](../../agent-providers/library/index.md) packages; Studio owns their product bindings and creative behavior.

## Pre-Development Checklist

- Read [directory ownership](../../frontend/directory-structure.md), [component contracts](../../frontend/component-guidelines.md) and [type safety](../../frontend/type-safety.md) before changing their owners.
- Read [feature ownership](../../frontend/feature-organization.md) before moving vertical modules, exposing feature entries or changing app/platform/product integration. Keep the actual ownership policy and every source consumer synchronized with a relocation.
- Read [shared storage](../../frontend/shared-product-storage.md), [native runtime](../../frontend/native-product-runtime.md) and [query hooks](../../frontend/hook-guidelines.md) for persistence/integration work. Keep one fixed storage owner and propagate explicit transactions.
- Read [Interaction Feedback](../../frontend/interaction-feedback.md) before adding loading/progress/success/recovery UI; keep ordinary success quiet and internal phases out of product copy.
- Read [Creative operation feedback](../../frontend/creative-operation-feedback.md) before changing library create/delete or file import; preserve acknowledged receipts, uncertain intent quarantine and serial next-file stop.
- Read the relevant business/Agent contracts linked by the canonical frontend index before editing that feature. Full specs may require chunked reads beyond injection limits.
- Read [Agent business details](../../frontend/agent-business-details.md) for finite shot/asset-link activation, retained batch-review handoff and aggregate editor departure; keep execution and real feature editing with their existing owners.
- Read [Agent send recovery](../../frontend/agent-send-recovery.md) for immediate submitted content, whole-draft restoration, reserved identities and unknown-outcome reconciliation.
- Read [Agent execution feedback](../../frontend/agent-execution-feedback.md) for invocation-bound phases, repeat-safe Stop and private timing; preserve existing runtime ownership and quiet successful messages.
- Read [Agent topic reading](../../frontend/agent-thread-reading.md) for requested-topic query envelopes, owned departure and local return-to-latest; preserve the execution/composer owner.
- Read [Agent jobs and retained reports](../../frontend/agent-jobs-results.md) for foreground progress, original completion publication, separate current-reader/historical-row scope, quota, paging, cleanup and truthful Stop/drain.
- Read [granted desktop media import](../../frontend/desktop-media-import.md) for native directory/video grants, prepared claims, import receipts, truthful process Stop and source/thumbnail lifecycle.
- Read [installed text skills](../../frontend/agent-installable-skills.md) for bounded local packages, strict device-setting CAS publication, immutable revisions and progressive reads without tool authority.
- Read [MCP connections](../../frontend/agent-mcp.md) for strict device catalogue/private revision boundaries, frozen discovery/schema/groups and finite native host authority; preserve stage/actual-host evidence limits.
- Before changing an Agent binding, read the actual core/runtime and provider/protocol contracts. Keep current credential, reference, native transport, ownership and transaction policy in Studio while invoking the shared algorithms.
- Read [quality](../../frontend/quality-guidelines.md) and [shared guides](../../guides/index.md); update discovery when moving sources.

## Quality Check

- Browser and desktop consume one shared implementation through declared exports; studio never imports an application package.
- Existing product behavior, routes, typed data flow, atomic writes and real-store regressions remain intact.
- Type, formal lint/architecture/unused checks and tests discover all owned sources; no cross-package private alias or relative traversal bypasses exports.
- Run root quality/build/model/test gates and relevant native/app commands; distinguish actual host checks from compilation.
