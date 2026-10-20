export type RuntimeHttpPurpose =
    "configured"
    | "result-download"
    | "search-probe"
    | "model-catalog"
    | "release-check"
    | "release-asset";
/** `redirected` is set by the transport for every hop after the first. */
export type RuntimeHttpScope = { purpose: RuntimeHttpPurpose; probeOrigin?: string; redirected?: boolean };

/** Do not include rejected authored URLs (including signed query values) in errors. */
export function remoteHttpUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("网络请求地址无效");
    }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
        throw new Error("仅支持不含账号信息的 HTTP(S) 请求地址");
    return url;
}

async function configuredOrigins(): Promise<Set<string>> {
    const {db} = await import("./store");
    const [connectors, search] = await Promise.all([
        db.connectors.toArray(), db.searchConnections.get("tavily"),
    ]);
    const origins = new Set<string>();
    for (const connector of connectors) {
        try {
            origins.add(remoteHttpUrl(connector.baseUrl).origin);
        } catch { /* Invalid config grants nothing. */
        }
    }
    if (search?.enabled && search.apiKey) origins.add("https://api.tavily.com");
    return origins;
}

/** Fixed, public Models.dev catalog document. Nothing else is reachable through the model-catalog purpose. */
export const MODEL_CATALOG_URL = "https://models.dev/api.json";
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie", "cookie2", "x-api-key", "api-key", "x-goog-api-key"];

/** Independent of configured connectors: exactly one anonymous GET, re-evaluated for every redirect hop. */
function authorizeModelCatalog(url: URL, method: string, headers: Headers, body: BodyInit | null | undefined): {
    origin: string;
    allowHttp: boolean
} {
    if (url.href !== MODEL_CATALOG_URL || method !== "GET" || body != null || CREDENTIAL_HEADERS.some(key => headers.has(key)))
        throw new Error("模型目录同步只能匿名 GET 访问 models.dev 的固定地址");
    return {origin: url.origin, allowHttp: false};
}

/** Fixed, public GitHub release listing for the desktop update check. */
export const RELEASE_CHECK_URL = "https://api.github.com/repos/ROYIANS/momoki/releases?per_page=30";
const RELEASE_ASSET_PREFIX = "https://github.com/ROYIANS/momoki/releases/download/";
const RELEASE_ASSET_REDIRECT_ORIGINS = new Set(["https://objects.githubusercontent.com", "https://release-assets.githubusercontent.com"]);

function assertAnonymousGet(method: string, headers: Headers, body: BodyInit | null | undefined, message: string): void {
    if (method !== "GET" || body != null || CREDENTIAL_HEADERS.some(key => headers.has(key))) throw new Error(message);
}

/** Independent of configured connectors: one anonymous GET, re-evaluated for every redirect hop. */
function authorizeReleaseCheck(url: URL, method: string, headers: Headers, body: BodyInit | null | undefined): {
    origin: string;
    allowHttp: boolean
} {
    const message = "检查更新只能匿名 GET 访问 GitHub 发布列表的固定地址";
    assertAnonymousGet(method, headers, body, message);
    if (url.href !== RELEASE_CHECK_URL) throw new Error(message);
    return {origin: url.origin, allowHttp: false};
}

/** The first request must sit under the release download path (URL-normalized); only redirects may reach the CDN hosts. */
function authorizeReleaseAsset(url: URL, method: string, headers: Headers, body: BodyInit | null | undefined, redirected: boolean): {
    origin: string;
    allowHttp: boolean
} {
    const message = "安装包下载只能匿名 GET 访问本项目的发布文件";
    assertAnonymousGet(method, headers, body, message);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error(message);
    const underRelease = url.href.startsWith(RELEASE_ASSET_PREFIX);
    const cdn = redirected && RELEASE_ASSET_REDIRECT_ORIGINS.has(url.origin);
    if (!underRelease && !cdn) throw new Error(message);
    return {origin: url.origin, allowHttp: false};
}

/** Native ACL grants persist until restart; this policy rechecks current app configuration. */
export async function authorizeRuntimeHttp(
    url: URL, method: string, headers: Headers, body: BodyInit | null | undefined, scope: RuntimeHttpScope,
): Promise<{ origin: string; allowHttp: boolean }> {
    if (scope.purpose === "model-catalog") return authorizeModelCatalog(url, method, headers, body);
    if (scope.purpose === "release-check") return authorizeReleaseCheck(url, method, headers, body);
    if (scope.purpose === "release-asset") return authorizeReleaseAsset(url, method, headers, body, scope.redirected === true);
    const origins = await configuredOrigins();
    const configured = origins.has(url.origin);
    if (scope.purpose === "result-download") {
        if (method !== "GET" || body != null ||
            ["authorization", "proxy-authorization", "cookie", "cookie2", "x-api-key", "api-key"].some(key => headers.has(key)))
            throw new Error("结果下载只能使用不含鉴权信息的 GET 请求");
        if (url.protocol === "http:" && !configured) throw new Error("结果下载需使用 HTTPS 或明确配置的 HTTP 地址");
    } else if (scope.probeOrigin) {
        if (url.origin !== scope.probeOrigin && !configured) throw new Error("连接测试重定向到了未配置的地址");
    } else if (scope.purpose === "search-probe") {
        if (url.origin !== "https://api.tavily.com") throw new Error("搜索连接测试地址无效");
    } else if (!configured) {
        throw new Error("网络请求地址不属于当前连接配置，请在连接页检查设置");
    }
    return {origin: url.origin, allowHttp: url.protocol === "http:"};
}
