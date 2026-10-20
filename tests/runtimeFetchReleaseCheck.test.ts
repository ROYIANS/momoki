import {afterEach, describe, expect, it, vi} from "vitest";
import {db} from "@/platform/product/store";
import {createRuntimeFetch, runtimeFetchFor, type RuntimeFetchServices} from "@/platform/runtime/runtimeFetch";
import {RELEASE_CHECK_URL, authorizeRuntimeHttp} from "@/platform/product/httpPolicy";

afterEach(() => vi.restoreAllMocks());

function services() {
    return {
        native: () => true,
        webFetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("web")),
        nativeFetch: vi.fn<RuntimeFetchServices["nativeFetch"]>().mockImplementation(async () => new Response("native")),
        grant: vi.fn<RuntimeFetchServices["grant"]>().mockResolvedValue(undefined),
        authorize: authorizeRuntimeHttp,
    };
}

const releaseCheck = (deps: ReturnType<typeof services>) => createRuntimeFetch(deps, {purpose: "release-check"});

describe("release-check purpose", () => {
    it("allows exactly the anonymous GET of the fixed releases URL, with no configured connector", async () => {
        const deps = services();
        expect(await (await releaseCheck(deps)(RELEASE_CHECK_URL, {method: "GET", headers: {Accept: "application/vnd.github+json"}})).text()).toBe("native");
        expect(deps.grant).toHaveBeenCalledExactlyOnceWith("https://api.github.com", false);
        expect(deps.nativeFetch).toHaveBeenCalledOnce();
        expect(runtimeFetchFor("release-check")).toBe(runtimeFetchFor("release-check"));
    });

    it.each([
        "https://api.github.com/repos/ROYIANS/momoki/releases",
        "https://api.github.com/repos/ROYIANS/momoki/releases?per_page=100",
        "https://api.github.com/repos/ROYIANS/momoki/releases?per_page=30&page=2",
        "https://api.github.com/repos/ROYIANS/momoki/releases?",
        "https://api.github.com/repos/ROYIANS/momoki/releases?per_page=30#frag",
        "https://api.github.com/repos/ROYIANS/momoki/releases/latest",
        "https://api.github.com/repos/ROYIANS/momoki",
        "https://api.github.com/repos/other/repo/releases?per_page=30",
        "https://api.github.com:8443/repos/ROYIANS/momoki/releases?per_page=30",
        "https://api.github.com.evil.example/repos/ROYIANS/momoki/releases?per_page=30",
        "https://evil.example/repos/ROYIANS/momoki/releases?per_page=30",
        "http://api.github.com/repos/ROYIANS/momoki/releases?per_page=30",
    ])("rejects %s before any native traffic", async target => {
        const deps = services();
        await expect(releaseCheck(deps)(target)).rejects.toThrow();
        expect(deps.grant).not.toHaveBeenCalled();
        expect(deps.nativeFetch).not.toHaveBeenCalled();
    });

    it.each(["POST", "PUT", "DELETE", "HEAD"])("rejects method %s", async method => {
        const deps = services();
        await expect(releaseCheck(deps)(RELEASE_CHECK_URL, {method})).rejects.toThrow("匿名 GET");
        expect(deps.nativeFetch).not.toHaveBeenCalled();
    });

    it("rejects a body", async () => {
        const deps = services();
        await expect(releaseCheck(deps)(RELEASE_CHECK_URL, {method: "GET", body: "x"})).rejects.toThrow();
        expect(deps.nativeFetch).not.toHaveBeenCalled();
    });

    it.each(["Authorization", "Proxy-Authorization", "Cookie", "Cookie2", "X-Api-Key", "Api-Key", "X-Goog-Api-Key"])("rejects credential header %s", async name => {
        const deps = services();
        await expect(releaseCheck(deps)(RELEASE_CHECK_URL, {headers: {[name]: "secret"}})).rejects.toThrow("匿名 GET");
        expect(deps.nativeFetch).not.toHaveBeenCalled();
    });

    it("re-authorizes every redirect hop: a foreign target is rejected before it is sent", async () => {
        const deps = services();
        deps.nativeFetch.mockResolvedValueOnce(new Response(null, {status: 302, headers: {location: "https://evil.example/releases"}}));
        await expect(releaseCheck(deps)(RELEASE_CHECK_URL)).rejects.toThrow("匿名 GET");
        expect(deps.nativeFetch).toHaveBeenCalledOnce();
        expect(deps.grant).toHaveBeenCalledOnce();
    });

    it("rejects a redirect to another api.github.com path", async () => {
        const deps = services();
        deps.nativeFetch.mockResolvedValueOnce(new Response(null, {status: 301, headers: {location: "/repos/ROYIANS/momoki"}}));
        await expect(releaseCheck(deps)(RELEASE_CHECK_URL)).rejects.toThrow("匿名 GET");
        expect(deps.nativeFetch).toHaveBeenCalledOnce();
    });

    it("rejects a redirect downgraded to http", async () => {
        const deps = services();
        deps.nativeFetch.mockResolvedValueOnce(new Response(null, {status: 307, headers: {location: "http://api.github.com/repos/ROYIANS/momoki/releases?per_page=30"}}));
        await expect(releaseCheck(deps)(RELEASE_CHECK_URL)).rejects.toThrow();
        expect(deps.nativeFetch).toHaveBeenCalledOnce();
    });

    it("follows a redirect back to the same allowed URL and re-authorizes that hop", async () => {
        const deps = services();
        const authorize = vi.fn(deps.authorize);
        deps.authorize = authorize;
        deps.nativeFetch.mockResolvedValueOnce(new Response(null, {status: 302, headers: {location: RELEASE_CHECK_URL}})).mockResolvedValueOnce(new Response("ok"));
        expect(await (await releaseCheck(deps)(RELEASE_CHECK_URL)).text()).toBe("ok");
        expect(authorize).toHaveBeenCalledTimes(2);
    });

    it("propagates cancellation without sending", async () => {
        const deps = services();
        const controller = new AbortController();
        controller.abort(new DOMException("stop", "AbortError"));
        await expect(releaseCheck(deps)(RELEASE_CHECK_URL, {signal: controller.signal})).rejects.toMatchObject({name: "AbortError"});
        expect(deps.nativeFetch).not.toHaveBeenCalled();
    });

    it("never widens the configured purpose: an allowed check grants no other origin", async () => {
        const deps = services();
        await releaseCheck(deps)(RELEASE_CHECK_URL);
        await expect(createRuntimeFetch(deps)(RELEASE_CHECK_URL)).rejects.toThrow("当前连接配置");
        await db.connectors.clear();
    });
});
