import test from 'node:test';
import assert from 'node:assert/strict';

import { needsConfirmation, isForbidden } from '../extension/lib/agent/policy.js';

test('reading never asks', () => {
  for (const mode of ['assisted', 'balanced', 'autonomous']) {
    for (const tool of ['read_page', 'read_console', 'read_network']) {
      assert.equal(needsConfirmation({ mode, tool }), false, `${mode}/${tool}`);
    }
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

test('secret fields ask in every mode, autonomous included', () => {
  for (const mode of ['assisted', 'balanced', 'autonomous']) {
    for (const sensitive of ['password', 'card', 'otp']) {
      assert.equal(
        needsConfirmation({ mode, tool: 'type_text', args: { ref: 'e1', text: 'x' }, refMeta: { kind: 'input', sensitive } }),
        true,
        `${mode}/${sensitive}`,
      );
    }
  }

  // A plain field and an ordinary dropdown stay free in autonomous mode, so the
  // floor is about secrets rather than "ask more".
  assert.equal(needsConfirmation({ mode: 'autonomous', tool: 'type_text', refMeta: { kind: 'input' } }), false);
  assert.equal(needsConfirmation({ mode: 'autonomous', tool: 'select_option', refMeta: { kind: 'select' } }), false);
  assert.equal(needsConfirmation({ mode: 'autonomous', tool: 'click', refMeta: { kind: 'button' } }), false);
});

test('a secret field asks even when the field is also being submitted', () => {
  assert.equal(
    needsConfirmation({
      mode: 'autonomous',
      tool: 'type_text',
      args: { ref: 'e4', text: '4242', submit: true },
      refMeta: { kind: 'input', sensitive: 'card' },
    }),
    true,
  );
});

test('unknown modes fall back to balanced, unknown tools always ask', () => {
  assert.equal(needsConfirmation({ mode: 'nonsense', tool: 'type_text' }), true);
  assert.equal(needsConfirmation({ mode: 'autonomous', tool: 'launch_rocket' }), true);
});

test('run_js may not read cookies or stored session tokens', () => {
  for (const code of [
    'document.cookie',
    'document["cookie"]',
    'document["coo" + "kie"]',
    'cookieStore.getAll()',
    'localStorage.getItem("sessionToken")',
    'sessionStorage["refresh_token"]',
    'localStorage.authToken',
    'Object.entries(localStorage)',
    'JSON.stringify(window.localStorage)',
    'localStorage',
    'localStorage.getItem(key)',
  ]) {
    assert.ok(isForbidden({ tool: 'run_js', args: { code } }).length > 0, code);
  }

  assert.equal(isForbidden({ tool: 'run_js', args: { code: 'document.title' } }), '');
  assert.equal(isForbidden({ tool: 'run_js', args: { code: 'localStorage.getItem("theme")' } }), '');
});

test('a bookmark follows the mode write rules', () => {
  assert.equal(needsConfirmation({ mode: 'autonomous', agentMode: 'ask', tool: 'bookmark' }), true);
  assert.equal(needsConfirmation({ mode: 'balanced', tool: 'bookmark' }), true);
  assert.equal(needsConfirmation({ mode: 'autonomous', tool: 'bookmark' }), false);
  assert.equal(needsConfirmation({ mode: 'balanced', agentMode: 'playground', tool: 'bookmark' }), false);
});

test('navigation is limited to http(s) and needs an address', () => {
  assert.equal(isForbidden({ tool: 'navigate', args: { url: 'https://example.com' } }), '');
  assert.equal(isForbidden({ tool: 'navigate', args: { url: 'javascript:alert(1)' } }).length > 0, true);
  assert.equal(isForbidden({ tool: 'navigate', args: { url: 'file:///etc/passwd' } }).length > 0, true);
  assert.equal(isForbidden({ tool: 'navigate', args: {} }).length > 0, true);
  assert.equal(isForbidden({ tool: 'click', args: { ref: 'e1' } }), '');
});
