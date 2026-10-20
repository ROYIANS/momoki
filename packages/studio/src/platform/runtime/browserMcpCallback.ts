export const BROWSER_MCP_CALLBACK_PATH = "/mcp/oauth/callback";
export const BROWSER_MCP_CALLBACK_KIND = "momoki_mcp_oauth_callback";

/** Run before router, analytics and diagnostic initialization; the parent owns all credentials. */
export function handleBrowserMcpCallback(target: Window): boolean {
    if (target.location.pathname !== BROWSER_MCP_CALLBACK_PATH) return false;
    const params = new URLSearchParams(target.location.search);
    target.history.replaceState(null, "", BROWSER_MCP_CALLBACK_PATH);
    const fields: Record<string, string> = {};
    const allowed = new Set(["code", "state", "iss", "error"]);
    let valid = true;
    for (const [key, value] of params) {
        if (key === "error_description" || key === "error_uri") continue;
        if (!allowed.has(key) || key in fields || value.length > 4_096) {valid = false; break;}
        fields[key] = value;
    }
    const opener = target.opener as WindowProxy | null;
    if (valid && opener && fields.state && (!!fields.code !== !!fields.error)) {
        opener.postMessage({kind: BROWSER_MCP_CALLBACK_KIND, redirect: `${target.location.origin}${BROWSER_MCP_CALLBACK_PATH}`, fields}, target.location.origin);
    }
    const root = target.document.getElementById("root");
    if (root) root.textContent = valid && target.opener ? "请返回原窗口完成登录。" : "无法完成此登录，请返回原窗口重新发起。";
    return true;
}
