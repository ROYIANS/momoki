import {mkdtemp, mkdir, readFile, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runCommand} from './quality/unused.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function workspaceFixture() {
    const directory = await mkdtemp(join(tmpdir(), 'momoki-workspace-gate-'));
    const write = async (file, value) => {await mkdir(dirname(join(directory, file)), {recursive: true}); await writeFile(join(directory, file), typeof value === 'string' ? value : JSON.stringify(value));};
    await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    const policy = JSON.parse(await readFile(join(root, 'quality/workspaces.json'), 'utf8'));
    for (const row of policy.packages) delete row.publicSources;
    await write('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n  - 'packages/*'\n  - 'examples/*'\n");
    await write('quality/workspaces.json', policy);
    await write('package.json', {private: true, type: 'module'});
    const paths = {};
    for (const row of policy.packages) {
        delete row.publicSources;
        const dependencies = Object.fromEntries(row.dependencies.map(name => [name, 'workspace:*']));
        await write(`${row.path}/package.json`, {name: row.name, private: true, exports: {'./entry': './src/main.ts'}, dependencies});
        await write(`${row.path}/src/main.ts`, `export const value = ${JSON.stringify(row.name)};\n`);
        paths[`${row.name}/entry`] = [`${row.path}/src/main.ts`];
    }
    const config = {compilerOptions: {target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', baseUrl: '.', paths}, include: ['apps/*/src', 'packages/*/src', 'examples/*/src']};
    await write('tsconfig.app.json', config);
    await write('quality/studio-ownership.json', {schemaVersion: 1, phase: 'complete', files: [{file: 'packages/studio/src/main.ts', target: 'packages/studio/src/main.ts', owner: 'main.ts', public: false}], featureUiAppEntries: [], storageParserEntries: []});
    const check = async () => {
        const result = await runCommand(process.execPath, [join(root, 'tooling/quality-check.mjs'), '--root', directory, '--only', 'architecture', '--report', join(directory, 'report.json')], root);
        const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
        return {result, report};
    };
    return {directory, policy, config, write, check};
}
