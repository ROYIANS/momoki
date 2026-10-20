import {generationTargetDestination} from "../../video/services/generationTargetDestination";
import {AgentGenerationBatches} from "./AgentGenerationBatches";
import {AgentAudioBatches} from "../../audio/ui/AudioGenerationBatches";
import {ShotDetailLink} from "../../../app/details/ShotDetails";
import {shotDetailHref} from "../../video/models/shotDetailTarget";
import {useProductQuery} from "../../../platform/product/queries";
import {Check, CircleAlert, Image, LoaderCircle, Video} from "../../../ui/icons";
import type {AgentGenerationStatus} from "../models/agentGeneration";
import {MediaPreview} from "../../library/ui/MediaThumb";

const LABELS: Record<AgentGenerationStatus, string> = {
    submitting: "正在提交", unknown: "提交未确认", submitted: "已提交，等待生成", running: "正在生成",
    remote_completed: "生成完成，准备保存", downloading: "正在保存素材", downloaded: "素材已保存，等待写回",
    applied: "已写入目标", conflict: "目标已变化，素材已保留", failed: "生成失败",
};
const TARGETS = {character: "角色", scene: "场景", prop: "道具", style: "风格", shot: "分镜", library: "素材库"};

/** Persistent job status stays visible even while the model waits or the run is paused. */
export function AgentGenerationResults({runId}: { runId: string }) {
    const jobs = useProductQuery((db) => db.agentGenerationJobs.where("runId").equals(runId).filter(job => !job.batchId).sortBy("createdAt"), [runId]);
    // Keep the batch subtree stable when a single job appears or disappears: it owns review drafts.
    return <><AgentGenerationBatches runId={runId}/><AgentAudioBatches runId={runId}/>{Boolean(jobs?.length) &&
        <div className="agent-generation-results" aria-label="生成素材">
            {jobs?.map((job) => {
                const Icon = job.kind === "image" ? Image : Video;
                const attention = ["unknown", "conflict", "failed"].includes(job.status);
                const working = ["submitting", "submitted", "running", "remote_completed", "downloading"].includes(job.status);
                const progress = typeof job.progress === "number" && Number.isFinite(job.progress) && job.progress >= 0 && job.progress <= 100 ? job.progress : undefined;
                return <section className="agent-generation-result" key={job.id}
                                aria-label={`${job.kind === "image" ? "图片" : "视频"}生成`}>
                    <div className="agent-generation-heading"><Icon size={16}
                                                                    aria-hidden/><strong>{job.kind === "image" ? "图片生成" : "视频生成"}</strong><span
                        title={job.model}>{job.model}</span></div>
                    <div className="agent-generation-status" role="status">
                        {attention ? <CircleAlert size={14} aria-hidden/> : working ?
                            <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden/> :
                            <Check size={14} aria-hidden/>}
                        <span>{LABELS[job.status]}{working && progress !== undefined ? ` · ${progress}%` : ""}</span>
                    </div>
                    {job.result && <MediaPreview mediaId={job.result.mediaId} inspect label="生成结果预览"
                                                 className="agent-generation-media"/>}
                    {job.error && <p className="agent-generation-error">{job.error}</p>}
                    {job.status === "unknown" && <p>请先在供应商处确认，避免重复提交。</p>}
                    <ShotDetailLink href={job.target.kind === "shot" ? shotDetailHref({projectId: job.target.projectId, episodeId: job.target.episodeId, shotId: job.target.entityId}) : generationTargetDestination(job.target).to}
                          target={job.target.kind === "shot" ? {projectId: job.target.projectId, episodeId: job.target.episodeId, shotId: job.target.entityId} : undefined}
                          className="agent-change-link">查看{TARGETS[job.target.kind]} ↗</ShotDetailLink>
                </section>;
            })}
        </div>}</>;
}
