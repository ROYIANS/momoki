import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {githubApi} from './publish-draft.mjs';

const assetUrl='https://uploads.github.com/repos/ROYIANS/momoki/releases/1/assets?name=Momoki%20%E7%89%88%20%2B%23.dmg';
const binary=Buffer.from(Array.from({length:150003},(_,index)=>(index*37)%256));

async function fixture(t,handler) {
    const directory=await mkdtemp(join(tmpdir(),'momoki-upload-http-'));
    const path=join(directory,'actual binary.dmg');
    await writeFile(path,binary);
    const state={requests:[],calls:[],streams:[]};
    const server=createServer((request,response)=> {
        if (handler) {handler(request,response,state);return;}
        const chunks=[];
        request.on('data',chunk=>chunks.push(chunk));
        request.on('end',()=> {
            const row={url:request.url,method:request.method,headers:request.headers,body:Buffer.concat(chunks)};
            state.requests.push(row);
            const status=request.method === 'POST' && !request.headers['content-length'] ? 400 : 201;
            response.writeHead(status,{'Content-Type':'application/json'});
            response.end(JSON.stringify({id:7,size:row.body.length}));
        });
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const origin=`http://127.0.0.1:${server.address().port}`;
    t.after(async ()=> {
        server.closeAllConnections();
        await new Promise((accept,reject)=>server.close(error=>error ? reject(error) : accept()));
        await rm(directory,{recursive:true,force:true});
    });
    const fetchImpl=(url,init)=> {
        const remote=new URL(url);
        assert.ok(['uploads.github.com','api.github.com'].includes(remote.hostname));
        assert.equal(remote.protocol,'https:');
        state.calls.push({url:remote,init});
        if (init.body && typeof init.body.destroy === 'function') {
            const stream=init.body;
            const closed=new Promise(accept=>stream.once('close',accept));
            state.streams.push({stream,closed});
        }
        return fetch(new URL(remote.pathname+remote.search,origin),init);
    };
    return {path,state,origin,api:githubApi('fixture-token',fetchImpl)};
}

async function assertClosed(state) {
    assert.equal(state.streams.length,1);
    const {stream,closed}=state.streams[0];
    await closed;
    assert.equal(stream.destroyed,true);
    assert.equal(stream.closed,true);
    assert.equal(stream.fd,null);
}

test('actual Node fetch reproduces HTTP 400 for the former unframed file stream',async t=> {
    const f=await fixture(t);
    const body=createReadStream(f.path);
    try {
        const response=await fetch(new URL(new URL(assetUrl).pathname+new URL(assetUrl).search,f.origin),{
            method:'POST',headers:{'Content-Type':'application/octet-stream'},body,duplex:'half',
        });
        assert.equal(response.status,400);
        await response.json();
        assert.equal(f.state.requests[0].headers['content-length'],undefined);
        assert.equal(f.state.requests[0].headers['transfer-encoding'],'chunked');
        assert.deepEqual(f.state.requests[0].body,binary);
    } finally {body.destroy();}
});

test('GitHub upload sends exact multichunk binary bytes with Content-Length and encoded asset name',async t=> {
    const f=await fixture(t);
    assert.deepEqual(await f.api.upload(assetUrl,f.path),{id:7,size:binary.length});
    const row=f.state.requests[0];
    assert.equal(row.method,'POST');
    assert.equal(row.headers['content-length'],String(binary.length));
    assert.equal(row.headers['transfer-encoding'],undefined);
    assert.equal(row.headers['content-type'],'application/octet-stream');
    assert.equal(row.headers.authorization,'Bearer fixture-token');
    assert.equal(row.headers.accept,'application/vnd.github+json');
    assert.equal(row.headers['x-github-api-version'],'2022-11-28');
    assert.equal(row.url,new URL(assetUrl).pathname+new URL(assetUrl).search);
    assert.equal(new URL(row.url,f.origin).searchParams.get('name'),'Momoki 版 +#.dmg');
    assert.deepEqual(row.body,binary);
    assert.equal(f.state.calls[0].init.duplex,'half');
    await assertClosed(f.state);
});

test('GitHub upload permits an empty file and closes its descriptor',async t=> {
    const f=await fixture(t);await writeFile(f.path,Buffer.alloc(0));
    assert.deepEqual(await f.api.upload(assetUrl,f.path),{id:7,size:0});
    assert.equal(f.state.requests[0].headers['content-length'],'0');
    assert.equal(f.state.requests[0].headers['transfer-encoding'],undefined);
    assert.equal(f.state.requests[0].body.length,0);
    await assertClosed(f.state);
});

test('GitHub upload rejects a missing file before any HTTP call',async t=> {
    const f=await fixture(t);
    await assert.rejects(f.api.upload(assetUrl,join(f.path,'missing')),error=>['ENOENT','ENOTDIR'].includes(error.code));
    assert.equal(f.state.calls.length,0);
    assert.equal(f.state.requests.length,0);
});

test('GitHub upload propagates an early HTTP 400 and closes its file stream',async t=> {
    const f=await fixture(t,(request,response)=> {
        request.resume();
        response.writeHead(400,{'Content-Type':'application/json'});
        response.end(JSON.stringify({message:'fixture rejection'}));
    });
    await writeFile(f.path,Buffer.alloc(2*1024*1024,0x73));
    await assert.rejects(f.api.upload(assetUrl,f.path),/GitHub POST .* failed \(400\)/);
    await assertClosed(f.state);
    assert.equal(f.state.calls.length,1);
});

test('GitHub upload propagates a transport failure and closes its file stream',async t=> {
    const f=await fixture(t,request=>request.socket.destroy());
    await writeFile(f.path,Buffer.alloc(2*1024*1024,0x73));
    await assert.rejects(f.api.upload(assetUrl,f.path),/fetch failed/);
    await assertClosed(f.state);
    assert.equal(f.state.calls.length,1);
});

test('GitHub JSON and asset download retain their separate HTTP behavior',async t=> {
    const f=await fixture(t,(request,response,state)=> {
        const chunks=[];request.on('data',chunk=>chunks.push(chunk));
        request.on('end',()=> {
            state.requests.push({method:request.method,headers:request.headers,body:Buffer.concat(chunks)});
            if (request.method === 'DELETE') {response.writeHead(204);response.end();}
            else if (request.headers.accept === 'application/octet-stream') {response.writeHead(200);response.end(binary);}
            else {response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({draft:true}));}
        });
    });
    assert.deepEqual(await f.api.json('POST','/repos/ROYIANS/momoki/releases',{draft:true}),{draft:true});
    assert.deepEqual(JSON.parse(f.state.requests[0].body.toString()),{draft:true});
    assert.equal(f.state.requests[0].headers['content-type'],'application/json');
    assert.equal(f.state.calls[0].init.headers['Content-Length'],undefined);
    assert.equal(f.state.calls[0].init.duplex,undefined);
    assert.equal(await f.api.json('DELETE','/repos/ROYIANS/momoki/releases/1'),null);
    assert.deepEqual(await f.api.download('/repos/ROYIANS/momoki/releases/assets/7'),binary);
    assert.equal(f.state.requests[2].headers.accept,'application/octet-stream');
    assert.equal(f.state.requests[2].headers.authorization,'Bearer fixture-token');
    assert.equal(f.state.requests[2].headers['content-length'],undefined);
    assert.equal(f.state.streams.length,0);
});

test('GitHub upload rejects untrusted URLs before sending bytes',async t=> {
    const f=await fixture(t);
    await assert.rejects(f.api.upload('https://example.invalid/assets',f.path),/Untrusted GitHub API URL/);
    assert.equal(f.state.calls.length,0);
});
