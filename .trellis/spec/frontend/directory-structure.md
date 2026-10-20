# Directory Structure

## Workspace ownership

Application entries live in `apps/web`, `apps/desktop` and `apps/site`. Browser
and desktop import the same `@momoki/studio/bootstrap`; the site consumes only
lightweight `@momoki/distribution` exports. The repository uses pnpm workspaces,
declared dependencies and explicit export maps. See
[Monorepo Boundaries](./monorepo-boundaries.md) for exports, discovery, build
assembly and deployment contracts.

The shared product is organized by feature inside `packages/studio`, rather
than by separate global component/domain/db/lib folders. The executable
[Studio Feature Ownership](./feature-organization.md) contract defines allowed
imports, public entries, fixed storage integration and transaction propagation.
`quality/studio-ownership.json` must agree with the actual tree; a directory
name alone does not establish that its dependencies are valid.

Canonical product contracts remain in `.trellis/spec/frontend`. Package-specific
indexes under `.trellis/spec/{web,desktop,site,studio,distribution,agent-core,agent-providers,agent-todo}` select those
contracts; `get_context.py --mode packages` lists actual owners. Unqualified
product module names in a contract refer to their Studio owner.

`packages/agent-core` owns the shared execution and context mechanisms;
`packages/agent-providers` owns the current chat protocols and neutral HTTP
mechanisms. Studio's Agent feature binds them to creative tools, current
credentials, product scope, held execution ownership and its existing store.
`examples/agent-todo` is an independent Node >=24.11 CLI with its own SQLite
schema and tools. It uses public emitted packages and is checked through the
outside-workspace `agent:example:check` gate. See the package indexes before
changing those owners.

## Studio layout

```text
packages/studio/src/
├── app/
│   ├── bootstrap.tsx         # initialize the fixed store, then mount
│   ├── routes/               # TanStack adapters; generated tree beside them
│   ├── layout/               # frame, page shells, header/context presentation
│   ├── workspace/            # project shell, kind dispatch and navigation
│   ├── navigation/           # accepted history and runtime history selection
│   ├── drafts/               # editor departure/retention and undo integration
│   ├── errors/               # shared crash/action error presentation
│   └── workflows/            # project ZIP/checkpoint/sync orchestration
├── features/
│   ├── projects/             # project models, gallery and project commands
│   ├── video/                # episodes, story/beats, shots and production
│   ├── audio/                # script/takes/timeline, generation, engine/export
│   ├── music/                # music drafts/works and creation workspace
│   ├── library/              # creative assets, IP, materials and owned media
│   ├── references/           # project references and document/source parsing
│   ├── memory/               # project knowledge, versions and retrieval
│   ├── settings/             # connectors, device preferences, catalog, updates
│   └── agent/                # chat, execution, tasks and product composition
├── platform/
│   ├── storage/              # protocol/adapters, typed tables and one schema
│   ├── product/              # fixed store, React query binding and HTTP policy
│   ├── runtime/              # system service/history/storage-profile mechanisms
│   ├── http/                 # product transport/policy bindings
│   ├── media/                # managed bytes and reusable media mechanisms
│   └── data/                 # named neutral data/revision mechanisms
└── ui/                       # neutral controls, icons and theme
```

A feature groups actual `models`, `commands`, `queries`, `services`, `ui` and
focused `tests` as its code requires; Audio also has named `engine`, `generation`,
`providers`, `packages`, `presentation` and `agent` owners. Do not create empty
layers or require one barrel per feature. Product tools/instructions remain
associated with the business feature they implement. Generic Agent package
extraction follows its own accepted task, without a second product loop here.

Cross-feature calls use reviewed entries. Models have one defining owner and
real relationships use type-only imports. The central typed table/schema owner
references those models; it is not another domain facade. Neutral storage never
imports React/product initialization. `platform/product/store.ts` retains the
single import-time fixed owner, and app bootstrap awaits initialization before
render. All nested business reads/writes keep the caller's explicit transaction.

## Routes and navigation

Routes are thin parameter/discriminant adapters under `app/routes`; library grids
and detail editors remain separate feature components. Studio library route
families use layout + index + `$id`. Creating a Studio asset navigates to its
Studio `$id` route, rather than asking for a project or opening a project editor.

- `/` redirects to `/agent`. `/agent` and `/agent/$threadId` share the stable
  Agent layout; `/agent/tasks` must not activate chat.
- `/settings` owns settings. `/connectors` redirects to
  `/settings?section=connections`; connections are embedded in settings.
- `/ips` and `/ips/$ipId` own persisted IP profiles. IP is not a project kind.
- `/assets` owns the materials hub and retains existing Studio
  character/scene/prop/style list/detail URLs. Shared editors check
  `STUDIO_LIBRARY_ID` versus the actual project owner before mutations.
- The series shell owns `/p/$projectId` and `/p/$projectId/world`. Episode shells
  own `/p/$projectId/e/$episodeId`, `/shots` and `/produce`. Old project-level
  shot URLs redirect to the first episode.
- Project-world detail routes remain `/p/$projectId/assets/*/$id`. The shared
  editor must verify that the loaded asset belongs to that route project.

`app/workspace/ProjectHomePage.tsx` dispatches by project kind. The presentation
catalog `features/projects/ui/projectKinds.tsx` blocks unavailable choices in
both UI and submit handling. Existing storage/migration contracts own persisted
kinds. Shell/gallery share `app/workflows/importStudioProject.ts`.

`app/layout/AppFrame.tsx` owns global navigation. `ModuleLayout.tsx` owns internal
left navigation; `ContextPanelHost.tsx` and `app/layout/context-panel.tsx` coordinate
feature-owned panels. Header/page/overlay owners present the UI while feature
owners retain drafts, commands, scrollports and runtime lifetimes. Accepted app
history tracking lives in `app/navigation/historyNavigation.ts`. See
[Shared Desktop UI](./desktop-ui.md).

## Business and integration owners

Concrete feature commands own durable mutations. Project, episode and thread
lifecycle commands live with their aggregate roots under
`features/projects/commands/lifecycle.ts`, `features/video/commands/episodes.ts`
and `features/agent/commands/lifecycle.ts`; their complete cascade transactions
remain intact. Project ZIP IO and the whole-graph import transaction
live in `app/workflows/packages`. Shared
`PackageError` identity lives in `platform/data/packageError.ts`. Workspace
availability binds to the product in `platform/product/workspaceAvailability.ts`;
the video repository contract lives in `features/video/services/workspaceRepository.tsx`. Feature codecs
remain pure validation/remapping owners. No aggregate repository facade, copied
schema or per-feature database replaces these responsibilities.

Audio snapshot reads use `features/audio/queries/snapshot.ts`. Audio selection,
shared decoding/export buffers, typed clip commands and generation adapters stay
with Audio. Music variant switching stays with Music. Chat execution sessions,
selection, flow orchestration and reference draft lifetimes remain separately
owned inside Agent. See the [component responsibility contract](./component-guidelines.md#d03-feature-responsibility-contract-2026-10-08)
for their preserved behavior.

Settings owns the Models.dev baseline/store/matching/sync/presentation and its
connections UI. Device-local state still uses the existing deviceSettings table.
Distribution owns shared release listing/platform/version facts; verified
installer download/Save remains a Studio settings/runtime operation. The site
never acquires storage, Agent or installer runtime dependencies. See
[Settings and desktop updates](./settings-update.md).

## Standalone site and deployment

`apps/site/landing.html` and `apps/site/src` build independently from the browser
app's `apps/web/index.html`. Root build assembles web/site output and merged
manifest/module reports in `dist`. Nginx serves the site at `/`, app fallback
elsewhere, and denies `/.vite/`. Use root `dev:site` for the site and `dev` for
web. Desktop keeps an isolated frontend configuration and excludes the site.
Shared public brand assets belong to distribution; site robots/sitemap belong
to `apps/site/public`. Native hash history and the app root redirect are
unchanged by this structure.
