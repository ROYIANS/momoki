import {useEffect, useRef, useState} from "react";
import type {SkillMetadata, SkillTextRange} from "@momoki/agent-core";
import {useProductQueryState} from "../../../platform/product/queries";
import {Button} from "../../../ui/button";
import {loadInstalledSkill, readInstalledSkillResource} from "../skills/queries/installedSkills";
import type {InstalledSkill, SkillImportCandidate, SkillManifest} from "../skills/models/installedSkill";
import type {InstalledSkillsController} from "./useInstalledSkills";

function Metadata({metadata}: {metadata: SkillMetadata}) {
    return <div className="installed-skill-metadata"><h3>{metadata.name}</h3><p>{metadata.description}</p>
        {metadata.compatibility && <dl><dt>兼容要求</dt><dd>{metadata.compatibility}</dd></dl>}
        {metadata.license && <dl><dt>许可</dt><dd>{metadata.license}</dd></dl>}
        {metadata.metadata && Object.entries(metadata.metadata).map(([key, value]) => <dl key={key}><dt>{key}</dt><dd>{value}</dd></dl>)}
        {metadata.allowedTools && <div className="installed-skills-advisory"><strong>声明的工具建议</strong><p>{metadata.allowedTools}</p><p>仅供参考，不会自动启用工具或增加权限。</p></div>}
        {metadata.unsupportedFields.length > 0 && <p className="installed-skills-hint">未支持字段：{metadata.unsupportedFields.join("、")}。这些声明不产生行为。</p>}
    </div>;
}

function fileChanges(previous: SkillManifest, next: SkillManifest): {added: number; changed: number; removed: number} {
    const oldFiles = new Map([previous.document, ...previous.resources].map(file => [file.path, file.digest]));
    const newFiles = [next.document, ...next.resources];
    return {added: newFiles.filter(file => !oldFiles.has(file.path)).length,
        changed: newFiles.filter(file => oldFiles.has(file.path) && oldFiles.get(file.path) !== file.digest).length,
        removed: [...oldFiles.keys()].filter(path => !newFiles.some(file => file.path === path)).length};
}

export function SkillImportReview({candidate, target, previous}: {candidate: SkillImportCandidate; target?: InstalledSkill; previous?: SkillManifest}) {
    const [path, setPath] = useState("SKILL.md");
    const changes = previous ? fileChanges(previous, candidate.manifest) : undefined;
    const selected = [candidate.document, ...candidate.resources].find(resource => resource.path === path) ?? candidate.document;
    return <div className="installed-skill-review"><Metadata metadata={candidate.manifest.metadata}/>
        {target && <section className="installed-skills-update"><h4>更新前</h4><p>{target.metadata.name}</p><p>{target.metadata.description}</p>
            {target.metadata.compatibility && <p>兼容要求：{target.metadata.compatibility}</p>}
            {changes && <p>新增 {changes.added} · 修改 {changes.changed} · 移除 {changes.removed} 个文件</p>}
            {candidate.manifest.revision === target.revision && <p>与当前安装的内容相同。</p>}
            {candidate.manifest.metadata.name !== target.metadata.name && <p role="alert" className="installed-skills-error">更新需选择同名技能文件夹。</p>}</section>}
        <section><h4>将安装的文本文件</h4><div className="installed-skills-resources">{[candidate.document, ...candidate.resources].map(resource =>
            <button type="button" key={resource.path} aria-pressed={selected.path === resource.path} onClick={() => setPath(resource.path)}>{resource.path}</button>)}</div>
            <pre className="installed-skills-text" aria-label={`预览 ${selected.path}`}>{selected.text}</pre></section>
        {candidate.exclusions.count > 0 && <section className="installed-skills-advisory"><h4>已排除 {candidate.exclusions.count} 项</h4><p>脚本、二进制、隐藏内容及嵌套技能不会安装或执行。</p>
            <ul>{candidate.exclusions.paths.map(path => <li key={path}>{path}</li>)}</ul>
            {candidate.exclusions.count > candidate.exclusions.paths.length && <p>仅列出前 {candidate.exclusions.paths.length} 项。</p>}</section>}
    </div>;
}

export function InstalledSkillDetail({descriptor, current, controller, picking, onUpdate, onUninstalled}: {
    descriptor: InstalledSkill; current?: InstalledSkill; controller: InstalledSkillsController;
    picking: boolean; onUpdate: () => void; onUninstalled: () => void;
}) {
    const [attempt, setAttempt] = useState(0);
    const key = `${descriptor.skillId}:${descriptor.revision}`;
    const query = useProductQueryState(async tx => ({key, value: await loadInstalledSkill(descriptor, tx)}), [key, attempt]);
    const loaded = query.value?.key === key ? query.value.value : undefined;
    const [resource, setResource] = useState<{key: string; path: string; page?: SkillTextRange; error?: string}>();
    const [reading, setReading] = useState(false);
    const reader = useRef<object | undefined>(undefined);
    const active = useRef(key);
    active.current = key;
    const [confirmUninstall, setConfirmUninstall] = useState(false);
    useEffect(() => {reader.current = undefined; setReading(false); setConfirmUninstall(false);}, [key]);
    async function readResource(path: string, offset = 0) {
        const ticket = {};
        reader.current = ticket;
        setReading(true);
        setResource({key, path});
        try {
            const page = await readInstalledSkillResource(descriptor, path, offset);
            if (reader.current === ticket && active.current === key) setResource({key, path, page});
        } catch (cause) {
            if (reader.current === ticket && active.current === key) setResource({key, path, error: cause instanceof Error ? cause.message : "资料读取失败"});
        } finally {if (reader.current === ticket) setReading(false);}
    }
    const selected = resource?.key === key ? resource : undefined;
    const writable = !!current && !controller.blocked;
    return <div className="installed-skill-detail"><Metadata metadata={descriptor.metadata}/>
        <div className="installed-skills-actions"><label className="installed-skills-enable"><input type="checkbox" role="switch"
            aria-label={`启用 ${descriptor.metadata.name}`} checked={current?.enabled ?? descriptor.enabled} disabled={!writable}
            onChange={event => {if (current) void controller.toggle(current, event.target.checked);}}/>启用</label>
            <Button type="button" size="sm" variant="outline" disabled={!writable || picking} aria-busy={picking} onClick={onUpdate}>选择文件夹更新</Button>
            <Button type="button" size="sm" variant="ghost" disabled={!writable} onClick={() => setConfirmUninstall(true)}>卸载</Button></div>
        {!current && <p role="alert" className="installed-skills-hint">当前安装已变化，正在查看已打开的版本。返回列表后可查看最新状态。</p>}
        {confirmUninstall && <div className="installed-skills-advisory"><p>卸载 {descriptor.metadata.name}？新执行将不再使用它，已记录的执行仍保留原版本。</p>
            <div className="installed-skills-actions"><Button type="button" size="sm" variant="destructive" disabled={!writable}
                onClick={() => {if (current) void controller.uninstall(current, onUninstalled);}}>确认卸载</Button>
                <Button type="button" size="sm" variant="outline" disabled={controller.pending || !!controller.uncertain} onClick={() => setConfirmUninstall(false)}>取消卸载</Button></div></div>}
        {query.error && <div role="alert" className="installed-skills-error"><p>{query.error.message}</p><Button type="button" size="sm" variant="outline" onClick={() => setAttempt(value => value + 1)}>重试读取内容</Button></div>}
        {!loaded && !query.error && <p className="installed-skills-hint">正在读取技能内容…</p>}
        {loaded && <section><h4>技能内容</h4><div className="installed-skills-resources"><button type="button" aria-pressed={!selected} onClick={() => {reader.current = undefined; setReading(false); setResource(undefined);}}>SKILL.md</button>
            {loaded.manifest.resources.map(file => <button type="button" key={file.path} aria-pressed={selected?.path === file.path} onClick={() => void readResource(file.path)}>{file.path}</button>)}</div>
            {selected ? <><h4>{selected.path}</h4>{reading && <p className="installed-skills-hint">正在读取资料…</p>}
                {selected.error && <div role="alert" className="installed-skills-error"><p>{selected.error}</p><Button type="button" size="sm" variant="outline" onClick={() => void readResource(selected.path)}>重试读取资料</Button></div>}
                {selected.page && <><pre className="installed-skills-text" aria-label={selected.path}>{selected.page.text}</pre>
                    <div className="installed-skills-actions">{selected.page.offset > 0 && <Button type="button" size="sm" variant="outline" onClick={() => void readResource(selected.path)}>回到开头</Button>}
                        {!selected.page.end && <Button type="button" size="sm" variant="outline" onClick={() => void readResource(selected.path, selected.page!.nextOffset)}>读取下一段</Button>}</div></>}
            </> : <pre className="installed-skills-text" aria-label="SKILL.md">{loaded.document}</pre>}
        </section>}
    </div>;
}
