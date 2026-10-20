# 右侧栏承载复杂界面与表单：实施计划

每批一次提交，可独立回滚；批与批之间可以暂停（owner：慢慢做）。通用验证：`pnpm lint`、`pnpm quality`、该批相关测试；S7 与每个业务批结束时跑全量 `pnpm exec vitest run`（需要 Rust 探针的原生测试在本机失败属环境问题）。从上一个任务学到的：**每批都要跑全量或至少跑改动文件所在目录的全部相关测试，不要只挑自己写的**；改了某个共享函数的参数含义（如批次编号）要逐个核对调用点，类型检查查不出同类型的误用。

## 节奏（owner：一次搞定，不要碎）
整件事连续做完，中间不停下来问。提交按功能分段（便于单独回滚），但这只是内部分段，不是让 owner 逐段确认。顺序：地基 → 对话流表单与批量审阅 → 其余业务区弹窗 → 收口。没有子任务拆分。

## S1 地基（顶栏三区 + 面板入口 + 拖宽 + 底部操作区，一并做）
- 顶栏改三列网格与 CSS 变量（`--app-nav-width`、`--app-panel-width`），分割线；左区迁入 leading + history 控件；中区保留 `app-header-slot`，新增 `app-header-actions` 槽与 `AppHeaderActionsPortal`、打开侧栏开关；右区 `AppPanelHeaderPortal`。
- `ContextPanelHost`：`openAuto(id, key)`、`open(id)`、关闭记忆；拖宽手柄与宽度持久化（`deviceSettings` 的 `panelWidth:<kind>`）；`ContextPanelFooter`；`ContextPanelHeaderBar`。
- 现有 7 处面板使用方不改行为（兼容旧 `ContextPanelHeader`），仅换头部位置的可选接入。
- 验证：`pnpm lint`、`pnpm quality`；新增 `tests/appFrameHeaderZones.test.tsx`（列宽变量、分割线、面板开合时右区出现/消失）、`tests/contextPanelHost.test.tsx`（openAuto 条件、关闭记忆、守卫替换、拖宽范围与持久化、覆盖态不自动展开）；现有面板相关测试全跑。
- 风险文件：`AppFrame.tsx`、`ContextPanelHost.tsx`、`context-panel.tsx`、`ui/theme.css`。
- 回滚点：整批 revert，无数据变化。

## S2 批量审阅
- `AgentGenerationBatches` 审阅弹窗 → 面板内容；确认生成/保存草稿/放弃批次 → 底部操作区；删除弹窗焦点交接；输入框批量行「审阅」→ `host.open`；批量就绪 → `host.openAuto(batch:<id>)`。
- 验证：`tests/agentGenerationBatch*.test.ts`、`tests/agentBatchCards.test.ts`、`tests/e16BatchDetailHandoff.test.ts`（改断言新载体）、新增面板入口/自动展开/离开守卫测试。
- 回滚点：revert 本批；S1 保留。

## S3 对话流表单
- 生成提案、音乐生成、收尾总结 → 面板；桌面导入停止/核对、MCP 结果核对 → 输入框上方的行；对话流只留一行状态。
- 动手前读码确认三处表单的草稿/守卫状态（见 design §9）。
- 验证：相关 UI 测试 + 新增面板/行测试；`tests/agentActionCards.test.ts` 扩展。

## S4 音频
`AudioGenerationBatches`（选段+确认合并）、`AudioArrangementActions`、`VoiceLibrary`、`AudioSources` 库选择。验证：`tests/audio*.test.ts`。

## S5 素材与资料
`MaterialImportDialog`、`GenerationSlotCard`、`IpProfileEditor`、`MemoryEditor`、`ReferenceLibrary`、`WorkspaceChrome` 项目设定。验证：素材库/IP/记忆相关测试。

## S6 视频与设置
`ProductionProposalsPanel`、`ShotEditorPage` 镜头道具与风格、`ModelCatalogPicker`、`ConnectorsPage`（视复杂度）、`TaskRecords/TaskInspector/TaskWrapup` 上叠的三个弹窗。

## S7 收口
- `tests/dialogUsage.test.ts`：扫描 `Dialog`（非 `AlertDialog`）使用点，允许清单之外失败。
- spec：`app` 布局与面板、`agent-business-details.md`、`desktop-ui.md`、`interaction-feedback.md`；长期记忆核对。
- 全量验证与真机走查清单（顶栏三区、自动展开、拖宽、窄屏覆盖、焦点）。

## 依赖
S1 先行；S2、S3 依赖 S1；S4–S6 各自依赖 S1，彼此独立；S7 最后。

## 开始前需 owner 确认
design.md §8 的默认值 D1–D8。
