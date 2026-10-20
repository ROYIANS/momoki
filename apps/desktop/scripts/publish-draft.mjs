import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fileDigest,regularFile,verifyReleaseDirectory} from './release-artifacts.mjs';
import {parseOptions,runContext,sha256} from './release-policy.mjs';

const API='https://api.github.com';
export function githubApi(token,fetchImpl=globalThis.fetch) {
    if (!token) throw new Error('GITHUB_TOKEN is required');
    async function request(method,path,body,raw=false,byteLength) {
        const url=new URL(path,API);
        if (!['api.github.com','uploads.github.com'].includes(url.hostname) || url.protocol !== 'https:') throw new Error('Untrusted GitHub API URL');
        const response=await fetchImpl(url,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(raw ? {'Content-Type':'application/octet-stream','Content-Length':String(byteLength)} : body ? {'Content-Type':'application/json'} : {})},body:raw ? body : body ? JSON.stringify(body) : undefined,...(raw ? {duplex:'half'} : {})});
        if (!response.ok) throw new Error(`GitHub ${method} ${url.pathname} failed (${response.status})`);
        if (raw === 'download') return Buffer.from(await response.arrayBuffer());
        if (response.status === 204) return null;
        return response.json();
    }
    return {
        json:(method,path,body)=>request(method,path,body),
        upload:async (url,path)=> {
            const file=await open(path,'r');
            let body;
            try {
                const {size}=await file.stat();
                body=file.createReadStream();
                return await request('POST',url,body,true,size);
            } finally {
                body?.destroy();
                await file.close();
            }
        },
        download:async path=> {
            const url=new URL(path,API);
            if (url.hostname !== 'api.github.com') throw new Error('Untrusted asset API');
            const response=await fetchImpl(url,{headers:{Authorization:`Bearer ${token}`,Accept:'application/octet-stream','X-GitHub-Api-Version':'2022-11-28'}});
            if (!response.ok) throw new Error(`GitHub asset download failed (${response.status})`);
            return Buffer.from(await response.arrayBuffer());
        },
    };
}
async function allPages(api,path) {
    const rows=[];
    for (let page=1;page<=100;page++) {
        const next=await api.json('GET',`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
        if (!Array.isArray(next)) throw new Error('Malformed GitHub pagination');
        rows.push(...next);if (next.length < 100) return rows;
    }
    throw new Error('GitHub pagination bound exceeded');
}
function marker(manifest,payloadDigest,status) {
    return `<!-- momoki-desktop-release:${JSON.stringify({schema:1,repository:manifest.context.repository,workflow:manifest.context.workflow,tag:manifest.context.tag,sourceSha:manifest.context.sourceSha,payloadDigest,status})} -->`;
}
function owned(release,manifest,digest) {
    if (release.draft !== true || release.prerelease !== true || release.immutable === true || release.tag_name !== manifest.context.tag) throw new Error('Existing release is published/immutable or has wrong mode');
    const matches=[...(release.body ?? '').matchAll(/<!-- momoki-desktop-release:(.*?) -->/g)];
    if (matches.length !== 1) throw new Error('Draft is unowned or has duplicate ownership');
    const value=JSON.parse(matches[0][1]);
    if (!['incomplete','complete'].includes(value.status) || marker(manifest,digest,value.status) !== matches[0][0]) throw new Error('Draft ownership/source/payload conflict');
}
async function checkedTag(api,manifest) {
    const path=`/repos/${manifest.context.repository}/git/ref/tags/${encodeURIComponent(manifest.context.tag)}`;
    let object=(await api.json('GET',path)).object;
    for (let depth=0;object?.type === 'tag' && depth<8;depth++) object=(await api.json('GET',`/repos/${manifest.context.repository}/git/tags/${object.sha}`)).object;
    if (object?.type !== 'commit' || object.sha !== manifest.context.sourceSha) throw new Error('Existing remote tag does not resolve to verified source');
}
async function assetMatches(api,asset,file) {
    if (asset.state !== 'uploaded' || asset.size !== file.bytes) throw new Error('Existing asset is incomplete or has different size');
    const digest=asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : sha256(await api.download(asset.url));
    if (digest !== file.sha256) throw new Error('Existing asset payload differs; original immutable assets or a new version are required');
}
export async function publishDraft(directory,{api,context=runContext()}={}) {
    const manifest=await verifyReleaseDirectory(directory);
    if (context.mode !== 'draft' || context.event !== 'push' || manifest.context.mode !== 'draft') throw new Error('Only desktop version-tag pushes may create drafts');
    for (const key of ['repository','workflow','sourceSha','tag','runId']) if (context[key] !== manifest.context[key]) throw new Error('Publisher context differs from collector');
    if (!Number.isSafeInteger(manifest.context.attempt) || manifest.context.attempt < 1 || manifest.context.attempt > context.attempt) throw new Error('Release manifest comes from an invalid/future attempt');
    if (!api) throw new Error('Explicit GitHub API boundary required');
    const repo=`/repos/${manifest.context.repository}`;
    await checkedTag(api,manifest);
    const files=[];
    for (const name of [...manifest.installers.map(file=>file.name),'SHA256SUMS','release-manifest.json'].sort()) files.push({name,...await fileDigest(await regularFile(directory,name))});
    const digest=sha256(JSON.stringify(files));
    const releases=(await allPages(api,`${repo}/releases`)).filter(release=>release.tag_name === manifest.context.tag);
    if (releases.length > 1) throw new Error('Multiple releases match the desktop tag');
    const notes=`Momoki ${manifest.context.version} — test distribution\n\n**UPLOAD INCOMPLETE. Do not publish until the workflow finishes and the ownership marker says complete.**\n\nSource: ${manifest.context.sourceSha}\n\n${manifest.limitations.map(line=>`- ${line}`).join('\n')}\n\nmacOS: ad-hoc signed, not notarized; allow the app through Privacy & Security if macOS blocks it. Windows: unsigned; review the publisher warning before allowing installation. WebView2 bootstrapper needs internet if the runtime is absent. Linux: Ubuntu 22.04 x64 baseline; install DEB dependencies or required AppImage/FUSE runtime.\n\nAll packages share the normal React/Agent product and SQLite/managed files. No updater or synchronization is claimed.\n`;
    let release=releases[0];
    if (release) owned(release,manifest,digest);
    else release=await api.json('POST',`${repo}/releases`,{tag_name:manifest.context.tag,target_commitish:manifest.context.sourceSha,name:`Momoki ${manifest.context.version} (test)`,body:notes+'\n'+marker(manifest,digest,'incomplete'),draft:true,prerelease:true,make_latest:'false'});
    owned(release,manifest,digest);
    const getOwned=async ()=> {const current=await api.json('GET',`${repo}/releases/${release.id}`);owned(current,manifest,digest);return current;};
    const getAssets=()=>allPages(api,`${repo}/releases/${release.id}/assets`);
    let assets=await getAssets();
    const expectedNames=new Set(files.map(file=>file.name));
    if (assets.some(asset=>!expectedNames.has(asset.name)) || new Set(assets.map(asset=>asset.name)).size !== assets.length) throw new Error('Unknown/duplicate draft assets; no overwrite or deletion performed');
    for (const file of files) {
        await getOwned();
        const existing=assets.find(asset=>asset.name === file.name);
        if (existing) {await assetMatches(api,existing,file);continue;}
        const uploadBase=release.upload_url.replace(/\{.*$/,'');
        const uploadUrl=new URL(uploadBase);uploadUrl.searchParams.set('name',file.name);
        try {await api.upload(uploadUrl.toString(),await regularFile(directory,file.name));}
        catch(error) {
            // Upload might have completed despite a lost reply. Reconcile only
            // exact uploaded bytes; starter placeholders remain for owner review.
            await getOwned();assets=await getAssets();
            const reconciled=assets.filter(asset=>asset.name === file.name);
            if (reconciled.length !== 1) throw error;
            await assetMatches(api,reconciled[0],file);
        }
        assets=await getAssets();
    }
    await checkedTag(api,manifest);await getOwned();assets=await getAssets();
    if (assets.length !== files.length || new Set(assets.map(asset=>asset.name)).size !== files.length || assets.some(asset=>!expectedNames.has(asset.name))) throw new Error('Remote asset closure is incomplete or unexpected');
    for (const file of files) await assetMatches(api,assets.find(asset=>asset.name === file.name),file);
    // GitHub REST has no draft CAS. This final read reduces accidental mutation
    // risk; the owner must not publish concurrently with an active upload.
    await getOwned();
    const completeNotes=notes.replace('**UPLOAD INCOMPLETE. Do not publish until the workflow finishes and the ownership marker says complete.**','**UPLOAD COMPLETE. The owner may review and publish this test distribution.**');
    release=await api.json('PATCH',`${repo}/releases/${release.id}`,{tag_name:manifest.context.tag,target_commitish:manifest.context.sourceSha,body:completeNotes+'\n'+marker(manifest,digest,'complete'),draft:true,prerelease:true,make_latest:'false'});
    owned(release,manifest,digest);return {id:release.id,html_url:release.html_url,payloadDigest:digest,assets:files};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const options=parseOptions(process.argv.slice(2),['--directory']);
    if (!options['--directory']) throw new Error('Provide --directory');
    const result=await publishDraft(resolve(options['--directory']),{api:githubApi(process.env.GITHUB_TOKEN)});
    console.log(JSON.stringify(result,null,2));
}
