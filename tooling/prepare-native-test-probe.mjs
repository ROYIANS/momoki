import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFile,lstat,mkdtemp,mkdir,open,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {desktopRoot,TOOL_VERSIONS,nativeProbeBuildArguments,nativeProbeOutputPath} from '../apps/desktop/scripts/tool-resolver.mjs';

async function toolVersion(command,env) {
    return new Promise((accept,reject)=> {
        const child=spawn(command,['--version'],{env,stdio:['ignore','pipe','pipe'],shell:false});
        let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
        child.once('error',reject);
        child.once('close',(code,signal)=>code === 0 && !signal ? accept(output.trim()) : reject(new Error('Pinned native tool version check failed')));
    });
}

export async function verifyNativeProbeReady(probe,env=process.env) {
    const temporary=await mkdtemp(join(tmpdir(),'momoki-probe-ready-'));
    try {
        return await new Promise((accept,reject)=> {
            const child=spawn(probe,['create',join(temporary,'workspace')],{env,stdio:['pipe','pipe','pipe'],shell:false});
            const lines=createInterface({input:child.stdout});
            let count=0,failure,stderr='';
            const fail=error=> {failure ??= error;child.kill();};
            const timer=setTimeout(()=>fail(new Error('Native test probe readiness timed out')),20000);
            child.stderr.on('data',chunk=> {stderr=(stderr+chunk).slice(-4096);});
            child.stdin.on('error',fail);
            child.once('error',error=> {failure ??= error;});
            lines.on('line',line=> {
                try {
                    if (line.length > 4096) throw new Error('Oversized native test probe readiness reply');
                    const reply=JSON.parse(line);count++;
                    if (count === 1 && reply.ok === true && reply.ready === true && Object.keys(reply).length === 2) {
                        child.stdin.write('{"type":"close"}\n');return;
                    }
                    if (count === 2 && reply.ok === true && reply.value?.closed === true && Object.keys(reply).length === 2 && Object.keys(reply.value).length === 1) {
                        child.stdin.end();return;
                    }
                    throw new Error('Native test probe did not confirm ready and closed');
                } catch (error) {fail(error);}
            });
            child.once('close',(code,signal)=> {
                clearTimeout(timer);lines.close();
                if (failure) reject(failure);
                else if (code !== 0 || signal || count !== 2) reject(new Error(`Native test probe readiness failed: exit=${code}, signal=${signal}, replies=${count}, stderr=${stderr}`));
                else accept({ready:true,closed:true,processExited:true,exitCode:code});
            });
        });
    } finally {await rm(temporary,{recursive:true,force:true});}
}

export async function prepareNativeTestProbe(options,environment=process.env) {
    for (const key of ['cargo','rustc','target-dir','evidence-dir','github-env']) {
        if (!options[key] || !isAbsolute(options[key]) || /[\r\n]/.test(options[key])) throw new Error(`Provide an absolute --${key}`);
    }
    for (const key of ['cargo','rustc']) {
        const path=options[key],entry=await lstat(path);
        if (!entry.isFile() || entry.isSymbolicLink() || /codex-runtimes/.test(path)) throw new Error('Native probe preparation requires actual approved tool executables');
    }
    if (environment.RUSTC_WRAPPER || environment.RUSTC_WORKSPACE_WRAPPER) throw new Error('Rust compiler wrappers are not allowed for native probe preparation');
    const target=resolve(options['target-dir']),evidence=resolve(options['evidence-dir']);
    const env={...environment,RUSTUP_TOOLCHAIN:TOOL_VERSIONS.rust,RUSTC:options.rustc,CARGO_TARGET_DIR:target,CARGO_INCREMENTAL:'0',CARGO_PROFILE_DEV_DEBUG:'0'};
    const versions={cargo:await toolVersion(options.cargo,env),rustc:await toolVersion(options.rustc,env)};
    if (!versions.cargo.startsWith(`cargo ${TOOL_VERSIONS.rust} `) || !versions.rustc.startsWith(`rustc ${TOOL_VERSIONS.rust} `)) throw new Error('Native test probe requires pinned Cargo and rustc 1.99.0');
    const exportFile=await lstat(options['github-env']);
    if (!exportFile.isFile() || exportFile.isSymbolicLink()) throw new Error('Probe environment output must be an existing regular file');
    await mkdir(evidence,{recursive:false});
    const report={schema:1,startedAt:new Date().toISOString(),status:'building',targetDirectory:target,coldTargetRequired:true,versions,executables:{cargo:options.cargo,rustc:options.rustc},commands:[],limitations:'No-GUI SQLite test probe readiness only; not packaged-product or corresponding-platform acceptance.'};
    try {
        // A warm/stale executable cannot satisfy the quality job prerequisite.
        await mkdir(target,{recursive:false});report.targetAbsentBeforeBuild=true;
        const args=nativeProbeBuildArguments(),log=await open(join(evidence,'probe-build.log'),'wx');
        report.commands.push({command:options.cargo,args,log:'probe-build.log'});
        try {
            report.buildExitCode=await new Promise((accept,reject)=> {
                const child=spawn(options.cargo,args,{cwd:desktopRoot,env,stdio:['ignore',log.fd,log.fd],shell:false});
                child.once('error',reject);child.once('close',(code,signal)=>accept(signal ? 1 : code ?? 1));
            });
        } finally {await log.close();}
        if (report.buildExitCode !== 0) throw new Error('Native test probe build failed; root tests must not start');
        const path=nativeProbeOutputPath(target),entry=await lstat(path);
        if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0) throw new Error('Fresh native test probe output is missing or invalid');
        report.probe={path,size:entry.size,sha256:createHash('sha256').update(await readFile(path)).digest('hex')};
        report.readiness=await verifyNativeProbeReady(path,env);
        await appendFile(options['github-env'],`MOMOKI_NATIVE_STORE_PROBE=${path}\n`);
        report.status='passed';return report;
    } catch (error) {
        report.status='failed';report.error=error instanceof Error ? error.message : String(error);throw error;
    } finally {
        report.finishedAt=new Date().toISOString();await writeFile(join(evidence,'probe-ready.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const options={};
    for (let index=2;index<process.argv.length;index+=2) {
        const key=process.argv[index]?.slice(2),value=process.argv[index+1];
        if (!process.argv[index]?.startsWith('--') || !['cargo','rustc','target-dir','evidence-dir','github-env'].includes(key) || !value || key in options) throw new Error('Expected --cargo --rustc --target-dir --evidence-dir --github-env');
        options[key]=value;
    }
    await prepareNativeTestProbe(options);
    console.log('Fresh pinned native SQLite test probe is ready; root tests may start.');
}
