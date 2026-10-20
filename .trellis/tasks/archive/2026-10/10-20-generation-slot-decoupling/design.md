# 生成与槽位解耦：设计

路径相对 `packages/studio/src/features/`。【读码确认】= 已读代码；【未核实】= 实现该步前再读。

## 1. 方案选择

`ProductionTarget`（`video/models/production.ts`）被约 30 个文件使用：任务、批次条目、选择（`targetKey`）、冲突检测（`baseRevision`）、应用、恢复、证据、UI 跳转。把 `target` 改成可选会让每个消费者都多一个分支。

**选定：新增一种 target——`library`，而不是去掉 target。**

```ts
| { kind: "library"; projectId: Id; entityId: Id; slot: "image" | "video"; label?: string }
```

- `entityId` 是一次生成请求自己的标识（runtime 生成，agent 可不传），所以每个无槽位候选在批次里自成一个「目标」：选择=「采用这一张入库」，没被选的结果仍按现有规则保留在任务历史里。
- `slot` 在这里是媒体类型（图/视频），解决「没有槽位就推断不出图/视频」的问题；视频不再只限镜头 `clip`。
- 现有基线/批次/任务/恢复/证据的结构不变，只在「读目标」「应用」「跳转」三处对 `library` 分支。绑槽位的路径一行不改。

不选「target 可选」：消费者分支多、`targetKey`、`generationEntityKey` 等都假定存在。不选「新建一套无槽位任务类型」：要复制提交、轮询、恢复、批次整套。

## 2. 改动点

### 2.1 目标与校验
- `production.ts`：`ProductionTarget` 加 `library` 变体。
- `productionRevision.ts` `validateProductionTarget`：`library` 要求 `projectId`、`entityId`、`slot ∈ {image, video}`，不要求实体存在。
- `generationProfiles.ts`：`targetSpec` 允许 `kind: "library"`；`entityId` 对 library 可省（在 `submit`/`prepare` 入口补一个新 id）；`slot` 的 json 描述加上 image/video；`profileRequest` 的 `kind` 推断改为：library 取 `slot`，其他沿用。`submitProperties.target.required` 去掉 `entityId`（仅 library 可省，由 zod 校验把关）。
- `agentGenerationBatch.ts`：`generationKind`、`generationTargetKey`、`generationEntityKey` 覆盖 library；「同批候选必须属于同一项目或素材库」沿用。

### 2.2 读目标与冲突检测
- `agentGenerationTarget.ts` `readGenerationTarget`：`library` 返回虚拟目标 `{entity: undefined 的占位, slot: emptySlot(), revision: 常量 "library", label: target.label ?? "素材库"}`；项目存在性仍校验（`studio` 伪项目也允许，对应工作室素材库，【未核实】工作室范围是否要在本任务开放——默认只开放项目范围，`studio` 报错）。
- `generationPreparation.ts` 快照/指纹：library 不读实体表；引用素材的项目归属校验沿用。
- `generationIntent.ts`、`generationRuntime.ts:200` 提交前的「目标已变」复检：library 恒不变。

### 2.3 应用（落库）
- 单张：`generationRuntime.ts` `prepareGenerationApply`/`applyAgentGeneration` 对 library 分支：不写槽位，改为「把生成媒体加入项目素材库」。
- 批量：`agentGenerationBatches.ts` 应用选择处（约 399–490 行）对 library 同样分支，**不**走 `set*Slot`、不记槽位级撤销。
- 共同的落库函数 `adoptGenerationIntoLibrary(job, store)`（放在 `library/commands/materials.ts` 旁）：复用 `promoteLegacyMaterial('media', job.result.mediaId, {kind:"project", projectId})`，在同一事务里把素材名设为 `label` 或提示词前缀、写 `source`（来源=生成任务 id/模型）、置 `media.libraryRetained = true`。幂等：同一 jobId 重复应用不新增（用 `source` 判重）。【未核实】`MaterialScope` 的项目范围形状与 `source` 字段形状。
- 状态：任务照常 `downloaded → applied`；`applied` 的含义对 library 是「已入库」。

### 2.4 指派（事后）
- `slot_update(result=媒体 ID)`、`project_update.coverMediaId`：已存在，要求媒体同项目——素材库素材的底层媒体仍是项目媒体，**无需改**。需要的是让 agent 拿到媒体 ID：`material_read` 是否返回底层 `mediaId`【未核实】；不返回则加上。
- IP 头像：`IpProfile` 加 `avatarMediaId?: Id`；`ip_update` 增加 `avatarMediaId` 参数（校验：图片 MIME、媒体存在；媒体归属见 §2.5）。

### 2.5 IP 头像的媒体归属
IP 不属于单一项目，`MediaRecord.projectId` 必填。【未核实】两条路：
- A. 头像媒体归属 `studio` 伪项目（`STUDIO_LIBRARY_ID`，已是共享归属者），设置时用 `copyMediaDependencies` 复制进去。
- B. 保留原项目媒体并加引用保护。
默认 A：和现有「跨项目靠复制」的规则一致，删项目不会让 IP 头像失效。

### 2.6 数据与迁移
- `IpProfile.avatarMediaId` 新增可选字段：`platform/storage/schema.ts`/`schema.json`、备份导入导出、`collectMediaIds`（头像媒体算「在用」，避免被清理）都要同步。可选字段不需要迁移旧数据，但 schema 校验与 parser 要接受。【未核实】存储版本是否要 +1。
- 已有任务/批次数据只含旧 kind，不受影响。

### 2.7 UI
- IP 编辑面板（刚迁到 `SidePanel`）加头像：上传/从项目媒体选择；IP 列表与详情显示头像。
- 素材库卡片显示来源「生成」。
- 批量审阅面板与输入框批量行：条目标签对 library 显示「素材库 · 图片/视频」，不跳槽位详情；`generationTargetHref`/`generationTargetDestination` 对 library 返回素材库页。
- 任务证据/追踪文案（`taskEvidence.ts`、`AgentRunDetails`）对 library 不显示槽位名。

### 2.8 工具与技能
- `generationTools.ts` 的描述：说明可以 `target.kind="library"`；`submit_generation`/`prepare_generation_batch` 的指令同步。
- `skills.ts` `media-generation` 技能说明：不绑槽位时用 library，结果进素材库，再用 `slot_update`/`project_update`/`ip_update` 指派；封面与头像怎么设。

## 3. 风险
| 风险 | 对策 |
| --- | --- |
| 漏掉某个消费者对 `target.slot`/`entityId` 的假设 | TypeScript 联合类型让编译器列出所有未处理分支；每处显式 `library` 分支，不用 default 吞 |
| 无槽位候选在批次里「选择」语义怪（每个候选自成一组） | 审阅面板对 library 条目显示为「加入素材库」勾选；批次层仍是 selection 机制，不改 |
| 重复应用产生重复素材 | 以 jobId 在素材 `source` 判重，加测试 |
| 付费前确认被绕过 | `submit_generation` 的 `requiresConfirmation` 不变；library 也走确认与批次审阅 |
| IP 头像媒体被清理 | 纳入 `collectMediaIds`，加测试 |
| 存储 schema 变更 | 只加可选字段；同步 schema.json 与导入导出测试 |

## 4. 兼容与回滚
绑槽位的调用与历史数据不变；新增变体只在新路径出现。回滚=revert 提交；IP 头像字段若已有数据，回滚后字段被忽略（可选字段）。

## 5. 默认值（不同意可改）
- D1 library 目标应用也需要用户确认（沿用 `apply_generation` 的确认），不自动入库。
- D2 工作室范围（`studio`）暂不支持无槽位生成，只做项目范围。
- D3 素材名默认取 `label`，否则取提示词前 24 字。
- D4 头像媒体归属 `studio` 并复制（§2.5 A）。
