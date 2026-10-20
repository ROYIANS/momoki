import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {desktopRoot,nativeProbePath,resolveTools} from './tool-resolver.mjs';
import {getTarget,parseOptions,runContext} from './release-policy.mjs';
import {fileDigest,listedFiles} from './release-artifacts.mjs';
import {runLoggedProcess} from './logged-process.mjs';

const options=parseOptions(process.argv.slice(2),['--target','--evidence-dir']);
const target=getTarget(options['--target']),context=runContext();
if (!options['--evidence-dir'] || process.platform !== target.platform || process.arch !== target.arch) throw new Error('Native checks require corresponding host and fresh evidence');
const evidence=resolve(options['--evidence-dir']);await mkdir(evidence,{recursive:false});
const root=resolve(desktopRoot,'../..'),tools=resolveTools();
const env={...tools.env,CARGO_INCREMENTAL:'0',MOMOKI_RUST_TARGET:target.triple};
env.MOMOKI_NATIVE_STORE_PROBE=nativeProbePath(env);
async function run(args,path,cwd=desktopRoot) {
    console.log(`Native check started: ${path}`);
    const {code,signal}=await runLoggedProcess(process.execPath,args,{cwd,env,logPath:resolve(evidence,path)});
    console.log(`Native check finished: ${path}; exit=${code}; signal=${signal ?? 'none'}`);
    if (code !== 0 || signal) throw new Error(`Required native check failed: ${path}; exit=${code}; signal=${signal ?? 'none'}`);
}
const commands=[
    ['fmt','--manifest-path','src-tauri/Cargo.toml','--all','--','--check'],
    ['clippy','--manifest-path','src-tauri/Cargo.toml','--locked','--all-targets','--features','test-hooks','--','-D','warnings'],
    ['clippy','--manifest-path','src-tauri/Cargo.toml','--locked','--all-targets','--features','product-sqlite,test-hooks','--','-D','warnings'],
    ['test','--manifest-path','src-tauri/Cargo.toml','--locked','--all-targets','--features','test-hooks','--','--nocapture'],
    ['test','--manifest-path','src-tauri/Cargo.toml','--locked','--all-targets','--features','product-sqlite,test-hooks','--','--nocapture'],
    ['test','--manifest-path','src-tauri/Cargo.toml','--locked','--test','portable_contract','--','--nocapture'],
];
await run([resolve(desktopRoot,'scripts/build-frontend.mjs')],'normal-frontend.log');
for (const [index,command] of commands.entries()) await run([resolve(desktopRoot,'scripts/tools.mjs'),'cargo',...command],`native-${index}.log`);
await writeFile(resolve(evidence,'native-tests.json'),JSON.stringify({schema:1,target:target.id,sourceSha:context.sourceSha,commands,status:'passed'},null,2)+'\n');
await run([resolve(root,'tooling/native-storage-regression.mjs'),'--evidence-dir',resolve(evidence,'shared-storage'),'--suite','all'],'shared-storage.log',root);
const storage=JSON.parse(await readFile(resolve(evidence,'shared-storage/acceptance.json'),'utf8'));
if (storage.exitCode !== 0 || storage.suite !== 'all' || storage.changedInputs.length) throw new Error('Shared storage all report failed');
const evidenceFiles=[];
for (const path of await listedFiles(evidence)) evidenceFiles.push({path,...await fileDigest(resolve(evidence,path))});
const report={schema:1,target:target.id,sourceSha:context.sourceSha,checks:[{name:'native-tests',status:'passed',evidence:'native-tests.json'},{name:'shared-storage-all',status:'passed',evidence:'shared-storage/acceptance.json'}],evidenceFiles};
await writeFile(resolve(evidence,'checks.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
