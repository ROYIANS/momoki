# 生成能力与槽位绑定现状

来源：调研子 agent 报告（主会话落盘）。路径相对 `packages/studio/src/features/`。只读代码，未运行验证。

## 结论摘要

- 所有图片/视频生成工具都强制要求槽位。`submit_generation` 与 `prepare_generation_batch` 必须带 `target{kind, projectId, entityId, slot}`，缺槽位会抛 `生成目标必须指定素材槽位`（`video/agent/generationProfiles.ts:93`）。
- 图片/视频没有「自由生成」路径。每个任务都绑定 target（`AgentGenerationJob.target: ProductionTarget`），结尾用 `apply_generation` 写回该槽位。
- 音频、音乐不绑槽位：结果是项目级 `AudioTake` / `MusicWork`，`segmentId` 可选。这是现成的「无槽位」参照模式。
- 没有手动「生成」UI：provider 的提交函数只被 `video/agent/generationRuntime.ts` 调用，手动路径只有上传、选已有、提升到素材库。
- 项目封面：手动（`WorkspaceChrome` 上传）和 AI（`project_update` 的 `coverMediaId`）都有，但 AI 只能指向「该项目媒体表里已有的图片」，没有任何 AI 工具能先生成一张自由图片再设为封面。
- IP 档案没有图片字段，`IpProfile.visual` 只是文本。

## a) Agent 工具目录中的生成类工具

图片/视频（skill `media-generation`，`agent/runtime/skills.ts:89-94`）：

| 工具 | 位置 | 是否必须槽位 |
|---|---|---|
| `prepare_generation_batch` | `video/agent/generationTools.ts:47` | 是。每个候选用 `generationSubmitSchema`，`target` 必填；最多 20 个候选、每槽位 4 个；只存草稿，需用户在批次面板确认并选择 |
| `read_generation_batch` / `generation_capabilities` / `check_generation` / `list_generation_jobs` | `generationTools.ts:62/101/160/181` | 否（读取类） |
| `submit_generation` | `generationTools.ts:139` | 是。`required: ["connectorId","model","target","prompt"]`；`target` 需 `kind`（shot/character/scene/prop/style）、`projectId`、`entityId`、`slot`（`generationProfiles.ts:56-61`） |
| `apply_generation` | `generationTools.ts:172` | 只能写回原 target 槽位 |

- 槽位校验：`validateProductionTarget`（`video/models/productionRevision.ts:5-25`）。镜头 `slot` 在类型上可选，但 `readGenerationTarget`（`agent/commands/agentGenerationTarget.ts:40`）与 `profileRequest` 缺失时会抛错。
- 图/视频由 target 推断（`generationProfiles.ts:94`）：`kind = target.kind==="shot" && slot==="clip" ? "video" : "image"`。视频只能生成到镜头的 `clip` 槽位。
- `projectId:"studio"` 可作为 target（`agentGenerationTarget.ts:38`），但只限工作室自己的角色/场景/道具/风格槽位。

音频/音乐（`audio/agent/*`、`music/agent/*`）：

| 工具 | 位置 | 绑定 |
|---|---|---|
| `audio_generate_speech` | `audio/agent/audioGenerationTools.ts:320` | 需要项目（默认线程绑定项目）；`segmentId`、`speakerId` 可选 |
| `music_generate` | `audioGenerationTools.ts:246` | 需要已保存草稿（`draftId` + `draftRevision`），结果为 `MusicWork`，不绑槽位 |
| `prepare_audio_generation_batch` | `audio/agent/audioBatchTools.ts:55` | 需要 `chapterId` 与 1–20 个 `segmentIds` |

其他相关工具：

- `slot_update`（`video/agent/businessTools.ts:986`）：给角色/场景/道具/风格/镜头槽位设置提示词、参考或 `result`（已有媒体 ID），不能创建媒体。
- `project_update`：接受 `coverMediaId`。
- 素材库工具（`library/agent/materialToolNames.ts`）：`material_search/read/read_text/read_image/update_metadata/promote/use/update_use/archive/release`，没有一个能生成或导入原始字节；`material_promote` 只是把已有媒体或设定复制进素材范围（global/ip/project）。
- `desktop_media_scan/read/import/status`：仅桌面端，导入本地视频。

## b) 生成结果去向

- 任务流程：`submitAgentGeneration`（`video/agent/generationRuntime.ts`）调用 provider 并轮询 → `storeGenerationMedia`（`agent/commands/agentGeneration.ts:71-89`）把 `MediaRecord` 写入 `db.media`（`projectId` 等于任务的 `projectId`），任务状态变 `downloaded` → `applyAgentGeneration`（`generationRuntime.ts` 约 495–540 行）经 `setCharacterSlot/setSceneSlot/setPropSlot/setStyleSlot/setShotSlot` 写入槽位；目标版本不一致则标 `conflict`。
- 模型：`MediaRecord`（`library/models/media.ts:17-29`）有 `projectId`、`mimeType`、`filename`、`blob`，可选 `libraryRetained`、`thumbnailMediaId`、`derivative`、`source`。`collectMediaIds`（`library/commands/media.ts:28-69`）把「被槽位、封面、`projectReferences`、`materialUses`、音频表引用，或 `libraryRetained===true`」的媒体算作在用。
- 历史保留：`collectHistoryMediaIds`（`media.ts:92`）会保留被生成任务结果和批次应用引用的媒体，所以未应用的结果不会被孤儿清理删掉，但它不在素材库里。
- 没有自由路径：没有任何工具、命令或模型能把生成任务结果变成 `LibraryMaterial` 或保留媒体。`libraryRetained:true` 只有两个写入方：`library/commands/materials.ts:352-374`（把素材采纳进项目）和桌面导入。`createFileMaterial(file, scope)`（`materials.ts:189`）收 `File`，没有对应的 agent 工具。
- 素材库模型：`LibraryMaterial` 有 `kind`（image/video/audio/document/character/scene/prop/style）、`scope`（global/ip/project）、`revision`、`tags`、`notes`、可选 `source`，以及 `file` 或 `setting` 两种 `MaterialVersion` 载荷（`library/models/materials.ts`）。素材来自手动上传，或把项目媒体/设定提升（`promoteLegacyMaterial`）。
- `MediaPicker`（`library/ui/MediaPicker.tsx`）只列出 `projectId` 等于当前项目的媒体（`MediaPicker.tsx:20`、`mediaPicker.ts:reusableMedia`）；`assertSlotMedia`（`library/commands/media.ts:146-162`）拒绝 `projectId` 与槽位项目不同的媒体。
- 音频/音乐结果进 `audioTakes`、`musicWorks`，带 `mediaId` 与 `provenance`，任务在 `audioGenerationJobs`，与槽位无关。

## c) 槽位清单

| 槽位（字段） | 手动设置 | AI 设置 | 备注 |
|---|---|---|---|
| 项目封面 `Project.coverMediaId`（`projects/models/project.ts:31`） | 是：`app/workspace/WorkspaceChrome.tsx:296-310` 上传/清除 | 部分：`project_update` 的 `coverMediaId`（`businessTools.ts:613-631`） | AI 只能提供该项目内已有图片媒体 ID（`size>0`），不能生成或上传；参考模式下设置封面是 `unsupported()`（`workspaceRepository.tsx:465`） |
| 项目封面回退 | 自动 | — | 未设置时取首个镜头的 `firstFrame.result`（`projects/queries/studioLibraryQueries.ts:6-21`） |
| 镜头 `firstFrame`、`lastFrame`（图） | 是 | 是：`submit_generation`、批次、`slot_update` | 需要镜头 `entityId` 与 `episodeId` |
| 镜头 `clip`（图或视频） | 是 | 是（唯一可生视频的槽位） | `library/models/slot.ts:103` |
| 角色 `front/side/back/expression/costume` | 是 | 是 | `library/models/slots.ts:30` |
| 场景 `wide/medium/detail` | 是 | 是 | |
| 道具 `hero/detail/worn` | 是 | 是 | |
| 风格 `look/light/lens` | 是 | 是 | |
| 各槽位 `referenceImageIds/referenceVideoIds` | 是 | 是（`slot_update`） | |
| 项目参考图 `projectReferences` | 是 | 只能搜索/读取/发现（`references/agent/referenceTools.ts`） | |
| IP 档案图片/头像 | 无此字段 | 无 | `IpProfile`（`library/models/materials.ts:4-17`）只有文本字段，没有 `avatarMediaId` |
| 剧集/节拍图片 | 无此字段 | 无 | grep 未发现 |
| 音频说话人 `mimo.referenceMediaId` | 是 | 工具参数可传项目内 WAV/MP3 媒体 ID | 不是图片槽位 |
| 音频 take / 音乐作品 `mediaId` | 是（上传） | 是（`audio_generate_speech`、`music_generate`） | 项目级，不绑槽位 |

说明：「AI 设置=是」仅指通过「绑槽位的生成」或「指向已存在的媒体 ID」。手动列对镜头和资产行来自对上传路径（`uploadMediaFile`、`MediaPicker`）的追踪，没有逐个读详情页。

## d) Provider 与批量入口

- 图片：APIMart（`gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`、`gpt-image-2.5-ext`；比例尺寸、1k/2k/4k，2.5 系列带 quality；最多 15 张参考图）、AIHubMix（仅 `gpt-image-2`）。定义在 `video/models/generationCapabilities.ts:29-110`。
- 视频：APIMart `MiniMax-H3`（文本/首尾帧/参考三种模式，768P 或 2K，4–15 秒，最多 9 张参考图，无参考视频）；AIHubMix `veo-3.1-fast-generate-preview`（最多 3 张参考图、1 个参考视频）。代码在 `video/providers/apimart.ts`、`aihubmix.ts`。
- 音频/音乐：MiMo 语音（`audio/providers/mimoSpeech.ts`）；APIMart 语音 `gpt-4o-mini-tts` 与音乐 flowmusic、suno v6/v6-wild/v6-mini（`audio/providers/apimartAudio.ts`）。
- 连接器：`generation_capabilities` 只读 `db.connectors` 中的 `apimart` 与 `aihubmix`；推荐依据 `settings/commands/generationPreferences`、`Project.generationDefaults`、`video/agent/generationSelection.ts`。
- 批量入口：Agent 的 `prepare_generation_batch`（审阅 UI 在 `agent/ui/AgentGenerationBatches.tsx`，持久化在 `agent/commands/agentGenerationBatches.ts`）与 `prepare_audio_generation_batch`；图片/视频没有非 Agent 的批量入口。
- 确认：`submit_generation` 为 `requiresConfirmation: true`（`generationTools.ts:145`）；批次要在面板中确认。

## e) 「先生成进资源库，之后再指派」的改动点

以下是当前代码的约束点，不是设计方案。

1. 目标类型：`ProductionTarget`（`video/models/production.ts:5-10`）是五种 kind 的联合，每种都带槽位；`AgentGenerationJob.target`、`GenerationIntent.target`、`ProductionProposal.target`、`AgentGenerationBatchItem.baseline.target` 都用它，批次代码里的 `targetKey` 与选择逻辑依赖它。无 target 的任务意味着放宽该类型或新增第二种任务类型。
2. 校验与 schema：`targetSpec`、`submitProperties.target.required`（`generationProfiles.ts:19-22,56-61`）；`validateProductionTarget`；`validateGenerationIntent`（`generationIntent.ts` 约 60 行）；`profileRequest`（`generationProfiles.ts:93`）；`readGenerationTarget`；`prepareGenerationSnapshot`（`video/agent/generationPreparation.ts`）；以及由 target 推断图/视频的逻辑，没有 target 就没有 kind 来源。
3. 应用步骤：`applyAgentGeneration` / `prepareGenerationApply` 依赖 `readGenerationTarget` 与 `set*Slot`，冲突检测依赖 target 的 `baseRevision`、`sourceRevisions`；无目的地的任务没有基线可比。
4. 媒体归属：`MediaRecord.projectId` 必填，`assertSlotMedia` 与封面设置器要求媒体项目与槽位项目一致；`storeGenerationMedia` 要求 `media.projectId === job.projectId`；跨项目靠复制（`copyMediaDependencies`，`library/commands/media.ts:13`）或 `material_use` / `adoptMaterialInProject`；`"studio"` 伪项目（`STUDIO_LIBRARY_ID`）已经是共享归属者。
5. 素材库侧：已有挂钩 `MediaRecord.libraryRetained`（注释：「在挂到槽位之前就显式被素材库采纳而保留」，`media.ts:18`）、`LibraryMaterial`、`promoteLegacyMaterial('media', id, scope)`；`file` 载荷要求 `blob` 与 `filename`；素材工具没有「从生成结果创建」的入口。
6. 技能与工具白名单：`skills.ts:89-94`（`media-generation`）、`BUSINESS_TOOL_GROUPS.assets`（`businessToolNames.ts`）里的 `slot_update`、素材技能（约 108 行）里的 `material_*`。
7. 事后指派到槽位或封面：`slot_update`（`businessTools.ts:986-1060`）用 `result` 传媒体 ID，已由 `assertSlotMedia` 校验（同项目、非空、MIME 匹配）；`project_update.coverMediaId` 同样校验归属；视频结果只允许镜头 `clip`（`businessTools.ts:998`）；`slot_update` 绕过批次选择只靠指令约束；`MediaPicker` 只列项目范围媒体。
8. 追踪：`taskEvidence.ts`、`agent/ui/AgentRunDetails.tsx` 引用 `submit_generation` / `prepare_generation_batch`；`agentToolRecovery.ts`、`agentTools.ts` 也引用生成工具；`submit_generation` 的 `recovery:"generation"` 把恢复绑到任务上。
9. 音频/音乐已经是无绑定模型（项目级 take 或 work，`segmentId` 可选），是最接近的现成模式。

## 未覆盖 / 不确定

- 没读 `.trellis/spec/` 里的生成相关契约。
- `StyleDetailPage`、`ShotDetailPanel` 等页面除 `GenerationSlotCard` / `MediaPicker` 外是否还有手动媒体入口，未逐个核实。
- 没看 `apps/web`、`apps/desktop` 里的生成代码；grep `generate_image` / `generateImage` 等只命中 `video/providers/apimart.ts`。
