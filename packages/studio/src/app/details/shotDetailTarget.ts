import type {ShotDetailTarget} from "../../features/video/models/shotDetailTarget";

function validId(id: string): boolean {
    return id.length > 0 && id.length <= 256 && id.trim() === id && id !== "." && id !== ".." &&
        !/[/\\?#]/.test(id) && ![...id].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/** Historical links are data, not authority; the detail query separately verifies ownership. */
export function readShotDetailTarget(href: string): ShotDetailTarget | undefined {
    if (href.length > 2048) return;
    const path = href.startsWith("#/") ? href.slice(1) : href;
    if (!/^\/(?!\/)/.test(path) || path.includes("#") || path.includes("\\")) return;
    try {
        const url = new URL(path, "https://momoki.invalid");
        const match = /^\/p\/([^/]+)\/e\/([^/]+)\/shots$/.exec(path.split("?", 1)[0]);
        // URL normalizes traversal and tolerates malformed query escapes; neither expands this route allowlist.
        decodeURIComponent(url.search.replace(/\+/g, " "));
        if (!match || [...url.searchParams.keys()].some(key => key !== "shot") || url.searchParams.getAll("shot").length !== 1) return;
        const projectId = decodeURIComponent(match[1]);
        const episodeId = decodeURIComponent(match[2]);
        const shotId = url.searchParams.get("shot") ?? "";
        if ([projectId, episodeId, shotId].every(validId)) return {projectId, episodeId, shotId};
    } catch {
        // Malformed percent escapes and arbitrary destinations keep normal link behavior.
    }
}
