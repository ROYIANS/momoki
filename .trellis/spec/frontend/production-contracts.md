# Production Handoff and Reviewed Changes

## 1. Scope / Trigger
Use for production ZIP delivery, scoped AI context, generation preparation, or reviewed writes to shot/asset data. These helpers do not submit remote requests or poll providers; the separate [creative skills executor](./agent-creative-skills.md) now does. A provider response is never authorization to overwrite business data.

## 2. Signatures
- `exportProductionHandoff(projectId, episodeId, onProgress?) -> Promise<{blob, filename, shotCount, missingCount}>` in `features/video/services/productionHandoff.ts`.
- `buildProductionContext(projectId, episodeId, shotId)` in `features/video/services/productionContext.ts`.
- `targetRevision(value): string` in `platform/data/revision.ts`; `validateProductionTarget(raw): ProductionTarget` in `features/video/models/productionRevision.ts`.
- `prepareGenerationIntent({context,target,prompt,config?,inputs?})`, `validateGenerationIntent(raw)`, `transitionGenerationIntent(intent,status,detail?)`, `generationIntentToProposalInput(intent)` in `features/video/services/generationIntent.ts`.
- `createProductionProposal({target,change,source,expectedRevision?})`, `applyProductionProposal(id,projectId)`, `cancelProductionProposal(id,projectId)`, `undoProductionProposal(id,projectId)` in `features/video/commands/proposals.ts`.
- Dexie v7 additive `productionProposals: "id, projectId, episodeId, status, createdAt"`. Shared types live in `features/video/models/production.ts`.

## 3. Contracts
### Delivery
Flush project drafts, read one scoped readonly snapshot, generate ZIP outside the transaction. Format is `momoki-handoff-v1`; it is not a restore backup. Include README, manifest, full-column CSV, missing report and ordered shot folders with readable text and original selected first/last/clip files. Names are bounded/sanitized; ordinal prefixes prevent collisions. Image clip is a planning placeholder; optional absent tail is not a gap. `missingCount` counts shots with warnings. Do not include connector/chat/extra/unrelated entities or local proposal history.

### Context and intent
Context explicitly projects project/world/episode/beat/shot, linked characters/scenes/props/effective style, output defaults and media metadata. No Blob/object URL/secrets/extra/unlinked record spreads. Local relationship IDs may remain in a warning when unresolved, but foreign entity content cannot enter the snapshot. Source tokens are synchronous canonical SHA-256, including complete entity content; tokens reveal no source prose. Revisions are conflict tokens, not authorization credentials.

Targets discriminate shot (episode mandatory, slot optional for text), character, scene, prop and style with legal slot literals. Generation requires a slot. Explicit media roles are first-frame, last-frame, reference-image and reference-video. Preparation only accepts verified output profiles and validates local media ownership/type/nonempty bytes. Transition graph: prepared -> submitted/cancelled; submitted -> running/terminal; running -> terminal; terminal has no outgoing transitions. Success requires complete local output; failure requires reason. Conversion returns proposal input and does not write a slot. Generated proposals require original expectedRevision matching their target source revision.

### Proposal writes
Dedicated repository module owns proposal mutations; UI never writes Dexie directly. Text changes whitelist shot content/notes/durationSec; result changes support legal asset and shot slots. Capture before, base revision and source; pending rows survive reload. Apply checks owner/target/media/revision and updates entity plus proposal inside the shared `PRODUCTION_TABLES` transaction. Repeated completed action is idempotent. Undo checks appliedRevision and restores affected values only; newer manual work blocks undo. Conflicts preserve pending row/data. Failed transaction rolls back both rows.

All proposal result references (before/after, including cancelled/undone history) retain media during orphan cleanup. This conservative retention intentionally favors recoverability; future history deletion needs explicit cleanup. Project deletion cascades proposals. Proposal rows are excluded from project backup/import and handoff because IDs and baseline versions are local. `collectMediaIds` remains committed-content-only for backup; proposal media retention is separate.

### UI scope
Produce uses a keyed project+episode inner component so live-query retained values/export state cannot leak across navigation. Proposal editor snapshots target at open; errors keep fields, saving blocks close, dirty close/target switch needs explicit discard. Preview precedes apply; changes never auto-update manual shot status. Workspace header explicitly positions all three grid children: title at row1/col1; desktop nav row1/col2; actions row1/col3. Mobile nav spans row2, actions row1/col2. Do not combine a fixed action row with automatic column placement.

## 4. Validation & Error Matrix
| Condition | Required behavior |
| --- | --- |
| Empty episode, wrong project/episode | Reject handoff, no empty successful package |
| Draft persistence failure | Reject snapshot/export; preserve retry |
| Missing/foreign/empty/wrong-kind selected media | Report gap; do not export bytes |
| Missing link in context | Warning, no foreign content |
| Unknown slot, wrong owner, invalid parameter/input role | Reject intent/proposal |
| Generated proposal lacks original revision | Reject; never rebase to current row |
| Edited/deleted target or media between preview and apply | Reject atomically, leave pending/data unchanged |
| Apply/undo repeated or concurrent | Return same completed state, no repeated mutation |
| Undo after newer edit | Refuse and preserve newer content |
| Disk/proposal write failure | Roll back entity update; retry possible |

## 5. Good / Base / Bad Cases
- Good: user downloads ordered original files with missing report, then edits externally without AI configured.
- Base: manual proposal replaces first frame, old media retained, guarded undo restores old result.
- Bad: auto-attach provider completion, infer video-ready status from image placeholder, export secret-bearing row spreads, or overwrite current content after a revision conflict.

## 6. Tests Required
`productionHandoff.test.ts`: unzip and check bytes/paths/full prose/scope, duplicate/traversal/long names, invalid media, draft failure/retry and consistent concurrent snapshot.
`productionContext.test.ts`: scoped whitelist, defaults/override/no-style, missing relations, secrets/Blob exclusion, canonical hashing against native SHA-256.
`generationIntent.test.ts`: profile params/input roles/state edges, owner/media/revision checks, successful proposal conversion without writes.
`productionProposals.test.ts`: durable preview, apply/undo/cancel idempotence, concurrent apply, conflict and deleted targets, rollback, all asset kinds, generated provenance, retained media and project cascade.
Browser: actual downloaded ZIP, manual create/apply/reload/undo, media selection/cancel, dirty discard, desktop/mobile header.

## 7. Wrong vs Correct
Wrong: `setShotSlot(id, "firstFrame", providerResult)` directly in completion handler.
Correct: persist validated local media, convert successful intent to pending proposal input, let user review, then call `applyProductionProposal` to atomically recheck and write.

Wrong: undo by writing the cached full shot regardless of changes.
Correct: compare current target with appliedRevision, restore only fields included in the proposal, and reject if the user has edited since apply.

## Current limits
ZIP generation uses browser memory (STORE for media); no streaming archive or timeline renderer. Legacy intent state remains a typed local contract; durable Agent execution/resume lives in agentGenerationJobs and the creative-skills executor. Source dependencies are recorded; only target revision is enforced for apply. The Agent executor validates adapter upload limits, input-byte revisions, result signatures and H3 image dimensions; full video codec/duration validation remains outside that executor. The legacy intent contract accepts APIMart GPT Image 2 / GPT Image 2.5 (flare, sunburst, ext) / MiniMax H3 profiles. It preserves image quality/version from the whitelisted context and rejects those parameters on incompatible models or video. The active Agent executor separately supports AIHubMix GPT Image 2 / Veo 3.1 Fast; those adapters do not automatically extend this legacy local contract.

## Project reference integration

See [Project References](./agent-references.md) for shared source ownership,
request materialization, withdrawal, source evidence and ZIP lifecycle contracts.

## Modern ZIP identity and parent ownership (C03)

See [the C03 parent ownership and modern package identity contract](state-management.md#c03-parent-ownership-and-modern-package-identity-contract-2026-09-30) for the seven-section contract. Modern nonempty episodes require original shot/beat ownership before repair; normalized beat identities must also remain unique before remapping. Legacy absent/empty episodes keep their explicit compatibility branch.


## Package codec and transaction ownership

Pure project parsing and ID remapping live under `app/workflows/packages/`; audio package parsing lives in `features/audio/services/`. Application package workflows retain ZIP/media IO, snapshot/compression and the whole import transaction. Shared `PackageError` in `platform/data/packageError.ts` retains one constructor identity across these actual package consumers. Modern raw IDs/FKs are validated before tolerant normalization/remapping; complete audio freshness is checked before allowlisting. A late audio relationship error rolls back previously inserted production/media/audio rows and Blobs. Historical local production-context/generation-intent modules remain test-only contracts pending E07 reference cleanup, not active paid-execution owners. See [the D03 contract](./component-guidelines.md#d03-feature-responsibility-contract-2026-10-08).

## Shared generation capability boundary

Project output defaults delegate overlapping capability facts while preserving permissive historical import parsing, profile versions/native keys and strict editor Save/CAS/rebase/dirty/retry/latest behavior. Saving/applying/clearing defaults makes no paid request. See [D06](./asset-output-foundation.md#d06-shared-generation-capability-contract-2026-10-08).

D08 optional text baselines for `episodes.patchStoryBeat` validate inside the existing transaction. Same-field conflicts and missing baseline-bearing targets reject without false saved state; unrelated changes merge. Legacy no-baseline/nontext omission behavior remains. See `state-management.md` D08 for the actual UI/retention and flush contracts.
