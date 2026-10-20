import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {TARGETS,PRODUCT,WORKFLOW,assetName,policyHash,runContext,sha256} from './release-policy.mjs';
import {TOOL_VERSIONS,resolveTools} from './tool-resolver.mjs';
import {collectArtifacts,copyCheckReports,verifyReleaseDirectory,verifyTargetDirectory} from './release-artifacts.mjs';
import {publishDraft} from './publish-draft.mjs';
import {selectArtifacts} from './select-release-artifacts.mjs';
import {releaseBuildArguments} from './build-release.mjs';
import {mediaReleaseIdentity} from './media-resources.mjs';

const context={repository:'ROYIANS/momoki',workflow:WORKFLOW,sourceSha:'a'.repeat(40),event:'push',mode:'draft',tag:'desktop-v0.1.0',runId:'42',attempt:2,version:'0.1.0'};
const clone=value=>JSON.parse(JSON.stringify(value));
async function fixture({state='packaged'}={}) {
    const root=await mkdtemp(join(tmpdir(),'momoki-release-tests-')),directories=[],selections=[];
    for (const [index,target] of Object.values(TARGETS).entries()) {
        const path=join(root,target.id);await mkdir(path);await mkdir(join(path,'assets'));
        const assets=[];
        for (const format of target.formats) {
            const name=assetName(target.id,context.version,format),bytes=Buffer.from(`real-fixture-${target.id}-${format}`);
            await writeFile(join(path,'assets',name),bytes);assets.push({name,format,bytes:bytes.length,sha256:sha256(bytes)});
        }
        const evidence=Buffer.from(JSON.stringify({fixture:true,target:target.id}));
        if (state === 'verified') {await mkdir(join(path,'evidence'));await writeFile(join(path,'evidence/report.json'),evidence);}
        const frontendFiles={'index.html':sha256('normal-root-frontend')};
        const receipt={schema:1,state,policyHash:policyHash(),context:{...context,attempt:index % 2+1},target:Object.fromEntries(['id','platform','arch','runner','triple'].map(key=>[key,target[key]])),product:{...PRODUCT,signing:target.signing},tools:{versions:TOOL_VERSIONS,executables:{cargo:'/fake/cargo'},host:{platform:target.platform,arch:target.arch}},inputs:{sourceBefore:{'package.json':sha256('source')},sourceAfter:{'package.json':sha256('source')}},payload:{executableSha256:sha256('executable'),frontendFiles,frontendSha256:sha256(JSON.stringify(frontendFiles)),mediaResources:await mediaReleaseIdentity(target.id)},assets,checks:state === 'verified' ? target.requiredChecks.map(name=>({name,status:'passed',evidence:'evidence/report.json'})) : [],evidenceFiles:state === 'verified' ? [{path:'evidence/report.json',bytes:evidence.length,sha256:sha256(evidence)}] : []};
        await writeFile(join(path,'receipt.json'),JSON.stringify(receipt));directories.push(path);
        selections.push({id:index+1,name:`desktop-${target.id}-${context.runId}-${receipt.context.attempt}`,target:target.id,attempt:receipt.context.attempt,runId:context.runId});
    }
    return {root,directories,selections,output:join(root,'collected'),async cleanup() {await rm(root,{recursive:true,force:true});}};
}
async function altered(fixture,target,change) {
    const path=join(fixture.directories[target],'receipt.json'),receipt=JSON.parse(await readFile(path,'utf8'));change(receipt);await writeFile(path,JSON.stringify(receipt));
}

test('closed event policy makes bootstrap and manual runs build-only',()=> {
    const base={GITHUB_SHA:context.sourceSha,GITHUB_REPOSITORY:context.repository,GITHUB_RUN_ID:'42',GITHUB_RUN_ATTEMPT:'2'};
    assert.equal(runContext({...base,GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/codex/desktop-release-pipeline'}).mode,'build-only');
    assert.equal(runContext({...base,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/tags/desktop-v0.1.0'}).mode,'build-only');
    assert.equal(runContext({...base,GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/tags/desktop-v0.1.0'}).mode,'draft');
    for (const ref of ['refs/heads/main','refs/heads/codex/other','refs/tags/v0.1.0','refs/tags/desktop-v0.1.0-extra']) assert.throws(()=>runContext({...base,GITHUB_EVENT_NAME:'push',GITHUB_REF:ref}));
});
test('portable tools retain local lane and reject Windows shell shims',()=> {
    assert.equal(resolveTools({},'darwin').tools.pnpm,'/Users/xiaomengdao/.nvm/versions/node/v24.11.0/bin/pnpm');
    assert.throws(()=>resolveTools({},'win32'));
    const env={MOMOKI_TOOL_MODE:'hosted',MOMOKI_CARGO_PATH:'C:\\tools\\cargo.exe',MOMOKI_RUSTC_PATH:'C:\\tools\\rustc.exe',MOMOKI_RUSTUP_PATH:'C:\\tools\\rustup.exe',MOMOKI_RUSTFMT_PATH:'C:\\tools\\rustfmt.exe',MOMOKI_PNPM_PATH:'C:\\tools\\pnpm.cmd'};
    // Host path syntax is OS dependent, but either rejection keeps the shim
    // from being interpolated into a shell on this platform.
    assert.throws(()=>resolveTools(env,'win32'));
});
test('release commands preserve Mac app receipts and disable per-format executable rewriting',()=> {
    for (const target of Object.values(TARGETS)) {
        const args=releaseBuildArguments(target.id);
        assert.equal(args[args.indexOf('--target')+1],target.triple);
        assert.equal(args[args.indexOf('--features')+1],'product-sqlite');
        assert.ok(args.includes('--no-binary-patching'));
        assert.deepEqual(args.slice(-2),['--','--locked']);
        assert.equal(args[args.indexOf('--bundles')+1],target.platform === 'darwin' ? 'app,dmg' : target.bundles.join(','));
        if (target.platform === 'darwin') assert.deepEqual(target.formats,['dmg']);
    }
    assert.throws(()=>releaseBuildArguments('unsupported'));
});
test('collector accepts four packaged targets across explicit attempts and emits five installers without test claims',async ()=> {
    const f=await fixture();try {
        const manifest=await collectArtifacts(f.directories,f.output,context,f.selections);
        assert.equal(manifest.installers.length,5);assert.equal(manifest.targets.length,4);
        for (const {receipt} of manifest.targets) {assert.equal(receipt.state,'packaged');assert.deepEqual(receipt.checks,[]);assert.deepEqual(receipt.evidenceFiles,[]);}
        assert.match(manifest.limitations.join('\n'),/Packaging-only delivery/);
        assert.match(manifest.limitations.join('\n'),/no automated tests, application launch or runtime acceptance/);
        assert.match(manifest.limitations.join('\n'),/owner performs functional testing before public publication/);
        assert.doesNotMatch(manifest.limitations.join('\n'),/smoke proves|smoke launches/);
        assert.deepEqual(await verifyReleaseDirectory(f.output),manifest);
        assert.equal((await readFile(join(f.output,'SHA256SUMS'),'utf8')).split('\n').filter(Boolean).length,5);
    } finally {await f.cleanup();}
});
test('explicit verified artifacts still require and retain their hashed check evidence',async ()=> {
    const f=await fixture({state:'verified'});try {
        const manifest=await collectArtifacts(f.directories,f.output,context,f.selections);
        assert.deepEqual(await verifyReleaseDirectory(f.output),manifest);
        for (const {receipt} of manifest.targets) assert.equal(receipt.checks.length,TARGETS[receipt.target.id].requiredChecks.length);
        assert.doesNotMatch(manifest.limitations.join('\n'),/Packaging-only delivery/);
        await writeFile(join(f.directories[0],'evidence/report.json'),'changed evidence');
        await assert.rejects(verifyTargetDirectory(f.directories[0],context),/checksum/);
    } finally {await f.cleanup();}
});
test('release revalidation rejects changed artifact provenance and divergent source inputs',async ()=> {
    for (const change of [
        manifest=>manifest.targets[0].artifact.id=manifest.targets[1].artifact.id,
        manifest=>manifest.targets[0].artifact.name='desktop-macos-arm64-42-9',
        manifest=>manifest.targets[0].artifact.target='windows-x64',
        manifest=>manifest.targets[0].artifact.runId='43',
        manifest=>manifest.targets[0].artifact.attempt=9,
        manifest=>manifest.targets[0].artifact.extra=true,
        manifest=>manifest.context.extra=true,
        manifest=>manifest.context.event='workflow_dispatch',
        manifest=>manifest.limitations=['All software tests passed'],
        manifest=>manifest.targets[0].receipt.state='verified',
        manifest=>{manifest.targets[1].receipt.inputs.sourceBefore['package.json']=sha256('different source');manifest.targets[1].receipt.inputs.sourceAfter['package.json']=sha256('different source');},
    ]) {
        const f=await fixture();try {
            await collectArtifacts(f.directories,f.output,context,f.selections);
            const path=join(f.output,'release-manifest.json'),manifest=JSON.parse(await readFile(path,'utf8'));
            change(manifest);await writeFile(path,JSON.stringify(manifest));
            await assert.rejects(verifyReleaseDirectory(f.output));
            const {api,state}=fakeApi();await assert.rejects(publishDraft(f.output,{api,context}));
            assert.equal(state.gets.length,0);assert.equal(state.uploads,0);
        } finally {await f.cleanup();}
    }
});
for (const [name,mutate] of [
    ['wrong source',r=>r.context.sourceSha='b'.repeat(40)],['wrong run',r=>r.context.runId='43'],['future attempt',r=>r.context.attempt=3],
    ['wrong owner',r=>r.product.storage='indexeddb'],['test hooks',r=>r.product.features.push('test-hooks')],['wrong architecture',r=>r.target.arch='arm'],
    ['changed input',r=>r.inputs.sourceAfter['package.json']='b'.repeat(64)],['unsafe filename',r=>r.assets[0].name='../escape'],
    ['extra field',r=>r.hidden=true],['wrong tool',r=>r.tools.versions={...r.tools.versions,pnpm:'11.0.0'}],
    ['wrong build host',r=>r.tools.host.arch='arm'],['missing installer',r=>r.assets.pop()],['wrong signing',r=>r.product.signing='signed'],
    ['building state',r=>r.state='building'],['invented state',r=>r.state='passed'],
    ['fabricated passed check',r=>r.checks.push({name:'native-tests',status:'passed',evidence:'evidence/fake.json'})],
    ['packaged evidence',r=>r.evidenceFiles.push({path:'evidence/fake.json',bytes:1,sha256:sha256('x')})],
    ['missing media identity',r=>delete r.payload.mediaResources],
    ['foreign media target',r=>r.payload.mediaResources.target='windows-x64'],
    ['changed media decoder hash',r=>r.payload.mediaResources.manifest.executables.ffmpeg.sha256='b'.repeat(64)],
    ['omitted corresponding source',r=>delete r.payload.mediaResources.files[Object.keys(r.payload.mediaResources.files).find(path=>path.startsWith('sources/'))]],
    ['malformed checks',r=>r.checks={}],['malformed evidence',r=>r.evidenceFiles=null],
]) test(`collector rejects ${name}`,async ()=> {
    const f=await fixture();try {await altered(f,0,mutate);await assert.rejects(collectArtifacts(f.directories,f.output,context,f.selections));} finally {await f.cleanup();}
});
for (const [name,mutate] of [
    ['failed check',r=>r.checks[0].status='failed'],['missing check',r=>r.checks.pop()],['unknown check',r=>r.checks[0].name='invented'],
    ['duplicate check',r=>r.checks[1]={...r.checks[0]}],['missing evidence',r=>r.evidenceFiles=[]],['missing check evidence',r=>r.checks[0].evidence='evidence/absent.json'],
]) test(`explicit verified collector rejects ${name}`,async ()=> {
    const f=await fixture({state:'verified'});try {await altered(f,0,mutate);await assert.rejects(collectArtifacts(f.directories,f.output,context,f.selections));} finally {await f.cleanup();}
});
test('collector hashes actual packaged installer bytes, not claimed strings',async ()=> {
    const f=await fixture();try {
        const receipt=JSON.parse(await readFile(join(f.directories[0],'receipt.json'),'utf8'));
        await writeFile(join(f.directories[0],'assets',receipt.assets[0].name),'mutated bytes');
        await assert.rejects(verifyTargetDirectory(f.directories[0],context),/checksum/);
    } finally {await f.cleanup();}
});
test('collector refuses links and unknown package closure files',async ()=> {
    const f=await fixture();try {
        await writeFile(join(f.directories[0],'extra-secret.txt'),'fixture only');
        await assert.rejects(verifyTargetDirectory(f.directories[0],context),/Unexpected/);
        await rm(join(f.directories[0],'extra-secret.txt'));await symlink(join(f.directories[0],'receipt.json'),join(f.directories[0],'linked-receipt'));
        await assert.rejects(verifyTargetDirectory(f.directories[0],context),/Links/);
    } finally {await f.cleanup();}
});
test('collector refuses duplicate target or artifact identity and omitted targets',async ()=> {
    const f=await fixture();try {
        await assert.rejects(collectArtifacts(f.directories.slice(1),f.output,context,f.selections.slice(1)),/four/);
        const picks=clone(f.selections);picks[1].id=picks[0].id;
        await assert.rejects(collectArtifacts(f.directories,f.output,context,picks),/selection/);
        await assert.rejects(collectArtifacts([f.directories[0],f.directories[0],...f.directories.slice(2)],f.output,context,[f.selections[0],f.selections[0],...f.selections.slice(2)]));
    } finally {await f.cleanup();}
});
for (const initialState of ['building','packaged']) test(`explicit receipt sealing from ${initialState} requires hashed check reports`,async ()=> {
    const f=await fixture();try {
        const root=f.directories[0],receiptPath=join(root,'receipt.json'),receipt=JSON.parse(await readFile(receiptPath,'utf8'));
        receipt.state=initialState;await writeFile(receiptPath,JSON.stringify(receipt));
        const reportDir=join(f.root,'checks');await mkdir(reportDir);await writeFile(join(reportDir,'report.json'),'actual check');
        const file={path:'report.json',bytes:12,sha256:sha256('actual check')};
        await writeFile(join(reportDir,'checks.json'),JSON.stringify({schema:1,target:receipt.target.id,sourceSha:context.sourceSha,checks:TARGETS[receipt.target.id].requiredChecks.map(name=>({name,status:'passed',evidence:file.path})),evidenceFiles:[file]}));
        const sealed=await copyCheckReports(receiptPath,[join(reportDir,'checks.json')]);
        assert.equal(sealed.state,'verified');assert.equal(sealed.checks.length,TARGETS[receipt.target.id].requiredChecks.length);
        assert.deepEqual(await verifyTargetDirectory(root,context),sealed);
        await assert.rejects(copyCheckReports(receiptPath,[join(reportDir,'checks.json')]),/fresh/);
    } finally {await f.cleanup();}
});
test('empty reports cannot turn a packaged receipt into a verified acceptance claim',async ()=> {
    const f=await fixture();try {
        const path=join(f.directories[0],'receipt.json');
        await assert.rejects(copyCheckReports(path,[]),/Missing required/);
        assert.equal(JSON.parse(await readFile(path,'utf8')).state,'packaged');
        await verifyTargetDirectory(f.directories[0],context);
    } finally {await f.cleanup();}
});

function fakeApi({failUploadAt=0,published=false,wrongTag=false,resetMissingDraftTag=false}={}) {
    const state={releases:[],assets:[],uploads:0,patches:[],gets:[],failed:false};
    let next=1;
    const api={
        async json(method,path,body) {
            state.gets.push({method,path});
            if (path.includes('/git/ref/')) return {object:{type:'commit',sha:wrongTag ? 'b'.repeat(40) : context.sourceSha}};
            if (method === 'GET' && /\/releases\?/.test(path)) return path.includes('page=1') ? state.releases : [];
            if (method === 'POST' && path.endsWith('/releases')) {const release={...body,id:next++,draft:!published,upload_url:'https://uploads.github.com/repos/ROYIANS/momoki/releases/1/assets{?name,label}',html_url:'https://github.com/ROYIANS/momoki/releases/tag/desktop-v0.1.0'};state.releases.push(release);return clone(release);}
            if (method === 'GET' && path.includes('/assets?')) return state.assets.map(asset=>({...asset,url:`https://api.github.com/repos/ROYIANS/momoki/releases/assets/${asset.id}`}));
            if (method === 'GET' && /\/releases\/\d+$/.test(path)) return clone(state.releases[0]);
            if (method === 'PATCH') {
                state.patches.push(body);Object.assign(state.releases[0],body);
                if (resetMissingDraftTag && !Object.hasOwn(body,'tag_name')) state.releases[0].tag_name='untagged-observed-fixture';
                return clone(state.releases[0]);
            }
            throw new Error(`Unexpected fake API ${method} ${path}`);
        },
        async upload(url,path) {
            state.uploads++;
            if (state.uploads === failUploadAt && !state.failed) {state.failed=true;throw new Error('injected interruption');}
            const data=await readFile(path),name=new URL(url).searchParams.get('name');
            state.assets.push({id:next++,name,state:'uploaded',size:data.length,digest:`sha256:${sha256(data)}`});
        },
        async download() {throw new Error('Digest-present fake must not download');},
    };return {api,state};
}
test('completion explicitly retains tag and source when a draft PATCH would reset an omitted tag',async ()=> {
    const f=await fixture();try {
        await collectArtifacts(f.directories,f.output,context,f.selections);
        const {api,state}=fakeApi({resetMissingDraftTag:true});
        const result=await publishDraft(f.output,{api,context});
        assert.equal(result.assets.length,7);assert.equal(state.assets.length,7);assert.equal(state.releases.length,1);
        assert.equal(state.releases[0].tag_name,context.tag);assert.equal(state.releases[0].target_commitish,context.sourceSha);
        assert.equal(state.patches.length,1);
        const patch=state.patches[0];
        assert.equal(patch.tag_name,context.tag);assert.equal(patch.target_commitish,context.sourceSha);
        assert.equal(patch.draft,true);assert.equal(patch.prerelease,true);assert.equal(patch.make_latest,'false');
        assert.match(patch.body,/UPLOAD COMPLETE/);assert.doesNotMatch(patch.body,/UPLOAD INCOMPLETE/);
        const marker=JSON.parse(patch.body.match(/<!-- momoki-desktop-release:(.*?) -->/)[1]);
        assert.equal(marker.tag,context.tag);assert.equal(marker.sourceSha,context.sourceSha);
        assert.equal(marker.payloadDigest,result.payloadDigest);assert.equal(marker.status,'complete');
        const assets=clone(state.assets),uploads=state.uploads;
        const retry=await publishDraft(f.output,{api,context});
        assert.equal(retry.id,result.id);assert.equal(retry.payloadDigest,result.payloadDigest);
        assert.equal(state.uploads,uploads);assert.deepEqual(state.assets,assets);
        assert.ok(state.gets.every(call=>call.method !== 'DELETE'));
    } finally {await f.cleanup();}
});
for (const [name,mutate,message] of [
    ['wrong tag',release=>release.tag_name='untagged-returned-fixture',/wrong mode/],
    ['published mode',release=>release.draft=false,/wrong mode/],
    ['non-prerelease mode',release=>release.prerelease=false,/wrong mode/],
    ['immutable mode',release=>release.immutable=true,/immutable/],
    ['missing ownership',release=>release.body='UPLOAD COMPLETE',/unowned/],
    ['changed ownership source',release=>release.body=release.body.replaceAll(context.sourceSha,'b'.repeat(40)),/ownership\/source\/payload conflict/],
]) test(`completion still rejects ${name} in the final PATCH response`,async ()=> {
    const f=await fixture();try {
        await collectArtifacts(f.directories,f.output,context,f.selections);
        const {api,state}=fakeApi({resetMissingDraftTag:true}),original=api.json;
        api.json=async (method,path,body)=> {
            const response=await original(method,path,body);
            if (method === 'PATCH') mutate(response);
            return response;
        };
        await assert.rejects(publishDraft(f.output,{api,context}),message);
        assert.equal(state.patches.length,1);assert.equal(state.uploads,7);assert.equal(state.assets.length,7);
        assert.ok(state.gets.every(call=>call.method !== 'DELETE'));
    } finally {await f.cleanup();}
});
test('publisher leaves an incomplete owned draft on interruption and exact retry skips original bytes',async ()=> {
    const f=await fixture();try {
        await collectArtifacts(f.directories,f.output,context,f.selections);const {api,state}=fakeApi({failUploadAt:3});
        await assert.rejects(publishDraft(f.output,{api,context}),/interruption/);
        assert.match(state.releases[0].body,/"status":"incomplete"/);assert.equal(state.patches.length,0);assert.equal(state.assets.length,2);
        const result=await publishDraft(f.output,{api,context});assert.equal(result.assets.length,7);assert.equal(state.assets.length,7);assert.match(state.releases[0].body,/"status":"complete"/);
        assert.match(state.releases[0].body,/Packaging-only delivery/);assert.match(state.releases[0].body,/owner performs functional testing before public publication/);
        assert.doesNotMatch(state.releases[0].body,/smoke proves|smoke launches|All software tests passed/);
        const count=state.uploads;await publishDraft(f.output,{api,context});assert.equal(state.uploads,count);
        assert.ok(state.patches.every(patch=>patch.draft === true && patch.prerelease === true));
    } finally {await f.cleanup();}
});
test('collector-only retry reconstructs identical metadata and resumes original draft payload',async ()=> {
    const f=await fixture();try {
        await collectArtifacts(f.directories,f.output,context,f.selections);
        const {api,state}=fakeApi({failUploadAt:3});await assert.rejects(publishDraft(f.output,{api,context}));
        const retry=join(f.root,'retry'),retryContext={...context,attempt:3};
        await collectArtifacts(f.directories,retry,retryContext,f.selections);
        assert.equal(await readFile(join(f.output,'release-manifest.json'),'utf8'),await readFile(join(retry,'release-manifest.json'),'utf8'));
        const result=await publishDraft(retry,{api,context:retryContext});assert.equal(result.assets.length,7);assert.match(state.releases[0].body,/"status":"complete"/);
    } finally {await f.cleanup();}
});
for (const option of [{published:true},{wrongTag:true}]) test(`publisher refuses ${JSON.stringify(option)}`,async ()=> {
    const f=await fixture();try {await collectArtifacts(f.directories,f.output,context,f.selections);const {api,state}=fakeApi(option);await assert.rejects(publishDraft(f.output,{api,context}));assert.equal(state.assets.length,0);} finally {await f.cleanup();}
});
test('publisher rejects published/unowned/duplicate drafts and unknown/mutated asset bytes',async ()=> {
    for (const change of [state=>state.releases[0].draft=false,state=>state.releases[0].body='unowned',state=>state.releases.push({...state.releases[0],id:99}),state=>state.assets.push({id:99,name:'unknown',state:'uploaded',size:1,digest:'sha256:'+sha256('x')}),state=>state.assets[0].digest='sha256:'+sha256('changed')]) {
        const f=await fixture();try {
            await collectArtifacts(f.directories,f.output,context,f.selections);const {api,state}=fakeApi();await publishDraft(f.output,{api,context});change(state);
            const uploads=state.uploads,patches=state.patches.length;await assert.rejects(publishDraft(f.output,{api,context}));assert.equal(state.uploads,uploads);assert.equal(state.patches.length,patches);
        } finally {await f.cleanup();}
    }
});
test('manual context cannot publish a draft even with a tag-like ref',async ()=> {
    const f=await fixture();try {await collectArtifacts(f.directories,f.output,context,f.selections);await assert.rejects(publishDraft(f.output,{api:fakeApi().api,context:{...context,event:'workflow_dispatch',mode:'build-only'}}),/Only desktop/);} finally {await f.cleanup();}
});
test('publisher rejects a manifest from a future attempt before GitHub requests',async ()=> {
    const f=await fixture();try {
        await collectArtifacts(f.directories,f.output,context,f.selections);
        const path=join(f.output,'release-manifest.json'),manifest=JSON.parse(await readFile(path,'utf8'));
        manifest.context.attempt=context.attempt+1;await writeFile(path,JSON.stringify(manifest));
        const {api,state}=fakeApi();await assert.rejects(publishDraft(f.output,{api,context}),/future attempt/);
        assert.equal(state.gets.length,0);assert.equal(state.uploads,0);
    } finally {await f.cleanup();}
});
test('publisher reconciles an upload that completed before its reply was lost',async ()=> {
    const f=await fixture();try {
        await collectArtifacts(f.directories,f.output,context,f.selections);const {api,state}=fakeApi();
        const upload=api.upload;let interrupted=false;
        api.upload=async (...args)=>{await upload(...args);if (!interrupted) {interrupted=true;throw new Error('lost reply after server commit');}};
        await publishDraft(f.output,{api,context});assert.equal(state.assets.length,7);assert.equal(state.uploads,7);
    } finally {await f.cleanup();}
});
test('publisher uses authenticated pagination to discover a page-two draft',async ()=> {
    const f=await fixture();try {
        await collectArtifacts(f.directories,f.output,context,f.selections);const {api,state}=fakeApi();await publishDraft(f.output,{api,context});
        const original=api.json;api.json=async (method,path,body)=> {
            if (method === 'GET' && /\/releases\?/.test(path)) {
                const page=new URL(path,'https://api.github.com').searchParams.get('page');
                return page === '1' ? Array.from({length:100},(_,index)=>({id:index+100,tag_name:'other'})) : state.releases;
            }
            return original(method,path,body);
        };
        const uploads=state.uploads;await publishDraft(f.output,{api,context});assert.equal(state.uploads,uploads);assert.equal(state.releases.length,1);
    } finally {await f.cleanup();}
});
test('starter placeholders cause a visible incomplete failure and are never deleted',async ()=> {
    const f=await fixture();try {
        await collectArtifacts(f.directories,f.output,context,f.selections);const {api,state}=fakeApi();
        api.upload=async url=> {state.assets.push({id:99,name:new URL(url).searchParams.get('name'),state:'starter',size:0});throw new Error('starter placeholder');};
        await assert.rejects(publishDraft(f.output,{api,context}),/incomplete/);assert.equal(state.patches.length,0);assert.equal(state.assets[0].state,'starter');
        assert.match(state.releases[0].body,/"status":"incomplete"/);assert.ok(state.gets.every(call=>call.method !== 'DELETE'));
    } finally {await f.cleanup();}
});
test('asset hashes are downloaded and independently computed when API digest is absent',async ()=> {
    const f=await fixture();try {
        await collectArtifacts(f.directories,f.output,context,f.selections);const {api,state}=fakeApi();await publishDraft(f.output,{api,context});
        for (const asset of state.assets) delete asset.digest;
        let reads=0;api.download=async url=>{reads++;const id=Number(url.split('/').at(-1)),asset=state.assets.find(file=>file.id === id);return readFile(join(f.output,asset.name));};
        await publishDraft(f.output,{api,context});assert.ok(reads >= 7);assert.equal(state.assets.length,7);
        api.download=async ()=>Buffer.from('wrong remote bytes');await assert.rejects(publishDraft(f.output,{api,context}),/differs/);
    } finally {await f.cleanup();}
});
test('artifact selection uses exact source/run attempts and rejects ambiguous/expired payloads',async ()=> {
    const rows=Object.keys(TARGETS).map((target,index)=>({id:index+1,name:`desktop-${target}-42-1`,expired:false,workflow_run:{head_sha:context.sourceSha}}));
    const api={json:async ()=>({artifacts:rows})};assert.equal((await selectArtifacts(api,context)).length,4);
    rows.push({...rows[0],id:99});await assert.rejects(selectArtifacts(api,context),/Ambiguous/);rows.pop();rows[0].expired=true;await assert.rejects(selectArtifacts(api,context),/Expired/);
});
test('workflow gates publisher to desktop tags and pins all external actions',async ()=> {
    const path=resolve(import.meta.dirname,'../../../.github/workflows/desktop-release.yml'),workflow=await readFile(path,'utf8');
    assert.match(workflow,/branches: \[codex\/desktop-release-pipeline\]/);assert.match(workflow,/tags: \['desktop-v\*'\]/);
    assert.match(workflow,/if: github.event_name == 'push' && startsWith\(github.ref, 'refs\/tags\/desktop-v'\)/);
    assert.equal([...workflow.matchAll(/contents: write/g)].length,1);
    for (const match of workflow.matchAll(/uses: ([^\s]+)/g)) assert.match(match[1],/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
    assert.match(workflow,/matrix: \$\{\{ fromJSON\(needs.prepare.outputs.matrix\) \}\}/);
    assert.match(workflow,/build:\n\s+needs: prepare/);assert.match(workflow,/collect:\n\s+needs: build/);
    assert.doesNotMatch(workflow,/pull_request:|quality:\n|release-native-checks|release-product-smoke|finalize-release|prepare-native-test-probe|pnpm (?:test|lint|quality)|cargo (?:test|clippy|fmt)|tauri-driver|webkit2gtk-driver|xvfb/);
    assert.doesNotMatch(workflow,/pull_request_target|--clobber|draft: false|releaseDraft: false/);
});
