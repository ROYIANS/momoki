# Deferred / not fixed in this task

Items recorded rather than fixed (P3, hardware-only acceptance, or no owning task). Other batches append their own sections.

## E16 residual business-detail entity families (Batch 4, item 10)

E12–E15 were cancelled, so no task owns these. The detail rollout covers shots and the four asset kinds (character, scene, prop, style; project and Studio owners). Still navigation-only:

| Family | Today | What a follow-up must establish first |
| --- | --- | --- |
| Material (library) | `/assets` collection link has no entity identity (`materialTools.ts`) | exact material id + owner (global / IP / project) in the link producers |
| IP profile | route navigation | exact IP id; archived/foreign handling |
| Memory | `?memory={id}` already carries identity | parser + ownership check + panel family |
| Project / episode | route navigation | owner-scoped target and departure semantics for the project editor |
| Audio / music items | route navigation | per-item identity and their draft/guard owners |

Rule for the follow-up: exact identity at the link producer, a feature-owned ownership read, and an independent provider slot (as `shot` / `asset` in `BusinessDetailsProvider`). `readBusinessDetailTarget` must keep returning `null` for anything without that identity.

## Batch 4 sub-items not changed (with reason)

- E05 "failed head retry re-parses the whole `File`": `filePayload` only validates and takes a lazy `blob.slice`; nothing is parsed or read. The retry cost is the storage write itself, which must be redone because the failed transaction rolled back. A prepared-payload cache would add state without saving work.
- E01 P3 items (`data-unsaved-fields` read-during-render, ~70-line `ShotDetailFields`, duplicated panel session state machine between shot and asset panels), E02 P3 items, E03 P3 items, E04 P3 items, E16 P3 items: recorded in the review reports, not fixed here.
- The Chromium script `tooling/agent-parallel-details-browser.mjs` needs Playwright and a built fixture, so it is exposed as `pnpm test:browser:agent-parallel-details` (manual/CI-opt-in gate) rather than run inside `vitest`. The docking thresholds (`contextPanelCoordinator.test.ts`) and the retained-workspace CSS contract (`e01ShotSelection.test.ts`) are covered automatically; real layout/scroll/paint still needs the browser script.
- Detail-pane lifetime: a detail pane is now scoped to the Agent thread (`ShotDetailsProvider scopeKey`); switching thread retires the pane (the pane's route blocker already refuses the switch while it holds unsaved work). The new-topic first-send navigation (`home` → `thread`) also changes the scope.
