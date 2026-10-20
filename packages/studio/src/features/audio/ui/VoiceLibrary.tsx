import {useCallback, useEffect, useRef, useState} from "react";
import {type ManualDraftDeparture, type ManualDraftState, useManualDraftDeparture} from "../../../app/drafts/useManualDraftGuard";
import {useProductQuery} from "../../../platform/product/queries";
import {ArrowLeft, Check, Mic, Plus, Sparkles} from "../../../ui/icons";
import {addAudioSpeaker, patchAudioSpeaker} from "../commands/audio";
import type {AudioSpeaker, AudioTake, MimoSpeechSettings} from "../models/audio";
import {MIMO_VOICES} from "../providers/mimoSpeech";
import {defaultMimoConnector, speakerSpeechProfile} from "../generation/defaults";
import {prepareAudioGeneration, submitAudioGeneration} from "../generation/runtime";
import {Button} from "../../../ui/button";
import {Input} from "../../../ui/input";
import {Textarea} from "../../../ui/textarea";
import {SidePanel} from "../../../app/layout/SidePanel";
import {Tabs, TabsList, TabsTrigger} from "../../../ui/tabs";
import {AudioPlayer, errorText} from "../presentation/shared";
import {Disclosure, DisclosureTitle, SelectOption, WorkspaceSelect} from "../presentation/controls";
import {MimoConnection} from "./MimoConnection";
import {VoiceReferencePicker} from "./VoiceReferencePicker";

export function voiceLabel(speaker: AudioSpeaker) {
    const profile = speakerSpeechProfile(speaker);
    if (!profile.mimo) return `原有音色 · ${profile.voice}`;
    return profile.mimo.mode === "design" ? "设计音色" : profile.mimo.mode === "clone" ? "克隆声音" : profile.voice === "mimo_default" ? "MiMo 默认" : profile.voice;
}

type VoiceLibraryProps = {
    projectId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    speakers: AudioSpeaker[];
    takes: AudioTake[];
    selectedId?: string;
    onChoose?: (id: string) => Promise<void>;
};

export function VoiceLibrary(props: VoiceLibraryProps) {
    const [owner, setOwner] = useState(props);
    const [session, setSession] = useState(0);
    const sameOwner = owner.projectId === props.projectId && (!owner.open || props.open);
    const shown = sameOwner ? props : owner;
    const [state, setState] = useState<ManualDraftState>({dirty: false, pending: false});
    const stateRef = useRef(state);
    const updateState = useCallback((next: ManualDraftState) => {
        stateRef.current = next;
        setState(next);
    }, []);
    const departure = useManualDraftDeparture(state.dirty, state.pending, () => {
        updateState({dirty: false, pending: false});
        setSession(value => value + 1);
    }, {
        readState: () => stateRef.current,
    });
    const {requestDeparture} = departure;
    const requestedOwner = `${props.projectId}:${props.open}`;
    const attempted = useRef(requestedOwner);
    useEffect(() => {
        if (sameOwner) {
            attempted.current = requestedOwner;
            setOwner(props);
            return;
        }
        if (attempted.current === requestedOwner) return;
        attempted.current = requestedOwner;
        requestDeparture(() => {
            updateState({dirty: false, pending: false});
            setOwner(props);
        });
    }, [sameOwner, props, requestedOwner, requestDeparture, updateState]);
    return <>{departure.confirmation}<VoiceLibraryContent key={`${shown.projectId}:${session}`} {...shown}
                                                          onOwnerStateChange={updateState}
                                                          requestDeparture={requestDeparture}/></>;
}

function VoiceLibraryContent({
                                 projectId,
                                 open,
                                 onOpenChange,
                                 speakers,
                                 takes,
                                 selectedId,
                                 onChoose,
                                 onOwnerStateChange,
                                 requestDeparture
                             }:
                                 VoiceLibraryProps & {
                                 onOwnerStateChange: (state: ManualDraftState) => void;
                                 requestDeparture: ManualDraftDeparture
                             }) {
    const [editing, setEditing] = useState<{ id: string; initial?: AudioSpeaker }>();
    const [busy, setBusy] = useState(false), [error, setError] = useState("");
    const choosing = useRef(false);
    const active = useRef(true);
    useEffect(() => {
        active.current = true;
        return () => {
            active.current = false;
        };
    }, []);
    const updateDraft = onOwnerStateChange;

    function requestLocalDeparture(leave: () => void) {
        requestDeparture(leave, () => {
        });
    }

    function leaveEditor() {
        setEditing(undefined);
        updateDraft({dirty: false, pending: false});
    }

    return <><SidePanel open={open} kind="voice-library" width={480}
                        onOpenChange={next => {
                            if (next) onOpenChange(true);
                            else {
                                onOpenChange(false);
                                leaveEditor();
                                setError("");
                            }
                        }}
                        onRequestDeparture={(proceed, cancel) => requestDeparture(proceed, cancel ?? (() => {}))}
                        title={editing ? editing.initial ? "编辑音色" : "创作新音色" : "项目音色"}
                        description={editing ? "给声音一个名字，描述它或提供一段参考录音。" : "这里的音色可用于所有章节，创作助手创建的音色也会出现在这里。"}>
        {editing ? <><Button className="justify-self-start" size="sm" variant="ghost" disabled={busy}
                             onClick={() => requestLocalDeparture(leaveEditor)}><ArrowLeft/>返回音色列表</Button><VoiceEditor
            key={`${projectId}:${editing.id}`} projectId={projectId} initial={editing.initial} takes={takes}
            onBusyChange={setBusy} onDraftStateChange={updateDraft}
            onSaved={leaveEditor}/></> : <>
            <Button className="justify-self-start" onClick={() => setEditing({id: "new"})}><Plus/>创作音色 /
                克隆声音</Button>
            {!speakers.length &&
                <p className="py-5 text-sm text-muted-foreground">还没有自定义音色。段落可以直接使用 MiMo
                    默认音色，也可以在这里创建自己的声音。</p>}
            <div className="divide-y">{speakers.map(row => <div key={row.id} className="flex items-center gap-3 py-3">
                <Mic className="size-4 shrink-0 text-muted-foreground"/>
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{row.name}</p><p
                    className="truncate text-xs text-muted-foreground">{voiceLabel(row)}</p></div>
                <Button size="sm" variant="ghost" disabled={busy}
                        onClick={() => setEditing({
                            id: row.id,
                            initial: structuredClone(row)
                        })}>编辑</Button>{onChoose &&
                <Button size="sm" variant={row.id === selectedId ? "secondary" : "outline"} disabled={busy}
                        onClick={() => {
                            if (choosing.current) return;
                            choosing.current = true;
                            updateDraft({dirty: false, pending: true});
                            setBusy(true);
                            setError("");
                            void onChoose(row.id).then(() => {
                                if (active.current) onOpenChange(false);
                            }).catch((e: unknown) => {
                                if (active.current) setError(errorText(e));
                            }).finally(() => {
                                choosing.current = false;
                                if (active.current) {
                                    setBusy(false);
                                    updateDraft({dirty: false, pending: false});
                                }
                            });
                        }}>{row.id === selectedId ? <><Check/>已选</> : "使用"}</Button>}</div>)}</div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </>}
    </SidePanel></>;
}

function VoiceEditor({projectId, initial, takes, onBusyChange, onSaved, onDraftStateChange}: {
    projectId: string;
    initial?: AudioSpeaker;
    takes: AudioTake[];
    onBusyChange: (value: boolean) => void;
    onSaved: () => void;
    onDraftStateChange: (state: ManualDraftState) => void;
}) {
    const [name, setName] = useState(initial?.name ?? "");
    const [mode, setMode] = useState<MimoSpeechSettings["mode"]>(initial ? speakerSpeechProfile(initial).mimo?.mode ?? "design" : "design");
    const [voice, setVoice] = useState(initial?.mimo?.mode === "preset" ? initial.voice ?? "mimo_default" : "mimo_default");
    const [description, setDescription] = useState(initial?.mimo?.instruction ?? "");
    const [reference, setReference] = useState(initial?.mimo?.referenceMediaId ?? "");
    const [sampleText, setSampleText] = useState("你好，很高兴用我的声音，为你讲述接下来的故事。");
    const [preview, setPreview] = useState<{ mediaId: string; signature: string }>();
    const [busy, setBusy] = useState(false), [referenceBusy, setReferenceBusy] = useState(false), [error, setError] = useState("");
    const pending = useRef(false);
    const referencePending = useRef(false);
    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const connections = useProductQuery((db) => db.connectors.toArray());
    const connector = defaultMimoConnector(connections ?? []);
    const blocked = busy || referenceBusy;
    const settings: MimoSpeechSettings = {
        mode,
        instruction: description, ...(mode === "clone" ? {referenceMediaId: reference} : {})
    };
    const signature = JSON.stringify({voice, settings, sampleText});
    const draft = {name, mode, voice, description, reference, sampleText};
    const baseline = useRef(JSON.stringify(draft));
    const currentDraft = useRef(draft);
    currentDraft.current = draft;

    function publish(patch: Partial<typeof draft> = {}) {
        currentDraft.current = {...currentDraft.current, ...patch};
        onDraftStateChange({
            dirty: JSON.stringify(currentDraft.current) !== baseline.current,
            pending: pending.current || referencePending.current
        });
    }

    const valid = mode === "design" ? Boolean(description.trim()) : mode === "clone" ? Boolean(reference) : true;

    async function run(fn: () => Promise<void>) {
        if (pending.current || referencePending.current) return;
        pending.current = true;
        setBusy(true);
        onBusyChange(true);
        publish();
        setError("");
        try {
            await fn();
        } catch (e) {
            if (mounted.current) setError(errorText(e));
        } finally {
            if (mounted.current) {
                pending.current = false;
                setBusy(false);
                onBusyChange(false);
                publish();
            }
        }
    }

    return <div className="space-y-4">
        {initial && !speakerSpeechProfile(initial).mimo &&
            <p className="text-xs text-muted-foreground">这是原有 APIMart 音色。保存本次编辑后，该角色将使用
                MiMo；已有配音版本保留。</p>}
        <Input aria-label="音色名称" value={name} maxLength={100} disabled={blocked}
               onChange={(e) => {
                   publish({name: e.target.value});
                   setName(e.target.value);
               }} placeholder="给声音起个名字，例如：晚安旁白"/>
        <Tabs value={mode} onValueChange={(value) => {
            publish({mode: value as MimoSpeechSettings["mode"]});
            setMode(value as MimoSpeechSettings["mode"]);
        }}><TabsList
            className="w-full" aria-label="创作音色方式"><TabsTrigger className="flex-1" value="design"
                                                                      disabled={blocked}>描述声音</TabsTrigger><TabsTrigger
            className="flex-1" value="clone" disabled={blocked}>克隆声音</TabsTrigger><TabsTrigger className="flex-1"
                                                                                                   value="preset"
                                                                                                   disabled={blocked}>预置音色</TabsTrigger></TabsList></Tabs>
        {mode === "preset" && <WorkspaceSelect aria-label="预置音色" value={voice} onValueChange={(value) => {
            publish({voice: value});
            setVoice(value);
        }}
                                               disabled={blocked}>{MIMO_VOICES.map(item => <SelectOption key={item}
                                                                                                         value={item}>{item === "mimo_default" ? "MiMo 默认" : item}</SelectOption>)}</WorkspaceSelect>}
        {mode === "design" &&
            <Textarea aria-label="描述声音" disabled={blocked} rows={4} value={description} maxLength={8000}
                      onChange={(e) => {
                          publish({description: e.target.value});
                          setDescription(e.target.value);
                      }}
                      placeholder="温暖、沉稳的女声，略带气息感，像在深夜为你讲述一个故事。"/>}
        {mode === "clone" &&
            <VoiceReferencePicker projectId={projectId} takes={takes} value={reference} onChange={(value) => {
                if (!mounted.current) return;
                publish({reference: value});
                setReference(value);
            }}
                                  disabled={busy} onBusyChange={(value) => {
                referencePending.current = value;
                setReferenceBusy(value);
                onBusyChange(value);
                publish();
            }}/>}
        {mode !== "design" &&
            <Disclosure><DisclosureTitle>演绎指导（可选）</DisclosureTitle><Textarea aria-label="音色演绎指导"
                                                                                   disabled={blocked} rows={3}
                                                                                   value={description} maxLength={8000}
                                                                                   onChange={(e) => {
                                                                                       publish({description: e.target.value});
                                                                                       setDescription(e.target.value);
                                                                                   }}
                                                                                   placeholder="语速稍慢、轻声讲述…"/></Disclosure>}
        <Disclosure><DisclosureTitle>试音文本</DisclosureTitle><Textarea aria-label="试音文本" disabled={blocked}
                                                                         value={sampleText} maxLength={8192} rows={3}
                                                                         onChange={(e) => {
                                                                             publish({sampleText: e.target.value});
                                                                             setSampleText(e.target.value);
                                                                         }}/></Disclosure>
        {preview && <><AudioPlayer mediaId={preview.mediaId} title="音色试音"
                                   compact/>{preview.signature !== signature &&
            <p className="text-xs text-muted-foreground">设置已改变，可重新生成试音。</p>}{mode === "design" && preview.signature === signature &&
            <Button variant="ghost" size="sm" disabled={blocked} onClick={() => {
                publish({reference: preview.mediaId, description: "", mode: "clone"});
                setReference(preview.mediaId);
                setDescription("");
                setMode("clone");
                setPreview({
                    ...preview,
                    signature: JSON.stringify({
                        voice,
                        settings: {mode: "clone", instruction: "", referenceMediaId: preview.mediaId},
                        sampleText
                    })
                });
            }}>用这次试音固定音色</Button>}</>}
        {!connector && connections !== undefined &&
            <MimoConnection key={connections.find(row => row.definitionId === "mimo")?.id ?? "new"}
                            existing={connections.find(row => row.definitionId === "mimo")}/>}
        <div className="flex flex-wrap gap-2"><Button variant="outline"
                                                      disabled={blocked || !valid || !sampleText.trim() || !connector}
                                                      onClick={() => void run(async () => {
                                                          if (!connector) return;
                                                          const job = await prepareAudioGeneration({
                                                              projectId,
                                                              connectorId: connector.id,
                                                              input: {
                                                                  kind: "speech",
                                                                  text: sampleText,
                                                                  voice,
                                                                  speed: 1,
                                                                  mimo: settings
                                                              }
                                                          });
                                                          const result = await submitAudioGeneration(projectId, job.id);
                                                          const output = result.results.find(row => row.takeId && row.mediaId);
                                                          if (!output?.mediaId) throw new Error(result.error || "试音尚未完成，请在生成任务中查看");
                                                          if (mounted.current) setPreview({
                                                              mediaId: output.mediaId,
                                                              signature
                                                          });
                                                      })}><Sparkles/>{busy ? "处理中…" : "生成试音"}</Button><Button
            disabled={blocked || !name.trim() || !valid} onClick={() => void run(async () => {
            const input = {name: name.trim(), voice, speed: 1, mimo: settings};
            if (initial) await patchAudioSpeaker(projectId, initial.id, initial.revision, input); else await addAudioSpeaker(projectId, input);
            if (mounted.current) {
                baseline.current = JSON.stringify(currentDraft.current);
                onSaved();
            }
        })}>保存音色</Button></div>
        <p className="text-xs text-muted-foreground">保存配置即可在台词中选用；生成试音使用 MiMo
            账户。试音会保留在项目声音中。</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>;
}
