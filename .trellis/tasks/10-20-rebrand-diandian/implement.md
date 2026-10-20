# 实施计划
- R1 展示文案 + 署名 + 英文名常量；测试：`landingEntry`、`aboutPage*`、`settingsUpdateSection` 等更新。
- R2 助手自称；新增默认指令断言。
- R3 桌面标识符/Cargo 名/产物名模板（无法在本机编译 Rust：只改配置与引用，并说明未验证）。
- R4 存储键/锁名/备份格式名（备份读取端兼容旧名一个版本）。
- R5 `@cuepoint/*` → `@tulai/*` 机械替换（依 owner 决定）；仓库地址依 owner 决定。
- R6 文档与 spec 现行说明；全量验证；archive。
验证：`pnpm lint`、`pnpm quality`、`pnpm vitest run`（原生探针测试本机失败属环境问题）；收尾 grep 确认无遗留。
