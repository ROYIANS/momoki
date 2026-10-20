import {useEffect, useRef, useState} from "react";
import {useBlocker} from "@tanstack/react-router";
import {useProductQuery} from "../../../platform/product/queries";
import {toast} from "sonner";
import type {MemoryInput, MemorySourceRef, ProjectMemory,} from "../models/projectMemory";
import {
    createProjectMemory,
    getProjectMemory,
    MemoryConflictError,
    promoteProjectMemory,
    updateProjectMemory,
} from "../commands/projectMemories";
import {Button} from "../../../ui/button";
import {Input} from "../../../ui/input";
import {Textarea} from "../../../ui/textarea";
import {Field} from "../../../ui/field";
import {SidePanel} from "../../../app/layout/SidePanel";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "../../../ui/alert-dialog";
import {readMemory} from "./readMemory";
import {CATEGORY_LABELS} from "./memoryLabels";
import {MemorySelect} from "./MemorySelect";
import "./memory.css";

const EMPTY_MEMORY: MemoryInput = {
    category: "convention",
    title: "",
    topicKey: "",
    body: "",
    applicability: "",
    tags: [],
};

export function MemoryEditor({
                                 projectId: incomingProjectId,
                                 initial: incomingInitial = EMPTY_MEMORY,
                                 memory: incomingMemory,
                                 source: incomingSource,
                                 sourceExcerpt: incomingExcerpt,
                                 onClose,
                                 onSaved,
                                 onPendingChange,
                             }: {
    projectId: string;
    initial?: MemoryInput;
    memory?: ProjectMemory;
    source?: MemorySourceRef;
    sourceExcerpt?: string;
    onClose: () => void;
    onSaved: (memory: ProjectMemory) => void;
    onPendingChange?: (pending: boolean) => void;
}) {
    // A mounted editor owns one input/source/owner snapshot. Live revisions are
    // reconciled explicitly below; new props cannot silently rebind its draft.
    const [session] = useState(() => ({
        projectId: incomingProjectId,
        memory: incomingMemory ? structuredClone(incomingMemory) : undefined,
        source: incomingSource ? structuredClone(incomingSource) : undefined,
        sourceExcerpt: incomingExcerpt,
        baseline: {
            inclusion: incomingInitial.inclusion ?? "relevant",
            category: incomingInitial.category,
            title: incomingInitial.title,
            topicKey: incomingInitial.topicKey,
            body: incomingInitial.body,
            applicability: incomingInitial.applicability,
            tags: [...incomingInitial.tags],
        } satisfies MemoryInput,
    }));
    const {projectId, memory, source, sourceExcerpt, baseline} = session;
    const identityMismatch = incomingProjectId !== projectId || incomingMemory?.id !== memory?.id ||
        incomingSource?.taskId !== source?.taskId || incomingSource?.summaryId !== source?.summaryId ||
        incomingSource?.summaryRevision !== source?.summaryRevision || incomingSource?.itemKind !== source?.itemKind ||
        incomingSource?.itemIndex !== source?.itemIndex || incomingSource?.itemText !== source?.itemText;
    const targetMatches = useRef(true);
    targetMatches.current = !identityMismatch;
    const [draft, setDraft] = useState<MemoryInput>(() => structuredClone(baseline));
    const [tagsText, setTagsText] = useState(baseline.tags.join("，"));
    const [expectedRevision, setExpectedRevision] = useState(memory?.revision);
    const [readAttempt, setReadAttempt] = useState(0);
    const currentRead = useProductQuery(
        (db) =>
            readMemory(async () =>
                memory
                    ? ((await getProjectMemory(projectId, memory.id, db)) ?? null)
                    : null,
            ),
        [projectId, memory?.id, readAttempt],
    );
    const current = currentRead?.data;
    const [pending, setPending] = useState(false);
    const [saveCompleted, setSaveCompleted] = useState(false);
    const [error, setError] = useState("");
    const [conflictIds, setConflictIds] = useState<string[]>([]);
    const [discard, setDiscard] = useState(false);
    const lock = useRef(false);
    const lifetime = useRef({mounted: false, epoch: 0, saved: false});
    useEffect(() => {
        const active = lifetime.current;
        active.mounted = true;
        return () => {
            active.mounted = false;
            active.epoch++;
        };
    }, []);
    useEffect(() => {
        onPendingChange?.(pending);
        return () => onPendingChange?.(false);
    }, [pending, onPendingChange]);
    const conflictsRead = useProductQuery(
        (db) =>
            readMemory(async () =>
                (
                    await Promise.all(
                        conflictIds.map((id) => getProjectMemory(projectId, id, db)),
                    )
                ).filter((item): item is ProjectMemory => !!item),
            ),
        [projectId, conflictIds.join("|"), readAttempt],
    );
    const conflicts = conflictsRead?.data;
    const readError = currentRead?.error || conflictsRead?.error;
    const dirty = !saveCompleted && (
        JSON.stringify(draft) !== JSON.stringify(baseline) ||
        tagsText !== baseline.tags.join("，")
    );
    const blocker = useBlocker({
        shouldBlockFn: () => dirty || pending,
        withResolver: true,
        enableBeforeUnload: dirty || pending,
    });

    function close() {
        if (pending) return;
        if (dirty) setDiscard(true);
        else onClose();
    }

    function change(patch: Partial<MemoryInput>) {
        setDraft((value) => ({...value, ...patch}));
        setConflictIds([]);
        setError("");
    }

    async function save(replace?: { id: string; expectedRevision: number }) {
        const active = lifetime.current;
        if (!active.mounted || active.saved || lock.current) return;
        if (!targetMatches.current) {
            setError("编辑目标已发生变化，请保留草稿并重新打开原记忆");
            return;
        }
        const epoch = active.epoch;
        const mounted = () => active.mounted && active.epoch === epoch;
        lock.current = true;
        setPending(true);
        setError("");
        const input = {
            ...draft,
            topicKey: draft.topicKey.trim() || draft.title,
            tags: tagsText
                .split(/[,，]/)
                .map((tag) => tag.trim())
                .filter(Boolean),
        };

        function saved(value: ProjectMemory, message: string) {
            if (!mounted()) return;
            // Retire this session before a callback can synchronously close it
            // or invoke a captured submit again, even before React rerenders.
            active.saved = true;
            setSaveCompleted(true);
            if (!targetMatches.current) {
                setError("原编辑目标已保存，但当前目标已发生变化，请重新打开记忆查看");
                return;
            }
            onSaved(value);
            if (mounted()) toast.success(message);
        }

        try {
            if (memory) {
                const updated = await updateProjectMemory(
                    projectId,
                    memory.id,
                    input,
                    expectedRevision!,
                );
                saved(updated, "记忆已更新");
            } else {
                const result = source
                    ? await promoteProjectMemory(projectId, source, input, {replace})
                    : await createProjectMemory(projectId, input, {replace});
                saved(result.memory,
                    result.duplicate
                        ? "这条记忆已经保存，无需重复添加"
                        : "已保存到项目记忆",
                );
            }
        } catch (failure) {
            if (!mounted()) return;
            setError(
                failure instanceof Error
                    ? failure.message
                    : "保存失败，编辑内容已保留，请重试",
            );
            if (failure instanceof MemoryConflictError)
                setConflictIds(failure.existingIds);
        } finally {
            lock.current = false;
            if (mounted()) setPending(false);
        }
    }

    return (
        <>
            <SidePanel
                open
                onOpenChange={(open) => {
                    if (!open) close();
                }}
                kind="memory-editor"
                width={520}
                title={memory ? "编辑记忆" : source ? "保存为项目记忆" : "添加项目记忆"}
                description="写下后续创作可以复用的内容，并明确它适用的条件。"
                footer={<>

                            <Button
                                type="button"
                                variant="ghost"
                                disabled={pending}
                                onClick={close}
                            >
                                取消
                            </Button>
                            <Button
                                type="submit"
                                form="memory-editor-form"
                                disabled={
                                    pending ||
                                    saveCompleted ||
                                    identityMismatch ||
                                    !!readError ||
                                    (!!memory &&
                                        (!current || current.revision !== expectedRevision)) ||
                                    !draft.title.trim() ||
                                    !draft.body.trim()
                                }
                            >
                                {pending ? "保存中…" : memory ? "保存修改" : "确认并保存"}
                            </Button>
                                        </>}
            >
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            void save();
                        }}
                        className="memory-editor-form" id="memory-editor-form"
                    >
                        <div className="memory-editor-body">
                            <fieldset disabled={pending || saveCompleted} className="memory-editor-fields">
                                {sourceExcerpt && (
                                    <details className="memory-source-excerpt">
                                        <summary>查看这条记忆的原始依据</summary>
                                        <p>{sourceExcerpt}</p>
                                        <small>
                                            来自已确认的历史总结。请再次检查它是否仍适用于当前项目。
                                        </small>
                                    </details>
                                )}
                                <div className="memory-form-pair">
                                    <Field label="分类">
                                        <MemorySelect label="记忆分类" value={draft.category}
                                                      disabled={pending || saveCompleted} options={CATEGORY_LABELS}
                                                      onValueChange={category => change({category: category as MemoryInput["category"]})}/>
                                    </Field>
                                    <Field label="标题">
                                        <Input
                                            autoFocus
                                            required
                                            maxLength={120}
                                            value={draft.title}
                                            onChange={(event) => change({title: event.target.value})}
                                            placeholder="例如：角色对白的语气"
                                        />
                                    </Field>
                                </div>
                                <Field label="记忆正文">
                                    <Textarea
                                        required
                                        rows={6}
                                        maxLength={6000}
                                        value={draft.body}
                                        onChange={(event) => change({body: event.target.value})}
                                        placeholder="保留明确、可复用的结论，而不是整段聊天记录。"
                                    />
                                </Field>
                                <Field label="引用方式"><MemorySelect label="引用方式"
                                                                      value={draft.inclusion ?? "relevant"}
                                                                      disabled={pending || saveCompleted}
                                                                      options={{
                                                                          relevant: "按需引用",
                                                                          project: "项目通用"
                                                                      }}
                                                                      onValueChange={inclusion => change({inclusion: inclusion as MemoryInput["inclusion"]})}/></Field>
                                <p className="memory-field-hint">{draft.inclusion === "project" ? "在本项目的对话中优先带入，仍受上下文预算限制。请确认适用于整个项目。" : "根据当前问题和任务选择，仅在相关时带入。"}</p>
                                <Field label="适用条件">
                                    <Textarea
                                        rows={2}
                                        maxLength={2000}
                                        value={draft.applicability}
                                        onChange={(event) =>
                                            change({applicability: event.target.value})
                                        }
                                        placeholder="适用于哪些场景，有什么例外？"
                                    />
                                </Field>
                                <div className="memory-form-pair">
                                    <Field label="主题（用于检查重复）">
                                        <Input
                                            maxLength={120}
                                            value={draft.topicKey}
                                            onChange={(event) =>
                                                change({topicKey: event.target.value})
                                            }
                                            placeholder="留空时使用标题"
                                        />
                                    </Field>
                                    <Field label="标签（逗号分隔）">
                                        <Input
                                            maxLength={600}
                                            value={tagsText}
                                            onChange={(event) => setTagsText(event.target.value)}
                                            placeholder="角色，对白"
                                        />
                                    </Field>
                                </div>
                            </fieldset>
                            {memory && current && current.revision !== expectedRevision && (
                                <div className="memory-conflicts" role="status">
                                    <strong>这条记忆已在其他地方更新</strong>
                                    <p>
                                        最新内容：{current.title}
                                    </p>
                                    <p>{current.body}</p>
                                    <p>适用条件：{current.applicability || "未单独限定"}</p>
                                    <p>引用方式：{current.inclusion === "project" ? "项目通用" : "按需引用"}</p>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        disabled={pending}
                                        onClick={() => {
                                            setExpectedRevision(current.revision);
                                            setError("");
                                        }}
                                    >
                                        已核对最新版本，保留我的草稿继续编辑
                                    </Button>
                                </div>
                            )}
                            {memory && current === null && (
                                <p className="memory-error" role="alert">
                                    这条记忆已被删除。编辑内容仍保留，可复制后另行添加。
                                </p>
                            )}
                            {readError && (
                                <div className="memory-error" role="alert">
                                    <p>暂时无法读取记忆：{readError}。草稿已保留。</p>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        disabled={pending}
                                        onClick={() => setReadAttempt((value) => value + 1)}
                                    >
                                        重新读取
                                    </Button>
                                </div>
                            )}
                            {identityMismatch && (
                                <p className="memory-error" role="alert">
                                    编辑目标已发生变化。草稿与原始来源仍保留，请重新打开原记忆后再保存。
                                </p>
                            )}
                            {error && (
                                <p className="memory-error" role="alert">
                                    {error}。编辑内容仍保留。
                                </p>
                            )}
                            {!!conflicts?.length && (
                                <div className="memory-conflicts">
                                    <p>
                                        已有相同主题的内容。你可以修改主题，也可以明确替代其中一条。
                                    </p>
                                    {conflicts.map((item) => (
                                        <div key={item.id}>
                                            <strong>{item.title}</strong>
                                            <p>{item.body}</p>
                                            {!memory && (
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="sm"
                                                    disabled={pending}
                                                    onClick={() =>
                                                        void save({
                                                            id: item.id,
                                                            expectedRevision: item.revision,
                                                        })
                                                    }
                                                >
                                                    保存并替代此条
                                                </Button>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </form>
            </SidePanel>
            <AlertDialog
                open={discard || blocker.status === "blocked"}
                onOpenChange={(open) => {
                    if (!open) {
                        setDiscard(false);
                        blocker.reset?.();
                    }
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>放弃尚未保存的修改？</AlertDialogTitle>
                        <AlertDialogDescription>
                            当前编辑的内容尚未写入项目记忆，离开后将丢失。
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={pending}>继续编辑</AlertDialogCancel>
                        <AlertDialogAction
                            disabled={pending}
                            onClick={() => {
                                if (blocker.status === "blocked") blocker.proceed();
                                else onClose();
                            }}
                        >
                            放弃修改
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
