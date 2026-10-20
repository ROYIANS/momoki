# 品牌改名为点点

## Goal
产品改名 Momoki（中文「默默」），主角叫齐默默、日常叫默默；图来设计工作室出品，站点 `momoki.tulai.design`；对话里的助手自称「默默」。原名「小光点 / Cuepoint」不再使用（小光点是公司已停止的自媒体项目名；「点点」「Tad」是曾考虑的名字，因小红书助手叫点点而放弃）。

## Owner 已定（2026-10-20）
- 英文 Momoki，中文「默默」，角色「齐默默」；域名 `momoki.tulai.design`；公司「图来设计工作室」（`tulai.design`）；署名「默默 · 图来设计工作室出品」。
- 取代「小光点 / Cuepoint」；logo（戴青蛙帽子的小男孩）不变。
- 还没有真实用户：安装标识符和本地存储键可以直接改，不做迁移。
- 助手昵称不只是展示名：agent 在对话里自称「默默」。

## Requirements
1. 界面、关于页、窗口标题、安装包名、站点文案的产品名统一为「默默」；英文环境「Momoki」；关于页与站点页脚署名「图来设计工作室出品」。
2. agent 提示词里的助手自称改为「默默」，只改称呼，不改行为规则。
3. 桌面应用 `productName`、`identifier`（`dev.cuepoint.prototype.offline` → `design.tulai.momoki`）、可执行名、安装包文件名模板同步。
4. 代码里带 `cuepoint` 的本地存储键、锁名、备份格式名、MCP OAuth 目录等改为新前缀，且新旧同时存在时不静默丢数据（没有用户，但开发数据要有一次明确的导出/导入提示）。
5. 站点、更新检查、下载地址等 URL 改为 `momoki.tulai.design`；仓库地址改为 `ROYIANS/momoki`。
6. 文档与 spec 里的现行说明改名；`archive/` 下旧任务不动。

## Acceptance Criteria
- [ ] 仓库非归档文件里不再出现 `小光点`；`Cuepoint` 只允许出现在 Open Questions 决定保留的位置（并写明原因）。
- [ ] 界面、关于页、站点无旧名；关于页有「图来设计工作室出品」。
- [ ] agent 系统提示里助手自称为「默默」，行为相关测试不回退。
- [ ] `pnpm lint`、`pnpm quality`、全量测试（除原生探针）通过；站点与桌面配置的测试同步更新。

## Out of Scope
- logo 重绘；官网内容重写；域名解析/部署（owner 自己处理）；注册商标。

## Decided
- 内部 npm 作用域 `@cuepoint/*` → `@momoki/*`。
- GitHub 仓库 `ROYIANS/Cuepoint` → `ROYIANS/momoki`（代码里的地址先改；仓库本身由 owner 在 GitHub 上改名，GitHub 会重定向旧地址，ghcr 镜像名 `ghcr.io/royians/momoki` 需随仓库新发布）。
