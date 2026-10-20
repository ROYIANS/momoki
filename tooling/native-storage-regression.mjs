#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {mkdir,readdir,readFile,stat,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {nativeProbePath,nativeProbeBuildArguments} from '../apps/desktop/scripts/tool-resolver.mjs';
import {assertAgentPackageFreshness} from './agent-package-inputs.ts';
import {workspacePolicy} from './workspace.mjs';
import {buildAgentPackages} from './build-agent-packages.mjs';
import {runLoggedProcess} from '../apps/desktop/scripts/logged-process.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const node=process.execPath;
const vitest=join(root,'node_modules/vitest/vitest.mjs');
const probe=nativeProbePath();
const manifestPath=join(root,'tests/fixtures/shared-storage/nativeAcceptanceSuites.json');
const hash=value=>createHash('sha256').update(value).digest('hex');

async function filesUnder(directory) {
    const entries=await readdir(directory,{withFileTypes:true}),files=[];
    for (const entry of entries) {
        const path=join(directory,entry.name);
        if (entry.isDirectory()) files.push(...await filesUnder(path));
        else if (entry.isFile()) files.push(path);
    }
    return files;
}
async function identity() {
    const files=[];
    for (const directory of [...workspacePolicy(root).roots.map(prefix=>prefix.slice(0,-1)),...workspacePolicy(root).packages.filter(row=>row.publicSources).map(row=>`${row.path}/dist`),'apps/desktop/scripts','apps/desktop/ui','tests','tooling','quality','apps/desktop/src-tauri/src','apps/desktop/src-tauri/permissions','apps/desktop/src-tauri/capabilities']) files.push(...await filesUnder(join(root,directory)));
    for (const file of ['package.json','pnpm-workspace.yaml','pnpm-lock.yaml','vitest.config.ts','tsconfig.app.json','tsconfig.json','tsconfig.node.json','eslint.config.mjs','knip.json',...workspacePolicy(root).packages.flatMap(row=>['package.json','tsconfig.json'].map(file=>`${row.path}/${file}`)),'apps/web/vite.config.ts','apps/site/vite.config.ts','apps/web/index.html','apps/site/landing.html','apps/desktop/index.html','apps/desktop/src-tauri/tauri.conf.json','apps/desktop/src-tauri/Cargo.toml','apps/desktop/src-tauri/Cargo.lock','apps/desktop/src-tauri/build.rs']) files.push(join(root,file));
    return Object.fromEntries(await Promise.all([...new Set(files)].sort().map(async path=>[relative(root,path),hash(await readFile(path))])));
}
async function run(command,args,log,env) {
    const {code,signal}=await runLoggedProcess(command,args,{cwd:root,env,logPath:log});
    console.log(`Native storage check finished: ${relative(evidenceDir,log)}; exit=${code}; signal=${signal ?? 'none'}`);
    return signal ? 1 : code ?? 1;
}
async function currentRegistry() {
    // Inspect names from the current registered recipes without executing a tool or reading data.
    const server=await createServer({configFile:false,root,server:{middlewareMode:true},appType:'custom',resolve:{alias:{'@':join(root,'packages/studio/src')}}});
    try {return (await server.ssrLoadModule('/packages/studio/src/features/agent/runtime/tools.ts')).BUILTIN_TOOLS.map(tool=>tool.name).sort();}
    finally {await server.close();}
}
async function coverage(directory,names) {
    const rows=[],tableRows=[];
    for (const file of await readdir(directory)) {
        if (!file.endsWith('.jsonl')) continue;
        for (const line of (await readFile(join(directory,file),'utf8')).split('\n').filter(Boolean)) {
            const row=JSON.parse(line);
            if (row.kind === 'committedTables') tableRows.push(row);else rows.push(row);
        }
    }
    const tools=names.map(name=> {
        const events=rows.filter(row=>row.name === name && row.owner === 'sqlite');
        const methods=Object.fromEntries(['parse','prepare','execute'].map(method=>[method,Object.fromEntries(['fulfilled','rejected'].map(outcome=>[outcome,events.filter(row=>row.method === method && row.outcome === outcome).length]))]));
        return {name,methods,tests:[...new Set(events.map(row=>row.test))].sort()};
    });
    const tables=[...new Set(tableRows.flatMap(row=>row.tables))].sort().map(table=> {
        const commits=tableRows.filter(row=>row.tables.includes(table)).map(row=>({owner:row.owner,file:row.file,test:row.test}));
        const nativeBusinessCommits=commits.filter(row=>row.owner === 'sqlite' && !/\/shared(?:Native)?StorageContract\.test\.ts$/.test(row.file));
        return {table,owners:[...new Set(commits.map(row=>row.owner))].sort(),commits,nativeBusinessCommits};
    });
    return {schemaVersion:1,registryCount:names.length,eventCount:rows.length,tools,tables,missingSuccessfulExecutions:tools.filter(tool=>tool.methods.execute.fulfilled === 0).map(tool=>tool.name),missingValidArguments:tools.filter(tool=>tool.methods.parse.fulfilled === 0).map(tool=>tool.name),missingInvalidArguments:tools.filter(tool=>tool.methods.parse.rejected === 0).map(tool=>tool.name)};
}

let evidenceDir,suite='all';
for (let index=2;index<process.argv.length;index++) {
    const argument=process.argv[index],value=process.argv[++index];
    if (!value || !['--evidence-dir','--suite'].includes(argument)) throw new Error('Usage: test:storage:native --evidence-dir <empty directory> [--suite core|business|all]');
    if (argument === '--evidence-dir') evidenceDir=resolve(value);else suite=value;
}
if (!evidenceDir || !['core','business','all'].includes(suite)) throw new Error('Provide --evidence-dir and optionally --suite core|business|all');
await mkdir(evidenceDir,{recursive:true});
if ((await readdir(evidenceDir)).length) throw new Error('Evidence directory must be empty; previous acceptance output will not be overwritten');
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
const tests=suite === 'all' ? [...new Set([...manifest.core,...manifest.business])] : manifest[suite];
for (const file of tests) if (!(await stat(join(root,file))).isFile()) throw new Error(`Missing permanent acceptance suite: ${file}`);
const ownerAssertions=JSON.parse(await readFile(join(root,manifest.ownerAssertions),'utf8'));
const currentTables=Object.keys(JSON.parse(await readFile(join(root,'packages/studio/src/platform/storage/schema.json'),'utf8')).tables);
const mappedTables=ownerAssertions.groups.flatMap(group=>group.tables);
if (mappedTables.length !== currentTables.length || new Set(mappedTables).size !== currentTables.length || currentTables.some(table=>!mappedTables.includes(table))) throw new Error('Current domain assertion anchors must cover each registered table exactly once');
for (const group of ownerAssertions.groups) {
    if (![...manifest.core,...manifest.business].includes(group.file) || !(await readFile(join(root,group.file),'utf8')).includes(group.case)) throw new Error(`Missing current business assertion anchor: ${group.file} ${group.case}`);
}
await buildAgentPackages();
await assertAgentPackageFreshness(root);
const before=await identity(),registry=await currentRegistry();
const report={schemaVersion:1,startedAt:new Date().toISOString(),suite,tests,registry,node:process.version,commands:[],sourceBefore:before,browserComparators:manifest.browserComparators,ownerAssertions,limitations:'Rust JSON-line process harness exercises the current shared TypeScript/SQLite implementation. It does not measure WKWebView latency or replace packaged macOS acceptance. Postcommit table statistics alone are not proof of complete domain behavior; current command/assertion anchors and passing suite output are required together.'};
const environment={...process.env,CARGO_INCREMENTAL:'0',MOMOKI_STORAGE_TEST_OWNER:'sqlite',MOMOKI_NATIVE_STORAGE_ACCEPTANCE:'1',MOMOKI_NATIVE_STORE_PROBE:probe,MOMOKI_TOOL_COVERAGE_DIR:join(evidenceDir,'coverage')};
await mkdir(environment.MOMOKI_TOOL_COVERAGE_DIR);
const buildArgs=[join(root,'apps/desktop/scripts/tools.mjs'),'cargo',...nativeProbeBuildArguments(process.env.MOMOKI_RUST_TARGET)];
report.commands.push({command:node,args:buildArgs,log:'probe-build.log'});
console.log('Building the current locked Rust probe with the pinned toolchain.');
report.buildExitCode=await run(node,buildArgs,join(evidenceDir,'probe-build.log'),environment);
if (report.buildExitCode === 0) {
    report.probe={path:probe,sha256:hash(await readFile(probe)),size:(await stat(probe)).size};
    const args=[vitest,'run',...tests];
    report.commands.push({command:node,args,log:'native-tests.log'});
    console.log(`Running ${tests.length} permanent suites against real SQLite; missing native capabilities fail this lane.`);
    report.testExitCode=await run(node,args,join(evidenceDir,'native-tests.log'),environment);
    report.additionalCommands=[];
    for (const [kind,additional] of [['selfHostedNative',manifest.selfHostedNative],['browserOnly',manifest.browserOnly]]) {
        if (!additional.length || (suite === 'business' && kind === 'selfHostedNative') || (suite === 'core' && kind === 'browserOnly')) continue;
        const args=[vitest,'run',...additional];
        const exitCode=await run(node,args,join(evidenceDir,`${kind}-tests.log`),{...environment,MOMOKI_STORAGE_TEST_OWNER:'indexeddb'});
        report.additionalCommands.push({kind,command:node,args,exitCode,log:`${kind}-tests.log`,note:kind === 'selfHostedNative' ? 'Suites construct and exercise their own real Rust probe; IndexedDB is only the unrelated global setup.' : 'Explicit browser capability regressions; these are not SQLite business evidence.'});
    }
    report.coverage=await coverage(environment.MOMOKI_TOOL_COVERAGE_DIR,registry);
    report.coverage.missingNativeCommittedTables=currentTables.filter(name=>!report.coverage.tables.some(row=>row.table === name && row.owners.includes('sqlite')));
    report.coverage.missingNativeBusinessTables=currentTables.filter(name=>!report.coverage.tables.some(row=>row.table === name && row.nativeBusinessCommits.length));
    report.coverage.ownerAssertionCommits=ownerAssertions.groups.map(group=> {
        const pattern=new RegExp(group.case.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/%[sijdfoO]/g,'.+?'));
        const tables=group.tables.map(table=>({table,commits:report.coverage.tables.find(row=>row.table === table)?.nativeBusinessCommits.filter(row=>row.file.endsWith(group.file) && pattern.test(row.test)) ?? []}));
        return {...group,tables};
    });
    report.coverage.missingNativeOwnerAssertions=report.coverage.ownerAssertionCommits.flatMap(group=>group.tables.filter(table=>!table.commits.length).map(table=>table.table));
    await writeFile(join(evidenceDir,'tool-and-table-coverage.json'),JSON.stringify(report.coverage,null,2)+'\n');
}
report.sourceAfter=await identity();
report.changedInputs=[...new Set([...Object.keys(before),...Object.keys(report.sourceAfter)])].filter(file=>before[file] !== report.sourceAfter[file]);
report.finishedAt=new Date().toISOString();
report.exitCode=report.buildExitCode || report.testExitCode || (report.additionalCommands?.some(command=>command.exitCode !== 0) ? 1 : 0) || (report.changedInputs.length ? 1 : 0) || (suite !== 'core' && (report.coverage.missingSuccessfulExecutions.length || report.coverage.missingValidArguments.length || report.coverage.missingInvalidArguments.length || (suite === 'all' && (report.coverage.missingNativeCommittedTables.length || report.coverage.missingNativeBusinessTables.length || report.coverage.missingNativeOwnerAssertions.length))) ? 1 : 0);
await writeFile(join(evidenceDir,'acceptance.json'),JSON.stringify(report,null,2)+'\n');
console.log(`Native acceptance ${report.exitCode === 0 ? 'passed' : 'failed'}; evidence: ${evidenceDir}`);
if (report.changedInputs.length) console.log(`Source changed during the run (${report.changedInputs.length} paths); rerun after edits settle.`);
process.exitCode=report.exitCode;
