import type {InstalledSkillDescriptor, SkillMetadata} from "@momoki/agent-core";

export interface SkillComponent {
    readonly path: string;
    readonly digest: string;
    readonly byteLength: number;
    readonly ordinal: number;
}

export interface SkillManifest {
    readonly version: 1;
    readonly revision: string;
    readonly metadata: SkillMetadata;
    readonly document: SkillComponent;
    readonly resources: readonly SkillComponent[];
}

export interface SkillTextRecord {
    readonly version: 1;
    readonly revision: string;
    readonly path: string;
    readonly text: string;
}

export interface SkillImportFile {readonly path: string; readonly bytes: Uint8Array}
export interface SkillImportExclusions {readonly count: number; readonly paths: readonly string[]}
export interface SkillImportCandidate {
    readonly version: 1;
    readonly directoryName: string;
    readonly manifest: SkillManifest;
    readonly document: SkillTextRecord;
    readonly resources: readonly SkillTextRecord[];
    readonly exclusions: SkillImportExclusions;
    readonly serializedBytes: number;
}

export interface InstalledSkill extends InstalledSkillDescriptor {
    readonly enabled: boolean;
    readonly installedAt: string;
    readonly updatedAt: string;
    readonly source: {readonly kind: "directory"; readonly label: string};
}

export type SkillMutationKind = "install" | "update" | "enable" | "uninstall";
export interface SkillMutationReceipt {
    readonly operationId: string;
    readonly fingerprint: string;
    readonly kind: SkillMutationKind;
    readonly skillId: string;
    readonly revision: string;
    readonly catalogueRevision: number;
}

export interface SkillCatalogue {
    readonly version: 1;
    readonly revision: number;
    readonly entries: readonly InstalledSkill[];
    readonly retainedRevisions: readonly string[];
    readonly serializedBytes: number;
    readonly lastOperation?: SkillMutationReceipt;
}

export interface SkillRetention {
    readonly version: 1;
    readonly revision: string;
    readonly currentReferences: number;
    readonly runReferences: number;
    readonly serializedBytes: number;
}

/** Separate from builtin skill IDs and executable capability snapshots. */
export interface InstalledSkillsSnapshot {
    readonly version: 1;
    readonly entries: readonly InstalledSkillDescriptor[];
}

export interface SkillMutationExpectation {
    readonly operationId: string;
    readonly catalogueRevision: number;
}
