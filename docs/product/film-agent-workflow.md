# 影视 Agent 工作流（Trellis 思路移植）

> 不是用 Trellis 写代码，而是模仿其流程：**聊天创建任务 → 约定约束 → 执行 Skills → 沉淀经验 → 后续对话可引用**。

## 目标体验

用户通过聊天说：「帮我完成第 1 集编写」。可上传剧本；系统创建任务并推进自动分场、分镜等。过程中确认的剧集设定、踩过的坑，要变成**可复用的约束/经验**，之后聊天默认带上。

## 概念对照

| Trellis（研发） | 默默（影视） |
| --- | --- |
| 开发任务 | **影视任务**（写完第 N 集、拆分镜、批量出提示词、出首帧…） |
| `prd.md` | 任务说明：目标集、剧本/附件、验收标准 |
| `.trellis/spec` 约束 | **剧集约定（Canon）** + **经验（Lessons）** |
| Skills | 固定套路：剧本→场次、场次→镜头、镜头→提示词… |
| Check | 完成度检查：场次/镜头空槽、缺角色、缺封面等 |
| 会话记忆 | 项目级记忆，跨聊天注入 |

## 建议数据（概念）

均落在本机（IndexedDB / 未来桌面 SQLite），不进你们的后台库。

### FilmTask（影视任务）

- `type`：如 `write_episode` | `breakdown_script` | `generate_shots` | `prompt_shots` | `generate_frames`
- `status`：`planning` | `in_progress` | `blocked` | `done` | `cancelled`
- `episodeId` / `projectId`
- `brief`：自然语言目标与验收
- `inputs`：上传剧本文本/文件引用
- `outputs`：产出指向（新建的 beat/shot ids 等）

### ProjectCanon（约定）

用户聊天或设定里锁定的规则，例如：

- 人设红线、时代、不能出现的元素  
- 画幅/视觉（可与项目 `aspectPreset` 对齐）  
- 叙事语气  

写入后，后续 Agent 提示词应注入相关条目。

### ProjectLessons（经验）

任务结束后的短复盘，例如：

- 「夜戏提示词要加冷光」  
- 「该集对白密度高，镜头别拆太碎」  

带标签，便于检索注入。

## Skills（MVP 建议先做 3 个）

1. **拆剧本** → 场次（beats）  
2. **生成分镜表** → shots（含基本列）  
3. **补镜头提示词** → 写入 generation slot / 文本列  

出图/出视频不强制进第一个 MVP：可先结构化，再接异步生成。

## 聊天驱动流程（示意）

```text
用户：「完成第1集」+ 上传剧本
  → 创建 FilmTask（planning）
  → 澄清/写入 Canon（如需要）
  → 用户确认 → in_progress
  → 跑 Skills：拆场 → 分镜
  → check：空场、缺角色…
  → done；可选写入 Lessons
之后任意聊天：自动附带 Canon + 相关 Lessons
```

## 与现有产品模块的关系

- **故事 / 分镜 / 制作**：任务的写入目标  
- **世界设定 / 角色场景**：Canon 的来源与落地处  
- **项目成片设定**（比例、封面）：已有能力，Canon/任务应尊重  
- **异步生成**（apimart 等）：任务步骤之一，结果用 `taskId` 回填槽位  

## 非目标（本规划）

- 在浏览器里复刻编码用 Trellis / 真·改 git 仓库  
- 云端托管用户剧本与约定  
- 一上来做完整 MCP 生态（用应用内 Tools + Skills 替代）

## 建议落地顺序

1. FilmTask 表 + 聊天创建「完成第 N 集」  
2. 上传剧本 → 拆场 → 分镜（结构化）  
3. ProjectCanon / Lessons 的写入与注入  
4. 再挂异步出图/出视频步骤  
