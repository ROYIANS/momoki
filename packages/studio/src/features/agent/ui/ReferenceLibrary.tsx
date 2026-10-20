import {binaryPreviewMessage, useBinaryPreview} from "../../library/services/media";
import type {MediaRecord} from "../../library/models/media";
import {useState} from "react";
import {useProductQuery} from "../../../platform/product/queries";
import {Check, Plus, RotateCcw, Search, Trash2, Upload} from "../../../ui/icons";
import {toast} from "sonner";
import {listProjectReferences, removeProjectReference} from "../../references/commands/references";
import {registerProjectImage, retryReferenceImport} from "../../references/documents/import";
import {type ProjectReference, type ReferenceAttachment, referenceAttachment} from "../../references/models/references";
import {SidePanel} from "../../../app/layout/SidePanel";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle
} from "../../../ui/alert-dialog";
import {REFERENCE_STATUS_LABELS, ReferenceSourceLink} from "./ReferenceAttachments";

export function ReferenceLibrary({projectId, open, onOpenChange, selected, onSelect, onImport}: {
    projectId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    selected: readonly Readonly<ReferenceAttachment>[];
    onSelect: (attachment: ReferenceAttachment) => void;
    onImport: () => void
}) {
    const [view, setView] = useState<"references" | "images">("references");
    const [query, setQuery] = useState("");
    const [attempt, setAttempt] = useState(0);
    const [busy, setBusy] = useState<string>();
    const [remove, setRemove] = useState<ProjectReference>();
    const loaded = useProductQuery(async (db) => {
        try {
            return {projectId, rows: open ? await listProjectReferences(projectId, db) : [], error: undefined};
        } catch (error) {
            return {projectId, rows: [], error: error instanceof Error ? error.message : "读取资料库失败"};
        }
    }, [projectId, open, attempt]);
    const loadedImages = useProductQuery(async (db) => {
        try {
            return {
                projectId,
                rows: open && view === "images" ? await db.media.where("projectId").equals(projectId).filter((row) => ["image/png", "image/jpeg", "image/webp"].includes(row.mimeType)).toArray() : [],
                error: undefined
            };
        } catch {
            return {projectId, rows: [], error: "读取项目图片失败，请重新打开资料库"};
        }
    }, [projectId, open, view]);
    const images = loadedImages?.projectId === projectId ? loadedImages : undefined;

    async function chooseImage(media: MediaRecord) {
        if (busy) return;
        setBusy(media.id);
        try {
            const reference = await registerProjectImage(projectId, media.id);
            if (reference.status !== "ready") throw new Error(reference.error ?? "图片不可用");
            onSelect(referenceAttachment(reference));
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "附加图片失败");
        } finally {
            setBusy(undefined);
        }
    }

    const result = loaded?.projectId === projectId ? loaded : undefined;
    const rows = result?.rows.filter((row) => row.filename.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];

    async function retry(row: ProjectReference) {
        setBusy(row.id);
        try {
            await retryReferenceImport(projectId, row.id);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "重新解析失败");
        } finally {
            setBusy(undefined);
        }
    }

    async function removeSource() {
        if (!remove || busy) return;
        setBusy(remove.id);
        try {
            await removeProjectReference(projectId, remove.id);
            setRemove(undefined);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "移除失败");
        } finally {
            setBusy(undefined);
        }
    }

    return <><SidePanel open={open} onOpenChange={onOpenChange} kind="reference-library" width={460} title="项目资料">
        <div className="reference-library-tabs" aria-label="资料类型">
            <button type="button" aria-pressed={view === "references"} onClick={() => setView("references")}>参考资料
            </button>
            <button type="button" aria-pressed={view === "images"} onClick={() => setView("images")}>项目图片</button>
        </div>
        <div className="reference-library-toolbar"><label><Search size={16}/><input autoFocus aria-label="搜索项目资料"
                                                                                    placeholder="搜索文件名…"
                                                                                    value={query}
                                                                                    onChange={(e) => setQuery(e.target.value)}/></label>
            <button type="button" onClick={onImport}><Upload size={16}/>导入</button>
        </div>
        <div className="reference-library-list">
            {view === "images" ? !images ? <p role="status">加载图片…</p> : images.error ?
                <p role="alert">{images.error}</p> : <>
                    <div
                        className="reference-image-grid">{images.rows.filter((row) => row.filename.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map((media) =>
                        <ProjectImage key={media.id} media={media} disabled={!!busy}
                                      onSelect={() => void chooseImage(media)}/>)}</div>
                    {!images.rows.length && <p className="reference-empty">项目中还没有图片</p>}</> : !result ?
                <p role="status">加载中…</p> : result.error ? <div role="alert"><p>{result.error}</p>
                    <button type="button" onClick={() => setAttempt((n) => n + 1)}>重试</button>
                </div> : !rows.length ? <div className="reference-empty">{query ? <strong>没有匹配的资料</strong> : <Upload size={28}/>}</div> : rows.map((row) => {
                    const attached = selected.some((item) => item.referenceId === row.id && item.revision === row.revision);
                    const usable = row.status === "ready" || row.status === "partial";
                    return <div className="reference-library-row" key={row.id}>
                        <div><ReferenceSourceLink projectId={projectId}
                                                  attachment={referenceAttachment(row)}/><small>{[row.kind.toUpperCase(), `${(row.size / 1024).toFixed(0)} KB`, REFERENCE_STATUS_LABELS[row.status]].filter(Boolean).join(" · ")}</small>{row.error &&
                            <p className="reference-error">{row.error}</p>}{row.warnings.map((warning, i) => <p
                            className="reference-warning" key={i}>{warning}</p>)}</div>
                        <div className="reference-row-actions">{(row.status === "failed" || row.status === "parsing") &&
                            <button type="button" disabled={!!busy} aria-label={`重新解析 ${row.filename}`}
                                    onClick={() => void retry(row)}><RotateCcw size={16}/></button>}
                            <button type="button" disabled={!usable || attached}
                                    onClick={() => onSelect(referenceAttachment(row))}
                                    aria-label={`${attached ? "已附加" : "附加"} ${row.filename}`}>{attached ?
                                <Check size={16}/> : <Plus size={16}/>}</button>
                            <button type="button" disabled={!!busy} onClick={() => setRemove(row)}
                                    aria-label={`移除资料 ${row.filename}`}><Trash2 size={15}/></button>
                        </div>
                    </div>;
                })}</div>
    </SidePanel><AlertDialog open={!!remove} onOpenChange={(next) => {
        if (!next && !busy) setRemove(undefined);
    }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>从项目移除这份资料？</AlertDialogTitle><AlertDialogDescription>“{remove?.filename}”将无法用于新的消息和工具读取。历史消息及引用记录仍会保留。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel
        disabled={!!busy}>取消</AlertDialogCancel><AlertDialogAction disabled={!!busy} onClick={(event) => {
        event.preventDefault();
        void removeSource();
    }}>移除资料</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></>;
}

function ProjectImage({media, disabled, onSelect}: { media: MediaRecord; disabled: boolean; onSelect: () => void }) {
    const image = useBinaryPreview(media.blob);
    return <button type="button" className="reference-project-image" disabled={disabled || image.status !== "ready"}
                   onClick={onSelect}
                   title={`附加 ${media.filename}`}>{image.status === "ready" ?
        <img src={image.url} onError={image.onError} alt={media.filename} loading="lazy"/> :
        <small>{binaryPreviewMessage(image)}</small>}<span>{media.filename}</span><small>附加图片</small>
    </button>;
}
