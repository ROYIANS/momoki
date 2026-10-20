import {ReferenceAttachments} from "./ReferenceAttachments";
import {ReferenceLibrary} from "./ReferenceLibrary";
import {REFERENCE_ACCEPT} from "../../references/models/references";
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from "../../../ui/dialog";
import {ProjectPicker} from "./ProjectPicker";
import {AgentControls, ComposerPlusMenu} from "./AgentControls";
import {Dropdown, Input} from "antd";
import {
    Check,
    ChevronDown,
    Expand,
    Infinity as InfinityIcon,
    LayoutList,
    LoaderCircle,
    Mic,
    Minimize2,
    RotateCcw,
    X
} from "../../../ui/icons";
import {type ComponentRef, cloneElement, isValidElement, type ReactElement, useEffect, useRef, useState} from "react";
import {toast} from "sonner";
import type {ChatSurfaceMode, ComposerProps} from "./composerTypes";
import {ModelSelectTrigger, SendCircleButton} from "./ModelSelectTrigger";
import {ComposerCardHost, ComposerSurface} from "./ComposerCards";
import {ComposerQueue} from "./ComposerQueue";
import {ComposerActionCards} from "./ComposerActionCards";
import "./composerControls.css";

function popupRoot(): HTMLElement {
    return document.querySelector<HTMLElement>(".agent-chat-root") ?? document.body;
}

type SpeechRecognitionLike = {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    start: () => void;
    stop: () => void;
    onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
    onend: (() => void) | null;
    onerror: (() => void) | null;
};

function speechRecognitionConstructor(): (new () => SpeechRecognitionLike) | undefined {
    const browser = window as unknown as {
        SpeechRecognition?: new () => SpeechRecognitionLike;
        webkitSpeechRecognition?: new () => SpeechRecognitionLike
    };
    return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

function ModeSwitch({mode, onChange}: {
    mode: ChatSurfaceMode;
    onChange: (mode: ChatSurfaceMode) => void;
}) {
    const [open, setOpen] = useState(false);
    return (
        <Dropdown
            trigger={["click"]}
            placement="topLeft"
            getPopupContainer={popupRoot}
            open={open}
            onOpenChange={setOpen}
            autoFocus
            menu={{
                className: "agent-composer-menu",
                selectedKeys: [mode],
                items: [
                    {
                        key: "agent",
                        icon: <InfinityIcon size={16}/>,
                        label: <span className="agent-control-option"><span>Agent {mode === "agent" &&
                            <Check size={14}/>}</span></span>
                    },
                    {
                        key: "task",
                        icon: <LayoutList size={16}/>,
                        label: <span className="agent-control-option"><span>任务 {mode === "task" &&
                            <Check size={14}/>}</span></span>
                    },
                ],
                onClick: ({key}) => {
                    onChange(key as ChatSurfaceMode);
                    setOpen(false);
                },
            }}
        >
            <button type="button" className="agent-chip agent-control"
                    aria-label={mode === "task" ? "任务模式" : "Agent 模式"} aria-haspopup="menu" aria-expanded={open}>
                {mode === "task" ? <LayoutList size={16} aria-hidden/> : <InfinityIcon size={16} aria-hidden/>}
                <span>{mode === "task" ? "任务" : "Agent"}</span>
                <ChevronDown size={12} aria-hidden/>
            </button>
        </Dropdown>
    );
}

/**
 * Floating composer — left Agent/任务, right model (with connector inside) + send.
 */
export function FloatingComposer({
                                     threadId,
                                     attachments = [],
                                     referenceImports = [],
                                     onAttachReference,
                                     onRemoveReference,
                                     onImportReferences,
                                     onCancelReferenceImport,
                                     onRetryReferenceImport,
                                     value,
                                     sending,
                                     stopping,
                                     blocked,
                                     blockedReason,
                                     readOnly,
                                     connectors,
                                     selectedConnectorId,
                                     model,
                                     reasoningEffort,
                                     onReasoningEffortChange,
                                     modelOptions,
                                     modelMetadata,
                                     probingModels,
                                     modelPolicy,
                                     modelWarning,
                                     chatMode,
                                     projects,
                                     projectId,
                                     projectRequired,
                                     projectLocked,
                                     onProjectChange,
                                     interactionMode,
                                     onChange,
                                     onSend,
                                     onStop,
                                     onConnectorChange,
                                     onModelChange,
                                     onChatModeChange,
                                     onInteractionModeChange,
                                     large,
                                     contextUsage,
                                     notice,
                                     attention,
                                     queue,
                                     actions,
                                     surface = "home",
                                     expanded = false,
                                     onExpandedChange,
                                 }: ComposerProps & {
    surface?: "home" | "detail";
    expanded?: boolean;
    onExpandedChange?: (expanded: boolean) => void
}) {
    // While a turn runs the draft is still sendable: it becomes the next queued card instead of interrupting.
    const canSend = (Boolean(value.trim()) || attachments.length > 0) && referenceImports.length === 0 && !blocked && !projectRequired && !modelPolicy.incompatibleModels.includes(model.trim());
    const [libraryOpen, setLibraryOpen] = useState(false);
    const [plusOpen, setPlusOpen] = useState(false);
    const sheetHost = useRef<HTMLDivElement>(null);
    // One row until the draft needs more room: a newline, a long draft, or attachments.
    const needsRows = value.includes("\n") || value.length > 72 || attachments.length > 0 || referenceImports.length > 0 || Boolean(modelWarning);
    const [grown, setGrown] = useState(false);
    useEffect(() => {
        if (needsRows) setGrown(true);
        else if (!value) setGrown(false);
    }, [needsRows, value]);
    const [projectAction, setProjectAction] = useState<"import" | "library" | File[]>();
    const fileInput = useRef<HTMLInputElement>(null);
    const [dragging, setDragging] = useState(false);
    const scope = `${threadId ?? "home"}/${projectId ?? ""}`;
    useEffect(() => {
        setLibraryOpen(false);
        setProjectAction(undefined);
        setDragging(false);
    }, [threadId]);

    function filesSelected(files: File[]) {
        if (!files.length || blocked) return;
        if (!projectId) {
            setProjectAction(files);
            return;
        }
        onImportReferences?.(files);
    }

    function openReferenceAction(action: "import" | "library") {
        if (blocked) return;
        if (!projectId) {
            setProjectAction(action);
            return;
        }
        if (action === "library") setLibraryOpen(true); else fileInput.current?.click();
    }

    useEffect(() => {
        if (!projectId || !projectAction) return;
        const action = projectAction;
        setProjectAction(undefined);
        if (action === "library") setLibraryOpen(true);
        else if (action === "import") fileInput.current?.click();
        else onImportReferences?.(action);
    }, [projectId, projectAction, onImportReferences]);
    const composing = useRef(false);
    const inputRef = useRef<ComponentRef<typeof Input.TextArea>>(null);
    useEffect(() => {
        if (!inputRef.current?.resizableTextArea?.textArea.closest("[inert]")) inputRef.current?.focus({preventScroll: true});
    }, [expanded]);
    const [modelOpen, setModelOpen] = useState(false);

    const [sendShortcut, setSendShortcut] = useState<"enter" | "mod-enter">(() => {
        try {
            return localStorage.getItem("cuepoint.agent.sendShortcut") === "mod-enter" ? "mod-enter" : "enter";
        } catch {
            return "enter";
        }
    });
    const [listening, setListening] = useState(false);
    const speechRef = useRef<SpeechRecognitionLike | null>(null);
    const speechBaseRef = useRef("");
    const detail = surface === "detail";
    const inline = detail && !expanded && !needsRows && !grown;

    useEffect(() => {
        if (!expanded) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !event.defaultPrevented && event.target instanceof Element && event.target.closest(".agent-composer-stack")) onExpandedChange?.(false);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [expanded, onExpandedChange]);

    useEffect(() => () => {
        const speech = speechRef.current;
        if (speech) {
            speech.onresult = null;
            speech.onend = null;
            speech.onerror = null;
            speech.stop();
        }
    }, []);

    const toggleVoiceInput = () => {
        if (listening) {
            speechRef.current?.stop();
            return;
        }
        const Recognition = speechRecognitionConstructor();
        if (!Recognition) {
            toast.info("当前浏览器不支持语音输入");
            return;
        }
        const recognition = new Recognition();
        speechBaseRef.current = value.trimEnd();
        recognition.continuous = true;
        recognition.interimResults = false;
        recognition.lang = "zh-CN";
        recognition.onresult = (event) => {
            const transcript = Array.from({length: event.results.length}, (_, index) => event.results[index]?.[0]?.transcript ?? "").join("").trim();
            onChange([speechBaseRef.current, transcript].filter(Boolean).join(" "));
        };
        recognition.onend = () => {
            setListening(false);
            speechRef.current = null;
        };
        recognition.onerror = () => {
            setListening(false);
            speechRef.current = null;
            toast.error("语音输入失败，请重试");
        };
        speechRef.current = recognition;
        setListening(true);
        try {
            recognition.start();
        } catch {
            speechRef.current = null;
            setListening(false);
            toast.error("无法启动语音输入，请检查浏览器的麦克风权限");
        }
    };

    const trySend = () => {
        // Dictating holds the textarea read-only; silently ignoring the press looks broken.
        if (listening) {
            toast.info("正在语音输入，请先结束听写再发送。");
            return;
        }
        if (canSend) onSend();
    };

    return (
        <ComposerSurface
            stackClassName={[expanded ? "is-expanded" : "", plusOpen ? "is-plus-open" : ""].filter(Boolean).join(" ") || undefined}
            above={<><div ref={sheetHost} className="agent-composer-sheets"/>{actions ? <ComposerActionCards threadId={actions.threadId} busy={sending} readOnly={readOnly} onRunAction={actions.onRunAction}/> : null}{queue ? <ComposerQueue threadId={queue.threadId} active={sending}/> : null}<ComposerCardHost notice={notice} attention={attention}/></>}
            frameClassName={`agent-composer agent-composer-refined${dragging ? " reference-dragging" : ""}${inline ? " is-inline" : ""}`}
            frameProps={{
                 onDragOver: (event) => {
                     if (event.dataTransfer.types.includes("Files")) {
                         event.preventDefault();
                         setDragging(true);
                     }
                 },
                 onDragLeave: (event) => {
                     if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
                 },
                 onDrop: (event) => {
                     if (!event.dataTransfer.types.includes("Files")) return;
                     event.preventDefault();
                     setDragging(false);
                     filesSelected(Array.from(event.dataTransfer.files));
                 },
                 onPaste: (event) => {
                     const images = Array.from(event.clipboardData.items).filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => !!file);
                     if (images.length) {
                         if (!event.clipboardData.getData("text/plain")) event.preventDefault();
                         filesSelected(images);
                     }
                 },
            }}
            after={<>
            {detail ? <div className="agent-composer-controlbar">
                <div className="agent-composer-cluster agent-composer-permissions"><AgentControls/>{isValidElement(contextUsage) ? cloneElement(contextUsage as ReactElement<{sheetHost?: typeof sheetHost}>, {sheetHost}) : contextUsage}</div>
            </div> : null}
            {projectId &&
                <ReferenceLibrary key={scope} projectId={projectId} open={libraryOpen} onOpenChange={setLibraryOpen}
                                  selected={attachments} onSelect={(attachment) => onAttachReference?.(attachment)}
                                  onImport={() => fileInput.current?.click()}/>}
            <Dialog open={!!projectAction && !projectId} onOpenChange={(open) => {
                if (!open) setProjectAction(undefined);
            }}><DialogContent
                className="reference-dialog reference-project-dialog"><DialogHeader><DialogTitle>先为资料选择项目</DialogTitle>{projectLocked && <DialogDescription>当前对话未绑定项目且已开始，请新开一个项目对话导入资料。</DialogDescription>}</DialogHeader><ProjectPicker
                projects={projects} projectId={projectId} locked={projectLocked} allowClear={false}
                onChange={onProjectChange}/></DialogContent></Dialog>
            </>}
        >
                <input ref={fileInput} type="file" accept={REFERENCE_ACCEPT} multiple hidden onChange={(event) => {
                    filesSelected(Array.from(event.target.files ?? []));
                    event.target.value = "";
                }}/>
                <ReferenceAttachments projectId={projectId} attachments={attachments} onRemove={onRemoveReference}/>
                {referenceImports.length > 0 &&
                    <div className="reference-imports" aria-live="polite">{referenceImports.map((job) => <div
                        key={job.id}>{job.status === "importing" ?
                        <LoaderCircle size={14} className="reference-spinner"/> : <span
                            aria-hidden>!</span>}<span><strong>{job.filename}</strong>{job.error && <small>{job.error}</small>}</span>{job.status === "failed" &&
                        <button type="button" aria-label={`重试导入 ${job.filename}`}
                                onClick={() => onRetryReferenceImport?.(job)}><RotateCcw size={14}/></button>}
                        <button type="button" aria-label={`取消附件 ${job.filename}`}
                                onClick={() => onCancelReferenceImport?.(job.id)}><X size={14}/></button>
                    </div>)}</div>}
                {dragging && <div className="reference-drop-hint">松开以导入参考资料</div>}
                <Input.TextArea
                    ref={inputRef}
                    readOnly={listening}
                    value={value}
                    variant="borderless"
                    placeholder={blocked ? blockedReason ?? "重新打开任务后可继续对话" : sending ? "回车排队，本轮结束后发送" : "提问、创建内容或启动任务"}
                    autoSize={expanded ? false : {minRows: inline ? 1 : large ? 3 : 2, maxRows: 10}}
                    className="agent-composer-input"
                    aria-label="消息内容"
                    onChange={(event) => onChange(event.target.value)}
                    onCompositionStart={() => {
                        composing.current = true;
                    }}
                    onCompositionEnd={() => {
                        composing.current = false;
                    }}
                    onPressEnter={(event) => {
                        if (composing.current || event.nativeEvent.isComposing || event.shiftKey || event.altKey) return;
                        if (expanded) {
                            if (event.metaKey || event.ctrlKey) {
                                event.preventDefault();
                                trySend();
                            }
                            return;
                        }
                        if (detail && sendShortcut === "mod-enter" && !(event.metaKey || event.ctrlKey)) return;
                        if (detail && !expanded && sendShortcut === "enter" && (event.metaKey || event.ctrlKey)) return;
                        event.preventDefault();
                        trySend();
                    }}
                />
                {modelWarning ? <div role="status" style={{
                    padding: "0 16px 8px",
                    fontSize: 12,
                    color: "#e0b878"
                }}>{modelWarning}</div> : null}
                <div className="agent-composer-footer">
                    <div className="agent-composer-cluster">
                        {!detail && <div className="agent-composer-scope"><ProjectPicker projects={projects} projectId={projectId}
                                                                             required={projectRequired}
                                                                             locked={projectLocked}
                                                                             onChange={onProjectChange}/>
                            <ModeSwitch mode={chatMode} onChange={onChatModeChange}/></div>}
                        <ComposerPlusMenu threadId={threadId} projectId={projectId}
                                          interactionMode={interactionMode}
                                          onInteractionModeChange={onInteractionModeChange}
                                          onImport={() => openReferenceAction("import")}
                                          onLibrary={() => openReferenceAction("library")}
                                          sheetHost={sheetHost} onOpenChange={setPlusOpen}/>
                        {detail && !inline ? <button type="button" className="agent-chip agent-control agent-control-icon"
                                          aria-label={expanded ? "退出全屏编辑" : "展开编辑器"}
                                          aria-expanded={expanded}
                                          onClick={() => onExpandedChange?.(!expanded)}>
                            {expanded ? <Minimize2 size={17} aria-hidden/> : <Expand size={17} aria-hidden/>}
                        </button> : null}
                    </div>

                    <div className="agent-composer-cluster agent-composer-cluster-right">
                        <ModelSelectTrigger
                            reasoningEffort={reasoningEffort}
                            onReasoningEffortChange={onReasoningEffortChange}
                            open={modelOpen}
                            onOpenChange={setModelOpen}
                            model={model}
                            modelOptions={modelOptions}
                            modelMetadata={modelMetadata}
                            probingModels={probingModels}
                            modelPolicy={modelPolicy}
                            connectors={connectors}
                            selectedConnectorId={selectedConnectorId}
                            onConnectorChange={onConnectorChange}
                            onModelChange={onModelChange}
                        />
                        {detail ? <button type="button"
                                          className={`agent-chip agent-control agent-control-icon agent-voice-button${listening ? " is-active" : ""}`}
                                          aria-label={listening ? "停止语音输入" : "语音输入"}
                                          aria-pressed={listening}
                                          onClick={toggleVoiceInput}
                                          title={listening ? "停止语音输入" : "语音输入"}><Mic size={17} aria-hidden/>
                        </button> : null}
                        <div className="agent-composer-send-group">
                            <SendCircleButton sending={sending} stopping={stopping} canSend={canSend && !listening} onSend={trySend}
                                              onStop={onStop}/>
                            {detail && !sending ? <Dropdown
                                trigger={["click"]}
                                placement="topRight"
                                getPopupContainer={popupRoot}
                                menu={{
                                    className: "agent-composer-menu",
                                    selectedKeys: [expanded ? "mod-enter" : sendShortcut],
                                    items: [
                                        {
                                            key: "enter",
                                            disabled: expanded,
                                            label: <span
                                                className="agent-control-option"><span>按 Enter 发送 {!expanded && sendShortcut === "enter" &&
                                                <Check size={14}/>}</span><small>Shift + Enter 换行</small></span>
                                        },
                                        {
                                            key: "mod-enter",
                                            label: <span
                                                className="agent-control-option"><span>按 ⌘ / Ctrl + Enter 发送 {(expanded || sendShortcut === "mod-enter") &&
                                                <Check size={14}/>}</span><small>Enter 换行</small></span>
                                        },
                                    ],
                                    onClick: ({key}) => {
                                        setSendShortcut(key as "enter" | "mod-enter");
                                        try {
                                            localStorage.setItem("cuepoint.agent.sendShortcut", key);
                                        } catch { /* Current page still uses the selection. */
                                        }
                                    },
                                }}
                            >
                                <button type="button" className="agent-send-menu-trigger" aria-label="发送方式">
                                    <ChevronDown size={13} aria-hidden/></button>
                            </Dropdown> : null}
                        </div>
                    </div>
                </div>
        </ComposerSurface>
    );
}
