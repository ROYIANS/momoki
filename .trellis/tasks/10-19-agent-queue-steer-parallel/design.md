# Agent 排队插队与批量并行：设计

来源：规划 agent 读代码产出，主会话落盘。【读码确认】= 已读到代码；【未核实】= 实现时需再确认。路径相对 `packages/studio/src/features/`，除非另注。

## 0. 核实摘要

1. 【读码确认】注入点在 `packages/agent-core/src/runtime.ts` 循环顶：`:226 while(true)`、`:228 pauseAtLimit`、`:229` 额度检查、`:230 prepareContext`。新增**可选**宿主方法 `admitPendingInput?`，插在 `:229` 与 `:230` 之间。必须可选，因为 `examples/agent-todo/src/host.ts` 也实现 `RuntimeHost`。
2. 【读码确认】next-turn 不能走 `finishingCheck`：它会在同一个 run 里追加 `continuationMessages`，把多条消息并成一个 assistant 气泡，违背「一条一轮」。next-turn 在 service 层出队：invocation 结束后重新 `claim` 并 `beginAgentRun`（对应 dsh `agent.ts` 的轮次结束 `hasPending`）。
3. 【读码确认，高风险】仓库有 6 处「run 之后出现更晚 user 消息就视为过期」的判定：`commands/agentTools.ts` 的 `requireLatestRun`（约 `:56`）、`commands/agentFinishingCheck.ts:62`、`commands/agentProjectCreation.ts:24`、`runtime/activityAttention.ts:86`、`music/agent/musicGenerationReview.ts:39`、`audio/commands/batches.ts:36`。插队产生的 user 行会让这 6 处全部失效（包括该 run 之后无法审批或继续）。必须先抽统一谓词并让插队行豁免。
4. 【读码确认】新增表要改：`platform/storage/browserDatabase.ts`（`version(28)`）、`schema.ts`、`schema.json`、`tableTypes.ts`，`tests/storageRegistryHash.test.ts` 无需更新（B1 实测：仓库无 `PINNED_REGISTRY_HASH`，该测试比较 schema.json 与历史快照）。Rust 通过 `include_str!` 直接读 `schema.json`，无硬编码表数。还要改 `commands/lifecycle.ts` 的 `deleteChatThread` 与 `projects/commands/lifecycle.ts` 的 `deleteProject` 级联。备选是 `deviceSettings` 按线程存一个 key；PRD 写明新表，默认新表（D1）。
5. 【读码确认】图片/视频批量的 `ownedGenerationBatch` 不检查 run 状态，可直接脱离线程锁。音频批量的 `ownedAudioGenerationBatch(mutate)` 要求源 run 是线程最新且未 cancelled，批量运行中用户一发新消息每次派发都会失败，必须放宽。`withThreadRunLock` 里的 `recoverAbandonedGenerationBatches(threadId)` 会把别处存活的批量误判为中断，必须改成按批量锁 `ifAvailable` 判断。
6. 【读码确认】`settleRun`（`commands/agentRunTerminalState.ts`）是唯一终态写入点。「停止/失败/中断后队列转 held」必须写在它里面才能与终态原子。需给 5 个调用点的事务 scope 加新表：`finishAgentRun`、`runChat` 的 `settle`、`cancelAgentRun`、`pauseAtModelStepLimit`、`interruptThreadRuns`。`interruptThreadRuns` 因此自动覆盖「重启后原 run 被判中断」。
7. 【读码确认】`sourceToolCallId` 在 `providers/referenceWire.ts:64`、`:87` 和 `runtime/contextMeasurement.ts:50` 三处被剥离，不发给 provider。新增的 `sourceQueueItemId` 必须同样剥离。
8. 【读码确认】`ComposerCards` 一次只显示一张卡，队列要做独立组件。`MessageList.tsx:154` 对 `role==='system'` 直接 `return null`。系统提示行用 `role:'user'` 加 `origin:'system'`，不用 `role:'system'`：`selectContextHistory` 会把 system 行原样发给模型，且 `canRetryRun` 和轮次分组都依赖 user 行。
9. 【读码确认】`appendToolResults` 已有「在全部 tool 结果之后追加 `{role:'user', sourceToolCallId}` 并同步 `responseItems`」的先例（`agentTools.ts:285-300`），插队消息沿用这个形态。`refreshRunMemoryContext` 和 `replaceContinuationBase` 都原样保留 base 之后的后缀，压缩和记忆刷新不会丢插队消息。
10. 【未核实】`ChatMessage` 新增 `origin`/`steeredIntoRunId`/`display` 字段是否被 native `rowCodec`/`validate` 拒绝（只确认 schema 只约束 key 和 index）。
11. 【未核实】新表 scope 取 `mixed` 的语义（参照 `agentRuns`/`chatMessages`）。
12. 【未核实】`runtime/chatTurns.ts` 和 `groupContextHistory` 遇到「没有 assistant 回复的插队 user 行」时的行为。
13. 【未核实】新增文件是否要登记 `quality/studio-ownership.json`；以 `pnpm quality` 实际报错为准。
14. 【未核实】`ui/icons` 中 Zap、MoreHorizontal、Trash 等图标是否存在。
15. 【未核实】`pnpm test:storage:native` 与 Rust 测试是否需要本机 cargo 环境；本阶段未运行任何命令。

## 1. 目标、范围与已定决策

见 `prd.md`。设计必须遵守：默认排队、卡片「引导/删除/更多」、停止/失败/中断后保留不自动发送、队列落库、逐条送出、自动续跑只在采纳之后且带淡色系统提示、同线程仍只有一个 agent run、多线程并行不变、「等待用户动作」的操作进入输入框附着卡片。

不做：右侧栏迁移、E11 Rust Host、音频采纳触发续跑（D8）。

## 2. 现状要点（读码确认）

- 四层拦截：`FloatingComposer.tsx:149` `canSend`；`AgentChatPage.tsx:178` `sendLocked`；`agentExecutionService.ts` 的 `claim()`（已有 invocation 即抛错）；`agentRuns.ts:103-104` `runBlocksThread`。批量另走 `threadWork.ts:31-38` 内存预留加 `runOwnership.ts` 线程 Web Lock。
- `executeRun`（`runtime.ts`）：`executePendingTools` 返回 true（`appendResults` 之后）才回到 `:226`。`:246` 是 `finishingCheck`，`:264` 是 tool 轮之后的 `executePendingTools`。
- `beginAgentRun`（`agentRuns.ts:64-246`）一次事务创建 user 行、assistant 行（`createdAt` 为 `at+1ms`）和 run。`at = max(now, history 最大 createdAt+1)`。
- 压缩和记忆刷新：`refreshRunMemoryContext` 用 `[...baseMessages, ...messages.slice(oldBase.length)]` 保留后缀；`replaceContinuationBase` 先校验旧 base 前缀，再追加完整不透明后缀。
- 终态写入：所有终态走 `settleRun`。

## 3. 数据模型

### 3.1 新表 `agentPendingInputs`（Dexie v28，表序号 54）

行类型：`agent/models/agentPendingInput.ts`。

| 字段 | 说明 |
| --- | --- |
| `id` | 主键，`createId("pin")` |
| `threadId` | 所属线程 |
| `projectId?` | 线程所属项目，用于 `deleteProject` 级联和派发校验 |
| `position` | 线程内序号。入队事务内取 `max+1`（IndexedDB rw 事务串行，跨标签页安全）；上移下移改写 position |
| `source` | `user` 或 `system` |
| `mode` | `next-turn` 或 `next-step`；「引导」即 next-turn→next-step |
| `status` | `queued` 或 `held`（停止/失败/中断后保留，永不自动发送） |
| `heldReason?` | `stopped`、`failed`、`interrupted`、`dispatch_failed`、`uncertain` |
| `content` | 给 agent 的文本。系统项带「[系统事件 · 用户已采纳批量结果，非用户输入]」前缀 |
| `display?` | 系统项在对话里显示的淡色短句，如「已采纳 3 张图，继续」；省略则显示 `content` |
| `attachments?` | `ReferenceAttachment[]`，只存引用不存字节 |
| `runId`、`userMessageId`、`assistantMessageId` | 入队时预分配的准入身份（幂等身份），沿用 `ChatAdmissionIdentity` 形态打平存储 |
| `submit?` | 用户项入队时冻结 `{connector:{id,definitionId,baseUrl}, model, reasoningEffort?, interactionMode, taskMode, modelMetadata?}`。系统项不存，派发时取线程最近使用的 connector/model/reasoning（D7） |
| `system?` | 系统项来源 `{kind:'batch-adopted', batchId, adoptionId, applied:[{targetKey,label,kind,jobId}]}` |
| `dedupeKey?` | 系统项幂等键，如 `adopt:${adoptionId}` |
| `revision` | 从 1 起，编辑/改模式/改状态加 1，用于 CAS |
| `lastError?` | 派发失败原因 |
| `createdAt`、`updatedAt` | ISO 时间 |

索引：`"id, threadId, projectId, status, &dedupeKey, updatedAt"`（`&dedupeKey` 稀疏唯一，先例 `agentJobs` 的 `&callId`）。scope 取 `mixed`（语义未核实）。

容量：每线程最多 20 条；系统项超限时按 `dedupeKey` 合并，不新增。正文长度沿用现有发送上限（实现时读 `normalizeSubmittedChatContent` 与 UI 限制）。

### 3.2 迁移

```ts
this.version(28).stores({agentPendingInputs: "id, threadId, projectId, status, &dedupeKey, updatedAt"});
```

纯增表，无 `.upgrade()`，与 v27（`desktopMediaImports`）同形。同步改：`schema.ts` 与 `schema.json`（逐字段一致，有一致性测试）、`tableTypes.ts`（`ProductRows`）、`browserDatabase.ts` 类声明、`tests/storageRegistryHash.test.ts` 实际比较当前 `schema.json` 与历史发版快照；仓库中不存在 `PINNED_REGISTRY_HASH`（B1 实测更正），纯新增表无需更新任何哈希、`.trellis/spec/frontend/shared-product-storage.md`（53 表/v27 → 54/v28）。原生端纯增表由 `registry_migrations.rs` 与 `apps/desktop/scripts/storage-compatibility.mjs` 自动推导；是否需 `registry-history` 快照只在发版时决定（未核实）。

回退：Dexie 版本升高后旧代码再开同一库会报 `VersionError`。B1 发版前可整体撤销；发版后不可降级，表保持为无害空表。

### 3.3 级联与清理

- `deleteChatThread`（`commands/lifecycle.ts:18`）：scope 加表，`where('threadId').equals(id).delete()`。
- `deleteProject`（`projects/commands/lifecycle.ts`）：按 `projectId` 删系统项；用户项保留，派发时因「关联项目已不存在」失败转 held。
- `recoverAbandonedRuns`：不删队列。

### 3.4 与 `chatMessages` 的关系

队列行不是消息，不参与 `selectContextHistory`，不进 `MessageList`。只有「真正送达」才产生 user 行：

- next-turn：`beginAgentRun` 同一事务创建 user 行并删队列行（`userMessageId` 预分配）。`createdAt` 沿用 `at`。
- next-step（插队）：注入事务里创建 user 行并删队列行。`createdAt = max(Date.now(), 线程所有消息最大 createdAt + 1)`，一定排在该 run 的 assistant 行（`at+1`）之后。

`ChatMessage`（`models/chat.ts`）新增可选字段：`origin?: "system"`、`steeredIntoRunId?: Id`、`display?: string`（仅系统行）。

系统行不用 `role:"system"` 的原因：`selectContextHistory`（`contextPlanner.ts:10-23`）会原样发 `role` 给模型；`canRetryRun`、`TurnNavigation`、`groupContextHistory` 都依赖 user 行；`MessageList.tsx:154` 对 `role==='system'` 直接不渲染。

排序取舍（D5）：插队行 `createdAt` 晚于 assistant 行，渲染在该 run 的 assistant 气泡之后，而该气泡之后还可能继续流式输出。历史顺序为「Q、助手完整回复、你的插队」，与时间一致，v1 接受。后续 run 的 `at` 因 history 含插队行自动更大。

### 3.5 统一「过期」谓词

`models/chatTurns.ts`（新建）：

```ts
isLaterUserTurn(message, run) =
  message.role === "user" && message.createdAt > run.createdAt && message.steeredIntoRunId !== run.id
```

替换摘要第 3 条的 6 处内联判断。`canRetryRun`（`agentRuns.ts:60`）取最后一个 user 行，系统行是 user 行，不用改。

用户反馈类统计要排除系统行（`origin==='system'`）：`runtime/wrapupEvidence.ts:40`、`:252`；`runtime/taskTools.ts:116`；`ui/TaskRecords.tsx:98`；`agentContextPreview.ts:98` 与 `agentRuns.ts:157` 的 `recentUserTurns`（记忆检索）；`MessageList.tsx:79` 的 `userMessages`（`TurnNavigation` 计数）。

## 4. 队列状态机与出队

### 4.1 命令层

新建 `commands/agentPendingInputs.ts`，函数接受可选 `ProductStore | StoreTx`，复用调用方事务。

- `enqueueUserInput(threadId, input, store)`：一个事务内校验线程和项目归属、容量，分配 `position`，写入。
- `enqueueSystemInput(tx, input)`：给采纳事务用，按 `dedupeKey` 幂等 upsert。
- `editPendingInput(id, expectedRevision, patch)`：只改 `content`，只限用户项，CAS。
- `setPendingMode(id, expectedRevision, mode)`：「引导」。
- `movePendingInput`：上移/下移，重排 `position`。
- `removePendingInput(id, expectedRevision?)`。
- `holdPendingInputs(tx, threadId, reason)`：该线程所有 `queued` 置 `held`。
- `claimNextDispatchable(...)`：见 §5。

编辑/删除遇到行已不存在，一律报「该消息已送出或被删除」；竞态由事务串行决定胜负。

### 4.2 状态转移

| 当前 | 事件 | 结果 | 谁写 |
| --- | --- | --- | --- |
| 不存在 | 运行中发送，或线程被 run 阻塞时发送 | `queued`，mode=next-turn | `enqueueUserInput` |
| `queued` | 点「引导」 | mode=next-step | `setPendingMode` |
| `queued`+next-step | 注入点认领 | 事务内：追加 user 消息、写 `chatMessages` 行、删队列行 | `admitPendingInput` |
| `queued` | run 正常 completed，线程空闲 | 派发为新一轮（next-step 也按 next-turn 对待）；`beginAgentRun` 事务内删行 | service drain |
| `queued` | run 被停止、失败、中断 | `held` | `settleRun` 内 `holdPendingInputs` |
| `held` | 用户「立即发送」 | 派发，行为同上 | service |
| `held`/`queued` | 编辑 | 保持状态，`revision+1` | 命令 |
| 任意 | 删除 | 行被删除 | 命令 |
| `queued` | 派发失败（连接缺失、项目已删、未确认提交） | `held`，写 `lastError`，防无限重试 | service |

### 4.3 hold 写进 `settleRun`

- 条件：run 原状态是 `running` 或 `waiting_approval`，新状态是 `cancelled`、`failed` 或 `interrupted`。
- 动作：同一事务内 `holdPendingInputs(tx, run.threadId, reason)`。
- 不触发：用户对已经 `interrupted/failed` 的 run 点「结束」（`allowedFrom` 含这两个状态）；那时队列早已 held，之后新入队的 queued 项不应被牵连。
- `pauseAtModelStepLimit` 经 `settleRun(interrupted)` 自动覆盖：额度暂停也需明确继续，同样 hold。

原子性理由：hold 若在 settle 事务之外，崩溃发生在两者之间会留下 `queued` 项，随后系统项的启动 drain 或空闲 drain 会把它自动发出，违背「停止后不自动发送」。

需加入事务 scope 的 5 个调用点（漏加会触发存储层 scope 报错）：`agentRuns.ts` 的 `finishAgentRun`（`:268`）；`runChat.ts` 的 `settle`（`:127`）；`agentTools.ts` 的 `cancelAgentRun`；`agentTools.ts` 的 `pauseAtModelStepLimit`；`agentRuns.ts` 的 `interruptThreadRuns`（`:276` scope 列表）。

### 4.4 重启与恢复

`recoverAbandonedRuns` 把仍是 `running` 的 run 经 `interruptThreadRuns → finishAgentRun(interrupted) → settleRun` 终结，hold 自动随之发生，无需另写识别队列的代码。`waiting_approval` 的 run 不是终态，队列保持 `queued`，批准并跑完后再出队；`interruptThreadRuns` 里「awaiting_approval 恢复为 waiting_approval」的分支不 hold。被中断且带 tool call 的 run 使 `runBlocksThread` 仍为真，线程保持阻塞，「立即发送」处理见 §5.4。

## 5. 出队（next-turn）

### 5.1 为什么不用 `finishingCheck`

`finishingCheck` 在 `:246` 返回 true 时 `continue`，是同一 run 的第二次模型请求。用它承接 next-turn 会：把多条消息并入同一 assistant 行；不创建新的 user 行、assistant 行和 run，破坏 `userMessageId` 配对和 run 上下文冻结；让记忆和引用选择（`beginAgentRun` 每次 begin 决定）失效。所以 next-turn 出队放在 `agentExecutionService`，每条独立 `claim` 并 `beginAgentRun`。

### 5.2 触发时机与条件

`claim()` 的 `finally`（invocation 已清除、线程工作槽释放、锁已释放之后）调用 `scheduleDrain(threadId)`。条件全部满足才出队：

- `admissionOpen` 且本 invocation 没被 `stopping`。
- invocation 的 `done` 是 resolve 而非 reject，且 `owner.error` 为空。
- invocation 种类是 submit、retry、decision，或新增的 `queue`。
- DB 里该线程没有 `runBlocksThread` 的 run，也没有本地 invocation。
- 存在 `status==='queued'` 的最小 `position` 项；忽略 `held` 项但不动它们。

另两个入口也调用同一 drain：采纳事务提交后由调用方显式触发（§8）；`initialize()` 在 `recoverAbandonedRuns` 之后触发，但**只处理 `source==='system'`**（D4）——用户队列重启后保持可见，由用户点「立即发送」（符合「恢复不自动发付费请求」原则）；系统项属用户已确认的采纳，要求刷新后仍继续。

### 5.3 派发路径与幂等

`claim(threadId, "queue", op)` 不带 `submitted` attempt。`op` 内：

1. 先 `readAgentAdmission(准入身份)`：已 accepted 则只清理残留队列行，绝不再 begin 或 dispatch（沿用「肯定回执不是派发许可」原则）。
2. absent 则调用 `executeNewChatMessage`，其内部 `beginAgentRun` 新增选项 `pendingInput:{id, revision}`：事务内读队列行，校验线程、`userMessageId`、`revision` 一致后删除；行已不存在就抛错中止 begin。保证跨标签页和重复调用下恰好一次。
3. 派发失败转 `held` 并写 `lastError`。

用户项冻结的 connector/model 在派发时用 `resolveConnector` 校验身份（沿用 `send()` 已有校验）。系统项没有冻结身份，用线程最近一次的 `connectorId/model/reasoningSelection`（D7）。

跨标签页：drain 只在持有线程 Web Lock 的 tab 里进行；其他 tab 只看到 DB 里的卡片。锁被占用时 drain 静默放弃，因此把 `runOwnership.ts` 里「此对话正在另一个页面执行」的抛错改为导出的 `ThreadLockBusyError` 类型，drain 据此区分，不当作失败。

### 5.4 「立即发送」与线程仍被阻塞

- 线程空闲：直接走 §5.3，不看 mode。
- 被 `waiting_approval` 的 run 阻塞：卡片保持 `queued`，提示「等待审批」，批准并完成后再出队。
- 被带 tool call 的 `interrupted/failed` run 阻塞：`beginAgentRun` 会抛「此对话已有执行」。**默认（D3，待 owner 确认）**：按钮变为「结束上次执行并发送」，在同一个 `claim` 内先 `cancelAgentRun`（保留已完成步骤）再派发。若 owner 不同意，退化为只展示原错误并保留卡片。
- 用户在空闲时直接发送新消息：直接 `submit`，不进队列，不影响已有 `held` 项。

### 5.5 运行中发送的判定

`AgentChatPage.handleSend` 新分支：`sendLocked() || control.runs.some(runBlocksThread)` 为真则入队，否则 `submit`。这样另一标签页占用线程时本页也入队，而不是抛锁错误后恢复草稿。

## 6. 注入点（next-step）

### 6.1 agent-core 新方法

`RuntimeHost` 加可选方法 `admitPendingInput?: (run: Run, signal: AbortSignal) => Promise<Run>;`，在 `executeRun` 循环里：

```ts
if (modelStepLimitReached(run)) throw new Error('...');                       // 现有 :229
run = await host.admitPendingInput?.(run, controller.signal) ?? run;          // 新增
run = await host.prepareContext(run, controller.signal);                      // 现有 :230
```

放在 `prepareContext` 之前，使上下文预算和压缩把新消息算进去。契约写进 `.trellis/spec/agent-core/library/runtime.md`：钩子只在循环顶被调用（前一轮全部 tool 结果已由 `appendResults` 保存之后，或本次运行首次请求之前）；宿主应在自己的一个事务内追加输入并返回重读后的 run。不能做必需方法：`examples/agent-todo/src/host.ts` 是第二个宿主，`pnpm agent:example:check` 会验证。

### 6.2 Studio 宿主实现

`runChat.ts` 宿主对象加 `admitPendingInput: run => guard(run, tx => injectSteerInputs(run.id, tx), scopeWithPendingInputs)`；`guard` 默认 scope 列表（`:54`）加 `db.agentPendingInputs`。

`injectSteerInputs`（`commands/agentPendingInputs.ts` 或 `commands/agentSteer.ts`）在一个事务内：

1. 读 run，要求 `status==='running'`。
2. 读该线程 `queued` 且 `mode==='next-step'`、`source==='user'`、无附件的项（D2），按 `position` 排序。
3. 逐条构造 `{role:'user', content, sourceQueueItemId:item.id}`，追加到 `continuationMessages`（缺省取 `requestMessages`）。
4. Responses 协议：同时把 `toResponseInput([message])` 追加到 `responseItems`（缺省取 `toResponseInput(messages)`，与 `saveAgentFinishingCheck` 同写法）。
5. 幂等：`messages.some(m => m.sourceQueueItemId === item.id)` 已存在则只删队列行。
6. 写 `chatMessages` user 行：`id=userMessageId`，`status:'complete'`，`steeredIntoRunId=run.id`，`createdAt` 单调递增。
7. 删队列行，更新 `run.updatedAt`，返回重读的 run。

类型：`AgentRequestMessage` 与 `AgentResponseItem`（`models/agent.ts:29`、`:85`）加可选 `sourceQueueItemId?: string`。在 `providers/referenceWire.ts:64`、`:87` 与 `runtime/contextMeasurement.ts:50` 的解构里同样剥离，否则发给 provider 的 JSON 会多出未知字段。

### 6.3 两种协议如何追加

| 协议 | 位置 | 形态 |
| --- | --- | --- |
| chat-completions | `continuationMessages` 末尾，全部 `role:'tool'` 之后 | `{role:'user', content}` |
| Responses | `responseItems` 末尾，全部 `function_call_output` 之后 | `toResponseInput` 转出的 `message` 项 |

两条路径复制了 `appendToolResults`「引用输入 user 消息」的既有位置，provider 端已验证可接受。

### 6.4 绝对不能插入的位置

- assistant `tool_calls` 与任何一条对应 tool 结果之间。
- `commitRound`（`saveToolRound`）之后、`appendResults` 之前（该窗口崩溃恢复时 `executePendingTools` 会先补齐结果再追加；钩子位于其后，天然安全）。
- `run.status` 非 `running`（`waiting_approval` 停车期间、`interrupted` 之后）。
- 工具状态为 `running` 或 `unknown` 时。
- 冻结的 base 前缀（`context.baseMessages` 与 `requestMessages`），压缩的前缀校验和记忆刷新都依赖它。
- 已持久化的 assistant 末轮之前。

Responses 的 `validateEnvelope`（`runChat.ts`）用 `responseRoundMatches` 只统计 `function_call` 项，不受多出的 `message` 项影响；`claimFingerprint` 只涉及 call 本身，也不受影响。

### 6.5 与压缩、记忆、finishingCheck 的交互

- 压缩：注入在 `prepareContext` 之前，新消息位于 base 之后的不透明后缀，`replaceContinuationBase` 原样保留；预算含它；「保护 live tool chain」不受影响。
- 记忆和引用：只在 `beginAgentRun` 选择一次，插队不重新选择（接受的取舍）；next-turn 是新的 begin，会重新选择。
- `finishingCheck`：原本在「后面还有更晚 user 消息」时跳过（`agentFinishingCheck.ts:62`），谓词替换为 `isLaterUserTurn` 后插队行不影响。
- 模型给出无 tool call 的最终答复时仍有未送达的 `next-step` 项：v1 不在同一 run 续写，剩余项在 run 结束后按 next-turn 出队（D9）。
- 额度暂停：`pauseAtLimit` 返回 true 时 `executeRun` 在注入之前就返回，待处理项保持原样并因 `interrupted` 转 held。

## 7. 批量脱离线程锁

### 7.1 目标不变量

同一线程同一时刻仍只允许一个 agent run；批量不再占用「线程执行槽」。批量自己用批量级 Web Lock，参照音频「项目拥有」批量的 `cuepoint.audio-batch.${id}`。

### 7.2 现状耦合点（读码确认）

| 位置 | 现状 | 问题 |
| --- | --- | --- |
| `video/agent/generationBatchRuntime.ts:52` | `reserveAgentThreadWork(videoBatch)` 占线程槽 | 聊天 `claim()` 被挡 |
| `generationBatchRuntime.ts:65` | `withThreadRunLock(threadId, …)` 全程占线程锁 | 聊天获取锁失败，且获取锁会 `interruptThreadRuns` |
| `generationBatchRuntime.ts:29-43` | `batchUserAction` 暂停/取消/编辑也走线程锁 | 聊天持锁时失败 |
| `audio/generation/batchRuntime.ts:34-38` | agent 拥有的批量 `withThreadRunLock(...)` 套 `lockBatch` | 同上 |
| `audio/generation/batchRuntime.ts:66,83` | `reserveAgentThreadWork(audioBatch)` | 同上 |
| `runtime/runOwnership.ts:70` | `withThreadRunLock` 内 `recoverAbandonedGenerationBatches(threadId)` | 把别处存活的 running 批量误判为 abandoned |
| `runOwnership.ts:76-97` | `recoverAbandonedRuns` 把 running 批量的线程也拉进线程锁恢复 | 同上 |
| `audio/commands/batches.ts:35-37` | `ownedAudioGenerationBatch(mutate)` 要求源 run 是最新且未 cancelled | 用户新开一轮后每次派发都失败 |

图片/视频的 `ownedGenerationBatch`（`agentGenerationBatches.ts`）只校验 run 存在、线程、项目和 call 的归属，不看 run 状态，无需改。`claimBatchItem` 的互斥来自事务内 item/job 状态，不依赖线程锁。

### 7.3 方案

1. **批量锁**：新增 `withGenerationBatchLock(batchId, execute, locks)`，锁名 `cuepoint.generation-batch.${batchId}`，`ifAvailable:true`，被占用则抛「此批次正在另一个页面执行」。不做 `interruptThreadRuns`，不做 `recoverAgentJobs`。放 `generationBatchRuntime.ts`；音频继续用现有锁名。
2. **批量工作登记**：`threadWork.ts` 增加第二个登记表，键为 `batchId`；新增 `reserveAgentBatchWork(store, identity, controller)`，只拒绝同一 `batchId` 重复。`currentAgentThreadWork` 不再返回批量工作；新增 `currentAgentBatchWorks(store, threadId)`；`shutdownAgentThreadWork` 同时中止并等待两张表。聊天线程的 `snapshot.active` 因此不再被批量置真，输入框不锁。
3. **`generationBatchRuntime.ts`**：`workers` 仍保留「每线程一个运行中批量」（D10），锁改为批量级。`batchUserAction(batchId, action, locks?)` 与 `stopGenerationBatch` 签名改用批量 ID（`AgentGenerationBatches.tsx` 调用点：`:351`、`:359`、`:581`、`:602`、`:611`、`:620`、`:627`、`:630`、`:635`、`:662`）。持锁 worker 的 `ownsLock/actions` 机制不变。
4. **恢复**：新增 `recoverAbandonedGenerationBatch(batchId, store)`（单批，逻辑照搬现有函数体）；`recoverAbandonedGenerationBatches(threadId, locks, store)` 改为遍历线程内 `running` 批量，对每个 `locks.request(batchLockName, {ifAvailable:true})`，拿到锁才恢复，拿不到视为存活跳过。`withThreadRunLock` 与 `recoverAbandonedRuns` 仍调用此版本；`recoverAbandonedRuns` 的线程集合不再因「有 running 批量」而加入线程，批量恢复单独循环。
5. **音频**：`ownership()`（`:34-38`）去掉 `withThreadRunLock`，agent 与项目拥有都只用 `cuepoint.audio-batch.${id}`；`startAudioGenerationBatch` 里 `reserveAgentThreadWork(audioBatch)` 换成 `reserveAgentBatchWork`；`ownedAudioGenerationBatch(mutate)` 的「最新 run、未 cancelled」检查只在批量仍是草稿（`!batch.confirmedAt`）时生效，已确认后只校验归属（run、线程、call、项目、任务）——已确认的批量是用户明确授权的付费请求，不应随聊天新增消息而失效。
6. **线程删除**：`AgentChatPage` 删除流程除停止 token 和 `work` 外，对 `currentAgentBatchWorks(threadId)` 逐个 abort 并等待。
7. **「停止」语义**：线程级停止只停聊天 run；批量暂停/取消在批量面板自己的按钮（本任务内这些按钮进入输入框附着卡片，见 §9.4）。

### 7.4 并存时会破的不变量与最小改法

| 不变量 | 破的原因 | 最小改法 |
| --- | --- | --- |
| `reserveAgentThreadWork` 同线程只一项 | 批量占了线程槽 | 批量改用批量登记表 |
| `withThreadRunLock` 获取锁时 `interruptThreadRuns` | 新 run 获取锁会中断同线程别的 running run；批量不在其中 | 无需改：批量不再持线程锁，也不触发该副作用 |
| `recoverAbandonedGenerationBatches(threadId)` | 聊天开始时把存活批量判为中断 | 按批量锁 `ifAvailable` 判断（§7.3.4） |
| `runBlocksThread` | 只看 run 状态，不看批量 | 无需改 |
| 音频 `ownedAudioGenerationBatch(mutate)` 最新 run 检查 | 新聊天使其失效 | 确认后放宽（§7.3.5） |
| 批量写业务实体与聊天 run 工具写同一实体 | 原来靠线程锁串行 | `applyBatchSelections` 已用 `entityRevisions` 做 CAS（未核实其他路径是否都带 revision 校验，测试覆盖） |
| `claimBatchItem` 的 fingerprint 去重 | 聊天里重复提交相同单张生成会被挡 | 期望行为，保留 |

## 8. 自动续跑

### 8.1 采纳入口

用户的「采纳」是 `applyBatchSelections(id, threadId)`（`agentGenerationBatches.ts:382`），UI 入口是 `AgentGenerationBatches.tsx` 的「写入选中的 N 个目标」按钮（约 `:635`）。该函数按实体分组，每组一个事务；一组失败不影响其他组，返回逐目标 `{targetKey, applied, error?}`。

### 8.2 采纳事务内写系统队列项

- 函数开头生成 `adoptionId = createId('adopt')`。
- 每个成功的实体分组事务里调用 `enqueueSystemInput(tx, ...)`：按 `dedupeKey = adopt:${adoptionId}` 找行；不存在则创建；存在则把本组 `applied` 合并进去并重新生成 `content` 与 `display`；若该行在两组之间已被消费，则用 `adopt:${adoptionId}:n` 新建一行。全部分组失败则不写项。
- 写入与该组的槽位写入同事务提交，满足「采纳后立刻刷新，agent 仍会继续」。

`content` 示例：`[系统事件 · 用户已采纳批量结果，非用户输入] 批次「…」已写入 3 个目标：镜头 A 首帧(图)、…。请继续后续步骤。` `display` 示例：`已采纳 3 张图，继续`，图或视频由 `job.kind` 区分。

### 8.3 触发

`applyBatchSelections` 返回后，UI 调用 `agentExecution.drainQueue(threadId)`：线程空闲则立即派发；线程忙则按队列规则排队，run 正常结束后出队，若这轮被停止则 held（与 §4 一致）；页面在采纳后立即刷新则由启动 `initialize()` 的系统项 drain 接管（§5.2）。

### 8.4 呈现

- `MessageList.tsx`：在 `entries.map` 里，对 `message.role==='user' && message.origin==='system'` 渲染 `<SystemNoteLine>`，不渲染用户气泡。key 仍是 `message.id`，与 `submissionTranscript` 去重兼容。
- 淡色单行（新建 `ui/SystemNoteLine.tsx`），文本取系统项的 `display`；`beginAgentRun` 创建 user 行时写入 `ChatMessage.display`。
- 该 run 的 assistant 回复正常渲染在其后。`TurnNavigation` 的用户消息计数排除系统行。

### 8.5 音频

音频的「采纳」走 arrangement 选用，不是 `applyBatchSelections`，v1 不接（D8）。`enqueueSystemInput` 与项目类型无关，后续音频采纳点可直接调用。

## 9. UI

### 9.1 输入框

`FloatingComposer.tsx`：`:149` `canSend` 去掉 `!sending`；`:171`、`:180`（`filesSelected`/`openReferenceAction`）与 `:421`（语音按钮）里的 `sending` 守卫去掉；`trySend`（`:289-297`）不变，由 `onSend` 决定入队或提交；`SendCircleButton`（`ModelSelectTrigger.tsx:336`）不改，`sending` 为真时仍是停止按钮，回车入队是唯一发送途径；运行中占位文案改为「回车排队，本轮结束后发送」；`:425` 附近「`detail && !sending`」发送快捷键下拉在运行中保持隐藏；`ComposerProps`（`composerTypes.ts`）新增 `queue?: {threadId: string}`。

### 9.2 队列组件

不能复用 `ComposerCards`（一次一张卡）。新建 `ui/useComposerQueue.ts`（`useProductQuery` 读 `agentPendingInputs where threadId` 按 `position` 排序，同时读本地 `snapshot.active` 与 `runs` 判断展示模式）、`ui/ComposerQueue.tsx`（渲染在 `FloatingComposer.tsx:286` 的 `above` 里，位于 `agent-composer-sheets` 与 `ComposerCardHost` 之间）、`ui/composerQueue.css`。

| 模式 | 触发 | 表现 |
| --- | --- | --- |
| 排队中 | 本地 run 活跃 | 卡片按钮：引导、删除、更多（编辑、上移、下移）。已转引导的卡片显示「将在下一个 tool call 之后送达」 |
| 已暂停 | 有 `held` 项且线程空闲 | 顶部一行「已停止，未自动发送」；每张卡片：立即发送（主按钮）、编辑、删除 |
| 等待审批 / 上次执行未结束 | 线程被阻塞但无活跃 invocation | 提示原因；按 §5.4 显示「结束上次执行并发送」或仅排队 |
| 系统项 | `source==='system'` | 淡色，只有「立即发送」和「取消继续」，不可编辑 |

「引导」提示文案：「提交，但不中断模型运行」。带附件的卡片引导按钮置灰并提示「带资料的消息只能排队」（D2）。「编辑」：卡片原位变文本框，保存时 CAS（`expectedRevision`），行已不存在则提示「该消息已送出」。

### 9.3 页面

`AgentChatPage.tsx`：`sendLocked`（`:178`）保留，仅用于非入队场景（如重试）；`handleSend`（`:358-359` 附近）先 `references.capture()`，再按 §5.5 决定入队或提交；入队路径 `references.consume(submitted)` → `await agentExecution.enqueue(...)`，失败时 `references.restore(submitted, recovery)`，与现有提交路径的草稿保护一致；入队用 `createSubmissionAttempt` 分配准入身份但不注册 attempt（不进 `submissionAttempts`），避免乐观气泡。`agentExecution` 新增 `enqueue`、`editPending`、`removePending`、`setPendingMode`、`movePending`、`dispatchPending(id)`、`drainQueue(threadId)`。

### 9.4 消息内操作按钮迁移（PRD 第 9 条）

范围：审批、确认批量、提交、暂停、取消、采纳、重试、继续、检查结果。这些操作现位于 `AgentGenerationBatches.tsx`（约 43 处点击入口）、`AgentJobReport.tsx`、`AgentRunDetails.tsx`、`AgentDesktopMediaReport.tsx`、`GenerationReview.tsx`、`MusicGenerationReview.tsx`、`TaskWrapup.tsx` 等。迁入输入框上方附着卡片，沿用 `composerAttention.ts` / `AgentComposerAttention.tsx` 的卡片机制。本草案**尚未逐个盘点**这些按钮和对应卡片形态，B4/B5 之前需补一份「等待用户动作操作清单」（见 implement.md B4a）。

## 10. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 协议信封被破坏 | 只在循环顶注入；chat-completions 与 Responses 各一条请求体顺序断言；`validateEnvelope` 与 `claimFingerprint` 不受影响，测试验证 |
| 新字段被发给 provider | 三处剥离（§6.2），加请求体断言：不得出现 `sourceQueueItemId` |
| 「最新用户消息」谓词漏改 | 统一 `isLaterUserTurn`，B0 单独提交，grep 校验 `role === "user" && .*createdAt >` 不再出现 |
| 幂等 | 准入身份预分配；`beginAgentRun` 的 `pendingInput` 事务内校验并删行；注入有 `sourceQueueItemId` 标记 |
| 跨标签页 | 线程 Web Lock 仍是执行唯一写者保证；drain 遇锁忙静默放弃；编辑和删除与 claim 靠事务串行；入队不需要锁 |
| 重载恢复 | hold 与终态同事务；启动只自动派发系统项；用户项保持可见 |
| 无限重试 | 派发失败转 `held` 并记录 `lastError` |
| 批量与聊天并存引发恢复误判 | 批量锁 `ifAvailable`；测试用「每个锁名独立」的假锁管理器（现有 `lockManager` 是单一 `held` 标志，要改） |
| 压缩 | 注入在 `prepareContext` 之前；测试覆盖「注入后触发压缩，后缀保留」 |
| 终态写入扩散 | hold 逻辑写在 `settleRun` 一处；5 个 scope 漏改会被存储层 scope 错误立刻暴露 |
| 模型步数额度 | 注入不消耗额度；`pauseAtLimit` 优先于注入 |
| 数据库升级不可降级 | B1 先于其他批次，发版前可整体回退 |

## 11. 测试矩阵

命名沿用 `tests/` 驼峰文件名。agent-core 单元测试放 `packages/agent-core/src/runtime.test.ts`（`vitest.agent-source.config.ts`）。新建 Studio 测试登记到 `vitest.studio-source.config.ts` 或 `vitest.agent-background-source.config.ts` 的 include（runtime 规范要求注册新套件）。

| 验收标准 | 层级 | 位置 |
| --- | --- | --- |
| 运行中发送变卡片、不打断，卡片有引导/删除/更多 | 服务+UI | `tests/agentQueueDrain.test.ts`；`tests/agentQueueUi.test.ts`（jsdom，参照 `agentJobsUi.test.ts`、`helpers/mountedHookHost.ts`） |
| 引导：下一次 tool call 之后、下一次请求之前；不在 tool_calls 与 tool results 之间；两种协议 | agent-core + Studio 集成 | `packages/agent-core/src/runtime.test.ts`；`tests/agentSteerInjection.test.ts`（fetch 桩抓第二次请求体，断言顺序为 assistant tool_calls、tool 结果、插队 user，且无未知字段） |
| 正常结束后逐条各开一轮 | 服务 | `tests/agentQueueDrain.test.ts` |
| 停止/失败/中断：保留、不自动发送；可立即发送、编辑、删除 | 服务+命令 | `tests/agentQueueDrain.test.ts`；`tests/agentPendingInputs.test.ts`（hold 与 `settleRun` 同事务、编辑 CAS、删除竞态） |
| 刷新/重启后仍在；重启时原 run 判中断则按上条处理 | 命令+恢复 | `tests/agentPendingInputs.test.ts`（`recoverAbandonedRuns` 后 held、零请求，参照 `agentRuntimeOwnership.test.ts`） |
| 批量运行期间输入框不锁，可发送并开新一轮；批量暂停/取消/编辑不因聊天持锁失败 | 运行时 | `tests/agentBatchDecoupling.test.ts`（每个锁名独立的假锁；批量运行中 `claim` 成功；聊天持锁时 `stopGenerationBatch` 成功；聊天开始不把存活批量判中断；音频确认后新建 run 仍可派发） |
| 采纳后自动开新一轮；采纳前不触发；有淡色系统提示 | 命令+服务+UI | `tests/agentBatchAdoptionContinue.test.ts`；`tests/agentQueueUi.test.ts`（系统行不是气泡） |
| 自动续跑持久化 | 服务 | `tests/agentBatchAdoptionContinue.test.ts`（新建 service 实例模拟重启，`initialize()` 派发系统项，用户项不派发） |
| 等待用户动作的操作只出现在输入框卡片 | UI | `tests/agentQueueUi.test.ts` 或各组件现有测试（B4a 清单确定后补） |
| 同对话只一个 run；多线程不变；不回归 | 回归 | 现有 `agentExecutionService.test.ts`、`e11RetainedWork.test.ts`（`videoBatch` 改用批量登记表要更新）、`audioGenerationBatch.test.ts:336`（`kind:"audioBatch"` 断言要更新）、`agentGenerationBatch.test.ts:161`（恢复函数签名）、`agentRuns.test.ts`、`agentFinishingCheck.test.ts`、`storageRegistryHash.test.ts` |

补充：`isLaterUserTurn` 的 6 个调用点各一条回归；存储契约 `sharedStorageContract` 与 `sharedNativeStorageContract` 自动覆盖新表，`pnpm test:storage:native` 做原生端回归；可选浏览器回归脚本参照 `tooling/agent-parallel-details-browser.mjs`，只作发版前验收。

## 12. 决策点

| 编号 | 问题 | 默认 | 备选 | 状态 |
| --- | --- | --- | --- | --- |
| D1 | 持久化载体 | 新表 `agentPendingInputs`（符合 PRD） | `deviceSettings` 每线程一个 key，免迁移但不能按状态建索引 | PRD 已定新表 |
| D2 | 插队是否支持附件 | v1 仅文本；带附件的卡片只能排队 | 注入时复用 `selectReferenceContext` 并校验视觉能力 | 默认 |
| D3 ★ | 线程被带 tool call 的中断 run 阻塞时的「立即发送」 | 「结束上次执行并发送」（先 `cancelAgentRun` 再派发） | 只显示原错误，用户手动结束 | **待 owner 确认** |
| D4 | 启动后自动派发范围 | 仅系统项；用户项保持可见 | 全部 queued 项 | 默认（与 PRD「停止后不自动发送」一致） |
| D5 | 插队行显示位置 | 独立气泡，排在该 run 的 assistant 气泡之后，加「引导」标记 | 内嵌到该 run 过程时间线 | 默认 |
| D6 | 队列容量 | 每线程 20 条，系统项按 `dedupeKey` 合并 | 其他数值 | 默认 |
| D7 | 系统项使用的模型 | 线程最近一次 connector、model、reasoning | 用批量来源 run 冻结的那一套 | 默认 |
| D8 | 音频采纳触发续跑 | v1 不做；提供 `enqueueSystemInput` 接口 | 在 arrangement 选用点接入 | 默认 |
| D9 | 最终答复时仍有未送达插队项 | 降级为 next-turn，run 结束后出队 | 同 run 续写（参照 `saveAgentFinishingCheck`） | 默认 |
| D10 | 批量并行度 | 每线程仍只允许一个运行中图片/视频批量，仅锁换批量级 | 允许同线程多批量 | 默认 |

## 13. 规范同步

实现完成后更新：`agent-core/library/runtime.md`（`admitPendingInput` 契约与不得插入的位置）、`frontend/agent-execution.md`（队列状态机、hold 原子性、drain 条件）、`frontend/agent-batch-generation.md`（批量级锁、批量登记表、恢复按批量锁判断）、`frontend/agent-context.md`（插队消息在后缀、不触碰 base 前缀）、`frontend/shared-product-storage.md`（54 表、Dexie v28）、`frontend/agent-jobs-results.md` 与 `agent-project-context.md`（涉及锁规则段落的措辞）。

## 关键文件

`packages/agent-core/src/runtime.ts`；`agent/runtime/agentExecutionService.ts`；`agent/commands/agentRuns.ts`；`agent/commands/agentRunTerminalState.ts`；`agent/runtime/runChat.ts`；`agent/runtime/threadWork.ts`；`agent/runtime/runOwnership.ts`；`video/agent/generationBatchRuntime.ts`；`audio/generation/batchRuntime.ts`；`agent/commands/agentGenerationBatches.ts`；`platform/storage/browserDatabase.ts`；`agent/ui/FloatingComposer.tsx`；`agent/ui/AgentChatPage.tsx`；`agent/ui/MessageList.tsx`。
