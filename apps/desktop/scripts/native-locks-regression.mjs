import {spawn} from 'node:child_process';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,open,realpath,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,basename,relative} from 'node:path';
import {reserveStreamServer} from './sse-server.mjs';

const base=fileURLToPath(new URL('../',import.meta.url));
const prefix='原生 Web Locks：';
const expected=[
    '真实安全上下文与默认管理器',
    '默认 Agent 同名排他与异名独立',
    '正常释放后重新取得默认 Agent 锁',
    '异常保留原错误且释放默认 Agent 锁',
    '真实 API 排队 AbortSignal 取消与释放',
    '真实音频批次前缀同名排他与释放',
    '探针所有 owner 清理',
    '独立探针完成',
].map(name=>`${prefix}${name}`);

function inspectReport(report) {
    if(report.version!==1||!Array.isArray(report.events)||report.finishedAt!==null)throw new Error('Expected unfinished, independent historical-acceptance report');
    const events=report.events.filter(event=>typeof event?.name==='string'&&event.name.startsWith(prefix));
    const complete=events.findLast(event=>event.name===expected.at(-1));
    if(!complete)return false;
    const current=events.slice(events.lastIndexOf(complete)-7,events.lastIndexOf(complete)+1);
    if(current.length!==expected.length||current.some((event,index)=>event.name!==expected[index]||event.ok!==true))throw new Error('Actual lock probe failed or its check sequence is incomplete');
    if(complete.detail?.passed!==true||complete.detail?.wholeProductAcceptanceComplete!==false||complete.detail?.wholeHistoricalAcceptanceComplete!==false)throw new Error('Lock-only receipt cannot claim whole acceptance');
    return true;
}

function checkReportOracle() {
    const good={version:1,finishedAt:null,events:expected.map(name=>({name,ok:true,detail:name===expected.at(-1)?{passed:true,wholeProductAcceptanceComplete:false,wholeHistoricalAcceptanceComplete:false}:{}}))};
    const requireReject=value=>{let rejected=false;try{inspectReport(value);}catch{rejected=true;}if(!rejected)throw new Error('Offline receipt rejection case unexpectedly passed');};
    if(!inspectReport(good)||inspectReport({...good,events:good.events.slice(0,-1)}))throw new Error('Offline receipt completion cases failed');
    requireReject({...good,finishedAt:new Date().toISOString()});
    requireReject({...good,events:good.events.filter((_,index)=>index!==2)});
    requireReject({...good,events:good.events.map((event,index)=>index===1?{...event,ok:false}:event)});
    requireReject({...good,events:good.events.map((event,index)=>index===7?{...event,detail:{...event.detail,wholeProductAcceptanceComplete:true}}:event)});
    console.log('Offline lock-report oracle: 6 cases passed; no native lock execution claimed.');
}

async function run() {
    const supplied=process.argv.indexOf('--root');
    const requested=supplied<0?resolve(base,'.acceptance',`run-${randomUUID()}`):resolve(process.argv[supplied+1]??'');
    if(!basename(requested).startsWith('run-')||!relative(resolve(base,'.acceptance'),requested)||relative(resolve(base,'.acceptance'),requested).startsWith('..'))throw new Error('Expected a dedicated .acceptance/run-* evidence directory');
    await mkdir(requested,{recursive:true});
    const root=await realpath(requested);
    if(!root.startsWith(`${await realpath(resolve(base,'.acceptance'))}/run-`)||!(await stat(root)).isDirectory())throw new Error('Run root escapes isolated acceptance evidence');
    try{await stat(resolve(root,'report.json'));throw new Error('Existing report root is not a fresh lock-probe run');}catch(error){if(error.code!=='ENOENT')throw error;}
    const token=randomBytes(32).toString('hex');
    const server=await reserveStreamServer(root,token);
    const env={...process.env,MOMOKI_STREAM_ENDPOINT:server.endpoint,MOMOKI_STREAM_TOKEN:token,MOMOKI_ACCEPTANCE_ROOT:root};
    const sourcePaths=['ui/acceptanceLocks.ts','ui/acceptance.tsx','ui/acceptanceEvidence.ts','scripts/native-locks-regression.mjs','../../packages/studio/src/features/agent/runtime/runOwnership.ts','../../packages/studio/src/features/audio/generation/batchRuntime.ts','../../packages/studio/src/features/agent/runtime/taskWrapup.ts'];
    const sources=async()=>Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,createHash('sha256').update(await readFile(resolve(base,path))).digest('hex')])));
    const before=await sources();
    const deadline=Date.now()+15*60*1000;
    const results=[];let app,buildChild,outcome='incomplete',interrupted=false,bundle;
    const onSignal=()=>{interrupted=true;if(buildChild?.exitCode===null)buildChild.kill('SIGTERM');if(app?.exitCode===null)app.kill('SIGTERM');};
    process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);
    const deadlineTimer=setTimeout(onSignal,Math.max(1,deadline-Date.now()));
    const pause=ms=>new Promise(accept=>setTimeout(accept,ms));
    try {
        const buildLog=await open(resolve(root,'locks-build.log'),'wx');
        let built;
        try {built=await new Promise((accept,reject)=>{
            buildChild=spawn(process.execPath,[resolve(base,'scripts/build-app.mjs'),'--acceptance'],{cwd:base,env,stdio:['ignore',buildLog.fd,buildLog.fd]});
            buildChild.once('error',reject);buildChild.once('exit',(code,signal)=>accept({code,signal}));
        });}finally{await buildLog.close();}
        results.push({type:'build',...built});
        if(built.code!==0||interrupted)throw new Error(`Lock-probe acceptance build failed/interrupted; raw log ${root}/locks-build.log`);
        bundle=JSON.parse(await readFile(resolve(base,'.acceptance/acceptance-bundle.json'),'utf8'));
        const binary=resolve(bundle.app,'Contents/MacOS/momoki');
        const binarySha256=createHash('sha256').update(await readFile(binary)).digest('hex');
        const appLog=await open(resolve(root,'locks-app.log'),'wx');
        try{app=spawn(binary,[],{env,stdio:['ignore',appLog.fd,appLog.fd]});}finally{await appLog.close();}
        let launchError;app.once('error',error=>{launchError=error;});
        await writeFile(resolve(base,'.acceptance/native-locks-active-run.json'),JSON.stringify({version:1,scope:'independent native Web Locks probe',root,app:bundle.app,pid:app.pid,startedAt:Date.now(),deadline,binarySha256,expectedChecks:expected,wholeProductAcceptanceComplete:false},null,2)+'\n');
        console.log(`Actual isolated lock-probe app: ${bundle.app}\nRun evidence: ${root}\nPID ${app.pid}; click “验证原生 Web Locks” only. The runner awaits that real partial report, with finishedAt remaining null.`);
        while(Date.now()<deadline&&!interrupted) {
            if(launchError)throw launchError;
            if(app.exitCode!==null)throw new Error(`Lock-probe application exited ${app.exitCode} before report`);
            try {
                const report=JSON.parse(await readFile(resolve(root,'report.json'),'utf8'));
                if(inspectReport(report)){outcome='passed';results.push({type:'real-packaged-locks',checks:expected.length,binarySha256,wholeProductAcceptanceComplete:false,reportFinishedAt:report.finishedAt});break;}
            }catch(error){if(error.code!=='ENOENT')throw error;}
            await pause(500);
        }
        if(outcome!=='passed')throw new Error('Finite lock-probe deadline expired or runner was interrupted without passing report');
        console.log('Actual packaged lock-only checks passed. Whole historical/product acceptance remains unfinished.');
        // Leave the completed visible result available briefly for the UI owner.
        const observationUntil=Math.min(deadline,Date.now()+30000);
        while(Date.now()<observationUntil&&!interrupted&&app.exitCode===null)await pause(500);
    } finally {
        clearTimeout(deadlineTimer);process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);
        // The runner owns only these child handles; no global process/app termination.
        if(app?.exitCode===null)app.kill('SIGTERM');
        if(buildChild?.exitCode===null)buildChild.kill('SIGTERM');
        await server.close();
        const after=await sources();
        await writeFile(resolve(root,'native-locks-runner-receipt.json'),JSON.stringify({version:1,outcome,scope:'independent native Web Locks probe',wholeProductAcceptanceComplete:false,wholeHistoricalAcceptanceComplete:false,before,after,stable:JSON.stringify(before)===JSON.stringify(after),bundle:bundle??null,results},null,2)+'\n');
    }
}

if(process.argv.includes('--check'))checkReportOracle();else await run();
