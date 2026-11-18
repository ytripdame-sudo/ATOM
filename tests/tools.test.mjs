import test from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_DEFINITIONS, TOOL_NAMES, parseArguments } from '../extension/lib/agent/tools.js';
import { describeAction, formatPageForModel, originPattern, hostOf } from '../extension/lib/page.js';

test('every tool has a name, description and object schema', () => {
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.type, 'function');
    assert.equal(typeof tool.function.name, 'string');
    assert.ok(tool.function.description.length > 20, tool.function.name);
    assert.equal(tool.function.parameters.type, 'object');
    assert.ok(tool.function.parameters.properties, tool.function.name);
  }
  assert.deepEqual([...TOOL_NAMES].sort(), ['click', 'navigate', 'read_page', 'scroll', 'select_option', 'type_text']);
});

test('arguments parse, and bad arguments are reported not thrown', () => {
  assert.deepEqual(parseArguments('{"ref":"e1"}').value, { ref: 'e1' });
  assert.deepEqual(parseArguments('').value, {});
  assert.equal(parseArguments('{oops}').ok, false);
  assert.equal(parseArguments('[1,2]').ok, false);
  assert.deepEqual(parseArguments({ ref: 'e9' }).value, { ref: 'e9' });
});

test('origins and hosts are derived safely', () => {
  assert.equal(originPattern('https://example.com/a/b?c=1'), 'https://example.com/*');
  assert.equal(originPattern('http://localhost:5173/sidepanel/'), 'http://localhost:5173/*');
  assert.equal(originPattern('chrome://extensions'), null);
  assert.equal(originPattern('file:///etc/passwd'), null);
  assert.equal(originPattern('not a url'), null);
  assert.equal(hostOf('https://example.com/a'), 'example.com');
  assert.equal(hostOf('nonsense'), '');
});

test('action summaries read like sentences', () => {
  assert.equal(describeAction('read_page', {}), 'Read the page');
  assert.equal(describeAction('click', { ref: 'e2' }, { kind: 'button', name: 'Sign in' }), 'Click “Sign in”');
  assert.equal(describeAction('click', { ref: 'e2' }), 'Click e2');
  assert.equal(describeAction('scroll', { direction: 'down' }), 'Scroll down');
  assert.equal(describeAction('navigate', { url: 'https://example.com/x' }), 'Open example.com');
  assert.equal(describeAction('type_text', { ref: 'e3', text: 'hi' }, { name: 'Search' }), 'Type into “Search”');
});

test('a page description formats into something a model can use', () => {
  const text = formatPageForModel({
    title: 'Example',
    url: 'https://example.com/',
    scroll: { percent: 40, y: 400, height: 1000, viewport: 600 },
    text: 'Hello world',
    headings: [{ level: 1, text: 'Welcome' }],
    elements: [
      { ref: 'e1', kind: 'link', name: 'Pricing', href: '/pricing' },
      { ref: 'e2', kind: 'input', name: 'Search', placeholder: 'Search…' },
      { ref: 'e3', kind: 'button', name: 'Sign in', disabled: true },
    ],
    forms: { password: true },
    truncated: false,
  });

  assert.match(text, /Page: "Example" — https:\/\/example\.com\//);
  assert.match(text, /Scroll: 40%/);
  assert.match(text, /Hello world/);
  assert.match(text, /Headings: H1 Welcome/);
  assert.match(text, /\[e1\] link "Pricing" → \/pricing/);
  assert.match(text, /\[e2\] input "Search" placeholder="Search…"/);
  assert.match(text, /\(disabled\)/);
  assert.match(text, /password field/);
});
