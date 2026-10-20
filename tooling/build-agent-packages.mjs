import {spawnSync} from 'node:child_process';
import {readFile, writeFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {workspacePolicy} from './workspace.mjs';
import {captureAgentPackageFiles, captureAgentPackageInputs} from './agent-package-inputs.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
/** Compile declared reusable libraries in dependency order before real dist consumers run. */
export async function buildAgentPackages() {
    const packages=workspacePolicy(root).packages;
    const pending=packages.filter(row=>row.publicSources);
    while (pending.length) {
        const index=pending.findIndex(row=>row.dependencies.every(name=>!pending.some(other=>other.name === name)));
        if (index<0) throw new Error('Reusable package build dependency cycle');
        const [row]=pending.splice(index,1);
        const capture=()=>captureAgentPackageInputs(root,row,packages);
        const inputs=await capture();
        await rm(join(root,row.path,'dist'),{recursive:true,force:true});
        const result=spawnSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-p',join(root,row.path,'tsconfig.json')],{cwd:root,stdio:'inherit'});
        if (result.status !== 0) throw new Error(`Reusable package build failed: ${row.name}`);
        if (JSON.stringify(inputs) !== JSON.stringify(await capture())) throw new Error(`Reusable package inputs changed during build: ${row.name}`);
        const outputs=await captureAgentPackageFiles(root,`${row.path}/dist`);
        const manifest=JSON.parse(await readFile(join(root,row.path,'package.json'),'utf8'));
        for (const target of Object.values(manifest.exports)) for (const file of [target.import,target.types]) {
            if (!outputs[`${row.path}/${file.slice(2)}`]) throw new Error(`Missing built public export: ${row.name} ${file}`);
        }
        await writeFile(join(root,row.path,'dist/.momoki-build.json'),JSON.stringify({inputs,outputs},null,2)+'\n');
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildAgentPackages();
