import test from 'node:test';
import assert from 'node:assert/strict';

import { createTrustedInput, keyEventParams } from '../extension/lib/agent/trusted.js';

test('Enter becomes the key events the browser expects', () => {
  const events = keyEventParams('Enter');
  assert.equal(events.down.type, 'keyDown');
  assert.equal(events.down.key, 'Enter');
  assert.equal(events.down.windowsVirtualKeyCode, 13);
  assert.equal(events.down.text, '\r');
  assert.equal(events.up.type, 'keyUp');
});

test('a chord carries its modifiers, and a letter key has a code', () => {
  const events = keyEventParams('Control+Shift+T');
  assert.equal(events.down.modifiers, 2 | 8);
  assert.equal(events.down.key, 'T');
  assert.equal(events.down.code, 'KeyT');
  assert.equal(events.down.text, undefined, 'a chord does not type a character');
});

test('an unknown key is refused rather than guessed', () => {
  assert.equal(keyEventParams('Hyperdrive'), null);
  assert.equal(keyEventParams(''), null);
});

test('real input rides the debugger session it is given', async () => {
  const calls = [];
  const input = createTrustedInput({
    shared: {
      send: async (method, params) => {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') return { result: { value: { ok: true } } };
        return {};
      },
    },
  });

  await input.click(7, 10, 20);
  await input.type(7, 'hello');
  await input.key(7, 'Enter');
  const value = await input.evaluate(7, 'document.title');

  assert.deepEqual(calls[0], { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 10, y: 20 } });
  assert.equal(calls[1].params.type, 'mousePressed');
  assert.deepEqual(calls[3], { method: 'Input.insertText', params: { text: 'hello' } });
  assert.equal(calls[4].method, 'Input.dispatchKeyEvent');
  assert.equal(calls.at(-1).method, 'Runtime.evaluate');
  assert.equal(value.ok, true);
});
