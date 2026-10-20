import assert from "node:assert/strict";
import {createServer as createHttpServer} from "node:http";
import {createSecureServer} from "node:http2";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createServer} from "vite";

// Narrow browser-port fixture, not an application build or installed-host test.
const {chromium} = await import(process.env.MCP_PLAYWRIGHT_PATH ?? "playwright");
const output = process.env.MCP_BROWSER_EVIDENCE_DIR ?? await mkdtemp(join(tmpdir(), "momoki-mcp-browser-evidence-"));
await mkdir(output, {recursive: true});
const counters = new Map(), requests = [], observations = [], errors = [];
let appOrigin, remoteOrigin, browser, page;
let registrationCount = 0, tokenCount = 0;
let refreshedScope = "fixture.read";
const authorizationCodes = new Map(), refreshTokens = new Set();
const sessions = new Set();
const sourceFiles = ["pnpm-lock.yaml", "packages/studio/package.json", "tooling/mcp-browser-regression.mjs", "tests/fixtures/mcp-browser/harness.ts", "tests/fixtures/mcp-browser/index.html",
    ...["browserMcp", "browserMcpCallback", "browserMcpData", "browserMcpFetch", "browserMcpOAuth", "mcp", "mcpWire", "mcpErrors"].map(name => `packages/studio/src/platform/runtime/${name}.ts`),
    ...["connections", "configuration", "records", "manifest"].map(name => `packages/studio/src/features/agent/mcp/runtime/${name}.ts`),
    "packages/studio/src/features/agent/mcp/queries/catalogue.ts"];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash("sha256").update(await readFile(file)).digest("hex")])));
const sources = await sourceHashes();
// Ephemeral local fixture TLS only. The browser context explicitly trusts this test certificate.
const tlsDirectory = await mkdtemp(join(tmpdir(), "momoki-mcp-browser-tls-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(tlsDirectory, "key.pem"), "-out", join(tlsDirectory, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], {stdio: "ignore"});
function count(mode) {counters.set(mode, (counters.get(mode) ?? 0) + 1);}
function cors(req, res, allowed = true, expose = true) {
    if (allowed) {
        res.setHeader("Access-Control-Allow-Origin", appOrigin);
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] ?? "Content-Type,Authorization,MCP-Protocol-Version,MCP-Method,MCP-Name,MCP-Session-Id,X-Fixture-Marker");
        if (expose) res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id,WWW-Authenticate,MCP-Protocol-Version");
    }
}
function json(res, status, value) {res.writeHead(status, {"Content-Type": "application/json"}); res.end(JSON.stringify(value));}
async function body(req) {const chunks = []; for await (const chunk of req) {chunks.push(chunk); if (chunks.reduce((n, item) => n + item.length, 0) > 65536) throw new Error("Oversized fixture input");} return Buffer.concat(chunks).toString();}
const handler = (req, res) => {void (async () => {
    const url = new URL(req.url, remoteOrigin), mode = url.pathname.split("/").at(-1);
    cors(req, res, mode !== "denied", mode !== "hidden_session");
    requests.push({path: url.pathname, method: req.method});
    if (req.method === "OPTIONS") {res.writeHead(204); res.end(); return;}
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        json(res, 200, {resource: `${remoteOrigin}/mcp/oauth`, authorization_servers: [remoteOrigin], scopes_supported: ["fixture.read"]}); return;
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server") || url.pathname.startsWith("/.well-known/openid-configuration")) {
        json(res, 200, {issuer: remoteOrigin, authorization_endpoint: `${remoteOrigin}/authorize`, token_endpoint: `${remoteOrigin}/token`, registration_endpoint: `${remoteOrigin}/register`,
            response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: true}); return;
    }
    if (url.pathname === "/register") {
        const metadata = JSON.parse(await body(req)); registrationCount++;
        assert.equal(metadata.token_endpoint_auth_method, "none");
        assert(metadata.redirect_uris.every(value => value === `${appOrigin}/mcp/oauth/callback`));
        json(res, 201, {...metadata, client_id: "registered-public"}); return;
    }
    if (url.pathname === "/authorize") {
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        assert.equal(url.searchParams.get("redirect_uri"), `${appOrigin}/mcp/oauth/callback`);
        const code = `code_${authorizationCodes.size}`;
        authorizationCodes.set(code, {challenge: url.searchParams.get("code_challenge"), resource: url.searchParams.get("resource")});
        const callback = new URL(`${appOrigin}/mcp/oauth/callback`);
        for (const [key, value] of Object.entries({code, state: url.searchParams.get("state"), iss: remoteOrigin})) callback.searchParams.set(key, value);
        res.writeHead(200, {"Content-Type": "text/html"});
        res.end(`<!doctype html><title>Fixture authorization</title><button id="approve">Approve fixture</button><script>window.fixtureCallback=${JSON.stringify(callback.href)};document.getElementById('approve').onclick=()=>location.assign(window.fixtureCallback)</script>`); return;
    }
    if (url.pathname === "/token") {
        const params = new URLSearchParams(await body(req)); tokenCount++;
        if (params.get("grant_type") === "authorization_code") {
            const code = authorizationCodes.get(params.get("code")); assert(code);
            authorizationCodes.delete(params.get("code"));
            const {createHash} = await import("node:crypto");
            assert.equal(createHash("sha256").update(params.get("code_verifier")).digest("base64url"), code.challenge);
            assert.equal(params.get("resource"), code.resource);
        } else {
            assert.equal(params.get("grant_type"), "refresh_token");
            assert(refreshTokens.delete(params.get("refresh_token")), "A rotated refresh token is redeemed only once");
            assert.equal(params.get("resource"), `${remoteOrigin}/mcp/oauth`);
        }
        const refreshToken = `refresh-private-marker-${tokenCount}`; refreshTokens.add(refreshToken);
        json(res, 200, {access_token: `access-private-marker-${tokenCount}`, token_type: "Bearer", refresh_token: refreshToken, expires_in: 3600,
            scope: params.get("grant_type") === "refresh_token" ? refreshedScope : "fixture.read"}); return;
    }
    if (req.method === "DELETE") {res.writeHead(204); res.end(); return;}
    if (req.method === "GET") {res.writeHead(405); res.end(); return;}
    const request = JSON.parse(await body(req));
    requests.at(-1).rpcMethod = request.method;
    const method = request.method, id = request.id;
    if (id === undefined) {res.writeHead(202); res.end(); return;}
    const reply = result => json(res, 200, {jsonrpc: "2.0", id, result});
    const legacy = ["legacy", "hidden_session"].includes(mode);
    if (mode === "oauth" && !req.headers.authorization) {
        res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${remoteOrigin}/.well-known/oauth-protected-resource/mcp/oauth"`);
        json(res, 401, {}); return;
    }
    if (method === "server/discover") {
        if (legacy) json(res, 200, {jsonrpc: "2.0", id, error: {code: -32601, message: "Legacy fixture"}});
        else reply({resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: {tools: {}, resources: {}}, ttlMs: 0, cacheScope: "private"});
        return;
    }
    if (method === "initialize") {res.setHeader("MCP-Session-Id", "fixture-session"); reply({protocolVersion: "2025-11-25", capabilities: {tools: {}, resources: {}}, serverInfo: {name: "fixture", version: "1"}}); return;}
    if (legacy && req.headers["mcp-session-id"] !== "fixture-session") {json(res, 404, {}); return;}
    if (method === "tools/list") {
        if (mode === "repeated_cursor") reply({resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [], nextCursor: "same"});
        else reply({resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [{name: "counter", description: "Fixture counter", inputSchema: {type: "object", properties: {}, additionalProperties: false}}]});
        return;
    }
    if (method === "resources/list") {reply({resultType: "complete", ttlMs: 0, cacheScope: "private", resources: [{uri: "fixture://note", name: "Note"}]}); return;}
    if (method === "resources/read") {reply({resultType: "complete", contents: [{uri: "fixture://note", text: "Fixture note"}]}); return;}
    if (method === "tools/call") {
        count(mode);
        if (mode === "lost") {if (req.stream) req.stream.session.destroy(); else req.socket.destroy(); return;}
        if (mode === "refused_stream") {req.stream.on("error", () => {}); req.stream.close(7); return;}
        if (["401", "403", "404", "408"].includes(mode)) {json(res, Number(mode), {}); return;}
        if (mode === "header_mismatch") {json(res, 400, {jsonrpc: "2.0", id, error: {code: -32020, message: "Header mismatch"}}); return;}
        if (mode === "input_required") {reply({resultType: "input_required", requestState: "opaque_fixture_state"}); return;}
        if (mode === "oversized_json") {reply({resultType: "complete", content: [{type: "text", text: "x".repeat(1048577)}]}); return;}
        if (mode === "oversized_sse") {res.writeHead(200, {"Content-Type": "text/event-stream"}); res.end(`data: ${"x".repeat(1048577)}\n\n`); return;}
        if (mode === "stalled_body") {res.writeHead(200, {"Content-Type": "application/json"}); res.flushHeaders(); res.write('{"jsonrpc":'); return;}
        if (mode === "manual") assert.equal(req.headers["x-fixture-marker"], "header-private-marker");
        reply({resultType: "complete", content: [{type: "text", text: "one"}]}); return;
    }
    json(res, 200, {jsonrpc: "2.0", id, error: {code: -32601, message: "Unsupported fixture method"}});
})().catch(error => {errors.push(String(error)); if (!res.headersSent) json(res, 500, {}); else res.destroy();});};
const remote = createSecureServer({key: await readFile(join(tlsDirectory, "key.pem")), cert: await readFile(join(tlsDirectory, "cert.pem")), allowHTTP1: true}, handler);
remote.on("session", session => {sessions.add(session); session.on("error", () => {}); session.on("close", () => sessions.delete(session));});
const httpOne = createHttpServer(handler);
await new Promise(resolve => remote.listen(0, "127.0.0.1", resolve));
await new Promise(resolve => httpOne.listen(0, "127.0.0.1", resolve));
remoteOrigin = `https://127.0.0.1:${remote.address().port}`;
const cacheDir = await mkdtemp(join(tmpdir(), "momoki-mcp-browser-vite-"));
const server = await createServer({configFile: false, cacheDir, plugins: [{name: "mcp-callback-fixture", transformIndexHtml: {order: "post", handler: html => html.replace(/<script type="module" src="\/@vite\/client"><\/script>/u, "")}, configureServer(vite) {
    vite.middlewares.use((req, _res, next) => {if (req.url?.startsWith("/mcp/oauth/callback")) req.url = "/tests/fixtures/mcp-browser/index.html"; next();});
}}], resolve: {alias: {"@": fileURLToPath(new URL("../packages/studio/src", import.meta.url))}},
    server: {host: "127.0.0.1", port: 0, hmr: false, watch: null},
    optimizeDeps: {entries: [fileURLToPath(new URL("../tests/fixtures/mcp-browser/harness.ts", import.meta.url))]}});
const report = async status => writeFile(join(output, "result.json"), JSON.stringify({status, observations, errors, counters: Object.fromEntries(counters), requests, registrationCount, tokenCount,
    sources,
    node: process.version, chromium: browser?.version(), limits: "Actual Chromium cross-origin fetch, SDK, feature configuration owner and ProductStore with a controlled local HTTP/OAuth peer. Not an installed desktop, third-party provider or application production build."}, null, 2) + "\n");
const test = async (name, action) => {
    try {await action(); assert.deepEqual(errors, []); observations.push({name, outcome: "pass"}); console.log(`PASS ${name}`);}
    catch (error) {observations.push({name, outcome: "fail", error: String(error)}); await report("FAIL"); throw error;}
};
const evaluate = (method, ...args) => page.evaluate(({method, args}) => window.mcpBrowserFixture[method](...args), {method, args});
const setup = async (mode, auth = "none", clientId) => {await evaluate("fresh"); const saved = await evaluate("save", `${remoteOrigin}/mcp/${mode}`, auth, clientId); assert.equal(saved.ok, true, JSON.stringify(saved)); return saved;};
try {
    await server.listen(); appOrigin = server.resolvedUrls.local[0].replace(/\/$/, "");
    browser = await chromium.launch({headless: true, ...(process.env.MCP_CHROMIUM_PATH ? {executablePath: process.env.MCP_CHROMIUM_PATH} : {})});
    page = await browser.newPage({ignoreHTTPSErrors: true}); page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${appOrigin}/tests/fixtures/mcp-browser/`); await page.waitForFunction(() => !!window.mcpBrowserFixture);
    for (const mode of ["modern", "legacy", "manual"]) await test(`actual SDK browser ${mode} connects and sends once`, async () => {
        await setup(mode, mode === "manual" ? "manual" : "none");
        const connected = await evaluate("connect"); assert.equal(connected.ok, true, JSON.stringify(connected));
        const result = await evaluate("invoke"); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.value.status, "completed");
        await evaluate("readback"); await evaluate("stop"); await evaluate("disconnect"); assert.equal(counters.get(mode), 1, JSON.stringify(await evaluate("fetchCalls")));
    });
    for (const mode of ["lost", "refused_stream", "401", "403", "404", "408", "input_required", "header_mismatch", "oversized_json", "oversized_sse", "stalled_body"]) await test(`no replay after ${mode}`, async () => {
        await setup(mode); assert.equal((await evaluate("connect")).ok, true);
        const result = await evaluate("invoke");
        assert.equal(result.ok, true, JSON.stringify(result)); assert.notEqual(result.value.status, "completed");
        await evaluate("readback"); await evaluate("stop"); await evaluate("disconnect"); assert.equal(counters.get(mode), 1, JSON.stringify(await evaluate("fetchCalls")));
    });
    for (const changedScope of [false, true]) await test(`refresh rotation ${changedScope ? "retires changed authority before send" : "is serialized and preserves unchanged authority"}`, async () => {
        await setup("oauth", "oauth", "registered-public");
        const popupPromise = page.waitForEvent("popup"); await page.getByRole("button", {name: "Login fixture"}).click();
        const popup = await popupPromise; await popup.waitForURL(`${remoteOrigin}/authorize**`); await popup.getByRole("button", {name: "Approve fixture"}).click();
        await page.waitForFunction(() => window.mcpBrowserFixture.login() !== undefined); assert.equal((await evaluate("login")).value?.state, "authorized");
        assert.equal((await evaluate("connect")).ok, true);
        const beforeEffects = counters.get("oauth") ?? 0, beforeTokens = tokenCount, realTime = Date.now();
        refreshedScope = changedScope ? "fixture.other" : "fixture.read";
        await page.clock.setSystemTime(realTime + 3_601_000);
        try {
            if (changedScope) {const result = await evaluate("invoke"); assert.equal(result.value?.status, "not_started", JSON.stringify(result));}
            else {
                const results = await page.evaluate(() => Promise.all([window.mcpBrowserFixture.invoke("refresh_first"), window.mcpBrowserFixture.invoke("refresh_second")]));
                assert(results.every(result => result.value?.status === "completed"), JSON.stringify(results));
            }
            assert.equal(tokenCount, beforeTokens + 1);
            assert.equal(counters.get("oauth") ?? 0, beforeEffects + (changedScope ? 0 : 2));
        } finally {await page.clock.setSystemTime(realTime); refreshedScope = "fixture.read";}
    });
    for (const mode of ["denied", "hidden_session", "repeated_cursor"]) await test(`bounded unsupported browser connection ${mode}`, async () => {
        await setup(mode); const result = await evaluate("connect"); assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(counters.get(mode) ?? 0, 0);
    });
    await test("HTTP/1 is explicitly unsupported without replayable-body fallback", async () => {
        await evaluate("fresh"); assert.equal((await evaluate("save", `http://127.0.0.1:${httpOne.address().port}/mcp/http_one`)).ok, true);
        assert.equal((await evaluate("connect")).ok, false); assert.equal(counters.get("http_one") ?? 0, 0);
        assert.equal(requests.filter(request => request.path === "/mcp/http_one" && request.rpcMethod).length, 0);
    });
    for (const clientId of ["registered-public", undefined]) await test(`actual popup OAuth ${clientId ? "pre-registration" : "DCR"}`, async () => {
        await setup("oauth", "oauth", clientId);
        const popupPromise = page.waitForEvent("popup"); await page.getByRole("button", {name: "Login fixture"}).click();
        const popup = await popupPromise; await popup.waitForURL(`${remoteOrigin}/authorize**`);
        if (clientId) {
            const authorizeUrl = popup.url(), callbackUrl = await popup.evaluate(() => window.fixtureCallback);
            const callback = new URL(callbackUrl), fields = Object.fromEntries(callback.searchParams);
            const beforeTokens = tokenCount;
            // Correct fields from the wrong source/origin must not consume the live attempt.
            await page.evaluate(({fields, redirect}) => window.postMessage({kind: "momoki_mcp_oauth_callback", redirect, fields}, location.origin), {fields, redirect: `${appOrigin}/mcp/oauth/callback`});
            await popup.evaluate(({fields, redirect, origin}) => window.opener.postMessage({kind: "momoki_mcp_oauth_callback", redirect, fields}, origin), {fields, redirect: `${appOrigin}/mcp/oauth/callback`, origin: appOrigin});
            for (const [key, value] of [["state", "forged-state"], ["iss", `${remoteOrigin}/other-issuer`]]) {
                const bad = new URL(callbackUrl); bad.searchParams.set(key, value);
                await popup.goto(bad.href); await popup.waitForFunction(() => !location.search);
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                assert.equal(await evaluate("login"), undefined); assert.equal(tokenCount, beforeTokens); assert(!popup.isClosed());
            }
            await popup.goto(authorizeUrl);
        }
        await popup.getByRole("button", {name: "Approve fixture"}).click();
        await page.waitForFunction(() => window.mcpBrowserFixture.login() !== undefined);
        assert.deepEqual((await evaluate("login")).value?.state, "authorized");
        assert.equal((await evaluate("connect")).ok, true); assert.equal((await evaluate("invoke")).value?.status, "completed");
        const bytes = JSON.stringify(await evaluate("snapshots"));
        for (const marker of ["access-private-marker", "refresh-private-marker", "header-private-marker", "code_verifier"]) assert(!bytes.includes(marker), marker);
        assert(!new URL(page.url()).search, "Parent route never receives callback fields");
    });
    await test("tab reload retains public catalogue and loses private session authority", async () => {
        await setup("manual", "manual"); await page.reload(); await page.waitForFunction(() => !!window.mcpBrowserFixture);
        const snapshot = await evaluate("snapshots"); assert.equal(snapshot.catalogue.entries.length, 1);
        assert.equal((await evaluate("restored")).ok, false);
        assert(!JSON.stringify(snapshot).includes("header-private-marker"));
    });
    await test("fixture and exercised source bytes stay unchanged", async () => {assert.deepEqual(await sourceHashes(), sources);});
    await report("PASS"); console.log(JSON.stringify({output, tests: observations.length, status: "PASS"}));
} finally {
    await browser?.close(); await server.close(); for (const session of sessions) session.destroy();
    httpOne.closeAllConnections(); await Promise.all([new Promise(resolve => remote.close(resolve)), new Promise(resolve => httpOne.close(resolve))]);
    await rm(tlsDirectory, {recursive: true, force: true});
}
