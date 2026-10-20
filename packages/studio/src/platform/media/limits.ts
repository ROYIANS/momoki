import {MAX_JSON_BYTES} from '@momoki/agent-providers/http';
export {MAX_JSON_BYTES, MAX_ERROR_BYTES} from '@momoki/agent-providers/http';
/** Local application resource policies; these are not supplier limits. */
export const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
export const MAX_MEDIA_DOWNLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_SPEECH_ENVELOPE_BYTES = Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + MAX_JSON_BYTES;
