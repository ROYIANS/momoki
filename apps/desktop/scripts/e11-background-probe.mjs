// A narrow debug-only native feasibility probe; no installer or whole-app build.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,open,copyFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
const base=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const root=await mkdtemp(resolve(tmpdir(),'e11-native-background-'));
const activationOnly=process.argv.includes('--activation-only');
if(process.argv.slice(2).some(arg=>arg!=='--activation-only'))throw new Error('Unknown finite probe mode');
const scale=activationOnly?0.03:1;
const milliseconds=value=>Math.round(value*scale);
const events=[],streams=[];
let report, failure, hiddenAt, readyAt, app, reopening=false;
const timers=new Set();
const record=(kind,detail={})=>{ const event={at:Date.now(),kind,...detail};events.push(event);console.log(JSON.stringify(event)); };
const later=(ms,fn)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timers.add(timer);};
const chunk=(delta,finish_reason=null)=>`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason}]})}\n\n`;
const finish=stream=>{stream.write(chunk({},'stop'));stream.end('data: [DONE]\n\n');};
const server=createServer(async(req,res)=>{
    const bytes=[];for await(const chunk of req)bytes.push(chunk);let body;try{body=JSON.parse(Buffer.concat(bytes).toString()||'{}');}catch{res.writeHead(400);res.end();return;}
    if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'e11-model',object:'model'}]}));return;}
    if(req.url==='/v1/chat/completions'){
        const text=JSON.stringify(body.messages),which=text.includes('E11-A')?'A':'B',afterTool=body.messages.some(message=>message.role==='tool');
        record('model-request',{which,afterTool,offered:body.tools?.map(tool=>tool.function?.name)});
        res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});res.write(chunk({content:`${which} original initial output. `}));
        req.on('close',()=>record('request-input-closed',{which}));res.on('close',()=>record('response-closed',{which,afterTool,writableEnded:res.writableEnded}));
        streams.push(res);
        if(afterTool){res.write(chunk({content:'Actual tool result received while hidden. '})); later(Math.max(100,readyAt+milliseconds(390_000)-Date.now()),()=>finish(res));return;}
        for(const [ms,label]of [[50_000,'checkpoint-1'],[120_000,'checkpoint-2'],[270_000,'checkpoint-3'],[335_000,'checkpoint-4']])later(milliseconds(ms),()=>{if(!res.writableEnded){res.write(chunk({content:`${which} ${label}. `}));record('public-output',{which,label});}});
        if(which==='B')later(milliseconds(190_000),()=>{res.write(chunk({tool_calls:[{index:0,id:'native-original-tool',type:'function',function:{name:'workspace_overview',arguments:'{}'}}]}));res.write(chunk({},'tool_calls'));res.end('data: [DONE]\n\n');record('tool-boundary',{which});});
        else later(milliseconds(385_000),()=>finish(res));
        return;
    }
    if(req.url==='/ready'){readyAt=Date.now();record('ready',body);}
    else if(req.url==='/hidden'){hiddenAt=Date.now();record('hidden',body);if(body.visible!==false)failure={error:'Actual close did not hide native main'};}
    else if(req.url==='/report'){report=body;await writeFile(resolve(root,'report.json'),JSON.stringify(body,null,2));record('report',{runs:body.runs?.map(run=>({id:run.id,status:run.status})),calls:body.calls?.map(call=>({name:call.name,status:call.status}))});}
    else if(req.url==='/failure'){failure=body;record('failure',body);}
    else {res.writeHead(404);res.end();return;}
    res.setHeader('content-type','application/json');res.end('{}');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const endpoint=`http://127.0.0.1:${server.address().port}`;
const frontend=resolve(root,'frontend');await mkdir(frontend);
await build({configFile:false,root:resolve(base,'ui/e11-background'),publicDir:false,define:{__E11_ENDPOINT__:JSON.stringify(endpoint),__APP_VERSION__:JSON.stringify('0.1.3')},build:{outDir:frontend,emptyOutDir:true,rollupOptions:{output:{manualChunks:undefined}}}});
const identifier=`dev.momoki.review.e11-${Date.now()}`;
const config={identifier,build:{frontendDist:frontend},app:{security:{capabilities:['main',{identifier:'e11-window-fixture',windows:['main'],permissions:['core:window:allow-close']}]}}};
const env={...process.env,TAURI_CONFIG:JSON.stringify(config),PATH:`/Users/xiaomengdao/.nvm/versions/node/v24.11.0/bin:${process.env.PATH}`};
const emittedBinary=resolve(base,'.tools/target/debug/momoki');
const binary=resolve(root,'momoki');
async function child(command,args,name){const log=await open(resolve(root,name),'wx');try{const process=spawn(command,args,{cwd:base,env,stdio:['ignore',log.fd,log.fd]});const deadline=setTimeout(()=>process.kill('SIGKILL'),name==='native-build.log'?180_000:5_000);try{await new Promise((resolve,reject)=>{process.once('error',reject);process.once('close',(code,signal)=>code===0?resolve():reject(new Error(`${name}: ${code}/${signal}`)));});}finally{clearTimeout(deadline);}}finally{await log.close();}}
console.log(`Native probe artifacts: ${root}`);
await child('/Users/xiaomengdao/.nvm/versions/node/v24.11.0/bin/node',['scripts/tools.mjs','cargo','build','--manifest-path','src-tauri/Cargo.toml','--locked','--features','product-sqlite','--bin','momoki'],'native-build.log');
// A private copy prevents a later scoped native compile from replacing this host.
await copyFile(emittedBinary,binary);await chmod(binary,0o700);
const log=await open(resolve(root,'native-host.log'),'wx');app=spawn(binary,[],{cwd:base,env,stdio:['ignore',log.fd,log.fd]});await log.close();
record('native-launch',{pid:app.pid,identifier,binary});
const deadline=Date.now()+(activationOnly?40_000:510_000);
let passed=false,probeError;
try {
    while(Date.now()<deadline&&!report&&!failure){
        if(app.exitCode!==null)throw new Error(`Actual WK host exited early ${app.exitCode}`);
        if(hiddenAt&&!reopening&&Date.now()-hiddenAt>milliseconds(370_000)){reopening=true;await child(binary,[],'second-launch.log');record('activation-completed',{hiddenMs:Date.now()-hiddenAt});}
        await new Promise(resolve=>setTimeout(resolve,500));
    }
    if(failure)throw new Error(failure.error);
    if(!report)throw new Error('Native probe bounded deadline expired');
    const requests=events.filter(event=>event.kind==='model-request'),a=requests.filter(event=>event.which==='A'),b=requests.filter(event=>event.which==='B');
    const smart=report.runs.find(run=>run.threadId===report.b);
    // Smart mode intentionally performs its one bounded terminal finishing
    // check after the actual tool-result step. It is a distinct original step.
    passed=hiddenAt&&reopening&&events.some(event=>event.kind==='activation-completed'&&event.hiddenMs>milliseconds(360_000))&&a.length===1&&b.length===3&&b[1].afterTool===true&&b[1].at<events.find(event=>event.kind==='activation-completed')?.at&&smart?.finishingCheck?.step===2&&smart?.finishingCheck?.reason==='terminal_reply'&&report.runs.length===2&&report.runs.every(run=>run.status==='completed')&&report.calls.length===1&&report.calls[0].name==='workspace_overview'&&report.calls[0].status==='completed'&&JSON.stringify(report.initialSession)===JSON.stringify(report.finalSession)&&report.state.visible===true;
    await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2));
    await writeFile(resolve(root,'receipt.json'),JSON.stringify({version:1,passed,scope:activationOnly?'actual macOS debug single-instance activation with original session; not long-hidden/installed/release/Windows acceptance':'actual macOS debug WKWebView hidden progress; not installed/release/Windows acceptance',identifier,pid:app.pid,events},null,2));
    if(!passed)throw new Error('Native hidden-progress/original-count/session oracle failed');
    console.log(`PASS actual hidden-WKWebView fixture; artifacts ${root}`);
} catch(error) {probeError=error instanceof Error?error.message:String(error);throw error;} finally {
    await writeFile(resolve(root,'outcome.json'),JSON.stringify({version:1,passed,activationOnly,error:probeError??failure?.error??null,identifier,pid:app.pid,events},null,2));
    for(const timer of timers)clearTimeout(timer);for(const stream of streams)stream.destroy();
    await writeFile(resolve(root,'events.json'),JSON.stringify(events,null,2));
    // Only this runner's isolated child; final installed Quit remains separate.
    if(app.exitCode===null)app.kill('SIGTERM');server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
