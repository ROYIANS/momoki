import assert from 'node:assert/strict';
import {rm, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {workspaceFixture} from './quality-fixture.mjs';
import {snapshotOwner, snapshotModule} from './snapshot-owners.ts';
import {historicalSource} from './historical-source.mjs';

const prefix = 'packages/studio/src/';
test('actual architecture CLI enforces Studio ownership, typed APIs and layer boundaries', async () => {
    const f = await workspaceFixture();
    const files = [
        ['app/main.ts', 'app', false],
        ['features/audio/commands/write.ts', 'features/audio', true],
        ['features/audio/commands/private.ts', 'features/audio', false],
        ['features/audio/models/model.ts', 'features/audio', true, ['Model']],
        ['features/audio/ui/view.ts', 'features/audio', false],
        ['features/music/commands/write.ts', 'features/music', true],
        ['db/music.ts', 'features/music', true],
        ['platform/storage/adapter.ts', 'platform/storage', false],
        ['platform/product/store.ts', 'platform/product', false],
        ['platform/runtime/http.ts', 'platform/runtime', false],
        ['app/composition.ts', 'app', false],
        ['app/page.ts', 'app', false],
        ['ui/control.ts', 'ui', false],
    ];
    const policy = {schemaVersion: 1, phase: 'audio-pilot', files: files.map(([file, owner, publicEntry, publicTypes = []]) => ({file: prefix + file, target: prefix + file, owner, public: publicEntry, publicTypes})), featureUiAppEntries: [{file: 'app/page.ts', symbols: ['page']}], storageParserEntries: []};
    const reset = async () => {
        for (const [file] of files) await f.write(prefix + file, 'export const value = 1; export type Model = {id: string}; export const page = 1;');
        await f.write('quality/studio-ownership.json', policy);
    };
    try {
        await unlink(join(f.directory, prefix + 'main.ts'));
        await reset();
        assert.equal((await f.check()).result.exitCode, 0);
        const cases = [
            ['db/music.ts', 'import "../features/audio/ui/view";', 'private-feature-import'],
            ['db/music.ts', 'import {value} from "../features/audio/commands/private";', 'private-feature-import'],
            ['features/music/commands/write.ts', 'import {value} from "../../audio/commands/private";', 'private-feature-import'],
            ['features/music/commands/write.ts', 'import type {Model} from "../../audio/ui/view";', 'private-feature-type-import'],
            ['features/audio/commands/write.ts', 'import {value} from "../ui/view";', 'feature-data-ui-edge'],
            ['features/audio/commands/write.ts', 'import type {Model} from "../ui/view";', 'feature-data-ui-edge'],
            ['features/audio/commands/write.ts', 'import type {page} from "../../../app/page";', 'feature-app-runtime-edge'],
            ['platform/product/store.ts', 'import {value} from "../../app/composition";', 'platform-app-edge'],
            ['platform/runtime/http.ts', 'import {value} from "../../app/composition";', 'platform-app-edge'],
            ['platform/storage/adapter.ts', 'import {value} from "../product/store";', 'storage-integration-edge'],
            ['platform/storage/adapter.ts', 'import {useState} from "react";', 'storage-integration-edge'],
            ['ui/control.ts', 'import {value} from "../features/audio/commands/write";', 'neutral-ui-business-edge'],
            ['features/audio/commands/write.ts', 'import {page} from "../../../app/page";', 'feature-app-runtime-edge'],
            ['features/audio/ui/view.ts', 'import "../../../app/page";', 'feature-app-runtime-edge'],
            ['features/audio/ui/view.ts', 'import {value} from "../../../app/page";', 'feature-app-runtime-edge'],
        ];
        for (const [file, source, kind] of cases) {
            await reset();
            await f.write(prefix + file, source);
            const {result, report} = await f.check();
            assert.equal(result.exitCode, 1, `${file}: ${source}: ${result.stderr}`);
            assert.ok(report.failures.some(row => row.kind === kind), JSON.stringify(report.failures));
        }
        await reset();
        await f.write(prefix + 'features/music/commands/write.ts', 'import type {Model} from "../../audio/models/model"; export type MusicModel = Model;');
        await f.write(prefix + 'features/audio/ui/view.ts', 'import {page} from "../../../app/page"; console.log(page);');
        assert.equal((await f.check()).result.exitCode, 0);
        await reset();
        await f.write(prefix + 'omitted.css', 'body{}');
        assert.ok((await f.check()).report.failures.some(row => row.kind === 'unmapped-studio-source'));
        await unlink(join(f.directory, prefix + 'omitted.css'));
        await f.write('quality/studio-ownership.json', {...policy, files: [...policy.files, policy.files[0]]});
        assert.ok((await f.check()).report.failures.some(row => row.kind === 'duplicate-studio-owner'));
        await f.write('quality/studio-ownership.json', {...policy, phase: 'complete', files: policy.files.map((row, i) => i ? row : {...row, target: prefix + 'app/renamed.ts'})});
        assert.ok((await f.check()).report.failures.some(row => row.kind === 'pending-studio-relocation'));
        await f.write('quality/studio-ownership.json', {...policy, files: policy.files.map((row, i) => i ? row : {...row, original: prefix + 'app/page.ts'})});
        assert.ok((await f.check()).report.failures.some(row => row.kind === 'old-studio-source-bridge'));
        await f.write('quality/studio-ownership.json', {...policy, phase: 'complete', files: policy.files.map((row, i) => i ? row : {...row, owner: 'features/audio'})});
        assert.ok((await f.check()).report.failures.some(row => row.kind === 'studio-owner-path-mismatch'));
        await unlink(join(f.directory, 'quality/studio-ownership.json'));
        const missing = await f.check();
        assert.equal(missing.result.exitCode, 1);
        assert.ok(missing.report.failures.some(row => row.kind === 'missing-studio-ownership-policy'));
    } finally {await rm(f.directory, {recursive: true, force: true});}
});

test('immutable source owner resolution never grants a current legacy alias bridge', () => {
    const root = process.cwd();
    const historical = root + '/tests/fixtures/sourceSnapshots/d05/src/lib/agent/materialTools.ts';
    const current = root + '/tests/current-owner.test.ts';
    assert.equal(snapshotOwner('@/domain/types', current), undefined);
    assert.equal(snapshotOwner('@/db/database', current), undefined);
    assert.equal(snapshotOwner('@/db/materials', historical), root + '/tests/fixtures/e07/original-materials-adapter.ts');
    assert.equal(snapshotOwner(root + '/packages/studio/src/domain/types', historical), '\0snapshot-owner:@/domain/types');
    assert.equal(snapshotOwner('@/lib/productionRevision', historical), '\0snapshot-owner:@/lib/productionRevision');
    const module = snapshotModule('\0snapshot-owner:@/domain/types');
    assert.ok(module.includes('export {getProjectKind}'));
    assert.ok(!module.includes('export {Id}'));
    assert.ok(!module.includes('export {Project}'));
});

test('explicit historical delivery relocates module references and preserves product literals', () => {
    const original = 'import {db} from "./database";\nimport type {Id, Project} from "@/domain/types";\nimport {PRODUCT_NAME_ZH} from "@/lib/brand";\nconst accept = ".wav,.mp3,audio/wav,audio/mpeg";\nconst key = ".";';
    const delivered = historicalSource(original, 'db/projectMemories.ts');
    assert.ok(delivered.includes('from "@/platform/product/store"'));
    assert.ok(delivered.includes('import type {Id} from "@/platform/identity"'));
    assert.ok(delivered.includes('import type {Project} from "@/features/projects/models/project"'));
    assert.ok(delivered.includes('from "@momoki/distribution/brand"'));
    assert.equal(delivered.slice(delivered.indexOf('const accept')), original.slice(original.indexOf('const accept')));
});
