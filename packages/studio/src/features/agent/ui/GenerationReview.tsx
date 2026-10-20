import {ShotDetailLink} from "../../../app/details/ShotDetails";
import {useId, useRef, useState} from "react";
import {useProductQuery} from "../../../platform/product/queries";
import {Input, Select} from "antd";

import {ArrowUpRight, Image, LoaderCircle, Restore, Video} from "../../../ui/icons";
import {toast} from "sonner";
import {getGenerationPreferenceState, saveGenerationPreference} from "../../settings/commands/generationPreferences";
import type {AgentToolCall} from "../models/agent";
import {
    generationResolutionChange,
    getGenerationCapability,
    projectGenerationParameters
} from "../../video/models/generationCapabilities";
import {Button} from "../../../ui/button";
import {Checkbox} from "../../../ui/checkbox";
import {
    GENERATION_PROFILES,
    type GenerationSubmitArgs,
    generationSubmitSchema,
    profileRequest
} from "../../video/agent/generationProfiles";
import {reviewAndApproveGeneration} from "../../video/agent/generationReview";
import {recommendGenerationSelection} from "../../video/agent/generationSelection";
import {applyGenerationSelection} from "../../video/agent/generationReviewDraft";
import type {RunAction} from "../models/chatRunAction";
import {ContextPanelFooter} from "../../../app/layout/context-panel";

const PROVIDER_LABELS = {apimart: "APIMart", aihubmix: "AIHubMix"};

function popupRoot() {
    return document.querySelector<HTMLElement>(".agent-chat-root") ?? document.body;
}

function Choice({label, value, options, onChange, disabled}: {
    label: string; value?: string; options: Array<{ value: string; label: string; disabled?: boolean }>;
    onChange: (value: string) => void; disabled?: boolean;
}) {
    const id = useId();
    return <div className="agent-generation-field"><label htmlFor={id}>{label}</label>
        <Select id={id} value={value} options={options} onChange={onChange} disabled={disabled} variant="borderless"
                getPopupContainer={(trigger: HTMLElement) => trigger.closest<HTMLElement>('[role=dialog]') ?? popupRoot()}
                popupMatchSelectWidth virtual={false} className="agent-generation-choice"/>
    </div>;
}

const options = (values: readonly (string | number)[]) => values.map((value) => ({
    value: String(value),
    label: String(value)
}));

/** The model's proposal remains immutable; only confirmed overrides become executable. */
export function GenerationReview({call, busy, onAction, retained}: {
    call: AgentToolCall; busy: boolean; onAction: (runId: string, action: RunAction, callId?: string) => void;
    /** A draft held outside this form, so edits survive the side panel closing and reopening. */
    retained?: RetainedDraft;
}) {
    let raw: unknown;
    try {
        raw = JSON.parse(call.arguments);
    } catch {
        raw = undefined;
    }
    const parsed = generationSubmitSchema.safeParse(raw);
    if (!parsed.success || !call.preview?.revision) return <div><p
        role="alert">生成提案不完整，请取消后让助手重新准备。</p><Button variant="ghost" size="sm" disabled={busy}
                                                                       onClick={() => onAction(call.runId, "reject", call.id)}>取消本次生成</Button>
    </div>;
    return <GenerationReviewForm key={call.id} call={call} initial={parsed.data} busy={busy} onAction={onAction} retained={retained}/>;
}

export type RetainedDraft = {draft: GenerationSubmitArgs | undefined; set: (draft: GenerationSubmitArgs) => void};

function GenerationReviewForm({call, initial, busy, onAction, retained}: {
    call: AgentToolCall;
    initial: GenerationSubmitArgs;
    busy: boolean;
    onAction: (runId: string, action: RunAction, callId?: string) => void;
    retained?: RetainedDraft;
}) {
    const [localDraft, setLocalDraft] = useState(initial);
    const draft = retained?.draft ?? localDraft;
    const setDraft = (next: GenerationSubmitArgs) => {
        setLocalDraft(next);
        retained?.set(next);
    };
    const [saving, setSaving] = useState(false);
    const [remember, setRemember] = useState(false);
    const [error, setError] = useState<string>();
    const [notice, setNotice] = useState<string>();
    const savingRef = useRef(false);
    const connectors = useProductQuery((db) => db.connectors.toArray(), []);
    const preferenceState = useProductQuery(getGenerationPreferenceState, []);
    const project = useProductQuery(async (db) => (await db.projects.get(initial.target.projectId)) ?? null, [initial.target.projectId]);
    const kind = initial.target.kind === "shot" && initial.target.slot === "clip" ? "video" : "image";
    const title = kind === "image" ? "图片" : "视频";
    const Icon = kind === "image" ? Image : Video;
    const selected = connectors?.find((item) => item.id === draft.connectorId);
    const provider = selected?.definitionId;
    const validProvider = provider === "apimart" || provider === "aihubmix" ? provider : undefined;
    const recommendation = connectors && preferenceState && project !== undefined ? recommendGenerationSelection({
        kind,
        connectors,
        projectDefaults: project?.generationDefaults,
        preferences: preferenceState.preferences,
        preferenceIssues: preferenceState.issues,
    }) : undefined;
    const hasDefault = Boolean(preferenceState?.preferences[kind] || preferenceState?.issues[kind]);
    let validation: string | undefined;
    try {
        if (!connectors) throw new Error("正在读取生成连接…");
        if (!selected?.apiKey.trim() || !validProvider) throw new Error("请选择已配置密钥的生成连接。");
        if (!draft.prompt.trim()) throw new Error("请填写画面描述。");
        profileRequest(generationSubmitSchema.parse(draft), validProvider);
    } catch (cause) {
        validation = cause instanceof Error && cause.name !== "ZodError" ? cause.message : "请检查画面描述与生成参数。";
    }
    const disabled = busy || saving;

    async function confirm() {
        if (savingRef.current || busy || validation) return;
        savingRef.current = true;
        setSaving(true);
        setError(undefined);
        try {
            await reviewAndApproveGeneration(call.runId, call.id, draft, {
                arguments: call.arguments,
                revision: call.preview!.revision!
            });
            if (remember) {
                const parameters = {...draft.parameters};
                delete parameters.mode;
                if (parameters.aspectRatio === "adaptive") delete parameters.aspectRatio;
                await saveGenerationPreference(kind, {connectorId: draft.connectorId, model: draft.model, parameters})
                    .catch(() => toast.error("本次生成已确认，但默认配置保存失败，请稍后重试。"));
            }
            onAction(call.runId, "resume");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "确认失败，请重试。");
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    }

    return <div className="agent-generation-review" aria-label={`确认${title}生成`}>
        <div className="agent-generation-review-heading"><Icon size={18}
                                                               aria-hidden/><strong>确认{title}生成</strong><span>AI 已准备</span>
        </div>
        <p className="agent-generation-review-intro">可以直接确认，也可以调整下面的配置。</p>
        {call.preview?.target && /^\/(?!\/)/.test(call.preview.target.href) && <ShotDetailLink className="agent-generation-target"
                                                                                     href={call.preview.target.href}>{call.preview.target.label}<ArrowUpRight
            size={13} aria-hidden/></ShotDetailLink>}
        {recommendation && ["project", "global"].includes(recommendation.source) &&
            <div className="agent-generation-default">
                <span>{recommendation.status === "ready" ? `${recommendation.source === "project" ? "项目" : "我的"}默认 · ${recommendation.recommendation?.model}` : recommendation.issues.join("；")}</span>
                {recommendation.recommendation && <button type="button" disabled={disabled} onClick={() => {
                    const selection = recommendation.recommendation!;
                    const selectedProvider = connectors?.find((item) => item.id === selection.connectorId)?.definitionId;
                    if (selectedProvider === "apimart" || selectedProvider === "aihubmix") {
                        setDraft(applyGenerationSelection(draft, selection, selectedProvider));
                        setError(undefined);
                        setNotice("已应用默认配置，生成方式沿用本次参考素材。");
                    }
                }}>应用默认</button>}
            </div>}
        <GenerationConfigurationFields draft={draft} onChange={setDraft} disabled={disabled}/>
        {notice && <p className="agent-generation-form-note" role="status">{notice}</p>}
        <div className="agent-generation-remember"><label><Checkbox checked={remember} disabled={disabled}
                                                                    onCheckedChange={(value) => setRemember(value === true)}/>设为默认{title}生成配置</label>
            {hasDefault && <button type="button" className="agent-generation-reset" disabled={disabled} onClick={() => {
                if (savingRef.current) return;
                savingRef.current = true;
                setSaving(true);
                void saveGenerationPreference(kind, null).then(() => toast.success(`已清除默认${title}配置`)).catch(() => toast.error("清除默认配置失败，请重试。"))
                    .finally(() => {
                        savingRef.current = false;
                        setSaving(false);
                    });
            }}>清除已保存的默认</button>}
        </div>
        {remember &&
            <p className="agent-generation-form-note">用于未设置项目默认值的后续生成，仅记住连接、模型和通用参数。</p>}
        {(error || validation) && <p role="alert" className="agent-generation-form-error">{error ?? validation}</p>}
        <p className="agent-generation-cost-note">确认后向所选供应商提交，可能产生费用。生成结果会先保存到本地。</p>
        <ContextPanelFooter className="agent-generation-confirm-actions">
            <Button size="sm" disabled={disabled || Boolean(validation)} onClick={() => void confirm()}>{saving &&
                <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none"/>}确认并生成{title}</Button>
            <Button size="sm" variant="ghost" disabled={disabled}
                    onClick={() => onAction(call.runId, "reject", call.id)}>取消本次生成</Button>
            <button type="button" className="agent-generation-reset" disabled={disabled} onClick={() => {
                setDraft(initial);
                setError(undefined);
                setNotice(undefined);
            }}><Restore size={13} aria-hidden/>恢复 AI 建议
            </button>
        </ContextPanelFooter>
    </div>;
}

/** Shared configuration controls for single requests and durable batch drafts. */
export function GenerationConfigurationFields({draft, onChange, disabled}: {
    draft: GenerationSubmitArgs;
    onChange: (draft: GenerationSubmitArgs) => void;
    disabled: boolean
}) {
    const promptId = useId();
    const connectors = useProductQuery((db) => db.connectors.toArray(), []);
    const kind = draft.target.kind === 'shot' && draft.target.slot === 'clip' ? 'video' : 'image';
    const selected = connectors?.find(item => item.id === draft.connectorId);
    const provider = selected?.definitionId;
    const validProvider = provider === 'apimart' || provider === 'aihubmix' ? provider : undefined;
    const choices = (connectors ?? []).filter(item => item.definitionId === 'apimart' || item.definitionId === 'aihubmix');
    const models = GENERATION_PROFILES.filter(item => item.provider === provider && item.kind === kind);
    const profile = models.find(item => item.model === draft.model);
    const p = draft.parameters;
    const frames = draft.inputs.some(input => ['first-frame', 'last-frame'].includes(input.role));
    const references = draft.inputs.length > 0 && !frames;
    const referenceVideos = draft.inputs.filter(input => input.role === 'reference-video').length;
    // Preserve the existing role-based control view; executable validation uses proposal mode.
    const displayProfile = profile ?? getGenerationCapability(provider === "aihubmix" ? "aihubmix" : "apimart", kind === "image" ? "gpt-image-2" : provider === "aihubmix" ? "veo-3.1-fast-generate-preview" : "MiniMax-H3", kind);
    const controls = displayProfile && projectGenerationParameters(displayProfile, p, {
        purpose: "request", mode: frames && validProvider ? "frames" : references ? "reference" : "text",
        inputRoles: draft.inputs.map(input => input.role),
    });
    const patch = (parameters: GenerationSubmitArgs['parameters']) => onChange({
        ...draft,
        parameters: {...draft.parameters, ...parameters}
    });

    function changeConnection(connectorId: string) {
        const connection = choices.find(item => item.id === connectorId);
        const supported = GENERATION_PROFILES.filter(profile => profile.provider === connection?.definitionId && profile.kind === kind);
        const model = supported.find(profile => profile.model === draft.model)?.model ?? supported[0]?.model;
        if (model && connection && (connection.definitionId === 'apimart' || connection.definitionId === 'aihubmix')) onChange(applyGenerationSelection(draft, {
            connectorId,
            model,
            parameters: {}
        }, connection.definitionId));
    }

    return <>
        <div className="agent-generation-fields">
            <Choice label="供应商连接" value={draft.connectorId} disabled={disabled} options={[
                ...choices.map((item) => ({
                    value: item.id,
                    label: `${PROVIDER_LABELS[item.definitionId as keyof typeof PROVIDER_LABELS]}${item.label ? ` · ${item.label}` : ""}${!item.apiKey.trim() ? "（未配置密钥）" : ""}`,
                    disabled: !item.apiKey.trim()
                })),
                ...(!selected ? [{
                    value: draft.connectorId,
                    label: connectors ? "原连接已不可用" : "读取连接…",
                    disabled: true
                }] : []),
            ]} onChange={changeConnection}/>
            <Choice label="生成模型" value={draft.model} disabled={disabled || !models.length}
                    options={models.map((model) => ({value: model.model, label: model.label}))} onChange={(model) => {
                if (validProvider) onChange(applyGenerationSelection(draft, {
                    connectorId: draft.connectorId,
                    model,
                    parameters: {}
                }, validProvider));
            }}/>
        </div>
        <div className="agent-generation-field"><label htmlFor={promptId}>画面描述</label><Input.TextArea id={promptId}
                                                                                                          value={draft.prompt}
                                                                                                          onChange={(event) => {
                                                                                                              onChange({
                                                                                                                  ...draft,
                                                                                                                  prompt: event.target.value
                                                                                                              });
                                                                                                          }}
                                                                                                          disabled={disabled}
                                                                                                          autoSize={{
                                                                                                              minRows: 3,
                                                                                                              maxRows: 9
                                                                                                          }}
                                                                                                          maxLength={32000}
                                                                                                          variant="borderless"/>
        </div>
        <div className="agent-generation-fields agent-generation-parameters">
            {kind === "image" ? <>
                <Choice label={provider === "aihubmix" ? "图片尺寸" : "图片比例"}
                        value={p.size ?? controls?.defaultSize ?? "auto"}
                        disabled={disabled}
                        options={options(!profile && provider !== "aihubmix" ? ["auto", ...(controls?.sizes ?? []).filter(size => size !== "auto")] : controls?.sizes ?? [])}
                        onChange={(size) => patch({size})}/>
                {provider === "aihubmix" ? <Choice label="画质" value={p.quality ?? "default"} disabled={disabled}
                                                   options={[{
                                                       value: "default",
                                                       label: "模型默认"
                                                   }, ...(controls?.qualities ?? []).map(value => ({
                                                       value,
                                                       label: value === "low" ? "低" : value === "medium" ? "中" : "高"
                                                   }))]}
                                                   onChange={(quality) => patch({quality: quality === "default" ? undefined : quality as "low" | "medium" | "high"})}/>
                    : <Choice label="分辨率" value={p.resolution ?? controls?.defaultResolution ?? "1k"}
                              disabled={disabled}
                              options={options(controls?.resolutions ?? [])}
                              onChange={(resolution) => patch({resolution})}/>}
                {profile && "qualities" in profile &&
                    <Choice label="画质" value={p.quality ?? controls?.defaultQuality ?? "auto"} disabled={disabled}
                            options={options(controls?.qualities ?? [])}
                            onChange={(quality) => patch({quality: quality as NonNullable<GenerationSubmitArgs["parameters"]["quality"]>})}/>}
                {profile && "versions" in profile &&
                    <Choice label="版本" value={p.version ?? controls?.defaultVersion ?? "flare"} disabled={disabled}
                            options={options(controls?.versions ?? [])}
                            onChange={(version) => patch({version: version as "flare" | "sunburst"})}/>}
            </> : <>
                <Choice label="分辨率" value={p.resolution ?? controls?.defaultResolution}
                        disabled={disabled}
                        options={options(controls?.resolutions ?? [])}
                        onChange={(resolution) => patch(displayProfile ? generationResolutionChange(displayProfile, resolution) : {resolution})}/>
                <Choice label="时长（秒）" value={String(p.duration ?? controls?.defaultDuration)}
                        disabled={disabled}
                        options={options(controls?.durations ?? [])}
                        onChange={(duration) => patch({duration: Number(duration)})}/>
                {controls?.showAspectRatio && <Choice label="视频比例"
                                                      value={p.aspectRatio ?? controls?.defaultRatio ?? "16:9"}
                                                      disabled={disabled}
                                                      options={options(controls?.ratios ?? [])}
                                                      onChange={(aspectRatio) => patch({aspectRatio})}/>}
            </>}
        </div>
        {profile && "qualities" in profile &&
            <p className="agent-generation-form-note">auto 会按最高档预扣，完成后再按实际用量结算。</p>}
        <p className="agent-generation-reference-note">{draft.inputs.length ? `已选 ${draft.inputs.length - referenceVideos} 张参考图片${referenceVideos ? `、${referenceVideos} 段视频` : ""}${frames ? " · 首尾帧模式" : ""}` : "根据文字描述生成"} ·
            目标和参考素材沿用本次提案</p>
    </>;
}
