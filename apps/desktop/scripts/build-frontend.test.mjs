import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const launcher=await readFile(new URL('./build-frontend.mjs',import.meta.url),'utf8');
const workerName='build-frontend-worker.mjs';
const report=`
import {getHeapStatistics} from 'node:v8';
import {readFileSync} from 'node:fs';
process.stdout.write(JSON.stringify({args:process.argv.slice(2),execArgv:process.execArgv,
    cwd:process.cwd(),endpoint:process.env.MOMOKI_STREAM_ENDPOINT,token:process.env.MOMOKI_STREAM_TOKEN,
    nodeOptions:process.env.NODE_OPTIONS,heapLimit:getHeapStatistics().heap_size_limit,agentPrepared:readFileSync('agent-build-ready','utf8')}));
process.stderr.write('worker stderr');
`;

async function fixture(body=report) {
    const root=await realpath(await mkdtemp(join(tmpdir(),'momoki frontend launcher ')));
    const scripts=join(root,'apps/desktop/scripts');
    await mkdir(scripts,{recursive:true});
    await mkdir(join(root,'tooling'));
    // Preserve the actual launcher's relative dependency topology. This fixture
    // isolates process forwarding; real frontend builds exercise the actual compiler.
    await writeFile(join(root,'tooling/build-agent-packages.mjs'),"import {writeFile} from 'node:fs/promises';export async function buildAgentPackages(){await writeFile(new URL('../agent-build-ready',import.meta.url),'prepared');}");
    await writeFile(join(scripts,'build-frontend.mjs'),launcher);
    await writeFile(join(scripts,workerName),body);
    return {root,entry:join(scripts,'build-frontend.mjs'),cleanup:()=>rm(root,{recursive:true,force:true})};
}
function run(f,{args=[],env={},nodeArgs=[]}={}) {
    const child=spawn(process.execPath,[...nodeArgs,f.entry,...args],{
        cwd:f.root,env:{...process.env,NODE_OPTIONS:'',...env},stdio:['ignore','pipe','pipe'],shell:false,
    });
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>stdout+=chunk);
    child.stderr.on('data',chunk=>stderr+=chunk);
    const finished=new Promise((accept,reject)=> {
        child.once('error',reject);
        child.once('close',(code,signal)=>accept({code,signal,stdout,stderr}));
    });
    return {child,finished};
}
function stopWorker(pid) {
    try {process.kill(pid,'SIGKILL');}
    catch (error) {if (error.code !== 'ESRCH') throw error;}
}

test('normal and acceptance builds inherit args, cwd and environment with one fixed worker budget',async ()=> {
    const f=await fixture();
    try {
        for (const args of [[],['--acceptance','a b;$(fixture)`literal`']]) {
            const env={MOMOKI_STREAM_ENDPOINT:'http://127.0.0.1:12345/v1',MOMOKI_STREAM_TOKEN:'fixture-only-token',NODE_OPTIONS:'--max-old-space-size=256 --no-warnings'};
            const result=await run(f,{args,env,nodeArgs:['--max-old-space-size=128']}).finished;
            assert.equal(result.code,0);assert.equal(result.signal,null);
            const actual=JSON.parse(result.stdout);
            assert.deepEqual(actual.args,args);
            assert.deepEqual(actual.execArgv,['--max-old-space-size=4096']);
            assert.equal(actual.cwd,f.root);
            assert.equal(actual.agentPrepared,'prepared');
            assert.equal(actual.endpoint,env.MOMOKI_STREAM_ENDPOINT);
            assert.equal(actual.token,env.MOMOKI_STREAM_TOKEN);
            assert.equal(actual.nodeOptions,env.NODE_OPTIONS);
            assert.ok(actual.heapLimit>4*1024**3 && actual.heapLimit<5*1024**3);
            assert.equal(result.stderr,'worker stderr');
            assert.equal(await readFile(join(f.root,'agent-build-ready'),'utf8'),'prepared');
        }
    } finally {await f.cleanup();}
});

test('frontend child failure retains its exact nonzero exit code and diagnostics',async ()=> {
    const f=await fixture("process.stderr.write('fixture build failure');process.exitCode=37;");
    try {
        const result=await run(f).finished;
        assert.equal(result.code,37);assert.equal(result.signal,null);
        assert.equal(result.stderr,'fixture build failure');
    } finally {await f.cleanup();}
});

test('an actual worker spawn error fails the launcher',async ()=> {
    const f=await fixture();
    try {
        const missing=join(f.root,'missing-node');
        const preload='data:text/javascript,'+encodeURIComponent(`process.execPath=${JSON.stringify(missing)};`);
        const result=await run(f,{nodeArgs:['--import',preload]}).finished;
        assert.equal(result.code,1);assert.equal(result.signal,null);
        assert.equal(result.stdout,'');assert.match(result.stderr,/ENOENT/);
    } finally {await f.cleanup();}
});

test('percentage heap options fail before worker execution instead of overriding the fixed budget',async ()=> {
    const f=await fixture();
    try {
        for (const nodeOptions of ['--max-old-space-size-percentage=50','"--max-old-space-size-percentage=50"','--no-warnings --max_old_space_size_percentage=50']) {
            const result=await run(f,{env:{NODE_OPTIONS:nodeOptions}}).finished;
            assert.equal(result.code,1);assert.equal(result.stdout,'');
            assert.match(result.stderr,/remove the percentage heap option/);
        }
    } finally {await f.cleanup();}
});

for (const signal of ['SIGINT','SIGTERM']) {
    test(`worker ${signal} remains a signaled build failure`,{skip:process.platform === 'win32'},async ()=> {
        const f=await fixture(`process.kill(process.pid,${JSON.stringify(signal)});`);
        try {
            const result=await run(f).finished;
            assert.equal(result.code,null);assert.equal(result.signal,signal);
        } finally {await f.cleanup();}
    });
    test(`launcher ${signal} stops its worker before exiting`,{skip:process.platform === 'win32'},async ()=> {
        const f=await fixture("process.stdout.write(JSON.stringify({pid:process.pid})+'\\n');setInterval(()=>{},1000);");
        let pid;
        try {
            const {child,finished}=run(f);
            pid=await new Promise((accept,reject)=> {
                let text='';
                child.stdout.on('data',chunk=> {
                    text+=chunk;
                    if (text.includes('\n')) accept(JSON.parse(text).pid);
                });
                child.once('error',reject);
                child.once('close',()=>reject(new Error('Worker exited before readiness')));
            });
            child.kill(signal);
            const result=await finished;
            assert.equal(result.code,null);assert.equal(result.signal,signal);
            assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
            pid=undefined;
        } finally {
            if (pid) stopWorker(pid);
            await f.cleanup();
        }
    });
}
