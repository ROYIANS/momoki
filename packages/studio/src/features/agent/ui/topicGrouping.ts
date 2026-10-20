import type {ChatThread} from "../models/chat";
import type {Id} from "../../../platform/identity";
import type {Project} from "../../projects/models/project";

export type TopicGrouping = "project" | "time";

export const TOPIC_GROUPING_KEY = "momoki.agent.topicGrouping";
export const UNLINKED_PROJECT_KEY = "__unlinked__";
const UNLINKED_PROJECT_LABEL = "未关联项目";

export interface TopicProjectGroup {
    key: string;
    label: string;
    threads: ChatThread[];
}

/** Invalid values or unavailable storage fall back to the default without throwing. */
export function readTopicGrouping(storage?: Pick<Storage, "getItem">): TopicGrouping {
    try {
        const value = (storage ?? localStorage).getItem(TOPIC_GROUPING_KEY);
        return value === "time" || value === "project" ? value : "project";
    } catch {
        return "project";
    }
}

/** Write failures are ignored; the preference is a convenience only. */
export function writeTopicGrouping(value: TopicGrouping, storage?: Pick<Storage, "setItem">): void {
    try {
        (storage ?? localStorage).setItem(TOPIC_GROUPING_KEY, value);
    } catch {
        // ignore
    }
}

const stamp = (thread: ChatThread) => new Date(thread.updatedAt).getTime() || 0;

/**
 * One section per project that actually has topics, newest activity first; topics with no or
 * a deleted project go to 未关联项目 at the end. Topics inside a section are newest first.
 */
export function groupThreadsByProject(threads: ChatThread[], projects: Project[]): TopicProjectGroup[] {
    const names = new Map<Id, string>(projects.map((project) => [project.id, project.name]));
    const buckets = new Map<string, ChatThread[]>();
    for (const thread of threads) {
        const key = thread.projectId && names.has(thread.projectId) ? thread.projectId : UNLINKED_PROJECT_KEY;
        const list = buckets.get(key);
        if (list) list.push(thread);
        else buckets.set(key, [thread]);
    }
    const groups: TopicProjectGroup[] = [];
    for (const [key, list] of buckets) {
        list.sort((a, b) => stamp(b) - stamp(a));
        groups.push({
            key,
            label: key === UNLINKED_PROJECT_KEY ? UNLINKED_PROJECT_LABEL : names.get(key) ?? "",
            threads: list
        });
    }
    return groups.sort((a, b) => {
        if (a.key === UNLINKED_PROJECT_KEY) return 1;
        if (b.key === UNLINKED_PROJECT_KEY) return -1;
        return stamp(b.threads[0]) - stamp(a.threads[0]);
    });
}

/** Compact relative age shown at the right of a topic row. */
export function formatRelativeShort(iso: string, now: number = Date.now()): string {
    const ts = new Date(iso).getTime();
    if (Number.isNaN(ts)) return "";
    const diff = Math.max(0, now - ts);
    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时`;
    const days = Math.floor(diff / 86_400_000);
    if (days < 30) return `${days} 天`;
    if (days < 365) return `${Math.floor(days / 30)} 个月`;
    return `${Math.floor(days / 365)} 年`;
}
