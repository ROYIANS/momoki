import {injectSteerInputs} from "../commands/agentSteer";
import {prepareThreadActivityKey} from "../commands/threadActivity";
import {createMcpRunRegistry} from "../mcp/runtime/runRegistry";
import {createId} from '../../../platform/identity';
import {executeRun,toolMetadataMatches,type RuntimeHost,type RoundDetail} from '@momoki/agent-core';
import type {ProductStore,StoreTx,TableScope} from '../../../platform/storage/types';
import {StorageError} from '../../../platform/storage/errors';
import {getOfferedToolNames,refreshRunToolLoading,toolNamesForCall} from './toolLoading';
import {saveAgentFinishingCheck} from '../commands/agentFinishingCheck';
import {upgradeLegacyPlanCalls} from '../commands/agentToolRecovery';
import {budgetContext,runBudgetMeasure} from './contextPlanner';
import {createContextAnchor} from './contextMeasurement';
import {continuationExtraTokens,prepareRunContext} from './contextCompaction';
import {refreshRunMemoryContext} from '../../memory/agent/memoryContext';
import {refreshRunProjectContext} from './projectContext';
import {frozenProjectScope} from './projectScope';
import {toolFailureResult,ToolPendingError,ToolUnavailableError} from './toolErrors';
import {streamResponses,type ResponsesResult} from '../providers/responsesStream';
import {db as productDb} from '../../../platform/product/store';
import {appendToolResults,AtomicToolRollbackError,markRunningToolsUnknown,pauseAtModelStepLimit,pauseForApproval,resumeAgentRun,saveToolPreview,saveToolRound,startModelStep,transitionToolCall} from '../commands/agentTools';
import type {AgentRun,AgentToolCall,AgentToolPreview,AgentResponseItem} from '../models/agent';
import {type AgentToolContext,type AgentToolDefinition,BUILTIN_TOOLS,requiresToolApproval,toolSchemas,validateToolCall} from './tools';
import {checkpointAgentRun,finishAgentRun,recordAgentModelMetrics} from '../commands/agentRuns';
import {streamChatCompletions} from '../providers/chatStream';
import {withExecutionOwnership,withOwnedExecution,assertThreadOwnership,type ThreadOwnership} from './runOwnership';
import {createRunCredentials} from './runCredentials';
import {responseRoundMatches} from '@momoki/agent-providers';
import {runtimeFetchFor} from '../../../platform/runtime/runtimeFetch';
import type {RuntimeExecutionFeedback} from './executionFeedback';

/** Provider wording differs; only a confirmed context-length rejection may trigger the single overflow compaction. */
const CONTEXT_OVERFLOW=/context[_ ]length|maximum context|context window|prompt is too long|input is too long|too many tokens|exceeds? the (?:model'?s )?(?:max|limit)|上下文(?:长度)?(?:超|过长)/i;
export function isContextOverflow(message:string):boolean {return CONTEXT_OVERFLOW.test(message);}

/** Only user review may supply an execution override; wire arguments remain untouched. */
function effectiveToolInput(call:AgentToolCall) {
    if (!call.generationOverride) return {arguments:call.arguments,preview:call.preview};
    if (call.name !== 'submit_generation' || !call.requiresConfirmation || call.decision !== 'approve') throw new Error('工具覆盖参数没有有效的用户确认');
    return call.generationOverride;
}

/** Product integration owns transactions and predicates, while core owns every execution transition. */
function createStudioRuntimeHost(db:ProductStore,ownership:ThreadOwnership,apiKey:string,fetchImpl:typeof fetch|undefined,materialized:ReturnType<typeof createMcpRunRegistry>,signal:AbortSignal,run:AgentRun,feedback?:RuntimeExecutionFeedback):RuntimeHost<AgentRun,AgentToolCall,AgentToolContext,AgentToolPreview,AgentResponseItem[]> {
    const registry = materialized.definitions;
    assertThreadOwnership(ownership,ownership.threadId);
    const activity=prepareThreadActivityKey(run.threadId);
    const executionId=createId('exec');
    const observe:RuntimeExecutionFeedback=event=>{
        try {feedback?.(event);} catch { /* Optional feedback cannot affect execution or committed results. */ }
    };
    const feedbackIdentity={executionId,runId:run.id};
    observe({...feedbackIdentity,type:'started',threadId:run.threadId,assistantMessageId:run.assistantMessageId});
    // This must use the original explicit transport, not the observation wrapper below.
    const credentials=createRunCredentials(db,apiKey,!!fetchImpl);
    const scope:TableScope=[db.deviceSettings,db.projects,db.agentRuns,db.agentToolCalls,db.agentJobs,db.chatThreads,db.chatMessages,db.agentTasks,db.agentGenerationJobs,db.agentTaskRecords,db.agentTaskRecordVersions,db.agentGenerationBatches,db.agentGenerationBatchItems,db.agentPendingInputs];
    const guard=async<T>(run:AgentRun,operation:(tx:StoreTx)=>Promise<T>,tables:TableScope=scope):Promise<T>=>db.transaction('rw',tables,async tx=>{
        assertThreadOwnership(ownership,run.threadId);
        if (ownership.threadId !== run.threadId) throw new Error('执行锁与对话归属不匹配');
        const current=await tx.agentRuns.get(run.id);
        const message=current ? await tx.chatMessages.get(current.assistantMessageId) : undefined;
        if (!current || current.threadId !== run.threadId || current.assistantMessageId !== run.assistantMessageId || !message || message.runId !== run.id || message.threadId !== run.threadId) throw new Error('执行消息归属不匹配');
        if (current.status === 'running' && current.modelStep !== run.modelStep) throw new Error('执行步骤已经变化');
        const value=await operation(tx);
        ownership.assertHeld();
        return value;
    });
    const host:RuntimeHost<AgentRun,AgentToolCall,AgentToolContext,AgentToolPreview,AgentResponseItem[]>={
        executionId,ownership,clock:()=>Date.now(),observe:feedback ? observe : undefined,
        readRun:id=>{ownership.assertHeld();return db.agentRuns.get(id);},
        readOutput:async run=>{
            ownership.assertHeld();
            const output=await db.chatMessages.get(run.assistantMessageId);
            if (output) observe({...feedbackIdentity,type:'baseline',output});
            return output;
        },
        checkpoint:(run,seq,output)=>guard(run,tx=>checkpointAgentRun(run.id,seq,output,tx,activity),[db.agentRuns,db.chatMessages,db.chatThreads,db.deviceSettings]),
        pauseAtLimit:run=>guard(run,tx=>pauseAtModelStepLimit(run.id,tx,activity)),
        admitPendingInput:run=>guard(run,tx=>injectSteerInputs(run.id,tx)),
        async prepareContext(run,signal) {
            ownership.assertHeld();
            observe({...feedbackIdentity,type:'preparing'});
            run=await refreshRunToolLoading(run.id,db);
            run=await refreshRunProjectContext(run.id,db);
            run=await refreshRunMemoryContext(run.id,db);
            run=await prepareRunContext(run.id,toolSchemas(getOfferedToolNames(run),registry),apiKey,signal,fetchImpl,db,run=>credentials.resolve(run),cause=>credentials.message(cause));
            run=await refreshRunMemoryContext(run.id,db);
            if (budgetContext(run.continuationMessages ?? run.requestMessages,toolSchemas(getOfferedToolNames(run),registry),run.context?.capacity,!!run.context?.summaryId,continuationExtraTokens(run),runBudgetMeasure(run)).overBudget) throw new Error('记忆更新后上下文超出安全预算，请减少历史或调整输入后继续');
            return run;
        },
        admitModelStep:(run,limit)=>guard(run,tx=>startModelStep(run.id,limit,tx,registry.map(tool=>tool.name))),
        async request(run,signal,onDelta,offeredDefinitions) {
            ownership.assertHeld();
            let delivered=false;
            const dispatch=async(current:AgentRun):Promise<ResponsesResult>=>{
                const currentKey=await credentials.resolve(current);
                signal.throwIfAborted();
                const transport=current.protocol === 'responses' ? streamResponses : streamChatCompletions;
                const selectedFetch=fetchImpl ?? runtimeFetchFor();
                const observedFetch:typeof fetch=(input,init)=>{
                    observe({...feedbackIdentity,type:'requestInvoked'});
                    return selectedFetch(input,init);
                };
                return transport({projectId:current.projectId,runId:current.id,visionCapability:current.visionCapability,responseItems:current.responseItems,baseUrl:current.connector.baseUrl,apiKey:currentKey,model:current.model,connectorDefinitionId:current.connector.definitionId,reasoningEffort:current.reasoningEffort,messages:current.continuationMessages ?? current.requestMessages,tools:offeredDefinitions.map(tool=>({type:"function",function:{name:tool.name,description:tool.description,parameters:tool.parameters}}))},{signal,fetchImpl:feedback ? observedFetch : fetchImpl,onDelta:content=>{
                    if (content && !signal.aborted) {delivered=true;observe({...feedbackIdentity,type:'publicReceived',kind:'content'});}
                    onDelta({content});
                },onReasoning:reasoning=>{
                    if (reasoning && !signal.aborted) {delivered=true;observe({...feedbackIdentity,type:'publicReceived',kind:'reasoning'});}
                    onDelta({reasoning});
                }});
            };
            let result=await dispatch(run);
            // A confirmed provider overflow compacts once and repeats the same step; nothing was delivered yet.
            if (!result.ok && !result.aborted && !signal.aborted && !delivered && isContextOverflow(result.message)) {
                const before=JSON.stringify(run.continuationMessages ?? run.requestMessages);
                const reduced=await prepareRunContext(run.id,toolSchemas(getOfferedToolNames(run),registry),apiKey,signal,fetchImpl,db,current=>credentials.resolve(current),cause=>credentials.message(cause),{force:true}).catch(()=>undefined);
                if (reduced && JSON.stringify(reduced.continuationMessages ?? reduced.requestMessages) !== before) result=await dispatch(reduced);
            }
            return result.ok ? {...result,continuation:result.responseOutput} : result;
        },
        recordMetrics:async(run,metrics)=>{
            // Pair the provider's prompt size with our estimate of the request actually sent (an overflow retry may have compacted it).
            const sent=await db.agentRuns.get(run.id) ?? run;
            const anchor=createContextAnchor({step:metrics.step,model:sent.model,definitionId:sent.connector.definitionId,protocol:sent.protocol ?? 'chat-completions',summaryId:sent.context?.summaryId,reportedTokens:metrics.usage?.inputTokens,messages:sent.continuationMessages ?? sent.requestMessages,tools:toolSchemas(getOfferedToolNames(sent),registry),extraTokens:continuationExtraTokens(sent)});
            return guard(run,tx=>recordAgentModelMetrics(run.id,metrics,tx,anchor),[db.agentRuns,db.chatMessages]);
        },
        finishingCheck:(run,output,continuation,signal)=>{ownership.assertHeld();return saveAgentFinishingCheck(run.id,run.modelStep!,output,continuation,signal,db);},
        commitRound:(run,result,details,output)=>guard(run,tx=>saveToolRound(run.id,result.content,result.toolCalls!,details.map(detail=>({...detail,recovery:productRecovery(detail)})),result.continuation,output,tx,activity)),
        offeredNames:(run,step)=>step === undefined ? getOfferedToolNames(run) : toolNamesForCall(run,step),
        settle:(run,status,output,error,reason)=>guard(run,async tx=>{await finishAgentRun(run.id,status,output,error,reason,tx,activity);return (await tx.agentRuns.get(run.id))!.status;},[db.agentRuns,db.chatMessages,db.chatThreads,db.deviceSettings,db.agentPendingInputs]),
        tools:{
            registry,
            readRound:run=>{
                observe({...feedbackIdentity,type:'working'});
                return guard(run,async tx=>{await upgradeLegacyPlanCalls(run.id,tx);return tx.agentToolCalls.where('runId').equals(run.id).toArray();});
            },
            validateEnvelope(run,calls) {
                if (run.protocol !== 'responses') return;
                if (!responseRoundMatches(run.responseItems,calls.map(call=>({id:call.providerCallId,type:'function',function:{name:call.name,arguments:call.arguments}})),false)) throw new Error('Responses 调用信封与执行记录不匹配，已阻止继续执行');
            },
            readCall:(_run,id)=>{ownership.assertHeld();return db.agentToolCalls.get(id);},
            async assertScope(run,call,signal) {
                await frozenProjectScope({runId:run.id,threadId:run.threadId,callId:call.id,signal,projectId:run.projectId},db);
                await materialized.assertBinding(call.binding);
            },
            assertBinding:binding=>materialized.assertBinding(binding),
            input:effectiveToolInput,
            validate:(name,raw,offered)=>validateToolCall(name,raw,offered,registry),
            context:(run,call,signal,preview)=>({projectId:run.projectId,runId:run.id,threadId:run.threadId,callId:call.id,signal,preview,store:db}),
            approval:requiresToolApproval,
            preview:(run,call,preview)=>guard(run,tx=>saveToolPreview(run.id,call.id,preview,tx)),
            transition:(run,call,from,to,extra)=>to !== 'running' ? guard(run,tx=>transitionToolCall(run.id,call.id,from,to,extra,tx,undefined,activity)) : transitionToolCall(run.id,call.id,from,to,extra,db,async(current,saved,tx)=>{
                assertThreadOwnership(ownership,current.threadId);
                if (current.id !== run.id || current.modelStep !== run.modelStep || current.assistantMessageId !== run.assistantMessageId || claimFingerprint(saved) !== claimFingerprint(call)) throw new Error('工具调用或审批在领取前已经变化');
                const {tool,args}=validateToolCall(saved.name,effectiveToolInput(saved).arguments,toolNamesForCall(current,saved.step),registry);
                if (!toolMetadataMatches(tool,args,saved) || requiresToolApproval(current.permissionMode ?? 'ask',tool,args) && saved.status !== 'approved') throw new Error('工具定义、权限或审批在领取前已经变化');
                await frozenProjectScope({runId:current.id,threadId:current.threadId,callId:saved.id,signal,projectId:current.projectId},tx);
                await materialized.assertBinding(saved.binding,tx);
            }),
            park:run=>guard(run,tx=>pauseForApproval(run.id,tx,activity)),
            appendResults:run=>guard(run,tx=>appendToolResults(run.id,tx)),
            markUnknown:(run,force)=>guard(run,tx=>markRunningToolsUnknown(run.id,tx,force,activity))
        },
        errors:{failure:toolFailureResult,unavailable:(name,offered)=>new ToolUnavailableError(name,offered),pending:cause=>cause instanceof ToolPendingError,pendingError:()=>new ToolPendingError('生成任务已保存，请继续查询已有任务。'),rolledBack:cause=>cause instanceof AtomicToolRollbackError,unknown:cause=>cause instanceof StorageError && cause.certainty === 'unknown',publicMessage:cause=>credentials.message(cause)}
    };
    return host;
}
function claimFingerprint(call:AgentToolCall):string {
    return JSON.stringify({runId:call.runId,threadId:call.threadId,providerCallId:call.providerCallId,name:call.name,arguments:call.arguments,step:call.step,order:call.order,title:call.title,status:call.status,effect:call.effect,highRisk:call.highRisk,atomic:call.atomic,requiresConfirmation:call.requiresConfirmation,binding:call.binding ? {capabilityId:call.binding.capabilityId,version:call.binding.version,registrationId:call.binding.registrationId} : undefined,recovery:call.recovery,decision:call.decision,preview:call.preview,generationOverride:call.generationOverride});
}
function productRecovery(detail:RoundDetail):AgentToolCall['recovery'] {
    if (detail.recovery === undefined || detail.recovery === 'generation' || detail.recovery === 'repeatable') return detail.recovery;
    throw new Error('未知工具恢复策略');
}

/** Direct typed consumers acquire the same execution lock without recovering their own new run. */
export async function executeChatRun(run:AgentRun,apiKey:string,controller:AbortController,fetchImpl?:typeof fetch,registry:readonly AgentToolDefinition[]=BUILTIN_TOOLS,store:ProductStore=productDb,ownership?:ThreadOwnership,feedback?:RuntimeExecutionFeedback):Promise<void> {
    const execute=(held:ThreadOwnership)=>withOwnedExecution(held,run.threadId,()=>executeRun(run,controller,createStudioRuntimeHost(store,held,apiKey,fetchImpl,createMcpRunRegistry(run.mcpSnapshot,registry,store),controller.signal,run,feedback)));
    if (ownership) await execute(ownership);else await withExecutionOwnership(run.threadId,execute);
}
export async function resumeChatRun(runId:string,apiKey:string,controller:AbortController,fetchImpl?:typeof fetch,registry:readonly AgentToolDefinition[]=BUILTIN_TOOLS,store:ProductStore=productDb,ownership?:ThreadOwnership,feedback?:RuntimeExecutionFeedback):Promise<void> {
    const saved=await store.agentRuns.get(runId);
    if (!saved) throw new Error('执行已删除');
    const execute=(held:ThreadOwnership)=>withOwnedExecution(held,saved.threadId,async()=>{
        controller.signal.throwIfAborted();
        const run=await resumeAgentRun(runId,store);
        await executeRun(run,controller,createStudioRuntimeHost(store,held,apiKey,fetchImpl,createMcpRunRegistry(run.mcpSnapshot,registry,store),controller.signal,run,feedback));
    });
    if (ownership) await execute(ownership);else await withExecutionOwnership(saved.threadId,execute);
}
