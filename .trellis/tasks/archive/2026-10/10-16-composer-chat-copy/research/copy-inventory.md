# Research: composer and chat copy inventory

- **Query**: Inventory leftover tutorial copy, decorative status, and internal-phase wording on the composer and chat surfaces, so they can be deleted the way Cursor does. Do not propose replacement helper copy.
- **Scope**: internal. `packages/studio/src/features/agent/ui` and the CSS beside those files. Judgment uses `.trellis/spec/frontend/interaction-feedback.md` and the child task `10-16-composer-chat-copy`.
- **Date**: 2026-10-16

Line numbers are from the working tree after this session’s composer edits. Strings already gone are listed under Caveats and are not in the Remove table.

Rule used: a sentence goes in Remove when it restates the control, explains an automatic save or retention, or names an internal phase. Keep is one short line only when the user must act (error, empty search, blocked control, or the accessible name of an icon).

## Already absent (do not delete again)

Confirmed missing from the current source:

- FloatingComposer attachment sentence 「发送后，所选图片及文档提取文字将分享给当前模型；超长内容按上下文预算读取。」
- Plus secondary page titles, the sheet caption 「当前对话」, parameter helper paragraphs, and 「设置自动保存」.
- A running composer card. `ComposerCards` kinds are `decision` and `problem` only.
- Context-footer compress and details are icon buttons (`aria-label` only).

Still present, despite the session note that it was removed: plus-home hint `` `${enabledCount} 项已启用` `` at `AgentControls.tsx:328`. It is in Remove.

## Findings

### Files Found

| File Path | Description |
|---|---|
| `packages/studio/src/features/agent/ui/FloatingComposer.tsx` | Mode menu, placeholders, import dialog, import phase line, model warning host |
| `packages/studio/src/features/agent/ui/AgentControls.tsx` | Permission chip and menu, plus home, skills and MCP sheets |
| `packages/studio/src/features/agent/ui/ContextParameters.tsx` | Parameter sheet |
| `packages/studio/src/features/agent/ui/ContextUsagePanel.tsx` | Context meter, details, compact footer |
| `packages/studio/src/features/agent/ui/ContextCompactionDetails.tsx` | Compaction disclosure inside the meter |
| `packages/studio/src/features/agent/ui/ComposerCards.tsx` | Decision and attention-error cards |
| `packages/studio/src/features/agent/ui/ComposerNotice.tsx` | Turn-problem bubble; copy comes from `models/turnProblem.ts` |
| `packages/studio/src/features/agent/ui/ReferenceLibrary.tsx` | Project library dialog |
| `packages/studio/src/features/agent/ui/ReferenceAttachments.tsx` | Chips, source dialog, request-coverage notes |
| `packages/studio/src/features/agent/ui/TopicSidebar.tsx` | Sidebar empty line; status words from `statusCopy.ts` |
| `packages/studio/src/features/agent/ui/MessageList.tsx` | Stream footer, speed tooltip, bare stop marker |
| `packages/studio/src/features/agent/ui/AgentRunDetails.tsx` | Tool-row status words and resume labels |
| `packages/studio/src/features/agent/ui/AgentChatPage.tsx` | Turn-status footer and no-connector empty state |
| `packages/studio/src/features/agent/ui/AgentJobReport.tsx` | Job text inside a tool row |
| `packages/studio/src/features/agent/ui/AgentDesktopMediaReport.tsx` | Import text inside a tool row |
| `packages/studio/src/features/agent/presentation/thinkingTitle.ts` | Thinking fold title |
| `packages/studio/src/features/settings/models/chatModelPolicy.ts` | `modelWarning` string rendered in the composer |

CSS next to these files has no user-facing copy (`content: ""` only).

### 1. Remove

| String | File:line | Why it is decorative |
|---|---|---|
| `聊天并调用已启用的工具` | `FloatingComposer.tsx:71` | Restates the Agent mode name. |
| `围绕目标规划步骤，追踪进度与成果` | `FloatingComposer.tsx:77` | Restates the 任务 mode name. |
| `资料保存在所选项目中；你的消息草稿会保留。` | `FloatingComposer.tsx:323` | Explains automatic save under the project picker. The locked branch on the same line stays (blocked). |
| `支持 JPEG / PNG / WebP（10 MB）、TXT / MD（5 MB）、PDF / DOCX（20 MB），每次最多 10 个文件。导入仅在本地解析。` | `FloatingComposer.tsx:325-326` | Always-on limit tutorial. |
| `正在本地导入与解析…` | `FloatingComposer.tsx:338` | Names the import phase. The spinner is already on the row. `job.error` stays. |
| `描述你想完成的事，与助手一起明确需求…` | `FloatingComposer.tsx:350` | Tutorial placeholder for task mode. |
| `先选择项目，再描述你想完成的事…` | `FloatingComposer.tsx:350` | Restates the project picker. |
| `编辑业务数据或使用互联网工具前询问` | `AgentControls.tsx:38` | Sentence under the 请求批准 choice. |
| `常规操作自动执行，高风险操作和付费生成询问` | `AgentControls.tsx:39` | Sentence under 帮我批准. |
| `自主执行已启用工具，付费生成仍需确认配置` | `AgentControls.tsx:40` | Sentence under 完全访问. |
| `助手权限` | `AgentControls.tsx:114` | Menu heading that restates the permission chip. |
| `权限已更新，对新执行生效` | `AgentControls.tsx:110` | Success toast after the chip already shows the new mode. |
| `正在保存…` | `AgentControls.tsx:117` | Save-phase caption. The trigger already sets `aria-busy`. |
| `对新执行生效。普通对话和计划保存无需批准。` | `AgentControls.tsx:117` | Explains what does not need approval. |
| `可调用已启用的工具和技能` | `AgentControls.tsx:322` | Restates the 智能 row. |
| `只进行普通对话，不调用工具` | `AgentControls.tsx:323` | Restates the 对话 row. |
| `` `${enabledCount} 项已启用` `` | `AgentControls.tsx:328` | Decorative count on the plus-home 技能 row. Still rendered. |
| `给创作一个空间` | `ProjectPicker.tsx:104` | Tutorial title in the composer’s new-project step. |
| `先起一个名字，创作设定可以稍后补充。` | `ProjectPicker.tsx:104` | Tutorial under that title. |
| `还没有项目，先为这次创作起个名字。` | `ProjectPicker.tsx:145` | Tutorial empty state. The no-match line stays. |
| `正在压缩…` | `ContextUsagePanel.tsx:234` | Names the compact phase. Cancel is already the icon. |
| `压缩前后的请求大小（估算）` | `ContextUsagePanel.tsx:238` | Tooltip that restates the `before → after` numbers. |
| `当前执行的已保存上下文` / `下次发送，包含当前草稿` · `{toolCount} 个工具` | `ContextUsagePanel.tsx:271` | Restates the open meter. |
| `历史上限 {n} 条` / `历史不限条数` · `已选 {n} 条` | `ContextUsagePanel.tsx:272` | Restates the history switch. |
| `上限 {tokens} · {source} · 输出预留 {n} · 输入预算 {n}` | `ContextUsagePanel.tsx:273` | Internal budget mechanics. |
| `上限未知，可在对话参数中设置本地预算` | `ContextUsagePanel.tsx:273` | Points at another control. |
| `基于最近一次实际输入 {n}，加新增内容估算` | `ContextUsagePanel.tsx:274` | Names the estimate method. |
| `按文本长度估算，发送后以供应商用量校准` | `ContextUsagePanel.tsx:274` | Names the estimate method. |
| `项目 {name} · 分集 {a}/{b} · 资产 {a}/{b}` | `ContextUsagePanel.tsx:275` | Internal coverage counts. |
| `参考资料 {n} 份，仅含本次准备的范围` | `ContextUsagePanel.tsx:277` | Restates the attached chips. |
| `正在读取上下文…` | `ContextUsagePanel.tsx:292` | Read-phase caption. The error branch on the same line stays. |
| `估算` | `ContextUsagePanel.tsx:302` | Decorative qualifier beside the token total. |
| `正在整理较早的对话` | `ContextCompactionDetails.tsx:10` | Names the compact phase. Same phrase is also the turn footer. |
| `历史已整理` | `ContextCompactionDetails.tsx:10` | Decorative done state. |
| `摘要已保存，约 {before} → {after} tokens；原始消息仍可在对话中查看。` | `ContextCompactionDetails.tsx:13` | Explains the automatic save. |
| `完成后将在下次发送时使用。可随时取消，未完成的摘要不会生效。` | `ContextCompactionDetails.tsx:13` | Restates cancel. |
| `完成后自动接续回复。可通过输入框的停止按钮中断，未完成的摘要不会生效。` | `ContextCompactionDetails.tsx:13` | Restates the stop button. |
| `整理用量：{n} tokens · 与回复用量分开统计` | `ContextCompactionDetails.tsx:15` | Internal accounting. |
| `正在读取参数…` | `ContextParameters.tsx:26` | Read-phase caption. Error branches stay. |
| `已恢复新对话默认参数` | `ContextParameters.tsx:105` | Success toast. The switches already show the values. |
| `已设为新对话默认参数` | `ContextParameters.tsx:109` | Success toast. Same. |
| `此项目的对话共享资料库。只将你选择的资料附加到当前消息。` | `ReferenceLibrary.tsx:99` | Tutorial under the dialog title. |
| `图片 ≤10 MB · TXT / MD ≤5 MB · PDF / DOCX ≤20 MB · 每次最多 10 个` | `ReferenceLibrary.tsx:111` | Always-on limit tutorial. |
| `包括上传和生成的图片。点击附加可让当前模型查看原始图片。` | `ReferenceLibrary.tsx:115` | Restates the attach control. |
| `把创作参考放在这里` | `ReferenceLibrary.tsx:124` | Tutorial empty title. |
| `导入剧本、文档或图片，之后可以在项目的其他对话中复用。` | `ReferenceLibrary.tsx:125` | Tutorial empty paragraph. |
| `已附加到消息` | `ReferenceLibrary.tsx:63` | Success toast. The chip is the result. |
| `解析中` | `ReferenceAttachments.tsx:13` | Import phase on a library row. |
| `可使用` | `ReferenceAttachments.tsx:14` | Restates that the row can be attached. |
| `历史消息中的引用会保留；不可用的资料无法参与新的请求。` | `ReferenceAttachments.tsx:49` | Retention sentence under the read error. |
| `原始图片 · 发送后由所选模型读取` | `ReferenceAttachments.tsx:55` | Restates what send will do. |
| `已提取 {n} 字符 · 处理 {a}/{b} 个来源单元。这里是提取预览，不代表模型已完整阅读。` | `ReferenceAttachments.tsx:55` | Preview tutorial. Warnings on the next lines stay. |
| `原始内容与提取结果` | `ReferenceAttachments.tsx:99` | Restates the dialog title 来源资料. |
| `仅从草稿中移除，项目资料仍保留` | `ReferenceAttachments.tsx:115` | Retention tooltip. The button name is `从消息中移除附件`. |
| `请求资料记录 · {n} 次请求` | `ReferenceAttachments.tsx:140` | Names an internal request ledger. |
| `本轮图片输入（图像 token 为估算）` | `ReferenceAttachments.tsx:147` | Internal token note. |
| `图片来源记录（本轮不含图片像素）` | `ReferenceAttachments.tsx:147` | Internal coverage note. |
| `` `包含 ${included}/${total} 段，${chars} 字符` `` plus ` · 部分内容` | `ReferenceAttachments.tsx:147` | Internal chunk accounting. |
| `{filename} · 本轮图片输入` | `ReferenceAttachments.tsx:169` | Phase label on the image chip. |
| `为本次请求准备的项目图片；不代表请求已经发出。图像 token 用量为估算。` | `ReferenceAttachments.tsx:171-172` | Tutorial in the image dialog. |
| `对话需要先配置 OpenAI 兼容连接（Base URL + API Key）。密钥只保存在本机。` | `AgentChatPage.tsx:460` | Tutorial under 还没有可用的连接. The title and 前往连接 stay. |
| `正在停止…` | `AgentChatPage.tsx:476` | Turn-footer phase. The send control already says 正在停止…. |
| `正在等待回复…` | `AgentChatPage.tsx:477` | Turn-footer phase. |
| `正在整理较早的对话…` | `AgentChatPage.tsx:480` | Turn-footer phase. |
| `正在执行` | `AgentChatPage.tsx:480` | Turn-footer phase. |
| `准备执行` | `AgentRunDetails.tsx:33` | Tool-row phase beside the icon. |
| `已批准，等待执行` | `AgentRunDetails.tsx:33` | Tool-row phase. |
| `执行中` | `AgentRunDetails.tsx:34` | Tool-row phase. The spinner is already the running icon. |
| `进行中` / `进行中 · 已用 {n} 个工具` | `AgentRunDetails.tsx:280` | Running summary names the phase. |
| `进行中` / `待办` | `AgentRunDetails.tsx:308` | Plan-step phase words. |
| `继续执行 · 最多 {MODEL_STEPS_PER_SEGMENT} 轮` | `AgentRunDetails.tsx:316` | Names the internal step budget. No replacement label is proposed. |
| `从已保存的步骤继续` | `AgentRunDetails.tsx:316` | Names the saved-step mechanism. |
| `AI 原始参数` | `AgentRunDetails.tsx:86` | Internal payload label. The fold name 参数与返回结果 stays. |
| `已关联当前对话，可在这里继续创作` | `CreatedEntityLinks.tsx:57` | Restates that the project is already bound. Shown from a tool row. |
| `正在打开…` | `CreatedEntityLinks.tsx:43` | Phase text on the continue button. |
| `生成速度：供应商返回的输出 token ÷ 流式生成耗时（不含工具和审批等待）` | `MessageList.tsx:241` | Tooltip that explains the tok/s figure. |
| `还没有话题，发一条消息开始。` | `TopicSidebar.tsx:196` | Tutorial empty state. The no-match line stays. |
| `已深度思考` / `` `已深度思考 ${(durationMs / 1000).toFixed(1)} 秒` `` | `presentation/thinkingTitle.ts:5-6` | Decorative duration after thinking ends. |
| `暂时无法确认当前连接的模型兼容性，发送时会重新校验。` | `chatModelPolicy.ts:45`, shown at `FloatingComposer.tsx:376` | Probe caption. Unresolved model checks stay quiet. |
| `正在确认…` | `ModelSelectTrigger.tsx:129` | Probe phase inside the opened capability panel. |
| `拉取模型中…` | `ModelSelectTrigger.tsx:254` and `:317` | List-load phase. The no-match and unverified lines stay. |
| `正在检查发送状态…` | `models/turnProblem.ts:51`, shown by `ComposerNotice.tsx:27` | Send-check phase. |
| `正在加载对话…` | `SubmissionMessage.tsx:32` | Load-phase line in the transcript fallback. |
| `加载中…` | `MessageList.tsx:148` | Load-phase line in the stream. |
| `正在停止原 MCP 调用，外部结果未确认。` / `等待当前检查结束，不再开始下一项。` / `正在结束本地网页读取。` | `AgentJobReport.tsx:34` | Stopping-phase sentences on a tool row. |
| `原 MCP 调用已停止，保留已确认的资料。` / `已停止，保留已检查的结果。` / `已停止本地网页读取。` | `AgentJobReport.tsx:35` | Explains automatic retention after stop. |
| `已检查 {completed} / {selected} 项` | `AgentJobReport.tsx:51` | Restates the job counters. |
| `还有 {remaining} 项未检查。` | `AgentJobReport.tsx:55` | Restates the same counters. |
| `服务可能已经执行，不会自动重新请求。` | `AgentJobReport.tsx:57` | Extra sentence under the unknown/failed line. |
| `正在读取报告…` | `AgentJobReport.tsx:84` | Read-phase line. |
| `已导入 {receipts} / {items} 个视频` | `AgentDesktopMediaReport.tsx:31` | Restates the import counters. |
| `等待当前处理结束，不再开始下一项。` | `AgentDesktopMediaReport.tsx:32` | Stopping-phase sentence. |
| `已停止，保留已导入的素材。还有 {remaining} 项未导入。` | `AgentDesktopMediaReport.tsx:33` | Retention sentence plus a repeated count. |
| `导入结果待核对，不会自动重新处理视频。` | `AgentDesktopMediaReport.tsx:35` | Restates the 核对导入结果 button. |
| `` `{project ? 当前项目：${name}。 : 选择项目与模型，描述你的创作需求。}` `` plus the task/agent follow-on sentence | `HomeWelcome.tsx:58` | Tutorial above the home composer. |
| `在上方描述目标启动任务，也可以先到看板手动整理计划。` | `HomeWelcome.tsx:80` | Tutorial empty state. |
| `待开始` / `进行中` / `已完成` / `已归档` / `已停止` | `runtime/taskState.ts:4-5`, drawn on the chat header from `AgentChatPage.tsx:504` | Phase words on the task chip. Action states stay. |
| `正在读取素材…` | `features/library/services/media.ts:120`, shown in reference previews | Read-phase line. The image or the error replaces it. |
| `素材已就绪` | `features/library/services/media.ts:122` | Decorative ready state once the preview is visible. |

Remove count: **99**.

### 2. Keep

| String | File:line | User action it supports |
|---|---|---|
| `请求批准` / `帮我批准` / `完全访问` | `AgentControls.tsx:38-40` | Names of the permission choices. Descriptions above them go. |
| `权限：${selected.title}` | `AgentControls.tsx:120-124` | Accessible name of the permission chip. |
| `读取助手配置失败` / `保存助手设置失败，请重试` | `AgentControls.tsx:52, 67` | Error toast when settings cannot be read or saved. |
| `内置技能设置的保存结果尚未确认，暂时无法再次修改。请重新加载工作区并核对设置后再操作。` | `AgentControls.tsx:245` | Blocked skill toggle after an uncertain write. |
| `内置技能设置保存失败，请重试` | `AgentControls.tsx:246` | Skill-save error. |
| `保存结果尚未确认，请先核对；不要重复提交。` and the reconcile errors in the same hook | `useInstalledSkills.ts:70, 73, 93-95` | Shown by `InstalledSkillMutationNotice` inside the skills sheet. User must refresh or reconcile. |
| `重新查看当前列表` / `核对保存结果` / `刷新技能列表` | `InstalledSkillsPanel.tsx:23-24` | Actions on that sheet error. |
| `没有匹配的技能或操作` | `AgentControls.tsx:299` | Empty plus search. |
| `没有匹配的技能` | `AgentControls.tsx:344` | Empty skills search. |
| `暂无连接` | `AgentControls.tsx:271` | Empty MCP list when `mcp.state.error` is absent. The error string itself stays. |
| `返回` / `搜索技能与操作` / `搜索 MCP…` / `搜索技能…` / `管理` | `AgentControls.tsx:153-157, 264, 276, 332` | Toolbar controls. |
| `更多选项` | `AgentControls.tsx:351-354` | Accessible name of the plus button. |
| `智能` / `对话` / `文件` / `项目资料` / `项目记忆` / `对话参数` / `技能` / `MCP` | `AgentControls.tsx:322-328` | Row names. Hints on 智能, 对话, and 技能 go. |
| `恢复默认` / `设为默认` | `ContextParameters.tsx:106, 109` | Explicit parameter actions. Success toasts go. |
| `自动压缩上下文` / `限制历史消息` / `最多携带` / `条` / `高级预算` / `本地上下文预算` / `采用模型上限` | `ContextParameters.tsx:85-101` | Control labels. |
| `搜索参数` / `搜索参数…` | `ContextParameters.tsx:81` | Search field name. |
| `参数暂时无法读取` / `参数所属对话或助手已不存在` / `保存参数失败，请重试` | `ContextParameters.tsx:21, 28, 64` | Read or save error. |
| `无法压缩` and `execution.error` on the footer | `ContextUsagePanel.tsx:224, 249` | Compact failure. |
| `对话正忙，稍后可压缩` / `发送消息后可压缩` / `请先选择模型` | `ContextUsagePanel.tsx:254-256` | Why the compact icon is disabled. |
| `执行中，结束后可压缩` / `当前范围不可用` | `ContextUsagePanel.tsx:319` | Same, as the compact button title. |
| `当前范围不可用，已保存的上下文仅供查看。` | `ContextUsagePanel.tsx:309` | Blocked meter. |
| `助手配置不存在` / `对话不存在` / `关联项目已不存在` | `ContextUsagePanel.tsx:82-84` | Read error for a missing scope. |
| `已用` / `已用 {percent}` and the grouped row names `系统指令` / `工具` / `对话` / `工具结果` / `记忆与参考` | `ContextUsagePanel.tsx:300`, `runtime/contextUsage.ts:53-57` | The meter the user opened. Not a second sentence. |
| `压缩上下文` / `取消压缩` / `正在取消…` / `详情` / `上下文明细` | `ContextUsagePanel.tsx:242-246, 387-406` | Accessible names of the icon buttons. |
| `项目记忆 · {n} 条` / `查看引用与排除 →` | `ContextUsagePanel.tsx:276` | Opens the memory citation list. |
| `整理已中断` / `整理未完成` | `ContextCompactionDetails.tsx:10` | Compact did not finish. |
| `` `${record.error ?? "原始对话已保留。"}` `` plus the manual or resume retry clause | `ContextCompactionDetails.tsx:13` | How to retry a failed compact. |
| `查看摘要覆盖的原始消息` | `ContextCompactionDetails.tsx:18` | Name of the disclosure. |
| `待办读取失败，请刷新后检查执行记录。` | `ComposerCards.tsx:11, 43` | Attention read error. |
| Decision `title` / `detail` / `action` from `activityAttention.ts:46-96` and `任务待你验收` / `查看` | `composerAttention.ts:64-66` | The card is the thing the user must open. Includes `生成结果待核实`, `待你确认生成`, `批次等待开始`, `批次已暂停`, `操作结果待核实`, `待批准`. |
| `关闭` | `ComposerCards.tsx:24` | Closes a card. |
| Turn reasons other than `正在检查发送状态…`: `发送未确认`, `发送状态待恢复`, `已停止发送`, `消息未发送`, `已暂停`, `执行失败`, `执行已中断`, `执行未完成`, `应用重启后已中断`, `网络中断`, `模型返回错误` | `models/turnProblem.ts:38-41, 53-72, 94` | Shown by `ComposerNotice`. User must check, recover, retry, or continue. |
| `检查` / `确认未发送` / `恢复` / `重试` / `继续` / `关闭提示` | `turnProblem.ts:55-70`, `ComposerNotice.tsx:32` | Those actions. |
| `无法继续此对话` / `重新打开任务后可继续对话` | `AgentChatPage.tsx:568`, `FloatingComposer.tsx:350` | Composer is blocked. |
| `项目不可用` / `新开项目对话` | `AgentChatPage.tsx:536-540` | Blocked thread; the button leaves it. |
| `还没有可用的连接` / `前往连接` / `先整理任务` | `AgentChatPage.tsx:459-465` | Empty connector state. The description sentence goes. |
| `当前模型的能力或接口与聊天不兼容，无法用于对话。请选择聊天模型；已有消息会保留。` | `chatModelPolicy.ts:43`, shown at `FloatingComposer.tsx:376` | Send is blocked. |
| `无法确认模型类型，请切换连接后重试` / `没有匹配的模型` | `ModelSelectTrigger.tsx:254` | Blocked or empty model search. |
| `选择模型` / `搜索模型` / `发送` / `停止` / `正在停止…` (on the send control only) | `ModelSelectTrigger.tsx:216, 225, 353-373` | Control names. The duplicate turn-footer `正在停止…` goes. |
| `推理强度` and the segment labels `默认` / `关闭` / `最低` / `低` / `中` / `高` / `极高` / `最高` | `ModelSettingsMenu.tsx:4, 20`, `reasoningPolicy.ts:58` | The effort control. |
| `Agent` / `任务` / `任务模式` / `Agent 模式` | `FloatingComposer.tsx:70-89` | Mode names. The `<small>` sentences go. |
| `按 Enter 发送` / `Shift + Enter 换行` / `按 ⌘ / Ctrl + Enter 发送` / `Enter 换行` / `发送方式` | `FloatingComposer.tsx:440-459` | The send-key choice. |
| `提问、创建内容或启动任务` / `消息内容` | `FloatingComposer.tsx:350, 353` | Default placeholder and the input name. |
| `当前对话未绑定项目且已开始，请新开一个项目对话导入资料。` | `FloatingComposer.tsx:323` | Import is blocked. |
| `先为资料选择项目` | `FloatingComposer.tsx:323` | Dialog title for the required project choice. |
| `松开以导入参考资料` | `FloatingComposer.tsx:344` | Drop target while dragging. |
| `重试导入 {filename}` / `取消附件 {filename}` | `FloatingComposer.tsx:339-341` | Failed-import actions. `正在本地导入与解析…` goes. |
| `当前浏览器不支持语音输入` / `语音输入失败，请重试` / `无法启动语音输入，请检查浏览器的麦克风权限` / `正在语音输入，请先结束听写再发送。` | `FloatingComposer.tsx:242, 261, 270, 277` | Voice is blocked or failed. |
| `语音输入` / `停止语音输入` / `展开编辑器` / `退出全屏编辑` | `FloatingComposer.tsx:395, 420` | Icon names. |
| `此对话的项目已固定；处理其他项目请新开对话` / `此对话已开始；在项目中工作请新开对话` | `ProjectPicker.tsx:79` | Project picker is locked. |
| `没有找到匹配的项目` | `ProjectPicker.tsx:145` | Empty project search. |
| `项目选择失败` / `创建项目失败` | `ProjectPicker.tsx:43, 61` | Picker errors. |
| `没有匹配的资料` | `ReferenceLibrary.tsx:124` | Empty library search. |
| `项目中还没有图片` | `ReferenceLibrary.tsx:120` | Empty image list. |
| `读取资料库失败` / `读取项目图片失败，请重新打开资料库` / `附加图片失败` / `重新解析失败` / `移除失败` / row `error` | `ReferenceLibrary.tsx:40, 51, 65, 79, 92, 131` | Read, attach, or remove failure. |
| `重试` / `从项目移除这份资料？` / the remove confirmation / `移除资料` / `取消` | `ReferenceLibrary.tsx:122, 148-152` | Destructive confirm and the retry. |
| `搜索项目资料` / `搜索文件名…` / `附加` / `已附加` / `重新解析` / `移除资料` | `ReferenceLibrary.tsx:105-142` | Library controls. |
| `部分解析` / `解析失败` / `已移除` | `ReferenceAttachments.tsx:15-17` | File is incomplete, failed, or gone. |
| `读取资料失败` / `重新读取` / `没有可提取文字的单元：…` / `文件中没有提取到文字。` | `ReferenceAttachments.tsx:35, 48, 58, 69` | Source cannot be read or has no text. |
| `从消息中移除附件` / `已附加的资料` | `ReferenceAttachments.tsx:111, 115` | Chip control names. |
| `原始图片已不可用，历史引用记录仍保留。` | `ReferenceAttachments.tsx:174` | The image for this request is gone. |
| `素材已丢失，请重新导入` / `素材内容已损坏，无法预览` / `读取素材失败，请重新打开后重试` / `没有素材` | `library/services/media.ts:112-118`, shown in reference previews | Preview is blocked. |
| `等待批准` / `已拒绝` / `未确认` | `AgentRunDetails.tsx:33-34` | User must approve, already rejected, or the outcome is unconfirmed. |
| `操作未确认` plus `failure.error` and `failure.recovery` | `AgentRunDetails.tsx:49-51` | Uncertain tool outcome the user must read. |
| `已回滚：` / `未执行：` / `调用失败` and the failure line | `AgentRunDetails.tsx:56-57, 139` | The tool did not run or was rolled back. |
| `批准` / `拒绝` / `高风险操作` / `结束本次执行` | `AgentRunDetails.tsx:142-145, 318` | Approval and stop actions. |
| `用了 {n} 个工具` / `过程记录` / `执行过程` / `执行计划` / `参数与返回结果` / `用户确认的参数` / `返回结果` | `AgentRunDetails.tsx:83-93, 274-304` | Names of folds the user opens. |
| `没有可检查的视频。` | `AgentJobReport.tsx:52` | The check has nothing to inspect. |
| `未能完成，请查看已保留的结果。` / `外部操作未确认。已保留记录，不会自动重新执行。` / `未确认，相关内容暂不可读取。` | `AgentJobReport.tsx:36-37` | Failed or unknown job. User must not resend. |
| `报告读取失败，请重试读取。` / `重试读取报告` / `保留结果已清理。` / `保留报告不可用。` / `报告没有正文内容。` | `AgentJobReport.tsx:80-86` | Report cannot be read. |
| `导入记录不可用，请核对原项目。` / `未能完成导入，已保存的素材仍然保留。` / `无法核对导入结果，请保留这次记录，不要重复导入。` | `AgentDesktopMediaReport.tsx:20, 34, 27` | Import record is blocked. |
| `停止` / `核对导入结果` | `AgentDesktopMediaReport.tsx:39-40` | Those actions. |
| `已停止` / `未完成` | `MessageList.tsx:29-30` | Bare marker when a stopped or empty failed turn has no other text. |
| `复制` / `返回最新` / `对话消息` | `MessageList.tsx:126, 167, 234` | Stream controls. |
| `思考中` | `presentation/thinkingTitle.ts:3`, `ThinkingMatrix.tsx:157` | Accessible name of the live thinking indicator. |
| `运行中` / `需要你批准` / `有未读内容` / `状态读取失败` | `statusCopy.ts:7-13`, announced from `TopicSidebar.tsx:349-350` | Accessible names of the sidebar markers. No extra visible sentence. |
| `没有匹配的话题标题。` | `TopicSidebar.tsx:197` | Empty topic search. |
| `搜索话题标题` / `关闭搜索` / `重命名` / `删除` / `开启新话题` | `TopicSidebar.tsx:137, 150-158, 327-331` | Sidebar controls. |
| `等待批准` / `待确认` / `执行失败` / `已中断` | `runtime/taskState.ts:4-5`, header chip via `AgentChatPage.tsx:504` | Task chip states where the user must approve, confirm, or recover. |

Keep count: **77** rows. Several rows bundle the labels of one control.

### 3. Defer

Outside the composer and chat chrome. Not judged for deletion here.

| Surface | File:line | What is there |
|---|---|---|
| Settings sections | `features/settings/ui/sections/AppearanceSection.tsx`, `StorageSection.tsx`, `UpdateSection.tsx`, `GeneralSection.tsx` | Theme, storage, and update explanations. |
| Connector settings | `features/settings/ui/ConnectorsPage.tsx` | Connection test and save toasts. |
| MCP settings page | `features/agent/mcp/ui/McpConnectionsSettings.tsx:19`, `McpConnectionDetail.tsx:38` | Page description and browser-auth tutorial. The plus MCP sheet is in scope above. |
| Installed-skills settings page | `InstalledSkillsPanel.tsx:116`, `InstalledSkillsContent.tsx:81`, `useInstalledSkills.ts:109` | `技能保存在当前设备…`, version-change hint, and the history-release notice. The error notice reused inside the plus sheet is in Keep. |
| Generation batch review | `AgentGenerationBatches.tsx`, `AgentGenerationResults.tsx`, `GenerationReview.tsx` | Batch warnings, `JOB_LABELS`, and review chrome. Composer cards only deep-link here. |
| Music generation review | `MusicGenerationReview.tsx` | Confirmation panel inside a tool row, owned by the review flow. |
| Audio generation and arrangement | `features/audio/ui/AudioGenerationBatches.tsx`, `AudioArrangementActions.tsx` | Outside agent chat chrome. |
| Task inspector | `TaskInspector.tsx` | Goal editor, step progress, outcome labels. |
| Task board | `TaskBoard.tsx:101` and column hints | Page description and column tutorial. |
| Task wrap-up | `TaskWrapup.tsx` | Acceptance copy and `版本 {revision}`. |
| Memory panels | `MemoryContextDetails.tsx`, `features/memory/ui/ProjectMemoryPage.tsx`, `MemoryEditor.tsx` | Citation and memory-page explanations. The meter’s `查看引用与排除` link stays in Keep. |
| Library and world pages | `AssetTextField.tsx`, `AssetLibraryPage.tsx`, `MaterialDetailPanel.tsx`, `DesktopMediaImportPanel.tsx` | Uncertain-save and import copy off the chat. |
| Desktop media outside the tool row | `features/library/ui/DesktopMediaImportPanel.tsx` | Import panel. The tool-row report is in scope above. |

Defer count: **13** surfaces.

### Related Specs

- `.trellis/spec/frontend/interaction-feedback.md` — quiet success, no preparation caption, one short line only when the user must act.
- `.trellis/tasks/10-16-composer-chat-copy/prd.md` — R2 is this inventory’s scope.
- `.trellis/tasks/10-16-ui-ux-overhaul/research/copy-and-state-audit.md` — earlier pass. Items it listed that are now absent are not repeated above.

## Caveats / Not Found

- `` `${enabledCount} 项已启用` `` is still on the plus home row. The session note treated it as removed.
- `请求结构与续接状态` is built in `ContextUsagePanel.tsx:159` and then folded into the visible row `系统指令` by `summarizeContextRows`. It is not a separate visible string.
- Skill `<small>` text on plus search results is `skill.description` from data, not chrome copy.
- Tool titles, preview summaries, and `failure.error` / `job.error` are runtime text. Only the fixed wrappers around them are listed.
- No browser pass. This is a source inventory.
