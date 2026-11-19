import test from 'node:test';
import assert from 'node:assert/strict';

import { modelVision, providerMeta } from '../extension/lib/providers/index.js';
import { toProviderMessages, estimateTokens } from '../extension/lib/session.js';

const settings = { provider: 'groq', model: 'qwen/qwen3.8-27b' };
const IMAGE = 'data:image/jpeg;base64,AAAA';
const OLD_IMAGE = 'data:image/png;base64,BBBB';

function call(id, name) {
  return { id, type: 'function', function: { name, arguments: '{}' } };
}

function screenshotMessages(image = IMAGE) {
  return [
    { id: 'u1', role: 'user', text: 'look at it', status: 'done' },
    {
      id: 'a1',
      role: 'assistant',
      text: '',
      status: 'done',
      toolCalls: [call('call_1', 'screenshot')],
    },
    {
      id: 't1',
      role: 'tool',
      text: 'Captured the visible part of “Example”.',
      toolCallId: 'call_1',
      name: 'screenshot',
      status: 'done',
      tool: { name: 'screenshot', status: 'done', image },
    },
  ];
}

test('only models documented as multimodal are marked for vision', () => {
  assert.equal(modelVision(settings), true);
  assert.equal(modelVision({ provider: 'groq', model: 'openai/gpt-oss-120b' }), false);
  assert.equal(modelVision({ provider: 'gemini', model: 'gemini-2.5-flash' }), true);
  assert.equal(modelVision({ provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' }), false);
  assert.equal(modelVision({ provider: 'custom', model: 'local-model' }), false);

  const meta = providerMeta(settings);
  const qwen = meta.providers
    .find((provider) => provider.id === 'groq')
    .models.find((model) => model.id === 'qwen/qwen3.8-27b');
  assert.equal(qwen.vision, true);
});

test('a vision model receives the screenshot as an image part after the tool result', () => {
  const out = toProviderMessages({
    messages: screenshotMessages(),
    settings,
    tab: null,
    capabilities: { pageAccess: true, agent: 'playground', vision: true },
  });

  const tool = out.find((message) => message.role === 'tool');
  assert.equal(tool.content.includes(IMAGE), false, 'the tool text itself stays text');

  const attachment = out.find((message) => message.role === 'user' && Array.isArray(message.content));
  assert.ok(attachment, 'an image message follows the tool result');
  assert.equal(attachment.content[1].type, 'image_url');
  assert.equal(attachment.content[1].image_url.url, IMAGE);
  assert.match(attachment.content[0].text, /untrusted page data/i);
  assert.ok(out.indexOf(attachment) > out.indexOf(tool), 'the image follows the result it belongs to');
});

test('a text-only model gets no image data and is told it cannot see pictures', () => {
  const out = toProviderMessages({
    messages: screenshotMessages(),
    settings: { provider: 'groq', model: 'openai/gpt-oss-120b' },
    tab: null,
    capabilities: { pageAccess: true, agent: 'playground', vision: false },
  });

  assert.equal(JSON.stringify(out).includes(IMAGE), false);
  assert.equal(out.some((message) => Array.isArray(message.content)), false);
  assert.match(out[0].content, /cannot see images/i);
});

test('a vision model is told the picture is attached on the next request', () => {
  const out = toProviderMessages({
    messages: screenshotMessages(),
    settings,
    tab: null,
    capabilities: { pageAccess: true, agent: 'playground', vision: true },
  });
  assert.match(out[0].content, /sees images/i);
  assert.match(out[0].content, /attaches the picture to your next request/i);
});

test('compaction drops the bytes of an old screenshot but keeps the newest', () => {
  const calls = Array.from({ length: 6 }, (_, index) => call(`call_${index}`, 'screenshot'));
  const results = calls.map((entry, index) => ({
    id: `t${index}`,
    role: 'tool',
    text: `Screenshot ${index}`,
    toolCallId: entry.id,
    name: 'screenshot',
    status: 'done',
    tool: {
      name: 'screenshot',
      status: 'done',
      image: index === 0 ? OLD_IMAGE : `data:image/jpeg;base64,NEW${index}`,
    },
  }));

  const out = toProviderMessages({
    messages: [
      { id: 'u1', role: 'user', text: 'many screenshots', status: 'done' },
      { id: 'a1', role: 'assistant', text: '', status: 'done', toolCalls: calls },
      ...results,
    ],
    settings,
    tab: null,
    capabilities: { pageAccess: true, agent: 'playground', vision: true },
  });

  const json = JSON.stringify(out);
  assert.equal(json.includes(OLD_IMAGE), false, 'the compressed result lost its image');
  assert.match(json, /NEW5/, 'the newest screenshot still travels');
});

test('a request never carries more than three images, keeping the newest', () => {
  const pairs = [0, 1, 2, 3].map((index) => ({
    user: { id: `u${index}`, role: 'user', text: `turn ${index}`, status: 'done' },
    assistant: {
      id: `a${index}`,
      role: 'assistant',
      text: '',
      status: 'done',
      toolCalls: [call(`call_${index}`, 'screenshot')],
    },
    tool: {
      id: `t${index}`,
      role: 'tool',
      text: `Screenshot ${index}`,
      toolCallId: `call_${index}`,
      name: 'screenshot',
      status: 'done',
      tool: { name: 'screenshot', status: 'done', image: `data:image/jpeg;base64,IMG${index}` },
    },
  }));

  const out = toProviderMessages({
    messages: pairs.flatMap((pair) => [pair.user, pair.assistant, pair.tool]),
    settings,
    tab: null,
    capabilities: { pageAccess: true, agent: 'playground', vision: true },
  });

  const images = out.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url') : [],
  );
  assert.equal(images.length, 3);
  const urls = images.map((part) => part.image_url.url);
  assert.deepEqual(urls, ['data:image/jpeg;base64,IMG1', 'data:image/jpeg;base64,IMG2', 'data:image/jpeg;base64,IMG3']);
});

test('token estimates include attached pictures', () => {
  const textOnly = estimateTokens([{ role: 'user', content: 'hello' }]);
  const withImage = estimateTokens([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: IMAGE } },
      ],
    },
  ]);
  assert.ok(withImage >= textOnly + 800, `expected an image-sized allowance, got ${withImage}`);
});
