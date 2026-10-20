import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildAgentPackages} from './build-agent-packages.mjs';
import {assertAgentPackageFreshness, captureAgentPackageFiles} from './agent-package-inputs.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const machinePnpm = '/Users/xiaomengdao/.nvm/versions/node/v24.11.0/bin/pnpm';
const sha = value => createHash('sha256').update(value).digest('hex');

/** Execute the actual independent host using only packed public libraries outside this repository. */
async function checkAgentExample() {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 24 || major === 24 && minor < 11) throw new Error('agent:example:check requires Node >=24.11');
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const pinned = manifest.packageManager.split('@').at(-1);
    const evidence = await realpath(await mkdtemp(join(tmpdir(), 'momoki-agent-example-')));
    const artifacts = join(evidence, 'artifacts'), consumer = join(evidence, 'consumer'), store = join(evidence, 'empty-offline-store');
    await mkdir(artifacts); await mkdir(consumer);
    const env = {...process.env, COREPACK_ENABLE_NETWORK: '0', npm_config_registry: 'http://127.0.0.1:9', npm_config_manage_package_manager_versions: 'true', npm_config_package_manager_strict_version: 'true'};
    // Local development uses the explicitly approved machine pnpm; CI supplies its pinned runner path.
    const pnpm = process.env.MOMOKI_PNPM_PATH ?? (process.platform === 'darwin' ? machinePnpm : 'pnpm');
    const commands = [];
    async function run(label, command, args, cwd = root) {
        const result = spawnSync(command, args, {cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
        const row = {label, command, args, cwd, exitCode: result.status, signal: result.signal}; commands.push(row);
        await writeFile(join(evidence, `${String(commands.length).padStart(2, '0')}-${label}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
        if (result.error || result.status !== 0) throw new Error(`${label} failed; evidence ${evidence}`, {cause: result.error});
        return result.stdout;
    }
    try {
        assert.equal((await run('pnpm-version', pnpm, ['--version'])).trim(), pinned);
        await buildAgentPackages(); await assertAgentPackageFreshness();
        const capture = async () => {
            const inputs = {};
            const proofRequire = createRequire(join(root, 'package.json'));
            const nodeTypeManifest = proofRequire.resolve('@types/node/package.json');
            const undiciDirectory = relative(root, dirname(createRequire(nodeTypeManifest).resolve('undici-types/package.json'))).split('\\').join('/');
            for (const directory of ['examples/agent-todo/src', 'packages/agent-core/src', 'packages/agent-providers/src', 'packages/agent-core/dist', 'packages/agent-providers/dist', 'node_modules/@types/node', undiciDirectory, 'node_modules/typescript']) Object.assign(inputs, await captureAgentPackageFiles(root, directory));
            for (const file of ['examples/agent-todo/package.json', 'examples/agent-todo/tsconfig.json', 'packages/agent-core/package.json', 'packages/agent-core/tsconfig.json', 'packages/agent-providers/package.json', 'packages/agent-providers/tsconfig.json', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'quality/workspaces.json', 'tooling/agent-example-check.mjs', 'tooling/build-agent-packages.mjs', 'tooling/agent-package-inputs.ts', 'tooling/workspace.mjs', 'node_modules/typescript/package.json', 'node_modules/typescript/bin/tsc', 'node_modules/typescript/lib/tsc.js', 'node_modules/typescript/lib/_tsc.js']) inputs[file] = sha(await readFile(join(root, file)));
            return inputs;
        };
        const before = await capture();
        const archives = {};
        for (const part of ['agent-core', 'agent-providers']) {
            await run(`pack-${part}`, pnpm, ['pack', '--pack-destination', artifacts], join(root, 'packages', part));
            const files = await readdir(artifacts); const archive = files.find(file => file.startsWith(`momoki-${part}-`) && file.endsWith('.tgz'));
            assert.ok(archive); archives[part] = join(artifacts, archive);
            const contents = await run(`archive-${part}`, 'tar', ['-tzf', archives[part]], evidence);
            assert.equal(contents.split('\n').some(file => file.startsWith('package/src/')), false);
        }
        const core = JSON.parse(await run('manifest-core', 'tar', ['-xOf', archives['agent-core'], 'package/package.json'], evidence));
        const providers = JSON.parse(await run('manifest-providers', 'tar', ['-xOf', archives['agent-providers'], 'package/package.json'], evidence));
        assert.deepEqual(Object.keys(core.dependencies ?? {}), []);
        assert.deepEqual(providers.dependencies, {'@momoki/agent-core': core.version});
        const coreFile = `file:${relative(consumer, archives['agent-core'])}`, providerFile = `file:${relative(consumer, archives['agent-providers'])}`;
        await writeFile(join(consumer, 'package.json'), JSON.stringify({name: 'momoki-independent-agent-acceptance', private: true, type: 'module', packageManager: manifest.packageManager,
            dependencies: {'@momoki/agent-core': coreFile, '@momoki/agent-providers': providerFile}, pnpm: {overrides: {'@momoki/agent-core': coreFile}}}, null, 2));
        await run('outside-pnpm-version', pnpm, ['--version'], consumer);
        await run('offline-install', pnpm, ['install', '--offline', '--ignore-scripts', '--no-frozen-lockfile', '--store-dir', store], consumer);
        await run('offline-frozen-reinstall', pnpm, ['install', '--offline', '--ignore-scripts', '--frozen-lockfile', '--store-dir', store], consumer);
        const require = createRequire(join(root, 'package.json'));
        const compilerRoot = dirname(require.resolve('typescript/package.json'));
        const nodeTypes = dirname(require.resolve('@types/node/package.json'));
        const nodeRequire = createRequire(join(nodeTypes, 'package.json'));
        const undiciTypes = dirname(nodeRequire.resolve('undici-types/package.json'));
        const compiler = join(evidence, 'compiler');
        await cp(compilerRoot, compiler, {recursive: true, dereference: true});
        await cp(nodeTypes, join(consumer, 'node_modules/@types/node'), {recursive: true, dereference: true});
        await cp(undiciTypes, join(consumer, 'node_modules/undici-types'), {recursive: true, dereference: true});
        await cp(join(root, 'examples/agent-todo/src'), join(consumer, 'src'), {recursive: true});
        await cp(join(root, 'examples/agent-todo/tsconfig.json'), join(consumer, 'tsconfig.json'));
        await writeFile(join(consumer, 'src/public-types.ts'), `import {createToolFactory, type ToolContext} from '@momoki/agent-core';
import type {ResponseItem} from '@momoki/agent-providers';
interface Context extends ToolContext<{title:string}> {services:{add:(title:string)=>number}}
const define=createToolFactory<Context,{title:string}>();
const spec={schema:{parse:(_raw:unknown)=>({title:'todo'})},json:{}};
define(spec,{name:'add',title:'Add',description:'Add',effect:'write',highRisk:args=>args.title.length>2,execute:(args,context)=>Promise.resolve(context.services.add(args.title))});
// @ts-expect-error public declarations reject incompatible callback arguments
 define(spec,{name:'bad',title:'Bad',description:'Bad',effect:'read',highRisk:()=>false,execute:(args:{title:number})=>Promise.resolve(args.title)});
// @ts-expect-error preview has the host-selected validated shape
 const invalidPreview:Context['preview']={title:123};
// @ts-expect-error provider wire union rejects product-specific values
 const invalidWire:ResponseItem={type:'project',projectId:'invalid'};
// @ts-expect-error private library sources are not exported
 import type {ToolMetadata} from '@momoki/agent-core/src/tools.js';
void invalidPreview;void invalidWire;const privateType:ToolMetadata|undefined=undefined;void privateType;
`);
        const compile = await run('outside-strict-types', process.execPath, [join(compiler, 'bin/tsc'), '-p', join(consumer, 'tsconfig.json'), '--listFiles', '--pretty', 'false'], consumer);
        const typeFiles = compile.split(/\r?\n/).filter(file => isAbsolute(file));
        assert.ok(typeFiles.length > 10);
        assert.ok(typeFiles.every(file => !relative(evidence, file).startsWith('..')));
        assert.ok(typeFiles.some(file => file.includes('agent-core') && file.endsWith('.d.ts')));
        assert.ok(typeFiles.some(file => file.includes('agent-providers') && file.endsWith('.d.ts')));
        await writeFile(join(consumer, 'runtime-exports.mjs'), `import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';import {fileURLToPath} from 'node:url';import {registerHooks} from 'node:module';
const edges=[];registerHooks({resolve(specifier,context,next){const resolved=next(specifier,context);if(specifier==='@momoki/agent-core'&&context.parentURL?.includes('agent-providers'))edges.push(realpathSync(fileURLToPath(resolved.url)));return resolved;}});
await import('@momoki/agent-providers');const directCore=realpathSync(fileURLToPath(import.meta.resolve('@momoki/agent-core')));assert.ok(edges.length>0);assert.ok(edges.every(file=>file===directCore));console.log(JSON.stringify({sameCoreIdentity:true,providerCoreEdges:edges,directCore}));
for(const name of ['@momoki/agent-core','@momoki/agent-providers','@momoki/agent-providers/http']){const file=realpathSync(fileURLToPath(import.meta.resolve(name)));assert.ok(file.startsWith(${JSON.stringify(evidence)}));assert.ok(file.endsWith('.js'));console.log(name+' '+file);}
for(const name of ['@momoki/studio','react','dexie','@tauri-apps/api/core','@momoki/agent-core/src/runtime.js','@momoki/agent-providers/dist/responses.js'])await assert.rejects(import(name));
`);
        await run('outside-runtime-exports', process.execPath, ['runtime-exports.mjs'], consumer);
        const exampleFiles = Object.keys(await captureAgentPackageFiles(root, 'examples/agent-todo/src'));
        const testSources = exampleFiles.filter(file => /\.test\.ts$/.test(file)); assert.ok(testSources.length > 0);
        const testOutputs = testSources.map(file => file.replace('examples/agent-todo/src/', 'dist/').replace(/\.ts$/, '.js'));
        for (const output of testOutputs) await readFile(join(consumer, output));
        await run('outside-complete-conformance', process.execPath, ['--test', ...testOutputs], consumer);
        const after = await capture();
        assert.deepEqual(after, before);
        const archiveHashes = Object.fromEntries(await Promise.all(Object.entries(archives).map(async ([name, file]) => [name, sha(await readFile(file))])));
        const report = {exitCode: 0, evidence, consumer, node: process.versions.node, pnpm: pinned, packedCoreVersion: core.version, providerCoreVersion: providers.dependencies['@momoki/agent-core'], archiveHashes, inputs: before, testSources, testOutputs, typeFiles, commands};
        await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({agentExample: 'PASS', evidence, conformance: 'complete', archiveHashes}));
        return report;
    } catch (cause) {await writeFile(join(evidence, 'failure.json'), JSON.stringify({exitCode: 1, evidence, commands, error: cause.stack}, null, 2)); throw cause;}
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await checkAgentExample();
