import type {ProductStore} from '../../../platform/storage/types';
import {redactCredentials} from "@momoki/agent-providers/http";
import {resolveConnector} from '../../settings/commands/connectors';
import {assertRetryConnector} from '../commands/agentRuns';
import type {AgentRun} from '../models/agent';

/** Credentials are read at each actual main/auxiliary dispatch, never stored in a run. */
export function createRunCredentials(store:ProductStore,injectedKey:string,hasInjectedTransport:boolean) {
    const seen=new Set<string>([injectedKey]);
    return {
        async resolve(run:AgentRun):Promise<string> {
            const connector=await resolveConnector(run.connector.id,store);
            // The existing explicitly injected transport can run fixtures without a saved connector.
            // Production dispatch always requires a currently saved identity and key.
            if (!connector) {
                if (hasInjectedTransport) return injectedKey;
                throw new Error('原连接不存在，请恢复连接配置后继续');
            }
            assertRetryConnector(run,connector);
            if (!connector.apiKey.trim()) throw new Error('原连接缺少密钥');
            seen.add(connector.apiKey);
            return connector.apiKey;
        },
        message(cause:unknown):string {
            let message=cause instanceof Error ? cause.message : '执行或本地保存失败';
            for (const key of seen) message=redactCredentials(message,key);
            return message.slice(0,300);
        }
    };
}
