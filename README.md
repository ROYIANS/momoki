# 默默 Momoki

**本地优先的 AI 创作工作室，让故事、画面、声音和音乐在同一个项目中逐步成形。**

**简体中文** · [English](README.en.md)

默默将创作助手、影视分镜、音频制作、音乐生成与可复用的 IP／素材库放在共用界面的浏览器与桌面工作室里。你可以手动编辑，也可以让助手结合项目资料拆解任务、调用创作工具，再检查实际保存的成果。

桌面端把项目数据存入应用内部的 SQLite，并将素材复制到受管理的文件工作区；浏览器端复用同一套界面、业务命令与 Agent，使用 IndexedDB。AI 使用你自己配置的服务和 API Key（BYOK）。浏览器端可以作为静态网站或 Docker 镜像部署，无需配置服务端应用数据库。安装包目标与发布验收流程见 [桌面分发说明](docs/desktop-distribution.md)。

> 当前可创建视频、音频和音乐项目。图片与文案的独立项目工作台仍为「即将推出」；现有视频项目内的图像生成和文本编辑已经可用。应用界面目前以中文为主，英文 README 不代表应用已提供完整英文界面。

## 目录

- [下载与安装](#下载与安装)
- [功能概览](#功能概览)
- [第一次使用](#第一次使用)
- [创作工作流](#创作工作流)
- [AI 连接与模型](#ai-连接与模型)
- [数据、隐私与备份](#数据隐私与备份)
- [本地开发](#本地开发)
- [部署](#部署)
- [Umami 访问统计](#umami-访问统计)
- [技术栈与代码结构](#技术栈与代码结构)
- [质量检查与贡献](#质量检查与贡献)
- [常见问题](#常见问题)
- [文档与实现范围](#文档与实现范围)
- [感谢](#感谢)
- [许可](#许可)

## 下载与安装

**[下载桌面体验版](https://github.com/ROYIANS/momoki/releases) · [查看图文安装指南](docs/desktop-installation.md)**

在 Release 页面选择标签为 `desktop-v<版本号>` 的桌面版本，展开 **Assets**，下载适合设备的安装包：

| 设备 | 选择的文件 |
| --- | --- |
| Mac · Apple 芯片（M 系列，macOS 14+） | 文件名含 `macos_arm64` 的 `.dmg` |
| Mac · Intel 处理器（macOS 14+） | 文件名含 `macos_x64` 的 `.dmg` |
| Windows · x64 | 文件名含 `windows_x64` 的 `_setup.exe` |
| Linux · x64 | `.deb` 或 `.AppImage`；当前为 Ubuntu 22.04 构建基线，需满足运行依赖 |

**第一次安装时可能出现系统提示。** 当前 Windows 包未进行代码签名，Mac 版本使用临时签名、尚未完成 Apple 公证，系统可能无法验证发布者或软件信誉。先确认文件来自上面的官方 Release，再按 [Windows / Mac 图文步骤](docs/desktop-installation.md) 选择是否继续；无需关闭系统安全功能。

遇到病毒、恶意软件或文件损坏提示时，请停止安装并 [反馈完整提示](https://github.com/ROYIANS/momoki/issues)。Assets 中的 **Source code (zip / tar.gz)** 是源码，不是安装包。当前没有 Windows ARM、Linux ARM 或 Mac 通用安装包。从 0.1.3 起，桌面版可在「设置 → 关于与更新」检查版本、下载并校验安装包，保存后由你完成安装；更新前请导出项目 ZIP 备份。

## 功能概览

| 模块 | 当前能力 |
| --- | --- |
| 创作助手 | 流式对话、项目绑定、任务计划、工具执行、权限控制、已安装技能、MCP 连接、执行记录与成果展示。离开对话时，进行中的工作可以继续 |
| 视频项目 | 单片／剧集、世界设定、故事与场次、镜头表、资产关联、画面生成与制作交付 |
| 音频项目 | 章节与稿件、说话人和音色、语音生成、麦克风录音、音源试听、多轨剪辑、WAV 混音导出 |
| 音乐项目 | 创作草稿、Suno／Flow Music 生成、作品试听与收藏、参数复用、下载及转入音频项目 |
| 我的 IP | 多个长期 IP 档案、项目关联、IP 范围的素材管理 |
| 素材库 | 图片、视频、音频、文档，以及角色／场景／道具／风格设定；版本与项目采用记录 |
| 项目记忆 | 管理创作约定、偏好、决定和经验，保留版本与来源，按项目用于后续创作 |
| 参考资料 | 本地解析图片、TXT／Markdown、文本 PDF 和 DOCX，供助手按需检索和阅读 |
| 联网研究 | 配置独立 Tavily 连接后搜索网页、提取页面正文并展示来源 |
| 交付与迁移 | 项目 ZIP 导入导出、分集 CSV、可打印分镜板、制作素材交付包、音频成品下载 |

## 第一次使用

1. 按[下载与安装](#下载与安装)安装桌面体验版；使用浏览器版本时，按[部署](#部署)运行镜像，或按[本地开发](#本地开发)启动开发服务。
2. 在「设置 → 连接与模型」中添加需要的 AI 服务，填写 Base URL 和 API Key，测试连接并查看模型。
3. 在「项目」中新建视频、音频或音乐项目。项目可以独立存在，也可以关联「我的 IP」中的档案。
4. 手动整理稿件和素材，或打开「创作助手」，选择连接与聊天模型，再绑定目标项目。
5. 使用工具和生成能力时检查权限与生成配置，在相应工作台查看保存结果。
6. 定期从项目菜单导出 ZIP。换浏览器、换设备或更换部署域名前，先备份需要迁移的项目。

不使用 AI 时，无需填写 API Key 即可进行本地项目编辑、素材管理和支持的导出操作。AI 生成、聊天和联网研究需要对应服务可用。

## 创作工作流

### 视频：故事 → 分镜 → 制作 → 交付

- **组织项目**：单片使用一个内部集；剧集支持多集共享项目设定与资产。
- **建立设定**：维护世界观、角色、场景、道具和视觉风格；将工作室中的资产副本用于当前项目。
- **整理故事**：编辑剧本与场次，将内容落实到具体镜头。
- **编辑镜头**：调整镜头顺序、时长、状态、提示词及资产关系，使用筛选、拖拽和快捷操作整理镜头表。
- **制作画面**：通过助手中的生成流程确认供应商、模型、提示词与输出目标；查看候选结果并按需采用到镜头或资产。
- **检查交付**：在制作页查看资料与媒体缺口，导出当前集的 CSV、可打印分镜板或素材交付 ZIP。

制作交付包用于移交镜头和素材；项目备份 ZIP 用于重新导入 Momoki。当前应用不提供完整视频时间线剪辑、转场合成或自动渲染整部影片的能力。

### 音频：稿件 → 声音 → 多轨 → 成品

- 按章节编写稿件，按段落分配说话人，粘贴多行稿件时拆分为段落。
- 在音色库中配置 MiMo 预设音色、自然语言音色设计或参考声音克隆，并试听、保存为可复用的说话人配置。
- 为稿件生成配音，或导入音频、通过麦克风录制音源。录音由用户操作触发，需要浏览器权限。
- 保留不同音源版本，试听后选择使用的版本并加入时间线。
- 进行多轨排列、移动、裁切、分割、复制、增益与淡入淡出调整，使用静音／独奏检查混音。
- 导出当前章节或完整项目的 WAV，并在导出记录中区分历史成品与当前编辑状态。

新配音默认走 MiMo 配置；已有 APIMart 配音配置仍可使用。音乐作品可以明确加入音频项目，作为新的音源继续编排。

### 音乐：创作草稿 → 生成版本 → 作品库

- 在草稿中填写音乐描述、歌词、风格等参数，按引擎选择简单、自定义或 Flow 创作形式。
- 通过 APIMart 提交 Suno／Flow Music 任务，保留供应商任务标识和生成结果。
- 在作品库中搜索、试听、收藏和下载作品，复用已有作品的参数创建新草稿。
- 将作品保存到素材库，或加入音频项目进一步编辑。

可用模型、参数、账户权限、额度和收费由供应商决定。供应商完成生成、音频下载到本地和用户试听是不同步骤。

### 助手：围绕项目执行并核对成果

助手可以结合绑定项目、参考资料和项目记忆，组织计划、读取项目、编辑创作数据，并调用已启用的生成或研究工具。普通对话与工具执行模式有明确区分；工具能力和权限会影响它能完成的操作。

| 权限模式 | 行为 |
| --- | --- |
| 请求批准 | 编辑业务数据或使用互联网工具前询问 |
| 帮我批准 | 常规操作自动执行，高风险操作和付费生成询问 |
| 完全访问 | 自主执行已启用工具；付费生成仍需确认配置 |

执行记录展示工具调用、待处理操作、停止原因和实际写入结果。生成流程会保留任务和候选结果；用户可以检查、采用和继续处理，模型的一句「完成」不替代工作台中的实际成果。

项目记忆可以手动维护，也可以从已确认的任务总结中提炼。参考文档在浏览器本地提取文本；选中的内容或图片会在相关 AI 请求中发送给所选供应商。扫描 PDF 没有 OCR 保证，图片理解需要所选模型具备相应能力。

### IP 与素材复用

IP 是长期创作身份或世界设定的组织方式，不是另一种项目类型。素材可以属于全局、某个 IP 或某个项目。项目采用素材时创建项目拥有的副本，并记录采用版本；共享素材新增版本不会悄悄替换已经使用的画面或设定。

## AI 连接与模型

连接保存在工作室范围，不必为每个项目重复填写密钥。聊天模型在助手中选择，生成模型与参数在对应生成流程中确认。

| 连接 | 当前项目中的用途 |
| --- | --- |
| OpenAI 兼容 | 连接兼容聊天接口的服务、代理或本地网关 |
| DeepSeek | 使用预设入口配置兼容聊天服务 |
| APIMart | 聊天、图像／视频生成，以及音频／音乐相关适配 |
| AIHubMix | 聊天、图像／视频生成 |
| MiMo | 聊天、语音合成、音色设计与声音克隆 |
| Tavily（独立搜索连接） | 助手网页搜索与页面正文提取 |

模型列表与能力提示来自供应商信息及项目内置或用户手动同步的 Models.dev 模型目录，不能代替账户权限检查。「获取模型」也不一定意味着密钥已通过验证；连接测试、公开模型查询和真实生成是不同操作。

通用 OpenAI 兼容连接测试优先读取模型列表；接口不支持或遇到部分网络错误时，可能使用最小聊天请求进行探测，因此可能产生少量供应商用量。专用连接器按各自协议测试。

浏览器直接访问供应商，因此服务必须允许相应的跨域请求（CORS）。桌面端使用官方原生 HTTP 传输，保留相同的连接来源策略、取消行为与供应商协议。如果需要代理，请配置自己的兼容网关；当前仓库不提供应用后端代理。使用 HTTPS 网站时，模型入口也应支持 HTTPS。

## 数据、隐私与备份

### 数据存放在哪里

| 数据／操作 | 位置或去向 |
| --- | --- |
| 项目、稿件、镜头、素材、音频、会话、任务和记忆 | 桌面端：内部 SQLite 与受管理的文件；浏览器端：当前来源的 IndexedDB，部分界面偏好使用本地存储 |
| AI 连接与搜索密钥 | 当前应用配置中的本地数据；发送请求时用于对应供应商认证 |
| AI 对话、生成描述、选用的参考文字／图片／音频 | 使用相关功能时发送给已配置的服务 |
| 网页研究查询与待提取 URL | 使用研究工具时发送给 Tavily |
| 网站资源 | 从部署站点加载；页面也会请求 Google Fonts |
| 可选访问统计 | 仅在生产构建配置 Umami 后发送标准页面访问数据 |

「本地优先」指项目存储架构，不代表所有功能离线，也不代表浏览器存储是系统钥匙串。当前没有内置的账号登录、跨设备自动同步或多人实时协作服务。

桌面应用配置和浏览器站点使用独立的数据标识，目前尚未实现自动同步。导入文件会复制到应用工作区，删除原始文件不会删除已导入的素材。

浏览器数据按配置文件和站点来源隔离。更改域名、协议或端口，换浏览器、使用隐私窗口或清理站点数据，都可能使原来的项目不可见或丢失。服务器容器与数据卷不会替你备份访问者浏览器中的项目。

### 项目 ZIP 的范围

从项目菜单导出，在工作室侧栏通过「导入项目」恢复。当前包格式标识为 `aifenjing-project-v1`，保留历史命名以兼容已有备份。

| 包含 | 不包含 |
| --- | --- |
| 项目设置、视频的集与镜头、项目拥有的角色／场景／道具／风格 | AI 连接和 API Key、Tavily 密钥 |
| 项目引用并保留的媒体、参考资料与文本块 | 完整 Agent 会话、执行账本和任务历史 |
| 项目记忆及版本历史 | 整个工作室的 IP 档案和全部共享素材库 |
| 音频／音乐项目记录及其相关媒体 | 尚未被项目采用的工作室素材快照 |

导入会创建独立的项目与资源标识。导入的记忆需要复核，历史生成任务不会因为导入而自动重新提交付费请求。项目 ZIP 是项目迁移与备份方式，不是整个浏览器工作室的完整镜像。

## 本地开发

### 环境准备

浏览器与 GHCR 主质量检查使用 **Node.js 22**；独立 Agent 示例检查与桌面发布流程使用 **Node.js 24.11.0**，详见[桌面打包指南](docs/desktop-distribution.md)。包管理器版本以 [`package.json`](package.json) 的 `packageManager` 为准，当前为 **pnpm 10.15.0**。在已有开发环境中遵循仓库 [`AGENTS.md`](AGENTS.md) 及本机包管理器约定，避免混用版本重建依赖。

```bash
git clone https://github.com/ROYIANS/momoki.git
cd Momoki
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

打开终端显示的开发地址，通常为 `http://localhost:5173`。基本启动不需要 `.env` 文件，也不需要数据库、Redis 或服务端 AI 密钥。

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 启动 Web 应用开发服务 |
| `pnpm dev:site` | 启动独立官网开发服务 |
| `pnpm --filter @momoki/desktop build:frontend` | 构建正常桌面前端 |
| `pnpm agent:build` | 按依赖顺序构建 Agent 包的 ESM 与类型声明 |
| `pnpm agent:example:check` | 在仓库外离线安装打包产物，验证独立 SQLite Agent（Node ≥24.11） |
| `pnpm quality` / `pnpm quality:self-test` | 检查全部源码及门禁失败用例 |
| `pnpm build` | 分别构建 Web／官网并校验合并到 `dist/` |
| `pnpm preview` | 本地预览生产构建 |
| `pnpm lint` | 运行 `tsc -b`，即 TypeScript 类型检查 |
| `pnpm test` | 运行完整 Vitest 测试集 |
| `pnpm exec vitest run tests/umami.test.ts` | 运行指定测试文件 |
| `pnpm models-dev:baseline` | 按已锁定的 `@opencode-ai/models` 重新生成内置模型目录基线 |
| `pnpm models-dev:verify` | 校验内置基线与锁定的包版本一致 |

## 部署

### 使用 Docker Compose

镜像：`ghcr.io/royians/momoki`，查看 [GHCR 包页面](https://github.com/ROYIANS/momoki/pkgs/container/momoki)。获取仓库中的 [`docker-compose.yml`](docker-compose.yml) 后，在它所在的目录运行：

```bash
# 仅在镜像包为私有时需要登录
printf '%s' "$GITHUB_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin

docker compose pull
docker compose up -d
```

打开 `http://localhost:8080`。Compose 将主机 `8080` 端口映射到容器 Nginx 的 `80` 端口，并配置 `unless-stopped` 重启策略。对外提供 HTTPS 时，在站点前配置 TLS 反向代理；录音功能需要 HTTPS 或本机安全上下文。

更新镜像仍使用 `docker compose pull` 和 `docker compose up -d`。如需固定发布版本，可将 Compose 的 `latest` 标签改为已发布的版本号。

### 本地构建镜像

```bash
docker build -t ghcr.io/royians/momoki:latest .
docker compose up -d
```

Dockerfile 先在 Node 构建阶段安装锁定依赖、构建前端，再将 `dist/` 放入 Nginx 镜像。运行阶段不需要 Node 或应用数据库。项目数据不保存在容器里。

### 静态托管

运行 `pnpm build` 后部署 `dist/`。托管服务必须支持 SPA 回退：实际文件不存在时返回 `index.html`，否则直接打开或刷新项目详情地址会出现 404。当前路由和资源按站点根路径部署，子目录托管需要另行调整与验证。

仓库的 [`deploy/nginx.conf`](deploy/nginx.conf) 已配置路由回退、gzip、静态资源缓存和入口 HTML 的重新校验。`pnpm preview` 用于本地验收，生产托管应使用正式静态服务器或平台。

### GitHub Actions 发布

[发布工作流](.github/workflows/ghcr.yml) 在 `main` 推送、`v*` 标签、面向 `main` 的 PR 和手动触发时运行。质量任务执行锁定依赖安装、类型检查、测试、模型快照校验和生产构建；镜像发布依赖质量任务成功，PR 不发布镜像。

默认分支发布 `latest`，版本标签产生 semver 标签，镜像同时带提交 SHA 标签。工作流使用 `GITHUB_TOKEN`，发布任务声明 `packages: write` 权限；仓库或组织策略需要允许该权限。

Fork 到自己的仓库时，需同步修改工作流中的固定镜像地址和 Compose／本地构建命令中的标签。

## Umami 访问统计

接入已有 Umami 即可，无需在 Compose 中新增统计服务或环境变量。

### 在 GitHub 配置

进入 **仓库 → Settings → Secrets and variables → Actions → Variables**，添加两个 Repository variables：

| 变量 | 内容 |
| --- | --- |
| `VITE_UMAMI_SCRIPT_URL` | Umami 追踪代码中的完整 `src`，如 `https://analytics.example.com/script.js` |
| `VITE_UMAMI_WEBSITE_ID` | 同一追踪代码中的 `data-website-id` |

必须同时填写，脚本地址支持完整 HTTP(S) URL；HTTPS 网站请使用 HTTPS 脚本。这些值会公开嵌入前端，使用 Variables 即可，不要填写管理员密码或 API Token。

保存后，在 `main` 上运行 **Actions → Quality checks and GHCR image → Run workflow**，或推送新提交。等待镜像发布成功，再在服务器拉取并重建容器。

配置在**构建时**生效。只修改 GitHub 变量或给已有容器添加环境变量不会改变旧镜像。关闭统计时，清空任意一个变量，重新构建发布并部署。

### 本地构建与验证

本地生产构建可复制 [`.env.example`](.env.example) 为 `.env.local`，填写两个值后运行 `pnpm build`、`pnpm preview`。`pnpm dev` 不加载统计。

本地环境文件不会进入 Git 或 Docker 构建上下文；Docker 构建需显式传参：

```bash
docker build \
  --build-arg VITE_UMAMI_SCRIPT_URL=https://analytics.example.com/script.js \
  --build-arg VITE_UMAMI_WEBSITE_ID=YOUR_WEBSITE_ID \
  -t ghcr.io/royians/momoki:latest .
docker compose up -d
```

脚本异步加载一次，由 Umami 处理 SPA 页面跳转。当前接入不添加业务事件，也不主动附带项目正文、提示词或供应商密钥；标准访问数据仍包含页面 URL、标题和来源等信息。

部署后在浏览器 Network 中确认脚本加载，切换页面检查采集请求（通常为 `/api/send`），再在对应 Umami 网站中查看访问。内容拦截器可能阻止统计。行为参考 [Umami 配置文档](https://docs.umami.is/docs/tracker-configuration)与 [SPA 指南](https://docs.umami.is/docs/guides/track-single-page-apps)。

## 技术栈与代码结构

| 层 | 技术与职责 |
| --- | --- |
| 前端 | React 19、TypeScript、Vite 7 |
| 路由 | TanStack Router 文件路由与自动代码拆分 |
| 本地数据 | 共用 ProductStore 命令与查询；桌面端 SQLite／文件，浏览器端 Dexie／IndexedDB |
| 界面 | Tailwind CSS 4、Radix UI、Ant Design、Lobe UI、Lucide、Motion |
| AI | 共用供应商适配与 Agent 工具运行时，原生或浏览器 HTTP，模型目录（Models.dev）元数据 |
| 文档与媒体 | PDF.js、Mammoth、JSZip、Web Audio、MediaRecorder |
| 桌面端 | Tauri 2／Rust、SQLite、原生 HTTP 与文件／系统服务 |
| 验证与部署 | Vitest、fake-indexeddb、TypeScript、GitHub Actions、Docker／Nginx |

```text
apps/
├── web/                    # 浏览器 HTML、启动入口与 Vite 配置
├── desktop/                # Tauri 入口、Rust 运行时、原生与发布工具
│   └── reference/electron/ # 保留的历史原型
└── site/                   # 独立的轻量官网
packages/
├── studio/                 # Web 与桌面端共用的产品实现
│   └── src/
│       ├── app/            # 启动、路由、页面框架与跨业务工作流
│       ├── features/       # projects、video、audio、music、library、
│       │                   # references、memory、settings、agent
│       ├── platform/       # 存储、运行时、HTTP、媒体与固定产品服务
│       └── ui/             # 通用控件、图标与主题
├── distribution/           # 品牌、统计、发布版本与平台信息
│   └── public/brand/       # 共用产品标识资源
├── agent-core/             # 通用 Agent 执行、工具与上下文机制
└── agent-providers/        # Chat Completions／Responses；公有 HTTP 机制入口
examples/
└── agent-todo/             # 独立 SQLite CLI；只使用 Agent 公有包
tooling/                    # 工作区、构建、质量、模型与原生验证工具
tests/                      # 跨包集成与永久测试
quality/                    # 源码归属、精确债务与保留契约
deploy/                     # 官网根路径与应用 SPA 回退的 Nginx 配置
.github/workflows/          # 根质量／GHCR 与桌面打包流程
docs/                       # 产品与架构文档
.trellis/                   # 开发规范、任务与会话记录
```

每个业务 feature 按需要收纳自己的模型、命令、查询、界面、测试和产品工具适配；例如音频编辑相关代码集中在 `packages/studio/src/features/audio/`。`app` 负责组合，`platform/storage` 提供存储机制，`platform/product/store.ts` 选择固定的产品存储实例。跨包通过声明的公有导出调用，跨 feature 通过具体命令、查询或服务入口协作。

Agent 的通用机制由 [`@momoki/agent-core`](packages/agent-core/README.md) 承担；[`@momoki/agent-providers`](packages/agent-providers/README.md) 提供现有协议与显式的 `/http` 公有入口，使用构建后的 ESM 和类型声明。Studio 负责创作工具、提示、项目范围、资料像素、连接凭据、运行时 HTTP 权限以及产品事务。

[`agent-todo`](examples/agent-todo/README.md) 使用自己的 SQLite 表和业务工具，演示批准、拒绝、停止以及进程重启后的显式恢复。它调用同一套 Agent 执行实现，展示其他项目需要实现的宿主适配。`agent:example:check` 在仓库外离线安装本地打包产物后验证示例；示例需要 Node ≥24.11，通用包和 Web 质量检查保留 Node 22 支持。

## 质量检查与贡献

开始修改前阅读 [`AGENTS.md`](AGENTS.md) 和相关 [Trellis 开发规范](.trellis/spec/frontend/index.md)。产品数据写入通过 `packages/studio/src/features/<feature>/commands/` 中的具体命令完成；嵌套操作沿用调用者的存储和事务上下文，保持项目归属、版本冲突检查和导入导出契约。

提交前按改动范围验证，完整发布门禁为：

```bash
pnpm lint
pnpm quality
pnpm quality:self-test
pnpm test
pnpm models-dev:verify
pnpm build
pnpm agent:example:check # 此项需要 Node ≥24.11
```

`lint` 当前是类型检查，不是 ESLint。测试以纯逻辑、数据层和运行时为主；录音、浏览器跨域、实际模型质量及付费生成还需要独立的真实环境验证。请在变更说明中区分模拟测试和真实供应商验证，并保留第三方许可与快照来源。

## 常见问题

**换地址后为什么项目不见了？**

浏览器按来源隔离数据，`http://localhost:8080` 与正式 HTTPS 域名不是同一个数据库。回原地址导出项目 ZIP，再到新地址导入。

**关闭页面后，助手还能继续工作吗？**

浏览器内的多步执行不会在关页后作为后台服务持续运行。已提交到供应商的异步生成可能继续，重新打开后可根据本地任务记录查询或恢复后续处理；停止本地等待不等于取消远端生成或收费。

**配置好 Key，为什么还是连接失败？**

检查 Base URL、模型权限、余额、HTTPS 和 CORS。公开模型目录可访问并不能证明 Key 有效。应用没有内置代理，需由供应商允许浏览器访问，或使用你自己的兼容网关。

**为什么图片／文案项目无法创建？**

这两类独立工作台尚未开放。视频项目里的图片生成、剧本和提示词编辑不受此限制。

**为什么录音不可用？**

检查是否通过 HTTPS 或 localhost 访问、浏览器是否支持 MediaRecorder、是否允许麦克风，以及设备是否可用。

**项目 ZIP 能恢复整个工作室吗？**

不能。它不包含完整聊天历史、全局连接、全部 IP 或整个素材库，具体范围见[备份说明](#项目-zip-的范围)。

**改了 Umami 变量为什么没有统计？**

需要重新构建和部署镜像，同时填写脚本地址与 Website ID；本地开发不启用统计。还需检查脚本是否被拦截、HTTPS 是否匹配，以及 Umami 中的网站是否对应。

## 文档与实现范围

- [产品与架构文档索引](docs/README.md)：包含早期方向记录，部分规划不代表当前已实现。
- [AI 连接器设计](docs/product/ai-connectors.md)：连接和协议适配的背景。
- [影视 Agent 工作流](docs/product/film-agent-workflow.md)：任务与工作流设计。
- [运行时选项](docs/architecture/runtime-options.md)：静态 Web、可选代理、桌面和同步方案的讨论。
- [前端开发规范](.trellis/spec/frontend/index.md)：代码约定及具体模块契约。
- [第三方声明](THIRD_PARTY_NOTICES.md)：依赖、数据快照和文档解析器许可。

同一套产品可以运行于浏览器静态应用和 Tauri 桌面应用，桌面端使用完整 SQLite／文件存储。跨平台安装包验收与代码实现、本机 macOS 检查分别记录，具体见桌面分发说明与实际工作流报告。原生 MCP、服务器后台 Agent、跨设备自动同步和多人实时协作尚未实现；功能范围以当前代码、可操作界面和已记录的验收结果为准。

## 感谢

感谢以下项目及其贡献者，为默默提供基础能力与实现参考：

| 项目 | 使用与参考 |
| --- | --- |
| [PDF.js](https://github.com/mozilla/pdf.js)、[Mammoth.js](https://github.com/mwilliamson/mammoth.js) | 浏览器本地 PDF 正文与 DOCX 文本提取；分别采用 Apache-2.0、BSD-2-Clause 许可 |
| [LobeHub](https://github.com/lobehub/lobehub) | Agent、聊天输入区和上下文交互的实现参考 |
| [Lobe UI](https://github.com/lobehub/lobe-ui)、[Lobe Icons](https://github.com/lobehub/lobe-icons)、[Fluent Emoji](https://github.com/lobehub/fluent-emoji) | 聊天组件、模型品牌图标与表情资源 |
| [Models.dev](https://models.dev) | 模型规格与价格目录（内置基线与手动同步，MIT） |
| [React](https://react.dev/)、[TypeScript](https://github.com/microsoft/TypeScript) | 应用界面与类型系统 |
| [Vite](https://github.com/vitejs/vite)、[Vite React Plugin](https://github.com/vitejs/vite-plugin-react) | 开发服务与构建 |
| [TanStack Router](https://github.com/TanStack/router) | 类型安全路由与路由生成 |
| [Dexie](https://github.com/dexie/Dexie.js) | IndexedDB 数据访问与 React 响应式查询 |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss)、[tailwind-merge](https://github.com/dcastil/tailwind-merge)、[tw-animate-css](https://github.com/Wombosvideo/tw-animate-css) | 样式、类名合并与动效样式 |
| [Radix Primitives](https://github.com/radix-ui/primitives)、[Ant Design](https://github.com/ant-design/ant-design) | 对话框、菜单、弹层、表单等界面基础组件 |
| [dnd kit](https://github.com/clauderic/dnd-kit) | 拖拽与排序 |
| [Lucide](https://github.com/lucide-icons/lucide)、[Boring Avatars](https://github.com/boringdesigners/boring-avatars) | 界面图标与头像 |
| [Motion](https://github.com/motiondivision/motion)、[Sonner](https://github.com/emilkowalski/sonner) | 界面动画与消息提示 |
| [Class Variance Authority](https://github.com/joe-bell/cva)、[clsx](https://github.com/lukeed/clsx) | 组件样式变体与条件类名 |
| [Zod](https://github.com/colinhacks/zod)、[JSZip](https://github.com/Stuk/jszip) | 数据校验与项目 ZIP 备份 |
| [Trellis](https://github.com/mindfold-ai/Trellis) | 项目规范、任务拆分与开发过程记录 |
| [Vitest](https://github.com/vitest-dev/vitest)、[fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB)、[DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | 自动化测试、浏览器数据库模拟与类型声明 |

同时感谢 [APIMart](https://docs.apimart.ai/llms.txt) 和 [AIHubMix](https://docs.aihubmix.com/llms.txt) 提供的接口文档，帮助我们完成 connector 适配。

依赖的具体版本见 [`package.json`](package.json) 与锁文件。各项目保留各自的版权与许可；致谢不代表第三方内容被重新授权。

## 许可

默默的原创代码采用 [MIT License](LICENSE)。

第三方内容遵循各自的原始许可，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。
