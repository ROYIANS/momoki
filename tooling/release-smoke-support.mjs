import {lstat,readFile,realpath} from 'node:fs/promises';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {sha256} from '../apps/desktop/scripts/release-policy.mjs';

export {sha256};

export function contained(root,path) {
    const suffix=relative(resolve(root),resolve(path));
    return suffix !== '' && !suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix);
}

export function smokeArguments(args) {
    const result={};
    const allowed=['--target','--package','--receipt','--evidence-dir'];
    for (let index=0;index<args.length;index+=2) {
        const key=args[index],value=args[index+1];
        if (!allowed.includes(key) || !value || value.startsWith('--') || Object.hasOwn(result,key.slice(2))) throw new Error(`Invalid smoke option: ${key}`);
        result[key.slice(2)]=value;
    }
    if (allowed.some(key=>!result[key.slice(2)])) throw new Error('Smoke requires --target, --package, --receipt and --evidence-dir');
    return result;
}

async function ordinaryFile(path) {
    const info=await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`Expected an ordinary single-link file: ${path}`);
    return info;
}

export async function verifyInstaller(path,receipt) {
    const info=await ordinaryFile(path),name=path.split(/[\\/]/).at(-1);
    const matches=receipt.assets.filter(asset=>asset.name === name);
    if (matches.length !== 1) throw new Error('Installer is not exactly one receipted asset');
    const asset=matches[0];
    if (info.size !== asset.bytes || sha256(await readFile(path)) !== asset.sha256) throw new Error('Installer differs from build receipt');
    return asset;
}

export async function verifyExecutable(path,expectedHash) {
    await ordinaryFile(path);
    const actual=sha256(await readFile(path));
    if (!/^[a-f0-9]{64}$/.test(expectedHash) || actual !== expectedHash) throw new Error('Installed executable differs from release payload');
    return {path:await realpath(path),sha256:actual};
}

export function verifyExecutableArchitecture(bytes,platform,arch) {
    if (arch !== 'x64') throw new Error('PE/ELF architecture check only accepts the closed x64 targets');
    if (platform === 'linux') {
        if (bytes.length<64 || !bytes.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46]))
            || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) throw new Error('Expected Linux x86_64 ELF payload');
        return 'x86_64-elf';
    }
    if (platform === 'win32') {
        if (bytes.length<64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error('Expected Windows PE payload');
        const offset=bytes.readUInt32LE(0x3c);
        if (offset>bytes.length-26 || bytes.readUInt32LE(offset) !== 0x00004550
            || bytes.readUInt16LE(offset+4) !== 0x8664 || bytes.readUInt16LE(offset+24) !== 0x20b) throw new Error('Expected Windows x64 PE32+ payload');
        return 'x86_64-pe32+';
    }
    throw new Error('Unknown executable platform');
}

/** Verify the actual PE icon resource bytes against the approved ICO entries. */
export function verifyPeIcons(pe,ico) {
    verifyExecutableArchitecture(pe,'win32','x64');
    const bound=(buffer,offset,length)=>{
        if (!Number.isSafeInteger(offset) || offset<0 || offset>buffer.length-length) throw new Error('Icon resource boundary');
        return offset;
    };
    bound(ico,0,6);
    if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('Invalid approved ICO');
    const expected=[];
    for(let i=0;i<ico.readUInt16LE(4);i++) {
        const entry=bound(ico,6+i*16,16),size=ico.readUInt32LE(entry+8),offset=bound(ico,ico.readUInt32LE(entry+12),size);
        expected.push(sha256(ico.subarray(offset,offset+size)));
    }
    if (!expected.length) throw new Error('Approved ICO is empty');
    const header=pe.readUInt32LE(0x3c),sections=pe.readUInt16LE(header+6),optional=header+24;
    bound(pe,optional,136);
    const sectionTable=optional+pe.readUInt16LE(header+20),resourceRva=pe.readUInt32LE(optional+128);
    const fromRva=(rva,size)=>{
        for(let i=0;i<sections;i++) {
            const section=bound(pe,sectionTable+i*40,40),start=pe.readUInt32LE(section+12),length=pe.readUInt32LE(section+16);
            if (rva>=start && rva-start<=length-size) return bound(pe,pe.readUInt32LE(section+20)+rva-start,size);
        }
        throw new Error('PE icon RVA outside file sections');
    };
    const base=fromRva(resourceRva,16);
    const entries=offset=>{
        const position=bound(pe,base+offset,16),count=pe.readUInt16LE(position+12)+pe.readUInt16LE(position+14),result=[];
        if (count>4096) throw new Error('PE resource entry boundary');
        for(let i=0;i<count;i++) {
            const entry=bound(pe,position+16+i*8,8),name=pe.readUInt32LE(entry),location=pe.readUInt32LE(entry+4);
            result.push({id:name&0xffff,named:Boolean(name&0x80000000),directory:Boolean(location&0x80000000),offset:location&0x7fffffff});
        }
        return result;
    };
    const types=entries(0);
    const resources=type=>{
        const root=types.find(entry=>!entry.named && entry.id === type && entry.directory);
        if (!root) throw new Error('PE approved icon resource missing');
        const result=[];
        for(const id of entries(root.offset)) {
            if (id.named || !id.directory) throw new Error('Unexpected icon identifier');
            for(const language of entries(id.offset)) {
                if (language.directory) throw new Error('Unexpected icon resource depth');
                const data=bound(pe,base+language.offset,16),size=pe.readUInt32LE(data+4),offset=fromRva(pe.readUInt32LE(data),size);
                result.push({id:id.id,bytes:pe.subarray(offset,offset+size)});
            }
        }
        return result;
    };
    const icons=resources(3),groups=resources(14);
    const approved=[...expected].sort();
    const matched=groups.some(group=>{
        const bytes=group.bytes;bound(bytes,0,6);
        if (bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1 || bytes.readUInt16LE(4) !== expected.length) return false;
        const observed=[];
        for(let i=0;i<bytes.readUInt16LE(4);i++) {
            const entry=bound(bytes,6+i*14,14),id=bytes.readUInt16LE(entry+12),length=bytes.readUInt32LE(entry+8);
            const variants=icons.filter(icon=>icon.id === id && icon.bytes.length === length);
            if (!variants.length) return false;
            observed.push(sha256(variants[0].bytes));
        }
        return JSON.stringify(observed.sort()) === JSON.stringify(approved);
    });
    if (!matched) throw new Error('Installed PE does not contain the approved dark ICO');
    return {entries:expected.length,sha256:sha256(ico)};
}

export function smokeFixture(token) {
    if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error('Invalid smoke fixture identity');
    const marker=`MOMOKI_RELEASE_SMOKE_${token}`;
    const bytes=Buffer.from(`${marker}\n${'0123456789 release managed fixture\n'.repeat(18000)}`,'utf8');
    return {bytes,marker,sha256:sha256(bytes),filename:`release-smoke-${token}.txt`,projectName:`Release smoke ${token}`};
}

export function validateReadOnlyProfile(snapshot,identifier,platform) {
    const expectedOrigin=platform === 'win32' ? 'http://tauri.localhost' : 'tauri://localhost';
    if (snapshot?.origin !== expectedOrigin || snapshot?.profile?.id !== identifier || snapshot?.profile?.storage !== 'sqlite'
        || snapshot.profile.version !== 1 || snapshot.writable !== false || snapshot.configurable !== false
        || snapshot.frozen !== true || snapshot.startupError) throw new Error('Packaged frontend has wrong trusted origin/fixed SQLite profile or failed startup');
}

export async function poll(description,operation,{timeout=30000,interval=200}={}) {
    const deadline=Date.now()+timeout;
    while (Date.now()<deadline) {
        const value=await operation();
        if (value) return value;
        await new Promise(done=>setTimeout(done,interval));
    }
    throw new Error(`Timed out: ${description}`);
}

export class WebDriver {
    constructor(base) {this.base=base;this.session=null;}
    async request(method,path,body) {
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('WebDriver request deadline')),30000);
        try {
            const response=await fetch(`${this.base}${path}`,{method,headers:{'Content-Type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body),signal:controller.signal});
            const raw=await response.text();
            if (Buffer.byteLength(raw)>12*1024*1024) throw new Error('WebDriver response boundary');
            const result=JSON.parse(raw);
            if (!response.ok || result.value?.error) {
                const error=new Error(`WebDriver ${path}: ${result.value?.error ?? response.status}: ${result.value?.message ?? ''}`);
                error.webDriverCode=result.value?.error;
                throw error;
            }
            return result.value;
        } finally {clearTimeout(timer);}
    }
    async start(executable) {
        const value=await this.request('POST','/session',{capabilities:{alwaysMatch:{'tauri:options':{application:executable},strictFileInteractability:false}}});
        if (!value?.sessionId) throw new Error('WebDriver did not create a session');
        this.session=value.sessionId;
    }
    path(suffix) {
        if (!this.session) throw new Error('No WebDriver session');
        return `/session/${this.session}${suffix}`;
    }
    execute(script,args=[]) {return this.request('POST',this.path('/execute/sync'),{script,args});}
    executeAsync(script,args=[]) {return this.request('POST',this.path('/execute/async'),{script,args});}
    async elements(using,value) {return this.request('POST',this.path('/elements'),{using,value});}
    async element(using,value) {
        return poll(`visible ${value}`,async()=>{
            for (const result of await this.elements(using,value)) {
                const id=result['element-6066-11e4-a52e-4f735466cecf'];
                if (id && await this.request('GET',this.path(`/element/${id}/displayed`))) return id;
            }
            return null;
        });
    }
    click(id) {return this.request('POST',this.path(`/element/${id}/click`),{});}
    clear(id) {return this.request('POST',this.path(`/element/${id}/clear`),{});}
    type(id,text) {return this.request('POST',this.path(`/element/${id}/value`),{text,value:Array.from(text)});}
    async button(text,prefix='') {await this.click(await this.element('xpath',`${prefix}//button[normalize-space(.)='${text}']`));}
    async screenshot() {
        const image=await this.request('GET',this.path('/screenshot'));
        if (typeof image !== 'string' || image.length>12*1024*1024) throw new Error('Invalid screenshot boundary');
        return Buffer.from(image,'base64');
    }
    async closeWindow() {
        await this.request('DELETE',this.path('/window'));
        // The caller observes actual process exit before disposing the session.
        // Session deletion/forced termination cannot stand in for that check.
    }
    async dispose() {
        if (!this.session) return;
        try {await this.request('DELETE',this.path(''));}
        catch (error) {if (error.webDriverCode !== 'invalid session id') throw error;}
        finally {this.session=null;}
    }
}
