import {build} from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';

const base=fileURLToPath(new URL('../',import.meta.url));
const projectRoot=resolve(base,'../..');
const acceptance=process.argv.includes('--acceptance');
const endpoint=acceptance ? process.env.MOMOKI_STREAM_ENDPOINT : '';
const token=acceptance ? process.env.MOMOKI_STREAM_TOKEN : '';
if(acceptance && (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(endpoint) || !token)) throw new Error('Acceptance build requires a reserved exact loopback endpoint and test token');
// The normal bundle is the real product. The historical acceptance harness
// remains a separate fixture so its locked selectors and evidence do not
// silently change when product routes evolve.
const frontendRoot=acceptance ? resolve(base,'ui') : base;

await build({configFile:false,root:frontendRoot,plugins:[react(),tailwind()],publicDir:resolve(projectRoot,'packages/distribution/public'),
    define:{__APP_VERSION__:JSON.stringify(JSON.parse(readFileSync(resolve(projectRoot,'package.json'),'utf8')).version),__ACCEPTANCE__:JSON.stringify(acceptance),__STREAM_ENDPOINT__:JSON.stringify(endpoint),__STREAM_TOKEN__:JSON.stringify(token)},
    build:{outDir:resolve(base,'dist',acceptance?'acceptance':'normal'),emptyOutDir:true,assetsInlineLimit:0},worker:{format:'es'}});
