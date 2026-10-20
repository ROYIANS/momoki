import {beforeEach,describe,expect,it,vi} from 'vitest';
import {db} from '@/platform/product/store';
import {checkTavilyNative} from '../apps/desktop/ui/tavilyProbe';
import {fixtureTavilyFetch} from '../apps/desktop/ui/tavilyProbeFetch';
import {Evidence} from '../apps/desktop/ui/acceptanceEvidence';

const state=vi.hoisted(()=>({native:true,profile:'dev.momoki.review.tavily.source-test',transport:vi.fn<typeof fetch>()}));
vi.mock('@/platform/runtime/runtimeIdentity',()=>({isTauriRuntime:()=>state.native}));
vi.mock('@/platform/runtime/storageProfile',()=>({getProductStorage:()=>({runtime:'tauri',storage:'sqlite',profileId:state.profile,databaseName:`momoki-desktop:${state.profile}:v1`})}));
vi.mock('@/platform/runtime/runtimeFetch',()=>({connectorProbeFetch:()=>state.transport}));

const endpoint='http://127.0.0.1:56368/v1';
const init=(path:string):RequestInit=>({method:path==='/usage'?'GET':'POST',headers:{Authorization:'Bearer synthetic-tavily-probe-only'},
    ...(path==='/usage'?{}:{body:'{}'}),credentials:'omit',redirect:'error'});
beforeEach(()=>{state.native=true;state.profile='dev.momoki.review.tavily.source-test';state.transport.mockReset();});

describe('test-only Tavily exact routing contract',()=>{
    it.each(['/usage','/search','/extract'])('maps only %s to the exact loopback with unchanged init',async path=>{
        state.transport.mockResolvedValue(new Response('{}'));
        const fetchImpl=fixtureTavilyFetch(endpoint,state.transport);const request=init(path);
        await fetchImpl(`https://api.tavily.com${path}`,request);
        expect(state.transport).toHaveBeenCalledExactlyOnceWith(`http://127.0.0.1:56368${path}`,request);
    });
    it.each(['https://evil.test/search','https://api.tavily.com/other','https://api.tavily.com/search?secret=x',
        'https://api.tavily.com/search#x','https://user:pass@api.tavily.com/search'])('rejects address %s before transport',url=>{
        expect(()=>fixtureTavilyFetch(endpoint,state.transport)(url,init('/search'))).toThrow();
        expect(state.transport).not.toHaveBeenCalled();
    });
    it.each([{...init('/usage'),method:'POST'},{...init('/search'),method:'GET'},
        {...init('/search'),headers:new Headers({Authorization:'Bearer real-or-other-key'})},{...init('/search'),credentials:'include' as const},
        {...init('/search'),redirect:'follow' as const},{...init('/search'),headers:new Headers({Authorization:'Bearer synthetic-tavily-probe-only',Cookie:'private'})}])('rejects out-of-scope request policy %#',request=>{
        expect(()=>fixtureTavilyFetch(endpoint,state.transport)('https://api.tavily.com/search',request)).toThrow();
        expect(state.transport).not.toHaveBeenCalled();
    });
    it.each(['https://api.tavily.com/v1','http://localhost:56368/v1','http://127.0.0.1:56368/v1?x=1'])('rejects uncontrolled fixture destination %s',value=>{
        expect(()=>fixtureTavilyFetch(value,state.transport)).toThrow();
    });
});

describe('visible-probe shared adapter and owned cleanup',()=>{
    it('executes the three real adapter paths, blocks stale revision and cleans only synthetic config',async()=>{
        state.transport.mockImplementation(async input=>{
            const path=new URL(String(input)).pathname;
            return Response.json(path==='/usage'?{account:{current_plan:'fixture'}}:path==='/search'?
                {results:[{title:'合成',url:'https://example.org/native-fixture',content:'这是本地合成检索结果，不能作为真实搜索证明。'}]}:
                {results:[{url:'https://example.org/native-fixture',raw_content:'合成资料全文。'}]});
        });
        const evidence=new Evidence(()=>{});await checkTavilyNative(evidence,endpoint);
        expect(state.transport.mock.calls.map(([url,request])=>[new URL(String(url)).pathname,request?.method])).toEqual([['/usage','GET'],['/search','POST'],['/extract','POST']]);
        expect(JSON.parse(String(state.transport.mock.calls[1][1]?.body))).toMatchObject({query:'native synthetic Tavily probe',max_results:1,search_depth:'basic',include_images:false});
        expect(JSON.parse(String(state.transport.mock.calls[2][1]?.body))).toMatchObject({urls:['https://example.org/native-fixture'],extract_depth:'basic',format:'markdown'});
        expect(await db.searchConnections.count()).toBe(0);
        expect(evidence.events).toHaveLength(7);expect(evidence.events.every(event=>event.ok)).toBe(true);
        expect(evidence.events.at(-1)?.detail).toMatchObject({requests:3,paidRequests:0,liveTavilyAccountVerified:false,wholeProductAcceptanceComplete:false,wholeHistoricalAcceptanceComplete:false});
        expect(JSON.stringify(evidence.events)).not.toContain('Bearer');
    });
    it('cleans its row after a malformed native response without a completion claim',async()=>{
        state.transport.mockResolvedValue(new Response('not-json'));
        const evidence=new Evidence(()=>{});await expect(checkTavilyNative(evidence,endpoint)).rejects.toThrow();
        expect(state.transport).toHaveBeenCalledOnce();expect(await db.searchConnections.count()).toBe(0);
        expect(evidence.events.some(event=>!event.ok)).toBe(true);
        expect(evidence.events.some(event=>event.name.endsWith('独立探针完成'))).toBe(false);
    });
    it('rejects an existing config without reading/overwriting it or sending',async()=>{
        await db.searchConnections.add({id:'tavily',provider:'tavily',apiKey:'other-config',enabled:true,revision:'other',updatedAt:'now'});
        await expect(checkTavilyNative(new Evidence(()=>{}),endpoint)).rejects.toThrow('已有搜索配置');
        expect(state.transport).not.toHaveBeenCalled();expect((await db.searchConnections.get('tavily'))?.revision).toBe('other');
    });
    it.each(['normal','dev.momoki.prototype.acceptance'])('rejects non-dedicated profile %s before config/transport',async profile=>{
        state.profile=profile;
        await expect(checkTavilyNative(new Evidence(()=>{}),endpoint)).rejects.toThrow('独立原生');
        expect(state.transport).not.toHaveBeenCalled();expect(await db.searchConnections.count()).toBe(0);
    });
});
