import {requestOnce} from "../../../platform/http/requestBoundary";
import {readResponseJson, ResponseLimitError} from "@momoki/agent-providers/http";
import {db} from '../../../platform/product/store';
import {publicWebUrl, type WebFailure, type WebFailureCode, type WebResult, type WebSource} from '../../settings/models/search';
import {nowIso} from '../../../platform/identity';

export interface WebSearchArgs {
    query: string;
    maxResults?: number;
    timeRange?: 'day' | 'week' | 'month' | 'year'
}

export interface TavilyOptions {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function webFailure(code: WebFailureCode, message: string, serviceMayHaveRun = false): WebFailure {
    return {ok: false, code, message, serviceMayHaveRun, retrievedAt: nowIso()};
}

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function clean(value: unknown, max: number, key: string): string {
    if (typeof value !== 'string') return '';
    return value.split(key).join('[已隐藏]').split(encodeURIComponent(key)).join('[已隐藏]').slice(0, max);
}

function sourceUrl(value: unknown, key: string): string | undefined {
    if (typeof value !== 'string' || value.includes(key) || value.includes(encodeURIComponent(key))) return undefined;
    return publicWebUrl(value);
}

async function request(path: 'search' | 'extract' | 'usage', key: string, body: unknown, options: TavilyOptions): Promise<{
    ok: true;
    value: unknown
} | WebFailure> {
    if (options.signal?.aborted) return webFailure('cancelled', '已停止本地等待，未发送请求');
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, options.timeoutMs ?? 30_000);
    const mayHaveRun = path !== 'usage';
    try {
        const response = await requestOnce(`https://api.tavily.com/${path}`, {
            method: path === 'usage' ? 'GET' : 'POST',
            headers: {Authorization: `Bearer ${key}`, ...(path !== 'usage' ? {'Content-Type': 'application/json'} : {})},
            ...(path !== 'usage' ? {body: JSON.stringify(body)} : {}),
        }, {
            fetchImpl: options.fetchImpl,
            signal: controller.signal,
            credentials: 'omit',
            redirect: 'error',
            runtimePurpose: path === 'usage' ? 'search-probe' : undefined
        });
        if (!response.ok) {
            await response.body?.cancel();
            const code = response.status === 401 || response.status === 403 ? 'authentication' : response.status === 429 ? 'rate_limit' : [402, 432, 433].includes(response.status) ? 'quota' : 'http';
            const message = code === 'authentication' ? 'Tavily 鉴权失败，请检查 API Key' : code === 'rate_limit' ? '搜索服务请求过于频繁，请稍后明确发起新请求' : code === 'quota' ? '搜索服务额度不可用，请检查账户' : `搜索服务返回 HTTP ${response.status}`;
            return webFailure(code, message, mayHaveRun);
        }
        try {
            return {ok: true, value: await readResponseJson(response, MAX_RESPONSE_BYTES, controller.signal, false)};
        } catch (error) {
            if (controller.signal.aborted) throw error;
            return error instanceof ResponseLimitError ? webFailure('response_too_large', '服务响应超过 2 MiB，未读取超限内容', mayHaveRun) : webFailure('invalid_response', '搜索服务返回了无法解析的数据', mayHaveRun);
        }
    } catch {
        return webFailure(timedOut ? 'timeout' : options.signal?.aborted ? 'cancelled' : 'transport', timedOut ? '搜索服务等待超时，服务可能已处理请求；没有自动重试' : options.signal?.aborted ? '已停止本地等待，不表示服务已取消或退款' : '无法连接搜索服务（网络或跨域限制），请在连接页测试鉴权；请求可能已处理，没有自动重试', mayHaveRun);
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
    }
}

/** Only the adapter reads saved credentials. Expected failures are complete tool results. */
export async function executeWebRequest(kind: 'search' | 'read', args: WebSearchArgs | {
    url: string
}, revision: string | undefined, options: TavilyOptions = {}): Promise<WebResult> {
    const config = await db.searchConnections.get('tavily');
    if (!config?.enabled || !config.apiKey) return webFailure('not_configured', '请在「连接 → 联网搜索」配置并启用 Tavily，然后重新发起调研');
    if (!revision || config.revision !== revision) return webFailure('configuration_changed', '搜索连接已变化，请重新准备并批准这次调研');
    const search = args as WebSearchArgs;
    const url = kind === 'read' ? publicWebUrl((args as { url: string }).url) : undefined;
    if (kind === 'read' && !url) return webFailure('invalid_response', '仅支持不含凭据的公开 HTTP(S) 网页');
    const body = kind === 'search' ? {
        query: search.query,
        max_results: search.maxResults ?? 5, ...(search.timeRange ? {time_range: search.timeRange} : {}),
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        auto_parameters: false,
    } : {urls: [url], extract_depth: 'basic', format: 'markdown', include_images: false};
    const response = await request(kind === 'search' ? 'search' : 'extract', config.apiKey, body, options);
    if (!response.ok) return response;
    const data = record(response.value);
    if (!data || !Array.isArray(data.results)) return webFailure('invalid_response', '搜索服务返回的数据缺少结果列表', true);
    const requestId = clean(data.request_id, 160, config.apiKey) || undefined;
    if (kind === 'search') {
        const sources: WebSource[] = [];
        for (const raw of data.results.slice(0, 10)) {
            const item = record(raw);
            const href = item && sourceUrl(item.url, config.apiKey);
            if (!item || !href) continue;
            sources.push({
                id: `web-${sources.length + 1}`,
                title: clean(item.title, 240, config.apiKey) || new URL(href).hostname,
                url: href,
                snippet: clean(item.content, 1500, config.apiKey), ...(typeof item.published_date === 'string' ? {publishedAt: clean(item.published_date, 100, config.apiKey)} : {})
            });
            if (sources.length >= (search.maxResults ?? 5)) break;
        }
        // Each source can carry a long URL; preserve a strict total result budget too.
        const result = {
            ok: true as const,
            kind: 'search' as const,
            query: clean(search.query, 500, config.apiKey),
            sources,
            retrievedAt: nowIso(),
            requestId,
            omittedSources: 0
        };
        while (JSON.stringify(result).length > 31_000) sources.pop();
        result.omittedSources = data.results.length - sources.length;
        return result;
    }
    const item = record(data.results[0]);
    const href = item && sourceUrl(item.url, config.apiKey);
    if (!item || !href || typeof item.raw_content !== 'string' || !item.raw_content.trim()) return webFailure('extraction_failed', '未取得网页正文，可能是页面不可访问或提取失败；没有自动重试', true);
    const result = {
        ok: true as const,
        kind: 'read' as const,
        requestedUrl: url!,
        url: href,
        retrievedAt: nowIso(),
        // The transport already bounded the accepted response. Keep its complete
        // sanitized extraction for owned retention; only the saved job preview is
        // projected into model context by the caller.
        text: clean(item.raw_content, Infinity, config.apiKey),
        availableLength: 0,
        truncated: false,
        coverage: 'provider_extraction' as const,
        requestId
    };
    result.availableLength = result.text.length;
    return result;
}

export async function testSearchConnection(apiKey?: string, options: TavilyOptions = {}): Promise<{
    ok: boolean;
    message: string
}> {
    const key = apiKey?.trim() || (await db.searchConnections.get('tavily'))?.apiKey;
    if (!key || key.length > 2048 || /\s/.test(key)) return {ok: false, message: '请填写 Tavily API Key'};
    const result = await request('usage', key, undefined, options);
    if (!result.ok) return {ok: false, message: result.message};
    if (!record(result.value)) return {ok: false, message: '鉴权接口返回无效数据'};
    return {ok: true, message: '鉴权读取成功；未执行搜索，搜索与网页读取权限以实际调用为准'};
}
