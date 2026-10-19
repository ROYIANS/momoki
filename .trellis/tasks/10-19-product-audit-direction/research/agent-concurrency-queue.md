# Agent 运行中的并发与消息队列现状

来源：调研子 agent 报告（主会话落盘）。路径相对 `packages/studio/src/features/`，除非另注。只读代码，未运行验证。

用户反馈：1) 对话没停止时不能发起批量请求，应支持并行；2) 不支持类似 Codex 的消息队列：运行中可继续发消息，既可「本轮结束后触发」，也可「插队：下一次 tool call 边界处触发」。

## a) 运行中发送消息的当前行为

- 没有消息队列实现。grep `agent/` 下的 queued/enqueue/pending-send 没有用户消息队列。"queued messages" 只出现在归档设计文档里（`10-16-ui-ux-overhaul/prd.md:40`、`research/popover-model-composer-audit.md:107`，作为 Codex 参照）。输入框的附着队列目前只装审批和确认（`agent/ui/composerAttention.ts`、`AgentComposerAttention.tsx`）。`10-15-agent-optimistic-send/research/ui-design.md:36` 明确写过「不要把下一条草稿编辑做成消息队列」。
- 输入框可以继续输入，但发送被静默禁用：
  - `agent/ui/FloatingComposer.tsx:149`：`canSend = ... && !blocked && !sending && ...`。
  - `FloatingComposer.tsx:425`：`SendCircleButton sending stopping canSend`，发送按钮在运行中变成停止。
  - 回车走 `trySend()`（`:340`、`:289-297`），`canSend` 为假时什么都不做，没有任何提示。附件、导入、语音控件同样受 `sending` 限制（`:171`、`:180`、`:421`）。
- 页面层第二道拦截：`agent/ui/AgentChatPage.tsx:178-181` 的 `sendLocked()` 读 `agentExecution.snapshot(id).active`；`handleSend`（`:358-359`）提前返回；`sending` 来自 `useChatExecutionSession.ts:36`（`sending: snapshot.active`）。
- 服务层第三道拒绝：`agent/runtime/agentExecutionService.ts:149-150`（`claim`）：`if (owner.invocation) throw new Error("当前对话尚有执行未结束，请等待完成或先停止")`；`agent/runtime/threadWork.ts:35` 有同样检查。
- 数据库层第四道：`agent/commands/agentRuns.ts:103-104`（`beginAgentRun`）：`runs.some(runBlocksThread)` 则抛「此对话已有执行…」；`runBlocksThread`（`agent/models/agentToolSelection.ts:11`）在状态为 running/waiting_approval，或 interrupted/failed 且带 tool call 时为真。
- 消息没有持久化队列：每次发送原子地创建一个 `AgentRun` 加一条 user、一条 assistant 的 `chatMessages`（`agentRuns.ts:64-246`）；run 在开始时冻结上下文：`context.history`、`requestMessages`、`baseMessages`（`:155-165`）。

## b) 运行中为什么批量任务被阻塞

UI 上没有与 run 挂钩的 disabled 标志。阻塞来自「每个线程同一时间只有一个执行」这条不变量，在三处强制：

1. **内存预留 `agent/runtime/threadWork.ts:31-38`**：`reserveAgentThreadWork` 在 Map 里按 `threadId` 保留一项，已有工作则抛「当前对话尚有执行未结束…」。`agentExecutionService.ts:146` 的每个 `claim()` 都会预留（submit、retry、decision、check、recovery、taskWrapup、contextCompaction）；`videoBatch`、`audioBatch` 也占用同一个槽位。所以批量任务在 run 活跃时不能启动，反之亦然。`AgentWorkIdentity` 在 `threadWork.ts:5-10`。
2. **Web Lock `agent/runtime/runOwnership.ts:46-48`**：锁名 `cuepoint:agent:${threadId}`，以 `{ifAvailable:true}` 申请；被占用则抛「此对话正在另一个页面执行…」。`withThreadRunLock`（`:68-75`）在执行前会跑 `recoverAgentJobs`、`recoverAbandonedGenerationBatches` 和 `interruptThreadRuns`（`agentRuns.ts:274`）；获取锁会把该线程其他 running 的 run 标记为 interrupted，所以锁必须独占。`withExecutionOwnership`（`:42-65`）在整个 `executeRun` 期间持锁。
3. **批量入口同时使用预留和锁**：
   - 图片/视频批量：`video/agent/generationBatchRuntime.ts:46-52`（`startGenerationBatch`）：`workers.has(threadId)` 则抛「此对话已有批次正在执行」，再 `reserveAgentThreadWork(..., {kind:"videoBatch"})`；`:65`：`worker.done = withThreadRunLock(threadId, ...)`；`:27-42`（`batchUserAction`）暂停、取消、编辑也走 `withThreadRunLock`，所以聊天 run 持锁时这些控制也会失败。
   - 音频批量：`audio/generation/batchRuntime.ts:34-38`：Agent 拥有的批次用 `withThreadRunLock(threadId, lockBatch)`；项目拥有的批次只用锁 `cuepoint.audio-batch.${id}`，与对话无关；`:66`、`:83` 预留 `audioBatch`。
   - UI：`agent/ui/AgentGenerationBatches.tsx:289` 的 `blocked = pending || !detail || view.error || parentReadError || view.readOnly` 没有 run 相关项，失败是点击之后才通过 `start()`（`:347`）和 `setError(message(cause))` 暴露。
- 图片批量只属于 Agent：批次由模型工具 `prepare_generation_batch`（`video/agent/generationTools.ts:47`）创建；`ownedGenerationBatch`（`agent/commands/agentGenerationBatches.ts:59-65`）要求有来源 run、call 和 thread，所以不存在项目级的图片批量。用户确认草稿后 `startGenerationBatch` 以 `BATCH_CONCURRENCY=2`（`agent/models/agentGenerationBatch.ts:8`）执行，单批上限 20 项。
- 单个 run 内 tool call 严格串行：`packages/agent-core/src/runtime.ts:116`（准备与审批）和 `:151`（执行）都是 `for` 循环逐个 `await tool.execute`，所以一轮里的单图 `submit_generation` 不会与其他 tool call 重叠。

## c) 并发模型

- 不同线程可在同一 WebView 内并行：`agentExecutionService.ts` 维护 `threads = new Map<threadId, ThreadState>`，每线程一个 `invocation` 槽；Web Lock 按线程；这条路径上没有发现全局限流；侧栏的线程活动（`agent/queries/threadActivity.ts:20-30`）按线程显示忙碌。
- 没有项目级互斥：项目范围按 tool call 通过 `frozenProjectScope` 和 `assertProjectToolScope` 检查，不靠锁。
- Agent run 与后台 job 的关系：`AgentJob` 类型有 `web_read`、`project_media_check`、`mcp`（`agent/models/agentJob.ts`），由 run 内的 tool call 准入（`admitAgentJob`，`commands/agentJobs.ts:155`），带 `runId`、`callId`；`recoverAgentJobs(threadId, ownership)` 在 `withThreadRunLock` 内执行。生成任务（`agentGenerationJobs`）在认领时也要求 `run.status==='running'` 且 call 为 `running`（`agent/commands/agentGeneration.ts:21-24`），批量流程通过 `claimBatchItem` 绕过。简言之，job 是同一线程锁下 run 或批次的子项，不是独立的并发域。
- 批次与 run 共用线程工作槽：批次 worker 在整个持续期间同时持有 `reserveAgentThreadWork` 和线程 Web Lock；批次期间 `sending` 为真（快照 `active` 包含 `work`），输入框同样被锁并显示停止（`handleStop` → `requestWorkStop`，`AgentChatPage.tsx:352-355`）。
- 文档：`.trellis/spec/agent-core/library/runtime.md:85`「capability is bound to the actually held thread lock… admits one execution at a time」；`.trellis/spec/frontend/agent-project-context.md:28`、`agent-jobs-results.md:191` 有锁规则。

## d) 实现「排队（本轮结束后）」与「插队（下一次 tool call 边界）」要改的层

**agent-core 循环（`packages/agent-core/src/runtime.ts`，`executeRun` 在 `:205`）**
- 插队的候选边界已经存在：`executePendingTools` 返回 true 后（`:263`）回到 `while(true)`（`:226`），依次 `host.pauseAtLimit`、`host.prepareContext(run)`（`:230`）、`host.admitModelStep`（`:231`）、`host.request`。
- Studio 的 `prepareContext` 在 `agent/runtime/runChat.ts`（约 92 行），会刷新工具加载、项目上下文和记忆，再调 `prepareRunContext`。
- 没有注入用户输入的 pre-step 钩子：`RuntimeHost`（`runtime.ts:35-72`）有 `prepareContext`、`admitModelStep`、`finishingCheck`、`commitRound`，没有返回待处理用户消息的方法，需要新增宿主方法。
- 已有「继续循环」钩子：`finishingCheck` 返回 true 时 `continue`（`:246`），「本轮结束后触发」可挂在这里而不需要新建 run。
- 模型对话记录存在 run 行里而不是聊天历史：`appendToolResults`（`agent/commands/agentTools.ts:267`）把 `{role:'tool'}` 消息推进 `run.continuationMessages ?? run.requestMessages`；Responses 协议还要 `responseItems`；provider 的 continuation 是不透明的。
- 注入用户消息 = 向 `continuationMessages` 追加 `{role:'user'}`（参考图路径已这样做，`agentTools.ts:285-300`）；Responses 还要扩展 `responseItems`，经 `@cuepoint/agent-providers` 的 `responseRoundMatches` / `appendResponseToolResult`。

**持久化与 schema**
- run 在开始时冻结 `context.history` 和 `baseMessages`，注入的输入需要自己的持久 `chatMessages` user 行。
- 按 `createdAt` 排序有隐患：assistant 行在开始时以 `at+1` 创建，之后的 user 行会排在它后面；`MessageList.tsx` 按消息顺序渲染。
- 待处理项需要新表或新字段（目标是下一步还是下一轮、顺序、附件、准入身份），这是新的产品 schema 和迁移，而 `runtime.md:85` 要求「Preserve the product schema」。
- 待处理项必须能在重载后保留；`recoverAbandonedRuns` / `interruptThreadRuns`（`agentRuns.ts:274`）需要决定保留还是清除。
- 幂等准入（现为 `agentAdmission.ts` + `ChatAdmissionIdentity`）也要扩展。

**服务 / 所有权**
- `agentExecutionService.ts` 的 `claim()` 在已有 `owner.invocation` 时抛错（`:150`），`send`/`submit` 总是走 `claim`；需要在现有 invocation 上新增 `enqueue` 或 `steer` API。目前 `threads[threadId].attempts` 是单次尝试的 UI 状态，`ChatSubmissionAttempt`（`models/chatSubmissionAttempt.ts`）带阶段并被冻结。
- tool 边界钩子必须在持有的 `ThreadOwnership` 下运行（`withOwnedExecution`）；`runChat.ts:46-60` 的 `guard()` 事务固定了 `current.modelStep !== run.modelStep` 不变量。
- 本轮结束后，排队项要在锁/invocation 仍被持有时启动新的 `beginAgentRun`；现在锁在 `claim` 的异步块结束时释放，`reservation.follow(done)` 释放槽位。

**UI**
- `FloatingComposer.tsx:149`（`canSend`）和 `:425`（`SendCircleButton`）需要「运行中发送」模式以及插队/排队选择；`trySend`（`:289`）没有反馈路径。
- `AgentChatPage.tsx:178`（`sendLocked`）、`:358`（`handleSend`）同理。
- `ComposerCardHost` / `composerAttention.ts` 是现成的附着队列界面，待处理项可以显示在这里。
- `MessageList.tsx` 以 `message.id` 和持久 user ID（轮次与滚动身份）为键，注入的消息要渲染在正确位置。
- `useChatExecutionSession` 与 `threadActivity` 发布 `busy`。

**风险（来自代码/spec）**
- provider 协议完整性：在 assistant tool_calls 与 tool results 之间注入用户内容会破坏 chat-completions 和 Responses 的信封，只有 `appendResults` 之后的点是安全的；`validateEnvelope`、`responseRoundMatches`、`claimFingerprint` 校验冻结形状。
- 上下文预算：`prepareRunContext`（`runtime/contextCompaction.ts`）假设基础消息冻结，且「Validate exact base prefix before replacing either protocol envelope」（`.trellis/spec/frontend/agent-context.md:46`），运行中的用户输入会改变这个前缀。
- 记忆与引用的选择是每次 begin 时确定的（`agentRuns.ts:144-155`）。
- 恢复与中断语义：待处理输入 vs 被中断的 run。
- 跨标签页：Web Lock 是唯一的单写者保证。
- 同一线程并发第二个 run 会违反 `runBlocksThread`、`reserveAgentThreadWork` 和 `interruptThreadRuns` 的假设（获取锁会中断其他 running 的 run），所以「批量与 run 在同一线程并行」需要把这三处一起重新设计。

## e) 参考：deepseek-harness（dsh）

- 本机可访问，路径见 `.trellis/tasks/archive/2026-10/10-16-e-series-review-fixes/research/dsh-host-architecture.md`。
- 两个持久收件箱（`packages/core/agent-loop/src/inbox.ts`）：`next-turn` 是排队，`next-step` 是插队。状态是从会话日志里的 `agent/inbox/spliced` 事件投影出来的。`ReactLoopInbox.claim(target, turn)`（`:97-102`）取走所有 `next-step` 消息，并在轮次边界再取一条 `next-turn`，每条发出 `agent/inbox/claimed`；`append`、`prepend`、`replace`、`remove`、`clear` 都是持久的 splice。
- Agent 入口（`packages/core/agent-loop/src/agent.ts`）：`followup(input)` = `send(input,'next-turn',true)`；`steer(input)` = `send(input,'next-step',true)`；`inject(input)` = `send(input,'next-step',false)`（不唤醒，`:163-173`）；`send`（`:154-161`）把「中止后唤醒的输入」归为 `next-turn`；`cancel` 默认清空收件箱，除非 `keepInbox`（`:175`）。
- 轮次循环（`agent.ts` 的 `turn()`，约 `:298-385`）：每次迭代调用 `preStep(target)`，其第一步是 `inbox.claim(target, turn)`（`:271`），取得的消息进入 `agent/pre-step` waterfall（`:274`）成为该步输入；一步结束后若 `nextStep` 非空则以 `target='next-step'` 继续（`:361-367`），只有没有待处理 steer 时才运行 `agent/turn-stopping`；轮次结束时若 `inbox.hasPending` 则启动下一轮（`:380-385`）。
- UI（`packages/client/ui-conversation/src/client/queue/QueueDock.tsx`、`input/hub.ts`）：按 `session-controller/README.md:34`，QueueDock 对两个列表提供编辑、移除、转为 steer；客户端回显见 README `:56-59`；提示按 `requestId` 去重，回显根据当前运行状态和投递模式显示为 transcript、queued 或 steering。
- 与 Cuepoint 的差别：dsh 的每步认领是内建在循环里的，Cuepoint 的 `executeRun` 没有对应物，模型请求前的接缝是宿主的 `prepareContext` / `admitModelStep`。

## 局限

- 没有运行任何东西。
- `SendCircleButton` 的具体代码（在 `ui/ModelSelectTrigger.tsx:336`）没验证，「运行中变停止」是从其 props 推断的。
- 这条路径上没发现跨线程的全局并发上限，但没有审计每个 provider 层。
