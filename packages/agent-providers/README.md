# @momoki/agent-providers

The current Chat Completions and Responses transports, emitted as ESM and TypeScript declarations. The package depends only on `@momoki/agent-core`. It has no product, storage or UI dependency.

Import `streamChatCompletions` or `streamResponses` from the package root. Every dispatch requires an explicit `fetchImpl`; a host supplies credentials at request time and selects its authorized transport. Optional `validateRequest` and typed materialization callbacks run before the single HTTP dispatch. Momoki uses those callbacks for connector/reasoning policy and reference image authorization. Those policies are outside this package.

Responses continuation uses the exported `ResponseItem` union. `decodeResponseOutput`, `toResponseInput`, `responseRoundMatches` and `appendResponseToolResult` preserve exact provider call IDs, original arguments and opaque reasoning strings. The append helper validates a matching call and accepts an already identical result once. Hosts save the resulting envelope with their own ledger transaction. `responseContinuationTokens` accounts for opaque continuation without exposing it in public events.

The explicit `@momoki/agent-providers/http` export owns bounded JSON/text/SSE reads, `ResponseLimitError`, safe URL/header helpers, credential redaction and required-fetch request helpers. Callers retain their existing `native-json` versus `bounded-json` policy. The same error class is shared by protocol and product media consumers.

`node tooling/build-agent-packages.mjs` builds the libraries in dependency order and records complete source/compiler/output identities. Actual dist consumers verify freshness. Root protocol tests and the package's `src/providers.test.ts` exercise these emitted exports. The independent Todo acceptance additionally packs and installs them outside the workspace; npm publication and public API stability are outside this task.
