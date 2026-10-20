# Partial checkpoint and sync-provider protocol

## 1. Scope / Trigger

Apply when changing `packages/studio/src/app/workflows/checkpoint.ts`, `packages/studio/src/app/workflows/syncProvider.ts` or future adapters that consume their contracts. This foundation implements only `momoki.protocol-fixture.v1`, schema 1, with explicitly partial coverage. Its project/media records are disposable protocol projections, not complete production table codecs. There is no user-facing sync, native filesystem/SQLite migration, managed hosting, marketplace or history/restore application in this boundary.

## 2. Signatures / Owners

`checkpoint.ts` owns `prepareCheckpoint`, `assertPreparedCheckpoint`, `createCheckpointManifest`, `validateCheckpointManifest`, `encodeCheckpointManifest`, `decodeCheckpointManifest` and `verifyCheckpointDelivery`. Preparation is privately certified by this module; a structural TypeScript object or a deserialized manifest is not publication-ready. The manifest carries workspace/project identity, a `sha256-v1:` revision, parent revisions, partial coverage, exact fixture records and binary entries. Binary entries carry stable binary/media/project IDs, a canonical `WorkspaceRef`, MIME, byte length and SHA-256.

`syncProvider.ts` owns the trusted internal `ProviderRegistry`, credential-handle/session/capability contracts, `checkpointObjectKey`, `publishCheckpoint`, `deliverCheckpoint` and read-only `listCheckpointRevisions`. Binary object keys are `sha256:<content hash>` scoped to the workspace. The provider port transports immutable objects and manifests and conditionally updates a workspace head. The application port owns atomic local application and its applied-revision ledger. Providers receive neither arbitrary database tables nor a local filesystem root.

## 3. Contracts / Invariants

Reject the adapter-local `browser-local` identity as portable identity. A caller supplies the fixture workspace ID; this module does not persist it. Every ordinary media path is re-derived from exact workspace/project/media IDs with `mediaWorkspaceRef` and compared with the supplied path. The single-project fixture validates ownership and complete record/binary reference closure; it does not imply Studio/global/nested-material codec support.

Accepted object keys, record variants, schema and format are exact. Unknown credential/runtime/job/approval fields cannot enter through a generic raw JSON export path. Partial coverage never authorizes applying a complete production workspace. Accepted authored title strings remain content; this is not keyword redaction of credentials a user may type or import into a file.

Canonical record/binary/parent ordering uses exact locale-independent string ordering. Do not use `localeCompare` or normalize IDs. Semantically equivalent unordered entry permutations have the same revision and canonical wire JSON; distinct bytes, identities, fields or parents change revision content. Revision hashing is integrity and identity, not authentication or encryption; no full ancestry-graph proof is claimed without loading that graph.

Snapshot portable metadata and mutable byte sources before the first asynchronous yield. Prepared/verified records, entries, references and arrays are defensively fixed. Returned writable bytes must not expose the private snapshot. Binary reads/hash verification use bounded 256 KiB turns and macrotask cancellation opportunities. Reuse the computed incremental digest; never rehash a media-sized full array synchronously after chunked reading. Complete immutable bytes still require content-sized storage/copying, and mutable-buffer snapshot allocation is distinct from bounded hashing.

Publish only a genuinely complete, unique, hash/size-verified prepared set. Immutable remote objects use a content address or a versioned identity including the content hash, so a stable logical media ID can retain old and new bytes across revisions. Upload required objects and manifest before head CAS, including when an initial head read already shows that the expected head is stale. Initial publication requires an absent expected head and no parents; a noninitial candidate includes its expected head in its parents. Both a known stale base and a CAS race retain stored candidate versions and report current-head conflict without silent overwrite. Locally prepared work remains available for recovery after failure or cancellation; remote staging alone does not mean the head advanced.

Capabilities and closed lifecycle actually gate operations, including direct fixture transports. Snapshot operation options, especially expected head, signal and progress callback, before yielding; ancestry validation and CAS must use the same expected head. Recheck lifecycle at the actual CAS/application boundary after caller callbacks, which may close a session. A provider without conditional-head support cannot fall back to last-write-wins. Delivery, listing, cancellation and binary-size limits are checked for the requested operation; listing never applies or deletes local content. The registry is trusted internal registration, not a sandbox for arbitrary third-party JavaScript. Credential handles remain device-local metadata; this boundary implements no credential vault or live authentication.

Publication acknowledgement means provider acceptance under that port's contract, not another device application or real-service durability proof. Delivery binds to the requested workspace and revision, verifies every required object's bytes before calling the trusted application owner, and returns a distinct application receipt. Repeated/concurrent receipt is idempotent through the owner's atomic ledger/apply contract. Cancellation before preparation return/publication/application prevents completion; after an atomic CAS/application begins, its actual committed outcome remains authoritative. Entering an asynchronous application method is not proof that its atomic commit has begun: the owner checks cancellation after staging and immediately before its real record/file/ledger commit. Transport errors with uncertain commit state must not be described as proof that nothing changed remotely.

## 4. Validation & Error Matrix

| Condition | Required outcome |
| --- | --- |
| Unknown schema/format/field or fake full coverage | Reject before application |
| Foreign workspace/revision, wrong derived path or duplicate/missing ownership reference | Reject before application |
| Truncated/corrupt/missing binary or false hash/size | No application receipt or partial ready records |
| Caller changes metadata/buffer after preparation starts | Immutable preparation uses its initial snapshot |
| Equivalent Unicode-sensitive entry reordering | Same canonical revision and wire bytes |
| Forged/incomplete/duplicate prepared set | Reject publication before a head update |
| Same logical media ID with distinct contents/revisions | Both immutable byte versions remain retrievable |
| Head changed during publication | Focused conflict; no silent overwrite; prepared work retained |
| Capability denied or session closed | No unauthorized operation/fallback |
| Caller mutates expected-head options or closes from progress callback | Original ancestry/base is retained; closed provider cannot advance the head |
| Cancel before prepare returns or commit begins | Abort; previous local state remains intact |
| Signal arrives after successful atomic CAS/application | Report committed acknowledgement/receipt |
| Provider acknowledgement only | Do not mark another device applied or offline-ready |

## 5. Good / Base / Bad Cases

Good: prepare an immutable partial fixture, publish content-addressed objects and manifest, win a compatible head CAS, then download into an independent fixture root and apply through an atomic ledger. Base: retry the same delivery without duplicate rows; retain local prepared work after provider failure. Bad: use project-copy ZIP remapping for sync, a stable media ID alone as a mutable remote object key, raw provider/credential envelopes as records, or an unverified structural object as proof of completed preparation.

## 6. Required Tests and Evidence Limits

Exercise actual protocol APIs with isolated transports/application stores. Cover canonical Unicode/order behavior, strict fields/coverage, caller mutation across the first await and chunk yield, corrupt/truncated/missing bytes, request binding, duplicate delivery, publication races, compatible ancestry, unsupported/closed provider, forged prepared sets and cancellation at actual commit boundaries. Keep independent failing probes and later corrected-source results separately; final gates must match source hashes.

Two fixture roots and a retained fixture ledger prove logical application and restart only. They do not prove disk materialization, SQLite transactions, crash recovery, native containment, authenticated/encrypted service delivery, all 49 durable table codecs or actual offline user handoff. Those remain separately validated parent deliverables.

## 7. Wrong vs Correct

Wrong: slice reads in chunks and then call `Sha256.update(allBytes)` again. Correct: retain and compare the digest from the bounded incremental pass.

Wrong: key remote bytes only by a logical media ID and overwrite it for a new revision. Correct: key immutable objects by content/version and retain the stable logical ID in the manifest.

Wrong: call a provider acknowledgement an applied device state. Correct: return application evidence only from the trusted atomic application owner after complete validation.
