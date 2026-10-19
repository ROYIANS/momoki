import type {AgentJob, AgentJobResultChunk} from "../../features/agent/models/agentJob";
import type {AgentPendingInput} from "../../features/agent/models/agentPendingInput";
import type {DesktopMediaImport} from "../../features/library/models/desktopMediaImport";
import type {
    AudioChapter,
    AudioClip,
    AudioExport,
    AudioSegment,
    AudioSpeaker,
    AudioTake,
    AudioTrack
} from "../../features/audio/models/audio";
import type {MusicDraft, MusicWork} from "../../features/music/models/music";
import type {AudioGenerationJob} from "../../features/audio/models/audioGeneration";
import type {AudioGenerationBatch, AudioGenerationBatchItem} from "../../features/audio/models/audioGenerationBatch";
import type {AudioArrangementProposal} from "../../features/audio/models/audioArrangement";
import type {
    IpProfile,
    LibraryMaterial,
    MaterialEvent,
    MaterialUse,
    MaterialVersion,
    ProjectIpLink
} from "../../features/library/models/materials";
import type {SearchConnection} from "../../features/settings/models/search";
import type {DeviceSetting} from "../../features/settings/models/deviceSettings";
import type {GenerationBatch, GenerationBatchItem} from "../../features/agent/models/agentGenerationBatch";
import type {ProjectReference, ReferenceChunk} from "../../features/references/models/references";
import type {ProjectMemory, ProjectMemoryVersion} from "../../features/memory/models/projectMemory";
import type {AgentTaskWrapup, AgentTaskWrapupVersion} from "../../features/agent/models/agentTaskWrapup";
import type {AgentTaskRecord, AgentTaskRecordVersion} from "../../features/agent/models/agentTaskRecords";
import type {AgentGenerationJob} from "../../features/agent/models/agentGeneration";
import type {ContextCompaction} from "../../features/agent/models/context";
import type {AgentConfig, AgentRun, AgentTask, AgentToolCall} from "../../features/agent/models/agent";
import type {ProductionProposal} from "../../features/video/models/production";
import type {Character, Prop, Scene, VisualStyle} from "./../../features/library/models/assets";
import type {ChatMessage, ChatThread} from "./../../features/agent/models/chat";
import type {ConnectorConfig} from "./../../features/settings/models/connector";
import type {Episode} from "./../../features/video/models/episodes";
import type {MediaRecord} from "./../../features/library/models/media";
import type {Project} from "./../../features/projects/models/project";
import type {Shot} from "./../../features/video/models/shots";

export interface ProductRows {
    desktopMediaImports: DesktopMediaImport;
    agentPendingInputs: AgentPendingInput;
    agentJobs: AgentJob;
    agentJobResultChunks: AgentJobResultChunk;
    audioChapters: AudioChapter;
    audioSpeakers: AudioSpeaker;
    audioSegments: AudioSegment;
    audioTakes: AudioTake;
    audioTracks: AudioTrack;
    audioClips: AudioClip;
    audioExports: AudioExport;
    musicDrafts: MusicDraft;
    musicWorks: MusicWork;
    audioGenerationJobs: AudioGenerationJob;
    audioGenerationBatches: AudioGenerationBatch;
    audioGenerationBatchItems: AudioGenerationBatchItem;
    audioArrangementProposals: AudioArrangementProposal;
    ipProfiles: IpProfile;
    projectIpLinks: ProjectIpLink;
    libraryMaterials: LibraryMaterial;
    materialVersions: MaterialVersion;
    materialUses: MaterialUse;
    materialEvents: MaterialEvent;
    searchConnections: SearchConnection;
    deviceSettings: DeviceSetting;
    projectReferences: ProjectReference;
    referenceChunks: ReferenceChunk;
    projectMemories: ProjectMemory;
    projectMemoryVersions: ProjectMemoryVersion;
    agentTaskWrapups: AgentTaskWrapup;
    agentTaskWrapupVersions: AgentTaskWrapupVersion;
    agentGenerationBatches: GenerationBatch;
    agentGenerationBatchItems: GenerationBatchItem;
    agentGenerationJobs: AgentGenerationJob;
    contextCompactions: ContextCompaction;
    agentTasks: AgentTask;
    agentToolCalls: AgentToolCall;
    agents: AgentConfig;
    agentRuns: AgentRun;
    productionProposals: ProductionProposal;
    projects: Project;
    characters: Character;
    scenes: Scene;
    props: Prop;
    styles: VisualStyle;
    episodes: Episode;
    shots: Shot;
    media: MediaRecord;
    connectors: ConnectorConfig;
    connectorAliases: ConnectorConfig;
    agentTaskRecords: AgentTaskRecord;
    agentTaskRecordVersions: AgentTaskRecordVersion;
    chatThreads: ChatThread;
    chatMessages: ChatMessage;
}

export type TableName = keyof ProductRows;
