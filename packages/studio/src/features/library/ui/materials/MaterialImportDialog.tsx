import {useEffect, useRef, useState} from "react";
import {Upload} from "../../../../ui/icons";
import {createFileMaterial} from "../../commands/materials";
import {Button} from "../../../../ui/button";
import {SidePanel} from "../../../../app/layout/SidePanel";
import {MaterialScopeSelect, parseScope, useMaterialDraftGuard} from "./MaterialControls";
import {StorageError} from "../../../../platform/storage/errors";
import type {MaterialScope} from "../../models/materials";

export const MATERIAL_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/webm,audio/flac,audio/aac,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.txt,.md,.pdf,.docx";

type ImportBatch = {scope: MaterialScope; total: number; completed: number; lastId?: string; unknown: boolean};
type ImportProgress = {total: number; completed: number; currentName?: string; stopRequested: boolean};

export type ImportInterruption = {completed: number; remaining: number; uncertain: boolean};

export function MaterialImportDialog({initialScope, open = true, onClose, onImported, onInterrupted}: {
    initialScope: string;
    open?: boolean;
    onClose: () => void;
    onImported: (id: string) => void;
    /** The dialog unmounted mid-batch: acknowledged files stay saved, unprocessed ones are dropped. */
    onInterrupted?: (summary: ImportInterruption) => void;
}) {
    const [scope, setScope] = useState(initialScope);
    const [files, setFiles] = useState<File[]>([]);
    const filesRef = useRef<File[]>([]);
    const batchRef = useRef<ImportBatch | null>(null);
    const [pending, setPending] = useState(false);
    const pendingRef = useRef(false);
    const filePicker = useRef<HTMLInputElement>(null);
    const [error, setError] = useState("");
    const [progress, setProgress] = useState<ImportProgress | null>(null);
    const [unknown, setUnknown] = useState(false);
    const stopRemaining = useRef(false);
    const activeRef = useRef(true);
    const {requestClose, dialog} = useMaterialDraftGuard(files.length > 0, pending);
    useEffect(() => {
        activeRef.current = true;
        return () => {activeRef.current = false;};
    }, []);
    useEffect(() => {
        if (open && !filesRef.current.length && !batchRef.current && !pendingRef.current) setScope(initialScope);
    }, [open, initialScope]);

    function reset() {
        filesRef.current = [];
        batchRef.current = null;
        setFiles([]);
        setProgress(null);
        setUnknown(false);
        setError("");
    }

    function close() {
        if (pendingRef.current) return;
        // Hiding uncertain recovery is reversible; the mounted page retains its queue.
        if (batchRef.current?.unknown) onClose();
        else requestClose(() => {reset(); onClose();});
    }

    /** Explicit user attestation after checking the library; never inferred. */
    function resolveUnknown(action: "skip" | "retry") {
        const batch = batchRef.current;
        if (pendingRef.current || !batch?.unknown) return;
        batch.unknown = false;
        setUnknown(false);
        setError("");
        if (action === "retry") return;
        filesRef.current = filesRef.current.slice(1);
        batch.total--;
        setFiles(filesRef.current);
        setProgress({total: batch.total, completed: batch.completed, stopRequested: false});
        if (filesRef.current.length) return;
        if (batch.lastId) finishImport(batch.lastId);
        else {reset(); onClose();}
    }

    function requestStop() {
        if (!pendingRef.current || stopRemaining.current) return;
        stopRemaining.current = true;
        setProgress(current => current ? {...current, stopRequested: true} : current);
    }

    function finishImport(lastId: string) {
        // Command acknowledgements and opening the confirmed result are separate outcomes.
        try {
            onImported(lastId);
            reset();
            onClose();
        } catch {
            setError("全部文件已导入，但未能打开素材。请从素材库查看，避免重复导入。");
        }
    }

    async function save() {
        if (pendingRef.current || !filesRef.current.length || batchRef.current?.unknown) return;
        pendingRef.current = true;
        stopRemaining.current = false;
        const batch = batchRef.current ?? {scope: parseScope(scope), total: filesRef.current.length, completed: 0, unknown: false};
        batchRef.current = batch;
        setPending(true);
        setError("");
        setProgress({total: batch.total, completed: batch.completed, stopRequested: false});
        let allImported = false;
        try {
            while (filesRef.current.length) {
                if (stopRemaining.current) break;
                const file = filesRef.current[0];
                setProgress({total: batch.total, completed: batch.completed, currentName: file.name, stopRequested: false});
                const material = await createFileMaterial(file, batch.scope);
                batch.lastId = material.id;
                batch.completed++;
                filesRef.current = filesRef.current.slice(1);
                if (!activeRef.current) {
                    if (filesRef.current.length) onInterrupted?.({completed: batch.completed, remaining: filesRef.current.length, uncertain: false});
                    return;
                }
                setFiles(filesRef.current);
                setProgress({total: batch.total, completed: batch.completed, stopRequested: stopRemaining.current});
            }
            allImported = filesRef.current.length === 0;
        } catch (cause) {
            if (!activeRef.current) {
                onInterrupted?.({completed: batch.completed, remaining: filesRef.current.length,
                    uncertain: cause instanceof StorageError && cause.certainty === "unknown"});
                return;
            }
            if (cause instanceof StorageError && cause.certainty === "unknown") {
                batch.unknown = true;
                setUnknown(true);
                setError("当前文件的导入结果待确认，请先核对素材库。已确认保存的文件会保留；核对后请选择重新导入或跳过此文件，系统不会自动重复导入。");
            } else setError(cause instanceof Error ? cause.message : "导入失败，请重试。已保存的文件不会重复导入。");
        } finally {
            pendingRef.current = false;
            if (activeRef.current) {
                setPending(false);
                setProgress({total: batch.total, completed: batch.completed, stopRequested: stopRemaining.current});
            }
        }
        if (activeRef.current && allImported && batch.lastId) finishImport(batch.lastId);
    }

    let importLabel = `导入${files.length ? ` ${files.length} 个文件` : ""}`;
    if (progress) importLabel = "继续导入";
    if (pending) importLabel = "正在导入…";
    const selectionLocked = pending || unknown || progress !== null;
    return <><SidePanel open={open} onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
    }} kind="material-import" width={460} title="导入媒体与资料"
                        description="素材按选择的位置保存。项目内素材需要明确提升后，才会出现在共享素材中。"
                        footer={<><Button variant="outline" disabled={pending}
                                          onClick={close}>{unknown ? "查看素材库" : "取消"}</Button>
                            {unknown && <><Button variant="outline" onClick={() => resolveUnknown("retry")}>已核对，重新导入此文件</Button>
                                <Button variant="outline" onClick={() => resolveUnknown("skip")}>已核对，跳过此文件继续</Button></>}
                            {pending && <Button variant="outline" disabled={progress?.stopRequested} onClick={requestStop}>停止后续导入</Button>}
                            <Button disabled={pending || unknown || !files.length}
                                    onClick={() => void save()}>{importLabel}</Button></>}>
        <label className="material-field">保存位置<MaterialScopeSelect value={scope} onChange={value => {
            if (!pendingRef.current && !batchRef.current) setScope(value);
        }} disabled={selectionLocked}/></label>
        <div className="material-upload"><Upload aria-hidden/><Button variant="outline" disabled={selectionLocked}
                                                                      onClick={() => filePicker.current?.click()}>选择文件</Button><span>图片、视频、音频、TXT、Markdown、PDF 或 DOCX</span><input
            ref={filePicker} hidden type="file" multiple accept={MATERIAL_ACCEPT} disabled={selectionLocked}
            onChange={(event) => {
                if (pendingRef.current || batchRef.current) return;
                const selected = Array.from(event.target.files ?? []);
                if (!selected.length) return;
                filesRef.current = selected;
                batchRef.current = null;
                setFiles(filesRef.current);
                setProgress(null);
                setError("");
            }}/></div>
        {files.length > 0 &&
            <ul className="material-file-list">{files.map((file, index) => <li key={`${file.name}-${index}`}>
                <span>{file.name}</span><small>{(file.size / 1024 / 1024).toFixed(1)} MB</small></li>)}</ul>}
        {error && <p role="alert" className="material-error">{error}</p>}{progress &&
            <p role="status" className="material-muted">已导入 {progress.completed} / {progress.total}
                {pending && progress.currentName && ` · 正在保存 ${progress.currentName}`}
                {pending && progress.stopRequested && " · 当前文件完成后停止后续导入"}</p>}
    </SidePanel>{dialog}</>;
}
