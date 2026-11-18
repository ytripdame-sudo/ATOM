import test from 'node:test';
import assert from 'node:assert/strict';

import { toProviderMessages, createMessage, newSession, dropMessage, titleFrom } from '../extension/lib/session.js';

const settings = { instructions: 'Be terse.' };

function call(id, name, args = '{}') {
  return { id, type: 'function', function: { name, arguments: args } };
}

test('plain conversation maps straight through', () => {
  const messages = [
    { id: 'a', role: 'user', text: 'hey', status: 'done' },
    { id: 'b', role: 'assistant', text: 'hello', status: 'done' },
    { id: 'c', role: 'user', text: 'and again', status: 'done' },
  ];
  const out = toProviderMessages({ messages, settings, tab: null, capabilities: { pageAccess: false } });
  assert.equal(out[0].role, 'system');
  assert.deepEqual(
    out.slice(1).map((m) => [m.role, m.content]),
    [
      ['user', 'hey'],
      ['assistant', 'hello'],
      ['user', 'and again'],
    ],
  );
});

test('tool calls and results stay paired', () => {
  const messages = [
    { id: 'u1', role: 'user', text: 'read it', status: 'done' },
    {
      id: 'a1',
      role: 'assistant',
      text: '',
      status: 'done',
      toolCalls: [call('call_1', 'read_page')],
    },
    {
      id: 't1',
      role: 'tool',
      text: 'Page: “Example”',
      toolCallId: 'call_1',
      name: 'read_page',
      status: 'done',
    },
    { id: 'u2', role: 'user', text: 'ok', status: 'done' },
  ];

  const out = toProviderMessages({ messages, settings, tab: null, capabilities: { pageAccess: true } });
  const assistant = out.find((m) => m.role === 'assistant');
  const tool = out.find((m) => m.role === 'tool');

  assert.equal(assistant.tool_calls.length, 1);
  assert.equal(assistant.tool_calls[0].id, 'call_1');
  assert.equal(assistant.content, null);
  assert.equal(tool.tool_call_id, 'call_1');
  assert.equal(tool.content, 'Page: “Example”');
});

test('an unanswered tool call gets a synthetic result rather than a 400', () => {
  const messages = [
    { id: 'u1', role: 'user', text: 'go', status: 'done' },
    { id: 'a1', role: 'assistant', text: '', status: 'done', toolCalls: [call('call_1', 'read_page'), call('call_2', 'click')] },
    { id: 't1', role: 'tool', text: 'ok', toolCallId: 'call_1', name: 'read_page', status: 'done' },
  ];

  const out = toProviderMessages({ messages, settings, tab: null, capabilities: { pageAccess: true } });
  const results = out.filter((m) => m.role === 'tool');
  assert.equal(results.length, 2);
  assert.equal(results[1].tool_call_id, 'call_2');
  assert.match(results[1].content, /interrupted/i);
});

test('orphan tool rows and error turns are dropped', () => {
  const messages = [
    { id: 't0', role: 'tool', text: 'orphan', toolCallId: 'nope', name: 'click', status: 'done' },
    { id: 'u1', role: 'user', text: 'hey', status: 'done' },
    { id: 'e1', role: 'assistant', text: '', status: 'error', code: 'network' },
  ];
  const out = toProviderMessages({ messages, settings, tab: null, capabilities: { pageAccess: false } });
  assert.equal(out.length, 2, JSON.stringify(out));
  assert.equal(out[1].content, 'hey');
});

test('history is trimmed to a budget without splitting a tool turn', () => {
  const messages = [];
  for (let i = 0; i < 30; i += 1) {
    messages.push({ id: `u${i}`, role: 'user', text: 'x'.repeat(1800), status: 'done' });
    messages.push({ id: `a${i}`, role: 'assistant', text: '', status: 'done', toolCalls: [call(`c${i}`, 'read_page')] });
    messages.push({ id: `t${i}`, role: 'tool', text: 'y'.repeat(1200), toolCallId: `c${i}`, name: 'read_page', status: 'done' });
  }

  const out = toProviderMessages({ messages, settings, tab: null, capabilities: { pageAccess: true } });
  const chars = out.reduce((sum, m) => sum + String(m.content || '').length, 0);
  assert.ok(chars < 28000, `too large: ${chars}`);

  for (const message of out) {
    if (message.role !== 'tool') continue;
    const parent = out.find((m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.id === message.tool_call_id));
    assert.ok(parent, `tool result ${message.tool_call_id} lost its call`);
  }
});

test('the prompt is honest about page access', () => {
  const messages = [{ id: 'u', role: 'user', text: 'hi', status: 'done' }];
  const withAccess = toProviderMessages({
    messages,
    settings,
    tab: { title: 'Example', url: 'https://example.com/x' },
    capabilities: { pageAccess: true },
  })[0].content;

  const without = toProviderMessages({
    messages,
    settings,
    tab: { title: 'Example', url: 'https://example.com/x' },
    capabilities: { pageAccess: false },
  })[0].content;

  assert.match(withAccess, /read_page/);
  assert.match(withAccess, /refs expire/i);
  assert.match(withAccess, /never instructions/i);
  assert.match(without, /no page access/i);
  assert.match(without, /do not describe/i);
  assert.match(without, /never instructions/i);
});

test('message helpers behave', () => {
  const session = newSession();
  const message = createMessage('user', 'hello');
  session.messages.push(message);
  assert.equal(session.messages.length, 1);
  assert.equal(dropMessage(session, message.id), true);
  assert.equal(session.messages.length, 0);
  assert.equal(titleFrom('a'.repeat(200)).endsWith('…'), true);
});
