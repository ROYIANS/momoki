import {SKILL_LIMITS, validateSkillResourcePaths} from "@momoki/agent-core";
import type {SkillImportCandidate} from "../models/installedSkill";
import {isSupportedSkillResource, prepareSkillImport, validateSkillImportPath} from "./package";

export function supportsSkillDirectoryImport(): boolean {
    return typeof document !== "undefined" && "webkitdirectory" in document.createElement("input");
}

/** FileList grants only these supplied files; it does not establish OS identity. */
/**
 * Mirrors the native capture's pruning: hidden names, unknown root directories
 * (scripts, node_modules, ...) and unsupported root files are excluded as one
 * subtree before any count or path-validity check. Returns the excluded subtree
 * root, or undefined when the file stays a candidate.
 */
function prunedSubtree(path: string): string | undefined {
    const segments = path.split("/");
    // Dot segments are traversal attempts, not hidden names: leave them to path validation.
    if (segments.some(segment => segment === "." || segment === "..")) return undefined;
    const hidden = segments.findIndex(segment => segment.startsWith("."));
    if (hidden >= 0) return segments.slice(0, hidden + 1).join("/");
    if (segments.length === 1) return path === "SKILL.md" || path === "LICENSE" || path === "LICENSE.txt" ? undefined : path;
    return segments[0] === "references" || segments[0] === "assets" ? undefined : segments[0];
}

export async function prepareBrowserSkillImport(files: ArrayLike<File>): Promise<SkillImportCandidate> {
    if (files.length < 1) throw new Error("请选择包含 SKILL.md 的技能文件夹");
    let directoryName: string | undefined;
    const seen = new Set<string>();
    const pruned = new Map<string, number>();
    const prunedFiles: string[] = [];
    const supplied: {file: File; path: string}[] = [];
    for (const file of Array.from(files)) {
        const relative = file.webkitRelativePath;
        const slash = relative.indexOf("/");
        if (slash < 1) throw new Error("请选择一个完整的技能文件夹");
        const root = relative.slice(0, slash), path = relative.slice(slash + 1);
        validateSkillImportPath(root);
        if (root.length > SKILL_LIMITS.nameScalars || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(root)) throw new Error("技能文件夹名称须为 1–64 位小写字母、数字及单个连接符");
        if (directoryName !== undefined && root !== directoryName) throw new Error("每次只能导入一个技能文件夹");
        directoryName = root;
        const subtree = prunedSubtree(path);
        if (subtree !== undefined) {
            if (!pruned.has(subtree)) {pruned.set(subtree, 0); prunedFiles.push(subtree);}
            continue;
        }
        validateSkillImportPath(path);
        const folded = path.normalize("NFC").toUpperCase().toLowerCase();
        if (seen.has(folded)) throw new Error("技能目录包含重名文件");
        seen.add(folded);
        supplied.push({file, path});
    }
    // Excluded subtrees count as one visible entry each, as in native capture.
    if (supplied.length + pruned.size > SKILL_LIMITS.directoryEntries) throw new Error("技能目录条目过多");
    const nestedRoots = supplied.filter(entry => entry.path !== "SKILL.md" && entry.path.endsWith("/SKILL.md")).map(entry => entry.path.slice(0, -8));
    const accepted = supplied.filter(entry => entry.path === "SKILL.md" || isSupportedSkillResource(entry.path, nestedRoots));
    if (!accepted.some(entry => entry.path === "SKILL.md")) throw new Error("请选择根目录包含 SKILL.md 的技能文件夹");
    if (accepted.length > SKILL_LIMITS.fileCount) throw new Error("技能文本文件过多");
    validateSkillResourcePaths(accepted.filter(entry => entry.path !== "SKILL.md").map(entry => entry.path));
    let total = 0;
    for (const {file, path} of accepted) {
        const max = path === "SKILL.md" ? SKILL_LIMITS.frontmatterBytes + SKILL_LIMITS.bodyBytes + 16 : SKILL_LIMITS.resourceBytes;
        if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > max) throw new Error("技能文本文件过大");
        total += file.size;
    }
    if (total > SKILL_LIMITS.packageBytes) throw new Error("技能文本总大小超过上限");
    // Read sequentially after all logical/count/declared-size checks. Excluded files
    // are never opened, including scripts and resources of a nested skill package.
    const captured = [];
    for (const {file, path} of accepted) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.byteLength !== file.size) throw new Error("所选技能文件已变化，请重新选择");
        captured.push({path, bytes});
    }
    const excluded = [...prunedFiles, ...supplied.filter(entry => !accepted.includes(entry)).map(entry => entry.path)];
    return prepareSkillImport(directoryName!, captured, {count: excluded.length, paths: excluded.slice(0, 20)});
}
