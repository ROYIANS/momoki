import {useEffect, useState} from "react";
import {ContextPanel, ContextPanelContent} from "../../../app/layout/context-panel";
import {useAutoOpenPanel} from "../../../app/layout/autoOpen";
import type {GenerationSubmitArgs} from "../../video/agent/generationProfiles";
import type {AgentToolCall} from "../models/agent";
import type {RunAction} from "../models/chatRunAction";
import {useAgentActivityNavigation} from "./AgentActivityNavigation";
import {GenerationReview} from "./GenerationReview";
import {MusicGenerationReview} from "./MusicGenerationReview";

const TITLES = {generation: "生成提案", music: "音乐生成"} as const;

/**
 * A proposal that waits for the user's confirmation, shown in the side panel instead of inside the message. This
 * shell stays in the message row, so the draft the user edits survives the panel closing and reopening; the
 * message itself only says it is waiting. The row above the composer ("审阅") brings the panel back.
 */
export function CallReviewPanel({call, kind, busy, onAction}: {
    call: AgentToolCall; kind: keyof typeof TITLES; busy: boolean;
    onAction: (runId: string, action: RunAction, callId?: string) => void;
}) {
    const {request} = useAgentActivityNavigation();
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<GenerationSubmitArgs>();
    useEffect(() => {
        if (request?.runId === call.runId && request.callId === call.id) setOpen(true);
    }, [request, call.runId, call.id]);
    // A changed proposal (new revision) is a new thing to offer.
    const panelOpenChange = useAutoOpenPanel({key: `call:${call.id}:${call.preview?.revision ?? 0}`, ready: true, open, width: 480, setOpen});
    return <>
        <p className="agent-action-hint" data-agent-public="true">{TITLES[kind]}待确认，在右侧栏审阅</p>
        <ContextPanel kind="call-review" title={TITLES[kind]} open={open} width={480} onOpenChange={panelOpenChange}>
            <ContextPanelContent className="agent-chat-root css-var-agent-chat agent-call-review-panel">
                {kind === "music"
                    ? <MusicGenerationReview key={call.id} call={call} busy={busy} active onAction={onAction}/>
                    : <GenerationReview call={call} busy={busy} onAction={onAction} retained={{draft, set: setDraft}}/>}
            </ContextPanelContent>
        </ContextPanel>
    </>;
}
