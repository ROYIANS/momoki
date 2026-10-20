#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {appendFile,lstat,mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runTool} from '../apps/desktop/scripts/tool-resolver.mjs';
import {contained,sha256} from './release-smoke-support.mjs';

const TAURI_DRIVER_VERSION='2.1.0';
const TAURI_DRIVER_CRATE_SHA256='2f2e29bd6900fb718dfdc06f2e7a371d6087c085daaf83709847ef3e6b0c1953';

export async function verifyConsumedCrate(cargoHome) {
    const root=join(cargoHome,'registry','cache');
    const namespaces=await readdir(root,{withFileTypes:true});
    const verified=[];
    for (const entry of namespaces) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const path=join(root,entry.name,`tauri-driver-${TAURI_DRIVER_VERSION}.crate`);
        let stat;
        try {stat=await lstat(path);} catch (error) {if (error.code === 'ENOENT') continue;throw error;}
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8*1024*1024) throw new Error('Consumed tauri-driver crate is not an ordinary bounded archive');
        const actual=sha256(await readFile(path));
        if (actual !== TAURI_DRIVER_CRATE_SHA256) throw new Error('Consumed tauri-driver crate checksum differs from pinned source');
        verified.push({path,bytes:stat.size,sha256:actual});
    }
    if (!verified.length) throw new Error('Consumed tauri-driver crate archive was not found in actual Cargo cache');
    return {declaredSha256:TAURI_DRIVER_CRATE_SHA256,verifiedCachedArchives:verified};
}

export function compatibleDriver(runtime,driver) {
    const parse=value=>value.match(/\b(\d+\.\d+\.\d+\.\d+)\b/)?.[1];
    const actual=parse(runtime),observed=parse(driver);
    if (!actual || !observed || actual.split('.').slice(0,3).join('.') !== observed.split('.').slice(0,3).join('.')) throw new Error('Edge driver does not match actual WebView2 runtime');
    return {runtime:actual,driver:observed};
}

async function command(executable,args) {
    const child=spawn(executable,args,{stdio:['ignore','pipe','pipe'],windowsHide:true});
    let output='',error='',timedOut=false;
    child.stdout.on('data',chunk=>{output=(output+chunk.toString()).slice(-1024*1024);});
    child.stderr.on('data',chunk=>{error=(error+chunk.toString()).slice(-1024*1024);});
    const timer=setTimeout(()=>{timedOut=true;child.kill();},60000);
    try {
        const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});
        if (code !== 0 || timedOut) throw new Error(`Driver setup command failed: ${executable}: ${error}`);
        return output.trim();
    } finally {clearTimeout(timer);}
}
function powershell(source) {return ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')];}
const literal=value=>`'${value.replaceAll("'","''")}'`;

async function download(url,path) {
    const response=await fetch(url,{signal:AbortSignal.timeout(60000)});
    if (!response.ok) throw new Error(`Exact-version driver download failed (${response.status}): ${url}`);
    const reader=response.body.getReader();const chunks=[];let size=0;
    try {
        while (true) {
            const {done,value}=await reader.read();if (done) break;
            size+=value.length;if (size>64*1024*1024) throw new Error('Driver archive boundary');chunks.push(value);
        }
    } catch (error) {await reader.cancel();throw error;}
    const bytes=Buffer.concat(chunks);await writeFile(path,bytes,{flag:'wx'});
    return {url,bytes:bytes.length,sha256:sha256(bytes)};
}

async function main() {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.MOMOKI_TOOL_MODE !== 'hosted' || !process.env.RUNNER_TEMP || !process.env.GITHUB_ENV) throw new Error('Driver setup requires the explicit hosted runner lane');
    if (!['linux','win32'].includes(process.platform)) throw new Error('External native driver is only supported on Windows/Linux');
    const directory=resolve(process.env.RUNNER_TEMP,'momoki-release-driver');
    if (!contained(await realpath(process.env.RUNNER_TEMP),directory)) throw new Error('Driver directory must stay inside runner temporary root');
    await mkdir(directory,{recursive:false});
    const report={schema:1,platform:process.platform,tauriVersion:TAURI_DRIVER_VERSION,source:'https://crates.io/crates/tauri-driver/2.1.0',status:'running'};
    try {
        const cargo=await runTool('cargo',['install','tauri-driver','--version',TAURI_DRIVER_VERSION,'--locked','--root',directory]);
        if (cargo.code !== 0) throw new Error('Pinned tauri-driver installation failed');
        report.crate=await verifyConsumedCrate(process.env.CARGO_HOME || join(homedir(),'.cargo'));
        const tauri=join(directory,'bin',`tauri-driver${process.platform === 'win32' ? '.exe' : ''}`);
        const help=await command(tauri,['--help']);
        if (!help.includes('--native-driver') || !help.includes('--native-port')) throw new Error('Unexpected pinned driver CLI');
        let native;
        if (process.platform === 'linux') {
            native=await realpath('/usr/bin/WebKitWebDriver');
            report.nativePackage=await command('dpkg-query',['-W','-f=${Package} ${Version}\n','webkit2gtk-driver']);
            report.nativeWebkitPackage=await command('dpkg-query',['-W','-f=${Package} ${Version}\n','libwebkit2gtk-4.1-0']);
        } else {
            const runtime=JSON.parse(await command('powershell.exe',powershell(`
                $roots=@((Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)) 'Microsoft/EdgeWebView/Application'),(Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'Microsoft/EdgeWebView/Application'))
                $candidates=@(foreach($root in $roots) { if(Test-Path -LiteralPath $root) {Get-ChildItem -LiteralPath $root -Directory | ForEach-Object {Join-Path $_.FullName 'msedgewebview2.exe'} | Where-Object {Test-Path -LiteralPath $_}} })
                $selected=$candidates | ForEach-Object {$f=Get-Item -LiteralPath $_; [PSCustomObject]@{path=$f.FullName; version=$f.VersionInfo.ProductVersion}} | Sort-Object { [version]$_.version } -Descending | Select-Object -First 1
                if(!$selected){throw 'Actual WebView2 runtime not found'}
                $selected | ConvertTo-Json -Compress
            `)));
            if (!/^\d+\.\d+\.\d+\.\d+$/.test(runtime.version)) throw new Error('Invalid installed WebView2 version');
            const archive=join(directory,'edgedriver.zip');
            report.download=await download(`https://msedgedriver.microsoft.com/${runtime.version}/edgedriver_win64.zip`,archive);
            const extracted=join(directory,'edge');
            await command('powershell.exe',powershell(`Expand-Archive -LiteralPath ${literal(archive)} -DestinationPath ${literal(extracted)} -ErrorAction Stop`));
            native=await realpath(join(extracted,'msedgedriver.exe'));
            const version=await command(native,['--version']);
            report.webview2={path:runtime.path,...compatibleDriver(runtime.version,version)};
        }
        report.executables={tauri:{path:tauri,sha256:sha256(await readFile(tauri))},native:{path:native,sha256:sha256(await readFile(native))}};
        await appendFile(process.env.GITHUB_ENV,`TAURI_DRIVER_PATH=${tauri}\nMOMOKI_NATIVE_WEBDRIVER_PATH=${native}\nMSEDGEDRIVER_TELEMETRY_OPTOUT=1\n`);
        report.status='passed';
    } catch (error) {report.status='failed';report.error=error.stack ?? error.message;throw error;}
    finally {await writeFile(join(directory,'driver-setup.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error.stack ?? error);process.exitCode=1;});
