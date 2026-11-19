import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_TOOLS,
  CAPTURE_TOOLS,
  MEMORY_TOOLS,
  TAB_TOOLS,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  WEB_TOOLS,
  parseArguments,
} from '../extension/lib/agent/tools.js';
import { describeAction, formatPageForModel, originPattern, hostOf } from '../extension/lib/page.js';

test('every tool has a name, description and object schema', () => {
  for (const tool of [...TOOL_DEFINITIONS, ...WEB_TOOLS, ...CAPTURE_TOOLS, ...MEMORY_TOOLS, ...TAB_TOOLS]) {
    assert.equal(tool.type, 'function');
    assert.equal(typeof tool.function.name, 'string');
    assert.ok(tool.function.description.length > 20, tool.function.name);
    assert.equal(tool.function.parameters.type, 'object');
    assert.ok(tool.function.parameters.properties, tool.function.name);
  }
  assert.deepEqual([...TOOL_NAMES].sort(), [
    'browser',
    'click',
    'list_tabs',
    'navigate',
    'plan',
    'press_key',
    'read_console',
    'read_network',
    'read_page',
    'remember',
    'run_js',
    'screenshot',
    'scroll',
    'select_option',
    'show_image',
    'tabs',
    'type_text',
    'web_search',
  ]);
});

test('the page tools accept a tab id, so one turn can work across tabs', () => {
  for (const name of ['read_page', 'click', 'type_text', 'select_option', 'scroll', 'navigate']) {
    const tool = TOOL_DEFINITIONS.find((entry) => entry.function.name === name);
    assert.deepEqual(tool.function.parameters.properties.tab?.type, ['integer', 'null'], name);
  }

  assert.deepEqual(TAB_TOOLS.map((tool) => tool.function.name), ['list_tabs']);
  const tabs = AGENT_TOOLS.find((tool) => tool.function.name === 'tabs');
  assert.deepEqual(tabs.function.parameters.properties.action.enum, ['open', 'close', 'switch', 'group']);
  assert.deepEqual(tabs.function.parameters.properties.tab.type, ['integer', 'null']);
  assert.deepEqual(MEMORY_TOOLS.map((tool) => tool.function.name), ['remember']);
  assert.match(MEMORY_TOOLS[0].function.description, /approves it before it is stored/);
});

test('web lookups are their own set, and say what they cannot do', () => {
  assert.deepEqual(WEB_TOOLS.map((tool) => tool.function.name).sort(), ['show_image', 'web_search']);

  const search = WEB_TOOLS.find((tool) => tool.function.name === 'web_search');
  // Stage 9: the provider is configured, and depth reads pages instead of
  // pretending snippets are the whole web.
  assert.match(search.function.description, /ranked results/);
  assert.match(search.function.description, /never guess an address/);
  assert.match(search.function.description, /depth true/);
  assert.ok(search.function.parameters.properties.depth, 'depth is offered');
  assert.deepEqual(search.function.parameters.required, ['query']);

  const pictures = WEB_TOOLS.find((tool) => tool.function.name === 'show_image');
  assert.match(pictures.function.description, /openly licensed/i);
  assert.deepEqual(pictures.function.parameters.required, ['query']);
});

test('diagnostics are a separate set that only exists while attached', () => {
  const pageNames = TOOL_DEFINITIONS.map((tool) => tool.function.name);
  assert.deepEqual(pageNames.sort(), ['click', 'navigate', 'read_page', 'scroll', 'select_option', 'type_text']);
  assert.equal(CAPTURE_TOOLS.length, 2);

  for (const tool of CAPTURE_TOOLS) {
    assert.equal(tool.function.parameters.type, 'object');
    assert.deepEqual(tool.function.parameters.properties, {});
    assert.match(tool.function.description, /since capture started/i);
    assert.match(tool.function.description, /reload/i);
  }
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
  assert.equal(describeAction('read_console', {}), 'Read the console');
  assert.equal(describeAction('read_network', {}), 'Read failed requests');
  assert.equal(describeAction('browser', { action: 'bookmark', url: 'https://example.com/x' }), 'Browser: bookmark example.com');
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
