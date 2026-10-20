import {discoverOAuthServerInfo, startAuthorization, exchangeAuthorization, refreshAuthorization, registerClient,
    validateAuthorizationResponseIssuer, selectResourceURL, type OAuthServerInfo, type OAuthClientInformationMixed,
    type OAuthTokens} from "@modelcontextprotocol/client";
import type {McpOAuthStatus, McpPrivateConfig} from "./mcp";
import {McpHostError} from "./mcpErrors";
import {BROWSER_MCP_CALLBACK_KIND, BROWSER_MCP_CALLBACK_PATH} from "./browserMcpCallback";
import {browserMcpDigest, browserMcpId, browserMcpJson} from "./browserMcpData";
import {createBoundedMcpFetch} from "./browserMcpFetch";
import {z} from "zod";
export {handleBrowserMcpCallback} from "./browserMcpCallback";

type Remote = Extract<McpPrivateConfig, {transport: "streamable_http"}>;
interface Credential {
    readonly info: OAuthServerInfo; readonly client: OAuthClientInformationMixed; readonly resource?: URL;
    readonly endpoint: string; tokens: OAuthTokens; scopes: string; expiresAt: number;
    refresh?: Promise<{token: string; principal: string}>;
    refreshController?: AbortController;
}
interface Attempt {
    readonly id: string; readonly key: string; readonly popup: Window; readonly controller: AbortController;
    readonly state: string; readonly redirect: string; readonly current: () => Promise<boolean>; readonly isCurrent: () => boolean;
    status: McpOAuthStatus["state"]; info?: OAuthServerInfo; client?: OAuthClientInformationMixed;
    resource?: URL; verifier?: string; readonly endpoint: string; readonly scopes: string;
    timer: ReturnType<typeof setTimeout>;
}
const scopes = (value: string) => [...new Set(value.split(" ").filter(Boolean))].sort().join(" ");
const callbackSchema = z.object({kind: z.literal(BROWSER_MCP_CALLBACK_KIND), redirect: z.string().max(4_096),
    fields: z.object({state: z.string().min(1).max(4_096), code: z.string().min(1).max(4_096).optional(),
        error: z.string().min(1).max(4_096).optional(), iss: z.string().max(4_096).optional()}).strict()}).strict();
function callbackFields(raw: unknown, attempt: Attempt) {
    const parsed = callbackSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const {fields, redirect} = parsed.data, metadata = attempt.info?.authorizationServerMetadata;
    if (redirect !== attempt.redirect || fields.state !== attempt.state || !!fields.code === !!fields.error) return undefined;
    try {validateAuthorizationResponseIssuer({iss: fields.iss, expectedIssuer: metadata?.issuer,
        issParameterSupported: metadata?.authorization_response_iss_parameter_supported === true}); return fields;} catch {return undefined;}
}
async function publicClient(info: OAuthServerInfo, config: Remote, redirect: string, fetchFn: typeof fetch): Promise<OAuthClientInformationMixed> {
    const metadata = info.authorizationServerMetadata;
    if (!metadata?.issuer || !metadata.authorization_endpoint || !metadata.token_endpoint
        || metadata.token_endpoint_auth_methods_supported && !metadata.token_endpoint_auth_methods_supported.includes("none")) throw new McpHostError("unsupported", "not_started", "oauth_registration");
    if (config.auth.kind !== "oauth") throw new McpHostError("invalid", "not_started", "oauth_registration");
    if (config.auth.clientId) return {client_id: config.auth.clientId};
    if (!metadata.registration_endpoint) throw new McpHostError("unsupported", "not_started", "oauth_registration");
    const client = await registerClient(info.authorizationServerUrl, {metadata, clientMetadata: publicMetadata(redirect), fetchFn});
    if (client.client_secret) throw new McpHostError("unsupported", "not_started", "oauth_registration");
    return client;
}
function publicMetadata(redirect: string) {return {client_name: "Momoki", redirect_uris: [redirect], token_endpoint_auth_method: "none" as const,
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"]};}
function principal(credential: Credential): string {
    return browserMcpDigest(JSON.stringify([credential.endpoint, credential.resource?.href, credential.info.authorizationServerMetadata?.issuer,
        credential.client.client_id, credential.scopes]));
}

/** Public-client OAuth only. All state/credentials die with this browser owner. */
export function createBrowserMcpOAuth(options: {readonly window?: Window; readonly fetch?: typeof fetch; readonly timeoutMs?: number; readonly requestTimeoutMs?: number;
    readonly track?: (key: string, task: Promise<unknown>) => void}) {
    const target = options.window;
    let reserved: Window | undefined, closed = false;
    const attempts = new Map<string, Attempt>(), credentials = new Map<string, Credential>();
    const request = (key: string, signal?: AbortSignal) => createBoundedMcpFetch({fetch: options.fetch, maximumBytes: 65_536, timeoutMs: options.requestTimeoutMs,
        signal, oneShotBody: true, onTask: task => options.track?.(key, task)});
    function finish(attempt: Attempt, state: McpOAuthStatus["state"]): void {
        if (attempt.status !== "pending") return;
        attempt.status = state;
        clearTimeout(attempt.timer);
        attempt.controller.abort();
        attempt.verifier = undefined;
        try {attempt.popup.close();} catch { /* No authority depends on a window closing. */ }
    }
    const cancelReserved = () => {try {reserved?.close();} finally {reserved = undefined;}};
    const listener = (event: MessageEvent<unknown>) => {
        if (closed || !target || event.origin !== target.location.origin) return;
        const attempt = [...attempts.values()].find(value => value.status === "pending" && value.popup === event.source);
        if (!attempt?.info || !attempt.client || !attempt.verifier) return;
        let fields: ReturnType<typeof callbackFields>;
        try {fields = callbackFields(JSON.parse(browserMcpJson(event.data, 16_384)) as unknown, attempt);} catch {return;}
        if (!fields) return;
        if (fields.error !== undefined) {finish(attempt, "failed"); return;}
        if (!fields.code) return;
        const code = fields.code, verifier = attempt.verifier, info = attempt.info, client = attempt.client;
        // Consume before the first await; duplicate callbacks cannot redeem the code twice.
        attempt.verifier = undefined;
        const exchange = (async () => {
            try {
                if (!await attempt.current() || !attempt.isCurrent() || attempt.status !== "pending") {finish(attempt, "canceled"); return;}
                const tokens = await exchangeAuthorization(info.authorizationServerUrl, {metadata: info.authorizationServerMetadata,
                    clientInformation: client, authorizationCode: code, iss: fields.iss, codeVerifier: verifier,
                    redirectUri: attempt.redirect, resource: attempt.resource, fetchFn: request(attempt.key, attempt.controller.signal)});
                if (!await attempt.current() || !attempt.isCurrent() || attempt.status !== "pending") {finish(attempt, "canceled"); return;}
                browserMcpJson(tokens, 32_768);
                credentials.set(attempt.key, {info, client, resource: attempt.resource, endpoint: attempt.endpoint, tokens,
                    scopes: scopes(tokens.scope ?? attempt.scopes), expiresAt: Date.now() + (tokens.expires_in ?? 3_600) * 1_000});
                finish(attempt, "authorized");
            } catch {finish(attempt, "failed");}
        })();
        options.track?.(attempt.key, exchange);
    };
    target?.addEventListener("message", listener);
    return {
        reserve() {
            cancelReserved();
            if (closed || !target) throw new McpHostError("unsupported", "not_started", "oauth_popup");
            reserved = target.open("about:blank", "_blank", "popup,width=640,height=760") ?? undefined;
            if (!reserved) throw new McpHostError("unsupported", "not_started", "oauth_popup");
        },
        cancelReserved,
        async begin(input: {readonly key: string; readonly config: Remote; readonly current: () => Promise<boolean>; readonly isCurrent: () => boolean}) {
            const popup = reserved;
            reserved = undefined;
            if (closed || !target || !popup || popup.closed) throw new McpHostError("unsupported", "not_started", "oauth_popup");
            if (attempts.size >= 64) {
                const settled = [...attempts.values()].find(attempt => attempt.status !== "pending");
                if (settled) attempts.delete(settled.id);
                else {popup.close(); throw new McpHostError("limit", "not_started", "oauth_popup");}
            }
            const id = browserMcpId("login"), state = browserMcpId("state");
            const attempt: Attempt = {id, key: input.key, popup, state, current: input.current, isCurrent: input.isCurrent, endpoint: input.config.endpoint,
                scopes: input.config.auth.kind === "oauth" ? input.config.auth.scopes.join(" ") : "", redirect: `${target.location.origin}${BROWSER_MCP_CALLBACK_PATH}`,
                controller: new AbortController(), status: "pending", timer: setTimeout(() => undefined, 0)};
            clearTimeout(attempt.timer);
            attempt.timer = setTimeout(() => finish(attempt, "expired"), options.timeoutMs ?? 300_000);
            attempts.set(id, attempt);
            try {
                if (input.config.auth.kind !== "oauth" || !await input.current()) throw new McpHostError("retired", "not_started", id);
                const info = await discoverOAuthServerInfo(input.config.endpoint, {fetchFn: request(input.key, attempt.controller.signal)});
                const metadata = info.authorizationServerMetadata;
                const clientMetadata = publicMetadata(attempt.redirect);
                const client = await publicClient(info, input.config, attempt.redirect, request(input.key, attempt.controller.signal));
                const resource = await selectResourceURL(input.config.endpoint, {redirectUrl: attempt.redirect, clientMetadata,
                    clientInformation: () => client, tokens: () => undefined, saveTokens: () => undefined,
                    redirectToAuthorization: () => undefined, saveCodeVerifier: () => undefined, codeVerifier: () => ""}, info.resourceMetadata);
                const result = await startAuthorization(info.authorizationServerUrl, {metadata, clientInformation: client, redirectUrl: attempt.redirect,
                    scope: attempt.scopes || undefined, state, resource});
                if (!await input.current() || !input.isCurrent() || attempt.status !== "pending" || popup.closed) throw new McpHostError("retired", "not_started", id);
                attempt.info = info; attempt.client = client; attempt.resource = resource; attempt.verifier = result.codeVerifier;
                popup.location.href = result.authorizationUrl.href;
                return {attemptId: id};
            } catch (error) {finish(attempt, "failed"); throw error instanceof McpHostError ? error : new McpHostError("oauth_failed", "not_started", id);}
        },
        status(id: string): McpOAuthStatus {
            const attempt = attempts.get(id);
            if (!attempt) throw new McpHostError("retired", "not_started", id);
            if (attempt.status === "pending" && attempt.popup.closed) finish(attempt, "canceled");
            return {attemptId: id, state: attempt.status};
        },
        cancel(id: string) {const attempt = attempts.get(id); if (attempt) finish(attempt, "canceled");},
        retire(key: string) {credentials.get(key)?.refreshController?.abort(); for (const attempt of attempts.values()) if (attempt.key === key) finish(attempt, "canceled");},
        clear(key: string) {credentials.get(key)?.refreshController?.abort(); credentials.delete(key); for (const attempt of attempts.values()) if (attempt.key === key) finish(attempt, "canceled");},
        async token(key: string, current: () => Promise<boolean>, isCurrent: () => boolean): Promise<{token: string; principal: string}> {
            const credential = credentials.get(key);
            if (closed || !credential || !await current() || !isCurrent()) throw new McpHostError("auth_required", "not_started", "oauth_token");
            if (credential.expiresAt > Date.now() + 5_000) return {token: credential.tokens.access_token, principal: principal(credential)};
            if (credential.refresh) return credential.refresh;
            const controller = new AbortController();
            credential.refreshController = controller;
            const refresh = async () => {
                if (!credential.tokens.refresh_token) throw new McpHostError("auth_required", "not_started", "oauth_token");
                const tokens = await refreshAuthorization(credential.info.authorizationServerUrl, {metadata: credential.info.authorizationServerMetadata,
                    clientInformation: credential.client, refreshToken: credential.tokens.refresh_token, resource: credential.resource, fetchFn: request(key, controller.signal)});
                if (closed || credentials.get(key) !== credential || !await current() || !isCurrent()) throw new McpHostError("retired", "not_started", "oauth_token");
                browserMcpJson(tokens, 32_768);
                credential.tokens = tokens;
                credential.scopes = scopes(tokens.scope ?? credential.scopes);
                credential.expiresAt = Date.now() + (tokens.expires_in ?? 3_600) * 1_000;
                return {token: tokens.access_token, principal: principal(credential)};
            };
            credential.refresh = refresh().catch(() => {throw new McpHostError("auth_required", "not_started", "oauth_token");});
            options.track?.(key, credential.refresh);
            try {return await credential.refresh;} finally {credential.refresh = undefined; credential.refreshController = undefined;}
        },
        dispose() {closed = true; cancelReserved(); for (const attempt of attempts.values()) finish(attempt, "canceled");
            for (const credential of credentials.values()) credential.refreshController?.abort();
            credentials.clear(); target?.removeEventListener("message", listener);},
    };
}
