import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {delimiter, isAbsolute, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
export const TOOL_VERSIONS = Object.freeze({node:'24.11.0',pnpm:'10.15.0',rust:'1.99.0',tauri:'2.12.1'});
const localNodeBin = '/Users/xiaomengdao/.nvm/versions/node/v24.11.0/bin';

export function resolveTools(environment=process.env, platform=process.platform) {
    const mode=environment.MOMOKI_TOOL_MODE ?? 'local';
    if (!['local','hosted'].includes(mode)) throw new Error('MOMOKI_TOOL_MODE must be local or hosted');
    const suffix=platform === 'win32' ? '.exe' : '';
    let tools,env;
    if (mode === 'local') {
        if (platform !== 'darwin') throw new Error('Non-Mac hosts require explicit hosted tools');
        const bin=resolve(desktopRoot,'.tools/cargo/bin');
        tools=Object.fromEntries(['cargo','rustc','rustup','rustfmt'].map(name=>[name,resolve(bin,name)]));
        tools.pnpm=resolve(localNodeBin,'pnpm');
        env={...environment,RUSTUP_HOME:resolve(desktopRoot,'.tools/rustup'),CARGO_HOME:resolve(desktopRoot,'.tools/cargo'),
            CARGO_TARGET_DIR:resolve(desktopRoot,'.tools/target'),PATH:[bin,localNodeBin,environment.PATH ?? ''].join(delimiter)};
    } else {
        tools=Object.fromEntries(['cargo','rustc','rustup','rustfmt','pnpm'].map(name=> {
            const path=environment[`MOMOKI_${name.toUpperCase()}_PATH`];
            if (!path || !isAbsolute(path) || /codex-runtimes/.test(path)) throw new Error(`Provide an explicit approved MOMOKI_${name.toUpperCase()}_PATH`);
            if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(path)) throw new Error('Use pnpm.cjs or an executable; shell command shims are not accepted');
            return [name,path];
        }));
        env={...environment,CARGO_TARGET_DIR:resolve(environment.CARGO_TARGET_DIR ?? resolve(desktopRoot,'.release/target'))};
    }
    return {mode,tools,env:{...env,RUSTUP_TOOLCHAIN:TOOL_VERSIONS.rust},suffix};
}

export function toolInvocation(name,args=[],options={}) {
    const resolved=resolveTools(options.env,options.platform);
    const path=resolved.tools[name];
    if (!path || !existsSync(path)) throw new Error(`Approved tool is missing: ${name}`);
    // Windows pnpm.cmd needs a shell. Invoke the pinned package's JavaScript
    // entry directly, retaining argument boundaries and never enabling shell.
    const javascript=/\.(?:cjs|mjs|js)$/i.test(path);
    return {command:javascript ? process.execPath : path,args:javascript ? [path,...args] : args,env:resolved.env};
}

export function runTool(name,args=[],options={}) {
    const invocation=toolInvocation(name,args,options);
    return new Promise((accept,reject)=> {
        const child=spawn(invocation.command,invocation.args,{cwd:options.cwd ?? desktopRoot,env:invocation.env,stdio:options.stdio ?? 'inherit',shell:false});
        child.once('error',reject);
        child.once('exit',(code,signal)=>accept({code:signal ? 1 : code ?? 1,signal}));
    });
}

export function nativeTargetDirectory({env=process.env,target,profile='debug'}={}) {
    const directory=resolveTools(env).env.CARGO_TARGET_DIR;
    return resolve(directory,...(target ? [target] : []),profile);
}

export function nativeProbePath(env=process.env) {
    if (env.MOMOKI_NATIVE_STORE_PROBE) return resolve(env.MOMOKI_NATIVE_STORE_PROBE);
    return nativeProbeOutputPath(resolveTools(env).env.CARGO_TARGET_DIR,env.MOMOKI_RUST_TARGET);
}

export function nativeProbeOutputPath(targetDirectory,target,platform=process.platform) {
    return resolve(targetDirectory,...(target ? [target] : []),'debug','product_store_probe'+(platform === 'win32' ? '.exe' : ''));
}

export function nativeProbeBuildArguments(target) {
    const args=['build','--manifest-path','src-tauri/Cargo.toml','--locked','--no-default-features','--features','test-hooks','--bin','product_store_probe'];
    if (target) args.push('--target',target);
    return args;
}
