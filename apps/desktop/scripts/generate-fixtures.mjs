import {build} from 'vite';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import JSZip from 'jszip';

const base=fileURLToPath(new URL('../',import.meta.url));
const output=resolve(base,'fixtures/media');
const generated=resolve(base,'.acceptance/fixture-generator');
await mkdir(output,{recursive:true});
await build({configFile:false,root:base,logLevel:'warn',build:{outDir:generated,emptyOutDir:true,minify:false,target:'es2022',lib:{entry:resolve(base,'scripts/fixture-audio.ts'),formats:['es'],fileName:()=> 'audio.mjs'}}});
const {wavFixture}=await import(pathToFileURL(resolve(generated,'audio.mjs')).href);
await writeFile(resolve(output,'tone.wav'),new Uint8Array(await wavFixture().arrayBuffer()));
const require=createRequire(import.meta.url);
// Official all-in-one Node-only encoder avoids the upstream split-module MPEGMode bug.
const encoderRoot=dirname(require.resolve('lamejs/package.json'));
const source=await readFile(resolve(encoderRoot,'lame.all.js'),'utf8');
const context={};runInNewContext(source,context,{timeout:10000});
const encoder=new context.lamejs.Mp3Encoder(1,44100,64);
const pcm=Int16Array.from({length:88200},(_,i)=>Math.round(Math.sin(i*2*Math.PI*440/44100)*1200));
const mp3=[];
for(let offset=0;offset<pcm.length;offset+=1152)mp3.push(Buffer.from(encoder.encodeBuffer(pcm.subarray(offset,offset+1152))));
mp3.push(Buffer.from(encoder.flush()));
await writeFile(resolve(output,'tone.mp3'),Buffer.concat(mp3));
const zip=new JSZip();
const date=new Date('2026-10-11T00:00:00Z');
zip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',{date});
zip.file('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',{date});
zip.file('word/document.xml','<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一段：雨夜的红色雨伞。</w:t></w:r></w:p><w:p><w:r><w:t>第二段：素材复制到工作区。</w:t></w:r></w:p></w:body></w:document>',{date});
await writeFile(resolve(output,'document.docx'),await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
const files={};
for(const name of ['image.png','tone.wav','tone.mp3','tone.aac','tone.m4a','movie.mp4','document.pdf','document.docx']) {
    const bytes=await readFile(resolve(output,name));files[name]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}
await writeFile(resolve(base,'fixtures/media-provenance.json'),JSON.stringify({format:'momoki.synthetic-fixtures.v1',encoder:{package:'lamejs',version:JSON.parse(await readFile(resolve(encoderRoot,'package.json'),'utf8')).version,allInOneSha256:createHash('sha256').update(source).digest('hex'),license:'LGPL-3.0',source:'https://github.com/zhuker/lamejs'},wavOwner:'packages/studio/src/features/audio/engine/wav.ts',pdfGenerator:'scripts/generate-fixtures.py',videoGenerator:'scripts/generate-video.swift',files},null,2)+'\n');
