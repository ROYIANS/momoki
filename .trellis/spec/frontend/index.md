# Frontend Development Guidelines

> Best practices for frontend development in this project.

---

## Overview

默默 Momoki is a Vite + React + TanStack Router product with one shared browser and Tauri page/Agent/command tree. Current commands and reactive reads use ProductStore: browser IndexedDB and the complete native SQLite/files adapter share the same business code. The normal packaged owner is activated only after actual isolated acceptance; adapter implementation alone is not that acceptance. The schema-4 video prototype is a separate reference/test lane. Runtime detection selects system services/history; the trusted fixed startup profile selects one persistence owner. There is no database mirror or automatic old-data migration.

---

## Guidelines Index

| Guide | Description | Status |
| --- | --- | --- |
| [Directory Structure](./directory-structure.md) | Studio layout+index+$id vs project workspace | Filled |
| [Monorepo Boundaries](./monorepo-boundaries.md) | Application ownership, exports, source discovery and deployment assembly | Filled |
| [Studio Feature Ownership](./feature-organization.md) | Vertical feature APIs, fixed product integration, explicit transactions and executable dependency rules | Filled |
| [Component Guidelines](./component-guidelines.md) | Thin routes, feature pages, ui primitives, slots | Filled |
| [Interaction Feedback](./interaction-feedback.md) | Quiet success paths, immediate results, purposeful progress and actionable product copy | Filled |
| [Creative Operation Feedback](./creative-operation-feedback.md) | Guarded asset intents, receipt-aware recovery, archive filters and serial import progress/stop | Filled |
| [Shared Desktop UI](./desktop-ui.md) | Frame/navigation, page typography, scroll owners, overlay focus and print | Filled |
| [Agent Business Details](./agent-business-details.md) | Finite shot/asset details, retained chat and batch review, guarded editing and responsive return | Filled |
| [Settings and Desktop Updates](./settings-update.md) | Settings search, embedded connections, device preferences, anonymous release checks and verified installer saves | Filled |
| [Shared Product Storage](./shared-product-storage.md) | All-table adapters, explicit transactions, durable certainty, observation and managed bytes | Filled |
| [Agent IP / Materials / Tool Loading](./agent-library-tools.md) | Confirmed IP/library operations, real content and per-request capability loading | Filled |
| [Agent Tools](./agent-tools.md) | Strict tools, permission snapshots, approval ledger and continuation | Filled |
| [Creative Skills](./agent-creative-skills.md) | Business CRUD, frozen previews, atomic writes and durable media generation | Filled |
| [Installed Text Skills](./agent-installable-skills.md) | Portable text imports, immutable device-local versions, metadata discovery and recorded-run retention | Filled |
| [MCP Connections](./agent-mcp.md) | Strict device catalogue, frozen discovery, finite host authority and bounded native SDK/process/credential contracts | Staged source contracts |
| [Batch Generation](./agent-batch-generation.md) | Reviewed 20-item queue, two-worker safety, candidate selection and current evidence | Filled |
| [Web Research](./agent-web-research.md) | Independent search connection, bounded source reads and truthful network recovery | Filled |
| [Agent Jobs / Retained Reports](./agent-jobs-results.md) | Owned foreground progress, bounded original results, authorized readback, retention and truthful Stop | Filled |
| [Granted Desktop Media Import](./desktop-media-import.md) | Session-bound native directory/video processing, staged claims, atomic import receipts and derivative lifecycle | Filled |
| [Agent Tasks](./agent-tasks.md) | Shared task/chat identity, plan ownership, artifacts and explicit completion | Filled |
| [Task Wrap-up](./agent-task-wrapup.md) | Evidence-backed review, durable summaries and explicit completion | Filled |
| [Project Memory](./project-memory.md) | Reviewed project knowledge, provenance, revision CAS and ZIP transfer | Filled |
| [Memory Retrieval](./agent-memory-retrieval.md) | Scoped lexical selection, independent request envelopes, audits and read tools | Filled |
| [Project Context](./agent-project-context.md) | Project binding, bounded facts, tool scope and deletion guards | Filled |
| [Image Discovery](./agent-image-discovery.md) | Named-project image lookup, same-run source proof and actual pixels | Filled |
| [Project References](./agent-references.md) | Local reference parsing, shared source library and native model image input | Filled |
| [Agent Context](./agent-context.md) | History policy, shared budgets and durable compaction | Filled |
| [Agent Send Recovery](./agent-send-recovery.md) | Immediate submitted echo, scoped recovery, create-only identities and uncertain admission | Filled |
| [Agent Execution](./agent-execution.md) | Durable runs, ordered checkpoints, explicit retry and cross-tab recovery | Filled |
| [Agent Execution Feedback](./agent-execution-feedback.md) | Invocation phases, immediate Stop acknowledgement and private receipt/checkpoint/DOM timing | Filled |
| [Agent Topic Reads / Reading](./agent-thread-reading.md) | Owned topic loading/departure and local accessible return-to-latest | Filled |
| [Agent Sidebar Activity / Read Revisions](./agent-thread-activity.md) | Atomic meaningful publication, separate report cursors, observed-only acknowledgement and semantic navigation | Filled |
| [Agent Activity UI](./agent-activity-ui.md) | Chronological execution, persistent action reminders and turn navigation | Filled |
| [Agent Write Evidence](./agent-write-evidence.md) | Atomic direct-write receipts, normalized results and bounded historical outcome display | Filled |
| [Chat Performance](./chat-performance.md) | Agent transcript scroll + memo vs LobeHub virtua | Filled |
| [AI Connectors](./ai-connectors.md) | Provider capabilities, APIMart/AIHubMix generation contracts and discovery | Filled |
| [Hook Guidelines](./hook-guidelines.md) | Shared transactional query identities, loading/missing/error and committed invalidation | Filled |
| [Audio / Music Workspaces](./audio-music.md) | Audio records, exact numeric clip editing/CAS, generation recovery/approval, MIME and ZIP | Filled |
| [Voice Batches / Arrangement](./audio-batch-arrangement.md) | v24 batches, exact confirmation, bounded retry, take selection and retained-clip placement | Filled |
| [State Management](./state-management.md) | Fixed ProductStore owner, explicit transaction context, episodes and STUDIO_LIBRARY_ID | Filled |
| [Managed Workspace](./workspace-storage.md) | Browser copy staging, cross-platform owned paths, incremental hashing and native boundaries | Filled |
| [Desktop Distribution](./desktop-distribution.md) | Packaging-only delivery, pinned tools, exact installer receipts and owned drafts; optional standalone smoke | Filled |
| [Native Product Runtime](./native-product-runtime.md) | Shared product, isolated-before-normal SQLite activation, official HTTP and native system services | Filled |
| [Native Workspace / Packaged Acceptance](./native-workspace.md) | Tauri DTO/generation/navigation boundaries, SQLite prototype, WebKit limitations and truthful packaged evidence | Filled |
| [Shared Video Workspace](./video-workspace.md) | One product page tree, runtime repositories, field baselines, atomic commands and committed inverse receipts | Filled |
| [Checkpoint / Sync Provider](./checkpoint-protocol.md) | Partial immutable fixture checkpoints, verified binary closure, conditional publication and application receipts | Filled |
| [IP / Material Library](./ip-material-library.md) | Multi-IP profiles, owned immutable snapshots, explicit adoption and retention | Filled |
| [Asset / Output Foundation](./asset-output-foundation.md) | Optional metadata, prop/style relationships, media reuse and APIMart output profiles | Filled |
| [Production Contracts](./production-contracts.md) | Handoff ZIP, scoped context, reviewed proposals and shared atomic persistence | Filled |
| [Delivery Export](./delivery-export.md) | Episode-scoped CSV and printable storyboard contracts | Filled |
| [Quality Guidelines](./quality-guidelines.md) | tsc lint, Vitest lib/repo tests, forbidden patterns | Filled |
| [Type Safety](./type-safety.md) | Domain types, normalizers, Zod package boundary | Filled |

---

## Pre-Development Checklist

- [ ] New pages use shared AppFrame/PageLayout presentation and retain feature/runtime scroll owners; read desktop-ui.md before changing global styling
- [ ] Trusted startup selects one fixed ProductStore owner; native HTTP/Save/hash history use genuine runtime detection. Read shared-product-storage.md and native-product-runtime.md; no per-feature denial, owner fallback or second catalog
- [ ] Studio asset create stays on `/characters|scenes|props|styles/$id` with `STUDIO_LIBRARY_ID`
- [ ] Detail `useProductQuery` uses its explicit readonly context and `get(id) ?? null`, preserving missing/error/loading states and current query identity
- [ ] `touchProject` no-ops for `isStudioLibrary`
- [ ] Project landing dispatches by kind: video film/series uses episodes, audio/music use their workspaces; video story/shots/produce take `episodeId`
- [ ] Agent list scroll uses `snapChatToBottom` / `isChatNearBottom` (`packages/studio/src/features/agent/presentation/chatScroll.ts`), not `scrollIntoView` smooth

## Quality Check

- [ ] Feedback follows interaction-feedback.md: immediate visible results, quiet normal success, no redundant transient labels or exposed internal phases, and actionable failures/recovery
- [ ] Headers, navigation breakpoints, short-window overlays, native keyboard activation, focus return and print obey desktop-ui.md; no global Agent theme leakage
- [ ] Studio create does not open a project picker or `/p/$projectId/...`
- [ ] `/characters/$missing` shows 找不到, not 加载中
- [ ] All current `props` / `styles` records and binary references stay in media collection/delete cascade through the same explicit transaction
- [ ] `/p/$projectId` dispatches by kind; video story/shots/produce live under `/p/$projectId/e/$episodeId`; non-video projects never run episode repair
- [ ] Shot queries and create/delete use `episodeId`, not the whole project table
- [ ] Delivery exports filter by both project and episode and wait for live queries to load
- [ ] Shot `status` defaults to draft; filters live on `Episode.shotFilters` (empty arrays = all); normal desktop startup preserves [released workspace upgrades](./native-product-runtime.md#workspace-registry-identity-and-released-upgrades)
- [ ] Browser and actual Rust SQLite core/business gates cover current tables, registered tools, binary carriers and uncertainty without callback/provider replay; isolated packaged acceptance precedes normal owner activation
- [ ] Agent stream does not `scrollIntoView({ behavior: "smooth" })` on a sentinel; history message items memo by content/status/reasoning/reasoningDurationMs

---

**Language**: All documentation should be written in **English**.
