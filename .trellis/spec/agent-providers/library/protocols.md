# Protocols, continuation and host transport

## 1. Scope / Trigger

Read before changing the shared chat protocols, HTTP exports or a host binding.
The current package extracts existing behavior; it does not add a provider,
endpoint, retry policy or product persistence owner. Canonical protocol, C06 and
D07 behavior remains in [AI connectors](../../frontend/ai-connectors.md).

## 2. Signatures and Owners

- The root exports `streamChatCompletions(input, handlers)`, `streamResponses`,
  `decodeResponseOutput` and `toResponseInput`, with their typed input/result
  contracts. `wire.ts` owns `ChatMessage`, `ChatRequestMessage`, explicit content
  parts, `ResponseItem` and materialized `ResponseRequestItem`.
- `responseRoundMatches(items, calls, ordered)` checks the received round or
  durable call ledger against exact call IDs, names and argument strings.
  `appendResponseToolResult(items, callId, result)` reuses an identical saved
  output, rejects duplicates/conflicts or a missing paired call, and otherwise
  appends the output to the caller-owned array. `responseContinuationTokens`
  estimates opaque reasoning context cost. These helpers perform no persistence;
  Studio calls them inside its existing transaction/context paths.
- Both dispatch handlers require `fetchImpl: typeof fetch`. Optional
  `validateRequest` supplies synchronous host policy. `materializeMessages` or
  `materializeItems` returns typed wire content under the request's AbortSignal;
  materialization runs inside the existing measured/guarded request path.
- `/http` exports bounded response readers, `ResponseLimitError`, `readSseEvents`,
  `normalizeBaseUrl`, `redactCredentials`, `requestOnce`, `readHttpJson` and the
  shared 4 MiB JSON / 64 KiB error budgets. `requestOnce` requires transport,
  credentials and redirect explicitly. `HttpJsonReadPolicy` selects native or
  bounded parsing independently for success and failure.
- Studio's `features/agent/providers/{chatStream,responsesStream}.ts` binds
  connector/reasoning policy, reference materialization and `runtimeFetchFor`.
  Studio's `platform/http/requestBoundary.ts` supplies runtime-purpose transport
  selection to neutral `requestOnce`. Media/audio/speech budgets remain product
  policy in `platform/media/limits.ts`.

## 3. Contracts

- Providers import only neutral/core contracts. No project/run identifier,
  connector definition, image provenance, ProductStore or browser/native
  selection is required by the public provider input.
- Hosts resolve current credentials before each main and auxiliary dispatch and
  validate frozen identity/base URL. The provider uses that one request key and
  redacts its diagnostics; it never owns a credential store or run-long snapshot.
- Transport is explicit. Missing transport cannot silently select global fetch.
  Studio retains its authorized native HTTP purpose and fail-closed behavior;
  a denied native request cannot fall back to browser networking.
- Preserve one POST per chat operation, original payload/header/signal policy,
  validation/materialization ordering, latency metrics, partial deltas and
  handler behavior. Abort during materialization must prevent dispatch.
- Responses continuation retains its validated opaque reasoning/encrypted
  content, call IDs, order and exact argument bytes through durable checkpoints
  and compaction. Core carries it opaquely. Studio-only reference/source
  provenance is added by its adapter and stripped when materializing the wire;
  it never becomes provider protocol data or public execution events.
- Only authoritative completed envelopes dispatch tools. Partial argument deltas,
  duplicate IDs, malformed/unknown items and mismatched terminal events preserve
  existing failure rules. Responses saved diagnostic statuses use their existing
  allowlist; arbitrary Responses status strings cannot enter durable
  `finishReason`. Chat Completions retains its existing redacted/bounded
  finish-reason handling rather than acquiring the Responses allowlist.
- The shared reader owns actual-byte bounds, UTF-8/surrogate accounting, reader
  cancellation/release, abort detection and `ResponseLimitError` identity. It is
  also used by existing non-chat consumers; extracting chat cannot leave copied
  readers or conflicting error classes behind.
- Preserve per-caller native versus bounded JSON consumption. Inline image JSON
  does not acquire the ordinary 4 MiB cap. Product audio remains 32 MiB, protected
  media downloads 256 MiB and speech envelopes retain their existing formula.
  A known non-2xx status remains authoritative if optional diagnostics fail;
  success/abort failures propagate, and uncertain paid effects do not authorize
  another POST. Redact before the original caller-specific truncation.

## 4. Validation and Error Matrix

| Condition | Required outcome |
| --- | --- |
| Invalid host connector/reasoning/reference scope | Zero dispatch; retain existing safe error/abort result. |
| Missing explicit transport | Refuse; no global/browser fallback. |
| Native authorization denies a request | Preserve denial and purpose; no alternate transport. |
| Stream/read/materialization abort | Preserve abort classification and cleanup; retain already confirmed output. |
| Exact/over byte bound or split multibyte delta | Preserve exact acceptance/accounting and reject before unsafe delivery. |
| Partial/malformed Responses tool envelope | No tool dispatch or second POST. |
| Checkpoint/compaction of opaque continuation | Retain validated bytes and paired calls; no reconstruction from visible text. |
| Unknown Responses diagnostic status or key-bearing error | Omit arbitrary Responses saved status; redact the full diagnostic before bounding. |
| Non-2xx diagnostic body cannot be read | Preserve observed HTTP status; propagate abort. |

## 5. Good, Base and Bad Cases

Base: an independent host supplies plain wire messages and a fetch transport to
the same shared adapter used by Studio. Good: Studio materializes verified image
pixels at dispatch while providers see only typed wire parts. Bad: copying the
protocol loop into a product adapter or moving product authorization into the
neutral transport package.

## 6. Tests Required

- Run existing Chat Completions/Responses suites against actual product bindings
  and direct public built-package protocol tests. Keep exact bodies, calls,
  continuation, malformed terminals, abort, partial output and redaction checks.
- Keep C06/D07 tests through the single shared HTTP owner, with native and
  bounded policy assertions. Assert actual body access at the response boundary;
  spying on a re-export cannot intercept an internal module reference. The D07
  native-JSON negative observes `response.body` while retaining real `.json()`;
  a `getReader` trap also catches native JSON and cannot establish this policy.
  Preserve request, byte and business assertions when rebinding a moved seam.
- Exercise real Studio/native transport selection and denial, reference
  withdrawal during materialization, current main/auxiliary credentials and
  durable continuation/compaction. Mock HTTP proves the exercised contract;
  it does not establish paid-provider availability.
- Verify both export declaration closures in the isolated packed consumer and
  actual forbidden dependency CLI cases. Final root/app/browser/native gates
  must include all new sources and emitted artifact identities.

## 7. Wrong Versus Correct

Wrong: a library imports Studio's `runtimeFetchFor` or chooses global fetch when
a host transport is missing. Correct: the neutral handler requires a transport;
Studio chooses its existing authorized transport in the actual composition.

```ts
import {streamChatCompletions} from '@momoki/agent-providers';

await streamChatCompletions(input, {fetchImpl: hostTransport, signal});
```

Wrong: mark a failed read as a safe retry or rebuild encrypted continuation from
display text. Correct: preserve uncertainty and use the validated saved envelope.
