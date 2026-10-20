# Agent 排队插队与批量并行

## Goal

用户在 Agent 运行中不必等待：可以继续发消息，并选择让它「本轮结束后再处理」或「在下一次 tool call 边界插入」；批量任务（生图、配音等）不再把整个对话锁死；用户采纳批量结果后 agent 自动接着做，不用再手动发消息。所有「等用户动作」的操作集中在输入框上方，不再散落在对话消息里。

用户的真实流程：agent 整理批量 → 用户确认 → agent 这一轮结束 → 用户触发提交 → 生成完 → 用户采纳 → 用户手动发消息让 agent 继续。痛点是批量期间对话被锁、agent 不会自己继续、操作按钮散在消息里。

本阶段只做规划，不改代码。

## Background（已确认事实，证据：`../10-19-product-audit-direction/research/agent-concurrency-queue.md` 与 design.md §0、§2）

- 当前没有任何用户消息队列。运行中输入框可输入，但发送被静默禁用（`FloatingComposer.tsx:149` `canSend`），按钮变成停止，回车无反馈。
- 「每个对话同一时间只有一个执行」在四层各拦一次：`canSend`、`AgentChatPage.tsx:178` `sendLocked`、`agentExecutionService.ts:149-150` `claim()`、`agentRuns.ts:103-104` `runBlocksThread`。批量另走内存预留 `threadWork.ts:31-38` 加 Web Lock `runOwnership.ts:46-48`。
- 批量运行期间 `sending` 同样为真，输入框被锁；批量的暂停/取消/编辑也要拿同一把线程锁，聊天 run 持锁时会失败。
- 不同线程之间已经可以并行；没有项目级互斥。
- 图片批量只能由 Agent 工具 `prepare_generation_batch` 创建（要求有来源 run/call/thread），没有项目级入口；音频批量在「项目拥有」时只用独立锁、与对话无关。
- 插队的天然边界：tool 结果追加之后、下一次模型请求之前（`packages/agent-core/src/runtime.ts:263` 回到 `:226` 循环，经 `prepareContext` / `admitModelStep`）。宿主 `RuntimeHost`（`runtime.ts:35-72`）没有注入用户输入的钩子。
- 不能在 assistant tool_calls 与 tool results 之间插入用户内容，否则破坏 chat-completions 与 Responses 协议信封；Responses 另需扩展 `responseItems`。
- 获取线程锁时 `interruptThreadRuns` 会把同线程其他 running 的 run 标为 interrupted。因此「同线程再开第二个 run」需要同时重设计 `runBlocksThread`、`reserveAgentThreadWork`、`interruptThreadRuns`；本任务不需要同对话并发两个 run，只需让批量不占线程锁。
- 参照 dsh（`packages/core/agent-loop/src/inbox.ts`、`agent.ts`）：两个持久收件箱 `next-turn`（排队）与 `next-step`（插队），每步开始 `inbox.claim`，轮次结束时仍有待处理则开启下一轮；QueueDock 提供编辑/移除/转插队。
- 历史约束：`10-15-agent-optimistic-send/research/ui-design.md:36` 曾明确「不要把下一条草稿编辑做成消息队列」；本任务有意推翻该决定。
- 设计阶段读码发现的高风险点（详见 design.md §0）：仓库有 6 处「run 之后出现更晚 user 消息即视为过期」的判定，插队产生的 user 行会让它们全部失效，必须先统一谓词；音频批量的派发会因用户在批量运行中发新消息而失败，必须放宽。

## Requirements

范围（owner 已定，2026-10-19）：一个任务内规划下列共用一套机制的事，不再拆阶段。

1. **待处理消息队列**：来源既可以是用户（排队/插队），也可以是系统事件（批量完成、用户采纳结果）。
2. **运行中发送默认排队**（参照 Codex）：消息成为输入框上方附着队列里的一张待发送卡片，不打断当前运行；卡片带「引导」按钮（提示「提交，但不中断模型运行」，即转为插队，在下一次 tool call 之后送达）、删除和更多操作；输入框右下角保持停止按钮。队列位置复用 `composerAttention.ts` / `AgentComposerAttention.tsx` 的附着卡片机制。
3. **停止/失败/中断后队列保留但不自动发送**：卡片仍留在输入框上方，用户逐条「立即发送」、编辑或删除；三种情形行为一致。
4. **队列持久化**：待发送消息（含系统消息）存数据库，刷新、重启后保留；需新增表与迁移，并定义重启后原 run 被判定为中断时的处理。
5. **多条排队逐条送出**：一轮正常结束后按顺序每条单独开一轮；一张卡片对应一次发送。
6. **批量脱离对话锁**：批量运行期间用户可继续聊天、发消息；批量使用自己的锁，参照音频「项目拥有」批量的做法。同一对话任何时刻仍只有一个 agent run。
7. **自动续跑**：用户采纳批量结果后，向队列放入一条系统消息触发 agent 继续；采纳后才触发，批量刚跑完时不触发。系统消息同样持久化。
8. **自动续跑在对话里显示一行淡色系统提示**，如「已采纳 3 张图，继续」，不是用户气泡；提示内容同时是 agent 续跑所依据的信息。
9. **设计原则：所有操作围绕输入框，对话消息内不出现操作按钮。** 本任务范围（owner 选 A）：只迁移「会让 agent 停下来等用户」的操作——审批、确认批量、提交、暂停、取消、采纳、重试、继续、检查结果——全部进入输入框上方附着卡片，与排队卡片同一位置。其余消息内按钮（报告翻页、展开详情、实体链接、「返回最新」等）不在本任务。重型审阅放右侧栏（另一子任务）。具体清单待 implement.md B4a 盘点后确定。

## Acceptance Criteria

核对于 2026-10-20，证据为自动化测试与读码；**未在真实应用或真实浏览器里手动验收**（见末尾）。

- [x] 运行中按发送：消息变成输入框上方的待发送卡片，当前运行不被打断；卡片有「引导」、删除、更多。（B4-1，`tests/agentQueueUi.test.ts`）
- [x] 点「引导」：消息在当前运行的下一次 tool call 完成之后、下一次模型请求之前送达；不会插在 assistant tool_calls 与 tool results 之间（chat-completions 与 Responses 两种协议均有测试）。（B3，`tests/agentSteerInjection.test.ts`、`packages/agent-core/src/runtime.test.ts`）
- [x] 一轮正常结束后，队列按顺序逐条送出，每条单独一轮。（B2，`tests/agentQueueDrain.test.ts`）
- [x] 点停止，或运行失败/中断：队列保留、不自动发送；用户可逐条立即发送、编辑、删除。（B2 hold 与终态同事务，有回滚测试）
- [x] 刷新页面或重启应用后，待发送卡片仍在；重启时原 run 被判定为中断，队列按上一条规则处理。（B1/B2；重启恢复用 `recoverAbandonedRuns` 测试）**桌面端原生 SQLite 路径未验证（本机无 cargo）。**
- [x] 批量（图片/视频、音频）运行期间，输入框不被锁，用户可正常发送并开始新一轮；批量的暂停、取消、编辑不再因聊天 run 持锁而失败。（B5，`tests/agentBatchDecoupling.test.ts`）**跨标签页的真实 Web Lock 仅用模拟锁验证。**
- [x] 用户采纳批量结果后，agent 自动开始新一轮；采纳前（批量刚跑完时）不触发；对话里有一行淡色系统提示。（B6，`tests/agentGenerationBatch.test.ts` 新增 4 条；系统行渲染见 B4-1）
- [x] 自动续跑消息同样持久化：采纳后立刻刷新，agent 仍会继续。（系统项与槽位写入同事务；启动只派发系统项，B2 有测试）
- [ ] **部分完成**：审批、确认批量、提交、暂停、取消、采纳、重试、继续、检查结果这些操作不再出现在对话消息内，统一出现在输入框上方附着卡片。
  - 已迁：审批/拒绝、继续/结束本次执行、批量的审阅/暂停/继续/查询进度/取消剩余/为失败项新建草稿/写入。
  - 未迁：生成提案与音乐生成的确认/取消（在要编辑的表单里，随右侧栏任务迁）、收尾总结的确认/重新整理（编辑面板，同上）、桌面导入的停止/核对、MCP 结果核对（两者独立，是可以马上做的小项）。批量的「确认生成」「保存草稿」留在审阅面板（要用本地编辑内容，随审阅面板一起迁）。
- [x] 同一对话任何时刻仍只有一个 agent run；多线程并行行为不变；现有 agent/批量测试不回归。（全量测试：除需要 Rust 探针的原生测试外全部通过）

另：引导消息按送达位置显示在 run 时间线内、不带标签（owner 追加要求，已完成，`tests/steeredPlacement.test.ts` 等）。

## Out of Scope

- 右侧栏迁移（另一子任务）。
- 消息区内不属于「等待用户动作」的按钮（报告翻页、展开详情、实体链接、「返回最新」等）。
- 内置技能体系、运行中断原因排查（owner 另提，列入审计任务候选）。
- E11 Rust Host / 独立 Host 进程。
- 音频「采纳」（arrangement 选用）触发续跑（design.md D8；仅预留 `enqueueSystemInput` 接口）。
- 插队消息携带附件（design.md D2；带附件的卡片只能排队）。

## Open Questions

- **D3（owner 批准总结时未单独回答，按设计默认「是」执行，可随时改）**：线程被「带 tool call 的中断/失败 run」阻塞时，点「立即发送」是否自动结束上次执行再发送？设计默认：是（按钮显示「结束上次执行并发送」，保留已完成步骤）。
- design.md §12 其余决策（D1、D2、D4–D10）已按默认取值，不阻塞规划；如有异议请指出。
- 设计里「未核实」的技术点（design.md §0 第 10–15 条）留在对应批次实现时核实，不阻塞规划。
