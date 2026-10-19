# 弹窗 vs 右侧栏盘点

来源：调研子 agent 的报告（由主会话落盘）。路径相对 `packages/studio/src/`。复杂度为读代码后的判断：L=重命名/确认，M=1–3 字段表单或查看器，H=多段落/多步骤工作流。未做运行时验证。

## 范围说明

- 没有 antd、Popconfirm、Drawer。弹层都是 `ui/` 下的 Radix 封装（`dialog.tsx`、`alert-dialog.tsx`、`sheet.tsx`、`popover.tsx`），另有 `AgentGenerationBatches.tsx` 里一处裸 `DialogPrimitive`。
- `apps/web` 无弹窗；`apps/desktop/ui/acceptance.tsx` 未读；`apps/site` 不在范围内。

## 可复用的右侧栏机制

1. `app/layout/context-panel.tsx` + `ContextPanelHost.tsx`：右侧停靠，无法停靠时回退全宽；同一时间只有一个面板，新的替换旧的；`onRequestDeparture(proceed, cancel)` 用于守住未保存草稿；宽度可配（300/400/520）。已被 `TaskInspector`、`InstalledSkillsPanel`、`McpConnectionsPanel`、`MemoryContextDetails`、`AudioWorkspacePage`、`MusicWorkspacePage`、`MaterialDetailPanel` 使用。
2. `app/details/BusinessDetails.tsx`：`useBusinessDetails().open(target, {origin})` 与 `returnToOrigin`。目前只支持 `shot` 和 `asset` 两类目标，带返回来源与拒绝协议。批量弹窗通过 `openAfterModalRelease`（`AgentGenerationBatches.tsx:395`）移交给它，原因是弹窗与面板争抢焦点。
3. 相关 spec：`.trellis/spec/frontend/agent-business-details.md`、`agent-batch-generation.md`。

## 明细表

### 建议改右侧栏

| 位置 | 触发 | 复杂度 | 理由 |
|---|---|---|---|
| `agent/ui/AgentGenerationBatches.tsx:433-643` | 批次条「打开」 | H | 逐目标候选列表、克隆/移除、配置、参考、指标、对比/选用/回写、暂停/重试；已需移交给 Shot/Asset 面板 |
| `audio/ui/AudioGenerationBatches.tsx:176-201` + `:122-161` | 批量配音（选段 + 确认） | M/H | 两步批量流程，列表随章节增长；应合并成一个面板 |
| `audio/ui/AudioArrangementActions.tsx:162-230` | 批量选版本/编排音色 | H | 表单 → 提案预览 → 应用；音频工作区已有面板宿主 |
| `library/ui/materials/MaterialImportDialog.tsx:155-189` | 导入媒体与资料 | H | 多文件、进度、停止、未知状态处理；同目录已有 `MaterialDetailPanel` |
| `video/ui/ProductionProposalsPanel.tsx:207-258` | 准备镜头变更 | H | 多步提案 + 前后对比 |
| `library/ui/GenerationSlotCard.tsx:355-` | 编辑生成槽位 | H | 提示词、参考图、选择器、上传、复用素材，是编辑器不是重命名 |
| `audio/ui/VoiceLibrary.tsx:123-` | 音色库新建/编辑 | H | 弹窗内自带列表/详情导航 |
| `video/ui/ShotEditorPage.tsx:1058-1092` | 镜头道具与风格 | M | 自动保存的持久编辑，可并入 `ShotDetailPanel`（中） |
| `library/ui/IpProfileEditor.tsx:123-170` | 新建/编辑 IP | M/H | 多个 20000 字长文本框（中） |
| `memory/ui/MemoryEditor.tsx:224-` | 项目记忆编辑 | M/H | 与上同类，`MemoryContextDetails` 已是面板（中） |
| `settings/ui/ModelCatalogPicker.tsx:113-` | 同步模型 | H | 搜索、厂商筛选、勾选长列表（中） |
| `agent/ui/ReferenceLibrary.tsx:97-` | 项目资料 | M/H | 标签、搜索、列表、导入，是资料库浏览器（中） |
| `app/workspace/WorkspaceChrome.tsx:387-428` | 项目设定 | M/H | 设定 + 封面上传 + 自动保存（低） |
| `agent/ui/TaskRecords.tsx:240-`、`:302-`；`TaskInspector.tsx:388-`；`TaskWrapup.tsx:566-` | 工作记录/目标/收尾历史 | M | 全部是「面板上叠弹窗」，改动成本最低（低） |
| `audio/ui/AudioSources.tsx:140` | 从库中添加 | M | 选择器（低） |

### 保留弹窗

| 位置 | 理由 |
|---|---|
| `AgentGenerationBatches.tsx:698-721` 放大图 | 灯箱属于合理的弹窗用法；迁移后需另定层级 |
| `audio/ui/AudioSources.tsx:126` 录音 | 麦克风活动期间应为模态 |
| `audio/ui/ScriptDocument.tsx:86-` 粘贴稿件 | 单输入导入步骤 |
| `settings/ui/ConnectorsPage.tsx:335-`、`SearchConnection.tsx:88-` | 有边界的小表单（连接器若再变长可再议） |
| `agent/ui/ReferenceAttachments.tsx:125/148/206`、`LegacyMaterialSources.tsx:111-` | 预览/只读查看器 |
| `projects/ui/ProjectGalleryPage.tsx:340-`（新建）、`:448-`（绑定 IP）、`:466-`（重命名） | 轻量创建/选择/重命名 |
| `agent/ui/AgentChatPage.tsx:676-` 重命名线程；`TaskBoard.tsx:157-` 新建任务；`FloatingComposer.tsx:320-`；`AboutPage.tsx:85-`；`ErrorDetailsDialog.tsx:80-` | 轻量或静态内容 |
| `library/ui/AssetLibraryPage.tsx:380-` 从工作室添加 | 选择列表，两可 |
| `app/layout/AppFrame.tsx:200` 移动端导航 Sheet | 左侧导航抽屉合理 |
| 全部 AlertDialog 确认（20 处，见下） | 删除/丢弃确认正是弹窗的本职 |

AlertDialog 位置：`WorkspaceChrome.tsx:429`、`useManualDraftGuard.tsx:134`、`ShotEditorPage.tsx:1093`、`EpisodeListPage.tsx:211`、`ProductionProposalsPanel.tsx:258`、`ProjectGalleryPage.tsx:496`、`IpProfilesPage.tsx:259`、`IpProfileEditor.tsx:172`、`AssetLibraryPage.tsx:210`、`AssetLibraryPages.tsx:187`、`MaterialControls.tsx:103`、`MaterialDetailPanel.tsx:306/319`、`ReferenceLibrary.tsx:140`、`AgentGenerationBatches.tsx:644`、`McpConnectionDetail.tsx:48`、`AgentChatPage.tsx:704`、`AudioSources.tsx:133`、`MemoryEditor.tsx:439`、`ProjectMemoryPage.tsx:450`、`ModelCatalogSection.tsx:147`。

Popover 保持原样：`ShotEditorPage.tsx:700/850`、`AudioTimeline.tsx:413/495/505/524/577`、`ScriptDocument.tsx:179`。

## 优先迁移点（前 5）

1. 批量图片生成审阅 `AgentGenerationBatches.tsx:433`：用户明确举的例子；面板与 Shot/Asset 移交机制已具备，迁移后可去掉弹窗/面板的焦点移交。
2. 批量配音 `AudioGenerationBatches.tsx:176/122`：合并为音频工作区面板（该页已有 `ContextPanel`，`AudioWorkspacePage.tsx:251`）。
3. 素材导入 `MaterialImportDialog.tsx:155`。
4. 镜头变更提案 `ProductionProposalsPanel.tsx:207` + 音频编排 `AudioArrangementActions.tsx:162`：同属「编辑 → 对比」两步流程。
5. 槽位编辑 `GenerationSlotCard.tsx:355` + 音色库 `VoiceLibrary.tsx:123`。

备选：`ModelCatalogPicker`、`ReferenceLibrary`、`IpProfileEditor`、`MemoryEditor`，以及 `TaskInspector` 上叠的三个弹窗（成本最低）。

## 风险与局限

- `ContextPanelHost` 同一时间只允许一个面板，批量审阅与 Shot/Asset 详情面板如何共存需要先决定；现有 `origin`/`returnToOrigin` 只覆盖一部分。
- 部分弹窗只读了前 50–100 行；`apps/desktop/ui/acceptance.tsx` 未读。
