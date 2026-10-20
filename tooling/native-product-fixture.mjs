import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureFiles = {image: ['image.png', 'image/png'], video: ['movie.mp4', 'video/mp4'], audio: ['tone.wav', 'audio/wav']};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const event = data => `data: ${JSON.stringify(data)}\r\n\r\n`;
const chunk = (delta, finish_reason = null) => ({id: 'fixture-chat', object: 'chat.completion.chunk', choices: [{index: 0, delta, finish_reason}]});
const fixtureToolGroups = {
    workspace_overview: 'workspace', business_search: 'business-read', business_detail: 'business-read',
    generation_capabilities: 'media-generation', submit_generation: 'media-generation', prepare_generation_batch: 'media-generation',
    audio_read: 'audio-production', audio_generation_capabilities: 'audio-production', audio_generate_speech: 'audio-production',
    prepare_audio_generation_batch: 'audio-production', music_read: 'music-creation', music_generate: 'music-creation',
};
const textContent = content => typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(part => ['text', 'input_text'].includes(part?.type)).map(part => part.text ?? '').join('\n') : '';

/** Fixture-only structural check against the actual tool schema advertised by the product.
 * The product's real Zod parser, ownership checks and approval remain authoritative. */
function advertisedArgumentsMatch(schema, value) {
    if (!record(schema)) return false;
    if (schema.anyOf && !schema.anyOf.some(item => advertisedArgumentsMatch(item, value))) return false;
    if (schema.oneOf && schema.oneOf.filter(item => advertisedArgumentsMatch(item, value)).length !== 1) return false;
    if (schema.enum && !schema.enum.includes(value)) return false;
    const type = schema.type;
    if (type === 'object') {
        if (!record(value) || (schema.required ?? []).some(key => !Object.hasOwn(value, key))) return false;
        if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties ?? {}, key))) return false;
        return Object.entries(value).every(([key, entry]) => !schema.properties?.[key] || advertisedArgumentsMatch(schema.properties[key], entry));
    }
    if (type === 'array') return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity) && (!schema.items || value.every(entry => advertisedArgumentsMatch(schema.items, entry)));
    if (type === 'string') return typeof value === 'string' && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity);
    if (type === 'number' || type === 'integer') return typeof value === 'number' && Number.isFinite(value) && (type !== 'integer' || Number.isInteger(value)) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
    if (type === 'boolean') return typeof value === 'boolean';
    if (type === 'null') return value === null;
    return type === undefined;
}

function explicitFixtureTool(messages, tools) {
    let latestUser = -1;
    for (let index = 0; index < messages.length; index++) if (messages[index].role === 'user') latestUser = index;
    if (latestUser < 0) return;
    const text = textContent(messages[latestUser].content);
    const marker = '[fixture:tool]';
    if (!text.includes(marker)) return;
    let command;
    try { command = JSON.parse(text.slice(text.indexOf(marker) + marker.length).trim()); } catch { return {content: '合成验收指令需要 [fixture:tool] 后紧跟完整 JSON。'}; }
    if (!record(command) || !Object.hasOwn(fixtureToolGroups, command.name) || !record(command.arguments) || Object.keys(command).some(key => !['name', 'arguments'].includes(key))) return {content: '这个合成验收指令不在允许的工具清单内，或 arguments 不是对象。'};
    const called = messages.slice(latestUser + 1).some(message => message.type === 'function_call' && message.name === command.name || message.tool_calls?.some(call => call.function?.name === command.name));
    if (called) return {content: '已收到产品真实工具结果，请查看工具记录；合成服务不会代替用户确认、选用或宣称生成成功。'};
    const advertised = tools.find(tool => (tool.function?.name ?? tool.name) === command.name);
    if (!advertised) {
        const loaded = messages.slice(latestUser + 1).some(message => message.type === 'function_call' && message.name === 'load_tool_groups' || message.tool_calls?.some(call => call.function?.name === 'load_tool_groups'));
        if (loaded) return {content: '已请求加载工具，但产品仍未提供对应定义；请核对当前模式、能力与授权，不会重复加载或提交。'};
        if (tools.some(tool => (tool.function?.name ?? tool.name) === 'load_tool_groups')) return {name: 'load_tool_groups', args: {groupIds: [fixtureToolGroups[command.name]]}};
        return {content: '当前 UI 执行未提供该工具或加载入口，请选择智能模式并启用对应创作能力。'};
    }
    if (!advertisedArgumentsMatch(advertised.function?.parameters ?? advertised.parameters, command.arguments)) return {content: '合成指令与产品本轮实际工具 schema 不匹配；未发出工具调用，请使用真实 ID 和合法字段。'};
    return {name: command.name, args: command.arguments};
}

function multipartFile(bytes, contentType) {
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)?.slice(1).find(Boolean)?.trim();
    if (!boundary) return;
    const headerEnd = bytes.indexOf('\r\n\r\n');
    const end = bytes.lastIndexOf(`\r\n--${boundary}--`);
    if (headerEnd < 0 || end < headerEnd + 4) return;
    const headers = bytes.subarray(0, headerEnd).toString('utf8');
    if (!headers.includes('name="file"')) return;
    return {bytes: bytes.subarray(headerEnd + 4, end), filename: /filename="([^"]*)"/.exec(headers)?.[1] ?? null};
}

/** Loopback-only, synthetic data and no CORS: a WebView fetch cannot substitute for native transport. */
export async function startNativeProductFixture({port = 0, outputDirectory} = {}) {
    const events = [];
    const tasks = new Map();
    let sequence = 0;
    let origin;
    const note = value => events.push({at: new Date().toISOString(), ...value});
    let persistence = Promise.resolve();
    const persist = () => {
        if (outputDirectory) persistence = persistence.then(() => writeFile(resolve(outputDirectory, 'fixture-events.json'), JSON.stringify(events, null, 2) + '\n'));
        return persistence;
    };
    const json = (response, value, status = 200) => {
        response.writeHead(status, {'Content-Type': 'application/json'});
        response.end(JSON.stringify(value));
    };
    const media = async (response, kind) => {
        const [file, mime] = fixtureFiles[kind];
        const bytes = await readFile(resolve(repository, 'apps/desktop/fixtures/media', file));
        response.writeHead(200, {'Content-Type': mime, 'Content-Length': bytes.length});
        response.end(bytes);
    };
    const stream = (response, entries, {stall = false, partial = false} = {}) => {
        response.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache'});
        response.flushHeaders();
        let index = 0;
        const timer = setInterval(() => {
            if (response.destroyed) return;
            if (index < entries.length) {
                const bytes = Buffer.from(entries[index++]);
                // Split inside UTF-8 as well as SSE boundaries, exercising the shared decoder.
                response.write(bytes.subarray(0, 9));
                response.write(bytes.subarray(9));
            } else {
                clearInterval(timer);
                if (!stall) { if (partial) response.destroy(); else response.end(); }
            }
        }, 120);
        response.once('close', () => clearInterval(timer));
    };
    const server = createServer(async (request, response) => {
        const id = ++sequence;
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const started = Date.now();
        note({type: 'request', id, method: request.method, path: url.pathname, query: url.search,
            origin: request.headers.origin ?? null, authorizationPresent: Boolean(request.headers.authorization),
            cookiePresent: Boolean(request.headers.cookie), contentType: request.headers['content-type'] ?? null});
        response.once('close', () => {
            note({type: 'disconnect', id, path: url.pathname, elapsedMs: Date.now() - started, finished: response.writableFinished});
            void persist();
        });
        try {
            if (request.method === 'OPTIONS') return json(response, {error: {message: 'This fixture deliberately offers no CORS'}}, 403);
            const chunks = [];
            let byteLength = 0;
            for await (const bytes of request) {
                byteLength += bytes.length;
                if (byteLength > 22 * 1024 * 1024) return json(response, {error: {message: 'Fixture input exceeds bound'}}, 413);
                chunks.push(bytes);
            }
            const bytes = Buffer.concat(chunks);
            let body;
            if (bytes.length && request.headers['content-type']?.includes('application/json')) body = JSON.parse(bytes.toString('utf8'));
            note({type: 'body', id, byteLength, sha256: digest(bytes), model: record(body) && typeof body.model === 'string' ? body.model : null,
                offeredTools: Array.isArray(body?.tools) ? body.tools.map(tool => tool.function?.name ?? tool.name) : []});

            if (url.pathname === '/health') return json(response, {ready: true, origin, cors: false});
            if (url.pathname === '/evidence') return json(response, {events, tasks: [...tasks.keys()]});
            if (url.pathname.startsWith('/media/')) {
                const kind = url.pathname.split('/')[2];
                if (!Object.hasOwn(fixtureFiles, kind)) return json(response, {error: {message: 'Unknown fixture media'}}, 404);
                return await media(response, kind);
            }
            if (url.pathname === '/echo') return json(response, {method: request.method, byteLength, sha256: digest(bytes), authorizationPresent: Boolean(request.headers.authorization), cookiePresent: Boolean(request.headers.cookie)});
            if (url.pathname === '/redirect') {
                const target = url.searchParams.get('to') ?? '/echo';
                const destination = new URL(target, origin);
                if (!['127.0.0.1', 'localhost', '[::1]'].includes(destination.hostname)) return json(response, {error: {message: 'Fixture redirects only to loopback'}}, 400);
                response.writeHead(Number(url.searchParams.get('status') ?? 302), {Location: destination.href});
                return response.end();
            }
            if (url.pathname === '/slow-headers') return; // Explicit abort case; socket close remains in evidence.
            if (url.pathname === '/stalled-body') return stream(response, [event(chunk({content: '首块🌹'}))], {stall: true});
            if (url.pathname === '/v1/models') return json(response, {data: ['fixture-chat', 'fixture-responses', 'fixture-stop', 'fixture-partial', 'fixture-http-error', 'fixture-redirect', 'gpt-5.6-luna', 'gpt-4o-mini-tts', 'mimo-v2.5-tts', 'flowmusic', 'suno', 'gpt-image-2.5-flare', 'MiniMax-H3'].map(id => ({id, type: 'model'}))});
            if (url.pathname === '/api/v1/models') return json(response, {success: true, data: [{model_id: 'fixture-chat', types: ['chat'], endpoints: ['chat/completions'], input_modalities: ['text', 'image'], output_modalities: ['text']}]});
            if (url.pathname === '/ai/v1/images' && request.method === 'GET') return json(response, {object: 'list', data: [], has_more: false});
            if (url.pathname === '/v1/uploads/images') {
                const file = multipartFile(bytes, request.headers['content-type'] ?? '');
                if (!file?.bytes.length) return json(response, {error: {message: 'Expected real multipart file'}}, 400);
                note({type: 'multipart-file', id, filename: file.filename, byteLength: file.bytes.length, sha256: digest(file.bytes)});
                // Upload metadata is a top-level response, unlike generation
                // submit/query envelopes. bytes describes the file, not MIME framing.
                return json(response, {url: `${origin}/media/image`, filename: file.filename, content_type: 'image/png', bytes: file.bytes.length, created_at: Math.floor(Date.now() / 1000)});
            }
            if (url.pathname === '/v1/audio/speech') return await media(response, 'audio');
            if (['/v1/images/generations', '/v1/videos/generations', '/v1/music/generations'].includes(url.pathname)) {
                const kind = url.pathname.includes('/music/') ? 'audio' : url.pathname.includes('/videos/') ? 'video' : 'image';
                const taskId = `fixture-${kind}-${id}`;
                const crossOrigin = typeof body?.prompt === 'string' && body.prompt.includes('[fixture:cross-origin-media]');
                const mediaOrigin = crossOrigin ? origin.replace('127.0.0.1', 'localhost') : origin;
                tasks.set(taskId, {kind, mediaOrigin});
                return json(response, {code: 200, data: [{task_id: taskId}]});
            }
            if (/^\/v1\/(music\/)?tasks\//.test(url.pathname)) {
                const taskId = decodeURIComponent(url.pathname.split('/').at(-1));
                const task = tasks.get(taskId);
                if (!task) return json(response, {error: {message: 'Unknown fixture task'}}, 404);
                const {kind, mediaOrigin} = task;
                const result = kind === 'audio' ? {music: [{audio_url: `${mediaOrigin}/media/audio`, title: '本地验收音乐', duration: 1}]} : {[kind === 'video' ? 'videos' : 'images']: [{url: [`${mediaOrigin}/media/${kind}`]}]};
                return json(response, {code: 200, data: {id: taskId, status: 'completed', progress: 100, result}});
            }
            if (url.pathname === '/search') return json(response, {query: body?.query, results: [{title: '合成验收资料', url: 'https://example.org/native-fixture', content: '这是本地合成检索结果，不能作为真实搜索证明。', score: 0.9}]});
            if (url.pathname === '/extract') return json(response, {results: [{url: 'https://example.org/native-fixture', raw_content: '合成资料全文。'}], failed_results: []});
            if (url.pathname === '/usage') return json(response, {key: {usage: 0, limit: 100}, account: {current_plan: 'fixture'}});
            if (!['/v1/chat/completions', '/v1/responses'].includes(url.pathname)) return json(response, {error: {message: 'Unknown fixture endpoint'}}, 404);
            if (String(body?.model).startsWith('mimo-v2.5-tts')) {
                const wav = await readFile(resolve(repository, 'apps/desktop/fixtures/media/tone.wav'));
                return json(response, {choices: [{finish_reason: 'stop', message: {role: 'assistant', audio: {data: wav.toString('base64')}, final_text_preview: '合成配音验收'}}]});
            }
            if (body?.model === 'fixture-http-error') return json(response, {error: {message: 'Synthetic provider rejection'}}, 429);
            if (body?.model === 'fixture-redirect' && !url.searchParams.has('redirected')) {
                const destination = `${origin.replace('127.0.0.1', 'localhost')}${url.pathname}?redirected=1`;
                note({type: 'redirect-hop', id, status: 307, destinationOrigin: new URL(destination).origin});
                response.writeHead(307, {Location: destination});
                return response.end();
            }
            const messages = body?.messages ?? body?.input ?? [];
            const userText = messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n');
            const offered = new Set((body?.tools ?? []).map(tool => tool.function?.name ?? tool.name));
            const hasToolResult = messages.some(message => message.role === 'tool' || message.type === 'function_call_output');
            const requestedTool = userText.includes('[fixture:project]') ? 'project_create' : userText.includes('[fixture:overview]') ? 'workspace_overview' : undefined;
            const alreadyCalled = requestedTool && messages.some(message => message.type === 'function_call' && message.name === requestedTool || message.tool_calls?.some(call => call.function?.name === requestedTool));
            const explicit = explicitFixtureTool(messages, body?.tools ?? []);
            let toolName = explicit?.name ?? (!alreadyCalled && requestedTool && offered.has(requestedTool) ? requestedTool : undefined);
            if (!alreadyCalled && requestedTool === 'project_create' && !toolName && offered.has('load_tool_groups')) toolName = 'load_tool_groups';
            const args = explicit?.args ?? (toolName === 'project_create' ? {name: '原生 Agent 验收项目', kind: 'video', mode: 'film', continueInProject: false} : toolName === 'load_tool_groups' ? {groupIds: ['story-edit']} : {});
            const content = explicit?.content ?? (body?.model === 'fixture-redirect' ? `跨源重定向已到达：method=${request.method}，authorization=${Boolean(request.headers.authorization)}，cookie=${Boolean(request.headers.cookie)}；以服务端请求记录为准。` : hasToolResult ? '已收到真实工具执行结果，请在项目或历史记录中核对。' : '原生 HTTP 合成验收完成：中文与 🌹 流式内容完整。');
            if (url.pathname.endsWith('/responses')) {
                const reasoning = '正在验证原生传输。';
                // The authoritative completed envelope must include every public
                // text/reasoning delta, including tool-only Responses turns.
                const output = [{type: 'reasoning', id: `rs-${id}`, summary: [{type: 'summary_text', text: reasoning}]},
                    ...(toolName ? [{type: 'function_call', id: `fc-${id}`, call_id: `call-${id}`, name: toolName, arguments: JSON.stringify(args), status: 'completed'}] : [{type: 'message', id: `msg-${id}`, role: 'assistant', status: 'completed', content: [{type: 'output_text', text: content, annotations: []}]}])];
                return stream(response, [event({type: 'response.reasoning_summary_text.delta', delta: reasoning}), ...(!toolName ? [event({type: 'response.output_text.delta', delta: content})] : []), event({type: 'response.completed', response: {id: `resp-${id}`, status: 'completed', output, usage: {input_tokens: 20, output_tokens: 10, total_tokens: 30}}})]);
            }
            if (!body?.stream) return json(response, {choices: [{message: {role: 'assistant', content}, finish_reason: 'stop'}]});
            const entries = [event(chunk({role: 'assistant', reasoning_content: '正在验证原生传输。'}))];
            if (toolName) entries.push(event(chunk({tool_calls: [{index: 0, id: `call-${id}`, type: 'function', function: {name: toolName, arguments: JSON.stringify(args)}}]})), event(chunk({}, 'tool_calls')));
            else entries.push(event(chunk({content: content.slice(0, 12)})), event(chunk({content: content.slice(12)})), event(chunk({}, 'stop')));
            if (body?.model !== 'fixture-partial') entries.push('data: [DONE]\r\n\r\n');
            return stream(response, ['fixture-stop', 'fixture-partial'].includes(body?.model) ? entries.slice(0, 2) : entries, {stall: body?.model === 'fixture-stop', partial: body?.model === 'fixture-partial'});
        } catch (error) {
            note({type: 'fixture-error', id, message: error instanceof Error ? error.message : 'Unknown fixture failure'});
            if (!response.headersSent) json(response, {error: {message: 'Fixture failed'}}, 500);
            else response.destroy();
        }
    });
    await new Promise((accept, reject) => {server.once('error', reject); server.listen(port, '127.0.0.1', accept);});
    origin = `http://127.0.0.1:${server.address().port}`;
    if (outputDirectory) {
        await mkdir(outputDirectory, {recursive: true});
        await writeFile(resolve(outputDirectory, 'fixture-ready.json'), JSON.stringify({origin, cors: false, token: 'synthetic-local-only', limits: 'Synthetic fixture only; no supplier or normal-product result is implied.'}, null, 2) + '\n');
    }
    return {origin, events, async close() {server.closeAllConnections(); await new Promise(accept => server.close(accept)); await persist();}};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const fixture = await startNativeProductFixture({port: Number(process.env.MOMOKI_FIXTURE_PORT ?? 0), outputDirectory: process.argv[2]});
    console.log(JSON.stringify({origin: fixture.origin, cors: false, token: 'synthetic-local-only'}));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {void fixture.close().then(() => process.exit(0));});
}
