import {registeredTools} from "./helpers/registeredTools";
import { preloadFixtureGroups } from "./helpers/toolDispatch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/platform/product/store";
import { beginAgentRun } from "@/features/agent/commands/agentRuns";
import { saveGenerationPreference } from "@/features/settings/commands/generationPreferences";
import { defaultImageGeneration } from "@/features/video/models/output";
import { updateGeneralAgentConfig } from "@/features/agent/commands/agentSettings";
import { resolveAgentToolApproval } from "@/features/agent/commands/agentTools";
import {addShot, patchShot} from "@/features/video/commands/shots";
import {createChatThread} from "@/features/agent/commands/chat";
import {createProject} from "@/features/projects/commands/projects";
import type { AgentPermissionMode } from "@/features/agent/models/agent";
import type {ConnectorConfig} from "@/features/settings/models/connector";
import { reviewAndApproveGeneration } from "@/features/video/agent/generationReview";
import { executeChatRun, resumeChatRun } from "@/features/agent/runtime/runChat";
import { GENERATION_TOOLS as GENERATION_TOOLS_DEFINITIONS } from "@/features/video/agent/generationTools";
import type { GenerationSubmitArgs } from "@/features/video/agent/generationProfiles";
import { BUILTIN_TOOLS } from "@/features/agent/runtime/tools";
const GENERATION_TOOLS = registeredTools(GENERATION_TOOLS_DEFINITIONS);


const connector:ConnectorConfig={id:"chat",name:"Chat",definitionId:"openai-compatible",baseUrl:"https://chat.test/v1",apiKey:"chat-secret",updatedAt:"now"};
const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII=";
afterEach(()=>vi.unstubAllGlobals());
async function pending(mode:AgentPermissionMode="full",protocol:"chat-completions"|"responses"="chat-completions",video=false) {
  await updateGeneralAgentConfig({permissionMode:mode,enabledSkillIds:["media-generation"]});
  await db.connectors.bulkPut([connector,{...connector,id:"apimart",definitionId:"apimart",baseUrl:"https://apimart.test/v1"},{...connector,id:"hub",definitionId:"aihubmix",baseUrl:"https://hub.test/v1"}]);
  const project=await createProject("确认测试");const episode=(await db.episodes.where("projectId").equals(project.id).first())!;const shot=await addShot(project.id,episode.id);
  const thread=await createChatThread();const run = await preloadFixtureGroups(await beginAgentRun({threadId:thread.id,connector,model:protocol==="responses"?"gpt-5.6-luna":"chat",content:"生成图片"}), ["media-generation"]);
  const args:GenerationSubmitArgs={connectorId:"apimart",model:video?"MiniMax-H3":"gpt-image-2",target:{kind:"shot",projectId:project.id,episodeId:episode.id,entityId:shot.id,slot:video?"clip":"firstFrame"},prompt:"AI 原始提示",parameters:video?{duration:5,resolution:"768P"}:{size:"16:9"},inputs:[]};
  const original=JSON.stringify(args);
  const functionCall={type:"function_call",id:"fc1",call_id:"call1",name:"submit_generation",arguments:original,status:"completed"};
  const fetcher=vi.fn<typeof fetch>(async()=>Response.json(protocol==="responses"?{id:"r1",status:"completed",output:[{type:"reasoning",id:"reason1",summary:[],encrypted_content:"sealed-state"},functionCall]}:{choices:[{message:{content:"",tool_calls:[{id:"call1",type:"function",function:{name:"submit_generation",arguments:original}}]},finish_reason:"tool_calls"}]}));
  await executeChatRun(run,connector.apiKey,new AbortController(),fetcher);
  const call=(await db.agentToolCalls.where("runId").equals(run.id).first())!;
  expect(call.status).toBe("awaiting_approval");expect(call.requiresConfirmation).toBe(true);
  const edited={...args,connectorId:"hub",prompt:"用户修改的提示",parameters:{size:"1536x1024",quality:"high" as const}};
  return {run,call,args,edited,original,shot,thread,expected:{arguments:call.arguments,revision:call.preview!.revision!}};
}
function paidFixture(){return vi.fn<typeof fetch>(async(url,init)=>{
  expect(String(url)).toBe("https://hub.test/ai/v1/images/generations");expect(init?.method).toBe("POST");
  return Response.json({id:"paid-1",object:"image",model:"gpt-image-2",status:"completed",output:[{index:0,type:"file",b64_json:png}]});
});}
const answer=(responses=false)=>Response.json(responses?{id:"r2",status:"completed",output:[{type:"message",id:"m2",role:"assistant",status:"completed",content:[{type:"output_text",text:"已下载",annotations:[]}]}]}:{choices:[{message:{content:"已下载"},finish_reason:"stop"}]});

describe("reviewed generation submission",()=>{
  it.each(["ask","assist","full"] as const)("%s always parks paid generation before network access",async(mode)=>{
    const paid=paidFixture();vi.stubGlobal("fetch",paid);await pending(mode);expect(paid).not.toHaveBeenCalled();expect(await db.agentGenerationJobs.count()).toBe(0);
  });
  it.each(["chat-completions","responses"] as const)("%s retains original envelopes while executing and reporting reviewed parameters once",async(protocol)=>{
    const paid=paidFixture();vi.stubGlobal("fetch",paid);const f=await pending("full",protocol);
    const before=(await db.agentRuns.get(f.run.id))!;
    await reviewAndApproveGeneration(f.run.id,f.call.id,f.edited,f.expected);
    expect(paid).not.toHaveBeenCalled();expect(await db.agentGenerationJobs.count()).toBe(0);
    const approved=(await db.agentToolCalls.get(f.call.id))!;
    expect(approved).toMatchObject({arguments:f.original,preview:f.call.preview,status:"approved",decision:"approve"});
    expect(JSON.parse(approved.generationOverride!.arguments)).toEqual(f.edited);
    expect((await db.agentRuns.get(f.run.id))!.responseItems).toEqual(before.responseItems);
    const next=vi.fn<typeof fetch>(async(_url,init)=>{
      const body=JSON.parse(String(init?.body));
      if(protocol==="responses") {
        expect(body.input.find((item:{type:string})=>item.type==="function_call").arguments).toBe(f.original);
        expect(body.input.find((item:{type:string})=>item.type==="reasoning").encrypted_content).toBe("sealed-state");
        expect(JSON.parse(body.input.find((item:{type:string})=>item.type==="function_call_output").output)).toMatchObject({provider:"aihubmix",model:"gpt-image-2",parameters:{prompt:f.edited.prompt,size:"1536x1024"}});
      } else {
        expect(body.messages.find((item:{tool_calls?:unknown})=>item.tool_calls).tool_calls[0].function.arguments).toBe(f.original);
        expect(JSON.parse(body.messages.find((item:{role:string})=>item.role==="tool").content)).toMatchObject({provider:"aihubmix",model:"gpt-image-2",parameters:{prompt:f.edited.prompt,size:"1536x1024"}});
      }
      return answer(protocol==="responses");
    });
    await resumeChatRun(f.run.id,connector.apiKey,new AbortController(),next);
    expect(await db.agentRuns.get(f.run.id)).toMatchObject({status:"completed",error:undefined});
    expect(paid).toHaveBeenCalledTimes(1);expect(next).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(paid.mock.calls[0][1]?.body))).toMatchObject({prompt:f.edited.prompt,size:"1536x1024",extra:{quality:"high"}});
    expect((await db.agentToolCalls.get(f.call.id))?.arguments).toBe(f.original);
    await expect(resumeChatRun(f.run.id,connector.apiKey,new AbortController(),next)).rejects.toThrow();expect(paid).toHaveBeenCalledTimes(1);
  });
  it("allows video provider/model changes with validated native parameters",async()=>{
    const f=await pending("full","chat-completions",true);
    const edited={...f.args,connectorId:"hub",model:"veo-3.1-fast-generate-preview",parameters:{duration:8,resolution:"1080p",aspectRatio:"9:16"}};
    await reviewAndApproveGeneration(f.run.id,f.call.id,edited,f.expected);
    const paid=vi.fn<typeof fetch>(async(url,init)=>{
      if(init?.method==="POST") return Response.json({id:"video1",object:"video",model:edited.model,status:"completed",output:[{index:0,type:"file",content_url:"https://hub.test/ai/v1/videos/video1/content"}]});
      expect(String(url)).toBe("https://hub.test/ai/v1/videos/video1/content");
      return new Response(new Uint8Array([0,0,0,20,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109]),{headers:{"content-type":"video/mp4"}});
    });vi.stubGlobal("fetch",paid);
    await resumeChatRun(f.run.id,connector.apiKey,new AbortController(),vi.fn(async()=>answer()));
    expect(await db.agentRuns.get(f.run.id)).toMatchObject({status:"completed"});
    expect(paid.mock.calls.filter(([,init])=>init?.method==="POST")).toHaveLength(1);
    expect(JSON.parse((await db.agentToolCalls.get(f.call.id))!.result!)).toMatchObject({provider:"aihubmix",model:edited.model,parameters:{duration:8,resolution:"1080p",aspect_ratio:"9:16"},result:{kind:"video"}});
  });
  it("rejects target/input changes, injected fields, incompatible parameters and stale CAS",async()=>{
    const f=await pending();
    for(const invalid of [{...f.edited,target:{...f.args.target,slot:"lastFrame"}},{...f.edited,inputs:[{mediaId:"foreign",role:"reference-image"}]},{...f.edited,approved:true},{...f.edited,parameters:{duration:10}}]) await expect(reviewAndApproveGeneration(f.run.id,f.call.id,invalid,f.expected)).rejects.toThrow();
    for(const expected of [{...f.expected,arguments:"{}"},{...f.expected,revision:"old"}]) await expect(reviewAndApproveGeneration(f.run.id,f.call.id,f.edited,expected)).rejects.toThrow("预览");
    expect((await db.agentToolCalls.get(f.call.id))?.status).toBe("awaiting_approval");
  });
  it("rejects edited targets both before review and after approval, without a POST",async()=>{
    const paid=paidFixture();vi.stubGlobal("fetch",paid);const f=await pending();
    await patchShot(f.shot.id,{notes:"改变目标"});
    await expect(reviewAndApproveGeneration(f.run.id,f.call.id,f.edited,f.expected)).rejects.toThrow("已变化");
    expect(paid).not.toHaveBeenCalled();
  });
  it("checks the reviewed fingerprint again immediately before submission",async()=>{
    const paid=paidFixture();vi.stubGlobal("fetch",paid);const f=await pending();
    await reviewAndApproveGeneration(f.run.id,f.call.id,f.edited,f.expected);await patchShot(f.shot.id,{notes:"确认后改动"});
    await resumeChatRun(f.run.id,connector.apiKey,new AbortController(),vi.fn(async()=>answer()));
    expect(paid).not.toHaveBeenCalled();expect(await db.agentGenerationJobs.count()).toBe(0);
    expect((await db.agentToolCalls.get(f.call.id))?.status).toBe("failed");
  });
  it("serializes competing confirmations and keeps only the winning reviewed request",async()=>{
    const f=await pending();const results=await Promise.allSettled([reviewAndApproveGeneration(f.run.id,f.call.id,f.edited,f.expected),reviewAndApproveGeneration(f.run.id,f.call.id,{...f.edited,prompt:"另一页面"},f.expected)]);
    expect(results.filter((item)=>item.status==="fulfilled")).toHaveLength(1);expect(results.filter((item)=>item.status==="rejected")).toHaveLength(1);
    expect((await db.agentToolCalls.get(f.call.id))?.status).toBe("approved");
  });
  it("rejects foreign ownership, completed decisions and preexisting job records",async()=>{
    const f=await pending();await expect(reviewAndApproveGeneration("foreign",f.call.id,f.edited,f.expected)).rejects.toThrow();
    await db.agentGenerationJobs.put({id:"existing",callId:f.call.id} as never);
    await expect(reviewAndApproveGeneration(f.run.id,f.call.id,f.edited,f.expected)).rejects.toThrow("已有任务");await db.agentGenerationJobs.delete("existing");
    await resolveAgentToolApproval(f.run.id,f.call.id,"reject");await expect(reviewAndApproveGeneration(f.run.id,f.call.id,f.edited,f.expected)).rejects.toThrow("已处理");
    expect((await db.agentToolCalls.get(f.call.id))?.generationOverride).toBeUndefined();
  });
  it("rejects foreign thread ownership and superseded executions",async()=>{
    const f=await pending();
    await db.agentToolCalls.update(f.call.id,{threadId:"foreign"});
    await expect(reviewAndApproveGeneration(f.run.id,f.call.id,f.edited,f.expected)).rejects.toThrow("归属");
    await db.agentToolCalls.update(f.call.id,{threadId:f.thread.id});
    await db.chatMessages.add({id:"newer-user",threadId:f.thread.id,role:"user",content:"next",createdAt:"9999-01-01T00:00:00.000Z"});
    await expect(reviewAndApproveGeneration(f.run.id,f.call.id,f.edited,f.expected)).rejects.toThrow("最后一次");
  });
  it("discovers independent global/project recommendations without exposing credentials or changing the AI draft",async()=>{
    const f=await pending();
    await saveGenerationPreference("image",{connectorId:"hub",model:"gpt-image-2",parameters:{quality:"high"}});
    const tool=GENERATION_TOOLS.find((item)=>item.name==="generation_capabilities")!;
    const context={runId:f.run.id,threadId:f.thread.id,callId:f.call.id,signal:new AbortController().signal};
    const global=await tool.execute(tool.parseArguments({}),context);
    expect(global).toMatchObject({recommendations:{image:{source:"global",status:"ready",recommendation:{connectorId:"hub"}}}});
    await db.projects.update(f.args.target.projectId,{generationDefaults:{image:defaultImageGeneration("9:16")}});
    const scoped=await tool.execute(tool.parseArguments({projectId:f.args.target.projectId}),context);
    expect(scoped).toMatchObject({recommendations:{image:{source:"project",status:"ready",recommendation:{connectorId:"apimart",parameters:{size:"9:16"}}}}});
    expect(JSON.stringify(scoped)).not.toContain("chat-secret");
    expect((await db.agentToolCalls.get(f.call.id))?.arguments).toBe(f.original);
    await expect(tool.execute(tool.parseArguments({projectId:"missing"}),context)).rejects.toThrow("不存在");
  });
  it("tells the agent which media the previous shot ended on, and says so when there is none",async()=>{
    const f=await pending();
    const target=f.args.target as {projectId:string;episodeId:string;entityId:string};
    const tool=GENERATION_TOOLS.find((item)=>item.name==="generation_capabilities")!;
    const context={runId:f.run.id,threadId:f.thread.id,callId:f.call.id,signal:new AbortController().signal};
    const second=await addShot(target.projectId,target.episodeId);
    const first=(await db.shots.get(target.entityId))!;
    expect(first.order).toBeLessThan(second.order);
    const empty=await tool.execute(tool.parseArguments({projectId:target.projectId,shotId:second.id}),context) as {continuity:{previousShot:{id:string;lastFrameMediaId:string|null}}};
    expect(empty.continuity.previousShot).toMatchObject({id:first.id,lastFrameMediaId:null});
    const slot={referenceImageIds:[],referenceVideoIds:[],prompt:"",result:{mediaId:"media-tail",kind:"image"}};
    await db.shots.update(first.id,{lastFrame:slot} as never);
    const filled=await tool.execute(tool.parseArguments({projectId:target.projectId,shotId:second.id}),context) as {continuity:{previousShot:{lastFrameMediaId:string|null}}};
    expect(filled.continuity.previousShot.lastFrameMediaId).toBe("media-tail");
    const head=await tool.execute(tool.parseArguments({projectId:target.projectId,shotId:first.id}),context) as {continuity:{previousShot:unknown}};
    expect(head.continuity.previousShot).toBeNull();
  });
  it("blocks stale permission snapshots instead of bypassing confirmation",async()=>{
    const paid=paidFixture();vi.stubGlobal("fetch",paid);
    const f=await pending();await db.agentToolCalls.update(f.call.id,{requiresConfirmation:undefined});
    await expect(reviewAndApproveGeneration(f.run.id,f.call.id,f.edited,f.expected)).rejects.toThrow();
    await resolveAgentToolApproval(f.run.id,f.call.id,"approve");
    const execute=vi.fn();const registry=BUILTIN_TOOLS.map((tool)=>tool.name==="submit_generation"?{...tool,execute}:tool);
    const fetcher=vi.fn<typeof fetch>(async(_url,init)=>{
      const failed=(await db.agentToolCalls.get(f.call.id))!;
      expect(failed).toMatchObject({status:"failed",decision:"approve",arguments:f.original,error:expect.stringContaining("定义已变化")});
      expect(JSON.parse(String(init?.body)).messages).toContainEqual({role:"tool",tool_call_id:f.call.providerCallId,content:failed.result});
      return answer();
    });
    await resumeChatRun(f.run.id,connector.apiKey,new AbortController(),fetcher,registry);
    expect(execute).not.toHaveBeenCalled();expect(paid).not.toHaveBeenCalled();expect(await db.agentGenerationJobs.count()).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);expect(await db.agentRuns.get(f.run.id)).toMatchObject({status:"completed",error:undefined});
  });
});
