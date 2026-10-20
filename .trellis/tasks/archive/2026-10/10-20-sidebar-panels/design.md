# 右侧栏承载复杂界面与表单：设计

路径相对 `packages/studio/src/`。标【读码确认】的来自读代码；标【未核实】的实现该批次时再确认。本设计只定地基与迁移方法，逐处迁移的细节在各批次动手前再读码细化。

## 1. 现状（读码确认）

- **顶栏**：`app/layout/AppFrame.tsx:166` 的 `app-topbar` 是横跨整个窗口的一条，含 logo、后退/前进/导航开关（`app-history-controls`）、一个由各功能通过 `AppHeaderPortal` 塞内容进来的标题槽（`app-header-slot`）、兜底标题。下面的 `app-frame-body` 才是 导航栏（`app-navigation`）| 工作面（`WorkingSurface`：内容 + 面板宿主）。
- **面板机制**：`app/layout/context-panel.tsx`（`ContextPanel`、`ContextPanelContent`、`ContextPanelHeader/Title/Description`）+ `ContextPanelHost.tsx`。面板内容用 portal 渲染进 `.app-context-panel-host`。同一时间一个活动面板；新面板通过 `request → outgoing.depart(proceed, cancel)` 的「离开守卫」协议替换旧的，旧面板拒绝则新面板收到 `close("guard-refused")`。每个面板注册自己的宽度。
- **停靠**：`docked = surfaceWidth >= navigationWidth + width + 480`，否则 `fullWidth`：面板盖住内容，工作区 `inert` 并保留挂载。
- **焦点**：`ContextPanelContent` 的 `onMountAutoFocus` 在停靠状态已 `preventDefault`，即停靠面板默认不抢焦点；全宽（覆盖）时才接管焦点。`FocusScope`、`DismissableLayer`、Escape 关闭、`createOverlayFocusReturn` 已有。
- **不具备**：自动出现的触发入口、拖宽、固定底部操作区、右区顶栏头部。面板头部是面板里自己的一行（`ContextPanelHeader`，`p-4 pr-10`，右上角 `context-panel-close`）。
- **业务详情**：`app/details/BusinessDetails.tsx` 的 `open(target, {origin})` / `returnToOrigin`，目前只支持 `shot` 与 `asset`；批量审阅弹窗通过 `openAfterModalRelease`（`features/agent/ui/AgentGenerationBatches.tsx`）把焦点交给它，原因是弹窗与面板争焦点——迁成面板后这段交接可以删。
- **弹窗盘点**：`../10-19-product-audit-direction/research/modal-vs-sidebar-audit.md`（约 15 处改右侧栏，AlertDialog 确认约 20 处保留）。
- **对话流里的表单**：`GenerationReview.tsx`、`MusicGenerationReview.tsx`、`TaskWrapup.tsx`；单动作按钮：`AgentDesktopMediaReport.tsx`、`AgentJobReport.tsx`；批量审阅弹窗含「确认生成/保存草稿」（它们读审阅时的本地编辑状态）。

## 2. 目标结构

```
┌ 左区(=导航列宽) ┬ 中区(=内容区) ──────────────────────┬ 右区(=面板宽, 仅面板打开时) ┐
│ logo ← → ⊟     │ 标题 ✎重命名            任务 ⊞侧栏   │ 面板标题 / 面板自带操作  ✕   │
├────────────────┼──────────────────────────────────────┼───────────────────────────────┤
│ 导航列          │ 内容区                               │ 面板主体(可滚动)               │
│                │                                      │ ─ 固定底部操作区(确认/保存) ─ │
└────────────────┴──────────────────────────────────────┴───────────────────────────────┘
```
三区之间只用 1px 分割线，不做成卡片。

## 3. 顶栏三区

- `app-topbar` 改为三列网格，列宽由 CSS 变量驱动：左区 `--app-nav-width`（导航列实际宽度，导航收起时随之收窄）、中区 `1fr`、右区 `--app-panel-width`（面板关闭为 0 且无分割线）。变量由 `AppFrame` 根据导航状态与 `ContextPanelHost` 的 `width/docked/active` 写到 `.app-frame` 上。
- 左区放现有的 `app-topbar-leading` 与 `app-history-controls`，原样迁入，不改行为。
- 中区保留现有 `app-header-slot` 的 portal 约定（各页面已经往里塞标题，零迁移），新增同级 `app-header-actions` 槽放右端快捷按钮（`AppHeaderActionsPortal`），**打开侧栏的开关固定放在这里最右**，没有面板可开的页面不显示。
- 右区是新 portal 目标 `AppPanelHeaderPortal`：面板调用 `<ContextPanelHeaderBar title actions/>`，内容被渲染进右区；`showCloseButton` 的关闭按钮移到右区最右。面板不提供时右区留空（只有分割线与关闭按钮）。
- 全宽覆盖模式（放不下）：右区并入中区，面板头部显示在覆盖层顶部，保持「返回」入口；顶栏仍是左区 + 中区，不会被面板盖住（沿用现有「覆盖不遮挡顶栏与导航」约定）。
- macOS 覆盖式标题栏：`data-tauri-drag-region="deep"` 目前挂在整条 `app-topbar`；三区各自需保证按钮 `data-tauri-drag-region="false"`、空白处可拖动。【未核实】Windows 自绘标题栏下三区的拖动区域与 `--dsh-windows-sidebar-width` 类似的内缩是否需要。

## 4. 面板宿主

- **单面板不变**（owner 决定）。新增两个入口：
  - `host.openAuto(id, key)`：仅当 `host.active === null` 且 `key` 未被用户关闭过才展开，且不抢焦点（沿用停靠态的 `preventDefault`；覆盖态下不自动展开，只在输入框上方保留行——覆盖会盖住对话，不能自动发生）。
  - `host.open(id)`：用户显式点「审阅」；若已有面板，走现有 `request` + 离开守卫替换。
- **关闭记忆**：用户关闭面板时记录 `key = "<kind>:<对象 id>"` 到会话级集合（不持久化），同一 key 不再自动展开；对象内容变化（revision 变）算新 key。
- **拖宽**：面板左缘拖拽手柄，`pointer` 事件 + `setPointerCapture`，范围 `[320, min(720, 面板可用宽)]`，同时保证内容区不低于既有的 480；宽度按「面板种类」写入 `deviceSettings`（`panelWidth:<kind>`），无记录用注册时的默认宽度。键盘：手柄可聚焦，左右方向键步进 16px。拖动中不改变停靠判定，松开后再重算。
- **窄屏覆盖**：保持现有 `fullWidth` 逻辑；窗口再变宽自动回到停靠，面板内容不重新挂载（沿用 portal 子树不换分支的约束，见 `context-panel.tsx` 注释）。
- **固定底部操作区**：新增 `ContextPanelFooter`，主体滚动、底部固定。表单类面板把「确认/保存/取消」放这里（参照任务工作台底部的「归档 / 检查并收尾」）。

## 5. 从弹窗/对话流迁移的统一做法

1. 内容组件抽出为「面板内容」，**状态与守卫沿用**：未保存编辑用现有 `onRequestDeparture` 拦截；弹窗里的 `useBlocker` 路由守卫保留。
2. 触发点从「点按钮开弹窗」变为：输入框上方的行（已有批量行、审批行）的「审阅」→ `host.open(id)`；agent 新产生待审内容 → `host.openAuto(id, key)`。
3. 对话流里原来渲染表单的位置只留一行状态文字（例如「生成提案待确认」），不留按钮。
4. 删掉弹窗专用的焦点交接（`openAfterModalRelease` 等），面板与详情面板之间改用现有 `origin / returnToOrigin`。
5. 每处迁移带测试：入口行出现、面板内容渲染、未保存时离开被拦、关闭后不重复自动弹出、窄屏覆盖下操作可用。
6. 弹窗留存规则落成测试：`tests/dialogUsage.test.ts` 扫描 `Dialog`（非 `AlertDialog`）的使用点，必须在允许清单内（重命名、单输入项、灯箱预览、录音）；新增复杂弹窗即失败。

## 6. 迁移清单与批次（对应 implement.md）

| 批次 | 内容 |
| --- | --- |
| S1 地基 | 顶栏三区、面板宿主新入口（openAuto/open/关闭记忆）、拖宽、底部操作区、`ContextPanelHeaderBar`、spec 更新 |
| S2 批量审阅 | `AgentGenerationBatches` 审阅弹窗 → 面板，含「确认生成/保存草稿/放弃批次」；输入框行「审阅」改 `host.open`；批量就绪自动展开；移除弹窗焦点交接 |
| S3 对话流表单 | `GenerationReview`（生成提案）、`MusicGenerationReview`、`TaskWrapup` 收尾 → 面板；`AgentDesktopMediaReport`、`AgentJobReport`(MCP 核对) → 输入框行 |
| S4 音频 | `AudioGenerationBatches`（选段 + 确认合并为一块）、`AudioArrangementActions`、`VoiceLibrary`、`AudioSources` 库选择 |
| S5 素材与资料 | `MaterialImportDialog`、`GenerationSlotCard` 槽位编辑、`IpProfileEditor`、`MemoryEditor`、`ReferenceLibrary`、`WorkspaceChrome` 项目设定 |
| S6 视频与设置 | `ProductionProposalsPanel` 镜头变更、`ShotEditorPage` 镜头道具与风格、`ModelCatalogPicker`、`ConnectorsPage`（视复杂度）、`TaskRecords/TaskInspector/TaskWrapup` 上叠的三个弹窗 |
| S7 收口 | `dialogUsage` 测试落地并清单化；spec 与记忆更新；全量验证；视觉走查 |

顺序依据：S2 是 owner 点名的第一例且已有批量行；S3 做完后「对话流没有表单」成立；S4–S6 在其他业务区，彼此独立，可按需要调整或暂停（owner：慢慢做）。

## 7. 风险

| 风险 | 对策 |
| --- | --- |
| 弹窗改面板后焦点/Escape/返回行为变化 | 沿用 `FocusScope`/`DismissableLayer`/`createOverlayFocusReturn`；每批带焦点测试；真机走查 |
| 未保存草稿在面板被替换/关闭时丢失 | 全部走现有离开守卫，不新增绕过路径；覆盖态关闭同样走守卫 |
| 顶栏三区与导航列/面板宽度对不齐 | 宽度由同一组 CSS 变量驱动，导航与面板也读这组变量；加快照级 DOM 测试断言列宽变量 |
| 窗口拖动区域（macOS 覆盖标题栏、Windows 自绘） | 三区逐一标注 `data-tauri-drag-region`；Windows 只做规划，不在本机验证 |
| `:has()`/`position` 等 CSS 在 WKWebView / WebView2 的差异 | 只用已在仓库使用过的特性；真机走查 |
| 一次性迁约 20 处的回归面 | 每批独立提交、独立回滚；每批跑相关测试 + `pnpm quality`；S4–S6 之间无依赖 |
| 测试大量依赖弹窗（`Dialog` mount/role） | 迁移同批更新；不删测试，改断言新载体 |

## 8. 默认值（待 owner 过目，不同意可逐条改）

- D1 面板宽度范围 320–720，内容区最小 480，按面板种类记住宽度。
- D2 覆盖态（放不下）不自动展开，只显示输入框上方的行；点「审阅」才覆盖。
- D3 关闭记忆只在当前会话内有效，不持久化；对象内容更新算新的一件事。
- D4 面板底部固定操作区：主操作在右，次操作在左，破坏性操作（放弃批次）放菜单。
- D5 右区无自定义操作时只显示面板标题与关闭按钮。
- D6 弹窗允许清单：重命名类单输入、灯箱预览、录音；其余 Dialog 一律不允许。
- D7 本任务不做标签页、不做同时多块面板。
- D8 本任务不做自动加宽桌面窗口（owner 已选「占一列让出内容宽度」）。

## 9. 未核实

- 导航列在窗口里的实际宽度来源（`navigationWidth` 与 `--module-navigation-width` 的关系）与左区对齐方式。
- Windows 自绘标题栏下顶栏的内缩与拖动区域。
- `GenerationReview`/`MusicGenerationReview`/`TaskWrapup` 的守卫与草稿状态能否原样搬进面板（读码在 S3 动手前做）。
- 各业务区弹窗里是否还有未列入盘点的复杂弹窗（`apps/desktop/ui/acceptance.tsx` 未读）。
