import {encodePcm16Wav} from '@momoki/studio/reference/lib/audio/wav';
export function wavFixture() {
    const length=96000;
    const channel=Float32Array.from({length},(_,i)=>Math.sin(i*2*Math.PI*440/48000)*0.03);
    return encodePcm16Wav({length,sampleRate:48000,numberOfChannels:1,getChannelData:()=>channel}).blob;
}
