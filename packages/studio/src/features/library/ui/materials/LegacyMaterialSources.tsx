import {useRef, useState} from "react";
import {useProductQuery} from "../../../../platform/product/queries";
import {Link} from "@tanstack/react-router";
import {ArrowUpRight, Layers} from "../../../../ui/icons";
import {promoteLegacyMaterial} from "../../commands/materials";
import {type MediaRecord} from "../../models/media";
import {STUDIO_LIBRARY_ID} from "../../models/ownership";
import {slotMediaIds} from "../../models/slot";
import type {MaterialEntity, MaterialKind, MaterialPayload, SettingMaterialKind} from "../../models/materials";
import {Button} from "../../../../ui/button";
import {SidePanel} from "../../../../app/layout/SidePanel";
import {MaterialPreview} from "./MaterialPreview";
import {KIND_LABELS, MaterialScopeSelect, parseScope, useMaterialDraftGuard} from "./MaterialControls";

type LegacyRow = { id: string; kind: MaterialKind | "media"; name: string; ownerId: string; payload: MaterialPayload };

function mediaKind(media: MediaRecord): MaterialKind {
    return media.mimeType.startsWith("image/") ? "image" : media.mimeType.startsWith("video/") ? "video" : media.mimeType.startsWith("audio/") ? "audio" : "document";
}

export function LegacyMaterialSources({view, scope, search, kind, onCreated}: {
    view: "media" | "settings";
    scope: string;
    search: string;
    kind: string;
    onCreated: (id: string) => void
}) {
    const [selected, setSelected] = useState<LegacyRow | null>(null);
    const [target, setTarget] = useState(scope.startsWith("ip:") ? scope : "global");
    const [pending, setPending] = useState(false);
    const pendingRef = useRef(false);
    const [error, setError] = useState("");
    const {requestClose, dialog} = useMaterialDraftGuard(false, pending);
    const data = useProductQuery(async (db) => {
        if (scope.startsWith("ip:")) return {rows: [] as LegacyRow[], projects: [], media: [] as MediaRecord[]};
        const ownerId = scope.startsWith("project:") ? scope.slice(8) : STUDIO_LIBRARY_ID;
        const [media, characters, scenes, props, styles, projects] = await Promise.all([
            scope === "all" ? db.media.toArray() : db.media.where("projectId").equals(ownerId).toArray(),
            view === "media" ? [] : scope === "all" ? db.characters.toArray() : db.characters.where("projectId").equals(ownerId).toArray(),
            view === "media" ? [] : scope === "all" ? db.scenes.toArray() : db.scenes.where("projectId").equals(ownerId).toArray(),
            view === "media" ? [] : scope === "all" ? db.props.toArray() : db.props.where("projectId").equals(ownerId).toArray(),
            view === "media" ? [] : scope === "all" ? db.styles.toArray() : db.styles.where("projectId").equals(ownerId).toArray(),
            db.projects.toArray(),
        ]);
        const rows: LegacyRow[] = view === "media" ? media.filter(item => !item.derivative).map((item) => ({
            id: item.id,
            kind: "media",
            name: item.filename || "未命名文件",
            ownerId: item.projectId,
            payload: {type: "file", blob: item.blob, filename: item.filename, mimeType: item.mimeType}
        })) : [
            ["character", characters], ["scene", scenes], ["prop", props], ["style", styles],
        ].flatMap(([entityKind, entities]) => (entities as MaterialEntity[]).map((entity) => ({
            id: entity.id,
            name: entity.name || "未命名设定",
            kind: entityKind as SettingMaterialKind,
            ownerId: entity.projectId,
            payload: {
                type: "setting" as const,
                kind: entityKind as SettingMaterialKind,
                entity,
                media: media.filter((item) => item.projectId === entity.projectId && Object.values(entity.slots).flatMap((slot) => slot ? slotMediaIds(slot) : []).includes(item.id))
            }
        })));
        return {rows, projects, media};
    }, [view, scope]);
    if (scope.startsWith("ip:")) return null;
    const rows = data?.rows.filter((row) => (scope === "all" || (scope.startsWith("project:") ? row.ownerId === scope.slice(8) : row.ownerId === STUDIO_LIBRARY_ID)) && (!search.trim() || row.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) && (kind === "all" || (row.kind === "media" ? mediaKind(data.media.find((item) => item.id === row.id)!) : row.kind) === kind));

    async function promote() {
        if (!selected || pendingRef.current) return;
        pendingRef.current = true;
        setPending(true);
        setError("");
        try {
            const material = await promoteLegacyMaterial(selected.kind, selected.id, parseScope(target));
            setSelected(null);
            onCreated(material.id);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "无法提升素材，请重试");
        } finally {
            pendingRef.current = false;
            setPending(false);
        }
    }

    return <section className="material-legacy" aria-label="现有项目与工作室素材">
        <header>
            <div><h2><Layers size={16} aria-hidden/>现有素材</h2>
                <p>保留原来的编辑方式。提升为独立版本后，可在新的项目中复用。</p></div>
            <span>{rows?.length ?? "…"} 项</span></header>
        {!rows ? <p role="status">读取现有素材…</p> : rows.length === 0 ?
            <p className="material-muted">当前筛选下没有现有素材。</p> :
            <div className="material-grid">{rows.map((row) => <Button variant="ghost" className="material-card"
                                                                      key={`${row.kind}-${row.id}`} onClick={() => {
                setSelected(row);
                setError("");
                setTarget("global");
            }}><MaterialPreview payload={row.payload}/>
                <div className="material-card-caption">
                    <strong>{row.name}</strong><span>{row.ownerId === STUDIO_LIBRARY_ID ? "工作室原件" : data?.projects.find((project) => project.id === row.ownerId)?.name ?? "原项目已删除"}</span>
                </div>
            </Button>)}</div>}
        {selected && <SidePanel open onOpenChange={(open) => {
            if (!open) requestClose(() => setSelected(null));
        }} kind="material-promote" width={460} title={selected.name}
                                description="从原件建立独立素材快照。以后编辑或删除原件，不会改变已保存的版本。"
                                footer={<><Button variant="outline" disabled={pending}
                                                  onClick={() => setSelected(null)}>关闭</Button><Button disabled={pending}
                                                                                                         onClick={() => void promote()}>{pending ? "正在保存…" : "保存为独立素材"}</Button></>}>
            <MaterialPreview payload={selected.payload} inspect/>
            {selected.kind !== "media" && <LegacySettingLink row={selected}/>}
            <label className="material-field">提升到<MaterialScopeSelect value={target} onChange={setTarget}
                                                                         disabled={pending}/></label>
            {error && <p role="alert" className="material-error">{error}</p>}
        </SidePanel>}{dialog}
    </section>;
}

export function LegacySettingLink({row}: { row: Pick<LegacyRow, "kind" | "id" | "ownerId"> }) {
    const collection = row.kind === "character" ? "characters" : row.kind === "scene" ? "scenes" : row.kind === "prop" ? "props" : "styles";
    const href = row.ownerId === STUDIO_LIBRARY_ID ? `/${collection}/${encodeURIComponent(row.id)}` : `/p/${encodeURIComponent(row.ownerId)}/assets/${collection}/${encodeURIComponent(row.id)}`;
    return <Link to={href}
                 className="material-source-link">编辑原{row.kind === "media" ? "素材" : KIND_LABELS[row.kind]}<ArrowUpRight
        size={14} aria-hidden/></Link>;
}
