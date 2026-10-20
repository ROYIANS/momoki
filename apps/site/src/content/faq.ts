import type {Claim} from "./copy";

export type FaqItem = { readonly question: string; readonly answer: Claim };

export const FAQ: readonly FaqItem[] = [
    {
        question: "我的数据存在哪里？",
        answer: {
            text: "桌面版存入本机 SQLite 与受管理的文件；浏览器版存入当前站点来源的 IndexedDB。换浏览器、无痕窗口、清理站点数据或更换域名，都可能看不到原来的项目，请定期导出项目 ZIP。",
            evidence: "README.md「数据存放在哪里」「常见问题」",
        },
    },
    {
        question: "需要联网或自带 API Key 吗？",
        answer: {
            text: "不使用 AI 时无需 API Key，可以本地编辑项目、管理素材并导出。AI 对话、生成和联网研究需要你自备服务的 API Key，并需要联网；部分供应商可能因跨域限制无法在浏览器里直连。",
            evidence: "README.md「第一次使用」「AI 连接与模型」",
        },
    },
    {
        question: "桌面版和网页版有什么区别？",
        answer: {
            text: "两者共用同一套界面与业务逻辑。桌面版使用原生 HTTP 传输，可以避开浏览器的跨域限制；两者的数据相互独立，目前不会自动同步。",
            evidence: "README.md「AI 连接与模型」「数据存放在哪里」",
        },
    },
    {
        question: "收费吗？用什么协议？",
        answer: {
            text: "应用本身开源，采用 MIT 协议。默默不提供模型服务，模型调用的额度与费用由你所选的供应商决定。",
            evidence: "README.md「许可」；README.md「音乐」供应商额度说明",
        },
    },
    {
        question: "安装包为什么没有签名？",
        answer: {
            text: "桌面版目前是测试版：Windows 安装包未签名，macOS 应用未经公证，首次打开可能出现系统安全提示。请只从 GitHub Releases 下载，并可用 SHA256 校验值核对安装包。",
            evidence: "docs/desktop-installation.md；README.md「下载与安装」",
        },
    },
];
