import test from 'node:test';
import assert from 'node:assert/strict';

import { needsConfirmation, isForbidden } from '../extension/lib/agent/policy.js';

test('reading never asks', () => {
  for (const mode of ['assisted', 'balanced', 'autonomous']) {
    assert.equal(needsConfirmation({ mode, tool: 'read_page' }), false, mode);
  }
});

test('assisted asks for everything that acts', () => {
  for (const tool of ['click', 'type_text', 'select_option', 'scroll', 'navigate']) {
    assert.equal(needsConfirmation({ mode: 'assisted', tool }), true, tool);
  }
});

test('balanced lets links and scrolling through, asks for state changes', () => {
  assert.equal(needsConfirmation({ mode: 'balanced', tool: 'click', refMeta: { kind: 'link' } }), false);
  assert.equal(needsConfirmation({ mode: 'balanced', tool: 'click', refMeta: { kind: 'button' } }), true);
  assert.equal(needsConfirmation({ mode: 'balanced', tool: 'click' }), true);
  assert.equal(needsConfirmation({ mode: 'balanced', tool: 'type_text' }), true);
  assert.equal(needsConfirmation({ mode: 'balanced', tool: 'scroll' }), false);
  assert.equal(needsConfirmation({ mode: 'balanced', tool: 'navigate' }), false);
});

test('autonomous stops asking except for submitting', () => {
  assert.equal(needsConfirmation({ mode: 'autonomous', tool: 'click', refMeta: { kind: 'button' } }), false);
  assert.equal(needsConfirmation({ mode: 'autonomous', tool: 'type_text' }), false);
  assert.equal(needsConfirmation({ mode: 'autonomous', tool: 'type_text', args: { submit: true } }), true);
});

test('unknown modes fall back to balanced, unknown tools always ask', () => {
  assert.equal(needsConfirmation({ mode: 'nonsense', tool: 'type_text' }), true);
  assert.equal(needsConfirmation({ mode: 'autonomous', tool: 'launch_rocket' }), true);
});

test('navigation is limited to http(s) and needs an address', () => {
  assert.equal(isForbidden({ tool: 'navigate', args: { url: 'https://example.com' } }), '');
  assert.equal(isForbidden({ tool: 'navigate', args: { url: 'javascript:alert(1)' } }).length > 0, true);
  assert.equal(isForbidden({ tool: 'navigate', args: { url: 'file:///etc/passwd' } }).length > 0, true);
  assert.equal(isForbidden({ tool: 'navigate', args: {} }).length > 0, true);
  assert.equal(isForbidden({ tool: 'click', args: { ref: 'e1' } }), '');
});
