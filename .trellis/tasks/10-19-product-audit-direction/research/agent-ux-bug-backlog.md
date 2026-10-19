# Research: Agent 体验与稳定性问题清单

- **Query**: 盘点 Agent 对话体验已知 bug、体验缺陷、已记录未修问题
- **Scope**: internal（归档任务文档 + 代码核对，只读）
- **Date**: 2026-10-19（HEAD 5af8def1，分支 main）

路径缩写：`ARCH` = `.trellis/tasks/archive/2026-10`；`REV` = `ARCH/10-16-e-series-delivery-review/research`；`FIX` = `ARCH/10-16-e-series-review-fixes`；`UX` = `ARCH/10-16-ui-ux-overhaul`；`R/` = `apps/desktop/src-tauri/src/`；`S/` = `packages/studio/src/`。
严重度沿用来源文档标注，不自行升降；来源无标注的写「无标注」。「普通用户」指是否可能在日常使用中遇到。

## 0. 总体结论（先读）

1. 来源：`REV/review-summary.md` 列出的 P1 共 5 类；`FIX` 计划分 9 批，git 历史里只能找到批次 1-5（`b4f5011a`、`d327169e`、`869e47a3`、`026cffc9`、`50ac64c8`）的修复提交。**批次 6（E11 interim：WebView 崩溃恢复、Quit/关闭流程、草稿持久化）、批次 7（task.json 台账修正）、批次 8（Rust Host）在 git log 与代码里都找不到对应提交或改动**，但 `FIX/task.json` 状态为 `completed`、归档提交为 `5af8def1`。`FIX/prd.md` 的验收项全部未勾选，且 `FIX/research/deferred.md` 没有记录 E11 被推迟。（这是文档与代码对照后的事实；owner 是否口头决定放弃，文档中无记录，标注未核实。）
2. 代码层 `packages/agent-core/src`、`packages/agent-providers/src`、`packages/studio/src/features/agent` 中没有 TODO/FIXME/HACK 注释（grep 无命中）；`packages`、`apps`、`examples`、`tests` 下没有 `it.skip`、`test.todo`、`xit`、`xdescribe`。已知限制只存在于文档里。
3. 未修项集中在：E11 后台宿主（崩溃/退出）、少量聊天 UI 文案残留、E-series 的 P3 与未分配归属的实体族。

## 1. 仍存在 / 部分修复（按优先级排序）

| # | 问题 | 来源证据 | 严重度 | 影响普通用户 | 状态 |
|---|---|---|---|---|---|
| A1 | WebView 在窗口隐藏期间被系统终止/崩溃时，没有检测与恢复；所有后台运行同时丢失，也没有"后台工作被中断"的提示 | `REV/review-E11.md` P1-1；`FIX/prd.md` 第 4 项；`FIX/design.md` "E11 interim"。核对：`R/` 下 grep `ProcessFailed|crash|fullscreen|session` 无任何 WebView 终止处理（仅 `desktop_media_process.rs`、`singleton.rs` 的无关命中） | P1 | 是（开启后台保留的桌面端用户，内存压力下可能遇到） | 未修（代码核对） |
| A2 | Quit 在渲染进程 1 秒内未应答时，跳过未保存手动草稿的决策，直接进入退出流程，可能丢弃脏草稿 | `REV/review-E11.md` P2-1；代码 `R/desktop_lifecycle/native.rs:180-199`（`Duration::from_secs(1)` 超时后 `initial.is_ok()` 为假即跳过人工等待） | P2 | 是（退出时有未保存编辑且渲染进程繁忙） | 未修（代码核对，逻辑与评审描述一致） |
| A3 | 有运行中任务时 Quit/关闭不提示；首次隐藏到后台无通知（Windows 用户可能以为已退出） | `REV/review-E11.md` P2-2；`FIX/prd.md` 第 14 项。核对：`R/` 与 `S/app` 无相关提示实现 | P2 | 是 | 未修（代码核对；仅 grep 判断） |
| A4 | 没有 Windows 会话结束放行和 macOS 全屏退出处理：关闭一律 `prevent_close` + hide | `REV/review-E11.md` P2-6；`R/desktop.rs` 关闭处理；grep `fullscreen|session|ENDSESSION` 无命中 | P2 | 是（Windows 注销/关机；macOS 全屏窗口关闭） | 未修（代码核对；真机效果未验证） |
| A5 | 草稿与失败/不确定的发送记录只在内存中，WebView 重载/崩溃/强制退出即丢失；草稿 map 不随线程删除清理 | `REV/review-E11.md` P2-3；`S/features/agent/runtime/chatDraftStore.ts` grep 无 `localStorage/deviceSettings/persist`；`agentExecutionService.ts` 的 `attempts` 数组 | P2 | 是 | 未修（代码核对） |
| A6 | 启动恢复是全有或全无，且失败结果被永久缓存：一个线程的坏数据会让整个 App 显示"工作区无法打开"；`recoverAbandonedRuns` 没有逐线程 try/catch | `REV/review-E11.md` P2-4；`S/features/agent/runtime/agentExecutionService.ts:135-142`（`initialized ??=`）；`S/features/agent/runtime/runOwnership.ts:76-97` 循环中无 try/catch；`tests/agentExecutionService.test.ts:329-345` 固化"拒绝保持缓存" | P2 | 少数（需要坏数据/锁错误触发） | 未修（代码核对） |
| A7 | Quit 过程中再次启动应用（`Closing`）直接 `exit(1)`，用户看到什么都没发生 | `REV/review-E11.md` P2-5；`R/desktop_lifecycle/native.rs:67-75` | P2 | 少数 | 未修（代码核对；仅读评审与结构，未逐行复核） |
| A8 | `claim()` 在 `feedbackOwner.begin(...)` 抛错时线程占位不释放，线程会一直显示忙；`catch` 中 `attemptFor` 可能抛"发送记录不存在"使 `done` 不结算（当前被 `owner.invocation` 守卫，评审认为现不可达） | `REV/review-E11.md` P2-8；`S/features/agent/runtime/agentExecutionService.ts:150-170`（`reserveAgentThreadWork` 先于 `feedbackOwner.begin`，顺序未变） | P2 | 少 | 未修（代码核对） |
| A9 | 执行宿主仍是单 WebView（dsh 为独立 Host 进程）；Rust Host 批次未做 | `REV/review-E11.md` 第 5 节；`FIX/prd.md` "Last batch note"（可拆为后续任务）；`FIX/research/deferred.md` 未提及 | 来源在 `review-summary.md` 作为 E11 P1 的一部分 | 间接（A1 的根因） | 未做；是否已被 owner 另行决定：未核实 |
| A10 | E11 的 AC8（真实 hide -> Quit -> 退出，带运行中任务）只靠 fake-port 测试；Windows/WebView2 无任何执行证据 | `REV/review-E11.md` P1-2；`REV/review-summary.md` E11 行 | P1（证据缺口，非代码缺陷） | 间接 | 未修（需真机验收） |
| A11 | 聊天 UI 仍有内部术语 / 未统一的不确定结果文案：`导入结果待核对`、`待核实`（任务收尾、活动提醒、MCP）、`版本 N · 人工修订`（任务收尾） | `UX/research/deferred.md` "Left for the chat-UI owner"；核对：`S/features/agent/ui/AgentDesktopMediaReport.tsx:35`、`TaskWrapup.tsx:62,402`、`runtime/activityAttention.ts:46,78`、`mcp/runtime/tools.ts:18` | 无标注（UI/UX 遗留项） | 是（文案层面） | 部分（R3 词表已在非聊天页应用；聊天 UI 列表中的组件仍用旧词，已抽查 3 处命中） |
| A12 | UI/UX overhaul 的批次 8（种子浏览器夹具 + 侧栏/弹层/composer/设置截图）与批次 9（最终 trellis-check 与真实 UI 截图）无完成证据：`UX/research/screens/` 只有参考图和改造前截图（`ours-composer-notice.png`、`ours-interrupted-run-before.png`），无改造后截图；`UX/prd.md` 验收项全部未勾选 | `UX/implement.md`；`UX/prd.md` 验收标准；`UX/research/screens/` 目录清单 | 无标注 | 是（侧栏状态点、弹层不被裁切、R13 单气泡未经真实 UI 验证） | 部分（功能提交已在：`8ee9778f`、`5e15b516`、`0e89be1f`、`83ee14bc`；视觉验证未做/未存档） |
| A13 | E06 授权：`complete_todo`/`list_todos` 未走授权端口 | `REV/review-E06.md` F1 | P1 | 否（示例 Todo 宿主，非 Studio 主路径） | 已修（提交 `b4f5011a`；`packages/agent-core/src/runtime.ts:56,95-96` 已有 `assertBinding` 并在无宿主检查时阻断绑定工具；`complete_todo` 授权细节未逐行核对，未核实） |
| A14 | E10 授权/绑定未使用 E06 registry，是"可复用"声称的缺口 | `REV/review-summary.md` Cross-delivery；`REV/review-E06.md` F3 | P2 | 否 | 未核实（`FIX/prd.md` 第 2 项允许"移到 registry 或在 PRD 去掉声称"，未核对采取哪种） |
| A15 | 其余 E11 引入的并发限制：E07 批处理与发送共用同一线程槽，批处理运行时无法在该线程发送 | `REV/review-E11.md` 第 6 节；`REV/review-summary.md` Cross-delivery risks | 无标注（设计后果） | 是（视频/音频批处理期间） | 仍存在（设计行为，评审认为符合"同一会话互斥"；未见改动） |
| A16 | 实体族详情仍只有导航：素材库、IP 档案、记忆、项目/分集、音频/音乐条目没有 Agent 并行详情；E12-E15 取消后无人认领 | `FIX/research/deferred.md` 第一节；`REV/review-E16.md` P2-2 | P2 | 是（从 Agent 点击这些链接会离开聊天，而非并行详情） | 未修（已登记为后续；评审 P2） |
| A17 | 老遗留：`recoverAbandonedRuns` 对 `agentToolCalls` 全表 `filter()`（审计 S6）；原子工具被 Stop 时被记成 `failed`（审计 S4） | `ARCH/10-13-agent-experience-overhaul/research/code-defect-audit.md` S4、S6；journal-1 Session 60 遗留；核对：`runOwnership.ts:81` 仍有 `agentToolCalls.filter(...)`；S4 对应文件 `agentTools.ts` 已不在原路径，未核实 | Low（审计标注） | S6 少；S4 少 | S6 仍存在（代码核对）；S4 未核实 |
| A18 | 审计提到的 `armOnce` 结构性风险与 e01/e02 手动浏览器脚本待核对 | journal-1 Session 60 Summary（行 1684） | 无标注 | 未知 | `armOnce` 在 `packages`/`apps` 中已无命中，疑已被重构掉；e01/e02 脚本是否核对：未核实（现有 `pnpm test:browser:agent-parallel-details` 为手动/CI-opt-in 门禁，见 `package.json:17`、`FIX/research/deferred.md`） |

## 2. 评审中的 P3 项（来源已登记"不修"）

来源：`FIX/research/deferred.md`（E01-E04、E16 的 P3 项"recorded in the review reports, not fixed here"）。以下为主要条目，状态均为未修，来源均标 P3。

| 问题 | 来源 | 影响普通用户 |
|---|---|---|
| `data-unsaved-fields` 渲染期读 ref，可能落后一渲染（仅诊断用）；`ShotDetailFields` 约 70 行；shot 与 asset 面板重复约 60 行状态机 | `REV/review-E01.md` P3-1/3；`REV/review-E16.md` P3-4 | 否 |
| `createChatThread` 重复创建返回 ConstraintError 而非幂等；每次发送 `yieldSubmissionPaint` 最多增加约 32ms/80ms 延迟（未写入规范）；`AgentChatPage.tsx` 增长 229 行成为协调中心 | `REV/review-E02.md` P3-1/3/4 | 否（延迟很小） |
| 每步重新发出 `preparing` 阶段，工具轮后短暂回到 `preparing`；祖先 `opacity 0` 动画延迟"已显示"标记；`observedFetch` 在桌面原生 fetch 路径未确认 | `REV/review-E03.md` P3-1/2/3 | 基本否（第三项桌面端行为未核实） |
| 触摸拖动后程序化增长无测试；A→B→A 切线程总是回到底部（PRD 有意）；按钮位置依赖 `--agent-chat-composer-safe`，首次测量前用 168px 回退；"最后一条消息很高"时 follow 标志可能在尾部被裁切时仍显示跟随 | `REV/review-E04.md` P3-1~4 | 少数（长消息场景） |
| 最后一个文件时点停止被当作正常完成；停止标志每文件被重置导致状态可能闪烁；Studio 库资产归属依赖 `STUDIO_LIBRARY_ID` 存放于 `projectId` | `REV/review-E05.md` P3-1~3 | 少数 |
| 批量详情激活在 Agent provider 之外失效并回退为路由跳转；查询参数追加后会静默失去激活；`useManualDraftDeparture` 老问题；四类资产路由页无路由级回归测试 | `REV/review-E16.md` P3-1~5 | 少数 |
| 侧栏"等待批准"只有读屏/title 标签；每个侧栏行一个 `db.observe`；每个流式检查点多写一条 `deviceSettings`；Windows 托盘图标缺失会让启动失败；`dismissAttempt` 重复返回 `false` | `REV/review-E11.md` P3-1~5 | 少数；其中等待批准标记 UI/UX R1 已要求做可见标记（`UX/prd.md` R1），代码是否做到未核实 |
| E06 P3：F8-F12（CLI 自动发授权、错误文案混用中英文、`vitest.agent-source.config.ts` 要求 Node >= 24.11 导致 E06 套件不在默认 `npm test`） | `REV/review-E06.md` F8-F12 | 否 |
| E07 P3：F8-F13（预览截断循环、job kind 与工具名耦合、媒体 revision 只用 文件名+类型+大小、读报告无逐 run 预算、清除后审计丢失） | `REV/review-E07.md` F8-F13 | 少数 |
| E08 P3：10 分钟超时含系统文件对话框等待；多种解码错误合并成一条通用文案；PNG 解压炸弹仅靠头尺寸限制；`desktop_media.rs` 1712 行 | `REV/review-E08.md` F9-F12 | 少数（超时：用户在对话框停留 > 10 分钟） |
| E09 P3：F5-F9（`load_skill` 长度守卫单位不一致；大于 65,536 字符的 `load_skill` 结果后续无法读资源；目录名必须是 kebab-case 且等于 skill name（评审称"真实用户最先会遇到"）） | `REV/review-E09.md` F5-F9 | 是（技能目录名限制） |
| E10 P3：F6-F11（只用 SIGKILL 无礼貌关闭；`env_clear` 默认已加白名单（代码中 `PATH`、`SystemRoot` 已在白名单，见下表）；只读工具也一律要审批；单连接串行；>1MiB 结果在服务端已执行后才报错） | `REV/review-E10.md` F6-F11 | 是（所有外部 MCP 工具每次需审批；F11 少见） |

## 3. 已被后续提交修复（核对）

| 问题 | 来源 | 严重度 | 修复证据 |
|---|---|---|---|
| E07 目录测试因 `load_skill`、`read_skill_resource` 失败（2 个用例红） | `REV/review-E07.md` F1（P1） | P1 | 提交 `b4f5011a`；`tests/d05ToolCatalog.test.ts` 在 `packages/studio` 下无该文件，仓库根 `tests/d05ToolCatalog.test.ts` 存在；是否转绿本次未运行，未核实通过结果 |
| E06 绑定工具无宿主检查即可执行 | `REV/review-E06.md` F2 | P2 | `packages/agent-core/src/runtime.ts:95-96` 缺 `assertBinding` 时抛错并阻止 |
| E08 Windows 扫描遇到任一重解析点整体失败 | `REV/review-E08.md` F1 | P1 | `R/paths/windows.rs:127-157` 现在先返回 `alias: true` 供扫描跳过（代码层面；Windows 未执行） |
| E08 不支持卷的错误无作用域消息 | `REV/review-E08.md` F2 | P1 | `R/desktop_media.rs:715` 已将 `nativeFilesystem` 映射到 NTFS 文案，且有测试（`:1551-1552`） |
| E08 Windows 无 Job Object；先哈希后按路径执行 | `REV/review-E08.md` F3/F4 | P2 | `R/desktop_media_process.rs` 已有 `TerminateJobObject`；`media_decoder.rs:112-135` 把校验过的字节写入应用私有副本并执行该副本（Windows 路径未执行） |
| E10 OAuth 回环被单个坏连接中止 | `REV/review-E10.md` F1 | P2 | `R/mcp/oauth.rs` 现在多处 `continue`（行 556-614），提交 `869e47a3` |
| E10 stdio 启动无原生同意；`env_clear` 去掉 PATH/SystemRoot | `REV/review-E10.md` F3/F7 | P2/P3 | `R/mcp/service.rs:34,146-148` 有 `Consent`；`R/mcp/process.rs:23,27` 环境白名单含 `PATH`、`SystemRoot` |
| E10 30s/65s 长调用与 discovery 私有主机 | `REV/review-E10.md` F2/F4 | P2 | 仅依据提交信息（"streaming call deadline"、"discovery host checks"），代码未逐项核对：未核实 |
| E02 重试丢失 `modelMetadata` | `REV/review-E02.md` P2-1 | P2 | `agentExecutionService.ts:213,236` 已携带 |
| E02 `uncertain` 无出口；E05 未知创建无出口；E01 选择控件无基线；E16 `onCloseAutoFocus` 无兜底；E05 导入队列卸载丢失 | 各 `REV/review-E0x.md` P2 | P2 | 提交 `50ac64c8`（31 个文件含测试：`agentExecutionService.test.ts`、`e01ShotSelection.test.ts`、`e05MaterialImport.test.ts`、`e16BatchDetailHandoff.test.ts` 等）；仅依据提交内容，未运行测试 |
| E07 分页重读、清除未释放槽位、非 running 运行遗留 job | `REV/review-E07.md` F2/F3/F7 | P2 | 提交信息"bound E07 readback and clear"；`recoverAgentJobs` 细节未逐行核对：未核实 |
| E09 浏览器导入过滤与原生不一致；修订额度无补救；Windows 占位文件 | `REV/review-E09.md` F1-F3 | P2 | 提交 `026cffc9`（`browserImport.ts`、`skills/commands/history.ts`、`InstalledSkillsPanel.tsx`、`skill_import.rs`） |
| E04 PRD AC1 与代码漂移（离开前确认被 E11 移除） | `REV/review-E04.md` P2-1 | P2 | 提交 `b50b811c` 在归档 PRD 里记录漂移；未恢复行为（设计上已移除） |
| 上下文用量不准、自动压缩 | `ARCH/10-16-context-usage-compaction` | 无标注 | 提交 `d8100735`；该任务 PRD 复选框未勾选，不属于本清单的未修项 |

## 4. 无法在 `FIX` 之外确认的两条台账事实

- `FIX/prd.md` 第 15 项（E08/E10/E11 的 `task.json` 状态与提交列表修正）：`ARCH/10-15-agent-background-host/task.json` 仍是 `"status": "completed"`，但带 `meta.deliveryState = "source-complete-pending-epic-acceptance"`；`REV/review-E11.md` 指出 `commit` 只列了 4 个提交中的最后一个（`7fb1b3c0`）。对该字段是否被改过：未核实。
- Windows、安装态 macOS、真实 Keychain/浏览器 OAuth 的验收（E08/E10/E11）按 `FIX/prd.md` 范围外条款留给 owner；journal-2 Session 89 记录"最终检查由用户完成"，没有结果记录。

## 5. 来源与未覆盖范围

- 已读：`FIX/{prd,implement,design}.md`、`FIX/research/deferred.md`、`UX/{prd,implement}.md`、`UX/research/deferred.md`、`REV/review-summary.md`、`REV/review-E01~E11,E16`（P1/P2/P3 段，E06-E10 为节选标题行与前段，未通读全文）、`10-13-agent-experience-overhaul/research/code-defect-audit.md`（S4/S6 行）、journal-1/journal-2 的 Next Steps 与 Session 60/89 摘要。
- 未覆盖：`ARCH/` 下 2026-09 与 10-10~10-15 其余任务的遗留项；journal-1 中 Session 35/36（全盘审查与修复）里 F01-F03 之外的遗留；`.trellis/spec` 里的已知限制章节。
- 未执行：任何测试、构建、Rust 编译。「已修」只来自提交内容与代码抽查，不等于测试通过。
