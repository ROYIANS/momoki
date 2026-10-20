import {SelectOption, SourcePlayer, WorkspaceSelect} from "../presentation/controls";
import {useEffect, useRef, useState} from "react";
import {useProductQuery} from "../../../platform/product/queries";
import {withBinaryReadLease} from "../../../platform/storage/binary";
import {Check, ChevronDown, Library, Mic, Plus, Square, Upload, X} from "../../../ui/icons";
import {db} from "../../../platform/product/store";
import {addAudioTake} from "../commands/audio";
import {adoptMaterialInProject} from "../../library/commands/materials";
import type {AudioTake} from "../models/audio";
import {audioBufferMetadata, decodeAudioBlob} from "../engine/engine";
import {listMicrophones, MicrophoneRecorder} from "../engine/recorder";
import {audioMimeExtension, detectAudioMime} from "../engine/mime";
import {createId} from "../../../platform/identity";
import {Button} from "../../../ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "../../../ui/dropdown-menu";
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
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from "../../../ui/dialog";
import {SidePanel} from "../../../app/layout/SidePanel";
import {errorText, Field, timeLabel} from "../presentation/shared";

export async function keepAudioSource(projectId: string, blob: Blob, name: string, source: AudioTake["source"], segmentId?: string) {
    const buffer = await decodeAudioBlob(blob);
    const mediaId = createId("med");
    const mimeType = await detectAudioMime(blob);
    const original = new Blob([blob], {type: mimeType});
    const filename = /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.${audioMimeExtension(mimeType)}`;
    return addAudioTake(projectId, {...audioBufferMetadata(buffer), mediaId, name, source, segmentId}, {
        id: mediaId,
        projectId,
        blob: original,
        filename,
        mimeType
    });
}

export function AudioSources({projectId, segmentId, onSaved, compact = false, request}: {
    projectId: string;
    segmentId?: string;
    onSaved: (take: AudioTake) => void;
    compact?: boolean;
    request?: { id: string; segmentId?: string };
}) {
    const [menuOpen, setMenuOpen] = useState(false);
    const [targetSegmentId, setTargetSegmentId] = useState<string>();
    const uploadTarget = useRef<string | undefined>(undefined);
    const lastRequest = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (!request || request.id === lastRequest.current) return;
        lastRequest.current = request.id;
        setTargetSegmentId(request.segmentId);
        setMenuOpen(true);
    }, [request]);

    function startUpload() {
        uploadTarget.current = targetSegmentId;
        input.current?.click();
    }

    const [recording, setRecording] = useState(false);
    const [capture, setCapture] = useState({dirty: false, saving: false});
    const [confirmClose, setConfirmClose] = useState(false);
    const changeRecording = (open: boolean) => {
        if (open) {
            setCapture({dirty: false, saving: false});
            setRecording(true);
            return;
        }
        if (capture.saving) return;
        if (capture.dirty) setConfirmClose(true); else setRecording(false);
    };
    const [library, setLibrary] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const input = useRef<HTMLInputElement>(null);
    return <>
        <div className="aw-actions">{compact ? <DropdownMenu open={menuOpen} onOpenChange={(open) => {
            if (open) setTargetSegmentId(segmentId);
            setMenuOpen(open);
        }}>
            <DropdownMenuTrigger asChild><Button size="sm" variant="outline" disabled={busy}><Plus/>添加声音<ChevronDown
                className="size-3"/></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuLabel>{targetSegmentId ? "为当前段落添加版本" : "添加到项目声音"}</DropdownMenuLabel>
                <DropdownMenuSeparator/>
                <DropdownMenuItem onSelect={() => changeRecording(true)}><Mic/>录制配音</DropdownMenuItem>
                <DropdownMenuItem onSelect={startUpload}><Upload/>上传音频</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setLibrary(true)}><Library/>从素材库选择</DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu> : <><Button size="sm" variant="outline" disabled={busy} onClick={() => {
            setTargetSegmentId(segmentId);
            changeRecording(true);
        }}><Mic/>录音</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => {
            uploadTarget.current = segmentId;
            input.current?.click();
        }}><Upload/>导入</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => {
            setTargetSegmentId(segmentId);
            setLibrary(true);
        }}><Library/>素材库</Button></>}<input ref={input} type="file"
                                               accept="audio/*,.wav,.mp3,.m4a,.aac,.flac,.ogg,.webm" hidden
                                               onChange={(e) => {
                                                   const file = e.target.files?.[0];
                                                   e.target.value = "";
                                                   if (!file)
                                                       return;
                                                   setBusy(true);
                                                   setError("");
                                                   void keepAudioSource(projectId, file, file.name, "upload", uploadTarget.current).then(onSaved).catch((err: unknown) => setError(errorText(err))).finally(() => setBusy(false));
                                               }}/></div>
        {busy && <p className="aw-muted mt-2" role="status">正在校验并保存原始音频…</p>}{error &&
        <p role="alert" className="aw-error">{error}</p>}
        <Dialog open={recording} onOpenChange={changeRecording}><DialogContent
            className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>录制配音</DialogTitle><DialogDescription>可以先录音，再补充文字。保留录音会新增一个版本。</DialogDescription></DialogHeader>{recording &&
            <Recorder projectId={projectId} segmentId={targetSegmentId} onCaptureChange={setCapture}
                      onSaved={(take) => {
                          onSaved(take);
                          setRecording(false);
                      }}/>}</DialogContent></Dialog>
        <AlertDialog open={confirmClose}
                     onOpenChange={setConfirmClose}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>退出这次录音？</AlertDialogTitle><AlertDialogDescription>当前录音还没有保留。退出会停止麦克风，并舍弃这次未保存的声音；项目里已有的版本不会改变。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>继续录音工作</AlertDialogCancel><AlertDialogAction
            onClick={() => {
                setConfirmClose(false);
                setRecording(false);
                setCapture({dirty: false, saving: false});
            }}>舍弃并退出</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
        <SidePanel open={library} onOpenChange={setLibrary} kind="audio-source-library" title="从素材库添加音频"
                   description="添加后在当前项目保存独立副本。">
            {library && <AudioLibrary projectId={projectId} segmentId={targetSegmentId} onSaved={(take) => {
                onSaved(take);
                setLibrary(false);
            }}/>}
        </SidePanel>
    </>;
}

function Recorder({projectId, segmentId, onSaved, onCaptureChange}: {
    onCaptureChange: (state: { dirty: boolean; saving: boolean }) => void;
    projectId: string;
    segmentId?: string;
    onSaved: (take: AudioTake) => void;
}) {
    const [state, setState] = useState("idle");
    const [error, setError] = useState("");
    const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
    const [deviceId, setDeviceId] = useState("");
    const [seconds, setSeconds] = useState(0);
    const [level, setLevel] = useState(0);
    const [url, setUrl] = useState<string>();
    const [saving, setSaving] = useState(false);
    const recorder = useRef<MicrophoneRecorder | null>(null);
    useEffect(() => {
        const instance = new MicrophoneRecorder({onState: setState, onError: (e) => setError(errorText(e))});
        recorder.current = instance;
        void listMicrophones().then(setDevices).catch((e: unknown) => setError(errorText(e)));
        const timer = window.setInterval(() => {
            setSeconds(instance.elapsedSec);
            setLevel(instance.readLevel());
        }, 80);
        return () => {
            clearInterval(timer);
            instance.dispose();
            recorder.current = null;
        };
    }, []);
    useEffect(() => () => {
        if (url)
            URL.revokeObjectURL(url);
    }, [url]);
    const active = ["requesting", "recording", "stopping"].includes(state);
    useEffect(() => onCaptureChange({
        dirty: active || state === "audition",
        saving
    }), [active, state, saving, onCaptureChange]);
    return <div className="aw-recorder"><Field label="麦克风"><WorkspaceSelect value={deviceId} disabled={active}
                                                                               onValueChange={(value) => setDeviceId(value)}><SelectOption
        value="">系统默认麦克风</SelectOption>{devices.map((device, index) => <SelectOption
        key={device.deviceId || index} value={device.deviceId}>{device.label || `麦克风 ${index + 1}`}</SelectOption>)}
    </WorkspaceSelect></Field>
        <div className="aw-inline"><span className="aw-time aw-grow">{timeLabel(seconds)}</span><span
            className="aw-muted">{state === "recording" ? "正在录制" : state === "requesting" ? "等待麦克风权限…" : "录音会保留原始文件"}</span>
        </div>
        <div className="aw-meter" role="meter" aria-label="输入电平" aria-valuemin={0} aria-valuemax={100}
             aria-valuenow={Math.round(Math.min(1, level * 4) * 100)}>
            <div style={{width: `${Math.min(1, level * 4) * 100}%`}}/>
        </div>
        {url && <SourcePlayer src={url} title="录音试听"/>}
        <div className="aw-actions">{state === "recording" ? <Button onClick={() => {
                void recorder.current?.stop().then((blob) => setUrl(URL.createObjectURL(blob))).catch((e: unknown) => setError(errorText(e)));
            }}><Square size={14}/>结束录制</Button> :
            <Button disabled={active || state === "audition" || saving} onClick={() => {
                setError("");
                void recorder.current?.start(deviceId || undefined).then(() => listMicrophones().then(setDevices)).catch((e: unknown) => setError(errorText(e)));
            }}><Mic/>开始录音</Button>}{state === "audition" && <><Button disabled={saving} onClick={() => {
            const blob = recorder.current?.blob;
            if (!blob)
                return;
            setSaving(true);
            void keepAudioSource(projectId, blob, `录音 ${new Date().toLocaleString("zh-CN").replace(/[/:]/g, "-")}`, "recording", segmentId).then((take) => {
                recorder.current?.markKept();
                onSaved(take);
            }).catch((e: unknown) => setError(errorText(e))).finally(() => setSaving(false));
        }}><Check/>{saving ? "保存中…" : "保留录音"}</Button><Button variant="ghost" disabled={saving} onClick={() => {
            recorder.current?.discard();
            setUrl(undefined);
        }}><X/>舍弃并重录</Button></>}</div>
        {error && <p className="aw-error" role="alert">{error}</p>}</div>;
}

function AudioLibrary({projectId, segmentId, onSaved}: {
    projectId: string;
    segmentId?: string;
    onSaved: (take: AudioTake) => void;
}) {
    const materials = useProductQuery(async (db) => {
        const link = await db.projectIpLinks.get(projectId);
        return db.libraryMaterials.filter((row) => row.kind === "audio" && !row.archived && (row.scope.kind === "global" || row.scope.kind === "project" && row.scope.id === projectId || row.scope.kind === "ip" && row.scope.id === link?.ipId)).toArray();
    }, [projectId]);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    return <div className="aw-source-list max-h-96 overflow-auto">{materials === undefined ?
        <p>加载素材…</p> : materials.length === 0 ?
            <p className="aw-muted">还没有可用的音频素材，可先在素材库导入音频。</p> : materials.map((material) => <div
                className="aw-source aw-inline" key={material.id}>
                <div className="aw-grow"><strong>{material.name}</strong><small>{material.notes || "音频素材"}</small>
                </div>
                <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => {
                    setBusy(material.id);
                    setError("");
                    void (async () => {
                        const use = await adoptMaterialInProject(material.id, projectId);
                        const media = await db.media.get(use.targetId);
                        if (!media)
                            throw new Error("素材文件已不存在");
                        const buffer = await withBinaryReadLease(media.blob, async lease => decodeAudioBlob(await lease.readBlob()));
                        const take = await addAudioTake(projectId, {
                            ...audioBufferMetadata(buffer),
                            mediaId: media.id,
                            name: material.name,
                            source: "library",
                            segmentId
                        });
                        onSaved(take);
                    })().catch((e: unknown) => setError(errorText(e))).finally(() => setBusy(""));
                }}>添加</Button></div>)}{error && <p role="alert" className="aw-error">{error}</p>}</div>;
}
