# 品牌改名为点点：设计

只做改名，不改行为。按「改了会有什么后果」分五类处理。

## 1. 展示文案（无风险）
`@cuepoint/distribution/brand` 的 `PRODUCT_NAME_ZH` 等常量、关于页、`apps/site`、窗口标题、`docs/product`。加英文名常量 `PRODUCT_NAME_EN = "Tad"` 与署名常量。`小光点` 约 20 个文件（packages/studio、apps/site、apps/desktop、tests、docs）。

## 2. 助手自称（影响 agent 语气）
找系统提示/默认 agent 配置里的自称与产品名，改为「点点」。只替换称呼；加一条测试断言默认指令包含新名字且不含旧名。

## 3. 标识符与文件名（改了要重新安装）
- `apps/desktop/src-tauri`：`productName`、`identifier` → `design.tulai.dot`；Cargo 包/库名 `cuepoint-prototype`、`cuepoint_native_storage`；`Info.plist`、entitlements、capabilities。
- 发布产物名 `Cuepoint_<ver>_*` 的模板、`release` 脚本与 `docs/desktop-release-*.md`（历史版本文档不改，仅改模板）。
- 本机开发数据会因 identifier 变化换目录：改前提示 owner 先导出。

## 4. 带数据含义的名字（逐个确认不丢数据）
`cuepoint.agent.*`、`cuepoint.audio-batch.*`、`cuepoint.generation-batch.*`（Web Lock 名）、`cuepoint.native-backup.v1`、`cuepoint-batch-v1`、`cuepoint-product-profile-v1`、`cuepoint-lifecycle-*`、`cuepoint.landing.release`、`/cuepoint-mcp-oauth`。
- 没有用户，直接换前缀，但这些字符串在测试和 fixtures 里也出现，需同批更新；存储 schema 版本号不变。
- 备份格式名（`native-backup.v1`）是文件格式标识：改名的同时让读取端接受旧名一个版本，避免开发数据导入失败。

## 5. 工程命名
- **内部作用域 `@cuepoint/*`**（agent-core、agent-providers、distribution、studio、site、desktop、web；约 300 处 import）：机械替换风险低但改动面大，对用户零收益。**建议改**成 `@tulai/*`，一次全量机械替换并用 `tsc -b`、`pnpm quality`、全量测试兜底，理由是留着旧名会让代码里长期两套叫法。若 owner 想省事，也可以保留作为内部名并在 README 说明。
- **GitHub 仓库 `ROYIANS/Cuepoint`**：更新检查（`api.github.com/repos/...`）、下载链接、issues 链接、`ghcr.io/royians/cuepoint` 都用它。仓库改名后 GitHub 会自动重定向旧地址，但 API 与 ghcr 不保证；改仓库名是 owner 的外部操作，代码里的地址要与最终仓库名一致。

## 6. 顺序与回滚
1 → 2 → 3 → 4 → 5，每类一次提交，可单独回滚；每类后跑 lint/quality/测试。
