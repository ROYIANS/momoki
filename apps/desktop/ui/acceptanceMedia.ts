import {parseReferenceFile} from '@momoki/studio/reference/lib/references/import';
import {native} from './bridge';
import {assert, delay, type Evidence, rejects} from './acceptanceEvidence';

export type FixtureBlobs = Map<string, Blob>;

export function fixture(blobs: FixtureBlobs, id: string): Blob {
    const blob = blobs.get(id);
    assert(blob, `未加载 ${id}`);
    return blob;
}

export async function readFixtures(evidence: Evidence): Promise<FixtureBlobs> {
    const blobs: FixtureBlobs = new Map();
    for (const id of ['image.png', 'tone.wav', 'tone.mp3', 'tone.aac', 'tone.m4a', 'movie.mp4', 'document.pdf', 'document.docx']) {
        const read = await evidence.check(`原生分块与 SHA-256：${id}`, () => native.read(id), value => ({
            assetId: value.asset.id,
            bytes: value.blob.size,
            mime: value.blob.type,
            sha256: value.asset.contentHash,
            chunkBytes: 262144
        }));
        if (read) blobs.set(id, read.blob);
    }
    return blobs;
}

export async function checkDocuments(blobs: FixtureBlobs, evidence: Evidence) {
    await evidence.check('PDF：真实离线 worker／中文／CMaps／字体', async () => {
        const fetched: { url: string; status: number; contentType: string | null }[] = [];
        const workers: { url: string; type: string; messages: number; terminated: boolean }[] = [];
        const originalFetch = globalThis.fetch;
        const ActualWorker = globalThis.Worker;
        // Observe genuine browser fetch/Worker calls without replacing transport, bytes or worker execution.
        globalThis.fetch = async (input, init) => {
            const response = await originalFetch(input, init);
            const url = typeof input === 'string' ? new URL(input, location.href).href : input instanceof URL ? input.href : input.url;
            fetched.push({url, status: response.status, contentType: response.headers.get('Content-Type')});
            return response;
        };
        globalThis.Worker = class extends ActualWorker {
            private readonly observation;

            constructor(url: string | URL, options?: WorkerOptions) {
                super(url, options);
                this.observation = {url: String(url), type: options?.type ?? 'classic', messages: 0, terminated: false};
                workers.push(this.observation);
                this.addEventListener('message', () => this.observation.messages++);
            }

            override terminate() {
                this.observation.terminated = true;
                super.terminate();
            }
        };
        const parsed = await (async () => {
            try {
                return await parseReferenceFile(await fixture(blobs, 'document.pdf').arrayBuffer(), 'pdf', 'application/pdf');
            } finally {
                globalThis.fetch = originalFetch;
                globalThis.Worker = ActualWorker;
            }
        })();
        const text = parsed.chunks.map(chunk => chunk.text).join('\n');
        assert(parsed.coverage.totalUnits === 2 && parsed.coverage.processedUnits === 2, 'PDF 页数不符');
        assert(text.includes('第一场：雨夜；角色：林一；保持红色雨伞。') && text.includes('第二场：清晨；素材属于工作区。') && text.includes('Momoki fixture 2026-10-11'), 'PDF 中文提取不符');
        const resources = fetched.map(entry => entry.url);
        const cMaps = resources.filter(name => /UniGB-UCS2-H|Adobe-GB1-UCS2/.test(name));
        const fonts = resources.filter(name => /LiberationSans-Regular/.test(name));
        assert(cMaps.length >= 2 && fonts.length >= 1, '没有观测到实际本地 CMaps／字体读取');
        assert([...cMaps, ...fonts].every(url => new URL(url).protocol === 'tauri:'), 'PDF 资源不是打包本地资产');
        assert(fetched.every(entry => entry.status >= 200 && entry.status < 300), '本地 PDF 资源加载失败');
        assert(workers.some(worker => worker.type === 'module' && worker.messages > 0 && worker.terminated), '没有观测到实际 module PDF worker 返回消息与释放');
        return {text, coverage: parsed.coverage, cMaps, fonts, workers, fetched};
    }, value => ({...value, coverage: {...value.coverage}}));
    await evidence.check('PDF：损坏输入拒绝', async () => rejects(() => parseReferenceFile(new TextEncoder().encode('%PDF-1.7\nbroken').buffer, 'pdf', 'application/pdf')), error => ({error}));
    await evidence.check('PDF：中途取消保留 AbortError', async () => {
        const controller = new AbortController();
        const reason = new DOMException('fixture PDF abort', 'AbortError');
        const pending = parseReferenceFile(await fixture(blobs, 'document.pdf').arrayBuffer(), 'pdf', 'application/pdf', controller.signal);
        controller.abort(reason);
        try {
            await pending;
        } catch (error) {
            assert(error === reason, 'PDF 取消原因未保留');
            return {name: reason.name};
        }
        throw new Error('PDF 已取消却成功');
    }, value => value);
    await evidence.check('DOCX：真实 module worker／转移／中文', async () => {
        const buffer = await fixture(blobs, 'document.docx').arrayBuffer();
        const pending = parseReferenceFile(buffer, 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        assert(buffer.byteLength === 0, 'DOCX buffer 没有转移到 worker');
        const parsed = await pending;
        const text = parsed.chunks.map(chunk => chunk.text).join('\n');
        assert(text.includes('第一段：雨夜的红色雨伞。') && text.includes('第二段：素材复制到工作区。'), 'DOCX 提取不符');
        assert(parsed.chunks.every(chunk => chunk.locator.kind === 'paragraph'), 'DOCX 错误标为页码');
        return {text, characters: parsed.coverage.characters, bufferDetached: true};
    }, value => value);
    await evidence.check('DOCX：真实 worker 损坏输入拒绝', () => rejects(() => parseReferenceFile(new Uint8Array([0x50, 0x4b, 3, 4, 0]).buffer, 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')), error => ({error}));
    await evidence.check('DOCX：已启动 worker 取消与转移', async () => {
        const controller = new AbortController();
        const reason = new DOMException('fixture DOCX abort', 'AbortError');
        const buffer = await fixture(blobs, 'document.docx').arrayBuffer();
        const pending = parseReferenceFile(buffer, 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', controller.signal);
        assert(buffer.byteLength === 0, 'DOCX 取消检查没有启动真实 worker');
        controller.abort(reason);
        try {
            await pending;
        } catch (error) {
            assert(error === reason, 'DOCX 取消原因未保留');
            return {name: reason.name, bufferDetached: true};
        }
        throw new Error('DOCX 已取消却成功');
    }, value => value);
}

function mediaEvent(element: HTMLMediaElement, name: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const finish = (error?: Error) => {
            clearTimeout(timer);
            element.removeEventListener(name, loaded);
            element.removeEventListener('error', failed);
            if (error) reject(error); else resolve();
        };
        const loaded = () => finish();
        const failed = () => finish(new Error(`视频 ${name} 失败：${element.error?.code ?? 'unknown'}`));
        const timer = setTimeout(() => finish(new Error(`视频 ${name} 超时`)), 10000);
        element.addEventListener(name, loaded, {once: true});
        element.addEventListener('error', failed, {once: true});
    });
}

export async function checkVisualMedia(blobs: FixtureBlobs, evidence: Evidence, host: HTMLElement, ownUrl: (blob: Blob) => string) {
    await evidence.check('PNG：真实图片解码与尺寸', async () => {
        const blob = fixture(blobs, 'image.png');
        await parseReferenceFile(await blob.arrayBuffer(), 'image', 'image/png');
        const image = new Image();
        image.alt = '本机生成的 64×48 验收图片';
        image.src = ownUrl(blob);
        host.append(image);
        await image.decode();
        assert(image.naturalWidth === 64 && image.naturalHeight === 48, 'PNG 尺寸不符');
        return {width: image.naturalWidth, height: image.naturalHeight, complete: image.complete};
    }, value => value);
    const video = await evidence.check('H.264／AAC：加载、解码、实际播放、跳转', async () => {
        const video = document.createElement('video');
        video.controls = true;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.setAttribute('aria-label', '本机 H.264／AAC 验收视频');
        host.append(video);
        const loaded = mediaEvent(video, 'loadeddata');
        video.src = ownUrl(fixture(blobs, 'movie.mp4'));
        video.load();
        await loaded;
        assert(video.videoWidth === 64 && video.videoHeight === 48 && Math.abs(video.duration - 2) < 0.05, '视频尺寸或时长不符');
        await video.play();
        await delay(350);
        const position = video.currentTime;
        assert(position > 0.1 && !video.paused, '视频没有实际播放');
        video.pause();
        const sought = mediaEvent(video, 'seeked');
        video.currentTime = 1.25;
        await sought;
        assert(Math.abs(video.currentTime - 1.25) < 0.1, '视频跳转失败');
        return {
            video,
            width: video.videoWidth,
            height: video.videoHeight,
            duration: video.duration,
            playedTo: position,
            seekTo: video.currentTime,
            readyState: video.readyState
        };
    }, value => ({
        width: value.width,
        height: value.height,
        duration: value.duration,
        playedTo: value.playedTo,
        seekTo: value.seekTo,
        readyState: value.readyState
    }));
    return video?.video;
}
