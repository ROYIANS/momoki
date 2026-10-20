import {appendFileSync,mkdirSync} from "node:fs";
import {join} from "node:path";
import {expect} from "vitest";
import {defineTool as originalDefineTool} from "../../../packages/studio/src/features/agent/runtime/toolDefinition?coverage-original";
import type {TypedToolDefinition,ToolBody} from "@/features/agent/runtime/toolDefinition";
import type {Spec} from "@/features/agent/runtime/businessSchemas";

export * from "../../../packages/studio/src/features/agent/runtime/toolDefinition?coverage-original";

function record(name:string,method:"parse"|"prepare"|"execute",outcome:"fulfilled"|"rejected") {
    const directory=process.env.MOMOKI_TOOL_COVERAGE_DIR;
    if (!directory) return;
    mkdirSync(directory,{recursive:true});
    appendFileSync(join(directory,`${process.pid}-${process.env.VITEST_POOL_ID ?? "worker"}.jsonl`),JSON.stringify({owner:process.env.MOMOKI_STORAGE_TEST_OWNER ?? "indexeddb",name,method,outcome,test:expect.getState().currentTestName ?? "unknown"})+"\n");
}

/** Test-only boundary instrumentation always invokes the current original recipe. */
export function defineTool<Args,const Name extends string>(spec:Spec<Args>,body:ToolBody<NoInfer<Args>,Name>):TypedToolDefinition<Args,Name> {
    const original=originalDefineTool(spec,body);
    const wrap=<R>(method:"prepare"|"execute",action:()=>Promise<R>):Promise<R>=>action().then(value=> {record(original.name,method,"fulfilled");return value;},error=> {record(original.name,method,"rejected");throw error;});
    return {...original,
        parseArguments:raw=> {try {const args=original.parseArguments(raw);record(original.name,"parse","fulfilled");return args;}catch(error) {record(original.name,"parse","rejected");throw error;}},
        ...(original.prepare ? {prepare:(args,context)=>wrap("prepare",()=>original.prepare!(args,context))} : {}),
        execute:(args,context)=>wrap("execute",()=>original.execute(args,context)),
    };
}
