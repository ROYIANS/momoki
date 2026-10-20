# 生成与槽位解耦

## Goal

agent 生成图片/视频不再必须绑定一个槽位：结果先进项目素材库，之后可以指派到任意槽位、项目封面、IP 头像，也可以提升到 IP/全局范围。解决「想先出一批图再挑」「AI 没法生成并设置封面」这类用不动的地方。

## Owner 已定（2026-10-20）

- 无槽位生成的结果放**项目素材库**（项目范围的 `LibraryMaterial`），不另造「未分配」池。之后沿用现有的提升/指派路径。
- IP 档案加**一张头像**（`avatarMediaId`），手动和 agent 都能设置；本次不做 IP 多张参考图。
- 批量审阅**先保留**：无槽位的候选同样进批量审阅面板，由用户确认后才付费。审阅体验本身有不顺的地方，owner 说之后还要优化，不在本任务内。
- 一次做完，中间不停下来问；内部按功能分段提交。

## Background（读码确认，见 `../10-19-product-audit-direction/research/generation-slot-binding.md`）

- 所有图片/视频生成工具强制要求 `target{kind,projectId,entityId,slot}`，缺槽位抛错（`generationProfiles.ts`）。图/视频由 target 推断：只有镜头 `clip` 槽位可生视频。
- 结果写回只能经 `applyAgentGeneration` → `set*Slot` 到原槽位；没有任何路径把生成结果变成素材库素材。
- 音频/音乐已是不绑槽位模式（项目级 take/work），可作参照。
- 事后指派已有：`slot_update(result=媒体ID)`、`project_update.coverMediaId`，都校验媒体归属同项目。
- `MediaRecord.libraryRetained`、`LibraryMaterial`、`promoteLegacyMaterial('media', id, scope)` 是现成挂钩。
- IP 档案（`IpProfile`）只有文本字段，没有图片字段。

## Requirements

1. agent 的 `submit_generation` 与 `prepare_generation_batch` 允许不带槽位；无槽位时必须明确 `kind: image | video`（槽位推断不再可用），并仍需用户确认后才提交。
2. 无槽位生成成功后，结果成为当前项目范围的素材库素材（有名称/备注/来源=生成任务），不写任何槽位；任务状态与追踪沿用现有「生成任务」记录。
3. 提供「把素材库里的素材指派到」槽位 / 项目封面 / IP 头像的 agent 路径（复用 `slot_update`、`project_update`，补 IP 头像）；视频仍只能指派到镜头 `clip`。
4. IP 档案新增 `avatarMediaId`：手动在 IP 编辑面板上传/选择；agent 经工具设置；IP 列表/详情显示头像；数据迁移与存储 schema 同步。
5. 素材库界面里能看到这些生成素材，并说明来源是生成；可手动指派/提升。
6. 现有绑槽位的流程（含批量审阅、冲突检测、应用步骤）行为不变，测试不回退。
7. 技能与工具说明同步：`media-generation` 技能说明可以不绑槽位、结果进素材库；封面与头像怎么设。

## Acceptance Criteria

- [ ] 无 target 的 `submit_generation` / `prepare_generation_batch` 通过校验，缺 `kind` 时给出明确错误；绑槽位的调用不变。
- [ ] 无槽位任务完成后产生一条项目范围素材（带来源），媒体不会被孤儿清理删除，不写任何槽位。
- [ ] agent 能把该素材设为项目封面、IP 头像、或指派到槽位；归属/MIME/视频限制校验保持。
- [ ] IP 档案有头像：手动设置、列表与详情显示、备份/恢复与存储 schema 一致。
- [ ] 批量审阅面板能展示并确认无槽位候选；确认前不付费。
- [ ] 新增/更新测试覆盖：校验、生成落库、指派、IP 头像、批量无槽位；`pnpm lint`、`pnpm quality`、全量测试（除原生探针）通过。

## Out of Scope

- 批量审阅体验的优化（owner：之后再做）。
- IP 多张参考图；剧集/节拍图片。
- 视频项目整体重设计；视频模型数量扩展。
- 生成素材跨项目自动共享（需要时用现有提升到 IP/全局）。

## Open Questions

无阻塞项。design.md 里标【未核实】的点在实现前读码确认。
