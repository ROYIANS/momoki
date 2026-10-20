import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureAgentPackageInputs,captureAgentPackageFiles,assertAgentPackageFreshness} from './agent-package-inputs.ts';

test('actual artifact freshness rejects stale producer/compiler/config/source/output identities and missing receipt keys',async()=> {
    const root=await mkdtemp(join(tmpdir(),'momoki-agent-artifacts-'));
    const write=async(file,value)=>{await mkdir(join(root,file,'..'),{recursive:true});await writeFile(join(root,file),typeof value === 'string' ? value : JSON.stringify(value));};
    try {
        const packages=[{name:'dependency',path:'packages/dependency',dependencies:[],publicSources:{'.':'src/index.ts'}},{name:'core',path:'packages/core',dependencies:['dependency'],publicSources:{'.':'src/index.ts'}}];
        await write('quality/workspaces.json',{packages});
        for (const row of packages) {
            for (const [file,body] of Object.entries({'src/index.ts':'export const value=1;','dist/index.js':'export const value=1;','dist/index.d.ts':'export declare const value=1;','package.json':'{}','tsconfig.json':'{}'})) await write(`${row.path}/${file}`,body);
        }
        for (const file of ['pnpm-lock.yaml','tooling/build-agent-packages.mjs','tooling/agent-package-inputs.ts','tooling/workspace.mjs','node_modules/typescript/package.json','node_modules/typescript/bin/tsc','node_modules/typescript/lib/tsc.js','node_modules/typescript/lib/_tsc.js']) await write(file,'fixture');
        for (const row of packages) await write(`${row.path}/dist/.momoki-build.json`,{inputs:await captureAgentPackageInputs(root,row,packages),outputs:await captureAgentPackageFiles(root,`${row.path}/dist`)});
        const receipt=JSON.parse(await readFile(join(root,'packages/core/dist/.momoki-build.json'),'utf8'));
        await assertAgentPackageFreshness(root);
        for (const file of [...Object.keys(receipt.inputs),...Object.keys(receipt.outputs)]) {
            const previous=await readFile(join(root,file));
            await writeFile(join(root,file),Buffer.concat([previous,Buffer.from('\n')]));
            await assert.rejects(assertAgentPackageFreshness(root),/Stale reusable package/);
            await writeFile(join(root,file),previous);
        }
        for (const key of Object.keys(receipt.inputs)) {
            const inputs={...receipt.inputs};delete inputs[key];
            await write('packages/core/dist/.momoki-build.json',{...receipt,inputs});
            await assert.rejects(assertAgentPackageFreshness(root),/Stale reusable package inputs/);
        }
        await write('packages/core/dist/.momoki-build.json',receipt);
        for (const file of ['packages/core/src/new.ts','packages/core/dist/obsolete.js']) {
            await write(file,'export const unbuilt=1;');
            await assert.rejects(assertAgentPackageFreshness(root),/Stale reusable package/);
            await rm(join(root,file));
        }
        await assertAgentPackageFreshness(root);
        const built=await readFile(join(root,'packages/core/dist/index.js'));
        await rm(join(root,'packages/core/dist/index.js'));
        await assert.rejects(assertAgentPackageFreshness(root),/Stale reusable package outputs/);
        await writeFile(join(root,'packages/core/dist/index.js'),built);
        await assertAgentPackageFreshness(root);
    } finally {await rm(root,{recursive:true,force:true});}
});
