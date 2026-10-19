import {snapshotToolDefinitions} from './capabilityRegistry.js';
import {createRunWriter} from './checkpoint.js';
import {accumulateStreamDelta,createReasoningAccum,finalizeReasoningAccum,type StreamDelta,type ReasoningAccum} from './reasoning.js';
import {toolMetadataMatches,type ToolBindingIdentity,type ToolContext,type ToolDefinition,type ToolMetadata} from './tools.js';
import {MODEL_STEPS_PER_SEGMENT,type AgentRunStatus,type AgentPermissionMode,type AgentToolCallStatus,type AgentRunOutput,type AgentWireToolCall,type AgentModelMetrics,type AgentTokenUsage} from './types.js';

export interface RuntimeRun {
    id:string; threadId:string; checkpoint:number; status:AgentRunStatus;
    hasToolCalls?:boolean; modelStep?:number; modelStepSegmentStart?:number; permissionMode?:AgentPermissionMode;
}
export interface RuntimeCall<Preview> extends ToolMetadata {
    id:string; name:string; arguments:string; status:AgentToolCallStatus; step:number; order:number; preview?:Preview;
}
export type ModelResult<Continuation> = {metrics?:Omit<AgentModelMetrics,'step'>;usage?:AgentTokenUsage} & (
    {ok:true;content:string;toolCalls?:AgentWireToolCall[];continuation?:Continuation;finishReason?:string} |
    {ok:false;message:string;aborted?:boolean;finishReason?:string}
);
export interface RoundDetail extends ToolMetadata {title:string; failure?:{error:string;result:string}}
interface HeldOwnership {assertHeld():void}
type ToolCertainty='not_started'|'rolled_back'|'unknown';

type RuntimeEventData =
    | {type:'output';confirmed:false;output:AgentRunOutput}
    | {type:'checkpoint';confirmed:true;checkpoint:number;output:AgentRunOutput}
    | {type:'tool_round';confirmed:true;step:number}
    | {type:'tool_completed';confirmed:true;callId:string}
    | {type:'approval';confirmed:true}
    | {type:'settled';confirmed:true;status:AgentRunStatus};
export type RuntimeEvent=RuntimeEventData & {sequence:number;runId:string;executionId:string};

/** Semantic commits are host-owned; no generic database or arbitrary transaction callback crosses this boundary. */
export interface RuntimeHost<Run extends RuntimeRun,Call extends RuntimeCall<Preview>,Context extends ToolContext<Preview>,Preview,Continuation> {
    executionId:string;
    ownership:HeldOwnership;
    observe?:(event:RuntimeEvent)=>void;
    clock:()=>number;
    readRun:(id:string)=>Promise<Run|undefined>;
    readOutput:(run:Run)=>Promise<AgentRunOutput|undefined>;
    checkpoint:(run:Run,sequence:number,output:AgentRunOutput)=>Promise<boolean>;
    pauseAtLimit:(run:Run)=>Promise<boolean>;
    /**
     * Optional loop-top hook: the host may durably append user input (in one transaction) and return the reread run.
     * Called only after the previous round's tool results are saved (or before the first request), never mid-round.
     */
    admitPendingInput?:(run:Run,signal:AbortSignal)=>Promise<Run>;
    prepareContext:(run:Run,signal:AbortSignal)=>Promise<Run>;
    admitModelStep:(run:Run,limit:number)=>Promise<Run>;
    request:(run:Run,signal:AbortSignal,onDelta:(delta:StreamDelta)=>void,offeredDefinitions:readonly ToolDefinition<unknown,Context,Preview,unknown>[])=>Promise<ModelResult<Continuation>>;
    recordMetrics:(run:Run,metrics:AgentModelMetrics)=>Promise<void>;
    finishingCheck:(run:Run,output:AgentRunOutput,continuation:Continuation|undefined,signal:AbortSignal)=>Promise<boolean>;
    commitRound:(run:Run,result:Extract<ModelResult<Continuation>,{ok:true}>,details:RoundDetail[],output:AgentRunOutput)=>Promise<void>;
    offeredNames:(run:Run,step?:number)=>readonly string[];
    settle:(run:Run,status:Exclude<AgentRunStatus,'running'|'waiting_approval'>,output:AgentRunOutput,error?:string,finishReason?:string)=>Promise<AgentRunStatus>;
    tools:{
        registry:readonly ToolDefinition<unknown,Context,Preview,unknown>[];
        readRound:(run:Run)=>Promise<Call[]>;
        validateEnvelope:(run:Run,calls:Call[])=>void;
        readCall:(run:Run,id:string)=>Promise<Call|undefined>;
        assertScope:(run:Run,call:Call,signal:AbortSignal)=>Promise<void>;
        /** Live-registration check for a call's pinned binding. Core invokes it at every scope check of a bound call and fails closed when absent. */
        assertBinding?:(binding:ToolBindingIdentity,signal:AbortSignal)=>Promise<void>;
        input:(call:Call)=>{arguments:string;preview?:Preview};
        validate:(name:string,raw:string,offered:readonly string[])=>{tool:ToolDefinition<unknown,Context,Preview,unknown>;args:unknown};
        context:(run:Run,call:Call,signal:AbortSignal,preview?:Preview)=>Context;
        approval:(mode:AgentPermissionMode,tool:ToolDefinition<unknown,Context,Preview,unknown>,args:unknown)=>boolean;
        preview:(run:Run,call:Call,preview:Preview)=>Promise<void>;
        transition:(run:Run,call:Call,from:AgentToolCallStatus[],to:AgentToolCallStatus,extra?:{error?:string;result?:string})=>Promise<boolean>;
        park:(run:Run)=>Promise<void>;
        appendResults:(run:Run)=>Promise<void>;
        markUnknown:(run:Run,force:boolean)=>Promise<void>;
    };
    errors:{
        failure:(cause:unknown,certainty:ToolCertainty)=>unknown;
        unavailable:(name:string,offered:readonly string[])=>Error;
        pending:(cause:unknown)=>boolean;
        pendingError:()=>Error;
        rolledBack:(cause:unknown)=>boolean;
        unknown:(cause:unknown)=>boolean;
        publicMessage:(cause:unknown)=>string;
    };
}

/** Both host admission transactions and the core-facing segment boundary use this same policy. */
export function modelStepLimitReached(run:Pick<RuntimeRun,'modelStep'|'modelStepSegmentStart'>,limit=MODEL_STEPS_PER_SEGMENT):boolean {
    return (run.modelStep ?? 0)-(run.modelStepSegmentStart ?? 0)>=limit;
}
export function canSettleRun(status:AgentRunStatus,allowedFrom:readonly AgentRunStatus[]=['running','waiting_approval']):boolean {
    return allowedFrom.includes(status);
}

class UnresolvedToolOutcomeError extends Error {}
const settled=(status:AgentToolCallStatus)=>['completed','failed','rejected'].includes(status);

/** First establish the complete approval barrier, then freshly read and claim each execution candidate. */
async function executePendingTools<Run extends RuntimeRun,Call extends RuntimeCall<Preview>,Context extends ToolContext<Preview>,Preview,Continuation>(run:Run,controller:AbortController,host:RuntimeHost<Run,Call,Context,Preview,Continuation>,emit:(event:RuntimeEventData)=>void=()=>undefined,offeredDefinitions:ReadonlyMap<number,readonly ToolDefinition<unknown,Context,Preview,unknown>[]> = new Map()):Promise<boolean> {
    const {tools,errors}=host;
    const assertScope=async(scopeRun:Run,call:Call)=>{
        await tools.assertScope(scopeRun,call,controller.signal);
        if (!call.binding) return;
        if (!tools.assertBinding) throw new Error('宿主未提供能力注册检查，已阻止绑定工具');
        await tools.assertBinding(call.binding,controller.signal);
    };
    host.ownership.assertHeld();
    const calls=(await tools.readRound(run)).sort((a,b)=>a.step-b.step || a.order-b.order);
    tools.validateEnvelope(run,calls);
    let waiting=false;
    const admitted = new Map<string, ToolDefinition<unknown,Context,Preview,unknown>>();
    const validate = (call: Call, current: Run) => {
        const raw = tools.input(call).arguments;
        const checked = tools.validate(call.name, raw, host.offeredNames(current,call.step));
        if (!toolMetadataMatches(checked.tool,checked.args,call)) throw new Error('工具定义已变化，请结束本次执行后重新发起任务');
        const offered = offeredDefinitions.get(call.step);
        const pinned = admitted.get(call.id) ?? offered?.find(tool=>tool.name === call.name);
        if (offered && !pinned) throw host.errors.unavailable(call.name,offered.map(tool=>tool.name));
        const tool = pinned ?? snapshotToolDefinitions([checked.tool])[0];
        const args = tool.parseArguments(JSON.parse(raw));
        if (!toolMetadataMatches(tool,args,call)) throw new Error('工具定义已变化，请结束本次执行后重新发起任务');
        admitted.set(call.id,tool);
        return {tool,args};
    };
    for (const call of calls) {
        host.ownership.assertHeld();controller.signal.throwIfAborted();
        if (settled(call.status)) continue;
        if (call.status === 'unknown' || call.status === 'running') throw new Error('有工具结果不确定，不能重跑');
        let validated:ReturnType<typeof tools.validate>;
        try {
            await assertScope(run,call);
            validated=validate(call,run);
        } catch (cause) {
            const error=cause instanceof Error ? cause.message : '工具参数无效';
            await tools.transition(run,call,['pending','approved','awaiting_approval'],'failed',{error,result:JSON.stringify(errors.failure(cause,'not_started') ?? {error})});
            continue;
        }
        const {tool,args}=validated;
        if (!toolMetadataMatches(tool,args,call)) throw new Error('工具定义已变化，请结束本次执行后重新发起任务');
        if (call.status === 'awaiting_approval') {waiting=true;continue;}
        if (tool.prepare && call.preview === undefined) {
            try {
                if (call.status !== 'pending') throw new Error('操作缺少批准前预览，请重新发起');
                const preview=await tool.prepare(args,tools.context(run,call,controller.signal));
                await assertScope(run,call);
                await tools.preview(run,call,preview);
            } catch (cause) {
                controller.signal.throwIfAborted();
                const error=cause instanceof Error ? cause.message : '无法准备操作预览';
                await tools.transition(run,call,['pending','approved'],'failed',{error,result:JSON.stringify(errors.failure(cause,'not_started') ?? {error})});
                continue;
            }
        }
        await assertScope(run,call);
        if (call.status !== 'approved' && tools.approval(run.permissionMode ?? 'ask',tool,args)) {
            await tools.transition(run,call,['pending'],'awaiting_approval');waiting=true;
        }
    }
    if (waiting) {await tools.park(run);emit({type:'approval',confirmed:true});return false;}
    for (const saved of calls) {
        host.ownership.assertHeld();controller.signal.throwIfAborted();
        if (settled(saved.status)) continue;
        const call=await tools.readCall(run,saved.id);
        if (!call || settled(call.status)) continue;
        const current=await host.readRun(run.id);
        if (!current || current.status !== 'running') throw new Error('执行已停止');
        await assertScope(current,call);
        const {tool,args}=validate(call,current);
        if (!toolMetadataMatches(tool,args,call)) throw new Error('工具定义已变化，请结束本次执行后重新发起任务');
        if (tools.approval(run.permissionMode ?? 'ask',tool,args) && call.status !== 'approved') throw new Error('工具尚未获得批准');
        if (!await tools.transition(current,call,['pending','approved'],'running')) throw new Error('工具已被其他执行领取');
        controller.signal.throwIfAborted();
        try {
            const value=await tool.execute(args,tools.context(current,call,controller.signal,tools.input(call).preview));
            // Atomic host tools have already committed their original result with their business writes.
            // Confirm that result first; never overwrite it in an unrelated completion transaction.
            if (tool.atomic) {
                const persisted=await tools.readCall(current,call.id);
                if (persisted?.status !== 'completed') throw new UnresolvedToolOutcomeError('原子工具没有已提交的完成记录，不能确认为成功。');
            } else {
                const result=JSON.stringify(value);
                if (result === undefined || result.length > 65_536) throw new Error('工具结果无效或超过大小限制');
                const saved=await tools.transition(current,call,['running'],'completed',{result});
                if (!saved && (await tools.readCall(current,call.id))?.status !== 'completed') throw new UnresolvedToolOutcomeError('工具完成记录未获确认，不能确认为成功。');
            }
            emit({type:'tool_completed',confirmed:true,callId:call.id});
        } catch (cause) {
            let persisted:Call|undefined;
            try {persisted=await tools.readCall(current,call.id);}
            catch (lookupError) {
                if (tool.effect !== 'read') throw new UnresolvedToolOutcomeError('无法核实已保存的工具结果，不能自动重跑。',{cause:lookupError});
                throw lookupError;
            }
            if (persisted?.status === 'completed') {emit({type:'tool_completed',confirmed:true,callId:call.id});continue;}
            if (errors.pending(cause) || controller.signal.aborted && call.recovery) {
                await tools.markUnknown(current,false);
                if (errors.pending(cause)) {if (cause instanceof Error) throw cause;throw new Error(String(cause),{cause});}
                throw errors.pendingError();
            }
            const ambiguous=!errors.rolledBack(cause) && tool.effect !== 'read';
            const error=ambiguous ? '操作结果尚不确定，请先核实，不能自动重跑。' : cause instanceof Error ? cause.message : '工具执行失败。';
            const certainty=errors.rolledBack(cause) ? 'rolled_back' : tool.effect === 'read' ? 'not_started' : 'unknown';
            try {await tools.transition(current,call,['running'],ambiguous ? 'unknown' : 'failed',{error,...(!ambiguous ? {result:JSON.stringify(errors.failure(cause,certainty) ?? {error})} : {})});}
            catch (saveError) {if (ambiguous) throw new UnresolvedToolOutcomeError(error,{cause:saveError});throw saveError;}
            if (ambiguous) throw new UnresolvedToolOutcomeError(error,{cause});
        }
        controller.signal.throwIfAborted();
    }
    await tools.appendResults(run);
    return true;
}

/** The single request/tool execution loop used by every host. Provider continuation stays opaque. */
export async function executeRun<Run extends RuntimeRun,Call extends RuntimeCall<Preview>,Context extends ToolContext<Preview>,Preview,Continuation>(initialRun:Run,controller:AbortController,host:RuntimeHost<Run,Call,Context,Preview,Continuation>):Promise<void> {
    host.ownership.assertHeld();
    if (!host.executionId) throw new Error('执行事件缺少本次执行标识');
    let run=await host.readRun(initialRun.id) ?? initialRun;
    const savedOutput=await host.readOutput(run);
    let accum:ReasoningAccum={...createReasoningAccum(),content:savedOutput?.content ?? '',reasoning:savedOutput?.reasoning ?? '',reasoningDurationMs:savedOutput?.reasoningDurationMs};
    let saveFailed=false,sequence=run.checkpoint,eventSequence=0;
    const emit=(event:RuntimeEventData)=>{
        // Observers receive notifications, never control durable execution or expose opaque continuation.
        try {host.observe?.({...event,sequence:++eventSequence,runId:run.id,executionId:host.executionId});} catch { /* Observer failure cannot undo a saved result. */ }
    };
    const settle=async(status:Exclude<AgentRunStatus,'running'|'waiting_approval'>,error?:string,finishReason?:string)=>{
        const actual=await host.settle(run,status,output(),error,finishReason);
        emit({type:'settled',confirmed:true,status:actual});
    };
    const output=():AgentRunOutput=>({content:accum.content,reasoning:accum.reasoning,reasoningDurationMs:accum.reasoningDurationMs});
    const makeWriter=()=>createRunWriter(async(seq,next)=>{sequence=seq;host.ownership.assertHeld();if (await host.checkpoint(run,seq,next)) emit({type:'checkpoint',confirmed:true,checkpoint:seq,output:next});},()=>{saveFailed=true;controller.abort();},sequence);
    let writer=makeWriter();
    const offeredDefinitions = new Map<number,readonly ToolDefinition<unknown,Context,Preview,unknown>[]>();
    try {
        if (run.hasToolCalls && !await executePendingTools(run,controller,host,emit,offeredDefinitions)) return;
        while (true) {
            host.ownership.assertHeld();controller.signal.throwIfAborted();
            if (await host.pauseAtLimit(run)) {const paused=await host.readRun(run.id);if (paused) emit({type:'settled',confirmed:true,status:paused.status});return;}
            if (modelStepLimitReached(run)) throw new Error('本段模型请求额度已用完，请继续下一段执行');
            run=await host.admitPendingInput?.(run,controller.signal) ?? run;
            run=await host.prepareContext(run,controller.signal);
            run=await host.admitModelStep(run,MODEL_STEPS_PER_SEGMENT);
            controller.signal.throwIfAborted();
            accum=createReasoningAccum();writer=makeWriter();
            const offered=Object.freeze([...host.offeredNames(run)]);
            const definitions=snapshotToolDefinitions(host.tools.registry.filter(tool=>offered.includes(tool.name)));
            offeredDefinitions.set(run.modelStep!,definitions);
            const result=await host.request(run,controller.signal,delta=>{
                if (controller.signal.aborted) return;
                accum=accumulateStreamDelta(accum,delta,host.clock());writer.push(output());emit({type:'output',confirmed:false,output:output()});
            },definitions);
            accum=finalizeReasoningAccum(accum,host.clock());await writer.flush();
            if (result.metrics) await host.recordMetrics(run,{...result.metrics,step:run.modelStep!});
            if (controller.signal.aborted || !result.ok && result.aborted) {await settle(run.hasToolCalls ? 'interrupted' : 'cancelled','已停止，已收到的内容与完成的步骤保留。');return;}
            if (!result.ok) {await settle('failed',result.message,result.finishReason);return;}
            if (!result.toolCalls?.length) {
                if (await host.finishingCheck(run,output(),result.continuation,controller.signal)) continue;
                controller.signal.throwIfAborted();await settle('completed',undefined,result.finishReason);return;
            }
            if (result.toolCalls.length > 16 || new Set(result.toolCalls.map(call=>call.id)).size !== result.toolCalls.length) throw new Error('工具调用数量超过限制或标识重复');
            const details=result.toolCalls.map(call=>{
                const tool=definitions.find(item=>item.name === call.function.name);
                if (!tool || !offered.includes(call.function.name)) {
                    const cause=host.errors.unavailable(call.function.name,offered);
                    return {title:`不可用的工具 ${call.function.name.slice(0,60)}`,effect:'read' as const,highRisk:false,failure:{error:cause.message,result:JSON.stringify(host.errors.failure(cause,'not_started'))}};
                }
                let highRisk=tool.effect !== 'read';
                try {highRisk=tool.highRisk(tool.parseArguments(JSON.parse(call.function.arguments)));} catch { /* Invalid arguments are durably rejected before execution. */ }
                return {title:tool.title,effect:tool.effect,highRisk,...(tool.binding ? {binding:tool.binding} : {}),...(tool.atomic ? {atomic:true} : {}),...(tool.recovery ? {recovery:tool.recovery} : {}),...(tool.requiresConfirmation ? {requiresConfirmation:true} : {})};
            });
            await host.commitRound(run,result,details,output());
            emit({type:'tool_round',confirmed:true,step:run.modelStep!});
            run=(await host.readRun(run.id))!;
            controller.signal.throwIfAborted();
            if (!await executePendingTools(run,controller,host,emit,offeredDefinitions)) return;
        }
    } catch (cause) {
        await writer.flush().catch(()=>undefined);
        const aborted=controller.signal.aborted;controller.abort();
        // A deleted run has no durable target for cleanup or a confirmed settlement event.
        // Read failures remain failures; only a confirmed absence ends this invocation.
        if (!await host.readRun(run.id)) return;
        await host.tools.markUnknown(run,cause instanceof UnresolvedToolOutcomeError || host.errors.unknown(cause));
        const latest=await host.readRun(run.id);run=latest ?? run;
        await settle(saveFailed ? 'failed' : host.errors.pending(cause) || run.hasToolCalls && aborted ? 'interrupted' : aborted ? 'cancelled' : 'failed',saveFailed ? '执行或本地保存失败，最后一段内容可能尚未保存。' : aborted ? '已停止，已完成的步骤保留。' : host.errors.publicMessage(cause));
        if (saveFailed) throw new Error('执行或本地保存失败，最后一段内容可能尚未保存',{cause});
    }
}
