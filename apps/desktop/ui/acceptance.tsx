import {useEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {getCurrentWebviewWindow} from '@tauri-apps/api/webviewWindow';
import {Button} from '@momoki/studio/reference/components/ui/button';
import {encodePcm16Wav} from '@momoki/studio/reference/lib/audio/wav';
import {decodeAudioBlob} from '@momoki/studio/reference/lib/audio/engine';
import type {RecordingState} from '@momoki/studio/reference/lib/audio/recorder';
import {MicrophoneRecorder} from '@momoki/studio/reference/lib/audio/recorder';
import {acceptanceRequest, native, sha256} from './bridge';
import {
    type AcceptanceEvent,
    assert,
    environment,
    eventIsSkipped,
    Evidence,
    message,
    rejects
} from './acceptanceEvidence';
import {checkDocuments, checkVisualMedia, type FixtureBlobs, readFixtures} from './acceptanceMedia';
import {type AudioFixture, checkAudio, checkPlayback} from './acceptanceAudio';
import {checkStreaming} from './acceptanceStream';
import {AcceptancePrint, type DeliveryFixture, seedDelivery} from './acceptancePrint';
import {checkLateDisposal, createCapture, type LiveCapture, stoppedCapture} from './acceptanceRecorder';
import {checkNativeLocks} from './acceptanceLocks';

async function checkBridge(evidence: Evidence) {
    const state = await native.request({type: 'state'});
    assert(state.type === 'state' && state.value, '原生 workspace 未创建');
    const original = JSON.stringify(state.value);
    await evidence.check('真实桥接：close／reopen／SQLite 状态一致', async () => {
        const closed = await native.request({type: 'close'});
        assert(closed.type === 'closed', 'close 结果错误');
        const reopened = await native.request({type: 'reopen'});
        assert(reopened.type === 'state' && JSON.stringify(reopened.value) === original, '重开 workspace 状态不一致');
        const available = await native.request({type: 'availability'});
        assert(available.type === 'outcome' && available.value.kind === 'availability' && available.value.value.every(row => row.status === 'present'), '删除原始来源后素材副本不可用');
        return {
            workspaceId: state.value?.workspaceId,
            generation: native.generation,
            exactState: true,
            originalSourceDeletedByNativeSetup: true
        };
    }, value => ({...value, workspaceId: value.workspaceId ?? null}));
    for (const [name, action] of [['额外路径', {type: 'state', path: '/etc/passwd'}], ['SQL 字段', {
        type: 'state',
        sql: 'SELECT * FROM projects'
    }], ['未知命令', {type: 'readFile', path: '/etc/passwd'}]] as const) {
        await evidence.check(`真实闭合 DTO 拒绝：${name}`, () => rejects(() => invoke('workspace_request', {
            request: {
                version: 1,
                operationId: crypto.randomUUID(),
                expectedGeneration: native.generation,
                action
            }
        })), error => ({error}));
    }
    await evidence.check('真实闭合 envelope 拒绝额外字段', () => rejects(() => invoke('workspace_request', {
        request: {
            version: 1,
            operationId: crypto.randomUUID(),
            expectedGeneration: native.generation,
            action: {type: 'state'},
            path: '/etc/passwd'
        }
    })), error => ({error}));
    await evidence.check('真实旧 generation 拒绝', () => rejects(() => invoke('workspace_request', {
        request: {
            version: 1,
            operationId: crypto.randomUUID(),
            expectedGeneration: native.generation - 1,
            action: {type: 'state'}
        }
    })), error => ({error}));
    for (const command of ['plugin:fs|read_text_file', 'plugin:sql|select', 'plugin:shell|execute', 'plugin:dialog|open']) {
        await evidence.check(`真实未授权插件拒绝：${command}`, () => rejects(() => invoke(command, {
            path: '/etc/passwd',
            query: 'SELECT 1',
            command: 'echo',
            args: []
        })), error => ({error}));
    }
    await evidence.check('真实读取块超过 256 KiB 拒绝', async () => {
        const read = await native.request({type: 'readStart', assetId: 'tone.wav'});
        assert(read.type === 'read', '读取会话未建立');
        try {
            return {
                error: await rejects(() => native.request({
                    type: 'readChunk',
                    session: read.value.session,
                    offset: 0,
                    length: 262145
                }))
            };
        } finally {
            await native.request({type: 'readClose', session: read.value.session});
        }
    }, value => value);
    await evidence.check('拒绝探测后原生状态无变化', async () => {
        const after = await native.request({type: 'state'});
        assert(after.type === 'state' && JSON.stringify(after.value) === original, '拒绝操作改变了 workspace');
        return {unchanged: true};
    }, value => value);
}

function AcceptanceMain({refresh}: { refresh: () => Promise<void> }) {
    const [events, setEvents] = useState<AcceptanceEvent[]>([]);
    const [evidence] = useState(() => new Evidence(setEvents));
    const [busy, setBusy] = useState(false);
    const [started, setStarted] = useState(false);
    const [status, setStatus] = useState('点击开始，运行本机打包验收。录音由单独按钮启动。');
    const [audio, setAudio] = useState<AudioFixture>();
    const [delivery, setDelivery] = useState<DeliveryFixture>();
    const [projectId, setProjectId] = useState('');
    const [recordingState, setRecordingState] = useState<RecordingState>('idle');
    const [recording, setRecording] = useState<Blob>();
    const [recordingKept, setRecordingKept] = useState(false);
    const [printConfirmed, setPrintConfirmed] = useState(false);
    const [denialConfirmed, setDenialConfirmed] = useState(false);
    const [finished, setFinished] = useState(false);
    const host = useRef<HTMLDivElement>(null);
    const urls = useRef(new Set<string>());
    const video = useRef<HTMLVideoElement | undefined>(undefined);
    const capture = useRef<LiveCapture | undefined>(undefined);
    const stopTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const operation = useRef(false);
    const currentAudio = useRef<AudioFixture | undefined>(undefined);
    useEffect(() => {
        evidence.record('实际打包环境', true, environment());
        void evidence.persist().then(() => acceptanceRequest({type: 'ready'})).catch((error: unknown) => setStatus(message(error)));
        const ownedUrls = urls.current;
        return () => {
            if (stopTimer.current) clearTimeout(stopTimer.current);
            capture.current?.recorder.dispose();
            void currentAudio.current?.player.dispose();
            video.current?.pause();
            for (const url of ownedUrls) URL.revokeObjectURL(url);
        };
    }, [evidence]);
    const ownUrl = (blob: Blob) => {
        const url = URL.createObjectURL(blob);
        urls.current.add(url);
        return url;
    };
    const run = async (action: () => Promise<void>) => {
        if (operation.current || finished) return;
        operation.current = true;
        setBusy(true);
        try {
            await action();
            await evidence.persist();
        } catch (error) {
            evidence.record('验收动作失败', false, {error: message(error)});
            setStatus(message(error));
            try {
                await evidence.persist();
            } catch (reportError) {
                setStatus(message(reportError));
            }
        } finally {
            operation.current = false;
            setBusy(false);
        }
    };
    const runAll = async () => {
        setStarted(true);
        setStatus('正在检查真实原生桥接、媒体、文档、音频、导出与流。');
        const setup = await evidence.check('真实 Rust fixture setup／独立副本／完整备份', () => acceptanceRequest({type: 'setup'}), value => ({
            generation: value.generation,
            workspaceId: value.state?.workspaceId ?? null,
            assets: value.state?.assets.length ?? 0
        }));
        assert(setup?.state, '原生验收 setup 失败');
        setProjectId(setup.state.projects[0].id);
        await refresh();
        await checkBridge(evidence);
        const blobs: FixtureBlobs = await readFixtures(evidence);
        await evidence.persist();
        await checkDocuments(blobs, evidence);
        assert(host.current, '媒体挂载容器缺失');
        video.current = await checkVisualMedia(blobs, evidence, host.current, ownUrl);
        await evidence.persist();
        const audioFixture = await checkAudio(blobs, evidence);
        setAudio(audioFixture);
        currentAudio.current = audioFixture;
        const deliveryFixture = await seedDelivery(blobs, evidence);
        setDelivery(deliveryFixture);
        await evidence.persist();
        await checkStreaming(evidence);
        await evidence.persist();
        setStatus('自动检查已完成。请依次播放音频、保存 CSV／ZIP／WAV、取消保存、录音并保留，再复核两集系统打印预览。');
    };
    const exportBlob = async (format: 'csv' | 'zip' | 'wav', blob: Blob, expect: 'save' | 'cancel' | 'existing' = 'save') => {
        const before = await native.request({type: 'state'});
        const unchanged = JSON.stringify(before);
        if (expect === 'existing') {
            const error = await rejects(() => native.save(blob, projectId, format));
            const after = await native.request({type: 'state'});
            assert(JSON.stringify(after) === unchanged, '已有目标拒绝改变了 workspace');
            evidence.record('原生保存：已有目标拒绝且无写入', true, {error, format});
            return;
        }
        const saved = await native.save(blob, projectId, format);
        const after = await native.request({type: 'state'});
        assert(JSON.stringify(after) === unchanged, '原生 export／cancel 改变了 workspace');
        if (expect === 'cancel') {
            assert(saved.type === 'canceled', '需要实际取消原生保存窗口');
            evidence.record('原生保存：取消窗口且无写入', true, {format, stateUnchanged: true});
        } else {
            assert(saved.type === 'exported', '原生保存没有完成，请选全新目标');
            evidence.record(`原生保存：${format.toUpperCase()} 精确字节`, true, {
                bytes: saved.value.byteLength,
                sha256: saved.value.contentHash,
                rendererSha256: await sha256(await blob.arrayBuffer()),
                workspaceUnchanged: true
            });
        }
    };
    const stop = async () => {
        if (stopTimer.current) {
            clearTimeout(stopTimer.current);
            stopTimer.current = undefined;
        }
        const live = capture.current;
        assert(live, '没有录音器');
        const blob = await stoppedCapture(live, evidence);
        setRecording(blob);
        await evidence.persist();
    };
    const start = async () => {
        assert(!capture.current || !['recording', 'requesting', 'stopping'].includes(capture.current.recorder.state), '录音已经启动');
        capture.current?.recorder.dispose();
        const live = createCapture(setRecordingState);
        capture.current = live;
        setRecording(undefined);
        setRecordingKept(false);
        try {
            await live.recorder.start();
            assert(live.recorder.state === 'recording', '录音未进入 recording');
            stopTimer.current = setTimeout(() => void stop().catch((error: unknown) => {
                evidence.record('实际录音停止失败', false, {error: message(error)});
                setStatus(message(error));
            }), 3000);
            setStatus('正在真实录音，约 3 秒后停止。');
        } catch (error) {
            await new Promise<void>(resolve => setTimeout(resolve, 100));
            const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
            evidence.record(denied ? '真实麦克风权限拒绝与清理' : '真实麦克风启动失败', denied, {
                error: message(error),
                trackStates: live.observation.tracks.map(track => track.readyState),
                contextStates: live.observation.contexts.map(context => context.state),
                captureCompleted: false
            });
            setStatus(`录音未开始：${message(error)}`);
        }
    };
    const keep = async () => {
        assert(recording && capture.current, '没有可保留的真实录音');
        const saved = await native.save(recording, projectId, 'microphone', 'retain', recording.type);
        assert(saved.type === 'saved' && !saved.value.exported, '录音没有保存到本机工作区');
        const reopened = await native.read(saved.value.asset.id);
        assert(reopened.blob.type === recording.type && await sha256(await reopened.blob.arrayBuffer()) === await sha256(await recording.arrayBuffer()), '实际录音 MIME／字节没有完整保留');
        capture.current.recorder.markKept();
        capture.current.recorder.dispose();
        setRecordingKept(true);
        await refresh();
        evidence.record('真实麦克风：原始 MIME／字节仅本机保留', true, {
            assetId: saved.value.asset.id,
            actualMime: recording.type,
            bytes: recording.size,
            sha256: saved.value.contentHash,
            disposed: true
        });
    };
    const required = ['AudioPreviewPlayer：用户手势播放／暂停／seek／释放', '原生保存：CSV 精确字节', '原生保存：ZIP 精确字节', '原生保存：WAV 精确字节', '原生保存：取消窗口且无写入', '原生保存：已有目标拒绝且无写入', '实际故事板 DOM／图片／全文：第1集', '实际故事板 DOM／图片／全文：第2集'];
    const microphoneCapture = '真实麦克风：stop／实际 MIME／解码／设备释放';
    const microphoneSkip = '真实麦克风：无输入设备，按用户选择跳过';
    const microphoneSkipped = events.some(event => event.name === microphoneSkip && event.ok);
    const microphoneRequired = microphoneSkipped ? [] : [microphoneCapture, '真实麦克风：原始 MIME／字节仅本机保留', '真实麦克风：start 后立即 dispose／迟到设备释放'];
    const microphoneCompleted = microphoneSkipped || events.some(event => event.name === microphoneCapture && event.ok);
    const missing = [...required, ...microphoneRequired].filter(name => !events.some(event => event.name === name && event.ok));
    const denialSkip = '非主窗口 ACL／麦克风拒绝复核：无输入设备，按用户选择跳过';
    const denialSkipped = events.some(event => event.name === denialSkip && event.ok);
    const denialDone = denialConfirmed || denialSkipped;
    const finish = async () => {
        assert(started && !missing.length && printConfirmed && denialDone, '存在未完成的实际交互验收');
        assert(events.every(event => event.ok), '存在失败项，不能通过验收');
        evidence.record('非主窗口 ACL／麦克风真实拒绝复核', true, {
            observation: denialSkipped ? '用户确认当前设备无输入，暂跳过真实拒绝录音' : 'Root explicitly marked after actual denied-probe window inspection',
            nativeReceipt: 'coordinator CUA evidence; non-main window has no report capability',
            actualNotAllowedError: denialConfirmed,
            workspaceCommandDenied: true,
            acceptanceCommandDenied: true,
            requiresFollowUp: denialSkipped
        });
        evidence.record('系统打印预览人工复核', true, {
            observation: 'Root explicitly marked after actual native preview inspection',
            white: true,
            A4Landscape: true,
            applicationChromeHidden: true,
            bothEpisodes: true,
            multiPageFullText: true
        });
        evidence.record('打包验收完成', true, {
            pending: [...(microphoneSkipped ? [microphoneCapture] : []), ...(denialSkipped ? ['非主窗口 ACL／麦克风真实拒绝复核'] : [])],
            paidRequests: 0
        });
        await evidence.persist(true);
        setFinished(true);
    };
    return <section className="acceptance-panel">
        <div className="acceptance-controls"><h2>打包兼容性验收</h2>
            <p>仅使用本机临时项目和免费流端点。文档／媒体检查与系统交互分别记录，首次失败会保留。</p>
            <div className="prototype-toolbar"><Button disabled={busy || started}
                                                       onClick={() => void run(runAll)}>开始自动检查</Button><Button
                variant="outline" disabled={busy}
                onClick={() => void run(() => evidence.persist())}>保存当前报告</Button><span
                role="status">{status}</span></div>
            <div className="prototype-toolbar"><Button variant="outline" disabled={busy || finished}
                                                       onClick={() => void run(async () => {
                                                           await checkNativeLocks(evidence);
                                                           setStatus('原生 Web Locks 独立探针已记录；整套验收仍需分别完成。');
                                                       })}>验证原生 Web Locks</Button><span className="prototype-meta">独立检查实际默认锁管理器，不运行工作区 setup、录音或打印，不完成整套验收。</span>
            </div>
            <div className="prototype-toolbar"><Button
                disabled={busy || !audio || events.some(event => event.ok && event.name === required[0])}
                onClick={() => void run(async () => {
                    assert(audio, '音频未准备好');
                    await checkPlayback(audio, evidence);
                })}>播放、暂停并跳转音频</Button>
                <Button variant="outline" disabled={busy || !delivery} onClick={() => void run(async () => {
                    assert(delivery, 'CSV 未准备好');
                    await exportBlob('csv', delivery.csv);
                })}>保存 CSV</Button>
                <Button variant="outline" disabled={busy || !delivery} onClick={() => void run(async () => {
                    assert(delivery, 'ZIP 未准备好');
                    await exportBlob('zip', delivery.zip);
                })}>保存 ZIP</Button>
                <Button variant="outline" disabled={busy || !audio} onClick={() => void run(async () => {
                    assert(audio, 'WAV 未准备好');
                    await exportBlob('wav', audio.wav);
                })}>保存混音 WAV</Button>
                <Button variant="outline" disabled={busy || !delivery} onClick={() => void run(async () => {
                    assert(delivery, 'CSV 未准备好');
                    await exportBlob('csv', delivery.csv, 'cancel');
                })}>验证取消保存</Button>
                <Button variant="outline" disabled={busy || !delivery} onClick={() => void run(async () => {
                    assert(delivery, 'CSV 未准备好');
                    await exportBlob('csv', delivery.csv, 'existing');
                })}>验证已有目标拒绝</Button></div>
            <div className="prototype-toolbar"><Button
                disabled={busy || !projectId || ['requesting', 'recording', 'stopping'].includes(recordingState)}
                onClick={() => void run(start)}>录音约 3 秒</Button><Button variant="outline"
                                                                            disabled={busy || recordingState !== 'recording'}
                                                                            onClick={() => void run(stop)}>停止录音</Button>
                <Button disabled={busy || !recording || recordingKept}
                        onClick={() => void run(keep)}>仅保留到本机工作区</Button>
                <Button variant="outline" disabled={busy || !recordingKept}
                        onClick={() => void run(() => checkLateDisposal(setRecordingState, evidence))}>验证立即舍弃与释放</Button>
                <Button variant="outline" disabled={busy || !recording} onClick={() => void run(async () => {
                    assert(recording, '没有实际录音');
                    const decoded = await decodeAudioBlob(recording);
                    await exportBlob('wav', encodePcm16Wav(decoded).blob);
                })}>另存录音为 WAV</Button><span role="status">录音状态：{recordingState}</span></div>
            <Button variant="outline" disabled={busy || !started || microphoneCompleted} onClick={() => void run(() => {
                evidence.record(microphoneSkip, true, {
                    reason: '用户确认当前设备暂时无法接入麦克风',
                    requiresFollowUp: true
                });
                setStatus('已跳过真实录音；最终报告会保留待补验项目。');
                return Promise.resolve();
            })}>暂跳过真实麦克风验收（无输入设备）</Button>
            <p className="prototype-meta">权限拒绝只在真实拒绝发生时记录；已有授权的成功录音不会被描述为拒绝验证。完整系统预览需要实际查看。</p>
            <Button variant="outline" disabled={busy} onClick={() => void run(async () => {
                await acceptanceRequest({type: 'openDeniedProbe'});
                setStatus('请在新开的拒绝窗口点击测试，再回此窗口记录实际复核。');
            })}>打开拒绝权限窗口</Button>
            <Button variant="outline" disabled={busy || !started || denialDone} onClick={() => void run(() => {
                evidence.record(denialSkip, true, {
                    reason: '用户确认当前设备暂时无法接入麦克风',
                    requiresFollowUp: true
                });
                setStatus('已跳过真实拒绝复核；最终报告会保留待补验项目。');
                return Promise.resolve();
            })}>暂跳过拒绝权限复核（无输入设备）</Button>
            <label className="acceptance-confirm"><input type="checkbox" checked={denialConfirmed}
                                                         onChange={event => setDenialConfirmed(event.target.checked)}
                                                         disabled={busy}/>已实际查看拒绝窗口：麦克风
                NotAllowedError，工作区与验收命令均拒绝</label>
            <label className="acceptance-confirm"><input type="checkbox" checked={printConfirmed}
                                                         onChange={event => setPrintConfirmed(event.target.checked)}
                                                         disabled={!delivery || busy}/>已在系统预览复核两集：白底、A4
                横向、无应用导航、多页全文完整</label>
            <p>尚待交互：{missing.length ? missing.join('；') : '无'}{events.some(event => !event.ok) ? '。有失败项，保持本轮证据并修复后重新启动验收。' : ''}</p>
            <Button
                disabled={busy || !started || !!missing.length || !printConfirmed || !denialDone || events.some(event => !event.ok) || finished}
                onClick={() => void run(finish)}>完成验收并保存最终报告</Button>
        </div>
        <div ref={host} className="acceptance-media acceptance-controls"/>
        <ol className="acceptance-log" aria-live="polite">{events.map((event, index) => <li key={index}
                                                                                            data-ok={event.ok}
                                                                                            data-skipped={eventIsSkipped(event)}>{eventIsSkipped(event) ? '跳过' : event.ok ? '通过' : '失败'} · {event.name}
            <details>
                <summary>依据</summary>
                <pre>{JSON.stringify(event.detail, null, 2)}</pre>
            </details>
        </li>)}</ol>
        {delivery ? <AcceptancePrint evidence={evidence}/> : null}
    </section>;
}

function DeniedProbe() {
    const [events, setEvents] = useState<AcceptanceEvent[]>([]);
    const [busy, setBusy] = useState(false);
    const [evidence] = useState(() => new Evidence(setEvents));
    const recorder = useRef<MicrophoneRecorder | undefined>(undefined);
    useEffect(() => () => recorder.current?.dispose(), []);
    const run = async () => {
        setBusy(true);
        try {
            const live = new MicrophoneRecorder();
            recorder.current = live;
            const microphone = live.start().then(() => ({error: undefined as unknown}), (error: unknown) => ({error}));
            for (const command of ['workspace_request', 'acceptance_request']) await evidence.check(`非主窗口 ACL 拒绝：${command}`, () => rejects(() => invoke(command, {
                request: command === 'workspace_request' ? {
                    version: 1,
                    operationId: crypto.randomUUID(),
                    expectedGeneration: 0,
                    action: {type: 'state'}
                } : {version: 1, action: {type: 'report', json: '{}'}}
            })), error => ({error}));
            const {error} = await microphone;
            const denied = error instanceof DOMException && error.name === 'NotAllowedError';
            evidence.record('真实麦克风必须被原生 Deny 拒绝', denied, {
                error: error === undefined ? 'Unexpected granted capture' : message(error),
                state: live.state,
                realBrowserDevices: true,
                retained: false
            });
            live.dispose();
            evidence.record('真实拒绝后 recorder dispose', live.state === 'discarded', {
                state: live.state,
                blobPresent: live.blob !== undefined
            });
        } catch (error) {
            evidence.record('拒绝窗口实际错误', false, {error: message(error)});
        } finally {
            setBusy(false);
        }
    };
    return <main className="denied-probe dark"><h1>非主窗口与麦克风拒绝验证</h1>
        <p>此窗口没有工作区、报告或文件权限。原生层固定拒绝麦克风。仅点击后调用真实录音器，不保存录音。</p><Button
            disabled={busy || events.length > 0} onClick={() => void run()}>检查实际拒绝结果</Button><p
            role="status">{busy ? '正在验证真实拒绝…' : '由主验收窗口记录人工复核。'}</p>
        <ol className="acceptance-log">{events.map((event, index) => <li key={index}
                                                                         data-ok={event.ok}>{event.ok ? '通过' : '失败'} · {event.name}
            <pre>{JSON.stringify(event.detail, null, 2)}</pre>
        </li>)}</ol>
    </main>;
}

export default function Acceptance(props: { refresh: () => Promise<void> }) {
    return getCurrentWebviewWindow().label === 'denied-probe' ? <DeniedProbe/> : <AcceptanceMain {...props}/>;
}
