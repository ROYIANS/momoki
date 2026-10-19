# Research: 业务功能现状与缺口盘点

- **Query**: 从“用户会在哪里卡住”盘点各业务线现状/缺口/卡点/AI 覆盖度，并给出候选方向
- **Scope**: internal（竞品对比为推断）
- **Date**: 2026-10-19
- 标注约定：[证据]=已读代码/README；[推断]=基于对同类 AI 影视工具的了解，未在仓库验证；[未验证]=没有打开运行，只读了代码。
- 说明：本次只做静态阅读（README 功能概览/创作工作流、routes、features/*、docs/），未运行应用，UI 实际顺畅度为从代码结构的判断。

路径前缀：`S=packages/studio/src`。

## 0. 总览：Agent 工具覆盖度（来自 *ToolNames.ts）

| 业务线 | 工具组 | 工具 |
|---|---|---|
| 视频读 | BUSINESS_TOOL_GROUPS.read (`S/features/video/agent/businessToolNames.ts`) | business_search/detail/read_relations/read_text |
| 视频故事 | story | project/episode/beat/shot 的 create/update/delete，creative_duplicate, creative_reorder |
| 视频资产 | assets | character/scene/prop/style CRUD, asset_copy_from_studio, slot_update, media_delete_orphan |
| 视频生成 | `video/agent/generationTools.ts` | generation_capabilities, prepare_generation_batch, submit_generation, check_generation, read_generation_batch, apply_generation, list_generation_jobs；另有 project_media_check |
| 音频 | AUDIO_TOOL_NAMES (`audio/agent/audioMusicToolNames.ts`) | audio_read/create/update, place_take, edit_clip, split_clip, remove_clip, generate_speech, generation_check, prepare_audio_generation_batch, select_takes, arrange_selected, revert_arrangement, read_arrangement |
| 音乐 | MUSIC_TOOL_NAMES | music_read, save_draft, update_work, reuse_work, music_generate, audio_generation_check |
| IP | `library/agent/ipToolNames.ts` | ip_search/read/create/update/set_archived, project_bind_ip |
| 素材 | MATERIAL_TOOL_NAMES | material_search/read/read_text/read_image/update_metadata/promote/use/update_use/archive/release |
| 桌面媒体 | DESKTOP_MEDIA_TOOL_NAMES | desktop_media_scan/read/import/status |
| 记忆/参考/联网 | memory/reference/web | memory_search/read, project_history_search/read, project_reference_search/read, discover/read_project_image, web_search/web_read/read_job_result |

观察：没有“导出/交付”类 Agent 工具（无 export_csv/handoff/project_zip/audio export 对应工具名）；没有项目级“制作进度/缺口汇总”专用工具，仅 project_media_check（`video/agent/mediaCheckTools.ts`）。[证据：工具名清单中无 export 项]

## 1. 视频项目 / 分镜

### 现状 [证据]
- 路由：`S/app/routes/p.$projectId.{world,plan,e.$episodeId.{index,shots,storyboard,produce},assets.*,memory,report}.tsx`。
- 镜头表 12 列（`video/models/columns.ts`：内容/时长/角色/场景/备注/类别/声音/情绪/摄像机角度/装备/焦段/场景特写）；状态 draft→ready→framed→clipped→approved（`video/models/shots.ts`）。
- 镜头图/视频槽：firstFrame/lastFrame/clip（`video/services/productionHandoff.ts` SLOT_LABELS）。
- 生成能力表（`video/models/generationCapabilities.ts`）：图像 GPT Image 2 / 2.5 Flare/Sunburst/Ext（apimart），GPT Image 2（aihubmix）；视频仅 MiniMax H3（apimart）、Veo 3.1 Fast（aihubmix）。
- 制作页：缺口检查（内容/时长/场景/首帧/成片，`ProducePage.tsx` MISSING_LABELS），导出 CSV、可打印分镜板（`StoryboardPrintPage.tsx`）、素材交付包 ZIP（`cuepoint-handoff-v1`）；ProductionProposalsPanel + `commands/proposals.ts` 提供 apply/cancel/undo 提案。
- 键盘/拖拽/筛选/撤销（`ShotEditorPage.tsx` 1337 行、`useShotEditorKeyboard.ts`、`shotEditorCommands.ts`）。

### 缺口
- README 明示不提供时间线剪辑、转场合成、整片渲染（`README.md:85`）。成片停留在“逐镜头 clip 槽 + 交付包”。
- 视频内没有引用音频/音乐项目的代码（`features/video` 下 grep audio 无命中）：配音、BGM 与镜头不关联；镜头“声音”列只是文本。
- 视频生成模型只有 2 个视频模型；无镜头间连续性（上一镜尾帧→下一镜首帧）的专用工作流 [未在代码中发现]。
- 剧本导入：StoryPage 有“采用导入正文/放弃导入”（`StoryPage.tsx:330`），形态为文本导入；未发现 Fountain/Final Draft/PDF 剧本结构化拆分入口，拆场/拆镜依赖 Agent。
- docs/product/film-agent-workflow.md 的 FilmTask/Canon/Lessons 为早期规划，README:386 注明“部分规划不代表当前已实现”。

### 卡点（用户会卡在哪）
1. 出完所有镜头图/视频后无法在应用内看到整集连续效果，只能下载交付包去外部剪辑（`ProducePage.tsx` 仅 handoff/CSV/打印）。
2. 视频生成强依赖外部供应商与 Key（`generationCapabilities.ts`），无 Key 时“制作”只剩手动上传槽。[推断：新用户首次体验在此中断]
3. 12 列镜头表较专业，新手需自行决定字段；无镜头模板/景别预设选择器（columns 均为 text）。

### AI 覆盖度：高
读/改/删/复制/重排、资产、批量生成+采用、缺口检查均有工具；缺：导出交付、整集预览、镜头与音频关联。

## 2. 音频

### 现状 [证据]
- 稿件按章节/段落/说话人（`audio/ui/ScriptDocument.tsx`，`engine/scriptImport.ts`）；音色库（`VoiceLibrary.tsx`，MiMo 预设/设计/克隆，`providers/mimoSpeech.ts`；APIMart 兼容 `apimartAudio.ts`）。
- 音源：生成/导入/麦克风录音（`engine/recorder.ts`）；多版本 take 选择；多轨时间线（`AudioTimeline.tsx` 732 行，裁切/分割/复制/增益/淡入淡出/静音独奏）。
- 导出：仅 WAV，章节或整项目（`engine/exportMix.ts:22,28`）；导出记录区分是否含最新编辑（`AudioExports.tsx`）。
- 批量生成 batch（`generation/batchRuntime.ts`，`commands/batches.ts`）。

### 缺口
- 导出格式只有 WAV，无 MP3/AAC、无分轨 stems、无字幕/SRT 时间轴导出 [证据：exportMix 仅 wav；字幕未发现]。
- 无音效(SFX)生成/环境声库入口，无降噪/响度标准化 [未在 features/audio 发现；推断为缺口]。
- 无口型/对白与视频镜头对齐，无法把配音贴到视频镜头 [见视频节]。

### 卡点
- 长稿件批量配音依赖单一语音供应商（MiMo，APIMart 为旧配置），连接失败时无替代 [证据：providers 仅两个]。
- 导出 WAV 体积大，分享不便 [推断]。

### AI 覆盖度：较高
16 个音频工具覆盖稿件→生成→排布→回退；缺：导出成品工具。

## 3. 音乐

### 现状 [证据]
- Suno v6/v6-wild/v6-mini 与 Flow Music（`music/models/music.ts`），简单/自定义/Flow 三种创作形式，时长上限 Flow 240s / Suno 360s。
- 作品库搜索/排序/收藏/下载/复用参数/存入素材库/加入音频项目（`music/ui/MusicWorkspacePage.tsx`）。
- 工具：music_read/save_draft/update_work/reuse_work/music_generate（`music/agent/musicTools.ts`）。

### 缺口
- 模型字段中没有续写(extend)、翻唱(cover)、分轨(stems)、人声/伴奏分离、歌词时间戳等 Suno 常见操作 [证据：MusicSettings 无相关字段；推断为竞品常见能力]。
- 仅 APIMart 一个渠道；没有“为某镜头/某章节配乐”的上下文绑定。
- 整个音乐功能仅约 1.5k 行（`features/music` 合计 1524 行），相对视频 12k 行体量较薄。

### 卡点
- 配额/等待由供应商决定，README 已说明（`README.md:104`）；失败后重试路径需看 `audio_generation_check`，UI 的重试按钮 [未验证]。
- 作品只能手动“加入音频项目”，无法一键绑定到视频集作为 BGM。

### AI 覆盖度：中高（生成+复用有，缺 extend/cover 类工具，因底层无）。

## 4. 素材库

### 现状 [证据]
- 类型：图片/视频/音频/文档 + 角色/场景/道具/风格设定（`library/models/materials.ts`）；范围：global/ip/project（`MaterialScope`）。
- 搜索：名称/标签/备注文本匹配，按类型/状态/范围过滤（`MaterialLibraryPage.tsx:48`）。
- 导入：MaterialImportDialog、桌面媒体扫描导入（`library/services/desktopMediaImport.ts`、`DesktopMediaImportPanel.tsx`）。
- 项目采用时复制并记录采用版本（README:121；`commands/assetReuse.ts`、`material_use`）。
- 工具 10 个 + 4 个桌面媒体工具。

### 缺口
- 搜索为字符串包含匹配，无语义/以图搜图/自动标签 [证据：filter 为 includes；推断竞品常有 AI 打标]。
- 无批量导入后的自动分类、重复检测（`audio/engine/fingerprint.ts` 仅音频指纹，素材库未见）[部分证据]。
- 无素材包分享/导出（项目 ZIP 之外）[未发现]。

### 卡点
- “全局/IP/项目”三层范围与“采用即复制”的语义对新用户较抽象（README:121 需长段解释）[推断]。

### AI 覆盖度：高（检索、读图、读文本、元数据更新、采用/释放均有）。

## 5. IP 库

### 现状 [证据]
- `library/ui/IpProfilesPage.tsx`、`IpProfileEditor.tsx`，路由 `_studio.ips.*`；项目通过 ProjectIpPicker 关联（`projects/ui/ProjectIpPicker.tsx`）；工具 ip_search/read/create/update/set_archived + project_bind_ip。
- 项目画廊可按 IP 过滤（`ProjectGalleryPage.tsx:101`）。

### 缺口
- IP 档案是元数据与素材归属，未见“IP 圣经”级结构（时间线/人物关系图/世界观版本）[推断：同类工具常有]。
- IP 变更如何影响已关联项目：设计上“新增版本不静默替换”（README:121），缺少“一键同步更新到项目”的流程印象 [未验证]。

### 卡点
- 路由 `_studio.characters/scenes/props/styles` 与 `/assets` 并存，用户可能不清楚角色该建在 IP 还是项目 [推断，需 UI 验证]。

### AI 覆盖度：中高（CRUD 齐，缺 IP 级一致性检查/汇总工具）。

## 6. 项目管理 / 导出 / 记忆 / 参考

### 现状 [证据]
- 项目画廊：视频/音频/音乐 kind 过滤、归档、IP 过滤、排序（`ProjectGalleryPage.tsx`）；设置面板（`ProjectSettingsPanel.tsx`，画幅 ASPECT_PRESETS）。
- 项目 ZIP 导入导出（`S/app/workflows/packages/projectPackage.ts`）、音频包（`audio/packages/audioPackageCodec.ts`）。
- 项目记忆含版本/来源，检索注入（`memory/*`，4 个读取工具）；参考资料支持图片/TXT/MD/文本 PDF/DOCX（`references/documents/*`），无 OCR（README:119）；联网研究 Tavily。
- 自动同步/协作：README:393 明示未实现多人协作与跨设备同步。

### 缺口
- 备份依赖手动导出 ZIP（README 第一次使用第6步）；无自动备份/版本快照 UI [证据：checkpoint.ts 在 workflows 但 README 未宣称自动备份，未验证]。
- 无项目复制/模板（ProjectGalleryPage grep duplicate/模板 无命中）。
- 无统一跨业务线“项目总览/进度仪表盘”（有 `p.$projectId.report.tsx`、`plan.tsx` 路由，内容 [未验证]）。
- 无 OCR；扫描 PDF 不可用（README）。

### 卡点
- 数据只在本机，换设备靠 ZIP。
- 导出/交付动作在 UI 中分散于各工作台，Agent 无法触发（见 §0）。

### AI 覆盖度：中（记忆/参考只读为主；项目创建在 story 组；缺导出、备份、报告工具）。

## 7. 候选方向（按 用户价值×实现成本 排序）

| # | 方向 | 价值 | 成本 | 依据/标注 |
|---|---|---|---|---|
| 1 | Agent 增加“导出/交付”工具（CSV、分镜板、handoff ZIP、音频 WAV、项目 ZIP） | 中高 | 低 | 证据：服务层已存在（episodeDelivery、productionHandoff、exportMix、projectPackage），仅缺工具封装 |
| 2 | 音频导出增加 MP3 与分轨/字幕 SRT | 高 | 低-中 | 证据：仅 WAV；MP3 属竞品常见 [推断] |
| 3 | 项目复制 / 项目模板（含镜头表预设） | 中高 | 低 | 证据：画廊无此入口；价值判断为推断 |
| 4 | 镜头关联音频/音乐（给镜头挂配音或 BGM，制作页显示缺口） | 高 | 中 | 证据：video 与 audio 无引用；整合价值为推断 |
| 5 | 整集预览播放（按镜头 clip 顺序连播 + 关联音频），不做完整剪辑 | 高 | 中 | README:85 现无；竞品常见 [推断] |
| 6 | 音乐 extend/cover/stems 与对应工具 | 中 | 中 | 证据：模型无；Suno 能力为外部知识 [推断] |
| 7 | 素材自动打标 + 语义搜索 | 中 | 中-高 | 证据：现为 includes；竞品 [推断] |
| 8 | 视频模型扩展与镜头连续性（上镜尾帧→下镜首帧） | 高 | 中-高 | 证据：仅 2 个视频模型；其余 [推断] |
| 9 | 剧本结构化导入（PDF/DOCX/Fountain→场次） | 中高 | 中 | 证据：references 已能解析 DOCX/PDF，StoryPage 仅文本导入；链路连接为推断 |
| 10 | 自动备份/快照与恢复提示 | 中 | 中 | 证据：README 依赖手动 ZIP |
| 11 | 新手引导：无 Key 时的本地模式路径、范围语义（全局/IP/项目）说明 | 中 | 低 | [推断，需实测] |
| 12 | 整片时间线剪辑/转场/渲染 | 高 | 很高 | README 明示未提供；与定位取舍有关 |

## Caveats
- 未运行应用，UI 层卡点为代码结构推断；`plan.tsx`/`report.tsx` 路由内容未读。
- 行数仅作体量参考，不代表质量。
- 竞品对比均为推断，未联网核实。
- 按系统规定本文件同时在最终回复中给出摘要。
