# AI connector and generation boundaries

## Models.dev catalog (replaced the LobeHub Model Bank; 2026-10-14)

The Models.dev catalog in `packages/studio/src/features/settings/modelCatalog/` is the only source for limits, vision and prices. The LobeHub Model Bank (`vendor/lobehub`, `lib/ai/modelBank/`, `model-bank:*` scripts) was removed on 2026-10-14. Historical `AgentRun.visionCapability.source: "model-bank"` markers and old "Model Bank" display strings in stored runs/messages are read as-is: `referenceInput.ts` keeps `"model-bank"` in its source union so old records stay valid; there is no migration and no code branches on it. Model data does not authorize new gateway wire parameters; transport policy remains in `reasoningPolicy`.
- Sources: a committed baseline projection of the pinned `@opencode-ai/models` (`models-dev:verify`), lazily imported; or the user-synced snapshot stored in the device-local `deviceSettings` table under key `modelCatalog` (selection under `modelCatalogSelection`, never in project ZIPs). Sync and the full-list index are manual only.
- Matching (exact, case-sensitive, no aliases): tier 1 the connector's own provider, tier 2 original-vendor providers, tier 3 same canonical id when candidates agree per field. Prices come only from tier 1 or tier 2; tier-2 prices are "官方参考价". Conflicts: smallest context/output, conflicting vision is unknown.
- Lookups stay synchronous and memory-only (safe inside transactions); runs freeze a `modelPricing` snapshot.
- UI contract: see [Model catalog page](./component-guidelines.md#model-catalog-page-2026-10-14).

## 1. Scope / Trigger

Read before changing provider discovery/probes or adding consumers of the APIMart/AIHubMix image/video clients. Catalog capabilities are separate from chat wire protocol. Keys belong to the existing studio-global Dexie connector table and never to project ZIPs.

## 2. Signatures

The shared `@momoki/agent-providers` root owns the actual Chat Completions and
Responses implementation and neutral wire/continuation types. Its explicit
`/http` export owns neutral bounded reading/SSE/redaction/request mechanisms.
Studio's `features/agent/providers/{chatStream,responsesStream}.ts` binds current
connector/reasoning policy, verified reference materialization and authorized
runtime transport. See [provider contracts](../agent-providers/library/protocols.md)
before changing those boundaries; creative generation/discovery policy below
remains product-owned.

Provider dispatch in `packages/studio/src/features/settings/models/connectors.ts`:

```ts
listConnectorModels(connector, usage: "all" | "chat", fetchImpl?)
testConnectorConnection(connector, fetchImpl?)
discoverConnectorChatModels(connector, options?)
runWithCompatibleChatModel(connector, model, action, options?)
```

`packages/studio/src/features/settings/models/chatModelPolicy.ts` owns connector-scoped compatibility, warning copy and the shared `buildChatModelOptions` filter. `runWithCompatibleChatModel` invokes the mutation/transport action only after compatibility succeeds; abort or a changed selection prevents action execution.

Provider client in `packages/studio/src/features/video/providers/apimart.ts`:

```ts
listApimartModels(credentials, query?, options?)
testApimartConnection(credentials, options?)
uploadApimartImage(credentials, file: Blob, options?)
submitApimartImageGeneration(credentials, input, options?)
submitApimartVideoGeneration(credentials, input, options?)
getApimartTask(credentials, taskId, options?)
// credentials: {baseUrl, apiKey}; options: {signal?, fetchImpl?, idempotencyKey?}
```

## 3. Contracts

- `baseUrl` includes `/v1`. Only fixed relative routes are executed; metadata endpoint/schema URLs are never followed with credentials.
- APIMart probes are read-only model queries, including when the key only permits media models.
- Discovery preserves category/capability tags and exposes parameter schema availability. Only `category === "chat"` populates automatic chat suggestions; unknown categories remain available through manual entry. Connection-page discovery retains all categories.
- Chat compatibility applies to every selection source: discovered suggestions, manual search and the current/saved model. Known `image`, `video` and `audio` categories cannot be reinserted by manual input. Use provider metadata rather than guessing from model names. A saved incompatible selection warns the user without changing historical messages.
- The send boundary checks the actual connector/model before creating a thread, appending messages, clearing the draft or calling chat transport. APIMart/AIHubMix metadata lookup failure cannot authorize an unchecked send; show the error and preserve the draft. Unknown custom models remain manually usable after successful discovery. Connector switching must not reuse another connector's classifications.
- Envelope `code` 200 or 202 without `error` is transport success. Image submit accepts either a `data` array of `{ task_id }` (Image 2 / standard 2.5) or a single `data` object with nonempty `id`/`task_id` (Ext 202 example). Video submit stays on the nonempty task-id array only — never treat a 202 object as video success. Query responses use a `data` object and still require `code === 200`. Never copy the conflicting final upload-guide example instead of dedicated generation/query contracts.
- Ext image submits alone may send `X-APIMart-Response-Version: 2026-07-27` and `Idempotency-Key` (stable local job id). Image 2 / flare / sunburst / video must not attach those headers.
- Model-native fields (`size` vs `aspect_ratio`, audio flags, frame roles, Ext `version`, 2.5 `quality`) survive unchanged. Server validation handles model-specific restrictions.
- Upload uses FormData without manually setting Content-Type; supported types are JPEG/PNG/WebP/GIF, up to 20 MB. Provider URLs are temporary, not durable media IDs.
- These adapters do not poll, persist jobs, automatically download results or mutate slots. AIHubMix offers an explicit protected Blob download. Multiple results and expiry must remain available to future callers.
- Requests are abortable; local abort does not cancel the remote task. Never automatically retry generation submissions after timeout or ambiguous network failure.

## 4. Validation & Error Matrix

| Condition | Required outcome |
| --- | --- |
| Missing credentials / invalid upload | Validation error without network traffic |
| APIMart model probe fails | Surface failure; never fall back to a POST |
| HTTP failure / provider error in HTTP 200 | Explicit failure, with credentials redacted |
| Invalid JSON/envelope or missing submitted task IDs | Protocol error, not empty success |
| Image Ext `code:202` object with `id`/`task_id` | Single task id; never invent a multi-task array |
| Video `code:202` object envelope | Protocol error; array parser only |
| Missing/unknown category or invalid parameter metadata | Preserve explicit metadata status; no name-based category guessing |
| Known media model entered manually or stored on a thread | Exclude from selectable chat options; warn and reject send without message writes or chat POST |
| APIMart metadata loading/failure during send | Finish validation or show error; never infer compatibility from an empty list |
| Unknown custom model after successful discovery | Allow manual chat selection/send |
| Unknown task state | Preserve provider state and normalize to unknown, never completed |
| Abort | Distinct aborted result; no claim of provider cancellation |

## 5. Good/Base/Bad Cases

- Good: connection page can discover a video-only key while chat suggestions remain empty.
- Base: existing OpenAI-compatible/DeepSeek discovery and fallback behavior stays unchanged.
- Bad: submit retries create multiple paid tasks after a lost response.
- Bad: an expiring result URL is stored as if it were permanent local media.

## 6. Tests Required

`tests/apimart.test.ts` owns provider envelope, upload, task-state and error contracts. `tests/connectors.test.ts` covers provider dispatch, filtering, read-only probes and configuration persistence. `tests/projectPackage.test.ts` checks key exclusion for each provider. Assert HTTP paths/bodies and call counts, not only parser output.

Chat-policy regression coverage must exercise manual-search and saved-selection reinsertion, metadata scope/loading/failure, unknown custom models, and the send gate with a downstream operation spy proving rejection causes no side effects.

## 7. Wrong vs Correct

```ts
// Wrong: provider model names alone include image/video models in chat.
await listModels(apimartConnector);

// Correct: the provider-aware layer filters documented categories.
await listConnectorModels(apimartConnector, "chat");
```

```ts
// Wrong: re-submit generation when a network response is lost.
// Correct: return the ambiguous failure to the caller without retrying.
// A future job runtime must reconcile provider identity before another submission.
```

```ts
// Wrong: treat every image/video envelope as code 200 + data[].
// Correct: accept Ext image code 202 + data{id|task_id} as one task;
// keep video (and Image 2 array) on the array parser; task GET still requires code 200.
```


## AIHubMix contracts

### 1. Scope / Trigger
Use for AIHubMix discovery, credential tests, native media requests and protected content reads. This module is the provider client. Durable Agent generation now wraps it in features/video/agent/generationRuntime.ts; see agent-creative-skills.md for verified profiles and recovery contracts.

### 2. Signatures
`packages/studio/src/features/video/providers/aihubmix.ts`: `listAIHubMixModels`, `testAIHubMixConnection`, `getAIHubMixModelSchema`, `submitAIHubMixImageGeneration`, `submitAIHubMixVideoGeneration`, `getAIHubMixImageTask`, `getAIHubMixVideoTask`, `downloadAIHubMixResult`. Requests accept passed credentials plus optional `signal`/`fetchImpl`; explicit downloads return Blob without repository mutation. Provider dispatch returns `via: "authenticated-read"` for a successful AIHubMix connection probe.

### 3. Contracts
- Chat Base URL ends in `/v1`. Media/catalog/schema routes derive from the same configured root, preserving proxy prefixes. Reject credentials/query/fragment in base URLs and unsupported path shapes. No hardcoded-host fallback.
- `/api/v1/models` is public; never send the key or claim discovery authenticates it. `/v1/models` was also readable without a key. Test access via authenticated `GET /ai/v1/images?limit=1`; never a POST or public-directory fallback.
- Metadata tokens: `types`, `endpoints`, `input_modalities`, `output_modalities`; missing annotations differ from explicit incompatibility. `t2t/t2i/t2v/reranking` map to documented current types. Preserve duplicates for conservative conflict resolution.
- AIHubMix's `listAIHubMixModels` maps valid normalized `input_modalities` containing the exact `image` token to `metadata: {source:"provider", vision:true}` when `parseModelMetadata(row)` has no explicit boolean vision. Existing token parsing accepts comma-separated strings or arrays of strings, trimming/deduplicating case-insensitively. Explicit `capabilities.vision: true|false` takes precedence, including false against image input. Missing/malformed/non-image modalities do not create affirmative vision metadata. The shared `resolveVisionCapability` keeps its explicit-provider-first/exact-Model-Bank/unknown rules; never infer support from a model ID or bypass `requireVision`.
- Suggest known text LLMs supporting Chat Completions or with unannotated protocols. Known non-chat types, media outputs and explicitly incompatible protocol sets block all selection sources and send. Image/video INPUT alone never blocks chat. Unknown/malformed metadata is manual-only after successful directory lookup; no name guessing.
- Schema lookup is optional public data. Select native POST endpoint by path, never first array element; surface missing/invalid metadata and network/CORS failure distinctly. Do not execute returned routes.
- Native image submit `/ai/v1/images/generations` defaults synchronous; preserve explicit boolean `async`. Native video `/ai/v1/videos` is always async, with numeric `duration` and native reference structures. Do not translate legacy `seconds`.
- Task reads use `/ai/v1/images/{id}` or `/ai/v1/videos/{id}`; unified `/ai/v1/tasks/{id}` is only a snapshot. Top-level task object has id/object/model/status/output/error/timestamps. Validate id/kind, preserve original status, map unknown states to unknown, preserve all indexed outputs and nullable Unix-second expiry.
- Protected content is not a public preview URL. Explicit binary reads verify origin AND exact configured-root task content route before Bearer auth. Reject redirects/cross-origin/task mismatch. Base64 is retained without automatic persistence.
- Task failure in HTTP 200 is a valid task read containing failed state. Request failure and failed remote task are distinct. Redact key-bearing provider errors, never retry generation, and never describe local abort as remote cancellation.

### 4. Validation & Error Matrix
| Input/result | Required behavior |
| --- | --- |
| Public model directory success | Metadata only; does not authenticate key |
| Authenticated probe rejected | Explicit error, no fallback POST |
| Vision input + text output | Eligible text model if protocol compatible |
| Valid image input without explicit boolean vision | Provider vision true reaches discovery and attachment preflight |
| Explicit vision false with image input, including a duplicate route | False remains authoritative; block attached-image execution |
| Missing/invalid/non-image modality without other verified vision evidence | Unknown/unsupported; preserve attachment and reject before durable run/messages |
| Known media or incompatible protocol, manual/saved | Exclude and block before all chat mutations |
| Metadata unavailable / changed connector | Unverified; preserve draft and history |
| Failed task in HTTP 200 | Return failed task and sanitized error |
| Completed task without usable output | Protocol failure |
| Unknown task state | Preserve provider state, never completed |
| Protected content foreign URL / wrong task / redirect | Do not forward key |
| Schema CORS / unavailable endpoint | Explicit failure/missing status; no fake schema |

### 5. Good/Base/Bad Cases
Good: a metadata-only catalog can load while testing an invalid key still fails. Base: APIMart categories and generic provider probe fallback remain unchanged. Bad: embed a protected result URL as a public image, or resend a paid POST after losing the response.

### 6. Tests Required
`tests/aihubmix.test.ts`: fixed paths, auth separation, native payloads, schema path selection, task states/identity/output/expiry, malformed envelopes, abort/redaction/no retry, protected Blob retrieval and path/origin rejection. `tests/connectors.test.ts` and `tests/chatModelPolicy.test.ts`: provider dispatch, text vs media classification, unknown/manual and saved selection behavior, stale catalog, aborted/switched sends with no downstream writes, and persistence. ZIP export covers all providers.

`tests/aihubmixVisionMetadata.test.ts` covers valid string/array tokens, malformed/absent/non-image input, explicit boolean precedence, conservative duplicate routes and special IDs. Exercise actual discovery → local PNG import → `beginAgentRun` → both wire materializers: exact pixels enter the wire while durable records contain no base64. Rejected capability creates no run/messages and retains the local reference. Catalog fetch is injected; these tests do not prove native transport, key entitlement or paid image inference.

### 7. Wrong vs Correct
Wrong: use successful public model discovery as proof that the configured API key is valid.
Correct: expose public discovery separately and test the authenticated task-list GET, describing that permission precisely.

Wrong: require AIHubMix to provide `capabilities.vision`, or guess it from a model name.
Correct: normalize its declared image input at the provider boundary, preserving any explicit boolean vision override and existing attachment guard.

Wrong: pass `content_url` directly to `<img>` or fetch any provider-returned URL with a Bearer header.
Correct: call the explicit guarded content reader, then let the future media runtime persist or display the Blob.

## Diagnostic redaction

Use the shared `redactCredentials` primitive before truncating provider diagnostics, including failed connection probes and network exceptions. Remove every exact configured key occurrence and Bearer credential; retain the provider-specific status/envelope handling. Boundary-position keys and repeated echoes must not leak through truncation.


## MiMo connector

`mimo` uses OpenAI-compatible chat protocol and dedicated `mimoSpeech.ts` audio transport. Default base is `https://api.xiaomimimo.com/v1`; custom proxy prefixes ending /v1 remain supported. Bearer auth is sufficient. Probe/discovery is authenticated GET /models, never a generation POST fallback; successful listing does not promise TTS permissions or balance. The three documented MiMo-V2.5-TTS model IDs and MiMo-V2.5-ASR are audio-only and blocked from manual/saved chat send paths. No model-bank edits are needed.

Speech POST uses fixed /chat/completions, assistant content for spoken text, user content for instruction/design, `stream:false`, and WAV output. Clone serializes a WAV/MP3 sample as a data URI only inside transport, max 10 MiB encoded including prefix. Design omits voice; explicit optimize_text_preview enables altered/automatic text and requires returned final_text_preview. Require stop completion, base64 WAV signature, then runtime checkpoint/decode. Redact credentials before truncating errors and never auto retry.

For returned speech, preserve strict base64 syntax and padding-aware decoded-size
validation before `atob`. Copy its binary string into one preallocated
`Uint8Array` by indexed `charCodeAt`; `Uint8Array.from(binaryString, callback)`
materializes costly iterable intermediates at the 32 MiB boundary. Keep Blob
size, WAV signature, preview validation and once-only request semantics. Shared
browser/Tauri code must not depend on Node `Buffer` or a newer optional WebView
decoder API for this copy. Retain the exact 32 MiB boundary test with its default
5-second deadline and above-limit rejection-before-`atob` assertions. Byte parity
tests cover NUL/high bytes and all three base64 padding residues. Profile actual
production stages on the unchanged fixture before relaxing a large-body test;
local timing/memory observations do not establish hosted success or OOM safety.

Official sources: https://mimo.mi.com/docs/zh-CN/api/model/list-models and https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5, checked 2026-09-22.


## Responses saved diagnostic status contract (A01 / PM-01, 2026-09-30)

### Scope / trigger
Responses adapters return diagnostic metadata that `runChat` passes to `finishAgentRun`; saved diagnostics have the same credential boundary as visible errors.

### Signatures
`streamResponses(input, handlers): Promise<ResponsesResult>` and `finishAgentRun(..., error?, finishReason?)` retain their existing signatures. Failed results may omit `finishReason`.

### Contracts
- A JSON failure can retain only these exact known statuses as `finishReason`: `completed`, `failed`, `incomplete`, `in_progress`, `queued`, `cancelled`. Unknown provider strings, including long strings, are omitted; do not persist them as status text.
- Error `message` uses the shared credential redactor before truncation. Never treat protecting message alone as protecting the whole saved result.
- Success keeps `stop` or `tool_calls`. A response with an error remains failure even if its recognized status is `completed`.
- SSE terminal event/type consistency remains mandatory. A mismatching unknown status is rejected before finish; this path differs from JSON failure handling.
- A protocol failure never triggers an automatic second POST.

### Validation / error matrix
| Input | Required result |
|---|---|
| Unknown JSON status containing configured key/Bearer text | `ok:false`, redacted message, omitted finishReason; saved run/message contain neither key |
| Known JSON status plus error | `ok:false`, exact known finishReason, redacted message |
| SSE response.failed with mismatching status | Explicit terminal-consistency failure, no arbitrary finishReason |
| Legal failed/incomplete SSE error | Known finishReason and redacted message |
| Complete content/tool result | Existing stop/tool_calls success |

### Good / base / bad cases
Base: failed status and ordinary provider error stay readable. Good: long unknown status is discarded while useful redacted error survives. Bad: copying unknown status through to run metadata because the visible message was already redacted.

### Required tests
`tests/responsesStream.test.ts` tests short/long fake-key JSON status, actual `finishAgentRun` persistence, known-status compatibility, SSE rejection/redaction, successful stop/tool_calls, and exactly one fetch. The vulnerability assertions must fail against the original raw-status implementation.

### Wrong / correct
Wrong: `finishReason = response.status` for any string. Correct: retain only recognized diagnostic statuses; separately redact the error and assert the complete persisted result has no credentials.


## Scenario: Generic discovery/probe protocol success (B04 / PM-02; 2026-09-30)

OpenAI-compatible/DeepSeek list/probe accepts an object directory envelope with no non-null error or success:false, an actual data array, and every row a nonempty string ID after trimming. A valid empty data array is success (modelCount0); HTML, malformed JSON, missing/non-array data or malformed rows are failure. Optional metadata may be absent/invalid without invalidating an otherwise valid ID; preserve trimmed IDs, dedup/sort and conservative duplicate metadata merging.

One generic operation uses GET /models first. Only HTTP404/405 or a TypeError thrown by the GET fetch transport permits one existing minimal chat POST. Body read/JSON/decoder errors—including TypeError after fetch resolved—are protocol failures, not fallback authorization. Keep fetch handling separate from body processing. Other HTTP errors and non-TypeError transport errors stop after GET. The permitted POST keeps defaultModel, ping and max_tokens1; successful HTTP alone is insufficient: error envelopes take precedence and a valid choices/message frame is required, while empty output from a one-token probe may be valid. No POST response/error triggers another request. Specialized MiMo/APIMart/AIHubMix probes stay read-only.

Tests assert result and exact requests/methods: malformed GET1/POST0, allowed fallback GET1/POST1 (two attempts), malformed fallback still exactlytwo, missing credentials zero. For forbidden fallback cases return a valid mock chat frame if accidentally called, so the test detects both hidden success and an unnecessary paid request. Connection page can append its separate list GET after successful via=models; adapter counts are not page-wide counts. Redact provider diagnostics before bounding them and retain current public result shapes.

## C06 bounded inbound reading contract (2026-09-30)

### 1. Scope / Trigger
Inbound provider JSON/error bodies, speech audio/base64 envelopes, CDN downloads, and Chat/Responses streaming accumulation.

### 2. Signatures
`readResponseBytes/Text/Json/Blob` share actual Uint8Array byte enforcement while consuming a Response body, before parsing or Blob construction. `readSseEvents` handles bounded UTF-8 events and cancellation. Their single defining owner is now `@momoki/agent-providers/http`, including `ResponseLimitError` and the shared error 64 KiB / ordinary JSON and retained chat output 4 MiB budgets. Product policies stay in `packages/studio/src/platform/media/limits.ts`: raw audio 32 MiB, MiMo speech envelope ceil(audioLimit/3)*4 + the shared JSON budget, protected/public image/video binary download 256 MiB. These are local application limits, not supplier specifications. Tavily remains at 2 MiB. Audio byte limits agree with the existing decoder guard.

### 3. Contracts
Content-Length is a hint, never the only enforcement. Reject an oversized body during reading, cancel and release the reader, and preserve AbortError semantics. Check exact decoded base64 size including padding before allocating and validate the resulting Blob. An SSE response bounds each pending line/event and the aggregate retained content/reasoning/tool output before delivering an over-limit delta; repeated legal usage-only events do not consume a lifetime response allowance. Retained output accounting handles UTF-16 surrogate pairs split across JSON deltas: charge actual appended UTF-8 bytes, rather than summing independent encodings that overcount a completed pair. Responses' existing event/output protections remain.

An oversized successful response is a protocol failure, not proof the remote paid submission did not execute. When a non-2xx status was already observed, preserve the adapter’s authoritative HTTP status contract while bounding/cancelling the error body; AbortError retains its existing exception. Speech follows existing uncertain-state handling without automatic resubmission. Music preserves already checkpointed task IDs/results and supports GET/CDN recovery without a new POST. Do not decode or fetch inside database transactions. Provider status reporting and redaction-before-truncation remain unchanged. An over-limit successful download reports the resource boundary rather than disguising it as a generic network/cross-origin error. Known non-2xx bodies still report authoritative status even if the bounded optional diagnostic body cannot be read. Exact scoped APIs are recorded in the accepted review; this contract does not claim every discovery or inline image JSON endpoint is now bounded.

### 4. Validation / Error Matrix
| Input | Required result |
| --- | --- |
| Exact configured byte boundary | Accept if otherwise valid |
| Missing or misleading Content-Length | Enforce actual streamed bytes |
| Limit crossed in one or multiple chunks | Cancel and reject before parsing/persistence |
| Base64 envelope with decoded size above audio limit | Reject before atob/Blob allocation |
| Abort while reading | Preserve abort classification |
| Many legal SSE usage events | Continue when retained state is bounded |
| Single huge event or accumulated output overflow | Stop before unsafe handler output |
| Oversized paid-submission response | Preserve uncertainty; no automatic second POST |
| Oversized music CDN body | Keep task IDs and recover through GET |

### 5. Good / Base / Bad Cases
Good: a bounded read rejects a fake-small Content-Length body before constructing a large Blob. Base: ordinary streamed reasoning and tools still finish. Bad: reading the complete body and checking its size afterward, or retrying a paid POST because its response was too large.

### 6. Required Tests
Finite mocked streams covering exact boundaries, cross-chunk/multibyte bytes, absent/fake headers, cancellation/release, abort, base64 padding, per-event and aggregate SSE limits, existing tool finishes, nonstreaming Responses, actual request counts, no media persistence, uncertain jobs and preserved music checkpoints. These tests prove control-flow boundaries rather than live-provider memory behavior or OOM prevention measurements.

### 7. Wrong vs Correct
Wrong: call response.json/text/blob with no bound or trust only the header. Correct: enforce the relevant actual-byte limit before materialization and preserve provider/runtime failure semantics.

## Shared generation capability boundary

Current image/video capability facts and scalar parameter validation are shared in features/video/models/generationCapabilities.ts, without changing provider requests, endpoint/model support or entitlement. APIMart frame request follow-input ratio and explicit persisted project adaptive ratio remain distinct representations; AIHubMix Veo resolution/reference/duration rules retain exact current constraints. See [D06](./asset-output-foundation.md#d06-shared-generation-capability-contract-2026-10-08).

## D07 shared once-only request and explicit JSON policies (2026-10-08)

## 1. Scope / Trigger

Maintain this contract when changing APIMart/image/audio, AIHubMix, MiMo, OpenAI-compatible/chat/Responses or Tavily request foundations. Share actual once-only fetch and response-reading mechanics without flattening provider status, payload, retry, timeout or browser policy.

## 2. Signatures / Owners

- `@momoki/agent-providers/http` owns `normalizeBaseUrl(baseUrl: string)` with the existing trim/trailing-slash behavior unchanged; actual product normalizer consumers use its public export or the meaningful OpenAI-compatible adapter API.
- The same `/http` entry owns neutral `RequestBoundaryOptions`, `requestOnce(url, init, options)`, `HttpJsonReadPolicy` and `readHttpJson(response, policy, signal): Promise<unknown>`. Transport, credentials/redirect and native/bounded success/failure policies are explicit caller inputs; bounded policy includes maxBytes and fatalUtf8. Neutral `requestOnce` checks an already-aborted signal and invokes the required injected fetch once. Studio's `platform/http/requestBoundary.ts` owns its product options and selects `runtimeFetchFor(runtimePurpose)` before delegating.
- The package's `http/{boundedResponse,boundedSse,safeError,limits}.ts` are the single actual byte-read, abort/cleanup, SSE framing, redaction and shared JSON/error budget owners. Product media/speech limits retain their existing policy owner.
- Existing provider adapters retain URL/key/route validation, headers/body, timeout controllers, HTTP/provider error formatting, envelope/schema/status/result decoding and durable runtime APIs. Shared JSON returns unknown, preserving the real adapter parse/validation boundary; it discards only unreadable optional non-2xx diagnostics and propagates success/abort failures.

## 3. Contracts / Invariants

- Submit each paid POST once. A shared helper cannot introduce automatic retry, fallback, auth retry or replay after an unknown outcome. Existing GET recovery remains distinct from submission.
- Preserve each actual adapter's request method/body/headers/signal/credentials/redirect and guarded URL rules. Moving base normalization must not broaden URL/key permission or alter relative/absolute route construction.
- JSON consumption has explicit native or bounded policy. C06 ordinary JSON limits are not authority to cap successful generic image/inline-base64 JSON, which keeps native parsing. Existing 256 MiB media, 32 MiB audio and provider envelope budgets remain unchanged.
- On non-2xx responses, observed HTTP status remains authoritative when optional diagnostic reading fails, overflows or cannot decode; AbortError still propagates. Success parsing failures remain real failures. Do not turn an unsuccessful HTTP response into a success fallback.
- Reuse actual-byte readers and cancellation/release behavior. Keep the original abort object/semantics where preserved by current adapters; do not duplicate abort detectors or allocate guessed memory budgets.
- Redact the full configured key, Bearer token and provider-specific encoded-key forms before truncating to the original adapter-specific lengths. Key-bearing URLs remain rejected where currently guarded. Shared reading does not weaken existing provider error authority.
- Generic discovery forwards its existing caller signal into the adapter. Existing two-argument public calls remain valid; the additive signal preserves cancellation rather than converting AbortError into ordinary directory failure or probe fallback. Generic probe retains its already-authorized GET404/405 or GET-fetch TypeError fallback only; the shared once-only helper does not remove this existing two-attempt operation or introduce another attempt.
- SSE framing and output/tool budgets stay with their existing owners; preserve event/error ordering, retained partial output and callback behavior. Provider status/envelope decoders remain explicit local logic.

## 4. Validation / Error Matrix

| Condition | Required behavior |
| --- | --- |
| Guarded URL/key invalid | Reject before fetch; no request |
| Successful native inline-image JSON | Preserve native parsing and original payload semantics, not a blanket ordinary-JSON cap |
| Bounded success exceeds budget/invalid UTF-8 | Existing actual limit/read error and cleanup |
| Non-2xx diagnostic read fails/overflows | Preserve observed HTTP status and original safe fallback detail |
| Abort before/during fetch/read | Propagate original abort behavior; cancel/release resources |
| Key-bearing provider message | Redact before original truncation, no disclosure |
| Paid submission returns uncertain outcome | No second POST; preserve existing recovery path |
| SSE error after partial output | Existing ordering/retention/flush semantics remain |

## 5. Good / Base / Bad Cases

- Base: each adapter supplies its explicit browser and JSON policies to a once-only shared helper.
- Good: a huge successful inline-image JSON retains its accepted native policy, while a small-budget ordinary envelope stops on observed bytes.
- Good: a non-2xx body-read error keeps HTTP failure authoritative, while abort propagates distinctly and no paid POST repeats.
- Bad: one universal response cap, hidden credentials/redirect defaults, swallowing AbortError, truncating before redaction, a generic provider factory, or shared automatic paid retry.

## 6. Tests Required

Compare before/after per-adapter policies and actual request bytes/call counts. Cover status authority versus diagnostic read/decode/overflow, abort identity/cleanup, redaction before truncation, encoded/key-bearing URL guards, bounded and native successful reads, SSE ordering and once-only paid submission with existing GET recovery. Keep C06 resource tests and D05/current runtime catalog/type boundaries intact. Native probes are needed for a concrete changed browser/transaction risk; finite mocks prove exercised contracts rather than live availability or OOM behavior. Preserve failures; no assertion/timeout/limit weakening.

## 7. Migration / Limits

All shared leaves need multiple real consumers and dependency-light layering. Keep existing public adapter APIs and actual compatibility normalizer consumers. No provider factory/service framework, retry system, endpoint/model support or audio/music policy change. D08 local text drafts follow `state-management.md`; E/QG01 remain separate later work. Current local evidence does not establish live provider behavior, acoustic quality or full app E2E; whole-D final acceptance checks the final cumulative inputs.
