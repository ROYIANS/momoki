# Research: popover / model picker / composer strip audit

- **Query**: packages/studio popover-like components, model selection + reasoning effort, strip above composer
- **Scope**: internal (static read, no runtime verification)
- **Date**: 2026-10-16

Paths are relative to `packages/studio/src/` unless noted.

## 1. Popover-like components

### 1.1 Shared wrappers in `ui/`

| Wrapper | collision | max-height / overflow | width | sideOffset | portal / z | Notes |
|---|---|---|---|---|---|---|
| `ui/popover.tsx:19-40` `PopoverContent` | `popupCollisionPadding()` (top 52, others 16) `:31` | **none** (no max-h, no overflow) | `w-72` fixed `:33` | 4 | Portal to body, `z-50` | Radix does not cap height by itself; content taller than available height is clipped/unscrollable |
| `ui/select.tsx:46-81` `SelectContent` | `popupCollisionPadding(8)` `:65` | `max-h-(--radix-select-content-available-height)`, `overflow-y-auto`, scroll up/down buttons `:68,78` | `min-w-32`; viewport `min-w-(--radix-select-trigger-width)` `:71-73`; no max width | popper translate 4px | Portal body, `z-50` | Scrollable. Long item text has no explicit truncation here |
| `ui/dropdown-menu.tsx:19-37` `DropdownMenuContent` | `popupCollisionPadding(8)` `:29` | `max-h-(--radix-dropdown-menu-content-available-height)`, `overflow-y-auto` | `min-w-[8rem]`, no max | 4 | Portal body, `z-50` | Scrollable |
| `ui/dropdown-menu.tsx:186-` `DropdownMenuSubContent` | `popupCollisionPadding(8)` `:193` | **`overflow-hidden`, no max-h** | `min-w-[8rem]` | none | `z-50` | Tall submenus are clipped, not scrollable |
| `ui/tooltip.tsx:32-56` `TooltipContent` | `popupCollisionPadding(8)` `:43` | none | `w-fit`, `text-balance` | 0 | Portal body, `z-50`; provider `delayDuration=0` `:9` | |
| `ui/popupCollision.ts:1-7` | `APP_TOPBAR_CLEARANCE=52` top padding; comment says top bar z-index 30 | | | | | Shared helper |

No HoverCard wrapper exists in `ui/` (grep found none). `ui/sheet.tsx`, `ui/dialog.tsx`, `ui/alert-dialog.tsx` also exist (not popovers).

### 1.2 Non-wrapper popovers (feature code)

| Component | File:line | Library | Anchor / side | Size / scroll | Portal / z |
|---|---|---|---|---|---|
| Model picker | `features/agent/ui/ModelSelectTrigger.tsx:293-328` | raw `@radix-ui/react-popover` | `side="top" align="end" sideOffset=10` `:315`, collisionPadding 16 | `.agent-model-popover` `agentChat.css:1320-1326`: `max-height: var(--radix-popover-content-available-height)`, overflow-y auto. Inner `.agent-model-panel` `agentChat.css:96-105`: `width:min(640px,100vw-48px)`, `max-height:min(420px,70vh)`, `overflow:hidden`; list column scrolls via `.agent-model-rows` `:127-132` (`overflow:auto`); detail aside `overflow:auto` `:161-168` (fixed 260px). Under 600px width → column layout, list `max-height:300px` `:1328-1340` | Portal container `popupRoot()` `:25-27` = `[data-slot="context-panel-content"]` → `.agent-chat-root` → body; `z-index:1100` |
| Model settings (effort) menu | `features/agent/ui/ModelSettingsMenu.tsx:15-55` | **antd `Dropdown`** placement `topRight` | submenu for effort (`:20-35`) | `.agent-composer-menu` `composerControls.css:42-46`: `width:min(320px,100vw-32px)`, `max-height:min(440px,100dvh-32px)`, `overflow-y:auto`; antd submenus are separate popups | `getPopupContainer` → context-panel / `.agent-chat-root` / body `:16` |
| Project picker | `features/agent/ui/ProjectPicker.tsx:68-156` | raw Radix Popover | `side="top" align="start" sideOffset=8`, collisionPadding 12 `:87` | `.agent-project-picker` `composerControls.css:413-416,531`: `width:min(360px,100vw-32px)`, `overflow:hidden`; list `max-height:min(300px,42dvh)`, overflow-y auto `:440-443`; names truncated with ellipsis `:469-473` (no title attr in markup `:127-131`) | container = enclosing `[role=dialog]` or `.agent-chat-root`; `z-index:80` |
| Context usage | `features/agent/ui/ContextUsagePanel.tsx:359-419` | raw Radix Popover | `side="top" align="end" sideOffset=10` | `.agent-context-popover` `agentChat.css:1301-1314`: `width:min(312px,100vw-32px)`, `max-height: var(--radix-popover-content-available-height)`, overflow-y auto | container `document.querySelector(".agent-chat-root")` (may be null in dialog context); `z-index:1100` |
| Permission menu | `features/agent/ui/AgentControls.tsx:77-125` | antd `Dropdown` + antd `Tooltip` | `topLeft` | `.agent-composer-menu` (as above) | `popupRoot` = `.agent-chat-root`/body `:39` |
| "+"/more menu | `features/agent/ui/AgentControls.tsx:211-354` | antd `Dropdown` + `Tooltip` (`:348`) | `topLeft` | same class | same |
| Topic sidebar menu/tooltips | `features/agent/ui/TopicSidebar.tsx:179-186` (DropdownMenu `agent-topic-menu`), `:229-241`, `:311-319` (Tooltip side=right, delay 500/600) | `ui/` wrappers | sidebar right | Tooltip is the only way to read a truncated thread title (`:311-319`) | body portal |
| Shot editor menus/popovers | `features/video/ui/ShotEditorPage.tsx:518,586,697-704 (PopoverContent w-72),741,847-854 (w-64)`; `ShotRow.tsx:422`; Selects at `ShotEditorPage.tsx:788-845`, `ShotRow.tsx:288,465`, `StoryPage.tsx:448`, `ShotDetailPanel.tsx:217,226`, `ProductionProposalsPanel.tsx:213,222`, `MemorySelect.tsx:15`, `ProjectGalleryPage.tsx:240` (trigger `max-w-52`), `ProjectIpPicker.tsx:19-23` (`max-w-[calc(100vw-32px)]`) | `ui/` wrappers | | `PopoverContent` instances rely on wrapper (no max-h) | body portal `z-50` |

Library mix: shadcn/Radix wrappers (`ui/*`), raw Radix (`ModelSelectTrigger`, `ProjectPicker`, `ContextUsagePanel`), antd (`ModelSettingsMenu`, `AgentControls`, composer `Input.TextArea`), `@lobehub/ui` (`ActionIcon`). Each has different collision, portal and z-index behaviour (Radix wrapper z-50 in body; chat popovers z-1100/80 inside `.agent-chat-root`; antd uses its own z-index/placement flipping).

### 1.3 Ranked clipping / non-scrollable cases

1. **`ui/popover.tsx` `PopoverContent` has no max-height/overflow** (`:33`). Any popover with content taller than viewport-available height (`ShotEditorPage.tsx:704` `w-72 space-y-3`, `:854`) is clipped in small windows; collisionPadding only moves/flips it. Highest generic risk because every shadcn Popover inherits it.
2. **`DropdownMenuSubContent` is `overflow-hidden` with no max-height** (`ui/dropdown-menu.tsx:~196`). Long submenus are cut off at the window edge and cannot scroll.
3. **Model picker is a bottom-anchored two-pane popup** (`ModelSelectTrigger.tsx:315`, side=top). Panel is `max-height:min(420px,70vh)` but outer content is capped by `available-height` minus 52px top padding; in short windows the panel shrinks, search input + provider chip row (wrap, `agent-model-providers` `agentChat.css:333-339`, not scroll-limited) consume the height, leaving `.agent-model-rows` very small. Detail aside is a fixed 260px column (`:161-168`) so on windows 600–~700px wide the list column gets <340px; only < 600px stacks. In a narrow right-docked panel (`popupRoot` selects `[data-slot="context-panel-content"]`, `:25-27`) the popup is positioned inside that container; width `min(640px,100vw-48px)` uses the viewport, not the container, so it can exceed the docked panel's width and be clipped by that container's overflow (not verified at runtime).
4. **Nested popovers in the composer model control**: antd Dropdown (`ModelSettingsMenu`) → effort antd submenu popup; "更换模型" calls `onChooseModel` (`:43`) which opens the Radix model popover (`FloatingComposer.tsx:419-421`) while the antd dropdown closes (`:46`). Two libraries, two portal roots, focus returned manually (`ModelSelectTrigger.tsx:319-323`).
5. **Text truncation without a way to read full text**: model rows ellipsis (`ModelSelectTrigger.tsx:267-277`, no `title`/tooltip); trigger label ellipsis (`:302-308`, `agent-chip` `max-width:220px` `agentChat.css:79`; `.agent-model-setting-label` `composerControls.css:358-363`); project picker `strong/small` ellipsis (`composerControls.css:469-473`); attention detail uses `title` only (`AgentComposerAttention.tsx:45-46`); task summary title ellipsis (`composerAttention.css`, `agentChat.css:1379-1386`); sidebar thread titles tooltip only (`TopicSidebar.tsx:311-319`, delay 600ms).
6. **antd menus**: `.agent-composer-menu` caps at `min(440px,100dvh-32px)` (`composerControls.css:42-46`), but it ignores the 52px top-bar clearance used by `popupCollisionPadding`, so tall menus on short windows can sit under the top bar (comment in `ui/popupCollision.ts:1-2`).
7. **Tooltips**: `delayDuration=0` provider (`ui/tooltip.tsx:9`), no max-width → long tooltip text balances on one very wide line.
8. `ContextUsagePanel.tsx:399` portals into `document.querySelector(".agent-chat-root")`; if the composer is inside a dialog/detail container, the portal target differs from the one used by ProjectPicker (`ProjectPicker.tsx:85-86`) — inconsistent roots.

## 2. Model selection

### 2.1 How the list is built
- Composer wiring: `AgentChatPage.tsx:392-394` `selectModelOptions = buildChatModelOptions(catalogMatches ? modelCatalog?.models : [], modelValue, "", modelPolicy)`; props passed at `AgentChatPage.tsx:548-561`.
- `settings/models/chatModelPolicy.ts:68-80`: dedupes suggestions + current + search text, filters `incompatibleModels`, sorts alphabetically; returns `[]` when policy unverified (`apimart`, `aihubmix`, `mimo` need verification, `:20-22`).
- Model list comes from the selected connector's own `/models` probe (`ChatModelCatalog` in `chatModelPolicy.ts:5-11`; `probingModels` at `AgentChatPage.tsx:196`). Typing a custom name in search injects it as an option (`:75`).
- Inside the popup: `ModelSelectTrigger.tsx:187-197` filter by search; `groupModelsByVendor` groups by regex vendor rules (`settings/models/modelVendors.ts:8-30`, 12 vendors, else prefix group).
- models.dev catalog (`settings/modelCatalog/sync.ts`, `store.ts`, `types.ts`) is used only for price, context window, output limit, vision, and a `reasoning?: boolean` fact (`modelCatalog/types.ts:19`, `validate.ts:41,55`, `sync.ts:78`). `ModelDetail` (`ModelSelectTrigger.tsx:29-108`) reads price/vision/context via lookup.
- Settings: `features/settings/ui/ModelCatalogSection.tsx`, `ModelCatalogPicker.tsx` (catalog sync/picker for settings; not the composer).

### 2.2 Trigger and popover content
- Trigger group: `FloatingComposer.tsx:404-424` renders `ModelSelectTrigger` with `trigger={<ModelSettingsMenu .../>}` when `model` is set, so the visible chip is the antd settings dropdown button (`ModelSettingsMenu.tsx:49-54`): model display name (ellipsis) + effort label small text (only if effort set and policy exists) + chevron. Without a model it falls back to the Radix trigger chip (`ModelSelectTrigger.tsx:296-313`).
- Click chip → antd menu: optional "推理强度 · {label}" submenu (only when `getReasoningPolicy` returns a policy), divider, "更换模型 {name}" (`ModelSettingsMenu.tsx:20-41`). Selecting "更换模型" opens the two-pane Radix popup anchored to the same chip (`Popover.Anchor`, `ModelSelectTrigger.tsx:294-295`).
- Popup: left column = search input, connector chips (wrap), vendor-grouped rows (icon, ellipsized name, check for current); right column = `ModelDetail` for hover preview (`onMouseEnter` sets preview, `:259`): name, vendor, context, price (4 values), abilities text + icons, image input status.
- After pick: `onModelChange(id)`, clear search, close (`:260-264`). Chip shows new display name; no toast, no effort preservation logic in this component.

### 2.3 Unfriendly points (observations)
- Two-step flow (menu → popup) for changing the model; connector switching is chips inside the popup (`:219-241`), and switching connector changes the list but the current model remains marked until a new one is chosen.
- Selected state shown as a check (`:278`) and `is-active` background shared with hover preview (`:258`), so "current" and "previewed" look the same (`agentChat.css:156-159`).
- Hover-driven detail pane (no touch/keyboard preview other than hover/focus not wired: only `onMouseEnter`).
- `ModelDetail` "能力" shows `check` icon for reasoning (`:107`) and text "深度思考" from regex `inferModelHints` (`modelVendors.ts:94-101`), not from the models.dev `reasoning` fact.
- Trigger truncation: chip `max-width:220px`; long model ids ellipsized with no tooltip.
- Row names use `modelDisplayName`; raw id not visible in rows.

### 2.4 Reasoning effort — data model and transport
- Type: `AgentReasoningEffort = "none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"` (`packages/agent-core/src/types.ts:1`).
- Policy: `settings/models/reasoningPolicy.ts:12-37` is a hard-coded allowlist `WIRE_POLICIES` keyed by exact model id: `gpt-5`, `gpt-5-2025-08-07`, `gpt-5.1`, `gpt-5.2`, `gpt-5.6-luna`, `o3`. `getReasoningPolicy` (`:46-65`) returns a policy only for connector `openai-compatible` (all levels) or `aihubmix` (drops `max`); **APIMart and native DeepSeek return `undefined`** (`:63-64`). Labels `:42-44`.
- Validation: `assertReasoningEffort` (`:67-71`) throws "当前连接和模型不支持此推理强度…" if the policy lacks the level. Called in `commands/agentRuns.ts:118`, `runtime/taskWrapup.ts:31`, `providers/chatStream.ts:28`, `providers/responsesStream.ts:21`.
- Protocol routing: `selectAgentProtocol` (`:75-78`) → Responses API only for `gpt-5.6-luna` + tools + effort≠none on openai-compatible/aihubmix; else chat-completions.
- Wire: chat-completions sends `reasoning_effort` (`packages/agent-providers/src/chatCompletions.ts:283`); responses sends `reasoning: {effort, summary:"auto"}` (`packages/agent-providers/src/responses.ts:216-221`), otherwise `reasoning: {summary:"auto"}`.
- Run persistence: `commands/agentRuns.ts:117,198` copies `previous?.reasoningEffort` or input into the run record; `models/agent.ts:132` stores `reasoningEffort` on `AgentRun`; also passed in `runChat.ts:94`, `contextCompaction.ts:115`, `taskWrapup.ts:72`, `agentExecutionService.ts:232,277-286`, `chatExecutionFlows.ts:73-79`.
- Thread persistence: `ChatThread.reasoningSelection {connectorId, baseUrl, model, value?}` (`models/chat.ts:17-22`); written via `updateChatThread` in `ui/useChatSelection.ts:105-117`; read back only if connector id, baseUrl and model all match and the level is still in policy (`useChatSelection.ts:19-26`). Before a thread exists it is held in local state (`effortSelection`). Not stored per project.
- UI: **UI exists** — `ModelSettingsMenu.tsx:20-35` (effort submenu), wired through `composerTypes.ts:32-33`, `AgentChatPage.tsx:536-540`, `FloatingComposer.tsx:417-420`. It is hidden whenever `getReasoningPolicy` returns undefined, which is the case for every model not in `WIRE_POLICIES`, every connector other than openai-compatible/aihubmix, and any Claude/Gemini/DeepSeek/Qwen model.
- Why the user cannot choose effort today: not a missing control; **metadata/transport gating** — effort is only offered for six hard-coded model ids on two connector types. The models.dev `reasoning` boolean (`modelCatalog/types.ts:19`) carries no level list, and `ChatModelMetadata` (`models/modelMetadata.ts:4-9`) has only vision/context/maxOutput, so no per-model effort levels are discovered from catalogs or provider `/models`. Additionally the effort entry sits inside a submenu of the model chip, not in the model popup.
- Other uses of "variant"/"thinking": `inferModelHints.reasoning` regex only; no `thinking`/`variant` field in the data model (grep in agent-core, agent-providers, studio).

## 3. Strip above the composer

Rendered by `FloatingComposer.tsx:317` `{status ? <div className="agent-composer-status">{status}</div> : null}` (first child of `.agent-composer-stack`, styled `composerControls.css:149-158`, compact `composerAttention.css:2-18`: rounded top corners sitting flush on top of the composer card). The `status` node is built at `AgentChatPage.tsx:499-531`. The outer condition at `:499` includes `activeThreadId`, so the wrapper exists for every thread.

| # | Item | Renderer | Shows when | Location |
|---|---|---|---|---|
| 1 | Execution error `execution.error` (`role=alert`, class `agent-composer-run-status`) | `AgentChatPage.tsx:500` | `agentExecution` snapshot has an error (send/start failure, not tied to a message) | strip, first |
| 2 | Attention queue "需要你处理" (pending approvals, confirmations, jobs, generation items, task review) | `AgentComposerAttention.tsx:9-58` (queries 7 tables), mounted `AgentChatPage.tsx:501-504` | `selectActivityAttention` returns items or open task in "review" state; returns null otherwise; read failure renders `待办读取失败` alert (`:33-34`) | strip, second |
| 3 | Project unavailable banner + "选择项目，开启新对话" button | `AgentChatPage.tsx:505-509` | `projectUnavailable` (also composer `blocked`/`readOnly` + placeholder via `blockedReason`, `:~475-478`) | strip |
| 4 | "需求沟通中 · 明确目标后，助手会建立任务" hint | `AgentChatPage.tsx:510-511` | `activeThread.taskMode && !activeTask` | strip |
| 5 | Task summary chip (title, state label, plan n/m) + "重新打开" | `AgentChatPage.tsx:512-521`; opens `TaskInspector` (`:630-638`) | `activeTask` exists; reopen button when lifecycle ≠ open and project available | strip |
| 6 | Run/execution status with 停止 button ("正在等待回复…", "正在停止…", working label) | `AgentChatPage.tsx:522-527`; derived `:436-447` (`showRunStatus`, `feedbackOwned`, `executionLabel`) | sending / run blocks thread | strip, last |
| 7 | Model warning (amber) | `FloatingComposer.tsx:390-394` inside the composer card above textarea; from `AgentChatPage.tsx:555-559` / `chatModelIssue` | incompatible model or unverified policy | in-card |
| 8 | Reference import jobs, attachment send note, drag hint | `FloatingComposer.tsx:~343-360` | importing/failed files; attachments present | in-card |
| 9 | Per-message error | `ui/MessageList.tsx:30-33` (`message.error`, "生成失败"/"生成中断") | message status error | in stream (already inline) |

Notes: items 1–6 are all stacked in one `.agent-composer-status` box; the stack has no scroll/limit, so many attention rows plus task + status increase the height above the composer (`agent-composer-attention` list lives inside). Task summary and attention both open `TaskInspector` / activity navigation (`useAgentActivityNavigation().reveal`, `AgentComposerAttention.tsx:15,47`).

### 3.1 Suggested placement (as requested; Codex-style mapping)
| Item | Proposed home |
|---|---|
| Attention queue (approvals, confirmations, task review) | stays attached to composer as the queue (Codex: attached queue only for queued messages/attachments/pending approvals) |
| Run status + 停止 | in the message stream (live turn row) / stop already on send button (`SendCircleButton`, `ModelSelectTrigger.tsx:332-383`) |
| `execution.error` | inline in the failing turn (per-turn error, like `MessageList` item 9) |
| Project unavailable | persistent inline banner in the thread header/stream; composer already shows disabled placeholder |
| 需求沟通中 hint | empty-state / placeholder text in the stream or composer placeholder (`FloatingComposer.tsx` placeholder already branches on `chatMode`) |
| Task summary | header chip or side-panel `TaskInspector` entry; plan card in stream or side panel (Codex shows plan/task card in the stream and progress in a side panel) |
| Model warning | near the model chip or inline in the turn |

## Related Specs
- `.trellis/spec/frontend/` and `.trellis/spec/studio/` (not re-read in this pass).
- Sibling research: `research/copy-and-state-audit.md`, `research/reference-ux-patterns.md`.

## Caveats / Not Found
- Static analysis only; clipping conclusions about narrow docked panels and antd menus under the top bar are inferred from CSS, not measured in a running window.
- No HoverCard component found in `ui/`.
- Exact origin of `execution.error` content (agentExecution snapshot) was not traced beyond `AgentChatPage.tsx:500`.
- `.trellis/spec` was not consulted for existing popover/z-index conventions.
