import {mediaWorkspaceRef, resolveWorkspaceRef, workspaceId} from '@momoki/studio/reference/lib/workspace';
import {Sha256} from '@momoki/studio/reference/lib/sha256';
import {STUDIO_LIBRARY_ID} from "@momoki/studio/reference/features/library/models/ownership";
import type {WorkspaceRef} from '@momoki/studio/reference/lib/workspace';

export function contractCorpus() {
    const id = workspaceId('b844e02c-8e56-4dc0-90e6-ab9d57b27f05');
    const ids = ['Project', 'project', 'é', 'e\u0301', '项目🌹', 'CON', '../a\\b:c', ' trailing ', '\u0000x', '\u0085'];
    const references = ids.map((projectId, index) => {
        const assetId = ids[ids.length - index - 1];
        const reference = mediaWorkspaceRef(id, projectId, assetId);
        return {assetId, reference, resolved: resolveWorkspaceRef(reference, {workspaceId: id, absolutePath: '/temporary/oracle'})};
    });
    const studioRef = mediaWorkspaceRef(id, STUDIO_LIBRARY_ID, '声音🌹');
    references.push({assetId: '声音🌹', reference: studioRef, resolved: resolveWorkspaceRef(studioRef, {workspaceId: id, absolutePath: '/temporary/oracle'})});
    const valid = mediaWorkspaceRef(id, 'Project', 'asset');
    const invalid: {assetId: string; reference: WorkspaceRef; rejectedByOracle: boolean}[] = [];
    for (const change of [{workspaceId: workspaceId('foreign')}, {projectId: 'foreign'}, {relativePath: '../asset'}, {relativePath: valid.relativePath.toUpperCase()}, {relativePath: `${valid.relativePath}/other`}, {relativePath: 'studio/assets/id-6161'}]) {
        const reference = {...valid, ...change};
        let rejectedByOracle = false;
        try { resolveWorkspaceRef(reference, {workspaceId: id, absolutePath: '/temporary/oracle'}); } catch { rejectedByOracle = true; }
        invalid.push({assetId: 'asset', reference, rejectedByOracle});
    }
    const malformedIds = ['', '  ', '\ufeff', '\ud800', '\udfff'];
    const rejectedIdentities = malformedIds.map(value => {
        let rejected = false;
        try { mediaWorkspaceRef(id, 'Project', value); } catch { rejected = true; }
        return {rawJson: JSON.stringify(value), rejected};
    });
    const hashes = [0, 1, 55, 56, 63, 64, 65, 127, 128, 257, 262151].map(length => {
        const bytes = Uint8Array.from({length}, (_, index) => index % 251);
        const hash = new Sha256();
        for (let offset = 0; offset < length; offset += 37) hash.update(bytes.subarray(offset, offset + 37));
        hash.update(new Uint8Array());
        return {length, sha256: hash.digest()};
    });
    return {format: 'momoki.native-contract-corpus.v1', workspaceId: id, references, invalid, rejectedIdentities, hashes};
}
