import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

type BuildReceipt = {inputs: Record<string,string>; outputs: Record<string,string>};
type PackageRow = {name:string; path:string; dependencies:string[]; publicSources?:Record<string,string>};
const repositoryRoot=fileURLToPath(new URL('../',import.meta.url));
const hash=(bytes: Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const equal=(left:Record<string,string>,right:Record<string,string>)=>JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());

/** Capture the complete current set, rather than trusting keys supplied by a saved receipt. */
export async function captureAgentPackageFiles(root:string,directory:string): Promise<Record<string,string>> {
    const local=relative(resolve(root),resolve(root,directory));
    if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) throw new Error(`Reusable package path escapes repository: ${directory}`);
    const result: Record<string,string>={};
    for (const entry of await readdir(join(root,directory),{withFileTypes:true})) {
        const file=`${directory}/${entry.name}`;
        if (entry.isDirectory()) Object.assign(result,await captureAgentPackageFiles(root,file));
        else if (entry.isFile() && entry.name !== '.momoki-build.json') result[file]=hash(await readFile(join(root,file)));
    }
    return result;
}

/** Exact producer/compiler/config identity shared by compilation and every artifact consumer. */
export async function captureAgentPackageInputs(root:string,row:PackageRow,packages:PackageRow[]): Promise<Record<string,string>> {
    const inputs=await captureAgentPackageFiles(root,`${row.path}/src`);
    const files=[`${row.path}/package.json`,`${row.path}/tsconfig.json`,'pnpm-lock.yaml',
        'tooling/build-agent-packages.mjs','tooling/agent-package-inputs.ts','tooling/workspace.mjs','quality/workspaces.json',
        'node_modules/typescript/package.json','node_modules/typescript/bin/tsc','node_modules/typescript/lib/tsc.js','node_modules/typescript/lib/_tsc.js'];
    for (const dependency of packages.filter(candidate=>candidate.publicSources && row.dependencies.includes(candidate.name))) files.push(`${dependency.path}/dist/.momoki-build.json`);
    for (const file of files) inputs[file]=hash(await readFile(join(root,file)));
    return inputs;
}

/** Verify the bytes actually loaded from dist still correspond to their current sources. */
export async function assertAgentPackageFreshness(root=repositoryRoot): Promise<void> {
    const policy=JSON.parse(await readFile(join(root,'quality/workspaces.json'),'utf8')) as {packages:PackageRow[]};
    for (const row of policy.packages.filter(row=>row.publicSources)) {
        const receipt=JSON.parse(await readFile(join(root,row.path,'dist/.momoki-build.json'),'utf8')) as BuildReceipt;
        const outputs=await captureAgentPackageFiles(root,`${row.path}/dist`);
        if (!equal(outputs,receipt.outputs)) throw new Error(`Stale reusable package outputs: ${row.path}; run agent:build`);
        const inputs=await captureAgentPackageInputs(root,row,policy.packages);
        if (!equal(inputs,receipt.inputs)) throw new Error(`Stale reusable package inputs: ${row.path}; run agent:build`);
    }
}
