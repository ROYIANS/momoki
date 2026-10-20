import {createHash} from 'node:crypto';

export const WORKFLOW='.github/workflows/desktop-release.yml';
const BOOTSTRAP_BRANCH='codex/desktop-release-pipeline';
export const PRODUCT=Object.freeze({name:'Momoki',identifier:'design.tulai.momoki',binary:'momoki',profile:'normal',storage:'sqlite',features:['product-sqlite']});
const common=['native-tests','shared-storage-all'];
export const TARGETS=Object.freeze({
    'macos-arm64':{id:'macos-arm64',platform:'darwin',arch:'arm64',runner:'macos-14',triple:'aarch64-apple-darwin',bundles:['app','dmg'],formats:['dmg'],signing:'ad-hoc',requiredChecks:[...common,'artifact-integrity','process-launch']},
    'macos-x64':{id:'macos-x64',platform:'darwin',arch:'x64',runner:'macos-15-intel',triple:'x86_64-apple-darwin',bundles:['app','dmg'],formats:['dmg'],signing:'ad-hoc',requiredChecks:[...common,'artifact-integrity','process-launch']},
    'windows-x64':{id:'windows-x64',platform:'win32',arch:'x64',runner:'windows-2022',triple:'x86_64-pc-windows-msvc',bundles:['nsis'],formats:['exe'],signing:'unsigned',requiredChecks:[...common,'artifact-integrity','product-ui-storage']},
    'linux-x64':{id:'linux-x64',platform:'linux',arch:'x64',runner:'ubuntu-22.04',triple:'x86_64-unknown-linux-gnu',bundles:['appimage','deb'],formats:['appimage','deb'],signing:'none',requiredChecks:[...common,'artifact-integrity-appimage','artifact-integrity-deb','appimage-product-ui-storage','deb-product-ui-storage']},
});
export function getTarget(id) {
    if (!Object.hasOwn(TARGETS,id)) throw new Error(`Unknown release target: ${id}`);
    return TARGETS[id];
}
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const policyHash=()=>sha256(JSON.stringify({schema:1,workflow:WORKFLOW,product:PRODUCT,targets:TARGETS}));
export function assetName(target,version,format) {
    const policy=getTarget(target);
    if (!/^\d+\.\d+\.\d+$/.test(version) || !policy.formats.includes(format)) throw new Error('Invalid version or bundle format');
    const suffix={dmg:'.dmg',exe:'_setup.exe',appimage:'.AppImage',deb:'.deb'}[format];
    return `Momoki_${version}_${target.replaceAll('-','_')}${suffix}`;
}
export function runContext(env=process.env) {
    const sourceSha=env.GITHUB_SHA ?? env.MOMOKI_SOURCE_SHA;
    const repository=env.GITHUB_REPOSITORY ?? 'ROYIANS/momoki';
    const event=env.GITHUB_EVENT_NAME ?? 'local';
    const ref=env.GITHUB_REF ?? '';
    let mode='build-only',tag=null;
    if (event === 'push' && ref.startsWith('refs/tags/desktop-v')) {mode='draft';tag=ref.slice(10);}
    else if (event === 'push' && ref !== `refs/heads/${BOOTSTRAP_BRANCH}`) throw new Error('Only the exact bootstrap branch or desktop tag is accepted');
    else if (!['push','workflow_dispatch','local'].includes(event)) throw new Error('Unsupported release event');
    if (tag && !/^desktop-v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Malformed desktop tag');
    if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Missing immutable source/repository identity');
    const runId=env.GITHUB_RUN_ID ?? 'local';
    const attempt=Number(env.GITHUB_RUN_ATTEMPT ?? '1');
    if (!/^(?:local|\d+)$/.test(runId) || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Invalid run identity');
    return {repository,workflow:WORKFLOW,sourceSha,event,mode,tag,runId,attempt};
}

export function parseOptions(argv,allowed,multiple=[]) {
    const result={};
    for (let index=0;index<argv.length;index+=2) {
        const key=argv[index],value=argv[index+1];
        if (!allowed.includes(key) || !value || value.startsWith('--')) throw new Error(`Expected named option: ${allowed.join(', ')}`);
        if (multiple.includes(key)) (result[key] ??= []).push(value);
        else if (Object.hasOwn(result,key)) throw new Error(`Duplicate option: ${key}`);
        else result[key]=value;
    }
    return result;
}
