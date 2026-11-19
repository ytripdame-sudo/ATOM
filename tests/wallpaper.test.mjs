import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_OPTIONS,
  PRESETS,
  checkFile,
  createFpsGate,
  detectKind,
  normalizeOptions,
  normalizeState,
} from '../extension/newtab/wallpaper-core.js';

const file = (name, type, size = 1024) => ({ name, type, size });

test('a file is classed by its type, and by its name when the type is blank', () => {
  assert.equal(detectKind(file('a.png', 'image/png')), 'image');
  assert.equal(detectKind(file('a.gif', 'image/gif')), 'image');
  assert.equal(detectKind(file('a.webp', 'image/webp')), 'image');
  assert.equal(detectKind(file('a.webm', 'video/webm')), 'video');
  assert.equal(detectKind(file('a.mp4', 'video/mp4')), 'video');
  assert.equal(detectKind(file('a.html', '')), 'html');
  assert.equal(detectKind(file('a.txt', 'text/plain')), '');
  assert.equal(PRESETS.length >= 3 && PRESETS.length <= 4, true, 'three or four presets');
});

test('big files are refused with a reason rather than stored', () => {
  assert.equal(checkFile(file('a.mp4', 'video/mp4', 10)).ok, true);
  assert.equal(checkFile(file('a.zip', 'application/zip')).ok, false);

  const huge = checkFile(file('huge.mp4', 'video/mp4', 60 * 1024 * 1024));
  assert.equal(huge.ok, false);
  assert.match(huge.reason, /60 MB/);

  const page = checkFile(file('page.html', 'text/html', 5 * 1024 * 1024));
  assert.equal(page.ok, false, 'html has its own, smaller ceiling');
});

test('options are clamped, never trusted', () => {
  assert.deepEqual(normalizeOptions({}), DEFAULT_OPTIONS);
  assert.equal(normalizeOptions({ opacity: 9 }).opacity, 1);
  assert.equal(normalizeOptions({ opacity: -3 }).opacity, 0.05);
  assert.equal(normalizeOptions({ dim: 5 }).dim, 0.95);
  assert.equal(normalizeOptions({ blur: 99 }).blur, 24);
  assert.equal(normalizeOptions({ speed: 0 }).speed, 0.25);
  assert.equal(normalizeOptions({ volume: 4 }).volume, 1);
  assert.equal(normalizeOptions({ fps: 47 }).fps, DEFAULT_OPTIONS.fps);
  assert.equal(normalizeOptions({ fps: '60' }).fps, 60);
  assert.equal(normalizeOptions({ muted: false }).muted, false);
  assert.equal(normalizeOptions({ lowPower: 'yes' }).lowPower, false);
});

test('a stored state keeps only real items and a reachable wallpaper', () => {
  const state = normalizeState({
    items: [
      { id: 'w1', kind: 'image', name: 'Sea', mime: 'image/png' },
      { id: 'w2', kind: 'script', name: 'Nope' },
      { id: 'w3', kind: 'video' },
    ],
    activeId: 'missing',
    options: { dim: 0.5 },
  });

  assert.deepEqual(state.items.map((item) => item.id), ['w1', 'w3']);
  assert.equal(state.items[1].name, 'Wallpaper');
  assert.equal(state.activeId, 'preset:flow', 'falls back to a preset, never to nothing');
  assert.equal(state.options.dim, 0.5);

  assert.equal(normalizeState({ items: [], activeId: 'preset:blobs' }).activeId, 'preset:blobs');
  assert.equal(normalizeState({ items: [{ id: 'x', kind: 'image' }], activeId: 'x' }).activeId, 'x');
});

test('the frame gate holds a 30 fps ceiling', () => {
  const gate = createFpsGate(30);
  assert.equal(gate(0), true);
  assert.equal(gate(10), false, 'too soon');
  assert.equal(gate(20), false);
  assert.equal(gate(34), true, 'next slot');
  assert.equal(gate(50), false);
  assert.equal(gate(68), true);
});
