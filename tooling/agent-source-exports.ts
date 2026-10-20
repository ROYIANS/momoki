import {fileURLToPath} from "node:url";

// Only explicitly selected source-validation profiles may use these mappings.
// Normal consumers retain the emitted exports and their freshness checks.
export function createAgentSourceAliases() {
    return [
        {find: /^@momoki\/agent-core$/, replacement: fileURLToPath(new URL("../packages/agent-core/src/index.ts", import.meta.url))},
        {find: /^@momoki\/agent-providers$/, replacement: fileURLToPath(new URL("../packages/agent-providers/src/index.ts", import.meta.url))},
        {find: /^@momoki\/agent-providers\/http$/, replacement: fileURLToPath(new URL("../packages/agent-providers/src/http/index.ts", import.meta.url))},
    ];
}
