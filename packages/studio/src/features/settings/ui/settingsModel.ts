import type {Icon} from "@phosphor-icons/react/lib";
import {Boxes, Database, Info, Palette, Plug, Settings as SettingsIcon, Sparkles} from "../../../ui/icons";

/** Sections are the single source of truth for both the rail and the search filter. */
export type SettingsSectionId = "general" | "appearance" | "models" | "mcp" | "skills" | "storage" | "update";

type SettingsRow = { id: string; title: string; description?: string; keywords?: string };
export type SettingsSection = { id: SettingsSectionId; title: string; rows: SettingsRow[] };

export const SETTINGS_SECTIONS: (SettingsSection & { icon: Icon })[] = [
    {
        id: "general", title: "通用", icon: SettingsIcon, rows: [
            {
                id: "auto-check",
                title: "启动时自动检查更新",
                description: "每天最多检查一次新版本，默认关闭",
                keywords: "GitHub 自动 更新"
            },
            {id: "last-check", title: "上次检查时间", keywords: "更新 时间"},
        ]
    },
    {
        id: "appearance", title: "外观", icon: Palette, rows: [
            {id: "theme", title: "主题", description: "当前版本只提供深色主题", keywords: "dark 深色"},
            {id: "language", title: "界面语言", description: "当前版本只提供简体中文", keywords: "language 简体中文"},
        ]
    },
    {
        id: "models", title: "模型", icon: Sparkles, rows: [
            {
                id: "models",
                title: "模型连接",
                description: "API Key 密钥与服务商配置",
                keywords: "provider OpenAI AIHubMix APIMart MiMo base URL 连接"
            },
            {id: "search", title: "网络搜索连接", description: "Tavily 搜索密钥"},
            {id: "catalog", title: "模型目录", description: "Models.dev 价格与模型清单", keywords: "pricing 同步"},
        ]
    },
    {
        id: "mcp", title: "MCP", icon: Plug, rows: [
            {id: "mcp", title: "MCP 外部工具连接", description: "本地程序与远程服务、授权和连接管理", keywords: "stdio Streamable HTTP OAuth Token 请求头 外部工具 资源 连接"},
        ]
    },
    {
        id: "skills", title: "技能", icon: Boxes, rows: [
            {id: "skills", title: "已安装技能", description: "导入、启用、更新与卸载文本技能，释放历史版本", keywords: "skill SKILL.md 导入 启用 卸载 历史版本"},
        ]
    },
    {
        id: "storage", title: "存储", icon: Database, rows: [
            {
                id: "location",
                title: "数据存放位置",
                description: "本地 SQLite 工作区、托管媒体或浏览器 IndexedDB",
                keywords: "目录 隐私"
            },
            {id: "scale", title: "数据规模", description: "项目数与素材设定条目数"},
            {id: "backup", title: "备份与迁移", description: "升级或换机前导出项目备份", keywords: "安装 导出 export"},
        ]
    },
    {
        id: "update", title: "关于与更新", icon: Info, rows: [
            {id: "version", title: "当前版本", keywords: "Momoki 默默 version"},
            {
                id: "check",
                title: "检查更新",
                description: "最新桌面版本与安装包下载",
                keywords: "GitHub 发布日期 更新 下载 安装"
            },
            {id: "release", title: "发布页", description: "所有版本、更新说明与校验文件", keywords: "release GitHub"},
            {id: "privacy", title: "数据与隐私", description: "项目数据本地保存，检查更新仅请求公开发布信息"},
            {id: "about", title: "更多关于 Momoki", description: "关于默默"},
        ]
    },
];

/** Former "connections" deep links (settings and /connectors) now land on the models section. */
export function normalizeSettingsSection(value: unknown): SettingsSectionId | undefined {
    if (value === "connections") return "models";
    return isSettingsSectionId(value) ? value : undefined;
}

export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
    return typeof value === "string" && SETTINGS_SECTIONS.some(section => section.id === value);
}

/** Blank query keeps every section; otherwise a section survives when it or one of its rows matches. */
export function filterSettings(sections: SettingsSection[], query: string): SettingsSection[] {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return sections;
    return sections.flatMap(section => {
        if (section.title.toLocaleLowerCase().includes(needle)) return [section];
        const rows = section.rows.filter(row =>
            `${row.title} ${row.description ?? ""} ${row.keywords ?? ""}`.toLocaleLowerCase().includes(needle));
        return rows.length ? [{...section, rows}] : [];
    });
}
