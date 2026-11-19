import test from 'node:test';
import assert from 'node:assert/strict';

import { noAccessFailure, staleFailure } from '../extension/lib/agent/failure.js';

/**
 * These strings are the whole of what a model sees when an action cannot run, so
 * the assertions are about what they make it do: stop, re-read the page, and ask
 * the user — never repeat the action that just failed.
 */

test('a stale ref says nothing happened, and sends the model back to read_page', () => {
  const text = staleFailure('e7');

  assert.match(text, /^e7 /, 'names the ref it was given');
  assert.match(text, /nothing happened/i);
  assert.match(text, /Call read_page/);
  assert.match(text, /do not repeat this action with e7/i);
  // Read first, then act on the new refs: the order is the instruction.
  assert.ok(text.indexOf('read_page') < text.indexOf('do not repeat'), 'read_page comes before the prohibition');
});

test('a stale ref with no ref still reads as a sentence', () => {
  assert.match(staleFailure(), /^That ref /);
  assert.match(staleFailure(''), /^That ref /);
});

test('no page access refuses the action, then asks for the grant before a retry', () => {
  const text = noAccessFailure('shop.example');

  assert.match(text, /^Page access is not granted for shop\.example/);
  assert.match(text, /nothing was changed/i);
  assert.match(text, /Do not retry this action/i);
  assert.match(text, /Grant access/);
  assert.match(text, /read_page/);
  // Nothing invites it to describe a page it never saw.
  assert.match(text, /Do not describe the page/);
});

test('neither failure is long enough to crowd the context', () => {
  for (const text of [staleFailure('f2:e19'), noAccessFailure('a-rather-long-subdomain.example.com')]) {
    assert.ok(text.length <= 400, `failure text is ${text.length} characters`);
  }
});
