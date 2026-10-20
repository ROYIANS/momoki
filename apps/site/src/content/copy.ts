import type {SceneId} from "../film/scenes";

// Every promotional statement is a Claim: its text plus the file or document that
// backs it. tests/landingCopy.test.ts asserts that each claim has evidence and that
// no forbidden claim (sync, collaboration, one-click output, ...) appears. Only
// capabilities listed as claimable in the task research (section 3) belong here.
export type Claim = { readonly text: string; readonly evidence: string };

export type SceneCopy = {
    readonly kicker: string;
    readonly title: string;
    readonly eyebrow?: Claim;
    readonly narration: Claim;
    /** The one narrated line shown on the stage (a film subtitle); the readable versions keep it under the title. */
    readonly subtitle: Claim;
    /** At most three. */
    readonly points: readonly Claim[];
    /** Description of the painted frame; it is not a product screenshot. */
    readonly caption: string;
    /** The frame is an illustration of the interface, not the interface itself. */
    readonly schematic?: boolean;
};

export const SCENE_COPY: Record<SceneId, SceneCopy> = {
    leader: {
        kicker: "片头",
        title: "默默 Momoki",
        eyebrow: {text: "本地优先 · 开源 MIT", evidence: "README.md「许可」；LICENSE"},
        narration: {
            text: "本地优先的 AI 创作工作室，让故事、画面、声音和音乐在同一个项目中逐步成形。",
            evidence: "README.md 首句；packages/distribution/src/brand.ts"
        },
        subtitle: {text: "每部片子，都从一粒光点开始。", evidence: "packages/distribution/src/brand.ts；README.md 首句"},
        points: [
            {
                text: "视频、音频与音乐，三类项目同在一个应用里",
                evidence: "README.md 模块表（视频项目 / 音频项目 / 音乐项目）"
            },
        ],
        caption: "黑场里亮起一粒光点，汇聚成片名。",
    },
    spark: {
        kicker: "第一幕 · 灵感 → 剧本",
        title: "从一个念头开始",
        narration: {
            text: "先把故事想清楚：世界设定、剧本与场次，都收在同一个项目里。",
            evidence: "README.md「视频：故事 → 分镜 → 制作 → 交付」建立设定、整理故事"
        },
        subtitle: {
            text: "先有一个念头，然后是一行字。",
            evidence: "README.md「视频：故事 → 分镜 → 制作 → 交付」建立设定、整理故事"
        },
        points: [
            {text: "单片与剧集两种组织方式，剧集可在多集之间共享项目设定与资产", evidence: "README.md「视频」组织项目"},
            {
                text: "参考资料（图片、TXT/Markdown、文本 PDF、DOCX）在本机解析；选中的内容会随 AI 请求发给你所选的供应商",
                evidence: "README.md「参考资料」「助手」；packages/studio/src/features/references/documents/"
            },
            {
                text: "多个 IP 档案与三级素材库；项目采用素材时创建副本并记录版本",
                evidence: "README.md「IP 与素材复用」；packages/studio/src/features/library/commands/assetReuse.ts"
            },
        ],
        caption: "散落的光点排成剧本的文字行，逐字显现。",
    },
    script: {
        kicker: "第二幕 · 剧本 → 分镜",
        title: "文字变成镜头",
        narration: {
            text: "把场次落到具体镜头：顺序、时长、提示词，以及与角色、场景、道具的关联。",
            evidence: "README.md「视频」编辑镜头"
        },
        subtitle: {text: "文字落成镜头，一格，一格。", evidence: "README.md「视频」编辑镜头；packages/studio/src/features/video/services/shotFilters.ts"},
        points: [
            {
                text: "镜头表可筛选、拖拽排序，并支持快捷操作",
                evidence: "README.md「视频」编辑镜头；packages/studio/src/features/video/services/shotFilters.ts、packages/studio/src/platform/collections/reorderIds.ts"
            },
            {
                text: "画面通过助手中的生成流程制作：供应商、模型与提示词由你确认，候选结果由你检查后采用",
                evidence: "README.md「视频」制作画面"
            },
        ],
        caption: "文字行裂变为分镜格，镜头编号与时间码依次生成。",
    },
    agent: {
        kicker: "第三幕 · 创作助手",
        title: "一位安静的助手",
        narration: {
            text: "围绕你绑定的项目对话、制定任务计划、调用已启用的工具，并留下可回看的执行记录。",
            evidence: "README.md「助手：围绕项目执行并核对成果」"
        },
        subtitle: {text: "有个安静的帮手，你点头，它才动手。", evidence: "README.md 权限模式表；packages/studio/src/features/agent/models/agent.ts"},
        points: [
            {text: "三档权限：请求批准、帮我批准、完全访问", evidence: "README.md 权限模式表；packages/studio/src/features/agent/models/agent.ts"},
            {
                text: "执行记录展示工具调用与实际写入的结果；模型说“完成”，不替代工作台里真正保存的内容",
                evidence: "README.md「助手」执行记录段落"
            },
            {
                text: "项目记忆可手动维护，让后续创作沿用约定与偏好",
                evidence: "README.md 模块表「项目记忆」；packages/studio/src/features/memory/commands/projectMemories.ts"
            },
        ],
        caption: "示意：安静的对话与工具时间线，并非真实界面截图。",
        schematic: true,
    },
    vault: {
        kicker: "第四幕 · 本机优先",
        title: "数据留在你这里",
        narration: {
            text: "桌面版存入本机 SQLite 与受管理的文件，浏览器版存入当前站点来源的 IndexedDB，不需要服务端应用数据库。",
            evidence: "README.md「数据存放在哪里」；docs/desktop-distribution.md"
        },
        subtitle: {text: "作品留在你这里，钥匙也是。", evidence: "README.md「数据存放在哪里」「AI 连接与模型」"},
        points: [
            {
                text: "AI 使用你自己的服务与 API Key，请求直接发往你配置的供应商；默默本身不提供模型服务",
                evidence: "README.md「AI 连接与模型」"
            },
            {
                text: "“本地优先”不等于全部离线：AI 与联网研究需要联网，浏览器存储也不是系统钥匙串",
                evidence: "README.md「数据、隐私与备份」"
            },
            {text: "浏览器版与桌面版的数据相互独立，目前不会自动同步", evidence: "README.md「数据存放在哪里」"},
        ],
        caption: "胶片盒缓缓合上，项目留在这台设备里。",
    },
    delivery: {
        kicker: "第五幕 · 成片与交付",
        title: "把成果交出去",
        narration: {
            text: "先检查资料与媒体的缺口，再导出可以移交、也可以备份的文件。",
            evidence: "README.md「视频」检查交付"
        },
        subtitle: {text: "想带走，就整整齐齐地交出去。", evidence: "README.md「视频」检查交付；packages/studio/src/features/video/services/episodeDelivery.ts"},
        points: [
            {
                text: "当前集的分镜 CSV、可打印分镜板与制作素材交付 ZIP",
                evidence: "README.md「视频」检查交付；packages/studio/src/features/video/services/episodeDelivery.ts"
            },
            {
                text: "项目 ZIP 用于备份与迁移，可重新导入；它不含 API Key，也不是整个工作室的镜像",
                evidence: "README.md「项目 ZIP 的范围」"
            },
            {
                text: "目前不含完整的视频时间线剪辑与转场合成，交付的是镜头与素材",
                evidence: "README.md「视频」制作交付包段落"
            },
        ],
        caption: "胶片条依次折成 ZIP、CSV 与分镜板。",
    },
    credits: {
        kicker: "片尾字幕",
        title: "开始使用",
        narration: {
            text: "在浏览器里直接体验，或下载桌面版装进电脑。",
            evidence: "README.md「第一次使用」；docs/desktop-installation.md"
        },
        subtitle: {text: "现在，轮到你开机。", evidence: "README.md「第一次使用」；docs/desktop-installation.md"},
        points: [],
        caption: "字幕缓缓上升。",
    },
};

// Statement under the hero actions; kept from the phase 1 page.
export const HERO_NOTE: Claim = {
    text: "桌面版目前为测试版，未签名，首次打开可能出现系统安全提示。项目数据保存在当前浏览器或本机；使用 AI 功能需要自备模型服务的 API Key。",
    evidence: "docs/desktop-installation.md；README.md「数据存放在哪里」",
};

// Facts about the browser edition (task research, section 3.5).
export const ONLINE_NOTES: readonly Claim[] = [
    {
        text: "在浏览器中打开的是真实的工作室，不是演示视频或沙盒。",
        evidence: "README.md「概览」；packages/studio/src/app/routes/_studio.agent.tsx"
    },
    {
        text: "项目只保存在当前浏览器与站点来源：换浏览器、无痕窗口或清理站点数据后会看不到原项目，请定期导出项目 ZIP。",
        evidence: "README.md「数据、隐私与备份」"
    },
    {
        text: "使用 AI 需要自备模型服务的 API Key，密钥保存在本机；部分供应商可能因跨域限制无法在浏览器直连，桌面版使用原生 HTTP 传输可避开。",
        evidence: "README.md「AI 连接与模型」"
    },
    {text: "浏览器版与桌面版的数据互不同步。", evidence: "README.md「数据存放在哪里」"},
];

export const OPEN_SOURCE: Claim = {
    text: "默默的原创代码采用 MIT 协议开源；第三方内容遵循各自的许可。",
    evidence: "README.md「许可」；LICENSE；THIRD_PARTY_NOTICES.md",
};

export const PRIVACY: Claim = {
    text: "项目数据只保存在你的浏览器或本机，不会上传到默默的服务器；AI 请求直接发往你配置的供应商。浏览器版与桌面版的数据相互独立，请定期导出项目 ZIP。本页会加载 Google Fonts，站点可能启用 Umami 访问统计。",
    evidence: "README.md「数据、隐私与备份」；packages/distribution/src/analytics.ts",
};
