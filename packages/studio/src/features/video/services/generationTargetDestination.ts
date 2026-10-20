import type {ProductionTarget} from "../models/production";

/** All generation surfaces point to the same owned target, including the exact shot. */
export function generationTargetDestination(target: ProductionTarget) {
    if (target.kind === "shot") return {
        to: "/p/$projectId/e/$episodeId/shots" as const,
        params: {projectId: target.projectId, episodeId: target.episodeId},
        search: {shot: target.entityId},
    };
    if (target.kind === "library") return {to: "/assets" as const, search: {project: target.projectId}};
    const project = encodeURIComponent(target.projectId);
    const section = {character: "characters", scene: "scenes", prop: "props", style: "styles"}[target.kind];
    return {
        to: `${target.projectId === "studio" ? "" : `/p/${project}/assets`}/${section}/${encodeURIComponent(target.entityId)}`,
    };
}
