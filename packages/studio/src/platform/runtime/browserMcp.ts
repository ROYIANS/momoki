import {Client, StreamableHTTPClientTransport, ProtocolError, UnauthorizedError, InsufficientScopeError} from "@modelcontextprotocol/client";
import {productEffectAdmission} from "./effectAdmission";
import type {McpHostBinding, McpHostScope, McpHostServices, McpHostTarget, McpInvocationIdentity, McpInvocationOutcome,
    McpPreparedAuthority, McpPrivateConfig, McpPrivateRevisionRef} from "./mcp";
import {McpHostError} from "./mcpErrors";
import {mcpBindingSchema, mcpConnectInputSchema, mcpIdentitySchema, mcpPrivateConfirmInputSchema,
    mcpPrivatePrepareInputSchema, mcpReferenceSchema, mcpScopeSchema, mcpTargetSchema, mcpWireId} from "./mcpWire";
import {browserMcpDigest, browserMcpId, browserMcpJson, freezeBrowserMcp} from "./browserMcpData";
import {createBoundedMcpFetch} from "./browserMcpFetch";
import {createBrowserMcpOAuth} from "./browserMcpOAuth";

/** Safe snapshot injected by the feature owner; platform has no feature dependency. */
export interface BrowserMcpCatalogue {
    readonly revision: number;
    readonly entries: readonly {readonly serverId: string; readonly configRevision: number; readonly enabled: boolean;
        readonly transport: "stdio" | "streamable_http"; readonly auth: "none" | "manual" | "oauth";
        readonly endpointDisplay?: string; readonly privateRevision: McpPrivateRevisionRef}[];
    readonly receipts: readonly {readonly operationId: string; readonly serverId: string; readonly kind: string;
        readonly fingerprint: string; readonly publishedPrivateRevision?: McpPrivateRevisionRef}[];
}
export interface BrowserMcpOptions {
    readonly readCatalogue: () => Promise<BrowserMcpCatalogue>;
    readonly fetch?: typeof fetch;
    readonly window?: Window;
    readonly requestTimeoutMs?: number;
    readonly oauthTimeoutMs?: number;
    readonly drainTimeoutMs?: number;
}
type Remote = Extract<McpPrivateConfig, {transport: "streamable_http"}>;
interface PrivateRevision {readonly serverId: string; readonly reference: McpPrivateRevisionRef; readonly config: Remote; confirmed: boolean}
interface Connection {
    readonly binding: McpHostBinding; readonly reference: McpPrivateRevisionRef; readonly config: Remote;
    readonly client: Client; readonly transport: StreamableHTTPClientTransport; readonly controller: AbortController;
    readonly discovery: unknown; readonly tools: Set<string>; readonly resources: Map<string, string>;
    readonly principal: string; token?: string; tail: Promise<unknown>; retired: boolean;
    readonly tasks: Set<Promise<unknown>>;
    invocation?: Invocation; status?: number; drain?: Promise<boolean>;
}
interface Invocation {readonly identity: McpInvocationIdentity; readonly fingerprint: string; readonly controller: AbortController;
    dispatched: boolean; outcome: McpInvocationOutcome; pending?: Promise<McpInvocationOutcome>}
interface Operation {readonly fingerprint: string; readonly result: Promise<unknown>}
const same = (left: unknown, right: unknown) => browserMcpJson(left, 65_536) === browserMcpJson(right, 65_536);
const referenceKey = (reference: McpPrivateRevisionRef) => `${reference.ownerId}:${reference.revisionId}`;
const argumentDigest = (args: unknown) => browserMcpDigest(browserMcpJson(args));

function discoveryHandles(tools: readonly unknown[], resources: readonly unknown[], serverId: string): {tools: Set<string>; resources: Map<string, string>} {
    const names = new Set<string>(), handles = new Map<string, string>();
    for (const raw of tools) {
        if (!raw || typeof raw !== "object" || !("name" in raw) || typeof raw.name !== "string" || raw.name.length > 256 || names.has(raw.name)) throw new McpHostError("protocol", "not_started", "discovery");
        browserMcpJson(raw, 32_768); names.add(raw.name);
    }
    for (const raw of resources) {
        if (!raw || typeof raw !== "object" || !("uri" in raw) || typeof raw.uri !== "string" || raw.uri.length > 2_048) throw new McpHostError("protocol", "not_started", "discovery");
        const handle = `resource_${browserMcpDigest(JSON.stringify([serverId, raw.uri]))}`;
        if (handles.has(handle)) throw new McpHostError("protocol", "not_started", "discovery");
        handles.set(handle, raw.uri);
    }
    return {tools: names, resources: handles};
}

function failedInvocation(invocation: Invocation, connection: Connection, error: unknown): McpInvocationOutcome {
    const operationId = invocation.identity.operationId;
    if (!invocation.dispatched) return {status: "not_started", operationId, code: invocation.controller.signal.aborted ? "canceled" : "retired"};
    if (error instanceof ProtocolError && !(error instanceof UnauthorizedError) && !(error instanceof InsufficientScopeError)) return {status: "protocol_error", operationId, code: "remote_error"};
    if (connection.status === 404) return {status: "unknown", operationId, code: "session_expired"};
    return {status: "unknown", operationId, code: invocation.controller.signal.aborted ? "stopped" : "reply_lost"};
}

/** Browser remote host. Original outcomes survive retirement; credentials never leave this owner. */
export function createBrowserMcpServices(options: BrowserMcpOptions): McpHostServices {
    const ownerId = browserMcpId("browser"), sessionId = browserMcpId("session");
    let active = true;
    const revisions = new Map<string, PrivateRevision>(), candidates = new Map<string, PrivateRevision>();
    const operations = new Map<string, Operation>(), connections = new Map<string, Connection>();
    const epochs = new Map<string, number>(), pending = new Map<string, AbortController>();
    const authorities = new Map<string, McpPreparedAuthority>(), invocations = new Map<string, Invocation>();
    const tasks = new Map<string, Set<Promise<unknown>>>(), retired = new Map<string, Connection>();
    const failedCleanup = new Set<string>();
    const revisionServers = new Map<string, string>();
    const oauth = createBrowserMcpOAuth({window: options.window ?? (typeof window === "undefined" ? undefined : window), fetch: options.fetch,
        timeoutMs: options.oauthTimeoutMs, requestTimeoutMs: options.requestTimeoutMs,
        track: (key, task) => {const serverId = revisionServers.get(key); if (serverId) void track(serverId, task);}});
    const capabilities = Object.freeze({host: "browser" as const, stdio: false, streamableHttp: true, oauth: true, rememberedCredentials: false});
    const epoch = (serverId: string) => epochs.get(serverId) ?? 0;
    function fail(code: ConstructorParameters<typeof McpHostError>[0], operationId: string): never {throw new McpHostError(code, "not_started", operationId);}
    function assertActive(operationId: string): void {if (!active) fail("closed", operationId);}
    function track<T>(serverId: string, task: Promise<T>, owner?: Set<Promise<unknown>>): Promise<T> {
        let owned = tasks.get(serverId);
        if (!owned) {owned = new Set(); tasks.set(serverId, owned);}
        const currentTasks = owned;
        currentTasks.add(task); owner?.add(task);
        const finish = () => {
            currentTasks.delete(task); owner?.delete(task);
            if (!currentTasks.size && tasks.get(serverId) === currentTasks) tasks.delete(serverId);
        };
        void task.then(finish, finish);
        return task;
    }
    async function settle(owned: Set<Promise<unknown>>): Promise<void> {
        while (owned.size) await Promise.allSettled([...owned]);
    }
    async function drainTasks(serverId?: string): Promise<boolean> {
        for (;;) {
            if (serverId === undefined ? failedCleanup.size : failedCleanup.has(serverId)) return false;
            const owned = serverId === undefined ? [...tasks.values()] : [tasks.get(serverId)].filter((value): value is Set<Promise<unknown>> => !!value);
            const closing = [...retired.values()].filter(connection => serverId === undefined || connection.binding.serverId === serverId);
            if (!owned.length && !closing.length) return true;
            const closed = await Promise.all(closing.map(connection => connection.drain ?? Promise.resolve(false)));
            if (closed.some(value => value !== true)) return false;
            await Promise.all(owned.map(settle));
        }
    }
    async function boundedDrain(task: Promise<boolean>): Promise<{status: "drained" | "draining"}> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const complete = await Promise.race([task, new Promise<boolean>(resolve => {timer = setTimeout(() => resolve(false), options.drainTimeoutMs ?? 5_000);})]);
            return {status: complete ? "drained" : "draining"};
        } finally {clearTimeout(timer);}
    }
    async function catalogue(): Promise<BrowserMcpCatalogue> {
        const result = await options.readCatalogue();
        browserMcpJson(result, 2_097_152);
        if (result.entries.length > 16 || !Number.isSafeInteger(result.revision)) fail("invalid", "catalogue");
        return result;
    }
    function own<T>(task: () => T, operationId: string): T {
        try {return task();} catch (error) {throw error instanceof McpHostError ? error : new McpHostError("invalid", "not_started", operationId);}
    }
    async function current(serverId: string, configRevision: number, reference: McpPrivateRevisionRef, operationId: string, enabled = true): Promise<PrivateRevision> {
        assertActive(operationId);
        const snapshot = await catalogue();
        assertActive(operationId);
        const row = snapshot.entries.find(item => item.serverId === serverId), revision = revisions.get(referenceKey(reference));
        if (!row || enabled && !row.enabled || row.configRevision !== configRevision || !same(row.privateRevision, reference)) fail("retired", operationId);
        if (!revision?.confirmed || revision.serverId !== serverId || reference.kind !== "session_memory" || reference.ownerId !== ownerId) fail("auth_required", operationId);
        if (row.transport !== revision.config.transport || row.auth !== revision.config.auth.kind || row.endpointDisplay !== new URL(revision.config.endpoint).origin) fail("conflict", operationId);
        return revision;
    }
    function operation<T>(id: string, input: unknown, work: () => Promise<T>): Promise<T> {
        assertActive(id);
        const fingerprint = browserMcpDigest(browserMcpJson(input, 65_536)), previous = operations.get(id);
        if (previous) {
            if (previous.fingerprint !== fingerprint) fail("conflict", id);
            return previous.result as Promise<T>;
        }
        // Never evict an original operation and accidentally allow its effect again.
        if (operations.size >= 256) fail("limit", id);
        const result = Promise.resolve().then(work);
        operations.set(id, {fingerprint, result});
        return result;
    }
    function retireLocal(serverId: string): Connection | undefined {
        epochs.set(serverId, epoch(serverId) + 1);
        pending.get(serverId)?.abort();
        for (const revision of revisions.values()) if (revision.serverId === serverId) oauth.retire(referenceKey(revision.reference));
        for (const [id, authority] of authorities) if (authority.binding.serverId === serverId) authorities.delete(id);
        const connection = connections.get(serverId);
        connections.delete(serverId);
        if (connection) {
            connection.retired = true; connection.controller.abort();
            retired.set(connection.binding.registrationId, connection);
            connection.drain = (async () => {
                const closed = connection.client.close().then(() => true, () => false);
                await connection.tail.catch(() => undefined);
                await settle(connection.tasks);
                const complete = await closed;
                if (complete && retired.get(connection.binding.registrationId) === connection) retired.delete(connection.binding.registrationId);
                return complete;
            })();
        }
        return connection;
    }
    async function checkedConnection(binding: McpHostBinding, id: string): Promise<Connection> {
        assertActive(id);
        const connection = connections.get(binding.serverId);
        if (!connection || connection.retired || !same(connection.binding, binding)) fail("retired", id);
        await current(binding.serverId, binding.configRevision, connection.reference, id);
        if (connections.get(binding.serverId) !== connection || connection.retired) fail("retired", id);
        return connection;
    }
    async function credential(revision: PrivateRevision, expectedEpoch: number, configRevision: number, operationId: string) {
        if (revision.config.auth.kind !== "oauth") return {token: undefined, principal: browserMcpDigest(browserMcpJson(revision.config, 32_768))};
        return oauth.token(referenceKey(revision.reference), async () => {
            if (!active || epoch(revision.serverId) !== expectedEpoch) return false;
            try {await current(revision.serverId, configRevision, revision.reference, operationId); return active && epoch(revision.serverId) === expectedEpoch;} catch {return false;}
        }, () => active && epoch(revision.serverId) === expectedEpoch);
    }
    async function collect(client: Client, kind: "tools" | "resources", signal: AbortSignal): Promise<unknown[]> {
        const items: unknown[] = [], cursors = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < 16; page++) {
            const params = cursor === undefined ? {} : {cursor};
            const response = kind === "tools" ? await client.request({method: "tools/list", params}, {signal, timeout: options.requestTimeoutMs ?? 30_000, maxTotalTimeout: options.requestTimeoutMs ?? 30_000})
                : await client.request({method: "resources/list", params}, {signal, timeout: options.requestTimeoutMs ?? 30_000, maxTotalTimeout: options.requestTimeoutMs ?? 30_000});
            browserMcpJson(response, 524_288);
            let rows: unknown;
            if (kind === "tools" && "tools" in response) rows = response.tools;
            if (kind === "resources" && "resources" in response) rows = response.resources;
            if (!Array.isArray(rows) || items.length + rows.length > 128) fail("limit", "discovery");
            items.push(...rows as unknown[]);
            if (response.nextCursor === undefined) return items;
            cursor = response.nextCursor;
            if (!cursor || cursor.length > 512 || cursors.has(cursor)) fail("limit", "discovery");
            cursors.add(cursor);
        }
        return fail("limit", "discovery");
    }
    function original(input: McpInvocationIdentity): Invocation | undefined {
        const found = invocations.get(input.operationId);
        if (found && !same(found.identity, input)) fail("conflict", input.operationId);
        return found;
    }
    function assertConnectAdmission(serverId: string, expected: number, operationId: string): void {
        if (!productEffectAdmission.open) fail("closed", operationId);
        if (!active || epoch(serverId) !== expected) fail("retired", operationId);
        if (pending.has(serverId)) fail("conflict", operationId);
        if (connections.size + pending.size + retired.size >= 8) fail("limit", operationId);
    }
    const host: McpHostServices = {
        get active() {return active;}, capabilities,
        async initialize() {assertActive("initialize"); await catalogue(); return capabilities;},
        reserveOAuthPopup() {productEffectAdmission.assertOpen(); assertActive("oauth_popup"); oauth.reserve();},
        cancelReservedOAuthPopup() {oauth.cancelReserved();},
        preparePrivateRevision(raw) {
            productEffectAdmission.assertOpen();
            const input = own(() => mcpPrivatePrepareInputSchema.parse(JSON.parse(browserMcpJson(raw, 65_536)) as unknown), raw.operationId);
            return operation(`private_${input.operationId}`, input, async () => {
                if (input.config.transport !== "streamable_http") fail("unsupported", input.operationId);
                browserMcpJson(input.config, 32_768);
                if (input.config.auth.kind === "manual") {
                    const forbidden = /^(?:accept-charset|accept-encoding|access-control-request-.+|connection|cookie2?|date|dnt|expect|host|keep-alive|origin|permissions-policy|referer|te|trailer|transfer-encoding|upgrade|via|proxy-.+|sec-.+|mcp-.+|dpop)$/iu;
                    if (Object.keys(input.config.auth.headers).some(name => forbidden.test(name))) fail("unsupported", input.operationId);
                }
                const snapshot = await catalogue();
                productEffectAdmission.assertOpen();
                if (snapshot.revision !== input.catalogueRevision || (snapshot.entries.find(row => row.serverId === input.serverId)?.configRevision ?? 0) !== input.expectedConfigRevision) fail("conflict", input.operationId);
                assertActive(input.operationId);
                if (revisions.size >= 64) fail("limit", input.operationId);
                const reference = freezeBrowserMcp({kind: "session_memory" as const, ownerId, revisionId: browserMcpId("private")});
                const revision: PrivateRevision = {serverId: input.serverId, reference, config: freezeBrowserMcp(input.config), confirmed: false};
                revisions.set(referenceKey(reference), revision); revisionServers.set(referenceKey(reference), input.serverId); candidates.set(input.operationId, revision);
                return reference;
            });
        },
        privateRevisionStatus(input) {
            assertActive(input.operationId); mcpWireId.parse(input.operationId); mcpWireId.parse(input.serverId);
            const candidate = candidates.get(input.operationId);
            if (candidate && candidate.serverId !== input.serverId) fail("conflict", input.operationId);
            return Promise.resolve(candidate ? {status: "prepared", reference: candidate.reference} : {status: "unknown"});
        },
        async confirmPrivateRevision(raw) {
            const input = own(() => mcpPrivateConfirmInputSchema.parse(raw), raw.operationId), snapshot = await catalogue();
            assertActive(input.operationId);
            const candidate = candidates.get(input.operationId);
            if (!candidate || candidate.serverId !== input.serverId || !same(candidate.reference, input.reference)
                || !snapshot.receipts.some(receipt => receipt.operationId === input.operationId && receipt.serverId === input.serverId && receipt.kind === "save" && receipt.fingerprint === input.catalogueFingerprint && same(receipt.publishedPrivateRevision ?? null, input.reference))
                || !snapshot.entries.some(row => row.serverId === input.serverId && same(row.privateRevision, input.reference))) fail("conflict", input.operationId);
            candidate.confirmed = true;
        },
        async discardPrivateRevision(input) {
            const reference = mcpReferenceSchema.parse(input.reference), snapshot = await catalogue();
            assertActive(input.serverId);
            if (reference.ownerId !== ownerId || reference.kind !== "session_memory" || snapshot.entries.some(row => same(row.privateRevision, reference))) fail("conflict", input.serverId);
            const key = referenceKey(reference), revision = revisions.get(key);
            if (revision && revision.serverId !== input.serverId) fail("conflict", input.serverId);
            oauth.clear(key); revisions.delete(key);
            for (const [id, value] of candidates) if (same(value.reference, reference)) candidates.delete(id);
        },
        async retireServer(input) {
            mcpWireId.parse(input.serverId);
            if (input.expectedConfigRevision !== undefined) {
                const row = (await catalogue()).entries.find(value => value.serverId === input.serverId);
                if (row?.configRevision !== input.expectedConfigRevision) fail("retired", input.serverId);
            }
            retireLocal(input.serverId);
            return boundedDrain(drainTasks(input.serverId));
        },
        oauthBegin(raw) {
            productEffectAdmission.assertOpen();
            const input = own(() => mcpConnectInputSchema.parse(raw), raw.operationId);
            const expected = epoch(input.serverId);
            return track(input.serverId, operation(`login_${input.operationId}`, input, async () => {
                if (!active || epoch(input.serverId) !== expected) fail("retired", input.operationId);
                const revision = await current(input.serverId, input.configRevision, input.privateRevision, input.operationId);
                if (!active || epoch(input.serverId) !== expected) fail("retired", input.operationId);
                if (revision.config.auth.kind !== "oauth") {oauth.cancelReserved(); return fail("invalid", input.operationId);}
                return oauth.begin({key: referenceKey(revision.reference), config: revision.config, isCurrent: () => active && epoch(input.serverId) === expected, current: async () => {
                    if (!active || epoch(input.serverId) !== expected) return false;
                    try {await current(input.serverId, input.configRevision, input.privateRevision, input.operationId); return active && epoch(input.serverId) === expected;} catch {return false;}
                }});
            }).finally(() => oauth.cancelReserved()));
        },
        oauthStatus(id) {mcpWireId.parse(id); assertActive(id); return Promise.resolve(oauth.status(id));},
        oauthCancel(id) {mcpWireId.parse(id); oauth.cancel(id); return Promise.resolve();},
        connect(raw, signal) {
            productEffectAdmission.assertOpen();
            const input = own(() => mcpConnectInputSchema.parse(raw), raw.operationId);
            const admittedEpoch = epoch(input.serverId);
            return track(input.serverId, operation(`connect_${input.operationId}`, input, async () => {
                assertConnectAdmission(input.serverId, admittedEpoch, input.operationId);
                retireLocal(input.serverId);
                const expected = epoch(input.serverId), controller = new AbortController();
                pending.set(input.serverId, controller);
                const abort = () => controller.abort();
                signal.addEventListener("abort", abort, {once: true}); if (signal.aborted) controller.abort();
                const localTasks = new Set<Promise<unknown>>();
                let client: Client | undefined, admitted: Connection | undefined, status: number | undefined;
                try {
                    const revision = await current(input.serverId, input.configRevision, input.privateRevision, input.operationId);
                    const auth = await credential(revision, expected, input.configRevision, input.operationId);
                    let token = auth.token;
                    const stillCurrent = () => active && epoch(input.serverId) === expected && !controller.signal.aborted;
                    const transport = new StreamableHTTPClientTransport(new URL(revision.config.endpoint), {
                        authProvider: {token: () => Promise.resolve(admitted?.token ?? token)},
                        requestInit: {headers: revision.config.auth.kind === "manual" ? {...revision.config.auth.headers} : {}},
                        fetch: createBoundedMcpFetch({fetch: options.fetch, timeoutMs: options.requestTimeoutMs, signal: controller.signal, oneShotBody: true,
                            onTask: task => {void track(input.serverId, task, localTasks);},
                            beforeSend: () => {
                                if (!stillCurrent()) fail("retired", input.operationId);
                                if (admitted?.invocation) admitted.invocation.dispatched = true;
                            }, onStatus: value => {status = value; if (admitted) admitted.status = value;}}),
                        onInsufficientScope: "throw", maxStepUpRetries: 0,
                        reconnectionOptions: {maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1},
                    });
                    client = new Client({name: "Momoki", version: "0.1.6"}, {capabilities: {}, inputRequired: {autoFulfill: false},
                        versionNegotiation: {mode: "auto", probe: {maxRetries: 0, timeoutMs: options.requestTimeoutMs ?? 30_000}}, listMaxPages: 16});
                    await client.connect(transport, {signal: controller.signal, timeout: options.requestTimeoutMs ?? 30_000, maxTotalTimeout: options.requestTimeoutMs ?? 30_000});
                    const tools = client.getServerCapabilities()?.tools ? await collect(client, "tools", controller.signal) : [];
                    const resources = client.getServerCapabilities()?.resources ? await collect(client, "resources", controller.signal) : [];
                    const discovery = {tools, resources};
                    browserMcpJson(discovery, 524_288);
                    const handles = discoveryHandles(tools, resources, input.serverId);
                    await current(input.serverId, input.configRevision, input.privateRevision, input.operationId);
                    if (!stillCurrent()) fail("retired", input.operationId);
                    const binding = freezeBrowserMcp({serverId: input.serverId, configRevision: input.configRevision, manifestRevision: browserMcpId("manifest"),
                        registrationId: browserMcpId("registration"), hostSessionId: sessionId, principalRevision: browserMcpId("principal")});
                    admitted = {binding, reference: input.privateRevision, config: revision.config, client, transport, controller, discovery: freezeBrowserMcp(discovery),
                        tools: handles.tools, resources: handles.resources, principal: auth.principal, token, tail: Promise.resolve(), tasks: localTasks, retired: false};
                    token = undefined;
                    connections.set(input.serverId, admitted);
                    const listChanged = () => {if (connections.get(input.serverId) === admitted) retireLocal(input.serverId);};
                    client.setNotificationHandler("notifications/tools/list_changed", listChanged);
                    client.setNotificationHandler("notifications/resources/list_changed", listChanged);
                    client.onclose = () => {if (connections.get(input.serverId) === admitted) retireLocal(input.serverId);};
                    return freezeBrowserMcp({binding, discovery});
                } catch (error) {
                    controller.abort(); await client?.close().catch(() => {failedCleanup.add(input.serverId);});
                    throw error instanceof McpHostError ? error : new McpHostError(status === 401 || error instanceof UnauthorizedError ? "auth_required" : "transport", "not_started", input.operationId);
                } finally {if (pending.get(input.serverId) === controller) pending.delete(input.serverId); signal.removeEventListener("abort", abort);}
            }));
        },
        async disconnect(raw) {
            const binding = mcpBindingSchema.parse(raw), connection = connections.get(binding.serverId);
            if (connection && same(connection.binding, binding)) retireLocal(binding.serverId);
            const original = retired.get(binding.registrationId);
            if (original && !same(original.binding, binding)) fail("retired", "disconnect");
            if (original?.drain) return boundedDrain(original.drain);
            if (connection && !same(connection.binding, binding)) fail("retired", "disconnect");
            return {status: "drained"};
        },
        async prepare(raw) {
            productEffectAdmission.assertOpen();
            const binding = mcpBindingSchema.parse(raw.binding), scope: McpHostScope = mcpScopeSchema.parse(raw.scope), target: McpHostTarget = mcpTargetSchema.parse(raw.target);
            const args = JSON.parse(browserMcpJson(raw.arguments)) as unknown, connection = await checkedConnection(binding, scope.callId);
            productEffectAdmission.assertOpen();
            if (target.kind === "tool" ? !connection.tools.has(target.rawName) : !connection.resources.has(target.handleId)) fail("denied", scope.callId);
            if (target.kind === "resource" && browserMcpJson(args) !== "{}" || target.kind === "tool" && (!args || typeof args !== "object" || Array.isArray(args))) fail("invalid", scope.callId);
            if (authorities.size >= 256) fail("limit", scope.callId);
            const authority = freezeBrowserMcp({authorityId: browserMcpId("authority"), binding, scope, target, argumentsDigest: argumentDigest(args)});
            authorities.set(authority.authorityId, authority);
            return authority;
        },
        async invoke(raw, signal) {
            const identity = own(() => mcpIdentitySchema.parse({operationId: raw.operationId, authority: raw.authority}), raw.operationId);
            const args = JSON.parse(browserMcpJson(raw.arguments)) as Record<string, unknown>, fingerprint = argumentDigest(args);
            const previous = original(identity);
            if (previous) {if (previous.fingerprint !== fingerprint) fail("conflict", identity.operationId); return previous.pending ?? previous.outcome;}
            productEffectAdmission.assertOpen();
            if (invocations.size >= 256) fail("limit", identity.operationId);
            const authority = authorities.get(identity.authority.authorityId);
            const connection = connections.get(identity.authority.binding.serverId);
            const controller = new AbortController(), abort = () => controller.abort();
            const invocation: Invocation = {identity: freezeBrowserMcp(identity), fingerprint, controller, dispatched: false,
                outcome: {status: "unknown", operationId: identity.operationId, code: "reply_lost"}};
            invocations.set(identity.operationId, invocation);
            if (!connection || !authority || !same(authority, identity.authority) || authority.argumentsDigest !== fingerprint) {
                invocation.outcome = {status: "not_started", operationId: identity.operationId, code: "denied"};
                return invocation.outcome;
            }
            authorities.delete(authority.authorityId);
            signal.addEventListener("abort", abort, {once: true}); if (signal.aborted) controller.abort();
            const run = async (): Promise<McpInvocationOutcome> => {
                try {
                    await checkedConnection(authority.binding, identity.operationId);
                    controller.signal.throwIfAborted();
                    const expected = epoch(authority.binding.serverId), revision = await current(authority.binding.serverId, authority.binding.configRevision, connection.reference, identity.operationId);
                    const auth = await credential(revision, expected, authority.binding.configRevision, identity.operationId);
                    if (auth.principal !== connection.principal) {if (connections.get(authority.binding.serverId) === connection) retireLocal(authority.binding.serverId); fail("auth_required", identity.operationId);}
                    await checkedConnection(authority.binding, identity.operationId);
                    controller.signal.throwIfAborted();
                    productEffectAdmission.assertOpen();
                    connection.token = auth.token; connection.invocation = invocation; connection.status = undefined;
                    const requestOptions = {signal: controller.signal, timeout: options.requestTimeoutMs ?? 30_000, maxTotalTimeout: options.requestTimeoutMs ?? 30_000, resetTimeoutOnProgress: false};
                    const result = authority.target.kind === "tool"
                        ? await connection.client.request({method: "tools/call", params: {name: authority.target.rawName, arguments: args}}, requestOptions)
                        : await connection.client.request({method: "resources/read", params: {uri: connection.resources.get(authority.target.handleId)!}}, requestOptions);
                    browserMcpJson(result, 1_048_576);
                    invocation.outcome = freezeBrowserMcp({status: "completed", operationId: identity.operationId, result});
                } catch (error) {
                    invocation.outcome = failedInvocation(invocation, connection, error);
                    if (invocation.dispatched && connections.get(authority.binding.serverId) === connection) retireLocal(authority.binding.serverId);
                } finally {connection.invocation = undefined; signal.removeEventListener("abort", abort);}
                return invocation.outcome;
            };
            invocation.pending = track(authority.binding.serverId, connection.tail.then(run, run));
            connection.tail = invocation.pending;
            return invocation.pending;
        },
        invocationStatus(raw) {
            const input = mcpIdentitySchema.parse(raw), invocation = original(input);
            return Promise.resolve(invocation?.outcome ?? {status: "unknown", operationId: input.operationId, code: "reply_lost"});
        },
        stop(raw) {
            const input = mcpIdentitySchema.parse(raw), invocation = original(input);
            if (!invocation) return Promise.resolve({status: "unknown", operationId: input.operationId, code: "reply_lost"});
            invocation.controller.abort();
            if (invocation.outcome.status === "unknown") invocation.outcome = invocation.dispatched ? {status: "unknown", operationId: input.operationId, code: "stopped"} : {status: "not_started", operationId: input.operationId, code: "canceled"};
            return Promise.resolve(invocation.outcome);
        },
        async dispose() {
            active = false;
            for (const serverId of new Set([...connections.keys(), ...pending.keys()])) retireLocal(serverId);
            authorities.clear(); oauth.dispose(); revisions.clear(); candidates.clear();
            return boundedDrain(drainTasks());
        },
    };
    return host;
}
