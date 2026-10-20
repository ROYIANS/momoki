# 品牌改名为点点

## Goal
产品改名「点点」（英文 Tad），图来设计工作室出品，站点 `dot.tulai.design`；对话里的助手自称「点点」。原名「小光点 / Cuepoint」不再使用（小光点是公司已停止的自媒体项目名，英文 glinta，仓库内没有出现）。

## Owner 已定（2026-10-20）
- 中文「点点」，英文「Tad」，域名 `dot.tulai.design`；公司「图来设计工作室」（`tulai.design`）。
- 「点点」取代「小光点」；logo（戴青蛙帽子的小男孩）不变。
- 还没有真实用户：安装标识符和本地存储键可以直接改，不做迁移。
- 助手昵称不只是展示名：agent 在对话里自称「点点」。

## Requirements
1. 界面、关于页、窗口标题、安装包名、站点文案的产品名统一为「点点」；英文环境「Tad」；关于页与站点页脚署名「图来设计工作室出品」。
2. agent 提示词里的助手自称改为「点点」，只改称呼，不改行为规则。
3. 桌面应用 `productName`、`identifier`（`dev.cuepoint.prototype.offline` → `design.tulai.dot`）、可执行名、安装包文件名模板同步。
4. 代码里带 `cuepoint` 的本地存储键、锁名、备份格式名、MCP OAuth 目录等改为新前缀，且新旧同时存在时不静默丢数据（没有用户，但开发数据要有一次明确的导出/导入提示）。
5. 站点、更新检查、下载地址等 URL 改为 `dot.tulai.design`（仓库地址见 Open Questions）。
6. 文档与 spec 里的现行说明改名；`archive/` 下旧任务不动。

## Acceptance Criteria
- [ ] 仓库非归档文件里不再出现 `小光点`；`Cuepoint` 只允许出现在 Open Questions 决定保留的位置（并写明原因）。
- [ ] 界面、关于页、站点无旧名；关于页有「图来设计工作室出品」。
- [ ] agent 系统提示里助手自称为「点点」，行为相关测试不回退。
- [ ] `pnpm lint`、`pnpm quality`、全量测试（除原生探针）通过；站点与桌面配置的测试同步更新。

## Out of Scope
- logo 重绘；官网内容重写；域名解析/部署（owner 自己处理）；注册商标。

## Open Questions（需 owner 决定，见 design.md §4）
1. 内部 npm 作用域 `@cuepoint/*`（约 300 处 import）是否改名。
2. GitHub 仓库 `ROYIANS/Cuepoint`（更新检查和下载链接用它）是否改名、改到哪个名字。
