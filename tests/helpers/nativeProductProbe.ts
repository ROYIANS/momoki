import {spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createInterface} from "node:readline";
import {createNativeStoreBridge} from "@/platform/storage/nativeBridge";
import {createNativeProductStore} from "@/platform/storage/native";
import {createNativeBinaryServices} from "@/platform/storage/nativeBinary";
import type {NativeSession} from "@/platform/storage/protocol";
import type {NativeInvoke} from "@/platform/storage/nativeBridge";

if (process.env.MOMOKI_TOOL_MODE === "hosted" && !process.env.MOMOKI_NATIVE_STORE_PROBE) throw new Error("Hosted native suites require the runner-resolved probe path");
export const nativeProbePath=resolve(process.env.MOMOKI_NATIVE_STORE_PROBE ?? "apps/desktop/.tools/target/debug/product_store_probe");

export async function createNativeProbe(options:{intercept?:(command:string,args:Record<string,unknown>,next:()=>Promise<unknown>)=>Promise<unknown>} = {}) {
    const temporary=await mkdtemp(join(tmpdir(),"momoki-shared-contract-")),root=join(temporary,"fresh-workspace");
    let processHandle:ChildProcessWithoutNullStreams,stderr="";
    let pending:Array<{resolve:(value:unknown)=>void;reject:(error:unknown)=>void}>=[];
    let ready:Promise<void>;
    const acceptedScopes=new Map<string,{mode:"r"|"rw";tables:string[]}>();
    const launch=(mode:"create"|"open")=> {
        processHandle=spawn(nativeProbePath,[mode,root],{stdio:"pipe"});
        stderr="";processHandle.stderr.on("data",chunk=>stderr+=chunk.toString());
        ready=new Promise((resolveReady,rejectReady)=> {
            let first=true;
            const lines=createInterface({input:processHandle.stdout});
            lines.on("line",line=> {
                const result=JSON.parse(line) as {ok:boolean;ready?:boolean;value?:unknown;error?:unknown};
                if (first) {first=false;if (result.ok && result.ready) resolveReady();else rejectReady(result);return;}
                const next=pending.shift();
                if (!next) throw new Error("Probe returned unsolicited reply");
                if (result.ok) next.resolve(result.value);else next.reject(result.error);
            });
            processHandle.on("error",rejectReady);
            processHandle.on("exit",code=> {
                if (first) rejectReady(new Error(`Probe exited before ready: ${code} ${stderr}`));
                for (const next of pending) next.reject(new Error(`Probe terminated: ${code} ${stderr}`));
                pending=[];lines.close();
            });
        });
    };
    launch("create");await ready!;
    const request=(input:unknown):Promise<unknown>=>new Promise((resolveReply,rejectReply)=> {
        if (processHandle.exitCode !== null || processHandle.stdin.writableEnded || processHandle.stdin.destroyed) {rejectReply(new Error("Probe request targeted a closed process"));return;}
        pending.push({resolve:resolveReply,reject:rejectReply});
        processHandle.stdin.write(JSON.stringify(input)+"\n");
    });
    const invoke:NativeInvoke=async (command,args)=> {
        if (command !== "product_store_request") throw new Error("Unexpected probe command");
        const next=async ()=> {
            const result=await request({type:"store",request:args.request});
            const envelope=args.request as {type:string;request:{operationId:string;mode:"r"|"rw";tables:string[]}};
            if (envelope.type === "begin") acceptedScopes.set(envelope.request.operationId,{mode:envelope.request.mode,tables:[...envelope.request.tables]});
            return result;
        };
        return options.intercept ? options.intercept(command,args,next) : next();
    };
    const construct=()=> {
        const bridge=createNativeStoreBridge(invoke);
        const binaries=createNativeBinaryServices({
            getSession:()=>driver.getSession(),
            request:(session,action)=>request({type:"binary",request:{session,action}}),
            // Fixture-only JSON-line process bridge adapts actual Rust bounded bytes.
            // Production Tauri transport continues to return raw ArrayBuffer bodies.
            read:async (session, action)=> {
                const reply=await request({type:"binary",request:{session,action}}) as {type:string;bytes:unknown;offset:number};
                if (reply.type !== "bytes" || reply.offset !== action.offset || !Array.isArray(reply.bytes)
                    || reply.bytes.length > 262144 || reply.bytes.some(value=>!Number.isInteger(value) || value < 0 || value > 255)) throw new Error("Probe binary reply is not a bounded native byte range");
                return Uint8Array.from(reply.bytes).buffer;
            },
        });
        const {store,driver}=createNativeProductStore(bridge,binaries);
        return {store,driver,bridge,binaries};
    };
    let current=construct();
    return {
        get store() {return current.store;},
        get driver() {return current.driver;},
        get bridge() {return current.bridge;},
        get binaries() {return current.binaries;},
        root,
        acceptedScopes,
        request,
        async reopen() {await request({type:"close"});processHandle.stdin.end();await new Promise(resolveExit=>processHandle.once("exit",resolveExit));launch("open");await ready;current=construct();},
        async close() {if (processHandle.exitCode === null) {await request({type:"close"});processHandle.stdin.end();await new Promise(resolveExit=>processHandle.once("exit",resolveExit));}await rm(temporary,{recursive:true,force:true});},
        async binaryRequest(session:NativeSession,action:unknown) {return request({type:"binary",request:{session,action}});},
    };
}
