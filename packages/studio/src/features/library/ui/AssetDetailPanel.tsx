import {useCallback, useEffect, useRef, useState} from "react";
import type {DetailPanelRequest, DetailPanelOutcome, DetailPanelClose, DetailPanelCloseRequest} from "../../../app/layout/detailPanelSession";
import {ContextPanel, ContextPanelContent, ContextPanelDescription, ContextPanelHeader, ContextPanelTitle} from "../../../app/layout/context-panel";
import {useManualDraftDeparture} from "../../../app/drafts/useManualDraftGuard";
import type {AssetDetailTarget} from "../models/assetDetailTarget";
import {AssetDetailContent, ASSET_DETAIL_LABELS, assetTargetKey, useAssetDetailDrafts} from "./AssetDetailContent";

/** One retained asset family; only accepted identity keys the actual editor. */
export function AssetDetailPanel({request, onRequestOutcome, onClosed, closeRequest, onCloseRefused, returnLabel}: {
    request: DetailPanelRequest<AssetDetailTarget>;
    onRequestOutcome: (event: DetailPanelOutcome) => void;
    onClosed: (event: DetailPanelClose) => void;
    closeRequest?: DetailPanelCloseRequest;
    onCloseRefused?: (closeRequestId: string) => void;
    returnLabel?: string;
}) {
    const [active, setActive] = useState(request);
    const {state, report, readState, discard, reset} = useAssetDetailDrafts();
    const {requestDeparture, confirmation} = useManualDraftDeparture(state.dirty, state.pending, discard, {readState: readState});
    const current = useRef({active, onRequestOutcome, onClosed, onCloseRefused});
    current.current = {active, onRequestOutcome, onClosed, onCloseRefused};
    const handled = useRef(request.id);
    const switching = useRef<string | undefined>(undefined);
    const presented = useRef<string | undefined>(undefined);
    const consumedClose = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (request.id === handled.current) return;
        handled.current = request.id;
        if (switching.current) {
            onRequestOutcome({requestId: request.id, status: "refused", reason: "busy"});
            return;
        }
        if (assetTargetKey(request.target) === assetTargetKey(active.target)) {setActive(request); return;}
        const candidate = request;
        switching.current = candidate.id;
        requestDeparture(() => {
            switching.current = undefined;
            reset(); setActive(candidate);
        }, discard, () => {
            switching.current = undefined;
            current.current.onRequestOutcome({requestId: candidate.id, status: "refused", reason: "guard"});
        });
    }, [request, active, requestDeparture, reset, discard, onRequestOutcome]);
    const close = useCallback((reason: "close" | "return", closeId?: string) => {
        if (switching.current) {
            if (closeId) current.current.onCloseRefused?.(closeId);
            return;
        }
        const selection = current.current.active;
        switching.current = closeId ?? reason;
        requestDeparture(() => {
            switching.current = undefined;
            if (current.current.active.id === selection.id) current.current.onClosed({requestId: selection.id, reason});
        }, discard, () => {
            switching.current = undefined;
            if (closeId) current.current.onCloseRefused?.(closeId);
        });
    }, [requestDeparture, discard]);
    useEffect(() => {
        if (!closeRequest || closeRequest.id === consumedClose.current) return;
        consumedClose.current = closeRequest.id;
        if (closeRequest.requestId !== active.id) {current.current.onCloseRefused?.(closeRequest.id); return;}
        close("return", closeRequest.id);
    }, [closeRequest, active.id, close]);
    return <><ContextPanel kind="asset" open onOpenChange={(open, reason) => {
        if (open) return;
        if (reason === "guard-refused" || reason === "busy") {
            onRequestOutcome({requestId: active.id, status: "refused", reason: reason === "busy" ? "busy" : "guard"});
        } else onClosed({requestId: active.id, reason: reason === "replaced" ? "replaced" : "close"});
    }} onRequestDeparture={(proceed, cancel) => requestDeparture(proceed, discard, cancel)}>
        <ContextPanelContent returnLabel={returnLabel ?? "返回对话"} showReturnWhenDocked={Boolean(returnLabel)} onReturn={returnLabel ? () => close("return") : undefined}
            onPresented={() => {
                if (presented.current === active.id) return;
                presented.current = active.id; onRequestOutcome({requestId: active.id, status: "presented"});
            }} className="flex min-h-0 flex-col" data-asset-detail={active.target.entityId} aria-busy={state.pending}>
            <ContextPanelHeader><ContextPanelTitle>{ASSET_DETAIL_LABELS[active.target.kind]}详情</ContextPanelTitle>
                <ContextPanelDescription>查看与编辑设定，对话会继续运行。</ContextPanelDescription></ContextPanelHeader>
            <AssetDetailContent key={assetTargetKey(active.target)} target={active.target} report={report} readState={readState} embedded/>
        </ContextPanelContent>
    </ContextPanel>{confirmation}</>;
}
