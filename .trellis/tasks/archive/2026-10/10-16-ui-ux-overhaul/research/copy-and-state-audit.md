# Research: copy-and-state-audit

- **Query**: Read-only audit of `packages/studio` UI (features/*/ui, app/, ui/) and desktop shell for redundant copy, incomprehensible status text, misplaced errors, and the topic sidebar item state markers.
- **Scope**: internal
- **Date**: 2026-10-16

All paths relative to `packages/studio/src/` unless noted. Line numbers are from the working tree on the audit date. Counts come from ripgrep sweeps and are approximate (lower bounds for multi-line JSX). Impact ranking: H = on the main chat/agent path or seen by most users; M = seen on a specific page; L = rare or settings.

---

## 0. Area counts (summary)

| Area | (1) redundant/helper copy | (2) jargon/status | (3) misplaced/duplicated errors | Notes |
|---|---|---|---|---|
| Agent chat (`features/agent/ui`, incl. generation batches, job report, run details, wrapup, attention) | ~14 | ~16 | ~14 | Largest concentration |
| Audio (`features/audio`) | ~6 | ~7 | ~5 | `AudioGenerationBatches`, `AudioArrangementActions`, `shared.tsx` |
| Library / world / materials | ~8 | ~7 | ~5 | `AssetTextField`, `DesktopMediaImportPanel`, `MaterialDetailPanel` |
| Memory | ~4 | ~6 | ~3 | `ProjectMemoryPage`, `MemoryEditor` |
| Settings | ~9 | ~2 | ~5 (toasts on Connectors) | `UpdateSection`, `StorageSection`, `ConnectorsPage` |
| Video | ~7 | ~1 | ~7 | toast-only save errors in `ShotEditorPage`, `ShotRow` |
| Projects / app shell | ~6 | 0 | ~6 | toasts in `ProjectGalleryPage`, `WorkspaceChrome` |
| Topic sidebar | 2 | 0 | 1 (silent `!`) | see section 4 |

Global sweeps: `role="alert"` appears in ~75 places across ~30 files (agent ≈ 30); `toast.error|warning` ~55 places across ~25 files; `description=` props (PageHeader / PageState / SettingsRow) ~55 across ~20 files; `版本 {…revision}` display of internal revision numbers appears in ~25 places.

---

## 1. Redundant / explanatory descriptive text

### Agent
| Loc | Literal text | Class |
|---|---|---|
| `features/agent/ui/AgentChatPage.tsx:428` | `对话需要先配置 OpenAI 兼容连接（Base URL + API Key）。密钥只保存在本机。` | tutorial/helper |
| `features/agent/ui/AgentChatPage.tsx:497-499` / `:510` | `项目不可用 · 历史仍可查看，请新开项目对话` (blockedReason) and `项目不可用 · 对话与记录仍保留` (status row) – same message twice | duplicated |
| `features/agent/ui/AgentChatPage.tsx:514` | `需求沟通中 · 明确目标后，助手会建立任务` | helper |
| `features/agent/ui/ReferenceLibrary.tsx:111` | `图片 ≤10 MB · TXT / MD ≤5 MB · PDF / DOCX ≤20 MB · 每次最多 10 个` (always visible) | helper |
| `features/agent/ui/ReferenceLibrary.tsx:115` | `包括上传和生成的图片。点击附加可让当前模型查看原始图片。` | helper |
| `features/agent/ui/AgentGenerationBatches.tsx:530` | `有请求的提交结果尚不明确，后续发送已暂停。请核实供应商记录；其他已受理任务可以继续查询，已保存结果仍可选用。` | long explanation |
| `features/audio/ui/AudioGenerationBatches.tsx:120` | `暂停和取消只停止本地发送/等待，已受理任务与音频保留。未知提交不可重发；解码和下载恢复不会再次付费。` | long explanation |
| `features/agent/ui/AgentJobReport.tsx:50` | `没有可检查的视频。` / `:53` `还有 {remaining} 项未检查。` / `:54` `服务可能已经执行，不会自动重新请求。` | restates counts |
| `features/agent/ui/InstalledSkillsContent.tsx:81` | `当前安装已变化，正在查看已打开的版本。返回列表后可查看最新状态。` | helper |
| `features/agent/mcp/ui/McpConnectionsSettings.tsx:19` | `本地程序与远程工具服务，在对话旁管理连接和授权。` (restates the title `MCP 外部工具连接`) | restates label |
| `features/agent/mcp/ui/McpConnectionDetail.tsx:38` | `请在浏览器中完成授权，然后检查登录结果。` | tutorial |
| `features/agent/ui/TaskBoard.tsx:101` | PageHeader `任务` / `管理项目目标、执行步骤与已确认的成果。` | restates label |
| `features/agent/ui/ContextUsagePanel.tsx:312,329` | `输出预留 … · 安全输入预算 …` / `预计占用 …%；整理触发基于上限的 50%（已有摘要时为 65%），另计 25% 估算余量及输出预留。` | internal mechanics |

### Settings
| Loc | Literal text |
|---|---|
| `features/settings/ui/sections/AppearanceSection.tsx:6` | `主题` / `深色。当前版本只提供深色主题。` |
| `…/AppearanceSection.tsx:9` | `界面语言` / `简体中文。当前版本只提供简体中文。` |
| `…/StorageSection.tsx:25-27` | `全部项目数据都在本机的应用私有目录内（本地 SQLite 工作区与托管媒体），不上传、不联网同步。` |
| `…/StorageSection.tsx:35` | `升级或换机前请先在项目里导出备份。安装包为未签名版本，系统会给出安全提示，属正常现象。` |
| `…/UpdateSection.tsx:88,90,92` | `当前版本与线上最新版本一致。` / `你使用的是开发或更新的版本，无需升级。` / `当前或线上版本号无法比较，仍可前往发布页查看最新版本。` |
| `…/UpdateSection.tsx:95,110,119` | `查看所有版本、更新说明与校验文件。` / `覆盖安装前请先导出项目备份。` / `项目与密钥保存在本机。检查更新仅请求公开发布信息；本地项目内容与密钥不会发送到 GitHub。` |
| `…/GeneralSection.tsx:44` | `开启后每天最多检查一次新版本。默认关闭，小光点不会主动联网检查更新。` |

### Page headers / empty states (PageHeader `description=` restating title)
- `features/memory/ui/ProjectMemoryPage.tsx:73` `项目记忆` / `管理这个项目已确认的规范、偏好与决策。`
- `features/video/ui/EpisodeListPage.tsx:155` `集` / `按集整理故事与分镜，各集共用项目世界。`
- `features/library/ui/IpProfilesPage.tsx:79` `IP` / `管理创作定位、表达偏好与关联项目。`
- `features/library/ui/AssetLibraryPage.tsx:139` `世界` / `管理项目共用的世界设定、角色、场景、道具与风格。`
- `features/projects/ui/ProjectGalleryPage.tsx:232` `管理视频、音频与音乐项目。`
- `features/video/ui/ProducePage.tsx:154` `检查${scopeLabel}的分镜完整性，并导出按当前顺序整理的交付物。`
- `features/video/ui/ProducePage.tsx:248` `添加镜头后可检查素材与交付内容。` / `可以导出交付物。`
- `features/projects/ui/ProjectSettingsPanel.tsx:110` `镜头默认跟随这里的风格；镜头中单独选择的风格会保留。可先在世界 → 风格中建立本项目的风格。`
- `features/projects/ui/ProjectSettingsPanel.tsx:225` `画幅表达作品的目标。图片和视频可分别选择模型参数，也可以保持手动制作；保存配置不会发起生成。`
- Empty states with tutorial text: `features/video/ui/ShotEditorPage.tsx:1030` `点击「新建」添加第一条分镜。`; `features/video/ui/EpisodeListPage.tsx:172` `新建第一集，开始整理故事与分镜。`; `features/library/ui/AssetLibraryPage.tsx:452` `可以新建，或从工作室添加一份可独立修改的快照。`; `features/library/ui/IpProfilesPage.tsx:91,202`; `features/projects/ui/ProjectGalleryPage.tsx:254`.

### Memory
- `features/memory/ui/ProjectMemoryPage.tsx:163` `选择一条记忆，查看它的适用条件、原始依据与修订过程。`
- `:420` `停用后内容和修订历史仍会保留。` / `:462` `这条记忆及其全部修订历史都会被删除，原始任务总结会保留。如果暂时不再适用，可以取消后选择停用。`

### Library
- `features/library/ui/materials/MaterialDetailPanel.tsx:187` `当前预览历史版本；“用于项目”始终采用最新版本 {material.revision}。`
- `features/library/ui/AssetTextField.tsx:60` (see section 2).

---

## 2. Status descriptions users cannot understand

Internal-term inventory (status maps and literals):

| Loc | Literal text | Jargon |
|---|---|---|
| `features/agent/ui/AgentGenerationBatches.tsx:143-152` (JOB_LABELS) | `已受理，等待生成` / `准备保存` / `目标有变化，结果保留` / `提交结果待核实` | accepted/remote_completed/conflict/unknown |
| `features/agent/ui/AgentGenerationResults.tsx:12` | `提交结果待核实` ; `:43` `请先核实供应商任务记录，避免重复提交。` | unknown outcome |
| `features/audio/ui/AudioGenerationBatches.tsx:37` | `提交待核实` / `待恢复保存` / `成果不可用` | uncertain/recovery/unavailable |
| `features/audio/presentation/shared.tsx:168` | `job.status === "uncertain"` branch + raw `job.error` rendered in `<p className="aw-error">` | uncertain, raw error |
| `features/agent/ui/AgentRunDetails.tsx:34` | `准备执行 / 等待批准 / 已批准，等待执行 / 结果待核实` ; `:49` `<strong>操作结果待核实</strong>` + `failure.error` + `failure.recovery` | unknown outcome |
| `features/agent/ui/AgentJobReport.tsx:36-37` | `外部操作结果待核实。可查看已保留的记录，不会自动重新执行。` / `结果待核实，未确认的内容暂不可读取。` ; `:35` `job.error ?? "未能完成，请查看已保留的结果。"` ; `:54` `服务可能已经执行，不会自动重新请求。` | uncertain outcome, raw error |
| `features/agent/ui/AgentJobReport.tsx:34` | `正在停止原 MCP 调用，外部操作结果仍需核实。` | MCP, call |
| `features/agent/ui/AgentDesktopMediaReport.tsx:35` | `导入结果待核对，不会自动重新处理视频。` | |
| `features/library/ui/DesktopMediaImportPanel.tsx:20,100` | `导入结果待核对，已确认的素材仍然保留。不会重复处理这些文件。` / `这次导入是否已受理尚未确认，请先核对，不能重新导入。` | accepted/unknown |
| `features/library/ui/AssetTextField.tsx:60` | `无法确认保存结果，当前草稿已保留。请先核对设定；离开时可以明确放弃这份草稿，当前不会重复保存。` | uncertain write |
| `features/agent/ui/AgentControls.tsx:203` | `内置技能设置的保存结果尚未确认，暂时无法再次修改。请重新加载工作区并核对设置后再操作。` | uncertain write |
| `features/agent/ui/SubmissionMessage.tsx:32-40` | `消息已保存，可查看恢复选项` / `正在核对发送状态…` / `发送未完成`; buttons `核对发送状态` `确认未发送` `查看恢复选项` | submission phase (uncertain/accepted+recoveryRequired) |
| `features/agent/ui/TaskWrapup.tsx:62` | `OUTCOMES = {fact:"记录", downloaded:"已生成 · 未应用", applied:"已应用", unresolved:"待核实"}` ; `:402,570` `版本 {revision}`, `总结版本 {summaryRevision}` (`:557`) | revision |
| `features/audio/ui/AudioArrangementActions.tsx:233-244` | `所选版本 {item.takeId}` / `保留片段 {clip.id} · 版本 {clip.takeId}` / `<summary>预览身份与冲突规则</summary>` / `{proposal.id} · 版本 {proposal.revision}` | raw ids + revision |
| `features/audio/ui/AudioGenerationBatches.tsx:139,143` | `段落版本 {segmentRevision}` / `版本 {speakerRevision}` | revision |
| `features/library/ui/materials/MaterialDetailPanel.tsx:172,184,265` | `版本 {material.revision}` / `版本 {item.revision} · 日期` / `版本 {use.revision} · 历史引用|当前采用` | revision |
| `features/memory/ui/ProjectMemoryPage.tsx:263,354,362` ; `MemoryEditor.tsx:334` ; `MemoryContextDetails.tsx:188,209` ; `TaskRecords.tsx:205,308` ; `MusicGenerationReview.tsx:83` | `版本 {revision}`, `修订历史`, `草稿版本 {draftRevision}` , `最新版本 {current.revision}：…` | revision |
| `features/agent/ui/AgentComposerAttention.tsx:34,41` | `待办读取失败，请刷新后检查执行记录。` / heading `需要你处理` | "待办" / execution record |
| `features/agent/ui/AgentGenerationBatches.tsx:193,463` | `读取批次失败：{view.error}` / `读取失败，当前视图与编辑已保留。{view?.error}` | "批次" |
| `features/settings/ui/ModelCatalogSection.tsx:115` | `内置基线 · 包版本 ${catalog.packageVersion ?? "未知"}` | |
| `features/agent/ui/ModelSelectTrigger.tsx:245` | `无法确认模型类型，请切换连接后重试` | |
| `features/settings/ui/sections/UpdateSection.tsx:91` | `无法比较版本` | |

Search for literal words `reservation` / `authority` / `attempt` in rendered strings: none found in `.tsx` copy (they appear only in identifiers such as `attempt` state counters at `features/video/ui/ShotDetailPanel.tsx:137`, `features/video/services/workspaceRepository.tsx:937`). Equivalent user-visible Chinese terms are "受理 / 待核实 / 核对 / 恢复 / 版本(revision) / 预留(`ContextUsagePanel.tsx:312`)".

Raw error passthrough (error.message / state.reason / job.error rendered unchanged):
`features/settings/ui/ConnectorsPage.tsx:196,210,229,249` (toast, redacted & sliced 300 chars); `features/settings/ui/sections/UpdateSection.tsx:63` (`state.reason`); `features/video/ui/ShotEditorPage.tsx:310,355,1206`, `ShotRow.tsx:179`; `features/agent/ui/AgentRunDetails.tsx:48-51` (`failure.error`); `AgentJobReport.tsx:35` (`job.error`); `features/audio/presentation/shared.tsx:168` (`job.error`); `features/agent/ui/ReferenceLibrary.tsx:65,79,92,114,121`; `features/projects/ui/ProjectGalleryPage.tsx:129,195`; `app/workspace/WorkspaceChrome.tsx:294,306,314`. No numeric/code literals (e.g. `HTTP 4xx`, error-code constants) are hard-coded in UI copy; any codes arrive through `error.message`.

---

## 3. Error/exception placement

### 3a. Toast used for failures that persist (state is not recoverable by dismissing)
- `features/video/ui/ShotEditorPage.tsx:310,355,1051,1206`; `ShotRow.tsx:179` – save/filter-save failures as toast (`保存失败，请重试`, `保存未成功，请先重试或放弃未保存的选择`); relation save shows both a toast (`:1051`) and persistent relation status.
- `features/settings/ui/ConnectorsPage.tsx:196,210,229,249` – connection test/save/disconnect errors as toast (up to 300 chars); the page also has `PageState kind="error"` for read failure (`:276`).
- `features/agent/ui/AgentChatPage.tsx:331-332,364,468` – `任务模式请先选择项目` / `请先配置连接` / `当前草稿已有改动，发送内容仍保留在消息中` / `关联任务失败` toasts at the composer; `:332` fires while the composer connector selector is the trigger control.
- `features/agent/ui/AgentChatPage.tsx:275,307,538-582` – `showError(...)` (global error component, `app/errors/showError`) for rename/delete/model/connector/reasoning/interaction changes, shown away from the sidebar row or composer control that triggered them.
- `features/agent/ui/AgentControls.tsx:47,62` – `读取助手配置失败`, `保存助手设置失败，请重试` toasts; `:203` persistent in-place `setBuiltinError`.
- `features/agent/ui/GenerationReview.tsx:124` – `本次生成已确认，但默认配置保存失败，请稍后重试。` toast (state persists).
- `features/agent/ui/FloatingComposer.tsx:293,302` – voice errors toast.
- `app/workspace/WorkspaceChrome.tsx:293-294,306,314`; `features/projects/ui/ProjectGalleryPage.tsx:129,195,316-317` – backup/cover/create failures as toast; `isPublishedSaveError` → `toast.warning`, otherwise `toast.error(\`备份失败：${message}\`)` (duplicated in both files).
- `features/agent/ui/ReferenceLibrary.tsx:65,79,92` toast, while `:114,121` renders the same class of read failure inline (`role="alert"`).

### 3b. Inline banners in a different region from the trigger
- `features/agent/ui/AgentChatPage.tsx:500` – `execution.error` rendered as `agent-composer-run-status role="alert"` in the composer status strip (styles `agentChat.css:1217-1250`: 12px, `--muted-foreground`, 4px 12px padding); the same `execution.error` is also rendered in `TaskWrapup.tsx:549` (`{error || execution.error}{draft ? "。编辑内容仍保留。" : ""}`) → same error in two regions.
- `features/agent/ui/AgentComposerAttention.tsx:33-34` – read failure `待办读取失败…` sits inside the composer region, while attention list lives in same section (`:39`), so both appear above the input.
- `features/agent/ui/AgentGenerationBatches.tsx:193` (`读取批次失败：…` at top of `.agent-batches`), `:430` (`!open` collapsed view), `:463` (inside open view `读取失败，当前视图与编辑已保留。`), `:591`, `:652` (`text-destructive text-sm`), `:820` (validation) – six alert surfaces in one component; `:193` and `:463` can both be present (parentReadError prop passed at `:196`).
- `features/agent/ui/AgentRunDetails.tsx:46-51` – `RecoveryFailureNotice` shown inside the run details block; certain failures fold into `failureLine` (`:53-56`, prefixes `已回滚：` / `未执行：`).
- `features/agent/ui/InstalledSkillsPanel.tsx:20` (panel-level `installed-skills-notice` for `controller.error`) and `:126` (`pickerError`); `InstalledSkillsContent.tsx:36,81,86,91` (four alerts in one detail view).
- `features/library/ui/AssetTextField.tsx:60` – field-level alert below the control (placed correctly near field); `features/library/ui/AssetLibraryPage.tsx:145-153,226` – `createIssue.kind === "unknown"` handled in header region; `deleteIssue.unknown` in dialog.
- `features/audio/presentation/shared.tsx:168` – `<p className="aw-error">` plus separate `uncertain` hint adjacent.
- Memory: `MemoryContextDetails.tsx:132` (`关联项目不可用；记忆快照仅供查看。`) and `:283` (error + retry); `MemoryEditor.tsx:330-335` conflict notice rendered as `role="status"` containing full latest body.

### 3c. Duplicated errors
- Project-unavailable message: `AgentChatPage.tsx:497` blockedReason + `:510` status row (+ `:331` toast `项目已不可用，请选择其他项目开启新对话`).
- `execution.error`: `AgentChatPage.tsx:500` and `TaskWrapup.tsx:549`.
- Unknown submission outcome in a batch: `AgentGenerationBatches.tsx:530` banner + `JOB_LABELS.unknown` per row (`:151`) + `AgentGenerationResults.tsx:12,43` + `AudioGenerationBatches.tsx:37,120`.
- Backup failure toast logic duplicated: `WorkspaceChrome.tsx:293-294` and `ProjectGalleryPage.tsx:316-317`.
- Connect/test errors: toast (`ConnectorsPage.tsx:196-249`) with no persistent field-adjacent status read in this audit.

---

## 4. Conversation sidebar item

### Files
| File | Role |
|---|---|
| `features/agent/ui/TopicSidebar.tsx` | List, `TopicRow` (`:291-336`), `TopicActivityStatus` (`:339-349`) |
| `features/agent/queries/threadActivity.ts` | `useTopicActivity` → `{busy, waitingApproval, unread, unavailable}` (`:5-12`) |
| `features/agent/ui/agentChat.css:562-641` | Row/trailing/status/spinner styles |
| `features/agent/ui/ThinkingMatrix.tsx`, `agentChat.css:813-843` | Dot-matrix animation |
| `ui/icons.tsx` | Phosphor wrappers (`appIcon`, `:111-132`; default `size=24`, `weight="regular"`) |
| `features/agent/ui/AgentTopicNavigation.tsx:26`, `AgentChatPage.tsx:404`, `ChatWorkspace.tsx` | Mount points of `TopicSidebar` |

### Current row structure (`TopicSidebar.tsx:310-334`)
DOM order inside `.agent-topic-row` (flex, `height:32px`, `border-radius:8px`):
1. `button.agent-topic-row-title` (flex:1, `padding:0 10px`, 14px, ellipsis, colour `rgb(255 255 255 / 72%)`, active → `--foreground`)
2. `span.agent-topic-row-trailing` (`width:58px`, `margin-right:4px`) containing `time.agent-topic-row-time` (12px, `--muted-foreground`, tabular) and `span.agent-topic-row-actions` (absolute overlay; rename `Pencil` 16px, delete `Trash2` 16px; revealed on `:hover`/`:focus-within`, time hidden then; `agentChat.css:608-614`; coarse-pointer override `:617-619`)
3. `TopicActivityStatus` → `span.agent-topic-row-status` (`width:27px; height:24px; margin-right:8px; gap:5px`, `agentChat.css:602`) – **trailing**, after the time/actions cluster.

No leading marker exists; title starts at 10px padding with no icon.

### Marker positions today (all trailing, rightmost)
| State | Visual | Where |
|---|---|---|
| running / loading (`busy` = `live.active || live.stopping`) | 14×14 ring, `border:1.5px`, `rgb(255 255 255/25%)` track with `/75%` top arc, `agent-topic-spin` 900ms linear infinite (`agentChat.css:603-604,615`); disabled under `prefers-reduced-motion` (`:616`) – not a ThinkingMatrix; same `i.agent-topic-spinner` element is always rendered (transparent when idle) | trailing status box |
| unread (`publicRevision > readRevision` for thread or any report) | 5×5 dot, `background: var(--foreground)` when `.is-unread`, transparent otherwise (`:605-606`) | trailing status box, before spinner (DOM order unread → spinner) |
| approval waiting (`waitingApproval`: last run `status === "waiting_approval"`, `threadActivity.ts:41`) | **No visual marker.** Only used in the sr-only/title label `等待批准` (`TopicSidebar.tsx:341-342`) and only if not `busy` | label only |
| state read failure (`unavailable`) | literal `!` in `span.agent-topic-unavailable`, absolute right:4px, 11px, `--muted-foreground` (`:607`) | trailing |

Accessible text: `title` on status span and `sr-only` span linked via `aria-describedby` (`:311-313,343-346`): `进行中` / `等待批准` / `有未读内容` / `状态读取失败` joined by `，`.

### ThinkingMatrix (reuse facts)
- `features/agent/ui/ThinkingMatrix.tsx`: 3×3 grid (`THINK_COLS=3`, `THINK_ROWS=3`), per-column 2-cell snakes, `TICK_MS=220`, `COLUMN_PHASE=2`, own `setInterval` per mounted instance (`:83-89`), static pattern under reduced-motion (`:61-65,81`); root `role="status" aria-label="思考中" aria-busy`; no props.
- Size: cells 3×3px, gap 2px → 13×13px grid (`agentChat.css:821-838`), `border-radius:0`, on-colour `rgb(200 200 200 / 90%)`, wrapper `min-height:11px; padding-block:1px`.
- Currently used once: `MessageList.tsx:17,242` (`showMatrix` while empty streaming). Exports `paintSnakeCells`, `stepColumn`, `THINK_COLS/ROWS` (module-level, testable).
- Rows are rendered per thread (`TopicActivityStatus` per mounted row); a ThinkingMatrix instance has its own timer (not shared across instances).

### icons.tsx facts
- `appIcon(Glyph, defaultWeight, mirror)` wraps Phosphor icons; props `size` (default 24), `weight` (`regular`/`fill`…), `mirrored`; used in sidebar at 12/14/16px (`TopicSidebar.tsx` chevrons 12, search/filter/plus 14, nav/folder/row actions 16).
- Relevant existing exports: `LoaderCircle` (`PhCircleNotch`, `:189`), `CircleAlert` (`PhWarningCircle`, `:156`), `AlertTriangle` (`:135`), `Circle` (`:155`), `Check`/`CheckCircle2`, `Hand` (`:174`), `ShieldQuestion` (used in `AgentRunDetails.tsx:38` for awaiting approval, amber `text-amber-500`), `Pause`, `Pin`. `LoaderCircle` with `animate-spin motion-reduce:animate-none` is the pattern used for running tool steps (`AgentRunDetails.tsx:37`).
- Colour tokens in play: `--foreground` (`oklch(0.97 0 0)`, `ui/theme.css:60`), `--muted-foreground` (`oklch(0.7 0 0)`, `:70`), amber literal `#d2ac64` (`agentChat.css:1235`), `text-amber-500`/`text-green-500`/`text-destructive` Tailwind classes in run-step icons; row backgrounds `rgb(255 255 255 / 5%|8%)`.
- Row sizes: row 32px, nav item 32px, group row icons 16px, chevron 12px, row action icons 16px, trailing box 58px, status box 27px, spinner 14px, unread dot 5px, title font 14px, time 12px.

---

## 5. Ranking by user impact — top 10 offenders

1. **Uncertain-outcome vocabulary on the main chat path** – `AgentGenerationBatches.tsx:151,530`, `AgentGenerationResults.tsx:12,43`, `AgentRunDetails.tsx:34,49`, `AgentJobReport.tsx:36-37,54`, `AudioGenerationBatches.tsx:37,120` (`提交结果待核实`, `操作结果待核实`, `服务可能已经执行…`, `请先核实供应商任务记录`). ~12 sites, one concept.
2. **`版本 {revision}` shown to users** – ~25 sites (`MaterialDetailPanel.tsx:172,184,265`, `ProjectMemoryPage.tsx:263,354,362`, `TaskWrapup.tsx:402,557,570`, `TaskRecords.tsx:205,308`, `AudioGenerationBatches.tsx:139,143`, `AudioArrangementActions.tsx:233-244`, `MemoryContextDetails.tsx:188,209`, `MusicGenerationReview.tsx:83`).
3. **Composer status strip stacks 4+ messages/errors** – `AgentChatPage.tsx:499-515` (`execution.error`, attention heading `需要你处理`, project-unavailable twice, `需求沟通中 …`, task summary) plus duplicate `execution.error` in `TaskWrapup.tsx:549`.
4. **Sidebar item has no approval-waiting marker and all markers are trailing** – `TopicSidebar.tsx:339-349`, `agentChat.css:602-607`; `!` for read failure is an unexplained glyph; spinner is a CSS ring not shared with ThinkingMatrix/`LoaderCircle`.
5. **Submission recovery wording** – `SubmissionMessage.tsx:32-40` (`消息已保存，可查看恢复选项`, `核对发送状态`, `确认未发送`, `发送未完成`).
6. **Generation batch component with six alert surfaces + long warning** – `AgentGenerationBatches.tsx:193,430,463,530,591,652,820`.
7. **Toast-only persistent save/connection errors** – `ShotEditorPage.tsx:310,355,1051,1206`, `ShotRow.tsx:179`, `ConnectorsPage.tsx:196-249`, `WorkspaceChrome.tsx:293-314`, `ProjectGalleryPage.tsx:129,195,316-317`.
8. **Uncertain-write text in library/agent settings** – `AssetTextField.tsx:60`, `DesktopMediaImportPanel.tsx:20,100`, `AgentControls.tsx:203`, `AgentDesktopMediaReport.tsx:35`.
9. **PageHeader/PageState descriptions restating titles & tutorial empty states** – ~20 sites (section 1, e.g. `ProjectMemoryPage.tsx:73`, `EpisodeListPage.tsx:155`, `IpProfilesPage.tsx:79`, `AssetLibraryPage.tsx:139`, `TaskBoard.tsx:101`).
10. **Settings explanatory rows** – `UpdateSection.tsx:88-119` (7 rows), `StorageSection.tsx:25-35`, `AppearanceSection.tsx:6,9`, `GeneralSection.tsx:44`.

---

## Caveats / Not Found

- Desktop shell: `apps/desktop/src/main.tsx` is the only TS file in `apps/desktop/src` (entry only); user-facing strings live in `packages/studio` and `apps/desktop/src-tauri/tauri.conf.json` (window title `小光点 Cuepoint`, `:21`). No separate desktop UI copy audited; Rust-side error messages (`src-tauri/src/**`) were not inventoried and may surface via `error.message` passthrough.
- Counts are from regex sweeps; multi-line JSX and strings built in `.ts` command/runtime modules (e.g. `features/agent/commands`, `runtime`) that become `error.message` were not enumerated (e.g. origin of `execution.error`, `failure.error`, `failure.recovery`, `job.error`).
- Strings `reservation`, `authority`, and raw error-code literals were not found in rendered UI copy.
- No runtime/visual verification was performed (no screenshots); style values are from CSS source.
