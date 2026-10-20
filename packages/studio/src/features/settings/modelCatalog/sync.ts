import {z} from "zod";
import {deleteDeviceSetting, DEVICE_SETTING_MAX_BYTES, getDeviceSetting, putDeviceSetting} from "../commands/deviceSettings";
import {MODEL_CATALOG_URL} from "../../../platform/product/httpPolicy";
import {requestOnce} from "../../../platform/http/requestBoundary";
import {isReadAbort, readResponseBytes, ResponseLimitError, utf8Bytes} from "@momoki/agent-providers/http";
import {
    compareEntries,
    originOf,
    projectCommonScope,
    projectEntry,
    type ProjectionScope,
    type RawProvider
} from "./projection.mjs";
import scopeJson from "./scope.json";
import {applySyncedSnapshot, MODEL_CATALOG_KEY, restoreBaselineSnapshot} from "./store";
import type {CatalogCost, CatalogEntry, CatalogSnapshot} from "./types";
import {MAX_CATALOG_ENTRIES, parseCatalogEntry} from "./validate";

/** Independent of the 4 MiB ordinary-JSON limit: the full Models.dev document is about 5.6 MB. */
export const MODEL_CATALOG_MAX_BYTES = 8 * 1024 * 1024;
const MODEL_CATALOG_TIMEOUT_MS = 60_000;
export const CATALOG_SELECTION_KEY = "modelCatalogSelection";
export const MAX_SELECTION_KEYS = 2000;
const MAX_SELECTION_KEY_LENGTH = 256;
const scope: ProjectionScope = scopeJson;

export interface CatalogSelection {
    autoIncludeCommon: boolean;
    /** "provider/id"; the id may itself contain "/". */
    modelKeys: string[];
}

type CatalogSyncFailureCode =
    "network"
    | "timeout"
    | "too-large"
    | "invalid-format"
    | "cancelled"
    | "storage"
    | "http-status";
export type CatalogSyncResult =
    | { ok: true; count: number; syncedAt: string; truncated: boolean }
    | { ok: false; code: CatalogSyncFailureCode; message: string };

const DEFAULT_SELECTION: CatalogSelection = {autoIncludeCommon: true, modelKeys: []};

function validKeys(keys: unknown): keys is string[] {
    return Array.isArray(keys) && keys.length <= MAX_SELECTION_KEYS &&
        keys.every(key => typeof key === "string" && key.length > 0 && key.length <= MAX_SELECTION_KEY_LENGTH);
}

function parseSelection(raw: unknown): CatalogSelection | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const {autoIncludeCommon, modelKeys} = raw as Record<string, unknown>;
    if (typeof autoIncludeCommon !== "boolean" || !validKeys(modelKeys)) return undefined;
    return {autoIncludeCommon, modelKeys: [...new Set(modelKeys)]};
}

/** Unreadable or corrupt storage falls back to the default selection. */
export async function getCatalogSelection(): Promise<CatalogSelection> {
    return await getDeviceSetting(CATALOG_SELECTION_KEY, parseSelection) ?? {...DEFAULT_SELECTION, modelKeys: []};
}

export async function putCatalogSelection(selection: CatalogSelection): Promise<void> {
    const parsed = parseSelection(selection);
    if (!parsed) throw new Error(`模型选择无效：最多 ${MAX_SELECTION_KEYS} 个，每个标识不超过 ${MAX_SELECTION_KEY_LENGTH} 个字符`);
    await putDeviceSetting(CATALOG_SELECTION_KEY, parsed);
}

const optional = <T extends z.ZodTypeAny>(schema: T) => schema.optional().catch(undefined);
const maybeNumber = optional(z.number());
// Only fields the projection reads. Unknown fields are ignored; a malformed optional field reads as absent
// (never as 0), while a missing id/name drops that one model.
const modelSchema = z.object({
    id: z.string().min(1), name: z.string().min(1),
    type: optional(z.string()), status: optional(z.string()),
    canonical_model_id: optional(z.string()), release_date: optional(z.string()),
    reasoning: optional(z.boolean()), tool_call: optional(z.boolean()),
    limit: optional(z.object({context: maybeNumber, output: maybeNumber})),
    modalities: optional(z.object({input: optional(z.array(z.string())), output: optional(z.array(z.string()))})),
    cost: optional(z.object({
        input: maybeNumber,
        output: maybeNumber,
        cache_read: maybeNumber,
        cache_write: maybeNumber
    })),
});

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Splits a "provider/id" key; Models.dev provider ids contain no "/". */
function splitKey(key: string): { provider: string; id: string } | undefined {
    const at = key.indexOf("/");
    return at > 0 && at < key.length - 1 ? {provider: key.slice(0, at), id: key.slice(at + 1)} : undefined;
}

/** Same model offered under different providers/prefixes: canonical id, else lowercase id without prefix. */
function normalizedId(entry: CatalogEntry): string {
    return entry.canonicalId ?? entry.id.slice(entry.id.lastIndexOf("/") + 1).toLowerCase();
}

/** One entry per normalized id: an original vendor beats an aggregator, then provider/id order. */
function representative(group: readonly CatalogEntry[]): CatalogEntry {
    const isOrigin = (entry: CatalogEntry) => scope.originProviders.includes(entry.provider);
    return [...group].sort((a, b) => Number(isOrigin(b)) - Number(isOrigin(a)) || compareEntries(a, b))[0];
}

/** A selectable line of the model picker: all equivalent entries (same normalized id) behind one row. */
export interface CatalogRow {
    /** Representative entry facts. */
    provider: string;
    providerName: string;
    id: string;
    name: string;
    releaseDate?: string;
    cost?: CatalogCost;
    imageInput?: boolean;
    /** Every provider the equivalent entries come from. */
    providers: string[];
    /** "provider/id" of every equivalent entry; ticking the row ticks all of them. */
    modelKeys: string[];
}

/** Groups entries by the same normalized-id rule the sync uses for manual picks. */
export function buildCatalogRows(entries: readonly CatalogEntry[], providerNames: Readonly<Record<string, string>> = {}): CatalogRow[] {
    const groups = new Map<string, CatalogEntry[]>();
    for (const entry of entries) {
        const key = normalizedId(entry);
        const group = groups.get(key);
        if (group) group.push(entry);
        else groups.set(key, [entry]);
    }
    const rows: CatalogRow[] = [];
    for (const group of groups.values()) {
        const main = representative(group);
        rows.push({
            provider: main.provider,
            providerName: providerNames[main.provider] ?? main.provider,
            id: main.id,
            name: main.name,
            ...(main.releaseDate ? {releaseDate: main.releaseDate} : {}),
            ...(main.cost ? {cost: main.cost} : {}),
            ...(main.imageInput !== undefined ? {imageInput: main.imageInput} : {}),
            providers: [...new Set(group.map(entry => entry.provider))].sort(),
            modelKeys: group.map(entry => `${entry.provider}/${entry.id}`).sort(),
        });
    }
    return rows.sort((a, b) => (a.releaseDate ?? "") < (b.releaseDate ?? "") ? 1 : (a.releaseDate ?? "") > (b.releaseDate ?? "") ? -1 : a.name.localeCompare(b.name));
}

/**
 * Sanitizes only the providers the selection can reach. The raw document (about 5.6 MB parsed) is not retained:
 * callers drop it right after this returns.
 */
function sanitizeProviders(root: Record<string, unknown>, wanted: ReadonlySet<string>): {
    providers: Record<string, RawProvider>;
    valid: Set<string>
} {
    const providers: Record<string, RawProvider> = {};
    const valid = new Set<string>();
    for (const [id, raw] of Object.entries(root)) {
        // `providers[id] = ...` with id "__proto__" would replace the object's prototype instead of adding a
        // key, so a hostile document could make absent providers appear to exist. Not covered by a test: the
        // helper is private and the effect is invisible through Object.keys/entries (see the task notes).
        if (id === "__proto__" || !isRecord(raw) || !isRecord(raw.models)) continue;
        valid.add(id);
        if (!wanted.has(id)) continue;
        const models: RawProvider["models"] = {};
        for (const model of Object.values(raw.models)) {
            const parsed = modelSchema.safeParse(model);
            if (parsed.success && parsed.data.id !== "__proto__") models[parsed.data.id] = parsed.data;
        }
        providers[id] = {api: raw.api, models};
    }
    return {providers, valid};
}

/**
 * Projects the selection. The common scope is exactly the build-time baseline projection (so connector-provider
 * prices keep matching at tier 1). Manual picks are merged by normalized id, preferring an original vendor over an
 * aggregator; a manual pick already in the common scope is not repeated.
 */
function projectSelection(root: Record<string, unknown>, selection: CatalogSelection, now: string): {
    entries: CatalogEntry[];
    providerOrigins: Record<string, string>
} | undefined {
    const manual = selection.modelKeys.flatMap(key => splitKey(key) ?? []);
    const wanted = new Set<string>(manual.map(item => item.provider));
    if (selection.autoIncludeCommon) for (const id of [...scope.fullProviders, ...scope.originProviders]) wanted.add(id);
    const {providers, valid} = sanitizeProviders(root, wanted);
    if (!valid.size) return undefined;
    if (selection.autoIncludeCommon && scope.fullProviders.filter(id => valid.has(id)).length * 2 < scope.fullProviders.length) return undefined;

    const common = selection.autoIncludeCommon ? projectCommonScope(providers, scope, now) : {
        entries: [],
        providerOrigins: {}
    };
    const providerOrigins: Record<string, string> = {...common.providerOrigins};
    const have = new Set(common.entries.map(entry => `${entry.provider}\u0000${entry.id}`));
    const groups = new Map<string, CatalogEntry[]>();
    for (const {provider, id} of manual) {
        const model = providers[provider]?.models[id];
        if (!model || have.has(`${provider}\u0000${id}`)) continue;
        const entry = parseCatalogEntry(projectEntry(provider, model));
        if (!entry) continue;
        const origin = typeof providers[provider].api === "string" ? originOf(providers[provider].api) : undefined;
        if (origin) providerOrigins[provider] = origin;
        const key = normalizedId(entry);
        groups.set(key, [...groups.get(key) ?? [], entry]);
    }
    const picked = [...groups.values()].map(representative);
    const entries: CatalogEntry[] = [];
    for (const raw of common.entries) {
        const entry = parseCatalogEntry(raw);
        if (entry) entries.push(entry); // One bad entry is dropped, never the whole sync.
    }
    entries.push(...picked);
    entries.sort(compareEntries);
    return {entries, providerOrigins};
}

/** Drops the oldest releases (undated first) until the row fits the entry and byte budgets. */
function fitBudget(entries: CatalogEntry[], providerOrigins: Record<string, string>, syncedAt: string): {
    entries: CatalogEntry[];
    truncated: boolean
} | undefined {
    const bytesOf = (items: CatalogEntry[]) => utf8Bytes(JSON.stringify({
        v: 1,
        syncedAt,
        providerOrigins,
        entries: items
    }));
    let total = bytesOf(entries);
    if (entries.length <= MAX_CATALOG_ENTRIES && total <= DEVICE_SETTING_MAX_BYTES) return {entries, truncated: false};
    const oldestFirst = entries.map((entry, index) => ({
        index,
        size: utf8Bytes(JSON.stringify(entry)) + 1,
        date: entry.releaseDate ?? ""
    }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.index - b.index));
    const dropped = new Set<number>();
    for (const item of oldestFirst) {
        if (entries.length - dropped.size <= MAX_CATALOG_ENTRIES && total <= DEVICE_SETTING_MAX_BYTES) break;
        dropped.add(item.index);
        total -= item.size;
    }
    const kept = entries.filter((_, index) => !dropped.has(index));
    if (!kept.length || bytesOf(kept) > DEVICE_SETTING_MAX_BYTES) return undefined;
    return {entries: kept, truncated: true};
}

const fail = (code: CatalogSyncFailureCode, message: string): {
    ok: false;
    code: CatalogSyncFailureCode;
    message: string
} => ({ok: false, code, message});

/** Reads and parses the document; the byte buffer and text are released when this returns. */
async function readCatalogJson(response: Response, signal: AbortSignal): Promise<unknown> {
    const bytes = await readResponseBytes(response, MODEL_CATALOG_MAX_BYTES, signal);
    return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
}

type DownloadResult = { ok: true; root: Record<string, unknown> } | {
    ok: false;
    code: CatalogSyncFailureCode;
    message: string
};

/** The one models.dev download shared by sync and the picker index: bounded read, 60 s deadline, friendly failures. */
async function downloadCatalog(options: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch
}, verb: string): Promise<DownloadResult> {
    if (options.signal?.aborted) return fail("cancelled", `已取消${verb}`);
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, {once: true});
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, MODEL_CATALOG_TIMEOUT_MS);
    const interrupted = (): DownloadResult | undefined =>
        timedOut ? fail("timeout", `${verb}超时，请稍后重试`)
            : controller.signal.aborted ? fail("cancelled", `已取消${verb}`) : undefined;
    try {
        let response: Response;
        try {
            response = await requestOnce(MODEL_CATALOG_URL, {method: "GET", headers: {Accept: "application/json"}}, {
                fetchImpl: options.fetchImpl,
                signal: controller.signal,
                credentials: "omit",
                redirect: "follow",
                runtimePurpose: "model-catalog",
            });
        } catch (error) {
            return interrupted() ?? (isReadAbort(error) ? fail("cancelled", `已取消${verb}`) : fail("network", "无法连接 models.dev，请检查网络后重试"));
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return fail("http-status", `models.dev 返回了 HTTP ${response.status}，请稍后重试`);
        }
        if (!/json/i.test(response.headers.get("content-type") ?? "")) {
            await response.body?.cancel().catch(() => undefined);
            return fail("invalid-format", "models.dev 返回的不是 JSON 数据");
        }
        let root: unknown;
        try {
            root = await readCatalogJson(response, controller.signal);
        } catch (error) {
            if (error instanceof ResponseLimitError) return fail("too-large", "模型目录数据超过 8 MiB，已停止读取");
            return interrupted() ?? (isReadAbort(error) ? fail("cancelled", `已取消${verb}`) : error instanceof SyntaxError || error instanceof TypeError
                ? fail("invalid-format", "模型目录数据无法解析")
                : fail("network", "读取模型目录时连接中断，请重试"));
        }
        return isRecord(root) ? {ok: true, root} : fail("invalid-format", "模型目录数据格式不符");
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
    }
}

/**
 * User-triggered only. Network and parsing finish before any database write; the single write is one transaction,
 * and any failure leaves both the stored row and the in-memory snapshot unchanged.
 */
export async function syncModelCatalog(
    selection: CatalogSelection, options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<CatalogSyncResult> {
    const syncedAt = new Date().toISOString();
    const downloaded = await downloadCatalog(options, "同步");
    if (!downloaded.ok) return downloaded;
    // The parsed document is not retained: only `parsed` outlives this call's first statement.
    const parsed = projectSelection(downloaded.root, selection, syncedAt);
    if (!parsed || !parsed.entries.length) return fail("invalid-format", "模型目录数据格式不符，或所选范围内没有可用模型");
    if (options.signal?.aborted) return fail("cancelled", "已取消同步");
    const fitted = fitBudget(parsed.entries, parsed.providerOrigins, syncedAt);
    if (!fitted) return fail("storage", "模型目录数据过大，无法保存到本机");
    try {
        await putDeviceSetting(MODEL_CATALOG_KEY, {
            v: 1,
            syncedAt,
            providerOrigins: parsed.providerOrigins,
            entries: fitted.entries
        });
    } catch {
        return fail("storage", "保存模型目录失败，已保留原有数据");
    }
    const snapshot: CatalogSnapshot = {
        source: "synced",
        syncedAt,
        providerOrigins: parsed.providerOrigins,
        entries: fitted.entries
    };
    applySyncedSnapshot(snapshot);
    return {ok: true, count: fitted.entries.length, syncedAt, truncated: fitted.truncated};
}

/**
 * Picker-only full list: downloads the same public document and projects light rows for the dialog. It writes nothing
 * and leaves the in-memory snapshot alone; the caller drops the rows when the dialog closes.
 */
export async function fetchCatalogIndex(
    options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: true; rows: CatalogRow[] } | { ok: false; code: CatalogSyncFailureCode; message: string }> {
    const downloaded = await downloadCatalog(options, "加载");
    if (!downloaded.ok) return downloaded;
    const entries: CatalogEntry[] = [];
    const names: Record<string, string> = {};
    for (const [providerId, raw] of Object.entries(downloaded.root)) {
        if (!isRecord(raw) || !isRecord(raw.models)) continue;
        if (typeof raw.name === "string" && raw.name) names[providerId] = raw.name.slice(0, 80);
        for (const model of Object.values(raw.models)) {
            const parsed = modelSchema.safeParse(model);
            const entry = parsed.success ? parseCatalogEntry(projectEntry(providerId, parsed.data)) : undefined;
            if (entry) entries.push(entry);
        }
    }
    if (!entries.length) return fail("invalid-format", "模型目录数据格式不符，或没有可用模型");
    return {ok: true, rows: buildCatalogRows(entries, names)};
}

/** "恢复为内置数据": removes the synced row and returns to the baseline. A failed delete keeps the current snapshot. */
export async function clearSyncedCatalog(): Promise<boolean> {
    try {
        await deleteDeviceSetting(MODEL_CATALOG_KEY);
    } catch {
        return false;
    }
    await restoreBaselineSnapshot();
    return true;
}
