import type {AgentJob, AgentJobResultChunk} from "../../features/agent/models/agentJob";
import type {AgentPendingInput} from "../../features/agent/models/agentPendingInput";
import type {DesktopMediaImport} from "../../features/library/models/desktopMediaImport";
import {getProductStorage} from "../runtime/storageProfile";
import {recoverLegacyText} from "../data/legacyScalar";
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
import Dexie, {type Table} from "dexie";
import type {Character, Prop, Scene, VisualStyle} from "./../../features/library/models/assets";
import type {ChatMessage, ChatThread} from "./../../features/agent/models/chat";
import type {ConnectorConfig} from "./../../features/settings/models/connector";
import type {Episode} from "./../../features/video/models/episodes";
import type {MediaRecord} from "./../../features/library/models/media";
import type {Project} from "./../../features/projects/models/project";
import type {Shot} from "./../../features/video/models/shots";
import {DEFAULT_VISIBLE_COLUMNS} from "./../../features/video/models/shots";
import {getEpisodeShotFilters} from "./../../features/video/models/episodes";
import {normalizeEpisodeStory, normalizeSeriesStory} from "./../../features/video/models/story";
import {parseShotPictureSlots} from "../../features/library/models/slot";
import {createId, nowIso} from "../identity";

class BrowserDatabase extends Dexie {
    desktopMediaImports!: Table<DesktopMediaImport, string>;
    agentPendingInputs!: Table<AgentPendingInput, string>;
    agentJobs!: Table<AgentJob, string>;
    agentJobResultChunks!: Table<AgentJobResultChunk, string>;
    audioChapters!: Table<AudioChapter, string>;
    audioSpeakers!: Table<AudioSpeaker, string>;
    audioSegments!: Table<AudioSegment, string>;
    audioTakes!: Table<AudioTake, string>;
    audioTracks!: Table<AudioTrack, string>;
    audioClips!: Table<AudioClip, string>;
    audioExports!: Table<AudioExport, string>;
    musicDrafts!: Table<MusicDraft, string>;
    musicWorks!: Table<MusicWork, string>;
    audioGenerationJobs!: Table<AudioGenerationJob, string>;
    audioGenerationBatches!: Table<AudioGenerationBatch, string>;
    audioGenerationBatchItems!: Table<AudioGenerationBatchItem, string>;
    audioArrangementProposals!: Table<AudioArrangementProposal, string>;
    ipProfiles!: Table<IpProfile, string>;
    projectIpLinks!: Table<ProjectIpLink, string>;
    libraryMaterials!: Table<LibraryMaterial, string>;
    materialVersions!: Table<MaterialVersion, string>;
    materialUses!: Table<MaterialUse, string>;
    materialEvents!: Table<MaterialEvent, string>;
    searchConnections!: Table<SearchConnection, string>;
    deviceSettings!: Table<DeviceSetting, string>;
    projectReferences!: Table<ProjectReference, string>;
    referenceChunks!: Table<ReferenceChunk, string>;
    projectMemories!: Table<ProjectMemory, string>;
    projectMemoryVersions!: Table<ProjectMemoryVersion, string>;
    agentTaskWrapups!: Table<AgentTaskWrapup, string>;
    agentTaskWrapupVersions!: Table<AgentTaskWrapupVersion, string>;
    agentGenerationBatches!: Table<GenerationBatch, string>;
    agentGenerationBatchItems!: Table<GenerationBatchItem, string>;
    agentGenerationJobs!: Table<AgentGenerationJob, string>;
    contextCompactions!: Table<ContextCompaction, string>;
    agentTasks!: Table<AgentTask, string>;
    agentToolCalls!: Table<AgentToolCall, string>;
    agents!: Table<AgentConfig, string>;
    agentRuns!: Table<AgentRun, string>;
    productionProposals!: Table<ProductionProposal, string>;
    projects!: Table<Project, string>;
    characters!: Table<Character, string>;
    scenes!: Table<Scene, string>;
    props!: Table<Prop, string>;
    styles!: Table<VisualStyle, string>;
    episodes!: Table<Episode, string>;
    shots!: Table<Shot, string>;
    media!: Table<MediaRecord, string>;
    /** Studio-global AI connectors — never included in project ZIP export. */
    connectors!: Table<ConnectorConfig, string>;
    /** Retired duplicate IDs remain usable by existing frozen runs/jobs only. */
    connectorAliases!: Table<ConnectorConfig, string>;
    /** Studio-global Agent chat threads — never included in project ZIP export. */
    agentTaskRecords!: Table<AgentTaskRecord, string>;
    agentTaskRecordVersions!: Table<AgentTaskRecordVersion, string>;
    chatThreads!: Table<ChatThread, string>;
    /** Studio-global Agent chat messages — never included in project ZIP export. */
    chatMessages!: Table<ChatMessage, string>;

    constructor(name = getProductStorage().databaseName) {
        super(name);
        this.version(1).stores({
            projects: "id, updatedAt",
            characters: "id, projectId, updatedAt",
            scenes: "id, projectId, updatedAt",
            shots: "id, projectId, order",
            media: "id, projectId",
        });
        this.version(2).stores({
            projects: "id, updatedAt",
            characters: "id, projectId, updatedAt",
            scenes: "id, projectId, updatedAt",
            props: "id, projectId, updatedAt",
            styles: "id, projectId, updatedAt",
            shots: "id, projectId, order",
            media: "id, projectId",
        });
        this.version(3)
            .stores({
                projects: "id, updatedAt",
                characters: "id, projectId, updatedAt",
                scenes: "id, projectId, updatedAt",
                props: "id, projectId, updatedAt",
                styles: "id, projectId, updatedAt",
                episodes: "id, projectId, order, updatedAt",
                shots: "id, projectId, episodeId, order",
                media: "id, projectId",
            })
            .upgrade(async (tx) => {
                const projectsTable = tx.table<Record<string, unknown>>("projects");
                const projects = await projectsTable.toArray();
                const episodesTable = tx.table<Episode>("episodes");
                const shotsTable = tx.table<Record<string, unknown>>("shots");
                const at = nowIso();

                for (const project of projects) {
                    // Owner identity must remain exact; abort the upgrade instead of rekeying it.
                    if (typeof project.id !== "string" || !project.id) throw new Error("旧项目 ID 无效，无法迁移");
                    const existing = await episodesTable.where("projectId").equals(project.id).count();
                    if (existing > 0) continue;

                    const rawStory =
                        project.story && typeof project.story === "object"
                            ? (project.story as Record<string, unknown>)
                            : {};
                    const episodeStory = normalizeEpisodeStory(rawStory);
                    const episodeId = createId("ep");
                    await episodesTable.add({
                        id: episodeId,
                        projectId: project.id,
                        order: 0,
                        title: "",
                        story: episodeStory,
                        createdAt: recoverLegacyText(project.createdAt, at),
                        updatedAt: at,
                    });
                    await projectsTable.put({
                        ...project,
                        story: normalizeSeriesStory(rawStory),
                        columnSettings: {visible: [...DEFAULT_VISIBLE_COLUMNS]},
                    });

                    const shots = await shotsTable.where("projectId").equals(project.id).toArray();
                    for (const shot of shots) {
                        const record = {...shot};
                        const slots = parseShotPictureSlots(record);
                        delete record.frame;
                        delete record.reference;
                        delete record.frameMediaId;
                        delete record.referenceMediaId;
                        await shotsTable.put({
                            ...record,
                            // No episode existed for this owner: every old scope is orphaned.
                            episodeId,
                            ...slots,
                        });
                    }
                }
            });
        this.version(4).stores({
            projects: "id, updatedAt",
            characters: "id, projectId, updatedAt",
            scenes: "id, projectId, updatedAt",
            props: "id, projectId, updatedAt",
            styles: "id, projectId, updatedAt",
            episodes: "id, projectId, order, updatedAt",
            shots: "id, projectId, episodeId, order",
            media: "id, projectId",
            connectors: "id, definitionId, updatedAt",
        });
        this.version(5).stores({
            projects: "id, updatedAt",
            characters: "id, projectId, updatedAt",
            scenes: "id, projectId, updatedAt",
            props: "id, projectId, updatedAt",
            styles: "id, projectId, updatedAt",
            episodes: "id, projectId, order, updatedAt",
            shots: "id, projectId, episodeId, order",
            media: "id, projectId",
            connectors: "id, definitionId, updatedAt",
            chatThreads: "id, updatedAt",
            chatMessages: "id, threadId, createdAt",
        });
        // Additive preference migration; existing indexes do not change.
        this.version(6).stores({}).upgrade(async (tx) => {
            const projects = await tx.table<Project>("projects").toArray();
            const episodes = tx.table<Episode>("episodes");
            for (const project of projects) {
                const owned = await episodes.where("projectId").equals(project.id).toArray();
                for (const episode of owned) {
                    await episodes.update(episode.id, {shotFilters: getEpisodeShotFilters(episode, project)});
                }
            }
        });
        this.version(7).stores({productionProposals: "id, projectId, episodeId, status, createdAt"});
        this.version(8).stores({
            agents: "id",
            agentRuns: "id, threadId, status, createdAt",
        }).upgrade(async (tx) => {
            await tx.table<ChatMessage>("chatMessages").filter((message) =>
                message.status === "streaming" || message.status === "pending",
            ).modify((message) => {
                message.status = "interrupted";
                message.error = "上次生成已中断，已保留收到的内容。可重新发送问题。";
            });
        });
        this.version(9).stores({agentToolCalls: "id, runId, threadId, &[runId+providerCallId], status"});
        this.version(10).stores({
            agentTasks: "id, &threadId, lifecycle, updatedAt",
            agentRuns: "id, threadId, taskId, status, createdAt"
        });
        this.version(11).stores({contextCompactions: "id, threadId, runId, status, createdAt"});
        this.version(12).stores({agentGenerationJobs: "id, &callId, runId, threadId, projectId, status, fingerprint, updatedAt"});
        this.version(13).stores({
            agentTaskRecords: "id, taskId, [taskId+kind], updatedAt",
            agentTaskRecordVersions: "versionId, taskId, recordId, &[recordId+revision]"
        });
        this.version(14).stores({
            agentTaskWrapups: "id, taskId, threadId, status, createdAt",
            agentTaskWrapupVersions: "versionId, taskId, threadId, &[id+revision]"
        });
        this.version(15).stores({
            chatThreads: "id, projectId, updatedAt",
            agentTasks: "id, &threadId, projectId, lifecycle, updatedAt",
            agentRuns: "id, threadId, taskId, projectId, status, createdAt"
        });
        this.version(16).stores({
            projectMemories: "id, projectId, [projectId+status], updatedAt",
            projectMemoryVersions: "versionId, projectId, memoryId, &[memoryId+revision]"
        });
        this.version(19).stores({searchConnections: "id"});
        this.version(18).stores({
            agentGenerationBatches: "id, &sourceCallId, projectId, threadId, runId, taskId, status, updatedAt",
            agentGenerationBatchItems: "id, batchId, projectId, threadId, &jobId",
            agentGenerationJobs: "id, &callId, &batchItemId, batchId, runId, threadId, projectId, status, fingerprint, updatedAt",
        });
        this.version(17).stores({
            projectReferences: "id, projectId, mediaId, [projectId+digest], updatedAt",
            referenceChunks: "id, projectId, referenceId, &[referenceId+revision+index]"
        });
        // Deduplicate before creating the unique index: preserve old IDs outside the
        // selectable connector table, without rewriting frozen run/job fingerprints.
        this.version(20).stores({connectorAliases: "id, definitionId"}).upgrade(async (tx) => {
            const connectors = tx.table<ConnectorConfig>("connectors");
            const rows = await connectors.toArray();
            rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
            const seen = new Set<string>();
            for (const row of rows) {
                if (!seen.has(row.definitionId)) {
                    seen.add(row.definitionId);
                    continue;
                }
                await tx.table<ConnectorConfig>("connectorAliases").put(row);
                await connectors.delete(row.id);
            }
        });
        this.version(21).stores({connectors: "id, &definitionId, updatedAt"});
        this.version(22).stores({
            ipProfiles: "id, updatedAt",
            projectIpLinks: "projectId, ipId",
            libraryMaterials: "id, kind, scope.kind, scope.id, updatedAt",
            materialVersions: "id, materialId, &[materialId+revision]",
            materialUses: "id, materialId, projectId, targetId, [materialId+projectId]",
            materialEvents: "id, materialId, createdAt",
        });
        this.version(23).stores({
            projects: "id, kind, updatedAt",
            audioChapters: "id, projectId, order",
            audioSpeakers: "id, projectId",
            audioSegments: "id, projectId, chapterId, speakerId, order",
            audioTakes: "id, projectId, segmentId, mediaId",
            audioTracks: "id, projectId, chapterId, order",
            audioClips: "id, projectId, chapterId, trackId, takeId",
            audioExports: "id, projectId, mediaId",
            musicDrafts: "id, projectId",
            musicWorks: "id, projectId, mediaId",
            audioGenerationJobs: "id, projectId, &intentId, status, updatedAt",
        });
        this.version(24).stores({
            audioGenerationBatches: "id, projectId, chapterId, &sourceCallId, owner.threadId, owner.runId, status, updatedAt",
            audioGenerationBatchItems: "id, projectId, chapterId, batchId, segmentId, &intentId, jobId",
            audioArrangementProposals: "id, projectId, chapterId, kind, state, updatedAt",
        });
        this.version(25).stores({deviceSettings: "key"});
        this.version(26).stores({
            agentJobs: "id, &callId, threadId, runId, projectId, status, updatedAt",
            agentJobResultChunks: "id, jobId, &[jobId+ordinal]",
        });
        this.version(27).stores({desktopMediaImports: "id, projectId, status, updatedAt"});
        this.version(28).stores({agentPendingInputs: "id, threadId, projectId, status, &dedupeKey, updatedAt"});
    }
}

export const browserDatabase = getProductStorage().storage === "indexeddb" ? new BrowserDatabase() : undefined;
