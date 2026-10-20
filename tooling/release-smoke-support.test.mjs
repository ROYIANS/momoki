import {strict as assert} from 'node:assert';
import {mkdtemp,mkdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {contained,poll,sha256,smokeArguments,smokeFixture,validateReadOnlyProfile,verifyExecutable,verifyExecutableArchitecture,verifyInstaller,verifyPeIcons,WebDriver} from './release-smoke-support.mjs';
import {compatibleDriver,verifyConsumedCrate} from './setup-release-driver.mjs';

test('driver source proof rejects missing, modified and linked consumed Cargo archives',async()=>{
    const root=await mkdtemp(join(tmpdir(),'momoki-driver-crate-'));
    try {
        const cache=join(root,'registry','cache','index.crates.io-fixture');
        await mkdir(cache,{recursive:true});
        await assert.rejects(verifyConsumedCrate(root),/was not found/);
        const archive=join(cache,'tauri-driver-2.1.0.crate');
        await writeFile(archive,Buffer.from('modified consumed source'));
        await assert.rejects(verifyConsumedCrate(root),/checksum differs/);
        await rm(archive);
        if (process.platform !== 'win32') {
            const outside=join(root,'outside.crate');await writeFile(outside,Buffer.from('source'));
            await symlink(outside,archive);
            await assert.rejects(verifyConsumedCrate(root),/ordinary bounded archive/);
        }
    } finally {await rm(root,{recursive:true});}
});

test('driver compatibility uses the observed WebView2 first three version parts',()=>{
    assert.deepEqual(compatibleDriver('133.0.3065.42','MSEdgeDriver 133.0.3065.59'),{runtime:'133.0.3065.42',driver:'133.0.3065.59'});
    for (const version of ['132.0.3065.42','133.0.3066.42','not version']) assert.throws(()=>compatibleDriver('133.0.3065.42',version),/does not match/);
});

test('actual PE/ELF architecture headers reject wrong target and malformed offsets',()=>{
    const elf=Buffer.alloc(64);Buffer.from([0x7f,0x45,0x4c,0x46]).copy(elf);elf[4]=2;elf[5]=1;elf.writeUInt16LE(62,18);
    assert.equal(verifyExecutableArchitecture(elf,'linux','x64'),'x86_64-elf');
    const wrong=Buffer.from(elf);wrong.writeUInt16LE(183,18);assert.throws(()=>verifyExecutableArchitecture(wrong,'linux','x64'));
    const pe=Buffer.alloc(128);pe.writeUInt16LE(0x5a4d);pe.writeUInt32LE(64,0x3c);pe.writeUInt32LE(0x4550,64);pe.writeUInt16LE(0x8664,68);pe.writeUInt16LE(0x20b,88);
    assert.equal(verifyExecutableArchitecture(pe,'win32','x64'),'x86_64-pe32+');
    const bad=Buffer.from(pe);bad.writeUInt32LE(0xffffffff,0x3c);assert.throws(()=>verifyExecutableArchitecture(bad,'win32','x64'));
    assert.throws(()=>verifyExecutableArchitecture(elf,'win32','x64'));assert.throws(()=>verifyExecutableArchitecture(pe,'linux','x64'));
});

test('PE icon verification inspects installed resources and rejects replaced bytes/bad offsets',()=>{
    const bytes=Buffer.from('icon'),ico=Buffer.alloc(26);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);
    ico[6]=16;ico[7]=16;ico.writeUInt32LE(4,14);ico.writeUInt32LE(22,18);bytes.copy(ico,22);
    const pe=Buffer.alloc(1024),header=64,optional=88,base=512,rva=4096;
    pe.writeUInt16LE(0x5a4d);pe.writeUInt32LE(header,0x3c);pe.writeUInt32LE(0x4550,header);pe.writeUInt16LE(0x8664,header+4);
    pe.writeUInt16LE(1,header+6);pe.writeUInt16LE(240,header+20);pe.writeUInt16LE(0x20b,optional);pe.writeUInt32LE(rva,optional+128);
    const section=optional+240;pe.writeUInt32LE(rva,section+12);pe.writeUInt32LE(512,section+16);pe.writeUInt32LE(base,section+20);
    const directory=(offset,entries)=>{
        pe.writeUInt16LE(entries.length,base+offset+14);
        for(const [index,entry] of entries.entries()) {
            pe.writeUInt32LE(entry.id,base+offset+16+index*8);
            pe.writeUInt32LE(entry.directory ? entry.offset+0x80000000 : entry.offset,base+offset+20+index*8);
        }
    };
    directory(0,[{id:3,directory:true,offset:64},{id:14,directory:true,offset:128}]);
    directory(64,[{id:1,directory:true,offset:96}]);directory(96,[{id:1033,offset:160}]);
    directory(128,[{id:1,directory:true,offset:192}]);directory(192,[{id:1033,offset:224}]);
    pe.writeUInt32LE(rva+256,base+160);pe.writeUInt32LE(4,base+164);bytes.copy(pe,base+256);
    const group=base+272;pe.writeUInt32LE(rva+272,base+224);pe.writeUInt32LE(20,base+228);
    pe.writeUInt16LE(1,group+2);pe.writeUInt16LE(1,group+4);pe[group+6]=16;pe[group+7]=16;pe.writeUInt32LE(4,group+14);pe.writeUInt16LE(1,group+18);
    assert.deepEqual(verifyPeIcons(pe,ico),{entries:1,sha256:sha256(ico)});
    const changed=Buffer.from(pe);changed[base+256]=88;assert.throws(()=>verifyPeIcons(changed,ico),/approved dark ICO/);
    const broken=Buffer.from(ico);broken.writeUInt32LE(0xffffffff,18);assert.throws(()=>verifyPeIcons(pe,broken),/boundary/);
});

test('closed CLI rejects missing, duplicate and arbitrary options before operations',()=>{
    const args=['--target','linux-x64','--package','p','--receipt','r','--evidence-dir','e'];
    assert.equal(smokeArguments(args).target,'linux-x64');
    for (const broken of [args.slice(0,-2),[...args,'--target','linux-x64'],[...args,'--profile','production'],[...args,'--unsafe']]) assert.throws(()=>smokeArguments(broken));
    assert.equal(contained('/tmp/run','/tmp/run/evidence'),true);
    assert.equal(contained('/tmp/run','/tmp/run'),false);
    assert.equal(contained('/tmp/run','/tmp/run-other'),false);
    assert.equal(contained('/tmp/run','/tmp/run/../other'),false);
});

test('fixture is deterministic, multi-chunk and has a marker inside the real preview window',()=>{
    const token='11111111-1111-4111-8111-111111111111',first=smokeFixture(token),second=smokeFixture(token);
    assert.equal(first.sha256,second.sha256);assert.deepEqual(first.bytes,second.bytes);
    assert.ok(first.bytes.length>262144);assert.ok(first.bytes.subarray(0,16000).includes(Buffer.from(first.marker)));
    assert.throws(()=>smokeFixture('../other'));
});

test('native read-only observation rejects wrong owner, mutable profile and startup error',()=>{
    const good={origin:'http://tauri.localhost',profile:{version:1,id:'design.tulai.momoki',storage:'sqlite'},
        writable:false,configurable:false,frozen:true,startupError:false};
    assert.doesNotThrow(()=>validateReadOnlyProfile(good,good.profile.id,'win32'));
    for (const patch of [{origin:'http://localhost'},{writable:true},{configurable:true},{frozen:false},{startupError:true},
        {profile:{...good.profile,storage:'indexeddb'}},{profile:{...good.profile,id:'review'}}]) {
        assert.throws(()=>validateReadOnlyProfile({...good,...patch},good.profile.id,'win32'));
    }
});

test('installer and installed binary guards detect real bytes, receipt ambiguity and links',async()=>{
    const root=await mkdtemp(join(tmpdir(),'momoki-smoke-support-'));
    try {
        const path=join(root,'fixture.deb'),bytes=Buffer.from('original installer');
        await writeFile(path,bytes);
        const asset={name:'fixture.deb',bytes:bytes.length,sha256:sha256(bytes),format:'deb'},receipt={assets:[asset]};
        assert.deepEqual(await verifyInstaller(path,receipt),asset);
        assert.equal((await verifyExecutable(path,sha256(bytes))).sha256,sha256(bytes));
        await writeFile(path,Buffer.from('modified installer'));
        await assert.rejects(verifyInstaller(path,receipt),/differs/);
        await assert.rejects(verifyExecutable(path,asset.sha256),/differs/);
        await assert.rejects(verifyInstaller(path,{assets:[asset,asset]}),/exactly one/);
        if (process.platform !== 'win32') {
            const linked=join(root,'linked.deb');await symlink(path,linked);
            await assert.rejects(verifyInstaller(linked,{assets:[{...asset,name:'linked.deb'}]}),/ordinary/);
        }
        await mkdir(join(root,'directory'));
        await assert.rejects(verifyExecutable(join(root,'directory'),asset.sha256),/ordinary/);
    } finally {await rm(root,{recursive:true});}
});

test('finite poll does not turn timeout or thrown assertion into success',async()=>{
    await assert.rejects(poll('missing',async()=>false,{timeout:5,interval:1}),/Timed out/);
    await assert.rejects(poll('assertion',async()=>{throw new Error('real failure');}),/real failure/);
    let calls=0;assert.equal(await poll('eventual',async()=>++calls>1 ? 'observed' : false,{timeout:50,interval:1}),'observed');
});

test('WebDriver keeps last-window close separate from session disposal and preserves assertion failures',async()=>{
    const calls=[];
    const server=createServer(async(req,res)=>{
        const chunks=[];for await (const chunk of req) chunks.push(chunk);
        const body=chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;calls.push({method:req.method,path:req.url,body});
        res.setHeader('Content-Type','application/json');
        if (req.url === '/session' && req.method === 'POST') res.end(JSON.stringify({value:{sessionId:'actual-session'}}));
        else if (req.url === '/session/actual-session/execute/sync') {res.statusCode=500;res.end(JSON.stringify({value:{error:'javascript error',message:'failed real UI assertion'}}));}
        else if (req.url === '/session/actual-session') {res.statusCode=404;res.end(JSON.stringify({value:{error:'invalid session id',message:'window already closed'}}));}
        else res.end(JSON.stringify({value:[]}));
    });
    await new Promise(done=>server.listen(0,'127.0.0.1',done));
    try {
        const driver=new WebDriver(`http://127.0.0.1:${server.address().port}`);
        await driver.start('/real/payload');
        assert.equal(calls[0].body.capabilities.alwaysMatch['tauri:options'].application,'/real/payload');
        await assert.rejects(driver.execute('throw real assertion'),/failed real UI assertion/);
        await driver.closeWindow();
        assert.equal(driver.session,'actual-session');
        assert.equal(calls.filter(call=>call.path === '/session/actual-session').length,0);
        await driver.dispose();assert.equal(driver.session,null);
    } finally {await new Promise(done=>server.close(done));}
});

test('WebDriver disposal fails on native errors other than an already deleted session',async()=>{
    const driver=new WebDriver('http://unused');driver.session='session';
    driver.request=async()=>{const error=new Error('native driver teardown failed');error.webDriverCode='unknown error';throw error;};
    await assert.rejects(driver.dispose(),/teardown failed/);
});
