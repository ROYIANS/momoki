import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {cp,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {checkRegistryCompatibility,validateRegistryCompatibility} from './storage-compatibility.mjs';

const history=new URL('../src-tauri/src/full_product_store/registry-history/',import.meta.url);
const catalog=JSON.parse(await readFile(new URL('catalog.json',history),'utf8'));
const current=await readFile(new URL('../../../packages/studio/src/platform/storage/schema.json',import.meta.url));
const snapshots=Object.fromEntries(await Promise.all(catalog.registries.map(async ({file})=>[file,await readFile(new URL(file,history))])));
const clone=value=>JSON.parse(JSON.stringify(value));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const newTable=()=>({keyPath:'id',scope:'content',indexes:[{name:'projectId',keyPaths:['projectId'],unique:false}]});

test('actual release prepare accepts a new table without catalog edits and rejects changed old definitions before matrix output',async ()=> {
    const fixture=await mkdtemp(join(tmpdir(),'momoki-registry-release-'));
    try {
        const files=['package.json','apps/desktop/package.json','apps/desktop/src-tauri/Cargo.toml','apps/desktop/src-tauri/tauri.conf.json',
            'apps/desktop/media/decoder-lock.json','apps/desktop/media/source-lock.json','packages/studio/src/platform/storage/schema.json'];
        for (const file of files) {
            await mkdir(dirname(join(fixture,file)),{recursive:true});
            await cp(new URL(`../../../${file}`,import.meta.url),join(fixture,file));
        }
        await cp(new URL('./',import.meta.url),join(fixture,'apps/desktop/scripts'),{recursive:true});
        await cp(history,join(fixture,'apps/desktop/src-tauri/src/full_product_store/registry-history'),{recursive:true});
        const output=join(fixture,'github-output'),version=JSON.parse(await readFile(join(fixture,'package.json'),'utf8')).version;
        const prepare=()=>spawnSync(process.execPath,[join(fixture,'apps/desktop/scripts/prepare-release.mjs')],{
            cwd:fixture,encoding:'utf8',env:{...process.env,GITHUB_EVENT_NAME:'push',GITHUB_REF:`refs/tags/desktop-v${version}`,
                GITHUB_SHA:'a'.repeat(40),GITHUB_REPOSITORY:'ROYIANS/momoki',GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:output},
        });
        const next=JSON.parse(current);next.tables.nextReleaseTable=newTable();
        await writeFile(join(fixture,'packages/studio/src/platform/storage/schema.json'),JSON.stringify(next));
        const valid=prepare();assert.equal(valid.status,0,valid.stderr);
        assert.match(await readFile(output,'utf8'),/^matrix=.+\nversion=/);
        await writeFile(output,'');
        next.tables.projects.keyPath='differentKey';
        await writeFile(join(fixture,'packages/studio/src/platform/storage/schema.json'),JSON.stringify(next));
        const invalid=prepare();assert.equal(invalid.status,1);
        assert.match(invalid.stderr,/released table definition changed/);
        assert.equal(await readFile(output,'utf8'),'');
    } finally {await rm(fixture,{recursive:true,force:true});}
});

test('every legacy shipped registry keeps its exact original identity for snapshot bootstrap',async ()=> {
    const released={
        'desktop-v0.1.0':'a3405d1995059418dc36f69a9ff547c53ebe1c500a4aa64da642be4c6585af85',
        'desktop-v0.1.1':'a3405d1995059418dc36f69a9ff547c53ebe1c500a4aa64da642be4c6585af85',
        'desktop-v0.1.2':'3c897189ef6f71517c55c86b5d24b7f9cd0e1cfd88d1b916b46345662187eff0',
        'desktop-v0.1.3':'3c897189ef6f71517c55c86b5d24b7f9cd0e1cfd88d1b916b46345662187eff0',
        'desktop-v0.1.4':'bb3a9483a600127ff43aeab1062830b616c1ad5b39b162dfa9520ab792154d52',
    };
    for (const [release,identity] of Object.entries(released)) {
        const entry=catalog.registries.find(entry=>entry.releases.includes(release));
        assert.ok(entry,`Shipped registry removed: ${release}`);
        assert.equal(entry.sha256,identity);
        assert.equal(hash(snapshots[entry.file]),identity);
    }
    const result=await checkRegistryCompatibility();
    assert.ok(result.releases.includes('desktop-v0.1.0'));
});

test('successive 54 and 55 table targets are additive without new hashes, snapshots or manual recipes',()=> {
    const unchangedCatalog=JSON.stringify(catalog),next=JSON.parse(current);
    for (const table of ['futureTable54','futureTable55']) {
        next.tables[table]=newTable();
        const bytes=Buffer.from(JSON.stringify(next));
        const result=validateRegistryCompatibility(bytes,catalog,snapshots);
        assert.equal(result.target,hash(bytes));
        assert.equal(result.registries,3);
    }
    assert.equal(JSON.stringify(catalog),unchangedCatalog);
});

test('formatting-only current changes do not require manual migration metadata',()=> {
    const bytes=Buffer.concat([current,Buffer.from('\n')]);
    assert.equal(validateRegistryCompatibility(bytes,catalog,snapshots).target,hash(bytes));
});

test('historical snapshot edits, omitted files and orphan snapshots are rejected',()=> {
    const first=catalog.registries[0].file;
    assert.throws(()=>validateRegistryCompatibility(current,catalog,{...snapshots,[first]:Buffer.concat([snapshots[first],Buffer.from('\n')])}),/checksum mismatch/);
    const omitted={...snapshots};delete omitted[first];
    assert.throws(()=>validateRegistryCompatibility(current,catalog,omitted),/checksum mismatch/);
    const edited=clone(catalog);edited.registries.shift();
    assert.throws(()=>validateRegistryCompatibility(current,edited,snapshots),/closure mismatch/);
});

test('preflight rejects unknown catalog fields that the native parser would reject',()=> {
    const edited=clone(catalog);edited.notes='unknown field';
    assert.throws(()=>validateRegistryCompatibility(current,edited,snapshots),/catalog fields/);
    delete edited.notes;edited.registries[0].addedTables=[];
    assert.throws(()=>validateRegistryCompatibility(current,edited,snapshots),/catalog entry fields/);
});

for (const [name,change] of [
    ['registry',registry=>registry.notes='unknown field'],
    ['table',registry=>registry.tables.projects.notes='unknown field'],
    ['index',registry=>registry.tables.projects.indexes[0].notes='unknown field'],
    ['index type',registry=>registry.tables.projects.indexes[0].unique='true'],
    ['empty index name',registry=>registry.tables.projects.indexes[0].name=''],
    ['reserved index name',registry=>registry.tables.projects.indexes[0].name='$primary'],
    ['duplicate index',registry=>registry.tables.projects.indexes.push(clone(registry.tables.projects.indexes[0]))],
    ['empty index paths',registry=>registry.tables.projects.indexes[0].keyPaths=[]],
]) test(`preflight and native parsing agree on closed ${name} definitions`,()=> {
    const edited=JSON.parse(current);change(edited);
    assert.throws(()=>validateRegistryCompatibility(Buffer.from(JSON.stringify(edited)),catalog,snapshots),/fields|invalid index definition/);
});

test('duplicate JSON keys are rejected rather than silently overwriting native definitions',()=> {
    for (const bytes of [
        Buffer.from(current.toString().replace('"version": 1','"version": 1, "version": 1')),
        Buffer.from(current.toString().replace('"keyPath": "id"','"keyPath": "id", "keyPath": "id"')),
    ]) {
        assert.notEqual(bytes.toString(),current.toString());
        assert.throws(()=>validateRegistryCompatibility(bytes,catalog,snapshots),/duplicate JSON field/);
    }
});

test('duplicate legacy source identities are rejected',()=> {
    const edited=clone(catalog);edited.registries.push(clone(edited.registries[0]));
    assert.throws(()=>validateRegistryCompatibility(current,edited,snapshots),/duplicate registry identity/);
});

for (const [name,change] of [
    ['removed table',tables=>delete tables.projects],
    ['primary key change',tables=>tables.projects.keyPath='differentKey'],
    ['index removal',tables=>tables.projects.indexes.pop()],
    ['unique constraint change',tables=>tables.projects.indexes[0].unique=!tables.projects.indexes[0].unique],
    ['scope change',tables=>tables.projects.scope='device'],
]) test(`automatic additions cannot authorize ${name}`,()=> {
    const next=JSON.parse(current);change(next.tables);
    assert.throws(()=>validateRegistryCompatibility(Buffer.from(JSON.stringify(next)),catalog,snapshots),/released table definition changed/);
});
