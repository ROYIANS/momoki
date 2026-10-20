import {db} from "./store";

export const AUDIO_TABLES = [db.audioChapters, db.audioSpeakers, db.audioSegments, db.audioTakes, db.audioTracks, db.audioClips, db.audioExports, db.musicDrafts, db.musicWorks, db.audioGenerationJobs, db.audioGenerationBatches, db.audioGenerationBatchItems, db.audioArrangementProposals];

export const AUDIO_TRANSACTION_TABLES = [db.projects, db.media, ...AUDIO_TABLES];

// Media recycling must hold the same lock as every committed slot/cover writer.
export const PRODUCTION_TABLES = [
    ...AUDIO_TABLES,
    db.projects, db.episodes, db.characters, db.scenes,
    db.props, db.styles, db.shots, db.media, db.ipProfiles, db.materialUses, db.productionProposals, db.agentGenerationJobs, db.agentGenerationBatches, db.agentGenerationBatchItems, db.projectReferences, db.referenceChunks,
];
