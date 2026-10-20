import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {ReactElement} from "react";

const host = vi.hoisted(() => ({
    cells: [] as unknown[], cursor: 0, pathname: "/settings", history: undefined as unknown, navigate: vi.fn(),
    narrow: false, setNavigationOpen: vi.fn(),
}));

// Execute production page callbacks and the shell's actual navigation builder.
// This host intentionally does not model browser layout or React scheduling.
vi.mock("react", async original => {
    const actual = await original<typeof import("react")>();
    return {...actual,
        useState: (initial: unknown) => {
            const index = host.cursor++;
            if (!(index in host.cells)) host.cells[index] = typeof initial === "function" ? initial() : initial;
            return [host.cells[index], (next: unknown) => {
                host.cells[index] = typeof next === "function" ? next(host.cells[index]) : next;
            }];
        },
        useRef: (initial: unknown) => {
            const index = host.cursor++;
            if (!(index in host.cells)) host.cells[index] = {current: initial};
            return host.cells[index];
        },
        useEffect: () => undefined,
        useContext: () => ({open: true, narrow: host.narrow, setOpen: host.setNavigationOpen}),
        useMemo: (compute: () => unknown) => compute(),
        useCallback: (callback: unknown) => callback,
        useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    };
});
vi.mock("@tanstack/react-router", async original => {
    const actual = await original<typeof import("@tanstack/react-router")>();
    return {...actual,
        useNavigate: () => host.navigate,
        useRouter: () => ({history: host.history}),
        useRouterState: ({select}: {select: (state: unknown) => unknown}) => select({location: {pathname: host.pathname}}),
    };
});
vi.mock("@/features/settings/ui/useAutoUpdateCheck", () => ({useAutoUpdateCheck: () => undefined}));
vi.mock("@/features/settings/ui/sections/GeneralSection", () => ({GeneralSection: () => null}));
vi.mock("@/features/settings/ui/sections/StorageSection", () => ({StorageSection: () => null}));
vi.mock("@/features/settings/ui/sections/UpdateSection", () => ({UpdateSection: () => null}));
vi.mock("@/platform/product/queries", () => ({useProductQuery: () => ({connectors: []})}));

import {createMemoryHistory, Link, isRedirect} from "@tanstack/react-router";
import {AppFrame} from "@/app/layout/AppFrame";
import {ModuleLayout} from "@/app/layout/ModuleLayout";
import {PageContent, PageHeader} from "@/app/layout/PageLayout";
import {SettingsPage} from "@/features/settings/ui/SettingsPage";
import {AppearanceSection} from "@/features/settings/ui/sections/AppearanceSection";
import {ConnectorsSection} from "@/features/settings/ui/ConnectorsPage";
import {McpConnectionsSettings} from "@/features/agent/mcp/ui/McpConnectionsSettings";
import {InstalledSkillsSettings} from "@/features/agent/ui/InstalledSkillsSettings";
import {GeneralSection} from "@/features/settings/ui/sections/GeneralSection";
import {UpdateSection} from "@/features/settings/ui/sections/UpdateSection";
import {AboutPage} from "@/features/settings/ui/AboutPage";
import {Route as SettingsRoute} from "@/app/routes/_studio.settings.tsx";
import {Route as ConnectorsRoute} from "@/app/routes/_studio.connectors.tsx";
import {Route as AboutRoute} from "@/app/routes/_studio.about.tsx";
import {getHistoryNavigation} from "@/app/navigation/historyNavigation";

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    const node = value as Node;
    return [node, ...nodes(node.props.children), ...(node.type === ModuleLayout ? nodes(node.props.navigation) : [])];
}
function draw(run: () => unknown) {
    host.cursor = 0;
    return nodes(run());
}
function navigationButtons(tree: Node[]) {
    return tree.filter(node => node.type === "button" && node.props.className === "module-nav-item");
}
function label(node: Node) {
    const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join("") : typeof value === "string" ? value : "";
    return text(node.props.children);
}
function search(tree: Node[], query: string) {
    const input = tree.find(node => node.type === "input" && node.props["aria-label"] === "搜索设置");
    expect(input).toBeDefined();
    (input!.props.onChange as (event: {target: {value: string}}) => void)({target: {value: query}});
}

beforeEach(() => {
    host.cells = [];
    host.cursor = 0;
    host.pathname = "/settings";
    host.narrow = false;
    host.history = createMemoryHistory({initialEntries: ["/settings"]});
    vi.stubGlobal("window", {matchMedia: () => ({matches: false})});
});
afterEach(() => {
    getHistoryNavigation(host.history as ReturnType<typeof createMemoryHistory>).destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("settings route compatibility", () => {
    it("renders the settings page without the former About redirect", () => {
        expect(SettingsRoute.options.beforeLoad).toBeUndefined();
        vi.spyOn(SettingsRoute, "useSearch").mockReturnValue({section: "update"});
        const tree = draw(() => (SettingsRoute.options.component as () => unknown)());
        const page = tree.find(node => node.type === SettingsPage);
        expect(page?.props.section).toBe("update");
        (page!.props.onSectionChange as (section: string) => void)("models");
        expect(host.navigate).toHaveBeenCalledWith({to: "/settings", search: {section: "models"}, replace: true});
    });

    it.each(["general", "appearance", "models", "mcp", "skills", "storage", "update"])("accepts the %s deep link", section => {
        const validate = SettingsRoute.options.validateSearch as (search: Record<string, unknown>) => unknown;
        expect(validate({section, irrelevant: "discard"})).toEqual({section});
    });

    it("maps the former connections deep link to the models section", () => {
        const validate = SettingsRoute.options.validateSearch as (search: Record<string, unknown>) => unknown;
        expect(validate({section: "connections"})).toEqual({section: "models"});
    });

    it.each([undefined, null, "", "updates", "General", ["update"], {}, 1])("ignores invalid section %j", section => {
        const validate = SettingsRoute.options.validateSearch as (search: Record<string, unknown>) => unknown;
        expect(validate({section, irrelevant: "discard"})).toEqual({});
    });

    it("redirects the old connectors path to the models section with replacement history", () => {
        let cause: unknown;
        try {(ConnectorsRoute.options.beforeLoad as () => void)();} catch (error) {cause = error;}
        expect(isRedirect(cause)).toBe(true);
        if (!isRedirect(cause)) throw new Error("Expected the production redirect");
        expect(cause.options).toMatchObject({to: "/settings", search: {section: "models"}, replace: true});
    });

    it("retains the independent About page", () => {
        expect(AboutRoute.options.beforeLoad).toBeUndefined();
        expect(AboutRoute.options.component).toBe(AboutPage);
    });
});

describe("rendered settings navigation and search", () => {
    it("opens general by default and executes real navigation callbacks for all seven sections", () => {
        const onSectionChange = vi.fn();
        const tree = draw(() => SettingsPage({onSectionChange}));
        const buttons = navigationButtons(tree);
        expect(buttons.map(label)).toEqual(["通用", "外观", "模型", "MCP", "技能", "存储", "关于与更新"]);
        expect(buttons.filter(node => node.props["aria-current"] === "page").map(label)).toEqual(["通用"]);
        expect(tree.some(node => node.type === GeneralSection)).toBe(true);
        buttons.forEach(button => (button.props.onClick as () => void)());
        expect(onSectionChange.mock.calls.map(([section]) => section)).toEqual(["general", "appearance", "models", "mcp", "skills", "storage", "update"]);
    });

    it.each([
        ["models", ConnectorsSection, "模型"],
        ["mcp", McpConnectionsSettings, "MCP"],
        ["skills", InstalledSkillsSettings, "技能"],
        ["appearance", AppearanceSection, "外观"],
        ["update", UpdateSection, "关于与更新"],
    ] as const)("renders the %s deep-linked section and its selected navigation", (section, component, title) => {
        const tree = draw(() => SettingsPage({section, onSectionChange: vi.fn()}));
        expect(tree.some(node => node.type === component)).toBe(true);
        expect(navigationButtons(tree).filter(node => node.props["aria-current"] === "page").map(label)).toEqual([title]);
    });

    it("matches a real row title even when its section name does not contain the query", () => {
        const onSectionChange = vi.fn();
        const render = () => SettingsPage({section: "general", onSectionChange});
        search(draw(render), " 界面语言 ");
        const tree = draw(render);
        expect(navigationButtons(tree).map(label)).toEqual(["外观"]);
        expect(tree.some(node => node.type === AppearanceSection)).toBe(true);
        expect(tree.some(node => node.type === GeneralSection)).toBe(false);
        const appearance = tree.find(node => node.type === AppearanceSection)!;
        const rows = nodes(AppearanceSection(appearance.props as Parameters<typeof AppearanceSection>[0]));
        expect(rows.some(node => node.props.title === "界面语言")).toBe(true);
        expect(rows.some(node => node.props.title === "主题")).toBe(false);
        expect(navigationButtons(tree).filter(node => node.props["aria-current"] === "page").map(label)).toEqual(["外观"]);
        expect(onSectionChange).not.toHaveBeenCalled();
    });

    it("finds authored keywords in the real page and restores the selected section when cleared", () => {
        const render = () => SettingsPage({section: "appearance", onSectionChange: vi.fn()});
        search(draw(render), "github");
        let tree = draw(render);
        expect(navigationButtons(tree).some(button => label(button) === "关于与更新")).toBe(true);
        search(tree, "");
        tree = draw(render);
        expect(navigationButtons(tree)).toHaveLength(7);
        expect(tree.some(node => node.type === AppearanceSection)).toBe(true);
        expect(navigationButtons(tree).filter(node => node.props["aria-current"] === "page").map(label)).toEqual(["外观"]);
    });

    it("exposes an empty state and no section content for unmatched search", () => {
        const render = () => SettingsPage({onSectionChange: vi.fn()});
        search(draw(render), "完全不存在的设置项");
        const tree = draw(render);
        expect(navigationButtons(tree)).toEqual([]);
        expect(tree.some(node => node.props.children === "没有匹配的设置项")).toBe(true);
        expect(tree.some(node => node.props.role === "status")).toBe(true);
        expect(tree.some(node => [GeneralSection, AppearanceSection, ConnectorsSection, UpdateSection].includes(node.type as typeof GeneralSection))).toBe(false);
    });

    it("closes the module overlay when selecting a section in a narrow window", () => {
        host.narrow = true;
        const onSectionChange = vi.fn();
        const tree = draw(() => SettingsPage({onSectionChange}));
        const connections = navigationButtons(tree).find(button => label(button) === "模型")!;
        (connections.props.onClick as () => void)();
        expect(onSectionChange).toHaveBeenCalledExactlyOnceWith("models");
        expect(host.setNavigationOpen).toHaveBeenCalledExactlyOnceWith(false);
    });

    it.each([
        ["general", "通用"], ["appearance", "外观"], ["models", "模型"], ["mcp", "MCP"], ["skills", "技能"], ["storage", "存储"], ["update", "关于与更新"],
    ])("places the %s title once in the common page wrapper", (section, title) => {
        const tree = draw(() => SettingsPage({section, onSectionChange: vi.fn()}));
        const headers = tree.filter(node => node.type === PageHeader);
        expect(headers).toHaveLength(1);
        expect(headers[0].props.title).toBe(title);
        expect(headers[0].props.description).toBeUndefined();
        const wrapper = tree.find(node => String(node.props.className ?? "").split(" ").includes("settings-content"));
        expect(wrapper).toBeDefined();
        expect(nodes(wrapper).some(node => node.type === PageHeader && node.props.title === title)).toBe(true);
    });
});

describe("connections embedded in settings", () => {
    it("retains its three subgroup controls and actual providers without a nested page title", () => {
        const tree = draw(() => ConnectorsSection());
        expect(tree.some(node => node.type === PageHeader || node.type === PageContent)).toBe(false);
        expect(tree.some(node => node.type === "h1")).toBe(false);
        const group = tree.find(node => node.props.role === "group" && node.props["aria-label"] === "连接分组");
        const buttons = nodes(group).filter(node => node.type === "button");
        expect(buttons.map(label)).toEqual(["模型连接", "网络搜索连接", "模型目录"]);
        expect(buttons.map(button => button.props["aria-pressed"])).toEqual([true, false, false]);
        expect(tree.some(node => node.props["aria-label"] === "安装 OpenAI 兼容 连接")).toBe(true);
        expect(tree.some(node => node.props.description && String(node.props.description).includes("密钥仅保存在本机，配置一次"))).toBe(false);
    });

    it("selects only the matching subgroup when settings search narrows connections", () => {
        const tree = draw(() => ConnectorsSection({visibleRowIds: ["catalog"]}));
        const group = tree.find(node => node.props.role === "group" && node.props["aria-label"] === "连接分组");
        const buttons = nodes(group).filter(node => node.type === "button");
        expect(buttons.map(label)).toEqual(["模型目录"]);
        expect(buttons[0].props["aria-pressed"]).toBe(true);
    });
});

describe("application rail settings highlight", () => {
    it.each(["/settings", "/about", "/connectors"])("selects settings at %s with no separate connections item", pathname => {
        host.pathname = pathname;
        const tree = draw(() => AppFrame({children: null}));
        const navigation = tree.find(node => node.type === "nav" && node.props["aria-label"] === "应用导航");
        expect(navigation).toBeDefined();
        const links = nodes(navigation).filter(node => node.type === Link);
        expect(links.filter(link => link.props["aria-current"] === "page").map(link => link.props.to)).toEqual(["/settings"]);
        expect(links.find(link => link.props.to === "/settings")?.props["aria-label"]).toBe("设置");
        expect(links.some(link => link.props.to === "/connectors")).toBe(false);
    });

    it("exposes exactly one settings entry, pinned as the last rail item", () => {
        const tree = draw(() => AppFrame({children: null}));
        const navigation = tree.find(node => node.type === "nav" && node.props["aria-label"] === "应用导航");
        const links = nodes(navigation).filter(node => node.type === Link);
        expect(links.filter(link => link.props.to === "/settings")).toHaveLength(1);
        expect(links.at(-1)?.props.to).toBe("/settings");
        // The topbar brand opens About, never settings.
        const topbar = tree.find(node => typeof node.type === "function" && node.type.name === "AppTopbar")!;
        const header = (topbar.type as (props: unknown) => Node)(topbar.props);
        expect(nodes(header).filter(node => node.type === Link).map(node => node.props.to)).toEqual(["/about"]);
    });

    it("does not leave settings selected in the project workspace", () => {
        host.pathname = "/p/project/e/episode/shots";
        const tree = draw(() => AppFrame({children: null}));
        const navigation = tree.find(node => node.type === "nav" && node.props["aria-label"] === "应用导航");
        const links = nodes(navigation).filter(node => node.type === Link);
        expect(links.filter(link => link.props["aria-current"] === "page").map(link => link.props.to)).toEqual(["/projects"]);
        expect(links.find(link => link.props.to === "/settings")?.props["aria-current"]).toBeUndefined();
    });
});
