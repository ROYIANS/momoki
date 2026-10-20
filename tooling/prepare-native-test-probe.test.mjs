import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {prepareNativeTestProbe,verifyNativeProbeReady} from './prepare-native-test-probe.mjs';
import {nativeProbeBuildArguments,nativeProbeOutputPath} from '../apps/desktop/scripts/tool-resolver.mjs';

const readySource=`process.stdout.write('{"ready":true,"ok":true}\\n');
let input='';process.stdin.on('data',chunk=>{input+=chunk;if(input.includes('\\n')) {if(JSON.parse(input).type !== 'close') process.exit(3);process.stdout.write('{"ok":true,"value":{"closed":true}}\\n');}});`;
async function executable(path,source) {await writeFile(path,'#!/usr/bin/env node\n'+source);await chmod(path,0o755);return path;}
async function fixture({buildFails=false,rustVersion='1.99.0',probeSource=readySource}={}) {
    const root=await mkdtemp(join(tmpdir(),'momoki-probe-contract-'));
    const options={cargo:join(root,'cargo'),rustc:join(root,'rustc'),'target-dir':join(root,'target'),'evidence-dir':join(root,'evidence'),'github-env':join(root,'github-env')};
    await executable(options.rustc,`console.log('rustc ${rustVersion} (contract fixture)');`);
    await executable(options.cargo,`import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
if(process.argv[2]==='--version') {console.log('cargo 1.99.0 (contract fixture)');}
else {if(${buildFails}) process.exit(2);const path=join(process.env.CARGO_TARGET_DIR,'debug');mkdirSync(path,{recursive:true});writeFileSync(join(path,'product_store_probe'),'#!/usr/bin/env node\\n'+${JSON.stringify(probeSource)},{mode:0o755});writeFileSync(join(process.env.CARGO_TARGET_DIR,'invocation.json'),JSON.stringify({args:process.argv.slice(2),rustc:process.env.RUSTC}));}`);
    await writeFile(options['github-env'],'EXISTING=value\n');
    return {root,options,cleanup:()=>rm(root,{recursive:true,force:true})};
}
test('shared probe build selects only locked no-GUI test hooks and platform-correct output',()=> {
    const args=nativeProbeBuildArguments('x86_64-unknown-linux-gnu');
    assert.deepEqual(args,['build','--manifest-path','src-tauri/Cargo.toml','--locked','--no-default-features','--features','test-hooks','--bin','product_store_probe','--target','x86_64-unknown-linux-gnu']);
    assert.equal(nativeProbeOutputPath('/target','x86_64-pc-windows-msvc','win32'),resolve('/target/x86_64-pc-windows-msvc/debug/product_store_probe.exe'));
});
test('fresh build and actual readiness exit precede explicit environment export',async ()=> {
    const f=await fixture();try {
        const report=await prepareNativeTestProbe(f.options,{...process.env,MOMOKI_NATIVE_STORE_PROBE:'/ignored-stale-probe'});
        assert.equal(report.status,'passed');assert.equal(report.targetAbsentBeforeBuild,true);
        assert.deepEqual(report.readiness,{ready:true,closed:true,processExited:true,exitCode:0});
        const build=JSON.parse(await readFile(join(f.options['target-dir'],'invocation.json'),'utf8'));
        assert.equal(build.rustc,f.options.rustc);assert.deepEqual(build.args,nativeProbeBuildArguments());
        assert.equal(await readFile(f.options['github-env'],'utf8'),`EXISTING=value\nMOMOKI_NATIVE_STORE_PROBE=${nativeProbeOutputPath(f.options['target-dir'])}\n`);
    } finally {await f.cleanup();}
});
test('failed build cannot export a stale or absent executable',async ()=> {
    const f=await fixture({buildFails:true});try {
        await assert.rejects(prepareNativeTestProbe(f.options),/build failed/);
        assert.equal(await readFile(f.options['github-env'],'utf8'),'EXISTING=value\n');
        const report=JSON.parse(await readFile(join(f.options['evidence-dir'],'probe-ready.json'),'utf8'));
        assert.equal(report.status,'failed');assert.equal(report.buildExitCode,2);assert.equal(report.probe,undefined);
    } finally {await f.cleanup();}
});
test('an existing target directory fails closed and preserves its bytes',async ()=> {
    const f=await fixture();try {
        await mkdir(f.options['target-dir']);await writeFile(join(f.options['target-dir'],'foreign'),'unchanged');
        await assert.rejects(prepareNativeTestProbe(f.options),/EEXIST/);
        assert.equal(await readFile(join(f.options['target-dir'],'foreign'),'utf8'),'unchanged');
        assert.equal(await readFile(f.options['github-env'],'utf8'),'EXISTING=value\n');
    } finally {await f.cleanup();}
});
test('wrong rustc and compiler wrappers reject before build or environment export',async ()=> {
    const f=await fixture({rustVersion:'1.98.0'});try {
        await assert.rejects(prepareNativeTestProbe(f.options),/pinned Cargo and rustc/);
        await assert.rejects(prepareNativeTestProbe(f.options,{...process.env,RUSTC_WRAPPER:'/wrapper'}),/wrappers/);
        assert.equal(await readFile(f.options['github-env'],'utf8'),'EXISTING=value\n');
    } finally {await f.cleanup();}
});
test('missing, failed and premature probe processes cannot manufacture readiness',async ()=> {
    const f=await fixture();try {
        await assert.rejects(verifyNativeProbeReady(join(f.root,'missing')),/ENOENT/);
        for (const [index,source] of [
            "process.exit(0);",
            "console.log('{\"ok\":false,\"ready\":true}');process.stdin.resume();",
            "console.log('{\"ok\":true,\"ready\":true}');process.exit(0);",
            "console.log('malformed');process.stdin.resume();",
        ].entries()) {
            const path=await executable(join(f.root,`invalid-${index}`),source);
            await assert.rejects(verifyNativeProbeReady(path));
        }
    } finally {await f.cleanup();}
});
test('a fresh executable without a valid close acknowledgement cannot export the path',async ()=> {
    const f=await fixture({probeSource:"console.log('{\"ok\":true,\"ready\":true}');process.stdin.on('data',()=>{console.log('{\"ok\":false}');});"});try {
        await assert.rejects(prepareNativeTestProbe(f.options),/did not confirm/);
        assert.equal(await readFile(f.options['github-env'],'utf8'),'EXISTING=value\n');
    } finally {await f.cleanup();}
});
test('GHCR prepares the real probe before root tests while desktop delivery remains packaging-only',async ()=> {
    const ghcr=await readFile(resolve(import.meta.dirname,'../.github/workflows/ghcr.yml'),'utf8');
    assert.match(ghcr,/\n  quality:\n/);
    const quality=ghcr.split('\n  quality:\n')[1].split(/\n  [a-z][a-z-]*:\n/)[0];
    const preparation=quality.indexOf('node tooling/prepare-native-test-probe.mjs');
    const installation=quality.indexOf('rustup toolchain install 1.99.0 --profile minimal');
    assert.ok(installation >= 0 && preparation > installation);
    const fullTest=quality.search(/(?:run: pnpm test\n|pnpm\.cjs" test\n)/);
    assert.ok(preparation >= 0 && fullTest > preparation);
    assert.match(quality,/--cargo "\$\(rustup which --toolchain 1\.99\.0 cargo\)" --rustc "\$\(rustup which --toolchain 1\.99\.0 rustc\)"/);
    assert.match(quality,/--github-env "\$GITHUB_ENV"/);
    assert.doesNotMatch(quality,/MOMOKI_STORAGE_TEST_OWNER|MOMOKI_NATIVE_STORAGE_ACCEPTANCE|--features product-sqlite/);
    assert.match(quality,/node --test tooling\/prepare-native-test-probe\.test\.mjs/);
    assert.match(ghcr,/node-version: 22/);
    const example=ghcr.split('\n  agent-example:\n')[1].split(/\n  [a-z][a-z-]*:\n/)[0];
    assert.match(example,/node-version: 24\.11\.0/);
    assert.match(example,/pnpm agent:example:check/);
    assert.match(ghcr,/needs: \[quality, agent-example\]/);
    const docker=await readFile(resolve(import.meta.dirname,'../Dockerfile'),'utf8');
    for (const path of ['packages/agent-core','packages/agent-providers','examples/agent-todo']) assert.ok(docker.indexOf(`COPY ${path}/package.json`) < docker.indexOf('RUN pnpm install --frozen-lockfile') && docker.includes(`COPY ${path}/package.json`),path);
    const vitest=await readFile(resolve(import.meta.dirname,'../vitest.config.ts'),'utf8');
    assert.doesNotMatch(vitest,/examples\/\*\/src\/\*\*\/\*\.test/);
    const desktop=await readFile(resolve(import.meta.dirname,'../.github/workflows/desktop-release.yml'),'utf8');
    assert.doesNotMatch(desktop,/\n  quality:\n|prepare-native-test-probe|vitest|pnpm(?:\.cjs")? test|release-native-checks|run-release-smokes/);
});
