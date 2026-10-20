import {MicrophoneRecorder, type RecorderDependencies, type RecordingState} from '@momoki/studio/reference/lib/audio/recorder';
import {decodeAudioBlob} from '@momoki/studio/reference/lib/audio/engine';
import {detectAudioMime} from '@momoki/studio/reference/lib/audio/mime';
import {assert, delay, type Evidence} from './acceptanceEvidence';

interface CaptureObservation {
    tracks: MediaStreamTrack[];
    contexts: AudioContext[];
    requests: number
}

async function waitForClosed(contexts: AudioContext[], timeoutMs = 1000) {
    const deadline = performance.now() + timeoutMs;
    while (contexts.some(context => context.state !== "closed") && performance.now() < deadline) await delay(25);
}

export interface LiveCapture {
    recorder: MicrophoneRecorder;
    observation: CaptureObservation;
    blob?: Blob
}

export function createCapture(onState: (state: RecordingState) => void): LiveCapture {
    const observation: CaptureObservation = {tracks: [], contexts: [], requests: 0};
    // Instrument actual browser objects. No fixture stream, mock recorder, fake clock or changed constraints.
    const dependencies: RecorderDependencies = {
        devices: {
            getUserMedia: async constraints => {
                assert(typeof navigator.mediaDevices?.getUserMedia === 'function', '打包 origin 未提供麦克风 API');
                observation.requests++;
                const stream = await navigator.mediaDevices.getUserMedia(constraints);
                observation.tracks.push(...stream.getTracks());
                return stream;
            }
        },
        isTypeSupported: mime => MediaRecorder.isTypeSupported(mime),
        createRecorder: (stream, options) => new MediaRecorder(stream, options),
        createContext: () => {
            const context = new AudioContext();
            observation.contexts.push(context);
            return context;
        },
        now: () => performance.now()
    };
    return {recorder: new MicrophoneRecorder({onState}, dependencies), observation};
}

export async function stoppedCapture(capture: LiveCapture, evidence: Evidence): Promise<Blob | undefined> {
    return evidence.check('真实麦克风：stop／实际 MIME／解码／设备释放', async () => {
        const blob = await capture.recorder.stop();
        const elapsed = capture.recorder.elapsedSec;
        capture.blob = blob;
        const mime = await detectAudioMime(blob);
        const decoded = await decodeAudioBlob(blob);
        await waitForClosed(capture.observation.contexts);
        await delay(100);
        assert(elapsed >= 2.7 && elapsed <= 4.5, '录音间隔不是约 3 秒');
        // WebKit's MediaRecorder can omit encoder priming/tail frames from the
        // decoded duration even when the wall-clock capture lasts about 3 s.
        assert(decoded.duration > 0 && decoded.duration <= 5, '实际录音解码时长不符');
        assert(capture.observation.tracks.length > 0 && capture.observation.tracks.every(track => track.readyState === 'ended'), '麦克风轨道没有释放');
        assert(capture.observation.contexts.every(context => context.state === 'closed'), '录音 AudioContext 没有关闭');
        return {
            blob,
            mime,
            elapsed,
            duration: decoded.duration,
            sampleRate: decoded.sampleRate,
            channels: decoded.numberOfChannels
        };
    }, value => ({
        mimeType: value.blob.type,
        detectedMime: value.mime,
        bytes: value.blob.size,
        elapsedSec: value.elapsed,
        decodedDurationSec: value.duration,
        sampleRate: value.sampleRate,
        channels: value.channels,
        realRequests: capture.observation.requests,
        trackStates: capture.observation.tracks.map(track => track.readyState),
        contextStates: capture.observation.contexts.map(context => context.state),
        scope: 'local disposable workspace only; requires explicit keep'
    })).then(value => value?.blob);
}

export async function checkLateDisposal(onState: (state: RecordingState) => void, evidence: Evidence) {
    const capture = createCapture(onState);
    await evidence.check('真实麦克风：start 后立即 dispose／迟到设备释放', async () => {
        // Start is invoked synchronously inside this explicitly clicked control; permission may resolve later.
        const pending = capture.recorder.start();
        capture.recorder.dispose();
        await pending;
        await waitForClosed(capture.observation.contexts);
        await delay(100);
        assert(capture.observation.tracks.every(track => track.readyState === 'ended'), '迟到权限返回的真实轨道未释放');
        assert(capture.observation.contexts.every(context => context.state === 'closed'), '立即 dispose 后 context 未关闭');
        assert(capture.recorder.blob === undefined && capture.recorder.state === 'discarded', 'dispose 留下录音或状态错误');
        return {
            realRequests: capture.observation.requests,
            tracksObserved: capture.observation.tracks.length,
            trackStates: capture.observation.tracks.map(track => track.readyState),
            contextStates: capture.observation.contexts.map(context => context.state),
            latePermission: 'actual API race; tracks may return before or after dispose, no fake deferred grant',
            retained: false
        };
    }, value => value);
}
