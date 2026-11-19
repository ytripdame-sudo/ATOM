import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, addMemory, normalizeSettings, publicSettings, removeMemory } from '../extension/lib/settings.js';

test('the first-run access question starts unanswered', () => {
  assert.equal(normalizeSettings(null).accessChoice, '');
  assert.equal(normalizeSettings({}).accessChoice, '');
});

test('an answer is remembered, and anything else is not an answer', () => {
  assert.equal(normalizeSettings({ accessChoice: 'per-site' }).accessChoice, 'per-site');
  assert.equal(normalizeSettings({ accessChoice: 'allow-all' }).accessChoice, 'allow-all');
  assert.equal(normalizeSettings({ accessChoice: 'later' }).accessChoice, '');
  assert.equal(normalizeSettings({ accessChoice: 42 }).accessChoice, '');
});

test('the panel is told the answer, never the key', () => {
  const view = publicSettings(normalizeSettings({ apiKey: 'gsk_x', accessChoice: 'allow-all' }));

  assert.equal(view.accessChoice, 'allow-all');
  assert.equal(view.hasKey, true);
  assert.ok(!('apiKey' in view));
});

test('trusted actions survive storage and anything else is dropped', () => {
  const normalized = normalizeSettings({
    actionGrants: [{ host: 'Example.com', kind: 'click', at: 4 }, { host: 'x', kind: 'submit' }, 'nope'],
  });

  assert.deepEqual(normalized.actionGrants, [{ host: 'example.com', kind: 'click', at: 4 }]);
  assert.deepEqual(publicSettings(normalized).actionGrants, normalized.actionGrants);
  assert.deepEqual(DEFAULT_SETTINGS.actionGrants, []);
});

test('memory is normalised, deduped, capped and removable', () => {
  const normalized = normalizeSettings({
    memories: [
      { id: 'a', text: 'Prefers short answers', at: 1 },
      { text: 'prefers SHORT answers' },
      { text: '   ' },
      { text: 'x'.repeat(400) },
    ],
  });

  assert.equal(normalized.memories.length, 2, 'a duplicate and an empty one are dropped');
  assert.equal(normalized.memories[1].text.length, 300, 'a long fact is capped');
  assert.deepEqual(publicSettings(normalized).memories, normalized.memories);

  const added = addMemory(normalized.memories, 'Works in Chromium');
  assert.equal(added.length, 3);
  assert.equal(addMemory(added, 'works in chromium').length, 3, 'the same fact twice is one memory');
  assert.equal(removeMemory(added, added[2].id).length, 2);
});

test('the browsing agent is off by default, and its mode and limit are known values', () => {
  const base = normalizeSettings(null);
  assert.equal(base.agent.mode, 'off');
  assert.equal(base.agent.stepLimit, 16);
  assert.deepEqual(base.agent.trustedSites, []);
  assert.deepEqual(publicSettings(base).agent, base.agent);

  const normalized = normalizeSettings({
    agent: { mode: 'playground', stepLimit: 999, trustedSites: ['GitHub.com', 'https://www.music.youtube.com/feed', 'not a host', 'github.com'] },
  });

  assert.equal(normalized.agent.mode, 'playground');
  assert.equal(normalized.agent.stepLimit, 40, 'the limit is clamped');
  assert.deepEqual(normalized.agent.trustedSites, ['github.com', 'music.youtube.com']);

  assert.equal(normalizeSettings({ agent: { mode: 'nonsense' } }).agent.mode, 'off');
  assert.equal(normalizeSettings({ agent: { stepLimit: 1 } }).agent.stepLimit, 4);
});
