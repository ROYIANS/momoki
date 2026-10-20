import {afterEach, describe, expect, it, vi} from "vitest";
import {db} from "@/platform/product/store";
import {createRuntimeFetch, runtimeFetchFor, type RuntimeFetchServices} from "@/platform/runtime/runtimeFetch";
import {authorizeRuntimeHttp} from "@/platform/product/httpPolicy";

afterEach(() => vi.restoreAllMocks());

const ASSET = "https://github.com/ROYIANS/momoki/releases/download/desktop-v0.1.3/Momoki_0.1.3_windows_x64_setup.exe";
const OBJECTS = "https://objects.githubusercontent.com/github-production-release-asset/1/Momoki_0.1.3_windows_x64_setup.exe?sig=x";
const RELEASE_ASSETS = "https://release-assets.githubusercontent.com/github-production-release-asset/2/file?sig=y";

function services() {
    return {
        native: () => true,
        webFetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("web")),
        nativeFetch: vi.fn<RuntimeFetchServices["nativeFetch"]>().mockImplementation(async () => new Response("native")),
        grant: vi.fn<RuntimeFetchServices["grant"]>().mockResolvedValue(undefined),
        authorize: authorizeRuntimeHttp,
    };
}

const assetFetch = (deps: ReturnType<typeof services>) => createRuntimeFetch(deps, {purpose: "release-asset"});

describe("release-asset purpose", () => {
    it("allows an anonymous GET of a file under the project's release download path", async () => {
        const deps = services();
        expect(await (await assetFetch(deps)(ASSET, {method: "GET"})).text()).toBe("native");
        expect(deps.grant).toHaveBeenCalledExactlyOnceWith("https://github.com", false);
        expect(deps.nativeFetch).toHaveBeenCalledOnce();
        expect(runtimeFetchFor("release-asset")).toBe(runtimeFetchFor("release-asset"));
    });

    it.each([
        ["%2e%2e escape", "https://github.com/ROYIANS/momoki/releases/download/%2e%2e/%2e%2e/evil/Momoki_0.1.3_windows_x64_setup.exe"],
        ["dot-segment escape", "https://github.com/ROYIANS/momoki/releases/download/../../evil/Momoki_0.1.3_windows_x64_setup.exe"],
        ["other repository path", "https://github.com/ROYIANS/momoki/archive/refs/heads/main.zip"],
        ["the releases list page", "https://github.com/ROYIANS/momoki/releases"],
        ["another repository", "https://github.com/other/repo/releases/download/desktop-v0.1.3/a.dmg"],
        ["a lookalike host", "https://github.com.evil.example/ROYIANS/momoki/releases/download/desktop-v0.1.3/a.dmg"],
        ["downgraded to http", "http://github.com/ROYIANS/momoki/releases/download/desktop-v0.1.3/a.dmg"],
        ["the CDN host as the first request", OBJECTS],
        ["the release-assets host as the first request", RELEASE_ASSETS],
        ["an unrelated host", "https://evil.example/Momoki_0.1.3_windows_x64_setup.exe"],
    ])("rejects %s before any native traffic", async (_name, target) => {
        const deps = services();
        await expect(assetFetch(deps)(target)).rejects.toThrow();
        expect(deps.grant).not.toHaveBeenCalled();
        expect(deps.nativeFetch).not.toHaveBeenCalled();
    });

    it("rejects a URL carrying credentials even on the allowed path", async () => {
        const deps = services();
        await expect(assetFetch(deps)("https://user:pass@github.com/ROYIANS/momoki/releases/download/desktop-v0.1.3/a.dmg")).rejects.toThrow("不含账号信息");
        expect(deps.nativeFetch).not.toHaveBeenCalled();
    });

    it("cannot forge redirect permission on the initial request through a supplied scope", async () => {
        const deps = services();
        const fetchImpl = createRuntimeFetch(deps, {purpose: "release-asset", redirected: true});
        await expect(fetchImpl(OBJECTS)).rejects.toThrow("匿名 GET");
        expect(deps.grant).not.toHaveBeenCalled();
        expect(deps.nativeFetch).not.toHaveBeenCalled();
    });

    it.each(["POST", "PUT", "DELETE", "HEAD"])("rejects method %s", async method => {
        const deps = services();
        await expect(assetFetch(deps)(ASSET, {method})).rejects.toThrow("匿名 GET");
        expect(deps.nativeFetch).not.toHaveBeenCalled();
    });

    it("rejects a body", async () => {
        const deps = services();
        await expect(assetFetch(deps)(ASSET, {method: "GET", body: "x"})).rejects.toThrow("匿名 GET");
        expect(deps.nativeFetch).not.toHaveBeenCalled();
    });

    it.each(["Authorization", "Cookie", "X-Api-Key"])("rejects credential header %s", async name => {
        const deps = services();
        await expect(assetFetch(deps)(ASSET, {headers: {[name]: "secret"}})).rejects.toThrow("匿名 GET");
        expect(deps.nativeFetch).not.toHaveBeenCalled();
    });

    it.each([OBJECTS, RELEASE_ASSETS])("follows the GitHub redirect to %s and re-authorizes that hop", async target => {
        const deps = services();
        const authorize = vi.fn(deps.authorize);
        deps.authorize = authorize;
        deps.nativeFetch.mockResolvedValueOnce(new Response(null, {status: 302, headers: {location: target}})).mockResolvedValueOnce(new Response("payload"));
        expect(await (await assetFetch(deps)(ASSET)).text()).toBe("payload");
        expect(authorize).toHaveBeenCalledTimes(2);
        expect(deps.grant).toHaveBeenLastCalledWith(new URL(target).origin, false);
    });

    it("rejects a redirect to a host outside the two allowed CDN hosts", async () => {
        const deps = services();
        deps.nativeFetch.mockResolvedValueOnce(new Response(null, {status: 302, headers: {location: "https://evil.example/file"}}));
        await expect(assetFetch(deps)(ASSET)).rejects.toThrow("匿名 GET");
        expect(deps.nativeFetch).toHaveBeenCalledOnce();
        expect(deps.grant).toHaveBeenCalledOnce();
    });

    it("rejects a redirect to a dotted lookalike of an allowed CDN host", async () => {
        const deps = services();
        deps.nativeFetch.mockResolvedValueOnce(new Response(null, {status: 302, headers: {location: "https://objects.githubusercontent.com.evil.example/a"}}));
        await expect(assetFetch(deps)(ASSET)).rejects.toThrow("匿名 GET");
    });

    it("rejects a redirect to a different port on an allowed host", async () => {
        const deps = services();
        deps.nativeFetch.mockResolvedValueOnce(new Response(null, {status: 302, headers: {location: "https://objects.githubusercontent.com:8443/a"}}));
        await expect(assetFetch(deps)(ASSET)).rejects.toThrow("匿名 GET");
    });

    it("rejects a CDN redirect downgraded to http", async () => {
        const deps = services();
        deps.nativeFetch.mockResolvedValueOnce(new Response(null, {status: 307, headers: {location: "http://objects.githubusercontent.com/a"}}));
        await expect(assetFetch(deps)(ASSET)).rejects.toThrow("匿名 GET");
    });

    it("does not add the CDN hosts to the configured purpose or to a release check", async () => {
        const deps = services();
        await assetFetch(deps)(ASSET);
        await db.connectors.clear();
        await expect(createRuntimeFetch(deps)(ASSET)).rejects.toThrow("当前连接配置");
        await expect(createRuntimeFetch(deps, {purpose: "release-check"})(ASSET)).rejects.toThrow("匿名 GET");
    });

    it("propagates cancellation without sending", async () => {
        const deps = services();
        const controller = new AbortController();
        controller.abort(new DOMException("stop", "AbortError"));
        await expect(assetFetch(deps)(ASSET, {signal: controller.signal})).rejects.toMatchObject({name: "AbortError"});
        expect(deps.nativeFetch).not.toHaveBeenCalled();
    });
});
