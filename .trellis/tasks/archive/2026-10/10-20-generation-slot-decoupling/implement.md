# 生成与槽位解耦：实施计划

一次做完，按功能分段提交（内部分段，不停下来问）。每段：`pnpm lint`、相关测试；收口段跑 `pnpm quality` 与全量测试（原生探针测试在本机失败属环境问题）。

## G1 目标类型与校验
`ProductionTarget.library`、`validateProductionTarget`、`generationProfiles`（schema/`profileRequest`）、`agentGenerationBatch` 的 key/kind 函数。让编译器列出所有未处理分支，逐处补 `library`。测试：校验、schema、批次 key。

## G2 读目标 / 快照 / 提交
`readGenerationTarget`、`generationPreparation`、`generationIntent`、`generationRuntime` 提交前复检；入口补 `entityId`。测试：无槽位 `submit_generation`/`prepare_generation_batch` 通过且缺 kind 报明确错误；绑槽位不变。

## G3 落库与应用
`adoptGenerationIntoLibrary`（幂等、`libraryRetained`、`source`）；单张 apply 与批量 apply 的 library 分支；状态 `applied`。测试：入库、重复应用、媒体不被清理、不写槽位。

## G4 IP 头像
`IpProfile.avatarMediaId`、schema/schema.json、备份导入导出、`collectMediaIds`、`ip_update` 参数、IP 编辑面板上传/选择、列表与详情显示。测试：设置/清除/校验/清理保护/导入导出。

## G5 agent 面与 UI 文案
`material_read` 返回底层 `mediaId`（若缺）、工具与技能说明、批量审阅与批量行对 library 的标签/跳转、素材库「来源：生成」、证据文案。测试：现有 UI 测试更新 + library 条目渲染。

## G6 收口
`pnpm lint`、`pnpm quality`、全量测试；spec 更新（生成契约、IP）；archive。
