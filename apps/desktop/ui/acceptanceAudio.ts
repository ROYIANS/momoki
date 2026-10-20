import {audioBufferMetadata, AudioPreviewPlayer, decodeAudioBlob, renderAudioMix} from '@momoki/studio/reference/lib/audio/engine';
import {type AudioSchedule, buildAudioSchedule, envelopeGainAt, seekAudioSchedule} from '@momoki/studio/reference/lib/audio/schedule';
import {detectAudioMime} from '@momoki/studio/reference/lib/audio/mime';
import {assert, delay, type Evidence, rejects} from './acceptanceEvidence';
import {fixture, type FixtureBlobs} from './acceptanceMedia';

export interface AudioFixture {
    schedule: AudioSchedule;
    buffers: Map<string, AudioBuffer>;
    wav: Blob;
    player: AudioPreviewPlayer
}

export async function checkAudio(blobs: FixtureBlobs, evidence: Evidence): Promise<AudioFixture | undefined> {
    const buffers = new Map<string, AudioBuffer>();
    for (const id of ['tone.wav', 'tone.mp3', 'tone.aac', 'tone.m4a']) {
        const buffer = await evidence.check(`真实音频解码：${id}`, async () => {
            const blob = fixture(blobs, id);
            const detected = await detectAudioMime(blob);
            const buffer = await decodeAudioBlob(blob);
            const lower = id === 'tone.mp3' ? 1.95 : 1.99;
            const upper = id === 'tone.mp3' || id === 'tone.aac' ? 2.15 : 2.05;
            assert(buffer.duration >= lower && buffer.duration <= upper, `${id} 解码时长不符`);
            assert(buffer.sampleRate === 48000 && buffer.numberOfChannels >= 1 && buffer.numberOfChannels <= 2, '音频解码参数不符');
            let energy = 0;
            for (const sample of buffer.getChannelData(0)) energy += sample * sample;
            assert(energy > 0.1, '音频没有实际非零样本');
            return {buffer, mime: detected, energy};
        }, value => ({...audioBufferMetadata(value.buffer), mime: value.mime, energy: value.energy}));
        if (buffer) buffers.set(id, buffer.buffer);
    }
    await evidence.check('损坏音频拒绝', () => rejects(() => decodeAudioBlob(new Blob(['corrupt'], {type: 'audio/wav'}))), error => ({error}));
    return evidence.check('双片段 OfflineAudioContext／淡入淡出／PCM16 WAV', async () => {
        const source = buffers.get('tone.wav');
        assert(source, 'WAV 解码缺失');
        const schedule = buildAudioSchedule({
            chapters: [{id: 'chapter', order: 0}],
            tracks: [{id: 'voice', chapterId: 'chapter', gain: 1, muted: false, solo: false}],
            takes: [{id: 'take', mediaId: 'tone.wav', ...audioBufferMetadata(source)}],
            clips: [
                {
                    id: 'a',
                    chapterId: 'chapter',
                    trackId: 'voice',
                    takeId: 'take',
                    startSec: 0.1,
                    trimStartSec: 0.2,
                    trimEndSec: 1.2,
                    gain: 0.5,
                    fadeInSec: 0.1,
                    fadeOutSec: 0.2
                },
                {
                    id: 'b',
                    chapterId: 'chapter',
                    trackId: 'voice',
                    takeId: 'take',
                    startSec: 0.65,
                    trimStartSec: 0.4,
                    trimEndSec: 1,
                    gain: 0.3,
                    fadeInSec: 0.05,
                    fadeOutSec: 0.1
                }]
        });
        assert(Math.abs(schedule.durationSec - 1.25) < 1e-9, '混音调度时长错误');
        const result = await renderAudioMix(schedule, buffers);
        const bytes = await result.blob.arrayBuffer();
        const view = new DataView(bytes);
        assert(new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && view.getUint16(22, true) === 2 && view.getUint32(24, true) === 48000, 'PCM16 WAV 头错误');
        assert(result.blob.size === 44 + Math.ceil(schedule.durationSec * 48000) * 4, 'WAV 样本数错误');
        const samples = [];
        for (const time of [0.03, 0.14, 0.3, 0.68, 0.83, 1.03, 1.22]) {
            const frame = Math.round(time * 48000);
            const actual = view.getInt16(44 + frame * 4, true) / 32768;
            const expected = schedule.clips.reduce((sum, clip) => {
                const elapsed = frame / 48000 - clip.startSec;
                if (elapsed < 0 || elapsed >= clip.durationSec) return sum;
                const index = Math.round((clip.offsetSec + elapsed) * 48000);
                return sum + (source.getChannelData(0)[index] ?? 0) * envelopeGainAt(clip.envelope, elapsed);
            }, 0);
            assert(Math.abs(actual - expected) < 0.0015, `混音实际样本与调度不符：${time}`);
            samples.push({time, actual, expected});
        }
        const decoded = await decodeAudioBlob(result.blob);
        assert(Math.abs(decoded.duration - 1.25) <= 1 / 48000, '混音 WAV 回读时长错误');
        const seek = seekAudioSchedule(schedule, 0.75);
        assert(seek.length === 2 && seek.every(clip => clip.startSec === 0), '实际 seek 调度错误');
        await rejects(() => renderAudioMix(schedule, new Map()));
        const controller = new AbortController();
        const pending = renderAudioMix(schedule, buffers, {signal: controller.signal});
        controller.abort(new DOMException('fixture mix abort', 'AbortError'));
        const aborted = await rejects(() => pending);
        assert(aborted.includes('AbortError'), '混音取消未保留中断');
        return {
            schedule,
            buffers,
            wav: result.blob,
            player: new AudioPreviewPlayer(),
            samples,
            peak: result.peak,
            attenuation: result.attenuation
        };
    }, value => ({
        duration: value.schedule.durationSec,
        clips: value.schedule.clips.length,
        bytes: value.wav.size,
        samples: value.samples,
        peak: value.peak,
        attenuation: value.attenuation,
        decoded: true,
        seek: true,
        missingBufferRejected: true,
        aborted: true
    }));
}

export async function checkPlayback(audio: AudioFixture, evidence: Evidence) {
    await evidence.check('AudioPreviewPlayer：用户手势播放／暂停／seek／释放', async () => {
        // play() constructs/resumes the actual AudioContext before its first await.
        let warmupRetry = false;
        await audio.player.play(audio.schedule, audio.buffers, 0);
        await delay(230);
        let before = audio.player.currentTime;
        // WebKit can resolve the first resume() call while its clock remains
        // suspended. Retry once inside this same explicit user action so the
        // acceptance records a real playback result without hiding a second
        // failure or looping on a browser-level permission problem.
        if (!audio.player.playing || before <= 0.1) {
            warmupRetry = true;
            await audio.player.play(audio.schedule, audio.buffers, 0);
            await delay(230);
            before = audio.player.currentTime;
        }
        assert(audio.player.playing && before > 0.1, '音频时间没有推进');
        const paused = audio.player.pause();
        await delay(100);
        assert(!audio.player.playing && Math.abs(audio.player.currentTime - paused) < 0.005, '音频暂停失败');
        await audio.player.seek(audio.schedule, audio.buffers, 0.75);
        await delay(150);
        const after = audio.player.currentTime;
        assert(after > 0.82 && after < 1.2, '音频 seek 没有实际推进');
        await audio.player.dispose();
        assert(!audio.player.playing, '音频未释放');
        return {before, paused, after, disposed: true, warmupRetry};
    }, value => value);
}
