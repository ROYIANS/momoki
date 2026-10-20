import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {releaseSourceFiles,releaseSourceHashes} from './release-source-hashes.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
async function repository() {
    const root=await mkdtemp(join(tmpdir(),'momoki-source-list-'));
    const git=(args,options={})=>execFileSync('git',args,{cwd:root,encoding:'utf8',...options});
    git(['init','--quiet']);
    const blob=git(['hash-object','-w','--stdin'],{input:''}).trim();
    return {root,git,index(paths) {git(['update-index','-z','--index-info'],{input:paths.map(path=>`100644 ${blob}\t${path}\0`).join('')});},async put(path,bytes) {await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),bytes);},async cleanup() {await rm(root,{recursive:true,force:true});}};
}
function referenceFiles(fixture) {
    // This reproduces the original selection for parity, with a test-only
    // buffer override to inspect fixtures larger than the former 1 MiB cap.
    return fixture.git(['ls-files','-z'],{maxBuffer:8*1024*1024}).split('\0').filter(path=>path && !path.startsWith('.trellis/') && !path.startsWith('.agents/') && !path.startsWith('.codex/')).sort();
}

test('source snapshot preserves exact root-only exclusions, path text, sorting and changed bytes',async ()=> {
    const f=await repository();
    try {
        const eligible=['z-last.txt','packages/studio/src/素材 🦋.txt','packages/studio/src/a name\nwith\ttabs.txt','packages/studio/src/[literal]*.txt','packages/studio/src/.trellis/kept.txt','.trellis-extra/kept.txt','.agents-extra/kept.txt','.codex-extra/kept.txt','A-first.txt','__proto__','constructor'];
        const excluded=['.trellis/tasks/excluded.txt','.agents/skills/excluded.txt','.codex/agents/excluded.txt'];
        f.index([...eligible,...excluded]);
        for (const path of eligible) await f.put(path,`source bytes: ${path}`);
        // Excluded entries deliberately have no worktree files: hashing them
        // would fail, rather than merely producing the same expected map.
        const files=await releaseSourceFiles(f.root);
        assert.deepEqual(files,referenceFiles(f));assert.deepEqual(files,[...eligible].sort());
        const before=await releaseSourceHashes(f.root);
        assert.deepEqual(before,Object.fromEntries([...eligible].sort().map(path=>[path,hash(`source bytes: ${path}`)])));
        assert.deepEqual(await releaseSourceHashes(f.root),before);
        await f.put('A-first.txt','changed eligible bytes');
        const after=await releaseSourceHashes(f.root);
        assert.equal(after['A-first.txt'],hash('changed eligible bytes'));
        assert.deepEqual(Object.keys(after),Object.keys(before));
        assert.deepEqual(Object.keys(before).filter(path=>before[path] !== after[path]),['A-first.txt']);
    } finally {await f.cleanup();}
});

test('root metadata names as files and nested metadata trees remain eligible',async ()=> {
    const f=await repository();
    try {
        const files=['.trellis','.agents','.codex','packages/studio/src/.agents/keep.txt','packages/studio/src/.codex/keep.txt'];f.index(files);
        for (const path of files) await f.put(path,path);
        assert.deepEqual(await releaseSourceFiles(f.root),referenceFiles(f));
        assert.deepEqual(Object.keys(await releaseSourceHashes(f.root)),[...files].sort());
    } finally {await f.cleanup();}
});

test('excluded Git metadata above the old stdout limit never enters source hashing',async ()=> {
    const f=await repository();
    try {
        const excluded=Array.from({length:9000},(_,index)=>`.trellis/tasks/archive/${index.toString().padStart(5,'0')}/${'e'.repeat(125)}.json`);
        f.index([...excluded,'packages/studio/src/real.txt']);await f.put('packages/studio/src/real.txt','eligible source');
        const all=f.git(['ls-files','-z'],{maxBuffer:8*1024*1024});
        assert.ok(Buffer.byteLength(all)>1024*1024);
        assert.throws(()=>f.git(['ls-files','-z']),error=>error.code === 'ENOBUFS');
        assert.deepEqual(await releaseSourceFiles(f.root),referenceFiles(f));
        assert.deepEqual(await releaseSourceHashes(f.root),{'packages/studio/src/real.txt':hash('eligible source')});
    } finally {await f.cleanup();}
});

test('eligible NUL-framed UTF8 source paths above 1 MiB are all streamed without a cap',async ()=> {
    const f=await repository();
    try {
        const eligible=Array.from({length:7000},(_,index)=>`packages/studio/src/素材 ${index.toString().padStart(5,'0')}-${'s'.repeat(145)}.txt`).reverse();
        f.index(eligible);
        assert.ok(Buffer.byteLength(eligible.join('\0')+'\0')>1024*1024);
        assert.deepEqual(await releaseSourceFiles(f.root),[...eligible].sort());
        assert.deepEqual(await releaseSourceFiles(f.root),referenceFiles(f));
    } finally {await f.cleanup();}
});

test('failed real Git enumeration and missing tracked file reject rather than return partial proof',async ()=> {
    const outside=await mkdtemp(join(tmpdir(),'momoki-source-no-git-'));
    try {await assert.rejects(releaseSourceHashes(outside),/Git tracked source enumeration failed.*not a git repository/s);} finally {await rm(outside,{recursive:true,force:true});}
    const f=await repository();
    try {
        f.index(['a-present.txt','z-missing.txt']);await f.put('a-present.txt','present');
        await assert.rejects(releaseSourceHashes(f.root),error=>error.code === 'ENOENT');
    } finally {await f.cleanup();}
});
