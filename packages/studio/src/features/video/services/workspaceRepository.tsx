import {type DependencyList, useEffect, useRef, useState} from "react";
import {useProductQueryState} from "../../../platform/product/queries";
import type {ProductStore} from "../../../platform/storage/types";
import {db} from "../../../platform/product/store";
import {getProductStorage, type ProductStorageOwner} from "../../../platform/runtime/storageProfile";
import * as episodeCommands from "../commands/episodes";
import * as projectCommands from "../../projects/commands/projects";
import * as shotCommands from "../commands/shots";
import {deleteProject, setProjectArchived} from "./../../projects/commands/lifecycle";
import {bindProjectIp} from "../../library/commands/ipProfiles";
import {readProjectCoverIds} from "../../projects/queries/studioLibraryQueries";
import type {Episode} from "../models/episodes";
import type {Id} from "../../../platform/identity";
import type {Project} from "../../projects/models/project";
import type {Shot} from "../models/shots";
import type {StoryBeat} from "../models/story";
import {resolutionForAspect} from "../models/format";
import {emptyProject} from "../../projects/models/newProject";
import {emptySlot} from "../../library/models/slot";
import {
    nativeBaseline,
    type NativeBeat,
    type NativeEpisode,
    type NativeShot,
    type NativeUndoReceipt,
    type NativeVideoWorkspaceState,
    nativeWorkspace,
} from "../../../platform/runtime/reference/nativeWorkspace";
import type {
    VideoWorkspaceCapability,
    VideoWorkspaceSnapshot,
    VideoWorkspaceUndoAction,
} from "../models/videoWorkspace";

const SQLITE_CAPABILITIES: VideoWorkspaceCapability[] = [
    {
        id: "world",
        status: "unavailable",
        reason: "原生视频切片尚未接入世界设定",
    },
    {
        id: "generation",
        status: "unavailable",
        reason: "生成能力由后续桌面模块提供",
    },
    {
        id: "relations",
        status: "unavailable",
        reason: "关系数据暂未进入原生工作区",
    },
    {
        id: "mediaSlots",
        status: "unavailable",
        reason: "媒体槽将随文件工作区一起接入",
    },
    {id: "sync", status: "unavailable", reason: "同步插件尚未配置"},
];
const PRODUCT_CAPABILITIES: VideoWorkspaceCapability[] =
    SQLITE_CAPABILITIES.map((item) => ({
        ...item,
        status: item.id === "sync" ? "unavailable" : "available",
        reason: item.id === "sync" ? item.reason : undefined,
    }));
const CHANGED = "momoki:video-workspace-changed";
const READ_STATUS = "momoki:video-read-status";
const readErrors = new Map<symbol, string>();

function currentReadError() {
    return [...readErrors.values()][0];
}

function setReadError(token: symbol, error: string | undefined) {
    if (error) readErrors.set(token, error);
    else readErrors.delete(token);
    if (typeof window !== "undefined")
        window.dispatchEvent(new Event(READ_STATUS));
}

function notify() {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGED));
}

function nullableFields<T extends object>(
    patch: T,
    fields: readonly string[],
): T {
    return Object.fromEntries(
        Object.entries(patch).map(([key, value]) => [
            key,
            fields.includes(key) && value === undefined ? null : value,
        ]),
    ) as T;
}

function unsupported(): never {
    throw new Error("当前原生工作区尚未支持此能力");
}

function projectFromNative(state: NativeVideoWorkspaceState): Project {
    return {
        ...emptyProject(
            state.project.title,
            state.video.mode,
            state.video.aspectPreset,
        ),
        id: state.project.id,
        createdAt: state.video.createdAt,
        brief: state.video.brief,
        genre: state.video.genre,
        audience: state.video.audience,
        tone: state.video.tone,
        kind: state.video.kind,
        updatedAt: state.video.updatedAt,
        archivedAt: state.video.archivedAt ?? undefined,
        columnSettings: {
            visible: state.video.columnSettings
                .visible as Project["columnSettings"]["visible"],
        },
        shotSettings: state.video.shotSettings,
        story: {logline: state.video.logline},
    };
}

function beatFromNative(beat: NativeBeat): StoryBeat {
    return {
        id: beat.id,
        title: beat.title,
        content: beat.content,
        characterIds: beat.characterIds,
        sceneId: beat.sceneId ?? undefined,
        timeOfDay: beat.timeOfDay,
        scriptRange: beat.scriptRange ?? undefined,
    };
}

function episodeFromNative(
    episode: NativeEpisode,
    beats: NativeBeat[],
): Episode {
    return {
        id: episode.id,
        projectId: episode.projectId,
        order: episode.order,
        title: episode.title,
        createdAt: episode.createdAt,
        updatedAt: episode.updatedAt,
        shotFilters: episode.shotFilters,
        story: {
            logline: episode.logline,
            script: episode.script,
            beats: beats
                .filter((item) => item.episodeId === episode.id)
                .sort((a, b) => a.order - b.order)
                .map(beatFromNative),
        },
    };
}

function shotFromNative(shot: NativeShot): Shot {
    return {
        ...shot,
        order: shot.order + 1,
        beatId: shot.beatId ?? undefined,
        sceneId: shot.sceneId ?? undefined,
        styleId: shot.styleId,
        firstFrame: emptySlot(),
        lastFrame: emptySlot(),
        clip: emptySlot(),
    };
}

class VideoRepository {
    private ownerMutations = new Map<string, Promise<void>>();
    private undos = new WeakMap<object, NativeUndoReceipt>();

    constructor(readonly storage: ProductStorageOwner, private readonly reference = false, private readonly store: ProductStore = db) {
    }

    withStore(store: ProductStore): VideoRepository {
        return new VideoRepository(this.storage, this.reference, store);
    }

    capabilities() {
        return !this.reference
            ? PRODUCT_CAPABILITIES
            : SQLITE_CAPABILITIES;
    }

    capability(id: VideoWorkspaceCapability["id"]) {
        return this.capabilities().find((item) => item.id === id)!;
    }

    async projects(): Promise<Project[]> {
        if (!this.reference) return this.store.projects.toArray();
        const state = await nativeWorkspace.ensure();
        return Promise.all(
            state.projects.map(async (row) =>
                projectFromNative(await nativeWorkspace.videoState(row.id)),
            ),
        );
    }

    async project(id: string): Promise<Project | null> {
        if (!this.reference) return (await this.store.projects.get(id)) ?? null;
        const state = await nativeWorkspace.ensure();
        if (!state.projects.some((row) => row.id === id)) return null;
        return projectFromNative(await nativeWorkspace.videoState(id));
    }

    async episodes(projectId: string): Promise<Episode[]> {
        if (!this.reference)
            return episodeCommands.listEpisodes(projectId, this.store);
        const state = await nativeWorkspace.videoState(projectId);
        return state.episodes
            .map((row) => episodeFromNative(row, state.beats))
            .sort((a, b) => a.order - b.order);
    }

    async episode(id: string): Promise<Episode | null> {
        if (!this.reference) return (await this.store.episodes.get(id)) ?? null;
        const state = await nativeWorkspace.state();
        const row = state.episodes.find((item) => item.id === id);
        return row ? episodeFromNative(row, state.beats) : null;
    }

    async beats(episodeId: string) {
        const episode = await this.episode(episodeId);
        return (
            episode?.story.beats.map((beat, order) => ({
                ...beat,
                episodeId,
                order,
            })) ?? []
        );
    }

    async shots(episodeId: string): Promise<Shot[]> {
        if (!this.reference)
            return this.store.shots.where("episodeId").equals(episodeId).sortBy("order");
        const state = await nativeWorkspace.state();
        return state.shots
            .filter((row) => row.episodeId === episodeId)
            .sort((a, b) => a.order - b.order)
            .map(shotFromNative);
    }

    async projectShots(projectId: string): Promise<Shot[]> {
        if (!this.reference)
            return this.store.shots.where("projectId").equals(projectId).toArray();
        return (await nativeWorkspace.videoState(projectId)).shots.map(
            shotFromNative,
        );
    }

    async characters(projectId: string) {
        return !this.reference
            ? this.store.characters.where("projectId").equals(projectId).toArray()
            : [];
    }

    async scenes(projectId: string) {
        return !this.reference
            ? this.store.scenes.where("projectId").equals(projectId).toArray()
            : [];
    }

    async props(projectId: string) {
        return !this.reference
            ? this.store.props.where("projectId").equals(projectId).toArray()
            : [];
    }

    async styles(projectId: string) {
        return !this.reference
            ? this.store.styles.where("projectId").equals(projectId).toArray()
            : [];
    }

    async ipProfiles() {
        return !this.reference ? this.store.ipProfiles.toArray() : [];
    }

    async projectIpLinks() {
        return !this.reference ? this.store.projectIpLinks.toArray() : [];
    }

    async projectCoverIds(ids: string[]) {
        return !this.reference
            ? readProjectCoverIds(ids, this.store)
            : new Map<string, string>();
    }

    async snapshot(projectId: string): Promise<VideoWorkspaceSnapshot | null> {
        const project = await this.project(projectId);
        if (!project) return null;
        const episodes = await this.episodes(projectId);
        return {
            project,
            episodes,
            beats: (
                await Promise.all(episodes.map((row) => this.beats(row.id)))
            ).flat(),
            shots: await this.projectShots(projectId),
            capabilities: this.capabilities(),
        };
    }

    async createProject(
        ...args: Parameters<typeof projectCommands.createProject>
    ): Promise<Project> {
        if (!this.reference)
            return projectCommands.createProject(...args);
        const [name, mode = "film", aspectPreset = "16:9", ipId] = args;
        if (ipId) unsupported();
        await nativeWorkspace.ensure();
        const project = {
            id: crypto.randomUUID(),
            title: name.trim() || "未命名项目",
        };
        const resolution = resolutionForAspect(aspectPreset);
        const defaults = emptyProject(project.title, mode, aspectPreset);
        const at = new Date().toISOString();
        await nativeWorkspace.command({
            type: "createVideoProject",
            project,
            video: {
                projectId: project.id,
                kind: "video",
                mode,
                aspectPreset,
                outputWidth: resolution.width,
                outputHeight: resolution.height,
                archivedAt: null,
                createdAt: at,
                updatedAt: at,
                brief: "",
                genre: "",
                audience: "",
                tone: "",
                logline: "",
                columnSettings: defaults.columnSettings,
                shotSettings: defaults.shotSettings,
            },
        });
        notify();
        return (await this.project(project.id))!;
    }

    async createAudioMusicProject(
        ...args: Parameters<typeof projectCommands.createAudioMusicProject>
    ) {
        if (!this.reference)
            return projectCommands.createAudioMusicProject(...args);
        unsupported();
    }

    async renameProject(
        ...args: Parameters<typeof projectCommands.renameProject>
    ) {
        if (!this.reference)
            return projectCommands.renameProject(...args);
        await nativeWorkspace.request({
            type: "project",
            project: {id: args[0], title: args[1]},
        });
        notify();
    }

    async deleteProject(
        ...args: Parameters<typeof deleteProject>
    ) {
        if (!this.reference)
            return deleteProject(...args);
        await nativeWorkspace.command({
            type: "deleteProject",
            projectId: args[0],
        });
        notify();
    }

    async setProjectArchived(
        ...args: Parameters<typeof setProjectArchived>
    ) {
        if (!this.reference)
            return setProjectArchived(...args);
        await nativeWorkspace.command({
            type: "patchVideoProject",
            projectId: args[0],
            patch: {archivedAt: args[1] ? new Date().toISOString() : null},
        });
        notify();
    }

    async bindProjectIp(...args: Parameters<typeof bindProjectIp>) {
        if (!this.reference) return bindProjectIp(...args);
        unsupported();
    }

    async patchProjectDetails(
        ...args: Parameters<typeof projectCommands.patchProjectDetails>
    ) {
        if (!this.reference)
            return projectCommands.patchProjectDetails(...args);
        const [id, patch, baseline] = args;
        if (
            Object.keys(patch).some(
                (key) =>
                    ![
                        "name",
                        "aspectPreset",
                        "brief",
                        "genre",
                        "audience",
                        "tone",
                    ].includes(key),
            )
        )
            unsupported();
        const next: Partial<
            Pick<
                import("../../../platform/runtime/reference/nativeWorkspace").NativeVideoProject,
                | "brief"
                | "genre"
                | "audience"
                | "tone"
                | "aspectPreset"
                | "outputWidth"
                | "outputHeight"
            >
        > & { title?: string } = {};
        for (const key of ["brief", "genre", "audience", "tone"] as const)
            if (key in patch) next[key] = patch[key] ?? "";
        if (patch.name !== undefined) next.title = patch.name;
        if (patch.aspectPreset) {
            next.aspectPreset = patch.aspectPreset;
            next.outputWidth = resolutionForAspect(patch.aspectPreset).width;
            next.outputHeight = resolutionForAspect(patch.aspectPreset).height;
        }
        const mappedBaseline = baseline
            ? {
                ...baseline,
                title: baseline.name,
                ...(baseline.aspectPreset
                    ? {
                        outputWidth: resolutionForAspect(baseline.aspectPreset).width,
                        outputHeight: resolutionForAspect(baseline.aspectPreset).height,
                    }
                    : {}),
            }
            : undefined;
        await nativeWorkspace.command({
            type: "patchVideoProject",
            projectId: id,
            patch: next,
            baseline: nativeBaseline(next, mappedBaseline),
        });
        notify();
    }

    async patchProjectOutput(
        ...args: Parameters<typeof projectCommands.patchProjectOutput>
    ) {
        if (!this.reference)
            return projectCommands.patchProjectOutput(...args);
        if ("coverMediaId" in args[1]) unsupported();
        await this.patchProjectDetails(args[0], args[1]);
    }

    async updateSeriesLogline(
        ...args: Parameters<typeof projectCommands.updateSeriesLogline>
    ) {
        if (!this.reference)
            return projectCommands.updateSeriesLogline(...args);
        await nativeWorkspace.command({
            type: "patchVideoProject",
            projectId: args[0],
            patch: {logline: args[1]},
            baseline:
                args[2] === undefined
                    ? undefined
                    : {fields: [{field: "logline", value: args[2]}]},
        });
        notify();
    }

    async updateShotSettings(
        ...args: Parameters<typeof projectCommands.updateShotSettings>
    ) {
        if (!this.reference)
            return projectCommands.updateShotSettings(...args);
        await this.withOwnerMutation(`project-settings:${args[0]}`, async () => {
            const state = await nativeWorkspace.videoState(args[0]);
            await nativeWorkspace.command({
                type: "patchVideoProject",
                projectId: args[0],
                patch: {shotSettings: {...state.video.shotSettings, ...args[1]}},
            });
            notify();
        });
    }

    async setVisibleColumns(
        ...args: Parameters<typeof projectCommands.setVisibleColumns>
    ) {
        if (!this.reference)
            return projectCommands.setVisibleColumns(...args);
        await nativeWorkspace.command({
            type: "patchVideoProject",
            projectId: args[0],
            patch: {columnSettings: {visible: args[1]}},
        });
        notify();
    }

    async ensureFirstEpisode(projectId: string): Promise<Episode> {
        if (!this.reference)
            return episodeCommands.ensureFirstEpisode(projectId);
        return (await this.episodes(projectId))[0] ?? this.addEpisode(projectId);
    }

    async addEpisode(projectId: string): Promise<Episode> {
        if (!this.reference)
            return episodeCommands.addEpisode(projectId);
        const row = await nativeWorkspace.createEpisode(projectId);
        notify();
        return episodeFromNative(row, []);
    }

    async updateEpisodeDraft(
        ...args: Parameters<typeof episodeCommands.updateEpisodeDraft>
    ) {
        if (!this.reference)
            return episodeCommands.updateEpisodeDraft(...args);
        await nativeWorkspace.command({
            type: "patchEpisode",
            episodeId: args[0],
            patch: nullableFields(args[1], ["beatId", "sceneId", "styleId"]),
            baseline: nativeBaseline(args[1], args[2]),
        });
        notify();
    }

    async deleteEpisode(
        ...args: Parameters<typeof episodeCommands.deleteEpisode>
    ): Promise<episodeCommands.DeletedEpisodeSnapshot | undefined> {
        if (!this.reference)
            return episodeCommands.deleteEpisode(...args);
        const episode = await this.episode(args[0]);
        if (!episode) return;
        const shots = await this.shots(args[0]);
        const receipt = await nativeWorkspace.command({
            type: "deleteEpisode",
            episodeId: args[0],
        });
        const snapshot = {episode, shots, media: []};
        this.rememberUndo(snapshot, receipt);
        notify();
        return snapshot;
    }

    async restoreEpisode(snapshot: episodeCommands.DeletedEpisodeSnapshot) {
        if (!this.reference)
            return episodeCommands.restoreEpisode(snapshot);
        await this.restoreReceipt(snapshot);
        notify();
    }

    async reorderEpisodes(
        ...args: Parameters<typeof episodeCommands.reorderEpisodes>
    ): Promise<VideoWorkspaceUndoAction | void> {
        if (!this.reference)
            return episodeCommands.reorderEpisodes(...args);
        const receipt = await nativeWorkspace.command({
            type: "reorderEpisodes",
            projectId: args[0],
            orderedIds: args[1],
        });
        notify();
        return this.undoAction(receipt);
    }

    async addStoryBeat(
        ...args: Parameters<typeof episodeCommands.addStoryBeat>
    ): Promise<StoryBeat> {
        if (!this.reference)
            return episodeCommands.addStoryBeat(...args);
        const episode = await this.episode(args[0]);
        if (!episode) throw new Error("集不存在");
        const range = args[1]?.scriptRange;
        const validRange =
            range &&
            range.start >= 0 &&
            range.end > range.start &&
            episode.story.script.slice(range.start, range.end) === range.excerpt
                ? range
                : null;
        const row: NativeBeat = {
            id: crypto.randomUUID(),
            episodeId: episode.id,
            order: episode.story.beats.length,
            title: `场 ${episode.story.beats.length + 1}`,
            content: range?.excerpt ?? "",
            timeOfDay: "",
            characterIds: [],
            sceneId: null,
            scriptRange: validRange,
        };
        const saved = await nativeWorkspace.saveBeat(row);
        notify();
        return beatFromNative(saved);
    }

    async patchStoryBeat(
        ...args: Parameters<typeof episodeCommands.patchStoryBeat>
    ) {
        if (!this.reference)
            return episodeCommands.patchStoryBeat(...args);
        await nativeWorkspace.command({
            type: "patchBeat",
            episodeId: args[0],
            beatId: args[1],
            patch: nullableFields(args[2], ["sceneId", "scriptRange"]),
            baseline: nativeBaseline(args[2], args[3]),
        });
        notify();
    }

    async deleteStoryBeat(
        ...args: Parameters<typeof episodeCommands.deleteStoryBeat>
    ): Promise<VideoWorkspaceUndoAction | void> {
        if (!this.reference)
            return episodeCommands.deleteStoryBeat(...args);
        const receipt = await nativeWorkspace.command({
            type: "deleteBeat",
            episodeId: args[0],
            beatId: args[1],
        });
        notify();
        return this.undoAction(receipt);
    }

    async restoreStoryBeat(
        ...args: Parameters<typeof episodeCommands.restoreStoryBeat>
    ) {
        if (!this.reference)
            return episodeCommands.restoreStoryBeat(...args);
        throw new Error("请使用已提交操作的撤销凭据恢复场次");
    }

    async duplicateBeat(
        ...args: Parameters<typeof episodeCommands.duplicateBeat>
    ): Promise<{
        beat: StoryBeat;
        shots: Shot[];
        undo?: VideoWorkspaceUndoAction;
    }> {
        if (!this.reference)
            return episodeCommands.duplicateBeat(...args);
        const result = await nativeWorkspace.command({
            type: "duplicateBeat",
            episodeId: args[0],
            beatId: args[1],
            includeShots: args[2]?.includeShots ?? false,
        });
        notify();
        if (result.type !== "outcome" || result.value.kind !== "duplicateBeat")
            throw new Error("复制场次未返回已提交结果");
        return {
            beat: beatFromNative(result.value.value.beat),
            shots: result.value.value.shots.map(shotFromNative),
            undo: this.receiptAction(result.value.value.receipt),
        };
    }

    async reorderBeats(
        ...args: Parameters<typeof episodeCommands.reorderBeats>
    ): Promise<VideoWorkspaceUndoAction | void> {
        if (!this.reference)
            return episodeCommands.reorderBeats(...args);
        const receipt = await nativeWorkspace.command({
            type: "reorderBeats",
            episodeId: args[0],
            orderedIds: args[1],
        });
        notify();
        return this.undoAction(receipt);
    }

    async updateEpisodeShotFilters(
        ...args: Parameters<typeof episodeCommands.updateEpisodeShotFilters>
    ) {
        if (!this.reference)
            return episodeCommands.updateEpisodeShotFilters(...args);
        await this.withOwnerMutation(`episode-filters:${args[0]}`, async () => {
            const episode = await this.episode(args[0]);
            if (!episode) throw new Error("集不存在");
            await nativeWorkspace.command({
                type: "patchEpisode",
                episodeId: args[0],
                patch: {shotFilters: {...episode.shotFilters!, ...args[1]}},
            });
            notify();
        });
    }

    async addShot(
        ...args: Parameters<typeof shotCommands.addShot>
    ): Promise<Shot> {
        if (!this.reference) return shotCommands.addShot(...args);
        return (await this.addShots(args[0], args[1], 1, args[2]))[0];
    }

    async addShots(
        ...args: Parameters<typeof shotCommands.addShots>
    ): Promise<Shot[]> {
        if (!this.reference) return shotCommands.addShots(...args);
        const [projectId, episodeId, count, options] = args;
        const result = await nativeWorkspace.command({
            type: "addShots",
            projectId,
            episodeId,
            count,
            atOrder: options?.atOrder === undefined ? undefined : options.atOrder - 1,
            beatId: options?.beatId,
        });
        notify();
        if (result.type === "outcome" && result.value.kind === "shots")
            return result.value.value.map(shotFromNative);
        throw new Error("创建镜头未返回镜头列表");
    }

    async patchShot(...args: Parameters<typeof shotCommands.patchShot>) {
        if (!this.reference) return shotCommands.patchShot(...args);
        await nativeWorkspace.command({
            type: "patchShot",
            shotId: args[0],
            patch: nullableFields(args[1], ["beatId", "sceneId", "styleId"]),
            baseline: nativeBaseline(args[1], args[2]),
        });
        notify();
    }

    async setShotCharacterSelected(
        ...args: Parameters<typeof shotCommands.setShotCharacterSelected>
    ) {
        if (!this.reference)
            return shotCommands.setShotCharacterSelected(...args);
        unsupported();
    }

    async setShotSlot(...args: Parameters<typeof shotCommands.setShotSlot>) {
        if (!this.reference) return shotCommands.setShotSlot(...args);
        unsupported();
    }

    async duplicateShot(
        ...args: Parameters<typeof shotCommands.duplicateShot>
    ): Promise<Shot & { undo?: VideoWorkspaceUndoAction }> {
        if (!this.reference) return shotCommands.duplicateShot(...args);
        const row = (await nativeWorkspace.state()).shots.find(
            (item) => item.id === args[0],
        );
        if (!row) throw new Error("镜头不存在");
        const result = await nativeWorkspace.command({
            type: "duplicateShot",
            episodeId: row.episodeId,
            shotId: args[0],
        });
        notify();
        if (result.type === "outcome" && result.value.kind === "duplicateShot")
            return {
                ...shotFromNative(result.value.value.shot),
                undo: this.receiptAction(result.value.value.receipt),
            };
        throw new Error("复制镜头未返回镜头");
    }

    async deleteShots(ids: Id[]) {
        if (!this.reference) return shotCommands.deleteShots(ids);
        if (!ids.length) return;
        const state = await nativeWorkspace.state();
        const first = state.shots.find((row) => row.id === ids[0]);
        if (!first) return;
        await nativeWorkspace.command({
            type: "deleteShots",
            episodeId: first.episodeId,
            shotIds: ids,
        });
        notify();
    }

    async deleteEpisodeShots(
        ...args: Parameters<typeof shotCommands.deleteEpisodeShots>
    ): Promise<shotCommands.DeletedShotsSnapshot | undefined> {
        if (!this.reference)
            return shotCommands.deleteEpisodeShots(...args);
        const [episodeId, ids] = args;
        const episode = await this.episode(episodeId);
        if (!episode) throw new Error("集不存在");
        const shots = (await this.shots(episodeId)).filter((row) =>
            ids.includes(row.id),
        );
        const receipt = await nativeWorkspace.command({
            type: "deleteShots",
            episodeId,
            shotIds: ids,
        });
        this.rememberUndo(shots, receipt);
        notify();
        return {projectId: episode.projectId, episodeId, shots, media: []};
    }

    async restoreShots(...args: Parameters<typeof shotCommands.restoreShots>) {
        if (!this.reference) return shotCommands.restoreShots(...args);
        if (!args[0].length) return;
        await this.restoreReceipt(args[0]);
        notify();
    }

    async patchEpisodeShots(
        ...args: Parameters<typeof shotCommands.patchEpisodeShots>
    ): Promise<shotCommands.EpisodeShotBulkUndo | undefined> {
        if (!this.reference)
            return shotCommands.patchEpisodeShots(...args);
        const episode = await this.episode(args[0]);
        if (!episode) throw new Error("集不存在");
        const receipt = await nativeWorkspace.command({
            type: "bulkShots",
            episodeId: args[0],
            shotIds: args[1],
            patch: nullableFields(args[2], ["beatId", "sceneId", "styleId"]),
        });
        const undo = {
            projectId: episode.projectId,
            episodeId: args[0],
            shots: args[1].map((id) => ({id, before: {}, after: args[2]})),
        };
        this.rememberUndo(undo, receipt);
        notify();
        return undo;
    }

    async undoEpisodeShotBulkPatch(undo: shotCommands.EpisodeShotBulkUndo) {
        if (!this.reference)
            return shotCommands.undoEpisodeShotBulkPatch(undo);
        await this.restoreReceipt(undo);
        notify();
    }

    async reorderShots(
        ...args: Parameters<typeof shotCommands.reorderShots>
    ): Promise<VideoWorkspaceUndoAction | void> {
        if (!this.reference) return shotCommands.reorderShots(...args);
        const receipt = await nativeWorkspace.command({
            type: "reorderShots",
            episodeId: args[0],
            orderedIds: args[1],
        });
        notify();
        return this.undoAction(receipt);
    }

    private withOwnerMutation<T>(
        owner: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        const current = this.ownerMutations.get(owner) ?? Promise.resolve();
        const result = current.then(operation);
        const settled = result.then(
            () => undefined,
            () => undefined,
        );
        this.ownerMutations.set(owner, settled);
        void settled.then(() => {
            if (this.ownerMutations.get(owner) === settled)
                this.ownerMutations.delete(owner);
        });
        return result;
    }

    private rememberUndo(
        id: object,
        result: Awaited<ReturnType<typeof nativeWorkspace.request>>,
    ) {
        if (result.type === "outcome" && result.value.kind === "undo")
            this.undos.set(id, result.value.value);
    }

    private async restoreReceipt(id: object) {
        const receipt = this.undos.get(id);
        if (!receipt) throw new Error("撤销记录不可用");
        await nativeWorkspace.command({type: "videoUndo", receipt});
        this.undos.delete(id);
    }

    private receiptAction(receipt: NativeUndoReceipt): VideoWorkspaceUndoAction {
        return {
            restore: async () => {
                await nativeWorkspace.command({type: "videoUndo", receipt});
                notify();
            },
        };
    }

    private undoAction(
        result: Awaited<ReturnType<typeof nativeWorkspace.request>>,
    ): VideoWorkspaceUndoAction | void {
        if (result.type !== "outcome" || result.value.kind !== "undo") return;
        const receipt = result.value.value;
        return {
            restore: async () => {
                await nativeWorkspace.command({type: "videoUndo", receipt});
                notify();
            },
        };
    }
}

export type VideoWorkspaceRepository = VideoRepository;
const sharedVideoWorkspace = new VideoRepository(getProductStorage().storage);

/** Historical schema-4 fixture lane only; never selected by normal product routes. */
export function getReferenceVideoWorkspaceRepository(): VideoRepository {
    return new VideoRepository("sqlite", true);
}

export function getVideoWorkspaceRepository(): VideoRepository {
    return sharedVideoWorkspace;
}

export function useVideoWorkspaceRepository(): VideoRepository {
    return sharedVideoWorkspace;
}

export function useVideoWorkspaceQuery<T>(query: (repository: VideoRepository) => T | Promise<T>, dependencies: DependencyList): T | undefined {
    const token = useRef(Symbol("video-read"));
    const [attempt, setAttempt] = useState(0);
    const state = useProductQueryState(tx => query(sharedVideoWorkspace.withStore(tx)), [...dependencies, attempt]);
    useEffect(() => {
        const id = token.current;
        setReadError(id, state.error?.message);
        return () => setReadError(id, undefined);
    }, [state.error]);
    useEffect(() => {
        const retry = () => setAttempt(value => value + 1);
        window.addEventListener(CHANGED, retry);
        return () => window.removeEventListener(CHANGED, retry);
    }, []);
    return state.value;
}

export function useVideoWorkspaceReadStatus(): {
    error?: string;
    retry: () => void;
} {
    const [error, setError] = useState(currentReadError);
    useEffect(() => {
        const update = () => setError(currentReadError());
        window.addEventListener(READ_STATUS, update);
        return () => window.removeEventListener(READ_STATUS, update);
    }, []);
    return {
        error,
        retry: () => {
            readErrors.clear();
            window.dispatchEvent(new Event(READ_STATUS));
            notify();
        },
    };
}
