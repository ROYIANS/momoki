import {useId, useRef, useState} from "react";
import {useBlocker} from "@tanstack/react-router";
import {LoaderCircle} from "../../../ui/icons";
import type {IpProfile, IpProfileInput} from "../models/materials";
import {createIpProfile, updateIpProfile} from "../commands/ipProfiles";
import {Button} from "../../../ui/button";
import {Input} from "../../../ui/input";
import {Textarea} from "../../../ui/textarea";
import {SidePanel} from "../../../app/layout/SidePanel";
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle
} from "../../../ui/alert-dialog";

export const IP_TEXT_FIELDS = [
    {
        key: "positioning",
        label: "IP 定位",
        placeholder: "你是谁，希望以什么独特视角被记住",
        hint: "一个清晰的身份，或者一句创作主张。"
    },
    {
        key: "audience",
        label: "目标受众",
        placeholder: "你的作品希望与谁产生共鸣",
        hint: "他们关注什么，期待怎样的陪伴或帮助。"
    },
    {
        key: "topics",
        label: "内容主题",
        placeholder: "持续关注的领域、故事或话题",
        hint: "可以分行记录，让不同项目拥有共同方向。"
    },
    {
        key: "expression",
        label: "表达方式",
        placeholder: "例如：平实、幽默，带一点观察生活的敏锐",
        hint: "语气、叙事习惯，以及希望避免的表达。"
    },
    {
        key: "visual",
        label: "视觉偏好",
        placeholder: "画面风格、色彩、构图或形象特征",
        hint: "文字描述可与 IP 素材库里的参考图配合使用。"
    },
    {
        key: "voice",
        label: "声音偏好",
        placeholder: "音色、节奏、配乐或口播风格",
        hint: "记录创作偏好，暂不涉及声音训练或生成。"
    },
] as const;

type Draft = Required<IpProfileInput>;

function initialDraft(profile?: IpProfile): Draft {
    return {
        name: profile?.name ?? "",
        positioning: profile?.positioning ?? "",
        audience: profile?.audience ?? "",
        topics: profile?.topics ?? "",
        expression: profile?.expression ?? "",
        visual: profile?.visual ?? "",
        voice: profile?.voice ?? ""
    };
}

/** The mounted editor owns a frozen revision. Live updates never overwrite unsaved input. */
export function IpProfileEditor({profile, onClose, onSaved}: {
    profile?: IpProfile;
    onClose: () => void;
    onSaved: (id: string) => void;
}) {
    const id = useId();
    const [baseline] = useState(() => initialDraft(profile));
    const [draft, setDraft] = useState(baseline);
    const [pending, setPending] = useState(false);
    const pendingRef = useRef(false);
    const [error, setError] = useState<string>();
    const [discardOpen, setDiscardOpen] = useState(false);
    const saved = useRef(false);
    const dirty = (Object.keys(baseline) as Array<keyof Draft>).some(key => baseline[key] !== draft[key]);
    const blocker = useBlocker({
        shouldBlockFn: () => !saved.current && (dirty || pendingRef.current),
        withResolver: true,
        enableBeforeUnload: dirty || pending
    });

    function close() {
        if (pendingRef.current) return;
        if (dirty) setDiscardOpen(true);
        else onClose();
    }

    async function save() {
        if (pendingRef.current) return;
        if (!draft.name.trim()) {
            setError("请填写 IP 名称。");
            return;
        }
        pendingRef.current = true;
        setPending(true);
        setError(undefined);
        try {
            if (profile) await updateIpProfile(profile.id, draft, profile.revision);
            const profileId = profile?.id ?? (await createIpProfile(draft)).id;
            saved.current = true;
            onSaved(profileId);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "保存失败，你的编辑已保留，请重试。");
        } finally {
            pendingRef.current = false;
            setPending(false);
        }
    }

    return <>
        <SidePanel open onOpenChange={open => {
            if (!open) close();
        }} kind="ip-profile-editor" width={520} title={profile ? "编辑 IP 档案" : "新建 IP"}
                   description="先起个名字，其余内容可以在创作中慢慢补充。"
                   footer={<>
                       {error ? <p role="alert" className="mr-auto text-sm text-destructive">{error}</p> : null}
                       <Button type="button" variant="ghost" disabled={pending} onClick={close}>取消</Button>
                       <Button type="submit" form={`${id}-form`}
                               disabled={pending || (Boolean(profile) && !dirty)}>{pending &&
                           <LoaderCircle className="animate-spin motion-reduce:animate-none"
                                         aria-hidden/>}{pending ? "正在保存…" : profile ? "保存修改" : "创建 IP"}</Button>
                   </>}>
                <form onSubmit={event => {
                    event.preventDefault();
                    void save();
                }} className="ip-editor-form" id={`${id}-form`}>
                    <div className="ip-editor-fields">
                        <div className="ip-editor-field ip-editor-name"><label htmlFor={`${id}-name`}>IP
                            名称 <span>必填</span></label><Input id={`${id}-name`} autoFocus value={draft.name}
                                                                 maxLength={300} disabled={pending}
                                                                 placeholder="例如：山间来信" onChange={event => {
                            setDraft(value => ({...value, name: event.target.value}));
                            setError(undefined);
                        }}/></div>
                        {IP_TEXT_FIELDS.map(field => <div key={field.key} className="ip-editor-field"><label
                            htmlFor={`${id}-${field.key}`}>{field.label}</label><Textarea id={`${id}-${field.key}`}
                                                                                          value={draft[field.key]}
                                                                                          maxLength={20000}
                                                                                          disabled={pending}
                                                                                          placeholder={field.placeholder}
                                                                                          onChange={event => {
                                                                                              setDraft(value => ({
                                                                                                  ...value,
                                                                                                  [field.key]: event.target.value
                                                                                              }));
                                                                                              setError(undefined);
                                                                                          }}/><p>{field.hint}</p>
                        </div>)}
                    </div>
                </form>
        </SidePanel>
        <AlertDialog open={discardOpen || blocker.status === "blocked"} onOpenChange={open => {
            if (!open && !pending) {
                setDiscardOpen(false);
                blocker.reset?.();
            }
        }}>
            <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{pending ? "档案正在保存" : "保留这次编辑吗？"}</AlertDialogTitle><AlertDialogDescription>{pending ? "请等待保存结束，避免遗漏刚刚填写的内容。" : "还有未保存的内容。可以返回继续编辑，或放弃本次修改。"}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter>
                <AlertDialogCancel asChild onClick={event => event.preventDefault()}><Button variant="outline"
                                                                                             disabled={pending}
                                                                                             onClick={() => {
                                                                                                 setDiscardOpen(false);
                                                                                                 blocker.reset?.();
                                                                                             }}>继续编辑</Button></AlertDialogCancel>
                <Button variant="destructive" disabled={pending} onClick={() => {
                    saved.current = true;
                    setDiscardOpen(false);
                    if (blocker.status === "blocked") blocker.proceed?.();
                    onClose();
                }}>放弃修改</Button>
            </AlertDialogFooter></AlertDialogContent>
        </AlertDialog>
    </>;
}
