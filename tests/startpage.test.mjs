import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSettings, publicSettings } from '../extension/lib/settings.js';
import { customProvider, providerMeta, resolveProviders } from '../extension/lib/providers/index.js';
import { rotationCandidates } from '../extension/lib/providers/pool.js';
import { formatPageForModel, readBudget } from '../extension/lib/page.js';

test('the start page starts with a usable theme', () => {
  const theme = normalizeSettings({}).startpage;
  assert.equal(theme.background, 'aurora');
  assert.equal(theme.font, 'sans');
  assert.equal(theme.width, 'default');
  assert.equal(theme.clock, true);
  assert.deepEqual(theme.links, []);
});

test('junk in a theme is replaced by the default, not applied', () => {
  const theme = normalizeSettings({
    startpage: { background: 'lasers', color: 'red', accent: '#GGGGGG', font: 'cosmic', width: 'huge' },
  }).startpage;

  assert.equal(theme.background, 'aurora');
  assert.equal(theme.color, '#0b0e14');
  assert.equal(theme.accent, '#7aa2ff');
  assert.equal(theme.font, 'sans');
  assert.equal(theme.width, 'default');
});

test('quick links keep only http(s) addresses, with a title', () => {
  const theme = normalizeSettings({
    startpage: {
      links: [
        { title: 'YouTube', url: 'https://youtube.com' },
        { url: 'javascript:alert(1)' },
        { title: 'Files', url: 'file:///etc/passwd' },
        { title: 'Bare', url: 'http://example.test/x' },
      ],
    },
  }).startpage;

  assert.deepEqual(theme.links, [
    { title: 'YouTube', url: 'https://youtube.com' },
    { title: 'Bare', url: 'http://example.test/x' },
  ]);
});

test('an uploaded picture is kept only when it is an image data url of sane size', () => {
  const small = `data:image/png;base64,${'A'.repeat(64)}`;
  assert.equal(normalizeSettings({ startpage: { image: small } }).startpage.image, small);

  const huge = `data:image/png;base64,${'A'.repeat(2_600_000)}`;
  assert.equal(normalizeSettings({ startpage: { image: huge } }).startpage.image, '');
  assert.equal(normalizeSettings({ startpage: { image: 'http://insecure.test/a.png' } }).startpage.image, '');
});

test('a custom endpoint becomes a provider, with no key when it is local', () => {
  const provider = customProvider({ baseUrl: 'http://localhost:11434/v1/', model: 'llama3.2' });

  assert.equal(provider.id, 'custom');
  assert.equal(provider.needsKey, false);
  assert.match(provider.label, /^Local \(localhost:11434\)$/);
  assert.equal(provider.chatEndpoint, 'http://localhost:11434/v1/chat/completions');
  assert.equal(provider.models[0].id, 'llama3.2');

  const settings = normalizeSettings({ provider: 'custom', custom: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' } });
  assert.equal(settings.custom.baseUrl, 'http://localhost:11434/v1', 'the trailing slash is gone');

  const candidates = rotationCandidates({ settings, providers: resolveProviders(settings) });
  assert.equal(candidates[0].provider.id, 'custom');
  assert.equal(candidates[0].key, '', 'a local endpoint is called without a key');
  assert.equal(candidates[0].model, 'llama3.2');
});

test('the endpoint key stays in the worker', () => {
  const settings = normalizeSettings({
    provider: 'custom',
    custom: { baseUrl: 'https://api.example.test/v1', model: 'x', key: 'sk-secret' },
  });
  const published = publicSettings(settings);

  assert.equal(published.custom.baseUrl, 'https://api.example.test/v1');
  assert.equal(published.custom.hasKey, true);
  assert.equal(published.hasKey, true);
  assert.ok(!JSON.stringify(published).includes('sk-secret'));
  assert.ok(JSON.stringify(providerMeta(settings)).includes('api.example.test'), 'the provider list includes it');
});

test('a page read is trimmed to the size the user chose, and says so', () => {
  assert.deepEqual(readBudget('small'), { maxElements: 40, maxChars: 4000 });
  assert.deepEqual(readBudget('nonsense'), readBudget('normal'));

  const page = {
    title: 'Big',
    url: 'https://example.test/big',
    text: 'x'.repeat(5000),
    elements: Array.from({ length: 100 }, (_, index) => ({ ref: `e${index}`, kind: 'button', name: `B${index}` })),
    headings: [],
  };

  const small = formatPageForModel(page, readBudget('small'));
  assert.match(small, /Interactive elements \(40 of 100\)/);
  assert.match(small, /more characters not shown/);
  assert.match(small, /60 more controls not shown/);
  assert.ok(!small.includes('B99'), 'the untrimmed controls are not in the prompt');
});
