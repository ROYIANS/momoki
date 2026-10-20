# Application and Package Boundaries

## 1. Scope / Trigger

Read when adding an application/library, changing package exports/dependencies, relocating source or editing workspace/build/quality discovery. Studio vertical organization follows [Feature Organization](./feature-organization.md); reusable Agent implementation follows its package index and the same export/discovery rules.

## 2. Signatures and Owners

| Owner | Responsibility and entry |
| --- | --- |
| `apps/web`, `@momoki/web` | Browser HTML, `src/main.tsx`, Vite configuration and package `dev`/`build`/`types`. |
| `apps/desktop`, `@momoki/desktop` | Native entry, Tauri/Rust, native/build/release scripts and explicitly retained reference lanes. |
| `apps/site`, `@momoki/site` | Landing HTML, site source/assets and standalone `dev`/`build`/`types`. |
| `packages/studio`, `@momoki/studio` | One shared product implementation; `./bootstrap` and `./styles.css` exports. |
| `packages/distribution`, `@momoki/distribution` | `./brand`, `./analytics`, `./releases`, `./platform`, `./version` and shared public brand assets. |
| `packages/agent-core`, `@momoki/agent-core` | Runtime-neutral Agent implementation; public root emits ESM and declarations. See [core library](../agent-core/library/index.md). |
| `packages/agent-providers`, `@momoki/agent-providers` | Current Chat Completions/Responses implementation and neutral HTTP mechanisms; emitted root and `./http` exports. See [provider library](../agent-providers/library/index.md). |
| `examples/agent-todo`, `@momoki/agent-todo` | Independent Node >=24.11 CLI, own SQLite business model and typed Agent host; see [durable consumer](../agent-todo/cli/index.md). |
| Root `tooling`, `tests`, `quality`, `deploy` | Repository checks, integration fixtures, policy and assembled web/site delivery. |

Root remains the authoritative app release version; native version/integrity readers must agree. Private workspace manifests do not create independent app release streams. pnpm workspace declarations and package manifests define installation; the quality-owned source/dependency inventory must agree with actual packages.

Root `build` builds web/site and assembles `dist`; `dev` selects web, `dev:site` selects site. Existing root `lint`, `quality`, `quality:self-test`, `test`, `models-dev:verify`, `landing:budget` and native regression commands remain usable. Run package builds via the approved explicit pnpm path and `--filter @momoki/<app>`.

`tooling/build-agent-packages.mjs` exports `buildAgentPackages(): Promise<void>`
and is the root `agent:build` entry. The compiler and actual artifact consumers
share `captureAgentPackageInputs(root, row, packages)` from
`tooling/agent-package-inputs.ts`; `assertAgentPackageFreshness(root?)` checks
the complete current input/output maps against each package's generated
`dist/.momoki-build.json`. This receipt is local build metadata, not a source
file or package-public execution API.

## 3. Contracts

- Apps are leaves. Web and desktop consume the same Studio bootstrap through declared exports. Studio never imports application source; the site consumes only its own modules, React and lightweight distribution exports.
- Declare internal dependencies using `workspace:*`. Cross-package consumers use actual export-map entries, never sibling source traversal or another package's private alias. Production Studio modules currently use package-local relative imports. Root integration/fixture resolution of `@/` targets Studio only and does not authorize production cross-package aliases.
- Reusable Agent exports resolve built ESM/declarations with valid `.js` imports.
  Core cannot import providers. Providers may depend on core, with neither
  package depending on Studio/apps, product storage, UI or runtime selection.
  Prepare dependencies before every actual consumer entry, including direct
  root build scripts and Tauri frontend workers that bypass package lifecycle
  hooks. Quality/unused analysis may map an exact declared public export to its
  real source entry; that analysis mapping cannot become a production source
  alias, expose a private module or mark every package file reachable. Validate
  the export/source/artifact relationship and bind consumed artifacts to input
  identities; a warm `dist` directory alone cannot prove a cold build works.
- When a running browser consumes a changed reusable package, regenerate its
  emitted dependencies with the approved machine Node running
  `tooling/build-agent-packages.mjs`, then call `assertAgentPackageFreshness()`
  and check the changed runtime exports through the real package entry. Vite's
  startup freshness assertion does not rerun for every later library edit.
  Necessary source-only tests may stay narrow, but do not leave the development
  server consuming stale `dist` after introducing a new public export. This
  dependency preparation is separate from the deferred production app build,
  installer and isolated packed-consumer acceptance; do not add production
  source aliases, commit generated `dist`, or forge a receipt to avoid it.
- Build reusable packages in declared dependency order and clean their output
  before compilation. Capture all source files, package manifest/tsconfig,
  lockfile, builder/capture/workspace policy implementations, exact public-source
  policy, actual TypeScript package/compiler entry files and each declared
  reusable dependency's receipt. Recompute the same complete map after building
  and before consuming; missing mandatory keys and additional stale output fail.
  Do not trust a receipt to choose which current inputs require validation.
  Site's standalone commands and the shared Vite helper stay independent of
  Agent artifacts; prepare or verify them only at entries that actually consume
  Studio/Agent.
- The explicitly selected `vitest.agent-source.config.ts` and
  `tests/typecheck/tsconfig.agent-source.json` are bounded source-validation
  entries. They map only the current public core, providers and providers/http
  exports, never private paths or production consumers. The Node source suite
  requires Node >=24.11 and real SQLite. Keep default freshness checks intact;
  source evidence does not establish emitted/packed acceptance. Register these
  exact configuration/test/type inputs in discovery and quality identities.
- Studio's separate `vitest.studio-source.config.ts` and
  `tests/typecheck/tsconfig.studio-agent-source.json` reuse those three exact
  public mappings for a finite consumer suite. The side-effect-free
  `tooling/vitest.studio.ts` factory preserves ordinary fixture plugins, setup,
  dependency aliases and native flags. Default Vitest retains its freshness
  assertion; neither source lane changes dev/production package resolution.
  Keep Studio Node22 support separate from the Todo Node24 SQLite prerequisite.
- Retained native/reference harnesses may consume individually declared `./reference/...` Studio exports for existing behavior tests. They are deliberate current reference APIs, not wildcard access, a duplicate implementation or permanent old-path bridges. Normal product entries use bootstrap.
- Browser/native startup selects the fixed existing ProductStore before render. Keep schema bytes/identity, routes, protocol contracts, product transactions and managed-file behavior unchanged during relocation. Rust schema inclusion follows the one Studio schema owner.
- Distribution never imports Studio, application source, storage, Agent or native runtime. Installer verification/download/Save and device settings stay product-owned. Site budgets and dependency-closure checks cover both eager and lazy chunks.
- Web/site outputs use disjoint asset namespaces. Assembly accepts identical shared assets, rejects conflicting output/report keys and missing manifest/resource/module references, and validates before replacing deployment output. Preserve production site at `/`, app fallback elsewhere and private manifest denial.
- Register every app/library and owned source root in type/lint/architecture/unused/test discovery. Desktop scripts/UI/reference inputs retain their appropriate separate gates. A source relocation and its discovery/config/test updates are one implementation slice.
- Move input identities with execution scope. Quality/native freshness checks must include the actual desktop scripts/UI and package/build/check configurations they consume; a passing receipt must reject changes to those inputs during its run. Independently invoked Python/browser/type-check harnesses need the same relocation inventory as package scripts.
- Keep immutable comparator bytes. Review and rebind exact diagnostic/retained-API evidence individually; no ignored new package, broad allowance or all-source-as-entry trick may make the gate pass.
- Keep existing delivery policy and source/version/hash closure. Desktop hosted delivery remains packaging-only; separate quality/native checks remain independent. This structural change authorizes no push, hosted dispatch or public publication.
- The Todo consumer declares its own Node >=24.11 engine for built-in SQLite.
  Generic libraries, web quality and existing GHCR quality remain on Node 22.
  A separate Node 24 example job runs `agent:example:check`; image delivery
  depends on both quality jobs. Docker's frozen installation receives every
  actual workspace manifest, including the two libraries and example, before
  installation. Desktop hosted delivery retains its packaging-only scope.
- The example is an application source owner, not a public library source map.
  Its real conformance suite runs through the Node 24 isolated gate, which must
  enumerate all example tests rather than hiding them behind the generic
  Node 22 test runner. Build and pack real libraries, validate packed dependency
  versions, install offline with an independent empty store outside the repo,
  and compile/run the consumer through installed emitted public exports.

## 4. Validation and Error Matrix

| Condition | Required outcome |
| --- | --- |
| Actual workspace package missing from quality inventory | Fail source coverage before claiming graph success. |
| Registered owned source root absent or omitted from a check | Fail; nonzero total source count is insufficient. |
| A consumed source/configuration changes during a quality/native run | Reject the stale result; input identity follows actual check ownership. |
| Reusable source/compiler/producer/policy or declared dependency receipt changes, or a receipt omits an input | Reject artifact freshness and require `agent:build`. |
| Reusable `dist` contains an obsolete extra output | Reject freshness; clean and compile the package. |
| An analysis-only public source mapping differs from its emitted runtime/type stem | Fail policy validation before graph analysis. |
| Site imports Studio, directly or transitively | Fail source/built-closure checks. |
| Sibling application import, private source traversal or foreign alias | Fail package boundary checks, including type-only package bypasses. |
| New static value cycle or prohibited Studio feature/platform/UI edge | Fail architecture gate; literal dynamic edges obey boundaries too. |
| Output file/report conflict or unresolved manifest/resource edge | Fail assembly without replacing validated output with a partial build. |
| Current snapshot bytes or reviewed evidence identity changes | Fail provenance/quality until the exact change is reviewed. |
| Native executable/tool/host unavailable | Record the specific unmet prerequisite/check; never infer runtime acceptance from build success. |

## 5. Good, Base and Bad Cases

Good: add a package's real sources, exports and declared callers, update every discovery owner, then prove a forbidden edge still fails. Base: move a Studio module intact and update its exact imports/fixture seam without changing behavior. Bad: leave a root-src alias, mark every file as an entry to hide unused code, duplicate bootstrap, or suppress a native assertion because its executable moved.

## 6. Tests Required

- Full root types/formal quality/self-test/tests/model verification/build and site budget after final structural changes; retain the actual native probe prerequisite and shared real-store all-suite acceptance.
- All three per-app builds, desktop types/lint/unused/parity/native/release-tool checks, and current fixture/reference gates through their actual relocated owners.
- Meaningful negative cases: forbidden site/Studio and sibling-app edges, undeclared/private cross-package import, unregistered package/source root and missing source discovery. Verify the real gate rejects them, rather than merely testing a copied predicate.
- `tooling/agent-packages.test.mjs` uses the actual capture/freshness helpers to reject changed producer/compiler/config/source/output bytes, every missing mandatory receipt key, new source and extra obsolete output. `tooling/workspace.test.mjs` invokes the actual CLI to prove public-root edges and reject private/Node/product/relative-dependency escapes and invalid export/type/source mappings. Preserve independent site types/build with Agent output absent, plus actual cold Studio consumer builds in integrated acceptance.
- Root `agent:example:check` proves the installed declaration/runtime closure
  and actual SQLite/process conformance outside workspace source resolution.
  Its generated tarballs, databases, independent store and logs stay temporary.
- Assembly cases: both HTML entries and reports survive, references resolve, identical shared assets are accepted and differing files/report keys or missing resources fail.
- Check route refresh, workers/assets and normal available browser/desktop startup separately from unit/build proof. Other-OS, actual installer/Save/live-provider coverage remains bounded by observed execution.

## 7. Wrong Versus Correct

Wrong: `apps/site` imports `../../packages/studio/src/lib/...` or uses the Studio `@/` alias. Correct: site declares distribution as a workspace dependency and imports an explicitly exported lightweight module.

Wrong: build both applications into the same directory with cleaning disabled and assume merged output is valid. Correct: build separately, validate complete manifests/module/resource closure and collisions, then assemble the existing deployment layout.

Wrong: copy every canonical spec under each package. Correct: package indexes select shared canonical contracts; update source anchors when their real owner moves, and read long specs beyond automatic injection limits.

Wrong: iterate only `receipt.inputs` and accept an old `dist` if those listed
files still match. Correct: independently capture the complete current input
set, compare exact key/hash maps and validate all emitted output bytes.
