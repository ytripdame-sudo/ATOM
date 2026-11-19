/**
 * Speech to text without the browser's SpeechRecognition: upload the recording
 * to a Whisper-compatible endpoint and read the transcript back.
 *
 * This runs in the service worker so the API key never reaches the panel, and
 * the endpoint is either Groq's Whisper or the user's own OpenAI-compatible
 * server — the same two places the keys already live.
 */

export const WHISPER_MODEL = 'whisper-large-v3-turbo';
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/** An error with a code the panel can turn into one short sentence. */
export class VoiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VoiceError';
    this.code = code;
  }
}

/** base64 → bytes, without Buffer (the worker has atob, not Node). */
export function base64ToBytes(value) {
  const clean = String(value || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (!clean) return new Uint8Array(0);

  let binary;
  try {
    binary = atob(clean);
  } catch {
    throw new VoiceError('empty', 'That recording could not be read.');
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The endpoint a recording goes to: the custom server if one is set. */
export function transcriptionUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  return base ? `${base}/audio/transcriptions` : 'https://api.groq.com/openai/v1/audio/transcriptions';
}

/**
 * @param {object} input
 * @param {string} input.audio   base64 audio
 * @param {string} [input.mime]  recorder's content type
 * @param {string} [input.lang]  BCP-47 hint, if the browser knows one
 * @param {string} input.url
 * @param {string} input.key
 * @param {string} [input.model]
 * @param {Function} [input.fetchImpl]
 * @param {Function} [input.FormDataImpl] [input.BlobImpl]
 * @returns {Promise<string>} the transcript, trimmed
 */
export async function transcribeAudio({
  audio,
  mime = 'audio/webm',
  lang = '',
  url,
  key,
  model = WHISPER_MODEL,
  fetchImpl = fetch,
  FormDataImpl,
  BlobImpl,
}) {
  const bytes = base64ToBytes(audio);
  if (!bytes.length) throw new VoiceError('empty', 'That recording was empty.');
  if (bytes.length > MAX_AUDIO_BYTES) throw new VoiceError('too_large', 'That recording is too long to transcribe.');

  const Form = FormDataImpl || FormData;
  const BlobType = BlobImpl || Blob;
  const form = new Form();
  form.append('file', new BlobType([bytes], { type: mime }), 'voice.webm');
  form.append('model', model);
  form.append('response_format', 'json');
  // A wrong language hint costs more than none: only send one that looks real.
  if (/^[a-z]{2}(-[A-Za-z]{2,8})?$/.test(String(lang || ''))) form.append('language', lang);

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
  } catch {
    throw new VoiceError('network', 'Could not reach the transcription server.');
  }

  if (response.status === 401 || response.status === 403) {
    throw new VoiceError('auth', 'The transcription key was rejected. Check the Groq key in Settings.');
  }
  if (response.status === 429) {
    throw new VoiceError('rate_limit', 'The transcription endpoint is rate limited. Try again in a moment.');
  }
  if (!response.ok) {
    throw new VoiceError('upstream', `The transcription endpoint failed (${response.status}).`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new VoiceError('upstream', 'The transcription endpoint sent something unreadable.');
  }

  const text = String(data?.text || '').trim();
  if (!text) throw new VoiceError('empty', 'No speech was recognised in that recording.');
  return text;
}
