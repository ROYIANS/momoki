import {lazy, Suspense, useCallback, useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {getCurrentWebviewWindow} from '@tauri-apps/api/webviewWindow';
import {Button} from '@momoki/studio/reference/components/ui/button';
import {Input} from '@momoki/studio/reference/components/ui/input';
import {PageHeader} from '@momoki/studio/reference/components/layout/PageLayout';
import {native, type NativeState} from './bridge';
import '@momoki/studio/reference/styles.css';
import './prototype.css';

const Acceptance = __ACCEPTANCE__ ? lazy(() => import('./acceptance')) : null;
const deniedProbe = __ACCEPTANCE__ && getCurrentWebviewWindow().label === 'denied-probe';

function App() {
    const [state, setState] = useState<NativeState | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [projectTitle, setProjectTitle] = useState('我的本地项目');
    const [importName, setImportName] = useState('我的素材');
    const [importMime, setImportMime] = useState('image/png');
    const [availability, setAvailability] = useState<Record<string, string>>({});
    const [preview, setPreview] = useState<{
        url: string;
        mime: string;
        name: string;
        bytes: number;
        sha256: string
    } | null>(null);
    const previewUrl = useRef<string | undefined>(undefined);
    const previewGeneration = useRef(-1);
    const mounted = useRef(true);
    const releasePreview = useCallback(() => {
        if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
        previewUrl.current = undefined;
        setPreview(null);
    }, []);
    const refresh = useCallback(async () => {
        const reply = await native.request({type: 'state'});
        const generation = native.generation;
        if (reply.type === 'state' && mounted.current && generation === native.generation) {
            setState(reply.value);
            if (previewGeneration.current !== generation) releasePreview();
        }
    }, [releasePreview]);
    useEffect(() => {
        void refresh().catch((error: unknown) => setError(error instanceof Error ? error.message : JSON.stringify(error)));
    }, [refresh]);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
        };
    }, []);
    const run = async (action: () => Promise<unknown>) => {
        setError('');
        setBusy(true);
        try {
            await action();
            await refresh();
        } catch (error) {
            setError(error instanceof Error ? error.message : JSON.stringify(error));
        } finally {
            setBusy(false);
        }
    };
    const showPreview = async (assetId: string) => {
        releasePreview();
        const generation = native.generation;
        const value = await native.read(assetId);
        if (!mounted.current || generation !== native.generation) throw new Error('工作区已切换，未显示旧素材');
        const url = URL.createObjectURL(value.blob);
        previewUrl.current = url;
        previewGeneration.current = generation;
        setPreview({
            url,
            mime: value.asset.mimeType,
            name: value.asset.displayName,
            bytes: value.asset.byteLength,
            sha256: value.asset.contentHash
        });
    };
    return <div className="prototype-shell dark">
        <aside className="prototype-nav"><strong>默默</strong><span>原生工作区原型</span><p>SQLite · 文件副本</p>
            <small>{__ACCEPTANCE__ ? '独立验收应用' : '离线应用'}</small></aside>
        <main className="prototype-main">
            <PageHeader title="本地工作区" description="在软件内管理项目和素材，原生层负责持久化与备份。"/>
            <div className="prototype-toolbar">
                <Button disabled={busy || !!state}
                        onClick={() => void run(() => native.request({type: 'create'}))}>创建工作区</Button>
                <Button variant="outline" disabled={busy || !!state}
                        onClick={() => void run(() => native.request({type: 'open'}))}>打开工作区</Button>
                <Button variant="outline" disabled={busy || !!state}
                        onClick={() => void run(() => native.request({type: 'restore'}))}>恢复备份</Button>
                <Button variant="outline" disabled={busy || !!state}
                        onClick={() => void run(() => native.request({type: 'reopen'}))}>重新打开</Button>
                <Button variant="outline" disabled={!state} onClick={() => void run(async () => {
                    releasePreview();
                    await native.request({type: 'close'});
                    setAvailability({});
                })}>关闭</Button>
                <Button variant="outline"
                        onClick={() => void native.cancel().catch((error: unknown) => setError(String(error)))}>取消操作</Button>
            </div>
            {error ? <p role="alert" className="prototype-error">{error}</p> : null}
            <p role="status"
               className="prototype-meta">{state ? `工作区 ${state.workspaceId} · SQLite ${state.sqliteVersion}` : '请选择全新目录创建工作区，或打开已有工作区。'}</p>
            {state ? <>
                <div className="prototype-toolbar"><Input value={projectTitle}
                                                          onChange={e => setProjectTitle(e.target.value)}
                                                          aria-label="项目名称"/><Button disabled={busy}
                                                                                         onClick={() => void run(() => native.request({
                                                                                             type: 'project',
                                                                                             project: {
                                                                                                 id: crypto.randomUUID(),
                                                                                                 title: projectTitle
                                                                                             }
                                                                                         }))}>新增项目</Button><Button
                    variant="outline" disabled={busy}
                    onClick={() => void run(() => native.request({type: 'backup'}))}>创建完整备份</Button><Button
                    variant="outline" disabled={busy} onClick={() => void run(async () => {
                    const generation = native.generation;
                    const reply = await native.request({type: 'availability'});
                    if (generation === native.generation && reply.type === 'outcome' && reply.value.kind === 'availability') setAvailability(Object.fromEntries(reply.value.value.map(row => [row.assetId, row.status === 'present' ? '副本完整' : row.status === 'missing' ? '素材已丢失' : '素材已损坏'])));
                })}>检查素材</Button></div>
                <div className="prototype-toolbar"><Input value={importName}
                                                          onChange={event => setImportName(event.target.value)}
                                                          aria-label="导入素材名称"/><label>素材格式 <select
                    value={importMime} onChange={event => setImportMime(event.target.value)}>
                    <option value="image/png">PNG 图片</option>
                    <option value="video/mp4">MP4 视频</option>
                    <option value="audio/wav">WAV 音频</option>
                    <option value="audio/mpeg">MP3 音频</option>
                    <option value="audio/aac">AAC 音频</option>
                    <option value="application/pdf">PDF 文档</option>
                    <option value="application/octet-stream">其他文件</option>
                </select></label></div>
                <div className="prototype-projects">{state.projects.map(project => <section key={project.id}>
                    <h2>{project.title}</h2><Button size="sm" variant="outline" disabled={busy}
                                                    onClick={() => void run(() => native.request({
                                                        type: 'import',
                                                        metadata: {
                                                            projectId: project.id,
                                                            assetId: crypto.randomUUID(),
                                                            kind: 'media',
                                                            displayName: importName,
                                                            mimeType: importMime
                                                        }
                                                    }))}>导入素材副本</Button>
                    <ul>{state.assets.filter(a => a.projectId === project.id).map(asset => <li key={asset.id}>
                        <span>{asset.displayName} · {asset.byteLength} bytes <small>{availability[asset.id]}</small></span><Button
                        size="sm" variant="outline" disabled={busy}
                        onClick={() => void run(() => showPreview(asset.id))}>校验并预览</Button><Button size="sm"
                                                                                                         variant="outline"
                                                                                                         disabled={busy}
                                                                                                         onClick={() => void run(() => native.request({
                                                                                                             type: 'export',
                                                                                                             assetId: asset.id
                                                                                                         }))}>导出</Button>
                    </li>)}</ul>
                </section>)}</div>
            </> : null}
            {preview ? <section className="prototype-preview"><h2>{preview.name}</h2><p>{preview.bytes} bytes ·
                SHA-256 {preview.sha256}</p>{preview.mime.startsWith('image/') ?
                <img src={preview.url} alt={preview.name}/> : null}{preview.mime.startsWith('video/') ?
                <video src={preview.url} aria-label={preview.name}
                       controls/> : null}{preview.mime.startsWith('audio/') ?
                <audio src={preview.url} aria-label={preview.name} controls/> : null}<Button variant="outline"
                                                                                             onClick={releasePreview}>关闭预览</Button>
            </section> : null}
            {Acceptance ? <Suspense fallback={<p>加载验收工具…</p>}><Acceptance refresh={refresh}/></Suspense> : null}
        </main>
    </div>;
}

const element = document.getElementById('root');
if (!element) throw new Error('Missing prototype mount');
createRoot(element).render(deniedProbe && Acceptance ?
    <Suspense fallback={<p>加载拒绝测试…</p>}><Acceptance refresh={() => Promise.resolve()}/></Suspense> : <App/>);
