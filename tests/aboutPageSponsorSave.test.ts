import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {ReactElement} from "react";

const host = vi.hoisted(() => ({cells: [] as unknown[], cursor: 0, save: vi.fn(), success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn()}));
vi.mock("react", async original => {
    const actual = await original<typeof import("react")>();
    return {...actual,
        useRef: (initial: unknown) => {
            const index = host.cursor++;
            if (!(index in host.cells)) host.cells[index] = {current: initial};
            return host.cells[index];
        },
        useState: (initial: unknown) => {
            const index = host.cursor++;
            if (!(index in host.cells)) host.cells[index] = initial;
            return [host.cells[index], (value: unknown) => {host.cells[index] = value;}];
        },
    };
});
vi.mock("sonner", () => ({toast: {success: host.success, info: host.info, error: host.error, warning: host.warning}}));
vi.mock("@/platform/runtime/nativeSystemServices", () => ({saveNativeBlob: host.save}));

import {AboutPage} from "@/features/settings/ui/AboutPage";
import {Button} from "@/ui/button";
import {GITHUB_URL} from "@momoki/distribution/brand";

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    const node = value as Node;
    return [node, ...nodes(node.props.children)];
}
function render() {host.cursor = 0; return nodes(AboutPage());}
function saveButton() {
    const button = render().find(node => node.type === Button && typeof node.props.onClick === "function");
    if (!button) throw new Error("Native sponsor Save control was not rendered");
    return button;
}
function clickSave() {(saveButton().props.onClick as () => void)();}
const jpegBytes = new Uint8Array([255, 216, 255, 224, 0, 16, 7, 255, 217]);
const imageResponse = () => new Response(jpegBytes, {headers: {"Content-Type": "image/jpeg"}});

beforeEach(() => {
    host.cells = [];
    host.cursor = 0;
    vi.stubGlobal("window", {__TAURI_INTERNALS__: {invoke: vi.fn()}});
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const mock of [host.save, host.success, host.info, host.error, host.warning]) mock.mockReset();
});

describe("About sponsor export caller", () => {
    it("fetches the bundled image once and waits for the real common save boundary before success", async () => {
        const fetcher = vi.fn<typeof fetch>(async () => imageResponse());
        vi.stubGlobal("fetch", fetcher);
        let finish: (value: "saved") => void = () => {throw new Error("Save not started");};
        host.save.mockImplementation(() => new Promise<"saved">(resolve => {finish = resolve;}));
        expect(saveButton().props.children).toBe("保存赞赏码");
        clickSave();
        clickSave(); // Two events before a React rerender must share the busy guard.
        expect(fetcher).toHaveBeenCalledExactlyOnceWith("/brand/sponsor-wechat.jpg");
        await vi.waitFor(() => expect(host.save).toHaveBeenCalledOnce());
        const blob = host.save.mock.calls[0][0] as Blob;
        expect(blob.type).toBe("image/jpeg");
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(jpegBytes);
        expect(host.save).toHaveBeenCalledWith(blob, "默默-微信赞赏码.jpg", undefined);
        expect(saveButton().props).toMatchObject({disabled: true, children: "正在保存赞赏码…", variant: "outline"});
        expect(host.success).not.toHaveBeenCalled();
        finish("saved");
        await vi.waitFor(() => expect(host.success).toHaveBeenCalledExactlyOnceWith("赞赏码已保存"));
        expect(saveButton().props.disabled).toBe(false);
        expect(host.info).not.toHaveBeenCalled();
        expect(host.error).not.toHaveBeenCalled();
    });

    it("shows native cancellation accurately and releases the pending control", async () => {
        vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => imageResponse()));
        host.save.mockResolvedValue("canceled");
        clickSave();
        await vi.waitFor(() => expect(host.info).toHaveBeenCalledExactlyOnceWith("已取消保存赞赏码"));
        expect(saveButton().props.disabled).toBe(false);
        expect(host.success).not.toHaveBeenCalled();
        expect(host.error).not.toHaveBeenCalled();
        expect(host.save).toHaveBeenCalledOnce();
    });

    it.each([false, true])("distinguishes an unpublished failure from a saved file warning (published=%s)", async published => {
        vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => imageResponse()));
        const failure = published ? Object.assign(new Error("文件已保存，请检查最后保存步骤。"), {published: true}) : new Error("目标文件已存在");
        host.save.mockRejectedValue(failure);
        clickSave();
        await vi.waitFor(() => expect(published ? host.warning : host.error).toHaveBeenCalledOnce());
        if (published) {
            expect(host.warning).toHaveBeenCalledWith(failure.message);
            expect(host.error).not.toHaveBeenCalled();
        } else {
            expect(host.error).toHaveBeenCalledWith(`保存赞赏码失败：${failure.message}`);
            expect(host.warning).not.toHaveBeenCalled();
        }
        expect(saveButton().props.disabled).toBe(false);
        expect(host.success).not.toHaveBeenCalled();
        expect(host.info).not.toHaveBeenCalled();
        expect(host.save).toHaveBeenCalledOnce();
    });

    it.each(["missing", "empty", "fallback-page"])("does not save an invalid local image (%s), and a manual retry can succeed", async reason => {
        const bad = reason === "missing" ? new Response("not found", {status: 404})
            : reason === "empty" ? new Response(new Blob([], {type: "image/jpeg"}))
                : new Response("<html>app fallback</html>", {headers: {"Content-Type": "text/html"}});
        const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(bad).mockResolvedValueOnce(imageResponse());
        vi.stubGlobal("fetch", fetcher);
        host.save.mockResolvedValue("saved");
        clickSave();
        await vi.waitFor(() => expect(host.error).toHaveBeenCalledWith("保存赞赏码失败：赞赏码图片加载失败，请重试"));
        expect(host.save).not.toHaveBeenCalled();
        expect(saveButton().props.disabled).toBe(false);
        clickSave();
        await vi.waitFor(() => expect(host.success).toHaveBeenCalledWith("赞赏码已保存"));
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(host.save).toHaveBeenCalledOnce();
    });

    it("retains the browser's same-origin download anchor and filename", () => {
        vi.stubGlobal("window", {});
        const fetcher = vi.fn();
        vi.stubGlobal("fetch", fetcher);
        const anchor = render().find(node => node.type === "a" && "download" in node.props);
        expect(anchor?.props).toMatchObject({href: "/brand/sponsor-wechat.jpg", download: "默默-微信赞赏码.jpg", children: "保存赞赏码"});
        expect(render().some(node => node.type === Button && typeof node.props.onClick === "function")).toBe(false);
        expect(fetcher).not.toHaveBeenCalled();
        expect(host.save).not.toHaveBeenCalled();
    });

    it("retains external support links and uses device-local privacy language for both hosts", () => {
        const tree = render();
        expect(tree.find(node => node.type === "a" && node.props.href === GITHUB_URL)?.props).toMatchObject({target: "_blank", rel: "noreferrer"});
        expect(tree.find(node => node.type === "a" && node.props.href === "https://afdian.com/a/ROYIANS")?.props).toMatchObject({target: "_blank", rel: "noopener noreferrer"});
        const privacy = tree.filter(node => node.type === "li").map(node => String(node.props.children)).join("\n");
        expect(privacy).toContain("保存在当前设备的应用或浏览器中");
        expect(privacy).toContain("不会写入项目备份 ZIP");
        expect(privacy).not.toContain("IndexedDB");
    });
});
