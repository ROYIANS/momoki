import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function workspacePolicy(root) {
    if (!existsSync(join(root, 'pnpm-workspace.yaml'))) return {packages: [], roots: ['src/']};
    const document = JSON.parse(readFileSync(join(root, 'quality/workspaces.json'), 'utf8'));
    const actual = [];
    for (const family of ['apps', 'packages', 'examples']) for (const entry of existsSync(join(root, family)) ? readdirSync(join(root, family), {withFileTypes: true}) : []) {
        if (entry.isDirectory() && existsSync(join(root, family, entry.name, 'package.json'))) actual.push(`${family}/${entry.name}`);
    }
    const declared = document.packages.map(row => row.path);
    if (new Set(declared).size !== declared.length || [...declared].sort().join() !== actual.sort().join()) throw new Error('Workspace coverage does not match actual application/library packages');
    const roots = [];
    for (const row of document.packages) {
        const pkg = JSON.parse(readFileSync(join(root, row.path, 'package.json'), 'utf8'));
        if (pkg.name !== row.name || !row.sources.includes('src') || !existsSync(join(root, row.path, 'src'))) throw new Error(`Missing registered owned source root: ${row.path}/src`);
        const internal = Object.entries({...pkg.dependencies, ...pkg.devDependencies}).filter(([name]) => name.startsWith('@momoki/'));
        if (internal.some(([name, version]) => !row.dependencies.includes(name) || version !== 'workspace:*')) throw new Error(`Forbidden workspace dependency: ${row.name}`);
        for (const [key, source] of Object.entries(row.publicSources ?? {})) {
            const target = pkg.exports?.[key];
            const compiler = JSON.parse(readFileSync(join(root,row.path,'tsconfig.json'),'utf8')).compilerOptions;
            const stem = source.replace(/^src\//,'./dist/').replace(/\.ts$/,'');
            if (!target || !source.startsWith('src/') || !source.endsWith('.ts') || source.includes('..') || !existsSync(join(root, row.path, source)) || compiler.rootDir !== 'src' || compiler.outDir !== 'dist' || target.types !== `${stem}.d.ts` || target.import !== `${stem}.js`) throw new Error(`Invalid public source mapping: ${row.name}${key}`);
        }
        if (row.publicSources && Object.keys(pkg.exports).sort().join() !== Object.keys(row.publicSources).sort().join()) throw new Error(`Incomplete public source mapping: ${row.name}`);
        for (const source of row.sources) {
            if (!source || source.includes('..') || !existsSync(join(root, row.path, source))) throw new Error(`Missing owned source root: ${row.path}/${source}`);
            roots.push(`${row.path}/${source}/`);
        }
    }
    return {...document, roots};
}

export function packageBoundary(edge, policy) {
    const owner = file => policy.packages.find(row => file.startsWith(`${row.path}/`));
    const from = owner(edge.from), to = owner(edge.to);
    if (from && ['@momoki/agent-core','@momoki/agent-providers'].includes(from.name) && edge.specifier.startsWith('.') && !edge.to.startsWith(`${from.path}/src/`)) return 'reusable-relative-import-escape';
    if (!from || !to) return undefined;
    if (edge.specifier.startsWith('@/') && from.name !== '@momoki/studio') return 'foreign-source-alias';
    if (from === to) return undefined;
    if (!from.dependencies.includes(to.name)) return 'forbidden-package-edge';
    if (edge.specifier !== to.name && !edge.specifier.startsWith(`${to.name}/`)) return 'cross-package-source-traversal';
    return undefined;
}

/** Analysis only: runtime exports remain the built ESM/declarations. */
export function publicSourcePaths(policy) {
    return Object.fromEntries(policy.packages.flatMap(row => Object.entries(row.publicSources ?? {}).map(([key, source]) => [key === '.' ? row.name : `${row.name}${key.slice(1)}`, [`${row.path}/${source}`]])));
}

export function ownedTypescriptFiles(root, policy) {
    const files = [];
    function visit(directory) {
        for (const entry of readdirSync(join(root, directory), {withFileTypes: true})) {
            const file = `${directory}/${entry.name}`;
            if (entry.isDirectory()) visit(file);
            else if (entry.isFile() && /\.[cm]?tsx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file)) files.push(file);
        }
    }
    for (const prefix of policy.roots) visit(prefix.replace(/\/$/, ''));
    return files.sort();
}

export function importContract(from, specifier, root, policy) {
    const owner = policy.packages.find(row => from.startsWith(`${row.path}/`));
    if (!owner) return undefined;
    if (/\.test\.tsx?$/.test(from) && (specifier === owner.name || specifier.startsWith(`${owner.name}/`))) {
        const manifest = JSON.parse(readFileSync(join(root,owner.path,'package.json'),'utf8'));
        const key = specifier === owner.name ? '.' : `.${specifier.slice(owner.name.length)}`;
        return Object.hasOwn(manifest.exports ?? {}, key) ? undefined : 'private-package-import';
    }
    if (specifier === 'vitest' && /\.test\.tsx?$/.test(from) && JSON.parse(readFileSync(join(root,owner.path,'package.json'),'utf8')).devDependencies?.vitest) return undefined;
    if (owner.name === '@momoki/agent-core' && !specifier.startsWith('.')) return 'core-external-import';
    if (owner.name === '@momoki/agent-providers' && !specifier.startsWith('.') && specifier !== '@momoki/agent-core') return 'provider-external-import';
    if (specifier.startsWith('@/') && owner.name !== '@momoki/studio') return 'foreign-source-alias';
    if (!specifier.startsWith('@momoki/')) return undefined;
    const target = policy.packages.find(row => specifier === row.name || specifier.startsWith(`${row.name}/`));
    if (!target || (target !== owner && !owner.dependencies.includes(target.name))) return 'forbidden-package-import';
    const manifest = JSON.parse(readFileSync(join(root, target.path, 'package.json'), 'utf8'));
    const key = specifier === target.name ? '.' : `.${specifier.slice(target.name.length)}`;
    if (!Object.hasOwn(manifest.exports ?? {}, key)) return 'private-package-import';
    return undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const policy = workspacePolicy(fileURLToPath(new URL('../', import.meta.url)));
    console.log(`Workspace coverage: ${policy.packages.length} packages, ${policy.roots.length} registered source roots`);
}
