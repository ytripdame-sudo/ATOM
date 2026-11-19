import test from 'node:test';
import assert from 'node:assert/strict';

import { takeSentences, speakable } from '../extension/lib/voice/sentences.js';
import {
  base64ToBytes,
  transcribeAudio,
  transcriptionUrl,
  VoiceError,
} from '../extension/lib/voice/transcribe.js';
import { normalizeSettings, publicSettings } from '../extension/lib/settings.js';

/* ------------------------------------------------------------- sentences */

test('a streamed sentence is released as soon as its full stop arrives', () => {
  const first = takeSentences('Sure. The page is a');
  assert.deepEqual(first.sentences, ['Sure.']);
  assert.equal(first.rest, 'The page is a');

  // The next delta completes the sentence; both halves are spoken in order.
  const second = takeSentences(`${first.rest} login form.`);
  assert.deepEqual(second.sentences, ['The page is a login form.']);
  assert.equal(second.rest, '');
});

test('a tail with no full stop waits for the answer to finish', () => {
  const { sentences, rest } = takeSentences('It has two fields');
  assert.deepEqual(sentences, []);
  assert.equal(rest, 'It has two fields');
});

test('a decimal is not the end of a sentence', () => {
  const { sentences, rest } = takeSentences('The price is 3.5 dollars. Next');
  assert.deepEqual(sentences, ['The price is 3.5 dollars.']);
  assert.equal(rest, 'Next');
});

test('a burst of sentences is all returned, in order', () => {
  const { sentences } = takeSentences('One. Two. Three. Four.');
  assert.deepEqual(sentences, ['One.', 'Two.', 'Three.', 'Four.']);
});

test('markdown is stripped before it is spoken', () => {
  const spoken = speakable('## Done\n\n- **Bold** and `code` and [a link](https://example.com)\n```js\nconst x = 1;\n```');
  assert.doesNotMatch(spoken, /#|\*|`|https?:/);
  assert.doesNotMatch(spoken, /const x/);
  assert.match(spoken, /Done/);
  assert.match(spoken, /a link/);
});

/* ---------------------------------------------------------- transcription */

const BYTES = btoa('fake audio bytes');

test('a transcript comes back trimmed, with the model and key in place', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ text: '  hello there  ' }) };
  };

  const text = await transcribeAudio({ audio: BYTES, url: 'https://x.test/v1/audio/transcriptions', key: 'k1', fetchImpl });

  assert.equal(text, 'hello there');
  assert.equal(calls[0].url, 'https://x.test/v1/audio/transcriptions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k1');
  assert.equal(calls[0].init.body.get('model'), 'whisper-large-v3-turbo');
  assert.equal(calls[0].init.body.get('file').type, 'audio/webm');
});

test('the custom endpoint is used when one is saved', () => {
  assert.equal(transcriptionUrl('http://localhost:1234/v1'), 'http://localhost:1234/v1/audio/transcriptions');
  assert.equal(transcriptionUrl(''), 'https://api.groq.com/openai/v1/audio/transcriptions');
});

test('a rejected key says so in one short line', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(
    () => transcribeAudio({ audio: BYTES, url: 'https://x.test', key: 'bad', fetchImpl }),
    (error) => error instanceof VoiceError && error.code === 'auth' && /key was rejected/.test(error.message),
  );
});

test('an unreachable server is a network error, not a crash', async () => {
  const fetchImpl = async () => {
    throw new Error('offline');
  };
  await assert.rejects(
    () => transcribeAudio({ audio: BYTES, url: 'https://x.test', key: 'k', fetchImpl }),
    (error) => error.code === 'network',
  );
});

test('an empty recording never reaches the network', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({ text: 'x' }) };
  };

  await assert.rejects(() => transcribeAudio({ audio: '', url: 'https://x.test', key: 'k', fetchImpl }), (error) => {
    return error.code === 'empty';
  });
  assert.equal(called, false);
});

test('base64 audio becomes the same bytes again', () => {
  const bytes = new Uint8Array([1, 2, 3, 250]);
  assert.deepEqual([...base64ToBytes(btoa(String.fromCharCode(...bytes)))], [...bytes]);
  assert.deepEqual([...base64ToBytes(`data:audio/webm;base64,${btoa('ab')}`)], [97, 98]);
});

/* ---------------------------------------------------------------- settings */

test('voice settings are clamped, and a bad endpoint is refused', () => {
  const settings = normalizeSettings({
    voice: { enabled: 'yes', rate: 40, volume: -3, endpoint: 'javascript:alert(1)', stt: 'telepathy', provider: 'http' },
  });

  assert.equal(settings.voice.enabled, false, 'only a real boolean turns it on');
  assert.equal(settings.voice.rate, 2);
  assert.equal(settings.voice.volume, 0);
  assert.equal(settings.voice.endpoint, '');
  assert.equal(settings.voice.stt, 'auto');
  assert.equal(settings.voice.provider, 'http');
});

test('the panel never sees the custom voice token', () => {
  const settings = normalizeSettings({
    voice: { enabled: true, endpoint: 'https://voice.test/say', key: 'secret-token' },
  });
  const shown = publicSettings(settings);

  assert.equal(shown.voice.hasKey, true);
  assert.equal(shown.voice.key, undefined);
  assert.ok(!JSON.stringify(shown).includes('secret-token'));
});
