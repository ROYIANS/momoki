import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const marker='\nMOMOKI_LOGGED_RESULT:';
const driver=`
import {readFileSync} from 'node:fs';
import {runLoggedProcess} from ${JSON.stringify(new URL('./logged-process.mjs',import.meta.url).href)};
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
try {
    const result=await runLoggedProcess(config.command,config.args,{cwd:config.cwd,env:{...process.env,...config.env},logPath:config.logPath});
    process.stderr.write(${JSON.stringify(marker)}+JSON.stringify(result));
    process.exitCode=result.code !== 0 || result.signal ? 1 : 0;
} catch (error) {
    process.stderr.write(${JSON.stringify(marker)}+JSON.stringify({error:{name:error.name,message:error.message,code:error.code}}));
    process.exitCode=1;
}
`;
async function fixture(source,options={}) {
    const directory=await mkdtemp(join(tmpdir(),'momoki logged process 测试 '));
    const childPath=join(directory,'actual child.mjs'),driverPath=join(directory,'driver.mjs'),configPath=join(directory,'config.json');
    const config={command:process.execPath,args:[childPath],cwd:directory,env:{},logPath:join(directory,'check.log'),...options};
    await writeFile(childPath,source);await writeFile(driverPath,driver);await writeFile(configPath,JSON.stringify(config));
    return {
        directory,logPath:config.logPath,
        async run({closeStdout=false,limitFileSize=false}={}) {
            // POSIX resource limits exercise a real post-open EFBIG without
            // altering the runner or substituting filesystem/process APIs.
            const limit='import os, resource, signal, sys; resource.setrlimit(resource.RLIMIT_FSIZE, (65536, 65536)); signal.signal(signal.SIGXFSZ, signal.SIG_IGN); os.execv(sys.argv[1], sys.argv[1:])';
            const command=limitFileSize ? '/usr/bin/python3' : process.execPath;
            const args=limitFileSize ? ['-c',limit,process.execPath,driverPath,configPath] : [driverPath,configPath];
            const child=spawn(command,args,{stdio:['ignore','pipe','pipe'],shell:false});
            const stdout=[],stderr=[];
            child.stdout.on('data',chunk=>stdout.push(chunk));child.stderr.on('data',chunk=>stderr.push(chunk));
            if (closeStdout) child.stdout.destroy();
            const exit=await new Promise((accept,reject)=> {
                child.once('error',reject);child.once('close',(code,signal)=>accept({code,signal}));
            });
            const errorOutput=Buffer.concat(stderr).toString('utf8'),boundary=errorOutput.lastIndexOf(marker);
            assert.notEqual(boundary,-1,`Driver must report its actual outcome: ${errorOutput}`);
            return {...exit,stdout:Buffer.concat(stdout),stderr:Buffer.from(errorOutput.slice(0,boundary)),outcome:JSON.parse(errorOutput.slice(boundary+marker.length))};
        },
        async cleanup() {await rm(directory,{recursive:true,force:true});},
    };
}

test('forwards both live streams and retains all multi-MiB bytes through EOF',{timeout:10000},async ()=> {
    const stdout=Buffer.concat([Buffer.alloc(2*1024*1024,0x61),Buffer.from('\nstdout 尾部 🌹\n')]);
    const stderr=Buffer.concat([Buffer.alloc(2*1024*1024,0x62),Buffer.from('\nstderr 尾部 🌹\n')]);
    const f=await fixture(`process.stdout.write(Buffer.concat([Buffer.alloc(${2*1024*1024},0x61),Buffer.from('\\nstdout 尾部 🌹\\n')]));process.stderr.write(Buffer.concat([Buffer.alloc(${2*1024*1024},0x62),Buffer.from('\\nstderr 尾部 🌹\\n')]));`);
    try {
        const result=await f.run(),log=await readFile(f.logPath);
        assert.equal(result.code,0);assert.deepEqual(result.outcome,{code:0,signal:null});
        assert.deepEqual(result.stdout,stdout);assert.deepEqual(result.stderr,stderr);
        assert.equal(log.length,stdout.length+stderr.length);
        const frequencies=bytes=> {
            const counts=Array(256).fill(0);for (const byte of bytes) counts[byte]++;return counts;
        };
        // Cross-stream ordering is unspecified; each stream's full bytes must
        // survive, including the UTF-8 tails beyond several pipe buffers.
        assert.deepEqual(frequencies(log),frequencies(Buffer.concat([stdout,stderr])));
        assert.ok(log.includes(Buffer.from('\nstdout 尾部 🌹\n')));assert.ok(log.includes(Buffer.from('\nstderr 尾部 🌹\n')));
    } finally {await f.cleanup();}
});
test('preserves cwd, environment and literal argument boundaries without a shell',{timeout:10000},async ()=> {
    const args=['with spaces','中文','$(false)','; exit 0','literal `code`'];
    const f=await fixture(`process.stdout.write(JSON.stringify({cwd:process.cwd(),value:process.env.MOMOKI_LOG_FIXTURE,args:process.argv.slice(2)}));`,{env:{MOMOKI_LOG_FIXTURE:'exact fixture value'}});
    try {
        const configPath=join(f.directory,'config.json'),config=JSON.parse(await readFile(configPath,'utf8'));
        config.args.push(...args);await writeFile(configPath,JSON.stringify(config));
        const result=await f.run();assert.equal(result.code,0);
        assert.deepEqual(JSON.parse(result.stdout.toString()),{cwd:await realpath(f.directory),value:'exact fixture value',args});
        assert.deepEqual(await readFile(f.logPath),result.stdout);
    } finally {await f.cleanup();}
});
test('retains a nonzero exit and panic text in both live output and evidence',{timeout:10000},async ()=> {
    const f=await fixture(`process.stdout.write('before failure\\n');process.stderr.write('actual panic detail\\n');process.exitCode=23;`);
    try {
        const result=await f.run(),log=await readFile(f.logPath,'utf8');
        assert.equal(result.code,1);assert.deepEqual(result.outcome,{code:23,signal:null});
        assert.equal(result.stdout.toString(),'before failure\n');assert.equal(result.stderr.toString(),'actual panic detail\n');
        assert.ok(log.includes('before failure\n'));assert.ok(log.includes('actual panic detail\n'));
    } finally {await f.cleanup();}
});
test('spawn failure rejects after child close and leaves a closed evidence log',{timeout:10000},async ()=> {
    const f=await fixture('',{command:join(tmpdir(),'momoki-executable-does-not-exist')});
    try {
        const result=await f.run();assert.equal(result.code,1);assert.equal(result.outcome.error.code,'ENOENT');
        assert.equal((await readFile(f.logPath)).length,0);
        // Windows rejects this deletion if the runner leaked an open handle.
        await rm(f.logPath);
    } finally {await f.cleanup();}
});
test('signal termination remains a failed check with retained prior output',{timeout:10000},async ()=> {
    const f=await fixture(`process.stderr.write('before signal\\n',()=>process.kill(process.pid,'SIGTERM'));`);
    try {
        const result=await f.run();assert.equal(result.code,1);assert.equal(result.stderr.toString(),'before signal\n');
        if (process.platform === 'win32') assert.ok(result.outcome.code !== 0 || result.outcome.signal);
        else assert.deepEqual(result.outcome,{code:null,signal:'SIGTERM'});
        assert.equal(await readFile(f.logPath,'utf8'),'before signal\n');
    } finally {await f.cleanup();}
});
test('an existing log fails before spawning and cannot be overwritten',{timeout:10000},async ()=> {
    const f=await fixture(`import {writeFileSync} from 'node:fs';writeFileSync('unexpected-spawn','spawned');`);
    try {
        await writeFile(f.logPath,'original evidence');
        const result=await f.run();assert.equal(result.code,1);assert.equal(result.outcome.error.code,'EEXIST');
        assert.equal(await readFile(f.logPath,'utf8'),'original evidence');
        await assert.rejects(readFile(join(f.directory,'unexpected-spawn')),{code:'ENOENT'});
    } finally {await f.cleanup();}
});
test('a missing log directory fails before spawning',{timeout:10000},async ()=> {
    const f=await fixture('',{logPath:join(tmpdir(),'momoki-log-directory-does-not-exist','check.log')});
    try {const result=await f.run();assert.equal(result.code,1);assert.equal(result.outcome.error.code,'ENOENT');}
    finally {await f.cleanup();}
});
test('a broken live stdout fails rather than claiming successful capture',{timeout:10000},async ()=> {
    const f=await fixture(`process.stdout.write(Buffer.alloc(1024*1024,0x63));`);
    try {
        const result=await f.run({closeStdout:true});assert.equal(result.code,1);
        assert.ok(result.outcome.error);assert.notEqual(result.outcome.error.code,undefined);
        await readFile(f.logPath);await rm(f.logPath);
    } finally {await f.cleanup();}
});
test('a real post-open evidence write failure rejects and closes the partial log',{timeout:10000,skip:process.platform === 'win32'},async ()=> {
    const f=await fixture(`process.stdout.write(Buffer.alloc(4*1024*1024,0x64));`);
    try {
        const result=await f.run({limitFileSize:true});assert.equal(result.code,1);assert.equal(result.outcome.error.code,'EFBIG');
        const log=await readFile(f.logPath);assert.ok(log.length > 0);assert.ok(log.length <= 65536);
        assert.ok(log.every(byte=>byte === 0x64));await rm(f.logPath);
    } finally {await f.cleanup();}
});
test('release cancellation retains the finite diagnostics without relaxing publication gates',async ()=> {
    const workflow=await readFile(resolve(import.meta.dirname,'../../../.github/workflows/desktop-release.yml'),'utf8');
    assert.match(workflow,/- name: Preserve finite failure diagnostics\n\s+if: failure\(\) \|\| cancelled\(\)\n\s+uses: actions\/upload-artifact@[a-f0-9]{40}/);
    assert.equal([...workflow.matchAll(/contents: write/g)].length,1);
    assert.match(workflow,/if: github.event_name == 'push' && startsWith\(github.ref, 'refs\/tags\/desktop-v'\)/);
    assert.match(workflow,/collect:\n\s+needs: build/);
});
