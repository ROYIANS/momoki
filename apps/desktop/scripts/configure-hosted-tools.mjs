import {access,appendFile,realpath} from 'node:fs/promises';
import {delimiter,join,resolve} from 'node:path';
import {TOOL_VERSIONS} from './tool-resolver.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP || !process.env.GITHUB_ENV) throw new Error('Hosted tool configuration runs only inside Actions');
if (process.version !== `v${TOOL_VERSIONS.node}`) throw new Error('Wrong hosted Node version');
const lines=['MOMOKI_TOOL_MODE=hosted',`CARGO_TARGET_DIR=${resolve(process.env.RUNNER_TEMP,'momoki-cargo-target')}`];
for (const name of ['cargo','rustc','rustup','rustfmt']) {
    let path;
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        const candidate=join(directory,name+(process.platform === 'win32' ? '.exe' : ''));
        try {await access(candidate);path=candidate;break;} catch { /* Continue through host-owned PATH. */ }
    }
    if (!path) throw new Error(`Hosted ${name} unavailable`);
    lines.push(`MOMOKI_${name.toUpperCase()}_PATH=${path}`);
}
const pnpm=await realpath(join(process.env.RUNNER_TEMP,'momoki-pnpm/node_modules/pnpm/bin/pnpm.cjs'));
if (pnpm.includes('codex-runtimes') || /[\r\n]/.test(pnpm)) throw new Error('Unapproved pnpm path');
lines.push(`MOMOKI_PNPM_PATH=${pnpm}`);
await appendFile(process.env.GITHUB_ENV,lines.join('\n')+'\n');
