import {type ReactElement, useEffect, useRef, useState} from 'react';
import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    RouterProvider
} from '@tanstack/react-router';
import JSZip from 'jszip';
import {z} from 'zod';
import {StoryboardPrintPage} from '@momoki/studio/reference/components/produce/StoryboardPrintPage';
import {Button} from '@momoki/studio/reference/components/ui/button';
import {db} from '@momoki/studio/reference/db/database';
import {DEFAULT_SHOT_SETTINGS, type Shot} from "@momoki/studio/reference/features/video/models/shots";
import {emptyEpisodeStory, emptySeriesStory} from "@momoki/studio/reference/features/video/models/story";
import {emptySetting} from "@momoki/studio/reference/features/video/models/world";
import {type Episode} from "@momoki/studio/reference/features/video/models/episodes";
import {type MediaRecord} from "@momoki/studio/reference/features/library/models/media";
import {type Project} from "@momoki/studio/reference/features/projects/models/project";
import {emptySlot} from '@momoki/studio/reference/domain/slot';
import {deriveEpisodeDelivery, episodeDeliveryCsv} from '@momoki/studio/reference/lib/episodeDelivery';
import {exportProjectZip} from '@momoki/studio/reference/lib/projectPackage';
import {readBinaryBlob} from '@momoki/studio/reference/lib/storage/binary';
import {sha256} from './bridge';
import {assert, delay, type Evidence, message} from './acceptanceEvidence';
import {fixture, type FixtureBlobs} from './acceptanceMedia';

const projectId = 'tauri-compatibility-print-project';
const episodeIds = ['tauri-print-episode-1', 'tauri-print-episode-2'] as const;
const endMarker = (episode: number) => `【第${episode + 1}集最后一镜完整结束】`;

export interface DeliveryFixture {
    project: Project;
    episodes: Episode[];
    shots: Shot[];
    media: MediaRecord[];
    csv: Blob;
    zip: Blob
}

async function webkitBlob(blob: Blob, mimeType: string): Promise<Blob> {
    // WebKit's IndexedDB bridge may reject a Blob whose backing store came
    // directly from a native IPC response. Re-materialize the bytes in the
    // current renderer realm before writing the compatibility-only projection.
    return new Blob([new Uint8Array(await blob.arrayBuffer())], {type: mimeType});
}

export async function seedDelivery(blobs: FixtureBlobs, evidence: Evidence): Promise<DeliveryFixture | undefined> {
    return evidence.check('真实 Dexie 临时投影／双集／CSV／项目 ZIP', async () => {
        assert(__ACCEPTANCE__ && location.protocol === 'tauri:', '拒绝在非隔离打包验收 origin 写入 fixture');
        await db.open();
        const existing = await db.projects.toArray();
        assert(existing.every(row => row.id === projectId), '此 origin 存在非 fixture 项目，拒绝写入');
        assert(await db.connectors.count() === 0, '此 origin 存在真实连接配置，拒绝写入');
        const at = '2026-10-11T00:00:00.000Z';
        const project: Project = {
            id: projectId,
            kind: 'video',
            name: '本机故事板，"完整内容"验收',
            mode: 'series',
            aspectPreset: '16:9',
            createdAt: at,
            updatedAt: at,
            columnSettings: {visible: ['content', 'category', 'sound', 'notes']},
            shotSettings: {...DEFAULT_SHOT_SETTINGS, filters: {statuses: [], beatIds: [], gaps: []}},
            story: emptySeriesStory(),
            setting: emptySetting()
        };
        const episodes: Episode[] = episodeIds.map((id, index) => ({
            id,
            projectId,
            order: index + 1,
            title: index === 0 ? '雨夜' : '清晨',
            story: emptyEpisodeStory(),
            createdAt: at,
            updatedAt: at
        }));
        const media: MediaRecord[] = [{
            id: 'tauri-print-image',
            projectId,
            mimeType: 'image/png',
            filename: 'image.png',
            blob: await webkitBlob(fixture(blobs, 'image.png'), 'image/png')
        }, {
            id: 'tauri-print-audio',
            projectId,
            mimeType: 'audio/wav',
            filename: 'tone.wav',
            blob: await webkitBlob(fixture(blobs, 'tone.wav'), 'audio/wav')
        }];
        const shots: Shot[] = episodes.flatMap((episode, index) => Array.from({length: index === 0 ? 8 : 6}, (_, order) => ({
            id: `${episode.id}-shot-${order + 1}`,
            projectId,
            episodeId: episode.id,
            order,
            shotNumber: `${index + 1}-${order + 1}`,
            status: 'draft',
            firstFrame: {...emptySlot(), result: {kind: 'image', mediaId: 'tauri-print-image'}},
            lastFrame: emptySlot(),
            clip: emptySlot(),
            category: '近景',
            durationSec: 2.5,
            content: `第${index + 1}集镜${order + 1}：他说，"你好"\n` + Array.from({length: 10}, (_, line) => `完整长段落 ${line + 1}：雨伞、台词和人物动作都应完整打印；换行与中文需要保留。`).join('\n') + `\n${order === (index === 0 ? 7 : 5) ? endMarker(index) : `【第${index + 1}集镜${order + 1}结束】`}`,
            notes: '长备注第一行，含逗号和"引号"\n长备注第二行；不得被截断。',
            sceneCloseup: '雨夜窗边',
            sound: '工作区录音引用：tauri-print-audio',
            emotion: '克制',
            cameraAngle: '平视',
            cameraGear: '固定',
            focalLength: '50 mm',
            characterIds: []
        })));
        // Explicit compatibility-only projection, after actual native byte verification; never a production write owner.
        await db.transaction('rw', [db.projects, db.episodes, db.shots, db.media], async (db) => {
            await db.projects.put(project);
            await db.episodes.bulkPut(episodes);
            await db.shots.bulkPut(shots);
            await db.media.bulkPut(media);
        });
        const delivery = deriveEpisodeDelivery({
            project,
            episode: episodes[0],
            shots,
            characters: [],
            scenes: [],
            props: [],
            styles: [],
            media: new Map(media.map(row => [row.id, row]))
        });
        assert(delivery.rows.length === 8 && delivery.rows.every(row => row.shot.episodeId === episodeIds[0]), 'CSV 包含另一集的镜头');
        const csvText = episodeDeliveryCsv(delivery);
        assert(csvText.charCodeAt(0) === 0xfeff && csvText.includes('\r\n') && csvText.includes('""你好""') && csvText.includes(endMarker(0)) && !csvText.includes(endMarker(1)), 'CSV BOM／换行／引用／分集范围错误');
        const csv = new Blob([csvText], {type: 'text/csv;charset=utf-8'});
        const zip = await exportProjectZip(projectId);
        const archive = await JSZip.loadAsync(zip);
        const jsonEntries = Object.keys(archive.files).filter(path => path.endsWith('.json'));
        assert(jsonEntries.length > 0, '真实项目 ZIP 缺少 JSON');
        const binaries = Object.values(archive.files).filter(entry => !entry.dir && !entry.name.endsWith('.json'));
        const imageHash = await sha256(await (await readBinaryBlob(media[0].blob)).arrayBuffer());
        let imageFound = false;
        for (const entry of binaries) if (await sha256(await entry.async('uint8array')) === imageHash) imageFound = true;
        assert(imageFound, '真实 ZIP 缺少实际 PNG 素材副本');
        return {
            project,
            episodes,
            shots,
            media,
            csv,
            zip,
            csvHash: await sha256(await csv.arrayBuffer()),
            zipHash: await sha256(await zip.arrayBuffer()),
            jsonEntries
        };
    }, value => ({
        database: db.name,
        origin: location.origin,
        projectId: value.project.id,
        episodeIds: value.episodes.map(episode => episode.id),
        shotCounts: [8, 6],
        longTextCharacters: value.shots.reduce((sum, shot) => sum + shot.content.length, 0),
        csvBytes: value.csv.size,
        zipBytes: value.zip.size,
        csvHash: value.csvHash,
        zipHash: value.zipHash,
        jsonEntries: value.jsonEntries,
        nativeMigration: false
    }));
}

function PrintRoute(): ReactElement {
    const raw: unknown = printRoute.useParams();
    const params = z.object({projectId: z.string().min(1), episodeId: z.string().min(1)}).strict().parse(raw);
    return <StoryboardPrintPage projectId={params.projectId} episodeId={params.episodeId}/>;
}

const rootRoute = createRootRoute({component: Outlet});
const printRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/p/$projectId/e/$episodeId/storyboard',
    component: PrintRoute
});
const produceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/p/$projectId/e/$episodeId/produce',
    component: () => <p>验收制作页；请用上方按钮返回故事板。</p>
});

function makeRouter() {
    return createRouter({
        routeTree: rootRoute.addChildren([printRoute, produceRoute]),
        history: createMemoryHistory({initialEntries: [`/p/${projectId}/e/${episodeIds[0]}/storyboard`]})
    });
}

async function waitPrintable(host: HTMLElement, episode: number) {
    const until = performance.now() + 15000;
    let page: HTMLElement | null = null;
    while (performance.now() < until) {
        page = host.querySelector('.storyboard-print');
        if (page?.textContent?.includes(endMarker(episode))) break;
        await delay(50);
    }
    assert(page && page.textContent?.includes(endMarker(episode)), '故事板 liveQuery 未完成或完整内容缺失');
    assert(!page.textContent.includes(endMarker(episode === 0 ? 1 : 0)), '故事板混入另一集');
    const cards = page.querySelectorAll('.storyboard-card');
    assert(cards.length === (episode === 0 ? 8 : 6), '故事板镜头数不符');
    await document.fonts.ready;
    await Promise.all([...page.querySelectorAll('img')].map(async image => {
        await image.decode();
        assert(image.naturalWidth === 64 && image.naturalHeight === 48, '故事板真实图片尚未解码');
    }));
    assert(page.querySelectorAll('img').length === cards.length, '故事板有缺失图片');
    for (const paragraph of page.querySelectorAll('.storyboard-card p')) {
        const style = getComputedStyle(paragraph);
        assert(style.overflow !== 'hidden' && style.textOverflow !== 'ellipsis', '故事板全文被截断');
    }
    return {
        episodeId: episodeIds[episode],
        cards: cards.length,
        fullEndMarker: endMarker(episode),
        characters: page.textContent.length,
        imageCount: page.querySelectorAll('img').length,
        fontStatus: document.fonts.status,
        nativePreview: 'pending actual root observation'
    };
}

export function AcceptancePrint({evidence}: { evidence: Evidence }) {
    const [router] = useState(makeRouter);
    const [episode, setEpisode] = useState(0);
    const [status, setStatus] = useState('等待故事板加载…');
    const host = useRef<HTMLDivElement>(null);
    useEffect(() => {
        let current = true;
        const element = host.current;
        if (!element) return;
        void evidence.check(`实际故事板 DOM／图片／全文：第${episode + 1}集`, () => waitPrintable(element, episode), value => value).then(result => {
            if (current) setStatus(result ? '已就绪。请点击故事板内“打印”打开系统预览。' : '故事板检查失败；查看日志。');
            return evidence.persist();
        }).catch((error: unknown) => {
            if (current) setStatus(message(error));
        });
        return () => {
            current = false;
        };
    }, [episode, evidence]);
    const select = async (index: number) => {
        await router.navigate({
            to: '/p/$projectId/e/$episodeId/storyboard',
            params: {projectId, episodeId: episodeIds[index]}
        });
        setEpisode(index);
    };
    return <div className="acceptance-print">
        <div className="acceptance-controls prototype-toolbar"><Button variant="outline" onClick={() => void select(0)}>故事板第
            1 集</Button><Button variant="outline" onClick={() => void select(1)}>故事板第 2 集</Button><span
            role="status">{status}</span></div>
        <div ref={host}><RouterProvider router={router}/></div>
    </div>;
}
