import {db} from '@momoki/studio/reference/db/database';
import {executeWebRequest, testSearchConnection} from '@momoki/studio/reference/lib/ai/tavily';
import {connectorProbeFetch} from '@momoki/studio/reference/lib/runtimeFetch';
import {isTauriRuntime} from '@momoki/studio/reference/lib/runtimeIdentity';
import {getProductStorage} from '@momoki/studio/reference/lib/productStorage';
import {assert, type Evidence} from './acceptanceEvidence';

import {fixtureTavilyFetch, TAVILY_PROBE_KEY} from './tavilyProbeFetch';

const PREFIX = '原生 Tavily 合成探针：';

export async function checkTavilyNative(evidence: Evidence, endpoint: string) {
    const profile = getProductStorage();
    assert(isTauriRuntime() && profile.runtime === 'tauri' && profile.profileId?.startsWith('dev.momoki.review.tavily.'), '必须是独立原生 Tavily 探针身份');
    assert(await db.searchConnections.count() === 0, '独立探针已有搜索配置，停止且不覆盖');
    const revision = `tavily-probe-${crypto.randomUUID()}`;
    let calls = 0;
    const native = connectorProbeFetch(endpoint);
    const transport = fixtureTavilyFetch(endpoint, (input, init) => {
        calls++;
        return native(input, init);
    });
    evidence.record(`${PREFIX}实际身份与固定范围`, true, {
        profileId: profile.profileId,
        databaseName: profile.databaseName,
        fixtureOrigin: new URL(endpoint).origin,
        adapterOrigin: 'https://api.tavily.com',
        transport: 'shared runtime fetch / official native HTTP',
        mappedBy: 'explicit test-only fetchImpl',
        paidRequests: 0
    });
    await db.searchConnections.add({
        id: 'tavily',
        provider: 'tavily',
        apiKey: TAVILY_PROBE_KEY,
        enabled: true,
        revision,
        updatedAt: new Date().toISOString()
    });
    try {
        const usage = await evidence.check(`${PREFIX}真实原生 GET usage`, async () => {
            const before = calls;
            const result = await testSearchConnection(TAVILY_PROBE_KEY, {fetchImpl: transport});
            assert(result.ok && calls === before + 1, 'usage 未成功或请求次数错误');
            return {requests: 1, method: 'GET', path: '/usage', authenticatedWithSyntheticKey: true};
        }, value => value);
        assert(usage, 'usage 检查失败');
        const search = await evidence.check(`${PREFIX}真实原生 POST search`, async () => {
            const before = calls;
            const result = await executeWebRequest('search', {
                query: 'native synthetic Tavily probe',
                maxResults: 1
            }, revision, {fetchImpl: transport});
            assert(result.ok && result.kind === 'search' && result.sources.length === 1 && result.sources[0].url === 'https://example.org/native-fixture' &&
                result.sources[0].snippet === '这是本地合成检索结果，不能作为真实搜索证明。' && calls === before + 1, 'search 真实协议／内容／次数错误');
            return {
                requests: 1,
                method: 'POST',
                path: '/search',
                sourceUrl: result.sources[0].url,
                syntheticTextExact: true
            };
        }, value => value);
        assert(search, 'search 检查失败');
        const extract = await evidence.check(`${PREFIX}真实原生 POST extract`, async () => {
            const before = calls;
            const result = await executeWebRequest('read', {url: 'https://example.org/native-fixture'}, revision, {fetchImpl: transport});
            assert(result.ok && result.kind === 'read' && result.text === '合成资料全文。' && result.coverage === 'provider_extraction' && calls === before + 1, 'extract 真实协议／内容／次数错误');
            return {requests: 1, method: 'POST', path: '/extract', coverage: result.coverage, syntheticTextExact: true};
        }, value => value);
        assert(extract, 'extract 检查失败');
        const stale = await evidence.check(`${PREFIX}过期配置零请求`, async () => {
            const before = calls;
            const result = await executeWebRequest('search', {query: 'must not send'}, `${revision}-stale`, {fetchImpl: transport});
            assert(!result.ok && result.code === 'configuration_changed' && calls === before, '过期配置发出 HTTP');
            return {requests: 0, code: result.code};
        }, value => value);
        assert(stale, '配置门检查失败');
    } finally {
        await db.transaction('rw', [db.searchConnections], async (db) => {
            const current = await db.searchConnections.get('tavily');
            assert(current?.revision === revision, '探针配置被更改，不删除其他 owner');
            await db.searchConnections.delete('tavily');
        });
        evidence.record(`${PREFIX}仅清理本次合成配置`, await db.searchConnections.count() === 0, {
            configurationRemoved: true,
            requests: calls
        });
    }
    assert(calls === 3, '成功探针必须恰好三次合成请求');
    evidence.record(`${PREFIX}独立探针完成`, true, {
        passed: true, requests: calls, paidRequests: 0, liveTavilyAccountVerified: false,
        wholeProductAcceptanceComplete: false, wholeHistoricalAcceptanceComplete: false
    });
}
