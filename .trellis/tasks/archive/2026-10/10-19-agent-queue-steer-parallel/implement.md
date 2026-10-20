# Agent 排队插队与批量并行：实施计划

来源：规划 agent 草案，主会话落盘并补充 B4a（消息内操作按钮迁移）。顺序：B0 → B1 → B2 → B3 → B4a → B4 → B5 → B6 → B7。

## 通用约定

- 每批一个独立提交，可单独回滚；批内不拆提交。提交由 owner 要求时才做，信息末尾按系统提示加归属行。
- 改动 `packages/agent-core` 之后，先 `pnpm agent:build`，否则默认 `vitest.config.ts` 的新鲜度检查会失败。
- 单个测试文件：`pnpm exec vitest run tests/<file>.test.ts`；agent-core 源码测试：`pnpm exec vitest run -c vitest.agent-source.config.ts`。
- 每批结束前固定执行 `pnpm lint`（`tsc -b`）加相关测试；B7 做全量：`pnpm test`、`pnpm quality`、`pnpm agent:example:check`、`pnpm test:storage:native`。
- 新增测试文件登记到对应 `vitest.*-source.config.ts` include；新增源文件若被 `pnpm quality` 报告未登记，再补 `quality/studio-ownership.json`（未核实是否必须）。

## B0 统一「过期用户消息」谓词（纯重构，无行为变化）

- 新建 `agent/models/chatTurns.ts`，导出 `isLaterUserTurn(message, run)`，此时不含 `steeredIntoRunId` 分支，行为与现有内联判断完全一致。
- `ChatMessage` 新增可选字段 `origin?: "system"`、`steeredIntoRunId?: Id`、`display?: string`，此批不使用。
- 替换 6 处内联判断：`commands/agentTools.ts`（`requireLatestRun`）、`commands/agentFinishingCheck.ts`、`commands/agentProjectCreation.ts`、`runtime/activityAttention.ts`、`music/agent/musicGenerationReview.ts`、`audio/commands/batches.ts`。
- 风险文件：上述 6 个，尤其 `activityAttention.ts` 与 `batches.ts`（写法略有差异，逐处对照）。
- 验证：`pnpm lint`；`pnpm exec vitest run tests/agentRuns.test.ts tests/agentFinishingCheck.test.ts tests/agentActivityAttention.test.ts tests/agentToolsReview.test.ts tests/audioGenerationBatch.test.ts`；`grep -rn 'role === "user" && .*createdAt >' packages/studio/src` 无剩余内联判断。
- 回滚点：整个提交可 revert，无数据变化。

## B1 数据模型与迁移

- 新建 `agent/models/agentPendingInput.ts` 与 `agent/commands/agentPendingInputs.ts`（入队、编辑、改模式、移动、删除、hold、系统项 upsert、容量校验），暂不接运行时。
- Dexie `version(28)`、`schema.ts`、`schema.json`、`tableTypes.ts`、类声明；`tests/storageRegistryHash.test.ts` 无需更新（仓库无 `PINNED_REGISTRY_HASH`）；`deleteChatThread`、`deleteProject` 级联；更新 `shared-product-storage.md` 的表数与版本号。
- 风险文件：`schema.ts` 与 `schema.json`（必须一致）、`browserDatabase.ts`、`commands/lifecycle.ts`。
- 验证：`pnpm lint`；`pnpm exec vitest run tests/agentPendingInputs.test.ts tests/storageRegistryHash.test.ts tests/sharedStorageContract.test.ts tests/sharedNativeStorageContract.test.ts tests/productStorage.test.ts`；本机有原生环境则 `pnpm test:storage:native`。
- 回滚点：发版前整体 revert；发版后不可降级 Dexie 版本，表保持为空表。

## B2 队列核心与出队

- `settleRun` 内加 `holdPendingInputs`，补 5 个调用点的 scope：`finishAgentRun`、`runChat` 的 `settle`、`cancelAgentRun`、`pauseAtModelStepLimit`、`interruptThreadRuns`。
- `beginAgentRun` 新增选项 `pendingInput:{id, revision}`，事务内校验并删行；`executeNewChatMessage` 透传。
- `runOwnership.ts` 导出 `ThreadLockBusyError`，替换原抛错。
- `agentExecutionService` 新增 `enqueue`、`editPending`、`removePending`、`setPendingMode`、`movePending`、`dispatchPending`、`drainQueue`；`claim` 的 `finally` 里 `scheduleDrain`；`initialize()` 在恢复之后只对系统项 drain；新增 invocation 种类 `queue`；派发前先 `readAgentAdmission`，失败转 `held` 并写 `lastError`。
- 风险文件：`agentRunTerminalState.ts`（唯一终态写入点）、`agentRuns.ts`、`agentExecutionService.ts`、`runOwnership.ts`。全任务最敏感的一批。
- 验证：`pnpm lint`；`pnpm exec vitest run tests/agentQueueDrain.test.ts tests/agentPendingInputs.test.ts tests/agentExecutionService.test.ts tests/agentRuns.test.ts tests/agentRunDefects.test.ts tests/agentRuntimeOwnership.test.ts tests/agentRuntimeClaimRaces.test.ts tests/e11RetainedWork.test.ts`。重点断言：停止/失败/中断后项为 held 且零请求；多条按顺序各开一轮；编辑与删除对 claim 的竞态；锁忙静默放弃；启动只派发系统项。
- 回滚点：revert 本批；B1 的表保持不用。

## B3 注入点（next-step）

- `packages/agent-core/src/runtime.ts`：`RuntimeHost` 加可选 `admitPendingInput`；循环 `:229` 与 `:230` 之间调用；`runtime.test.ts` 加用例（顺序、abort、缺省不影响、返回的 run 用于 `prepareContext`）。
- Studio：`runChat.ts` 实现 `admitPendingInput`，`guard` 默认 scope 加新表；新增 `injectSteerInputs`；`AgentRequestMessage` 与 `AgentResponseItem` 加 `sourceQueueItemId?`；`referenceWire.ts`（两处）与 `contextMeasurement.ts` 剥离该字段。
- `isLaterUserTurn` 加入 `steeredIntoRunId` 豁免；更新 `agent-core/library/runtime.md`。
- 风险文件：`runtime.ts`（公共核心，示例宿主依赖）、`runChat.ts`、`agentTools.ts`（`appendToolResults` 旁的先例，不要改动它）、`referenceWire.ts`。
- 验证：`pnpm agent:build`；`pnpm exec vitest run -c vitest.agent-source.config.ts`；`pnpm agent:example:check`；`pnpm lint`；`pnpm exec vitest run tests/agentSteerInjection.test.ts tests/agentFinishingCheck.test.ts tests/agentTools.test.ts tests/agentRuntimeOwnership.test.ts tests/mcpAgentExecution.test.ts`。重点断言：两种协议请求体顺序；无 `sourceQueueItemId`；注入后触发压缩后缀保留；`pauseAtLimit` 优先；Responses 的 `validateEnvelope` 仍通过；插队后该 run 仍可审批和继续。
- 回滚点：revert 本批；agent-core 钩子可选，单独保留无副作用。

## B4a 等待用户动作的操作清单（盘点，不改代码）

PRD 第 9 条要求把审批、确认批量、提交、暂停、取消、采纳、重试、继续、检查结果迁入输入框附着卡片。设计草案尚未逐个盘点。本批只产出清单：对 `AgentGenerationBatches.tsx`、`AgentJobReport.tsx`、`AgentRunDetails.tsx`、`AgentDesktopMediaReport.tsx`、`GenerationReview.tsx`、`MusicGenerationReview.tsx`、`TaskWrapup.tsx`、`AgentWriteOutcomes.tsx` 逐个标出「等待用户动作」的按钮，对应的附着卡片形态（`composerAttention.ts` 现有类型能否承载），以及哪些需要新卡片类型。输出 `research/awaiting-action-inventory.md`，并据此补充 design.md §9.4 与本计划的 B4/B5/B6 范围。
- 验证：清单经 owner 过目后再进入 B4。
- 回滚点：仅文档。

## B4 UI

- `FloatingComposer.tsx`：`canSend` 去 `!sending`；去掉附件和语音的 `sending` 守卫；占位文案；`ComposerProps.queue`。
- 新建 `ui/useComposerQueue.ts`、`ui/ComposerQueue.tsx`、`ui/composerQueue.css`，挂在 `FloatingComposer` 的 `above`。
- `AgentChatPage.tsx`：`handleSend` 入队分支，入队用 `references.consume/restore` 保护草稿。
- `MessageList.tsx`：系统行渲染为 `SystemNoteLine`（新建）；排除 `TurnNavigation` 计数；插队行加「引导」标记。
- 反馈类统计排除系统行（`wrapupEvidence.ts`、`taskTools.ts`、`TaskRecords.tsx`、`agentContextPreview.ts`、`agentRuns.ts:157`）。
- 按 B4a 清单把「等待用户动作」的消息内按钮迁入附着卡片（具体范围以清单为准，可拆为 B4b）。
- 风险文件：`FloatingComposer.tsx`、`AgentChatPage.tsx`、`MessageList.tsx`、`AgentGenerationBatches.tsx`。
- 验证：`pnpm lint`；`pnpm exec vitest run tests/agentQueueUi.test.ts tests/agentMessagePresentation.test.ts tests/e11ThreadReadingUi.test.ts tests/topicSidebar.test.ts tests/e16BatchDetailHandoff.test.ts`；手动 `pnpm dev`：运行中发送、点引导、停止、刷新（需真实模型或桩）。
- 回滚点：revert 本批；B2、B3 的服务和钩子无 UI 也能工作。

## B5 批量脱离线程锁

- `threadWork.ts`：批量登记表、`reserveAgentBatchWork`、`currentAgentBatchWorks`，`shutdownAgentThreadWork` 同时处理两张表。
- `video/agent/generationBatchRuntime.ts`：批量级锁，`batchUserAction` 与 `stopGenerationBatch` 改用 `batchId`；`AgentGenerationBatches.tsx` 调用点更新。
- `audio/generation/batchRuntime.ts`：去掉线程锁与线程槽预留；`ownedAudioGenerationBatch` 的最新 run 检查仅草稿阶段。
- `agentGenerationBatches.ts`：`recoverAbandonedGenerationBatch`（单批）与按批量锁判断的线程版本。
- `runOwnership.ts`：`withThreadRunLock` 与 `recoverAbandonedRuns` 的批量恢复改按批量锁；线程集合不再因批量加入。
- `AgentChatPage` 删除线程时停止该线程的批量；更新 `agent-batch-generation.md`、`agent-execution.md`。
- 风险文件：`generationBatchRuntime.ts`、`audio/generation/batchRuntime.ts`、`runOwnership.ts`、`threadWork.ts`、`audio/commands/batches.ts`。第二敏感的一批（涉及付费派发的互斥）。
- 验证：`pnpm lint`；`pnpm exec vitest run tests/agentBatchDecoupling.test.ts tests/agentGenerationBatch.test.ts tests/agentGenerationBatchSafety.test.ts tests/agentBatchPreparationRecovery.test.ts tests/audioGenerationBatch.test.ts tests/audioGenerationAgent.test.ts tests/e11RetainedWork.test.ts tests/e16BatchDetailHandoff.test.ts`。现有测试的假锁管理器是单一 `held` 标志，需改为按锁名独立；`e11RetainedWork.test.ts` 与 `audioGenerationBatch.test.ts:336` 断言同步更新。重点断言：批量运行时聊天 `claim` 成功；聊天持锁时批量暂停/取消/编辑成功；聊天开始不把存活批量判中断；跨标签页同一批量仍被批量锁互斥；未知提交仍不重发。可选 `pnpm test:browser:agent-parallel-details`。
- 回滚点：revert 本批；不改 schema，回滚后批量恢复占用线程锁的旧行为，队列功能不受影响。

## B6 自动续跑

- `applyBatchSelections`：每个成功的实体分组事务内调用 `enqueueSystemInput`，用 `adoptionId` 聚合；`content` 与 `display` 文案由函数构造。
- `AgentGenerationBatches.tsx`：采纳返回后调用 `agentExecution.drainQueue(threadId)`。
- `beginAgentRun`：系统项创建 user 行时写入 `origin:'system'` 与 `display`。
- 启动 drain 的系统项分支联调；更新 `agent-batch-generation.md`、`agent-execution.md`。
- 风险文件：`agentGenerationBatches.ts`（`applyBatchSelections` 的事务边界与分组语义）、`agentRuns.ts`。
- 验证：`pnpm lint`；`pnpm exec vitest run tests/agentBatchAdoptionContinue.test.ts tests/agentGenerationBatch.test.ts tests/agentGenerationReviewTransactions.test.ts tests/agentQueueUi.test.ts`。重点断言：采纳前不触发；多组聚合为一条；全部失败不写项；线程忙时排队；采纳后新建 service 实例仍派发；用户项不会因此自动发送。
- 回滚点：revert 本批；系统项不再产生，队列和批量解耦不受影响。

## B7 收尾

- 同步所有受影响 spec（design.md §13）。
- 视需要新增浏览器回归脚本（参照 `tooling/agent-parallel-details-browser.mjs`），覆盖运行中入队、引导、停止后保留、刷新后保留、批量并行聊天。
- 对照 PRD 验收标准逐条核对。
- 全量验证：`pnpm test`；`pnpm lint`；`pnpm quality`；`pnpm agent:example:check`；`pnpm test:storage:native`（若具备原生环境）；`pnpm build`。
- 回滚点：仅文档和脚本，可直接 revert。

## 依赖关系

- B3 依赖 B1（认领表）与 B0（谓词）。
- B4a 可与 B1–B3 并行（只读盘点）；B4 依赖 B2、B3 与 B4a。
- B6 依赖 B2（drain）与 B5（批量与聊天可并存，否则采纳后线程可能仍被批量占着）。
- B5 与 B2–B4 在代码上基本独立，可并行，但共同修改 `runOwnership.ts` 与 `agentExecutionService.ts`，合并时留意冲突。

## 开始前需要 owner 确认

- **D3**：线程被带 tool call 的中断 run 阻塞时，「立即发送」是否自动结束上次执行（默认：是）。
- D1/D2/D4/D5/D6/D7/D8/D9/D10 已按 design.md §12 取默认；如有异议请指出。
- 草案标注的「未核实」项（design.md §0 第 10–15 条）在对应批次实现时核实，不阻塞开始。
