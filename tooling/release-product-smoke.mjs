#!/usr/bin/env node
// External host-only verification; never imported by or bundled with the product.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {chmod,lstat,mkdir,readFile,readdir,readlink,realpath,rm,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {getTarget,PRODUCT} from '../apps/desktop/scripts/release-policy.mjs';
import {contained,poll,sha256,smokeArguments,smokeFixture,validateReadOnlyProfile,verifyExecutable,verifyExecutableArchitecture,verifyInstaller,verifyPeIcons,WebDriver} from './release-smoke-support.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

async function run(command,args,{cwd,env=process.env,log,timeout=120000}={}) {
    const stream=log ? createWriteStream(log,{flags:'wx'}) : null;
    let output='',error='',timedOut=false,logBytes=0;
    const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    const capture=(name,chunk)=>{
        if (stream && logBytes<8*1024*1024) {
            const bounded=chunk.subarray(0,8*1024*1024-logBytes);stream.write(bounded);logBytes+=bounded.length;
        }
        if (name === 'output') output=(output+chunk.toString()).slice(-2*1024*1024);
        else error=(error+chunk.toString()).slice(-2*1024*1024);
    };
    child.stdout.on('data',chunk=>capture('output',chunk));child.stderr.on('data',chunk=>capture('error',chunk));
    const timer=setTimeout(()=>{timedOut=true;child.kill();},timeout);
    try {
        const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',code=>done(code));});
        if (timedOut || code !== 0) throw new Error(`${command} failed (${timedOut ? 'deadline' : code}): ${error.slice(-1000)}`);
        return {output,error};
    } finally {clearTimeout(timer);if (stream) await new Promise(done=>stream.end(done));}
}

function powershell(source) {
    // Executable arguments contain one encoded source value, without cmd.exe or
    // interpolation of caller paths by a shell.
    return ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')];
}
const psLiteral=value=>`'${value.replaceAll("'","''")}'`;

async function appData(identifier) {
    if (process.platform === 'win32') {
        const {output}=await run('powershell.exe',powershell("[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)"));
        return join(output.trim(),identifier);
    }
    if (process.platform === 'darwin') return join(homedir(),'Library','Application Support',identifier);
    return join(process.env.XDG_DATA_HOME || join(homedir(),'.local','share'),identifier);
}

async function matchingProcesses(executable) {
    if (process.platform === 'win32') {
        const {output}=await run('powershell.exe',powershell(`@((Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -ieq ${psLiteral(executable)} }).ProcessId) | ConvertTo-Json -Compress`));
        const value=output.trim() ? JSON.parse(output) : [];
        return Array.isArray(value) ? value : [value];
    }
    if (process.platform === 'linux') {
        const pids=[];
        for (const name of await readdir('/proc')) {
            if (!/^\d+$/.test(name)) continue;
            try {if (await readlink(`/proc/${name}/exe`) === executable) pids.push(Number(name));}
            catch (error) {if (!['ENOENT','EACCES','EPERM'].includes(error.code)) throw error;}
        }
        return pids;
    }
    const {output}=await run('/bin/ps',['-axo','pid=,comm=']);
    return output.split('\n').flatMap(line=>{
        const match=line.match(/^\s*(\d+)\s+(.*)$/);
        return match && match[2] === executable ? [Number(match[1])] : [];
    });
}

async function assertAbsent(path) {
    try {await lstat(path);throw new Error(`Refusing existing user/application state: ${path}`);}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
}

async function freePort() {
    const server=createServer();
    await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
    const port=server.address().port;
    await new Promise(done=>server.close(done));
    return port;
}

async function packagePayload(assetPath,asset,receipt,evidence) {
    const payload=join(evidence,'payload');await mkdir(payload);
    const binary=receipt.product.binary;
    if (asset.format === 'exe') {
        const installation=join(payload,'installed');
        await run(assetPath,['/S',`/D=${installation}`],{log:join(evidence,'install.log')});
        return {executable:join(installation,`${binary}.exe`),application:join(installation,`${binary}.exe`),kind:'installed-nsis'};
    }
    if (asset.format === 'deb') {
        const version=(await run('dpkg-deb',['--field',assetPath,'Version'])).output.trim();
        const architecture=(await run('dpkg-deb',['--field',assetPath,'Architecture'])).output.trim();
        if (version !== receipt.context.version || architecture !== 'amd64') throw new Error('DEB version/architecture mismatch');
        await run('dpkg-deb',['--extract',assetPath,payload],{log:join(evidence,'extract.log')});
        return {executable:join(payload,'usr','bin',binary),application:join(payload,'usr','bin',binary),kind:'extracted-deb'};
    }
    if (asset.format === 'appimage') {
        await chmod(assetPath,0o755);
        await run(assetPath,['--appimage-extract'],{cwd:payload,log:join(evidence,'extract.log')});
        return {executable:join(payload,'squashfs-root','usr','bin',binary),application:join(payload,'squashfs-root','AppRun'),kind:'extracted-appimage'};
    }
    if (asset.format === 'dmg') {
        const mount=join(payload,'mount');await mkdir(mount);
        await run('hdiutil',['attach','-readonly','-nobrowse','-noautoopen','-mountpoint',mount,assetPath],{log:join(evidence,'mount.log')});
        const bundle=join(mount,`${receipt.product.name}.app`);
        return {executable:join(bundle,'Contents','MacOS',binary),application:bundle,kind:'mounted-dmg',mount,bundle};
    }
    throw new Error('Unknown receipted installer format');
}

async function packageIdentity(payload,receipt,target,evidence) {
    const executable=await verifyExecutable(payload.executable,receipt.payload.executableSha256);
    if (process.platform === 'darwin') {
        const info=JSON.parse((await run('plutil',['-convert','json','-o','-',join(payload.bundle,'Contents','Info.plist')])).output);
        if (info.CFBundleIdentifier !== receipt.product.identifier || info.CFBundleShortVersionString !== receipt.context.version
            || info.CFBundleExecutable !== receipt.product.binary || info.CFBundleName !== receipt.product.name) throw new Error('Mounted app metadata mismatch');
        const architecture=(await run('lipo',['-archs',payload.executable])).output.trim();
        if (architecture !== (target.arch === 'arm64' ? 'arm64' : 'x86_64')) throw new Error('Mounted app architecture mismatch');
        await run('codesign',['--verify','--deep','--strict',payload.bundle],{log:join(evidence,'signature-verify.log')});
        const signature=await run('codesign',['--display','--verbose=4',payload.bundle],{log:join(evidence,'signature-detail.log')});
        if (!signature.error.includes('Signature=adhoc')) throw new Error('Expected ad-hoc test signature');
        const resources=join(payload.bundle,'Contents','Resources');
        if (!info.CFBundleIconFile) throw new Error('Bundle icon metadata missing');
        const icon=join(resources,info.CFBundleIconFile.endsWith('.icns') ? info.CFBundleIconFile : `${info.CFBundleIconFile}.icns`);
        if (sha256(await readFile(icon)) !== sha256(await readFile(join(root,'apps/desktop/src-tauri/icons/icon.icns')))) throw new Error('Bundle does not use approved icon');
        return {...executable,architecture,signature:'ad-hoc',version:info.CFBundleShortVersionString};
    }
    const bytes=await readFile(payload.executable);
    const architecture=verifyExecutableArchitecture(bytes,target.platform,target.arch);
    if (target.platform === 'win32') return {...executable,architecture,icon:verifyPeIcons(bytes,await readFile(join(root,'apps/desktop/src-tauri/icons/icon.ico')))};
    const approvedPng=await readFile(join(root,'apps/desktop/src-tauri/icons/icon.png'));
    if (approvedPng.length<24 || !approvedPng.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Approved Linux PNG icon is malformed');
    const width=approvedPng.readUInt32BE(16),height=approvedPng.readUInt32BE(20);
    if (!width || !height || width>4096 || height>4096) throw new Error('Approved Linux icon dimensions out of boundary');
    const packageRoot=dirname(dirname(dirname(payload.executable)));
    const iconPath=join(packageRoot,'usr','share','icons','hicolor',`${width}x${height}`,'apps',`${receipt.product.binary}.png`);
    const icon=await verifyExecutable(iconPath,sha256(approvedPng));
    return {...executable,architecture,icon:{...icon,width,height}};
}

async function screenshot(driver,evidence,name) {await writeFile(join(evidence,`${name}.png`),await driver.screenshot(),{flag:'wx'});}

async function profile(driver,identifier) {
    const snapshot=await driver.execute("const d=Object.getOwnPropertyDescriptor(window,'__MOMOKI_PRODUCT_PROFILE__');return {origin:location.protocol+'//'+location.host,profile:d?.value,writable:d?.writable,configurable:d?.configurable,frozen:Object.isFrozen(d?.value),startupError:document.body.innerText.includes('工作区无法打开')};");
    validateReadOnlyProfile(snapshot,identifier,process.platform);
    return snapshot;
}

async function openProjects(driver) {
    await driver.click(await driver.element('xpath',"//a[normalize-space(.)='项目']"));
    await driver.element('xpath',"//button[normalize-space(.)='新建项目']");
}
async function openLibrary(driver) {
    await driver.click(await driver.element('xpath',"//a[normalize-space(.)='素材库']"));
    await driver.element('css selector','input[aria-label="搜索素材"]');
}
async function preview(driver,marker) {
    await driver.element('xpath',`//pre[contains(.,'${marker}')]`);
}

async function currentFrontendIdentity(driver,receipt) {
    const files=await driver.execute("return [...document.querySelectorAll('script[src],link[rel=stylesheet][href]')].map(x=>new URL(x.getAttribute('src')||x.getAttribute('href'),location.href).pathname.replace(/^\\//,''));");
    if (!Array.isArray(files) || !files.length || files.some(file=>!Object.hasOwn(receipt.payload.frontendFiles,file))) throw new Error('Launched frontend entry differs from receipted normal frontend');
    const observed=[];
    for (const file of files) {
        const result=await driver.executeAsync(`
            const file=arguments[0],done=arguments[arguments.length-1];
            const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
            fetch('/'+file,{signal:controller.signal}).then(async response=>{
                if (!response.ok) throw new Error('Bundled resource read failed');
                const bytes=new Uint8Array(await response.arrayBuffer());
                if (bytes.length>8*1024*1024) throw new Error('Bundled resource boundary');
                if (crypto.subtle) {
                    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
                    return {sha256:Array.from(digest,x=>x.toString(16).padStart(2,'0')).join('')};
                }
                let raw='';for(let i=0;i<bytes.length;i+=8192) raw+=String.fromCharCode(...bytes.subarray(i,i+8192));
                return {base64:btoa(raw)};
            }).then(value=>done(value)).catch(error=>done({error:String(error)})).finally(()=>clearTimeout(timer));
        `,[file]);
        if (result?.error || (!result?.sha256 && typeof result?.base64 !== 'string')) throw new Error('Could not hash actual bundled frontend entry');
        const digest=result.sha256 || sha256(Buffer.from(result.base64,'base64'));
        if (digest !== receipt.payload.frontendFiles[file]) throw new Error(`Launched frontend bytes differ: ${file}`);
        observed.push({file,sha256:digest});
    }
    return observed;
}

async function uiSmoke(payload,receipt,evidence,state,report) {
    const driverPath=process.env.TAURI_DRIVER_PATH,nativePath=process.env.MOMOKI_NATIVE_WEBDRIVER_PATH;
    if (!driverPath || !nativePath) throw new Error('Explicit external Tauri/native driver paths required');
    const port=await freePort(),nativePort=await freePort();
    const log=createWriteStream(join(evidence,'webdriver.log'),{flags:'wx'});
    const driverProcess=spawn(driverPath,['--port',String(port),'--native-port',String(nativePort),'--native-driver',nativePath],{
        env:{...process.env,TAURI_WEBVIEW_AUTOMATION:'true'},stdio:['ignore','pipe','pipe'],windowsHide:true});
    let driverError;driverProcess.once('error',error=>{driverError=error;});
    let logBytes=0;
    const logChunk=chunk=>{if (logBytes<8*1024*1024) {const bounded=chunk.subarray(0,8*1024*1024-logBytes);log.write(bounded);logBytes+=bounded.length;}};
    driverProcess.stdout.on('data',logChunk);driverProcess.stderr.on('data',logChunk);
    const driver=new WebDriver(`http://127.0.0.1:${port}`);
    const fixture=smokeFixture(randomUUID()),sourcePath=join(evidence,fixture.filename);
    const expected={projectName:fixture.projectName,fixtureFilename:fixture.filename,fixtureBytes:fixture.bytes.length,
        fixtureSha256:fixture.sha256,previewMarker:fixture.marker,sourcePath};
    await writeFile(sourcePath,fixture.bytes,{flag:'wx'});
    await writeFile(join(evidence,'expectation.json'),JSON.stringify(expected,null,2)+'\n',{flag:'wx'});
    try {
        await poll('external driver startup',async()=>{
            if (driverError) throw driverError;
            if (driverProcess.exitCode !== null) throw new Error('External driver exited before startup');
            try {return await driver.request('GET','/status');} catch (error) {if (error.cause?.code === 'ECONNREFUSED') return false;throw error;}
        });
        await driver.start(payload.application);
        report.processesBeforeWrite=await poll('release product process',async()=>{const pids=await matchingProcesses(payload.executable);return pids.length ? pids : false;});
        report.profile=await profile(driver,receipt.product.identifier);
        report.frontendEntries=await currentFrontendIdentity(driver,receipt);
        const identity=await lstat(state);report.createdState={dev:identity.dev,ino:identity.ino};
        await writeFile(join(state,'.release-smoke-owner.json'),JSON.stringify({token:report.token}),{flag:'wx'});
        report.ownsState=true;
        await openProjects(driver);
        await driver.button('新建项目');
        const name=await driver.element('css selector','#new-project-name');
        await driver.clear(name);await driver.type(name,fixture.projectName);
        await driver.button('创建项目',"//div[@role='dialog']");
        await poll('created project navigation',()=>driver.execute("return !document.querySelector('#new-project-name')"));
        await openProjects(driver);
        await driver.element('css selector',`button[aria-label="${fixture.projectName}"]`);
        await screenshot(driver,evidence,'project-created');
        await openLibrary(driver);await driver.button('导入素材');
        const inputs=await driver.elements('css selector','[role="dialog"] input[type="file"]');
        if (inputs.length !== 1) throw new Error('Expected the real material import file control');
        await driver.type(inputs[0]['element-6066-11e4-a52e-4f735466cecf'],sourcePath);
        await driver.button('导入 1 个文件',"//div[@role='dialog']");
        await preview(driver,fixture.marker);await screenshot(driver,evidence,'material-preview');
        await driver.closeWindow();
        await poll('first observed product exit',async()=>(await matchingProcesses(payload.executable)).length === 0);
        await driver.dispose();
        report.firstExitObserved=true;
        await rm(sourcePath);report.originalFixtureRemoved=true;
        await driver.start(payload.application);
        await poll('reopened product process',async()=>{const pids=await matchingProcesses(payload.executable);return pids.length ? pids : false;});
        await profile(driver,receipt.product.identifier);await currentFrontendIdentity(driver,receipt);
        await openProjects(driver);await driver.element('css selector',`button[aria-label="${fixture.projectName}"]`);
        await openLibrary(driver);
        await driver.click(await driver.element('css selector',`button[aria-label="${fixture.filename}"]`));
        await preview(driver,fixture.marker);await screenshot(driver,evidence,'reopened-preview');
        await driver.closeWindow();
        await poll('second observed product exit',async()=>(await matchingProcesses(payload.executable)).length === 0);
        await driver.dispose();
        report.secondExitObserved=true;
        const python=process.env.MOMOKI_PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
        const verified=await run(python,[join(root,'tooling/verify-release-smoke-store.py'),'--workspace',join(state,'product-workspace-v1'),
            '--expectation',join(evidence,'expectation.json')],{log:join(evidence,'disk-verifier.log')});
        report.diskVerification=JSON.parse(verified.output.trim());
        if (report.diskVerification.status !== 'passed') throw new Error('Read-only disk verifier did not pass');
        report.fixture={...expected,sourcePath:fixture.filename};
    } catch (error) {
        if (driver.session) {
            try {await screenshot(driver,evidence,'failure');} catch (screenshotError) {report.screenshotError=screenshotError.message;}
        }
        throw error;
    } finally {
        try {await driver.dispose();} catch (error) {report.driverDisposeError=error.message;}
        driverProcess.kill();
        await poll('external driver cleanup',async()=>driverProcess.exitCode !== null || driverProcess.signalCode !== null,{timeout:10000});
        await new Promise(done=>log.end(done));
    }
}

async function macLaunch(payload,receipt,evidence,state,report) {
    const output=createWriteStream(join(evidence,'process-launch.log'),{flags:'wx'});
    const child=spawn(payload.executable,[],{stdio:['ignore','pipe','pipe']});
    let outputBytes=0;
    const outputChunk=chunk=>{if (outputBytes<8*1024*1024) {const bounded=chunk.subarray(0,8*1024*1024-outputBytes);output.write(bounded);outputBytes+=bounded.length;}};
    child.stdout.on('data',outputChunk);child.stderr.on('data',outputChunk);
    let spawnError;child.once('error',error=>{spawnError=error;});
    try {
        await poll('mounted Mac executable launch',async()=>{
            if (spawnError) throw spawnError;
            if (child.exitCode !== null) throw new Error('Mounted Mac product exited during launch');
            return (await matchingProcesses(payload.executable)).includes(child.pid);
        });
        await new Promise(done=>setTimeout(done,8000));
        if (child.exitCode !== null || !(await matchingProcesses(payload.executable)).includes(child.pid)) throw new Error('Mac product did not stay alive during bounded launch');
        const info=await lstat(state);report.createdState={dev:info.dev,ino:info.ino};
        await writeFile(join(state,'.release-smoke-owner.json'),JSON.stringify({token:report.token}),{flag:'wx'});report.ownsState=true;
        report.launch={pid:child.pid,aliveForMs:8000,termination:'SIGTERM after bounded launch',uiStorage:'not established'};
    } finally {
        if (child.exitCode === null) child.kill('SIGTERM');
        await poll('bounded Mac process cleanup',async()=>(await matchingProcesses(payload.executable)).length === 0);
        await new Promise(done=>output.end(done));
    }
}

async function cleanState(state,payload,report) {
    if (!report.ownsState) return;
    if ((await matchingProcesses(payload.executable)).length) throw new Error('Refusing state cleanup while release product still runs');
    const info=await lstat(state),owner=JSON.parse(await readFile(join(state,'.release-smoke-owner.json'),'utf8'));
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== report.createdState.dev || info.ino !== report.createdState.ino
        || owner.token !== report.token) throw new Error('Runner-created state identity changed; refuse cleanup');
    await rm(state,{recursive:true});report.createdStateCleaned=true;
}

async function evidenceFiles(directory) {
    const files=[];
    for (const entry of await readdir(directory,{withFileTypes:true})) {
        // Extracted payload, fixture and WebView profile are not uploaded as evidence.
        if (!entry.isFile() || entry.name === 'checks.json' || entry.name.endsWith('.txt')) continue;
        const bytes=await readFile(join(directory,entry.name));
        if (bytes.length>16*1024*1024) throw new Error('Evidence file boundary');
        files.push({path:entry.name,bytes:bytes.length,sha256:sha256(bytes)});
    }
    return files.sort((a,b)=>a.path.localeCompare(b.path));
}

async function main(args=process.argv.slice(2)) {
    const options=smokeArguments(args),target=getTarget(options.target),evidence=resolve(options['evidence-dir']);
    if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP || !contained(await realpath(process.env.RUNNER_TEMP),evidence)) throw new Error('Product smoke is restricted to fresh GitHub runner-created evidence directories');
    if (target.platform !== process.platform || target.arch !== process.arch) throw new Error('Smoke must run on its matching native host architecture');
    await mkdir(evidence,{recursive:false});
    const receiptPath=resolve(options.receipt),receipt=JSON.parse(await readFile(receiptPath,'utf8'));
    if (receipt.schema !== 1 || receipt.target.id !== target.id || receipt.product.profile !== 'normal' || receipt.product.storage !== 'sqlite'
        || JSON.stringify(receipt.product.features) !== JSON.stringify(PRODUCT.features)
        || ['name','identifier','binary'].some(key=>receipt.product[key] !== PRODUCT[key])) throw new Error('Smoke requires the normal receipted product-sqlite payload');
    const assetPath=await realpath(resolve(options.package));
    if (!contained(join(dirname(receiptPath),'assets'),assetPath)) throw new Error('Installer must be in the receipt assets directory');
    const asset=await verifyInstaller(assetPath,receipt),state=await appData(receipt.product.identifier);
    if (!target.formats.includes(asset.format)) throw new Error('Receipted installer format does not belong to the exact target');
    await assertAbsent(state);
    const report={schema:1,target:target.id,sourceSha:receipt.context.sourceSha,format:asset.format,status:'running',token:randomUUID(),
        startedAt:new Date().toISOString(),stateWasAbsent:true,claim:'Host installer payload proof; no paid providers, microphone, print or power-loss claim.'};
    let payload;
    try {
        payload=await packagePayload(assetPath,asset,receipt,evidence);
        payload.executable=await realpath(payload.executable);
        if ((await matchingProcesses(payload.executable)).length) throw new Error('Installed product already has a process');
        report.payload={kind:payload.kind,identity:await packageIdentity(payload,receipt,target,evidence)};
        report.installer={name:asset.name,bytes:asset.bytes,sha256:asset.sha256};
        if (process.platform === 'darwin') await macLaunch(payload,receipt,evidence,state,report);
        else await uiSmoke(payload,receipt,evidence,state,report);
        await verifyInstaller(assetPath,receipt);
        report.status='passed';
    } catch (error) {report.status='failed';report.error=error.stack ?? error.message;process.exitCode=1;}
    finally {
        if (payload) {
            try {await cleanState(state,payload,report);} catch (error) {report.cleanupError=error.message;report.status='failed';process.exitCode=1;}
            if (payload.mount) {try {await run('hdiutil',['detach',payload.mount],{log:join(evidence,'unmount.log')});} catch (error) {report.unmountError=error.message;report.status='failed';process.exitCode=1;}}
        }
        report.finishedAt=new Date().toISOString();
        await writeFile(join(evidence,'smoke-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
        const integrity=process.platform === 'linux' ? `artifact-integrity-${asset.format}` : 'artifact-integrity';
        const runtime=process.platform === 'darwin' ? 'process-launch' : process.platform === 'linux' ? `${asset.format}-product-ui-storage` : 'product-ui-storage';
        await writeFile(join(evidence,'checks.json'),JSON.stringify({schema:1,target:target.id,sourceSha:receipt.context.sourceSha,
            checks:[{name:integrity,status:report.status,evidence:'smoke-report.json'},{name:runtime,status:report.status,evidence:'smoke-report.json'}],
            evidenceFiles:await evidenceFiles(evidence)},null,2)+'\n',{flag:'wx'});
    }
    if (report.status !== 'passed') throw new Error(`Release smoke failed; see ${join(evidence,'smoke-report.json')}`);
    console.log(`Release smoke passed: ${target.id}/${asset.format}; ${evidence}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error.stack ?? error);process.exitCode=1;});
