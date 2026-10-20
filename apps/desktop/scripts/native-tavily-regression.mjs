import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,open,realpath,stat,cp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,relative,basename} from 'node:path';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const base=fileURLToPath(new URL('../',import.meta.url));
const endpoint='http://127.0.0.1:56368/v1';
const prefix='原生 Tavily 合成探针：';
const expected=['实际身份与固定范围','真实原生 GET usage','真实原生 POST search','真实原生 POST extract','过期配置零请求','仅清理本次合成配置','独立探针完成'].map(name=>`${prefix}${name}`);

function inspectReport(report,identifier) {
    if(report.version!==1||!Array.isArray(report.events)||report.finishedAt!==null)throw new Error('Expected unfinished independent Tavily report');
    const events=report.events.filter(event=>event?.name?.startsWith(prefix));
    if(events.some(event=>event.ok!==true))throw new Error('Actual Tavily probe recorded a failure');
    const final=events.findLast(event=>event.name===expected.at(-1));
    if(!final)return false;
    if(events.length!==expected.length||events.some((event,index)=>event.name!==expected[index]))throw new Error('Tavily check sequence incomplete');
    const identity=events[0].detail;
    if(identity?.profileId!==identifier||identity.databaseName!==`momoki-desktop:${identifier}:v1`||identity.fixtureOrigin!==new URL(endpoint).origin||identity.paidRequests!==0)throw new Error('Tavily isolation receipt mismatch');
    if(events[1].detail?.requests!==1||events[1].detail.method!=='GET'||events[1].detail.path!=='/usage'||
        events[2].detail?.requests!==1||events[2].detail.method!=='POST'||events[2].detail.path!=='/search'||
        events[3].detail?.requests!==1||events[3].detail.method!=='POST'||events[3].detail.path!=='/extract'||
        events[4].detail?.requests!==0||events[5].detail?.configurationRemoved!==true||events[5].detail.requests!==3)throw new Error('Tavily bounded requests/cleanup receipt mismatch');
    if(final.detail?.passed!==true||final.detail.requests!==3||final.detail.paidRequests!==0||final.detail.liveTavilyAccountVerified!==false||
        final.detail.wholeProductAcceptanceComplete!==false||final.detail.wholeHistoricalAcceptanceComplete!==false)throw new Error('Tavily fixture cannot claim live/whole acceptance');
    return true;
}

function checkOracle() {
    const identifier='dev.momoki.review.tavily.oracle';
    const details=[{profileId:identifier,databaseName:`momoki-desktop:${identifier}:v1`,fixtureOrigin:new URL(endpoint).origin,paidRequests:0},
        {requests:1,method:'GET',path:'/usage'},{requests:1,method:'POST',path:'/search'},{requests:1,method:'POST',path:'/extract'},
        {requests:0},{configurationRemoved:true,requests:3},{passed:true,requests:3,paidRequests:0,liveTavilyAccountVerified:false,wholeProductAcceptanceComplete:false,wholeHistoricalAcceptanceComplete:false}];
    const good={version:1,finishedAt:null,events:expected.map((name,index)=>({name,ok:true,detail:details[index]}))};
    const requireReject=report=>{let rejected=false;try{inspectReport(report,identifier);}catch{rejected=true;}if(!rejected)throw new Error('Offline oracle rejection failed');};
    if(!inspectReport(good,identifier)||inspectReport({...good,events:good.events.slice(0,-1)},identifier))throw new Error('Offline completion oracle failed');
    requireReject({...good,finishedAt:'not unfinished'});
    requireReject({...good,events:good.events.map((event,index)=>index===1?{...event,ok:false}:event)});
    requireReject({...good,events:good.events.map((event,index)=>index===6?{...event,detail:{...event.detail,liveTavilyAccountVerified:true}}:event)});
    requireReject({...good,events:good.events.map((event,index)=>index===6?{...event,detail:{...event.detail,wholeProductAcceptanceComplete:true}}:event)});
    requireReject({...good,events:good.events.map((event,index)=>index===0?{...event,detail:{...event.detail,profileId:'normal'}}:event)});
    requireReject({...good,events:good.events.map((event,index)=>index===4?{...event,detail:{requests:1}}:event)});
    console.log('Offline Tavily receipt oracle: 8 cases passed; no native HTTP execution claimed.');
}

async function run() {
    const supplied=process.argv.indexOf('--root');
    const requested=supplied<0?resolve(base,'.acceptance',`run-${randomUUID()}`):resolve(process.argv[supplied+1]??'');
    const container=resolve(base,'.acceptance');const inside=relative(container,requested);
    if(!basename(requested).startsWith('run-')||!inside||inside.startsWith('..'))throw new Error('Expected fresh isolated .acceptance/run-* root');
    await mkdir(requested,{recursive:true});const root=await realpath(requested);
    if(!root.startsWith(`${await realpath(container)}/run-`))throw new Error('Run root escaped evidence container');
    try{await stat(resolve(root,'report.json'));throw new Error('Existing report is not a fresh run');}catch(error){if(error.code!=='ENOENT')throw error;}
    const launchBuilt=process.argv.includes('--launch-built');
    const buildOnly=process.argv.includes('--build-only');
    if(launchBuilt&&buildOnly)throw new Error('Choose build-only or launch-built');
    let identifier=`dev.momoki.review.tavily.${randomUUID()}`;
    const appName='Momoki Tavily Review';
    const frontend=resolve(root,'frontend');
    const configPath=resolve(root,'tavily-config.json');
    const sourcePaths=['ui/tavilyProbeFetch.ts','ui/tavilyProbe.ts','ui/tavilyProbeMain.tsx','ui/tavily-probe/index.html','ui/acceptanceEvidence.ts','scripts/native-tavily-regression.mjs','../../packages/studio/src/features/references/providers/tavily.ts','../../packages/studio/src/platform/runtime/runtimeFetch.ts','../../packages/studio/src/platform/product/httpPolicy.ts','../../packages/studio/src/platform/http/requestBoundary.ts','../../tooling/native-product-fixture.mjs'];
    const sources=async()=>Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,createHash('sha256').update(await readFile(resolve(base,path))).digest('hex')])));
    const before=await sources();const env={...process.env,MOMOKI_ACCEPTANCE_ROOT:root};
    const deadline=Date.now()+15*60*1000;
    let child,app,bundle,outcome='incomplete',interrupted=false;
    const results=[];
    const stop=()=>{interrupted=true;if(child?.exitCode===null)child.kill('SIGTERM');if(app?.exitCode===null)app.kill('SIGTERM');};
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
    const timer=setTimeout(stop,15*60*1000);
    try {
        if(!launchBuilt) {
        await build({configFile:false,root:resolve(base,'ui/tavily-probe'),plugins:[react(),tailwind()],
            define:{__ACCEPTANCE__:'true',__STREAM_ENDPOINT__:JSON.stringify(endpoint),__STREAM_TOKEN__:JSON.stringify('synthetic-tavily-probe-only')},
            build:{outDir:frontend,emptyOutDir:true,assetsInlineLimit:0},worker:{format:'es'}});
        const config={productName:appName,identifier,mainBinaryName:'momoki',build:{frontendDist:frontend},
            app:{windows:[{label:'main',create:false,title:'Tavily 原生合成接口验收',width:1120,height:780,minWidth:760,minHeight:520}],
                security:{capabilities:['main',{identifier:'acceptance',windows:['main'],permissions:['allow-acceptance-request']}],
                    csp:"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; font-src 'self' data:; connect-src ipc: http://ipc.localhost 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'"}}};
        await writeFile(configPath,JSON.stringify(config));
        const log=await open(resolve(root,'tavily-build.log'),'wx');
        let built;
        try{built=await new Promise((accept,reject)=>{
            child=spawn(process.execPath,[resolve(base,'scripts/tools.mjs'),'pnpm','exec','tauri','build','--bundles','app','--features','acceptance','--config',configPath],{cwd:base,env,stdio:['ignore',log.fd,log.fd]});
            child.once('error',reject);child.once('exit',(code,signal)=>accept({code,signal}));
        });}finally{await log.close();}
        results.push({type:'build',...built});
        if(built.code!==0||interrupted)throw new Error('Tavily probe native build failed/interrupted; raw log retained');
        const archived=resolve(root,`${appName}.app`);
        await cp(resolve(base,'.tools/target/release/bundle/macos',`${appName}.app`),archived,{recursive:true,errorOnExist:true,force:false});
        const binary=resolve(archived,'Contents/MacOS/momoki');
        bundle={app:archived,identifier,storage:'sqlite',webkitStoreId:createHash('sha256').update(`momoki-product-profile-v1:${identifier}:sqlite`).digest('hex').slice(0,32),binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex')};
        await writeFile(resolve(root,'native-tavily-bundle.json'),JSON.stringify(bundle,null,2)+'\n');
        if(buildOnly){outcome='built';console.log(`Built only; no app launched: ${archived}\nRun root: ${root}`);return;}
        } else {
            bundle=JSON.parse(await readFile(resolve(root,'native-tavily-bundle.json'),'utf8'));
            const buildReceipt=JSON.parse(await readFile(resolve(root,'native-tavily-build-receipt.json'),'utf8'));
            identifier=bundle.identifier;
            if(buildReceipt.outcome!=='built'||!buildReceipt.stable||JSON.stringify(before)!==JSON.stringify(buildReceipt.after)||
                !/^dev\.momoki\.review\.tavily\.[a-f0-9-]{36}$/.test(identifier)||bundle.app!==resolve(root,`${appName}.app`))throw new Error('Built probe/source identity changed before launch');
        }
        const binary=resolve(bundle.app,'Contents/MacOS/momoki');
        if(createHash('sha256').update(await readFile(binary)).digest('hex')!==bundle.binarySha256)throw new Error('Built probe binary changed');
        const appLog=await open(resolve(root,'tavily-app.log'),'wx');
        try{app=spawn(binary,[],{env,stdio:['ignore',appLog.fd,appLog.fd]});}finally{await appLog.close();}
        let launchError;app.once('error',error=>{launchError=error;});
        await writeFile(resolve(base,'.acceptance/native-tavily-active-run.json'),JSON.stringify({version:1,root,pid:app.pid,bundle,deadline,fixtureOwnership:'root already running fixture at 56368; probe never starts/stops it',expectedChecks:expected},null,2)+'\n');
        console.log(`Actual dedicated app: ${bundle.app}\nReport: ${root}/report.json\nClick “验证 Tavily 原生合成接口” only. No automated IPC/UI action is issued.`);
        const pause=ms=>new Promise(accept=>setTimeout(accept,ms));
        while(Date.now()<deadline&&!interrupted) {
            if(launchError)throw launchError;
            if(app.exitCode!==null)throw new Error('Tavily app exited before actual report');
            try{const report=JSON.parse(await readFile(resolve(root,'report.json'),'utf8'));if(inspectReport(report,identifier)){outcome='passed';results.push({type:'actual-native-tavily-fixture',checks:7,requests:3,paidRequests:0});break;}}
            catch(error){if(error.code!=='ENOENT')throw error;}
            await pause(500);
        }
        if(outcome!=='passed')throw new Error('Tavily deadline/interruption without a passing visible report');
        console.log('Actual native Tavily synthetic protocol passed; live account and whole acceptance remain unverified.');
        const observationUntil=Math.min(deadline,Date.now()+30000);
        while(Date.now()<observationUntil&&!interrupted&&app.exitCode===null)await pause(500);
    } finally {
        clearTimeout(timer);process.off('SIGINT',stop);process.off('SIGTERM',stop);
        if(app?.exitCode===null)app.kill('SIGTERM');if(child?.exitCode===null)child.kill('SIGTERM');
        const after=await sources();
        await writeFile(resolve(root,buildOnly?'native-tavily-build-receipt.json':'native-tavily-runner-receipt.json'),JSON.stringify({version:1,outcome,scope:'independent test-only Tavily protocol over actual native HTTP',before,after,stable:JSON.stringify(before)===JSON.stringify(after),bundle:bundle??null,results,liveTavilyAccountVerified:false,wholeProductAcceptanceComplete:false,wholeHistoricalAcceptanceComplete:false},null,2)+'\n');
    }
}

if(process.argv.includes('--check'))checkOracle();else await run();
