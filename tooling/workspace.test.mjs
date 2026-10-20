import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {test} from 'node:test';
import {workspaceFixture} from './quality-fixture.mjs';
import {assembleWeb} from './assemble-web.mjs';

test('actual architecture CLI rejects package bypasses and omitted owned sources', async () => {
    const f = await workspaceFixture();
    try {
        assert.equal((await f.check()).result.exitCode, 0);
        for (const source of [
            'import {value} from "@momoki/studio/entry"; console.log(value);',
            'import type {value} from "@momoki/studio/entry";',
            'import {value} from "../../desktop/src/main"; console.log(value);',
            'import {value} from "../../../packages/distribution/src/main"; console.log(value);',
            'import {value} from "@momoki/distribution/private"; console.log(value);',
            'import {value} from "@/lib/private"; console.log(value);',
        ]) {
            await f.write('apps/site/src/main.ts', source);
            const {result, report} = await f.check();
            assert.equal(result.exitCode, 1, `${source}: ${result.stderr}`);
            assert.ok(report.failures.some(row => /package|source-alias/.test(row.kind)), source);
        }
        await f.write('apps/site/src/main.ts', 'export const value = 1;');
        await f.write('apps/site/src/omitted.ts', 'export const omitted = 1;');
        await f.write('tsconfig.app.json', {...f.config, exclude: ['apps/site/src/omitted.ts']});
        const omitted = await f.check();
        assert.equal(omitted.result.exitCode, 1);
        assert.ok(omitted.report.failures.some(row => row.kind === 'owned-source-not-scanned' && row.file === 'apps/site/src/omitted.ts'));
        await f.write('tsconfig.app.json', f.config);
        await f.write('quality/workspaces.json', {...f.policy, packages: f.policy.packages.filter(row => row.name !== '@momoki/site')});
        assert.equal((await f.check()).result.exitCode, 2);
        await f.write('quality/workspaces.json', {...f.policy, packages: f.policy.packages.map(row => row.name === '@momoki/site' ? {...row, sources: []} : row)});
        assert.equal((await f.check()).result.exitCode, 2);
        await rm(join(f.directory,'quality/workspaces.json'));
        assert.equal((await f.check()).result.exitCode,2);
    } finally {await rm(f.directory, {recursive: true, force: true});}
});

test('actual CLI follows exported reusable roots into source and rejects private and environment imports', async () => {
    const f = await workspaceFixture();
    try {
        const core=f.policy.packages.find(row=>row.name === '@momoki/agent-core');
        assert.ok(core);
        await f.write(`${core.path}/package.json`, {name:core.name, exports:{'.':{types:'./dist/main.d.ts',import:'./dist/main.js'}}});
        await f.write(`${core.path}/tsconfig.json`,{compilerOptions:{rootDir:'src',outDir:'dist'}});
        await f.write('quality/workspaces.json', {...f.policy, packages:f.policy.packages.map(row=>row === core ? {...row,publicSources:{'.':'src/main.ts'}} : row)});
        await f.write('packages/studio/src/main.ts','import {value} from "@momoki/agent-core"; console.log(value);');
        const positive=await f.check();
        assert.equal(positive.result.exitCode,0,JSON.stringify(positive.report.failures));
        assert.ok(positive.report.sections.architecture.edges.some(edge=>edge.from === 'packages/studio/src/main.ts' && edge.to === 'packages/agent-core/src/main.ts' && edge.internal));
        await f.write(`${core.path}/package.json`, {name:core.name, exports:{'.':{types:'./dist/main.d.ts',import:'./dist/other.js'}}});
        assert.equal((await f.check()).result.exitCode,2);
        await f.write(`${core.path}/package.json`, {name:core.name, exports:{'.':{types:'./dist/main.d.ts',import:'./dist/main.js'}}});
        for (const [file,source,reason] of [
            ['packages/studio/src/main.ts','import "@momoki/agent-core/private";','private-package-import'],
            ['packages/agent-core/src/main.ts','import "node:fs";','core-external-import'],
            ['packages/agent-core/src/main.ts','import "vitest";','core-external-import'],
            ['packages/agent-core/src/main.ts','import "@momoki/studio/entry";','core-external-import'],
            ['packages/agent-core/src/main.ts','import "../../studio/src/main";','reusable-relative-import-escape'],
            ['packages/agent-core/src/main.ts','import "../../../node_modules/react/index.js";','reusable-relative-import-escape'],
        ]) {
            await f.write('packages/studio/src/main.ts','export const value=1;');
            await f.write('packages/agent-core/src/main.ts','export const value=1;');
            await f.write(file,source);
            const checked=await f.check();
            assert.equal(checked.result.exitCode,1,JSON.stringify(checked.report));
            assert.ok(checked.report.failures.some(row=>row.kind === reason),reason);
        }
        await f.write('packages/agent-core/src/main.ts','export const value=1;');
        const provider=f.policy.packages.find(row=>row.name === '@momoki/agent-providers');
        assert.ok(provider);
        await f.write(`${provider.path}/src/http.ts`, 'export const read=1;');
        await f.write(`${provider.path}/package.json`, {name:provider.name, dependencies:{'@momoki/agent-core':'workspace:*'}, exports:{'.':{types:'./dist/main.d.ts',import:'./dist/main.js'},'./http':{types:'./dist/http.d.ts',import:'./dist/http.js'}}});
        await f.write(`${provider.path}/tsconfig.json`, {compilerOptions:{rootDir:'src',outDir:'dist'}});
        await f.write('quality/workspaces.json', {...f.policy, packages:f.policy.packages.map(row=>row === core ? {...row,publicSources:{'.':'src/main.ts'}} : row === provider ? {...row,publicSources:{'.':'src/main.ts','./http':'src/http.ts'}} : row)});
        await f.write('packages/studio/src/main.ts', 'import {read} from "@momoki/agent-providers/http"; console.log(read);');
        assert.equal((await f.check()).result.exitCode,0);
        for (const [file,source,reason] of [
            ['packages/studio/src/main.ts','import "@momoki/agent-providers/http/private";','private-package-import'],
            ['packages/agent-providers/src/main.ts','import "@momoki/studio/entry";','provider-external-import'],
            ['packages/agent-providers/src/main.ts','import "node:fs";','provider-external-import'],
            ['packages/agent-providers/src/main.ts','import "../../studio/src/main";','reusable-relative-import-escape'],
            ['packages/agent-providers/src/main.ts','import "../../../node_modules/react/index.js";','reusable-relative-import-escape'],
        ]) {
            await f.write('packages/studio/src/main.ts','export const value=1;');
            await f.write('packages/agent-providers/src/main.ts','export const value=1;');
            await f.write(file,source);
            const checked=await f.check();
            assert.equal(checked.result.exitCode,1,JSON.stringify(checked.report));
            assert.ok(checked.report.failures.some(row=>row.kind === reason),reason);
        }
        await f.write('packages/agent-providers/src/main.ts','export const value=1;');
        for (const source of [
            'import "@momoki/studio/entry";',
            'import type {value} from "@momoki/studio/entry";',
            'import "../../../packages/studio/src/main";',
            'import "@/features/agent/runtime/runChat";',
            'import "@momoki/agent-core/private";',
        ]) {
            await f.write('examples/agent-todo/src/main.ts',source);
            const checked=await f.check();
            assert.equal(checked.result.exitCode,1,JSON.stringify(checked.report));
            assert.ok(checked.report.failures.some(row=>/package|source-alias/.test(row.kind)),source);
        }
        await f.write('examples/agent-todo/src/main.ts','export const value=1;');
        await f.write('examples/unregistered/package.json',{name:'@momoki/unregistered'});
        await f.write('examples/unregistered/src/main.ts','export const value=1;');
        assert.equal((await f.check()).result.exitCode,2);
    } finally {await rm(f.directory,{recursive:true,force:true});}
});

test('web/site assembly preserves both entries and rejects incomplete or conflicting closure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'momoki-web-assembly-'));
    const write = async (file, value) => {await mkdir(dirname(join(directory, file)), {recursive: true}); await writeFile(join(directory, file), typeof value === 'string' ? value : JSON.stringify(value));};
    const web = join(directory, 'web'), site = join(directory, 'site'), output = join(directory, 'output');
    const manifest = (name, entry) => ({[entry]: {isEntry: true, file: `assets/${name}.js`}});
    try {
        for (const [name, entry] of [['web', 'index.html'], ['site', 'landing.html']]) {
            await write(`${name}/${entry}`, `<script type="module" src="/assets/${name}.js"></script>`);
            await write(`${name}/assets/${name}.js`, `console.log(${JSON.stringify(name)});`);
            await write(`${name}/brand/shared.png`, 'identical-shared-bytes');
            await write(`${name}/.vite/manifest.json`, manifest(name, entry));
            await write(`${name}/.vite/chunk-modules.json`, {[`assets/${name}.js`]: [`apps/${name}/src/main.ts`]});
        }
        await assembleWeb({web, site, output});
        assert.deepEqual(Object.keys(JSON.parse(await readFile(join(output, '.vite/manifest.json'), 'utf8'))).sort(), ['index.html', 'landing.html']);
        assert.equal(await readFile(join(output, 'brand/shared.png'), 'utf8'), 'identical-shared-bytes');
        await write('site/brand/shared.png', 'conflict');
        await assert.rejects(assembleWeb({web, site, output}), /Output file collision/);
        assert.equal(await readFile(join(output, 'brand/shared.png'), 'utf8'), 'identical-shared-bytes');
        await write('site/brand/shared.png', 'identical-shared-bytes');
        await write('site/.vite/manifest.json', {...manifest('site', 'landing.html'), 'index.html': {file: 'different.js'}});
        await assert.rejects(assembleWeb({web, site, output}), /Output report collision/);
        await write('site/.vite/manifest.json', {'landing.html': {isEntry: true, file: 'missing.js'}});
        await assert.rejects(assembleWeb({web, site, output}), /Missing output file/);
        await write('site/.vite/manifest.json', {'landing.html': {isEntry: true, file: 'assets/site.js', imports: ['missing-key']}});
        await assert.rejects(assembleWeb({web, site, output}), /Missing manifest edge/);
        await write('site/.vite/manifest.json', manifest('site', 'landing.html'));
        await write('site/landing.html', '<script type="module" src="/missing.js"></script>');
        await assert.rejects(assembleWeb({web, site, output}), /Missing HTML resource/);
        await write('site/landing.html', '<script type="module" src="/assets/web.js"></script>');
        await assert.rejects(assembleWeb({web, site, output}), /HTML entry does not load its manifest module/);
        await write('site/landing.html', '<script type="module" src="/assets/site.js"></script><link rel="stylesheet" href="/missing.css">');
        await assert.rejects(assembleWeb({web, site, output}), /Missing HTML resource/);
        await write('site/landing.html', '<script type="module" src="/assets/site.js"></script>');
        await write('site/.vite/chunk-modules.json', {});
        await assert.rejects(assembleWeb({web, site, output}), /Missing module report/);
    } finally {await rm(directory, {recursive: true, force: true});}
});
