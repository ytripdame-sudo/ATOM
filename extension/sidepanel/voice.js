/**
 * Voice, loaded on first use and never before: the panel imports this the first
 * time the user presses the mic or turns speaking on, so a browser with no
 * microphone support and a user who never asks pays nothing.
 *
 * Two directions, one module:
 *  - listening: the browser's SpeechRecognition when it exists, otherwise
 *    MediaRecorder and the worker's Whisper endpoint. Interim words go into the
 *    composer as they are heard; the sentence is sent when recognition ends.
 *  - speaking: the reply is split into sentences as it streams and played one
 *    at a time, so the first sentence is heard while the rest is still arriving.
 *    Browser speechSynthesis by default; a custom HTTP voice can replace it.
 */
import { takeSentences, speakable } from '../lib/voice/sentences.js';

const Recognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

/** One utterance of a long answer is not worth the wait; this is per message. */
const MAX_SPOKEN_CHARS = 2000;
/** A recording has to be stopped eventually: 60 s is one sentence, not a podcast. */
const MAX_RECORD_MS = 60_000;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * @param {object} ctx
 * @param {(message: object) => void} ctx.send        port message
 * @param {(text: string, sticky?: boolean) => void} ctx.status
 * @param {HTMLTextAreaElement} ctx.input
 * @param {HTMLButtonElement} ctx.mic
 * @param {() => object} ctx.getVoice               current voice settings
 * @param {(text: string) => void} ctx.sendText     put the transcript in and send it
 * @param {() => boolean} ctx.isBusy
 * @param {(listening: boolean) => void} [ctx.onListening]
 * @param {(speaking: boolean) => void} [ctx.onSpeaking]
 */
export function createVoice(ctx) {
  let cfg = { ...norm(ctx.getVoice?.() || {}) };
  let voices = [];
  let listening = false;
  let mode = '';
  let recognition = null;
  let recorder = null;
  let stream = null;
  let chunks = [];
  let recordTimer = 0;
  let draft = '';
  let heard = '';
  let aborted = false;

  // Speaking
  let queue = [];
  let busy = false;
  let pending = '';
  let spokenChars = 0;
  const fed = new Map();
  let audio = null;
  let audioDone = null;
  let cancelled = false;
  let remoteWarned = false;

  const mic = ctx.mic;
  const input = ctx.input;
  let pressAt = 0;
  let pressing = false;

  /* ------------------------------------------------------------- speaking */

  function setSettings(voice) {
    cfg = { ...norm(voice || {}) };
    if (!cfg.enabled) stopSpeaking();
    if (cfg.provider === 'browser') refreshVoices();
  }

  /** Streamed text for one message; unchanged text is ignored. */
  function feed(id, text) {
    if (!cfg.enabled || !text) return;
    const seen = fed.get(id) || 0;
    if (text.length <= seen) return;
    fed.set(id, text.length);
    push(text.slice(seen));
  }

  /** The answer finished: speak whatever tail has no sentence ending yet. */
  function finish(id, text) {
    if (!cfg.enabled) return;
    if (text) feed(id, text);
    fed.delete(id);
    const tail = speakable(pending);
    pending = '';
    if (tail) enqueue(tail);
  }

  function push(delta) {
    pending += delta;
    const { sentences, rest } = takeSentences(pending);
    pending = rest;
    for (const sentence of sentences) enqueue(sentence);
  }

  function enqueue(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    if (spokenChars >= MAX_SPOKEN_CHARS) return;
    spokenChars += clean.length;
    queue.push(clean);
    pump();
  }

  async function pump() {
    if (busy || !queue.length) {
      if (!busy && !queue.length) idle();
      return;
    }

    busy = true;
    cancelled = false;
    ctx.onSpeaking?.(true);
    const text = queue.shift();

    try {
      if (cfg.provider === 'http' && cfg.endpoint) await speakRemote(text);
      else await speakBrowser(text);
    } catch {
      // A voice that cannot speak must not strand the queue.
      if (cfg.provider === 'http' && !remoteWarned) {
        remoteWarned = true;
        ctx.status('The custom voice did not answer — using the browser voice instead.');
      }
      try {
        await speakBrowser(text);
      } catch {
        /* nothing else to try */
      }
    } finally {
      busy = false;
      ctx.onSpeaking?.(Boolean(queue.length));
      // A cancel (barge-in, a new turn) is not an idle moment: idle() would
      // immediately reopen the mic on top of the one the user just pressed.
      if (!cancelled) {
        if (!queue.length) idle();
        else pump();
      }
    }
  }

  /** After the last sentence: hands-free starts listening again. */
  function idle() {
    ctx.onSpeaking?.(false);
    if (cancelled || !cfg.handsFree || listening || ctx.isBusy?.()) return;
    start();
  }

  function speakBrowser(text) {
    return new Promise((resolve, reject) => {
      if (!('speechSynthesis' in window)) {
        reject(new Error('no speech synthesis'));
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = voices.find((entry) => entry.voiceURI === cfg.voiceURI);
      if (voice) utterance.voice = voice;
      utterance.rate = cfg.rate;
      utterance.volume = cfg.volume;
      utterance.lang = voice?.lang || navigator.language || 'en-US';

      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      utterance.onend = done;
      // 'interrupted' and 'canceled' arrive when stopSpeaking() cancels us.
      utterance.onerror = () => done();

      try {
        window.speechSynthesis.speak(utterance);
      } catch (error) {
        reject(error);
      }
    });
  }

  async function speakRemote(text) {
    const headers = { 'content-type': 'application/json' };
    if (cfg.key) headers.authorization = `Bearer ${cfg.key}`;

    const response = await fetch(cfg.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, voice: 'Justin', speed: cfg.rate, volume: cfg.volume }),
    });
    if (!response.ok) throw new Error(`voice endpoint ${response.status}`);

    const blob = await response.blob();
    if (cancelled) return;

    const url = URL.createObjectURL(blob);
    audio = new Audio(url);
    audio.volume = cfg.volume;
    audio.playbackRate = cfg.rate;

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        audioDone = null;
        URL.revokeObjectURL(url);
        audio = null;
        resolve();
      };
      audioDone = done;
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
    });
  }

  /** Barge-in: the whole queue goes, not just the sentence being spoken. */
  function stopSpeaking() {
    cancelled = true;
    queue = [];
    pending = '';
    spokenChars = 0;
    fed.clear();
    busy = false;
    ctx.onSpeaking?.(false);

    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* nothing playing */
    }
    if (audio) {
      audio.pause();
      // Pausing never fires 'ended', so the promise is settled here or it hangs.
      audioDone?.();
      audio = null;
    }
  }

  function refreshVoices() {
    if (!('speechSynthesis' in window)) return;
    try {
      voices = window.speechSynthesis.getVoices() || [];
    } catch {
      voices = [];
    }
  }

  function listVoices() {
    refreshVoices();
    return voices.map((voice) => ({ uri: voice.voiceURI, name: voice.name, lang: voice.lang }));
  }

  /* ------------------------------------------------------------ listening */

  function start() {
    if (listening) return;
    stopSpeaking();
    aborted = false;

    const wantsBrowser = cfg.stt === 'browser' || (cfg.stt === 'auto' && Boolean(Recognition));
    if (wantsBrowser && Recognition) return startRecognition();

    // Firefox and anything without SpeechRecognition records and uploads.
    if (typeof MediaRecorder !== 'undefined' && navigator.mediaDevices?.getUserMedia) return startRecorder();

    ctx.status('This browser cannot record speech — try Chrome or Edge.');
    return undefined;
  }

  function startRecognition() {
    try {
      recognition = new Recognition();
    } catch {
      return startRecorder();
    }

    draft = draftValue();
    heard = '';
    recognition.lang = navigator.language || 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      listening = true;
      mode = 'recognition';
      markListening(true);
    };

    recognition.onresult = (event) => {
      let interim = '';
      let finalText = '';

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript || '';
        if (result.isFinal) finalText += text;
        else interim += text;
      }

      if (finalText) heard += finalText;
      // Speaking over ATOM is the other half of barge-in.
      if (interim || finalText) stopSpeaking();
      setInput(`${draft}${heard}${interim}`.trimStart());
    };

    recognition.onerror = (event) => {
      const code = event?.error || '';
      if (code === 'aborted') return;
      aborted = code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture';
      ctx.status(recognitionMessage(code));
    };

    recognition.onend = () => {
      listening = false;
      mode = '';
      markListening(false);

      const text = `${draft}${heard}`.trim();
      if (text && heard.trim() && !aborted) return deliver(text);
      if (!aborted && !heard.trim()) {
        ctx.status('Didn’t catch that — try again.');
        setInput(draft.trimEnd());
      } else {
        setInput(draft.trimEnd());
      }
      return undefined;
    };

    try {
      recognition.start();
    } catch {
      ctx.status('The microphone could not start.');
      markListening(false);
    }
    return undefined;
  }

  async function startRecorder() {
    markListening(true);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      markListening(false);
      ctx.status(micMessage(error));
      return;
    }

    chunks = [];
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(
      (candidate) => typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(candidate),
    );

    try {
      recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
    } catch {
      teardownStream();
      markListening(false);
      ctx.status('This browser could not start recording.');
      return;
    }

    draft = draftValue();
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' });
      chunks = [];
      recorder = null;
      teardownStream();
      markListening(false);
      upload(blob);
    };

    try {
      recorder.start();
      listening = true;
      mode = 'recorder';
      clearTimeout(recordTimer);
      recordTimer = setTimeout(() => {
        if (listening) stopListening();
      }, MAX_RECORD_MS);
    } catch {
      teardownStream();
      markListening(false);
      ctx.status('Recording could not start.');
    }
  }

  async function upload(blob) {
    if (!blob || blob.size < 1200) {
      ctx.status('Didn’t catch that — try again.');
      setInput(draft.trimEnd());
      return;
    }
    if (blob.size > MAX_UPLOAD_BYTES) {
      ctx.status('That recording is too long — keep it under a minute.');
      setInput(draft.trimEnd());
      return;
    }

    const id = `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    pendingIds.add(id);
    ctx.status('Transcribing…', true);

    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      ctx.send({
        t: 'voice.transcribe',
        id,
        audio: toBase64(bytes),
        mime: blob.type || 'audio/webm',
        lang: navigator.language || '',
      });
    } catch {
      pendingIds.delete(id);
      ctx.status('That recording could not be read.');
    }
  }

  const pendingIds = new Set();

  /** The worker's transcript, or its one-line reason. */
  function onTranscript(event) {
    const id = String(event?.id || '');
    if (!pendingIds.has(id)) return;
    pendingIds.delete(id);

    if (event.error) {
      ctx.status(event.error);
      setInput(draft.trimEnd());
      return;
    }
    const text = String(event.text || '').trim();
    if (!text) {
      ctx.status('Didn’t catch that — try again.');
      return;
    }
    deliver(text);
  }

  function deliver(text) {
    const value = String(text || '').trim();
    if (!value) return;
    setInput('');
    ctx.sendText(value);
  }

  function stopListening() {
    if (mode === 'recognition' && recognition) {
      try {
        recognition.stop();
      } catch {
        /* already stopped */
      }
    }
    if (mode === 'recorder' && recorder) {
      try {
        recorder.stop();
      } catch {
        /* already stopped */
      }
    }
    clearTimeout(recordTimer);
    listening = false;
  }

  function toggle() {
    if (listening) stopListening();
    else start();
  }

  /* -------------------------------------------------------------- helpers */

  function draftValue() {
    const current = String(input?.value || '');
    return current && !current.endsWith(' ') ? `${current} ` : current;
  }

  function setInput(value) {
    if (!input) return;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function markListening(on) {
    listening = Boolean(on);
    ctx.onListening?.(listening);
  }

  function teardownStream() {
    for (const track of stream?.getTracks?.() || []) track.stop();
    stream = null;
  }

  function micMessage(error) {
    const name = error?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Microphone blocked — allow it for ATOM in the browser’s extension settings.';
    }
    if (name === 'NotFoundError') return 'No microphone was found.';
    if (name === 'NotReadableError') return 'The microphone is in use by another app.';
    return 'The microphone did not start.';
  }

  function recognitionMessage(code) {
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      return 'Microphone blocked — allow it for ATOM in the browser’s extension settings.';
    }
    if (code === 'audio-capture') return 'No microphone was found.';
    if (code === 'network') return 'Speech recognition needs a connection, and it could not reach the service.';
    return 'Didn’t catch that — try again.';
  }

  /**
   * Push-to-talk on hold, tap to toggle: the same button does both. The panel
   * binds the events, because the module is imported on the first press and a
   * gesture must not be lost to that import.
   */
  function press() {
    pressAt = Date.now();
    pressing = true;
    if (listening) stopListening();
    else start();
  }

  function release() {
    if (!pressing) return;
    pressing = false;
    // A quick tap leaves the mic open; a hold stops when it is released.
    if (listening && Date.now() - pressAt > 320) stopListening();
  }

  /** The Settings button that proves the voice works without spending a turn. */
  function speakSample() {
    stopSpeaking();
    enqueue('Voice ready. This is how I sound at this speed.');
  }

  refreshVoices();
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
  }

  return {
    press,
    release,
    speakSample,
    setSettings,
    feed,
    finish,
    stop: stopSpeaking,
    toggle,
    start,
    stopListening,
    onTranscript,
    listVoices,
    get listening() {
      return listening;
    },
    get speaking() {
      return busy;
    },
  };
}

function norm(voice) {
  return {
    enabled: voice.enabled === true,
    handsFree: voice.handsFree === true,
    provider: voice.provider === 'http' ? 'http' : 'browser',
    voiceURI: String(voice.voiceURI || ''),
    rate: Number(voice.rate) > 0 ? Number(voice.rate) : 1,
    volume: Number.isFinite(Number(voice.volume)) ? Number(voice.volume) : 1,
    endpoint: String(voice.endpoint || ''),
    key: String(voice.key || ''),
    stt: ['auto', 'browser', 'whisper'].includes(voice.stt) ? voice.stt : 'auto',
  };
}

function toBase64(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}
