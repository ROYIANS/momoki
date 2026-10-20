import type {ProductStore} from "../../../platform/storage/types";
import {db as productDb} from "../../../platform/product/store";
import {type AgentConfig, type AgentPermissionMode, GENERAL_AGENT_ID} from "../models/agent";
import {assembleSkills, DEFAULT_SKILL_IDS} from "../runtime/skills";
import {nowIso} from "../../../platform/identity";

const SKILL_DEFAULTS_VERSION = 3;

/** May also run in the transaction that creates a run. */
export async function getGeneralAgentConfig(store?: ProductStore): Promise<AgentConfig> {
    const db = store ?? productDb;
    return db.transaction("rw", [db.agents].flat(), async (db) => {
        const existing = await db.agents.get(GENERAL_AGENT_ID);
        if (existing) {
            // Enable the foundational creative skills once for existing installations.
            // A saved version prevents later reads from undoing the user's switch choices.
            if ((existing.skillDefaultsVersion ?? 0) < SKILL_DEFAULTS_VERSION) {
                const version = existing.skillDefaultsVersion ?? 0;
                const enabledSkillIds = existing.enabledSkillIds?.length === 0 ? []
                    : version < 1 ? [...DEFAULT_SKILL_IDS] : [...(existing.enabledSkillIds ?? DEFAULT_SKILL_IDS)];
                if (enabledSkillIds.length) {
                    if (version < 2) enabledSkillIds.push("ip-management", "material-library");
                    if (version < 3) enabledSkillIds.push("audio-production", "music-creation");
                }
                const migrated: AgentConfig = {
                    ...existing,
                    permissionMode: existing.permissionMode ?? "ask",
                    enabledSkillIds: [...new Set(enabledSkillIds)],
                    skillDefaultsVersion: SKILL_DEFAULTS_VERSION,
                    updatedAt: nowIso()
                };
                await db.agents.put(migrated);
                return migrated;
            }
            return {
                ...existing,
                permissionMode: existing.permissionMode ?? "ask",
                enabledSkillIds: existing.enabledSkillIds ?? [...DEFAULT_SKILL_IDS]
            };
        }
        const agent: AgentConfig = {
            id: GENERAL_AGENT_ID,
            name: "创作助手",
            instructions: "你是默默（全名齐默默），Momoki 里的通用创作助手，帮助用户梳理创意、剧本和制作计划。准确说明已完成的工作，不要声称执行了没有实际调用的工具或修改了系统数据。",
            permissionMode: "ask",
            enabledSkillIds: [...DEFAULT_SKILL_IDS],
            skillDefaultsVersion: SKILL_DEFAULTS_VERSION,
            updatedAt: nowIso(),
        };
        await db.agents.add(agent);
        return agent;
    });
}

export async function updateGeneralAgentConfig(patch: {
    permissionMode?: AgentPermissionMode;
    enabledSkillIds?: string[]
}, store?: ProductStore): Promise<void> {
    const db = store ?? productDb;
    if (patch.permissionMode !== undefined && !["ask", "assist", "full"].includes(patch.permissionMode)) throw new Error("未知授权模式");
    if (patch.enabledSkillIds) assembleSkills(patch.enabledSkillIds);
    await db.transaction("rw", [db.agents].flat(), async (db) => {
        const agent = await getGeneralAgentConfig(db);
        await db.agents.update(agent.id, {...patch, updatedAt: nowIso()});
    });
}
