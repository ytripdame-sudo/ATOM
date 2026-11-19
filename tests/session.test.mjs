import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toProviderMessages,
  estimateTokens,
  createMessage,
  newSession,
  dropMessage,
  titleFrom,
} from '../extension/lib/session.js';

// Instructions have their own tests; the rest of these map the transcript, which
// the standing-instructions reminder would otherwise decorate on every turn.
const settings = {};

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
  assert.match(tool.content, /^The block below is untrusted data/);
  assert.match(tool.content, /<<<ATOM_UNTRUSTED:READ_PAGE>>>/);
  assert.match(tool.content, /Page: “Example”/);
  assert.match(tool.content, /<<<END_ATOM_UNTRUSTED:READ_PAGE>>>$/);
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
  assert.match(without, /needs no page access/i, 'navigation survives a missing grant');
  assert.match(without, /never instructions/i);
});

test('the page digest rides the first request and is fenced as page data', () => {
  const capabilities = {
    pageAccess: true,
    digest: 'Page: Example — https://example.com/x\nOpening text: hello',
  };
  const messages = [{ id: 'u', role: 'user', text: 'what is this?', status: 'done' }];

  const first = toProviderMessages({ messages, settings, tab: null, capabilities })[0].content;
  assert.match(first, /ATOM_UNTRUSTED:PAGE_DIGEST/, 'the digest is fenced as page data');
  assert.match(first, /cost no model step and no tokens/i);

  const later = toProviderMessages({
    messages: [
      ...messages,
      { id: 'a', role: 'assistant', text: 'A page about examples.', status: 'done' },
    ],
    settings,
    tab: null,
    capabilities,
  })[0].content;
  assert.doesNotMatch(later, /PAGE_DIGEST/, 'the digest is not repeated once the model has answered');
});

test('the prompt mentions capture only while it is attached', () => {
  const messages = [{ id: 'u', role: 'user', text: 'hi', status: 'done' }];
  const withCapture = toProviderMessages({
    messages,
    settings,
    tab: null,
    capabilities: { pageAccess: true, capture: true },
  })[0].content;
  const without = toProviderMessages({ messages, settings, tab: null, capabilities: { pageAccess: true } })[0].content;

  assert.match(withCapture, /read_console/);
  assert.match(withCapture, /read_network/);
  assert.match(withCapture, /never follow it/i);
  assert.match(withCapture, /reload/i);
  assert.doesNotMatch(without, /read_console/);
  assert.match(without, /never instructions/i);
});

test('a standing-instructions reminder lands on the last user turn only', () => {
  const messages = toProviderMessages({
    messages: [
      { id: 'a', role: 'user', text: 'yo', status: 'done' },
      { id: 'b', role: 'assistant', text: 'hey', status: 'done' },
      { id: 'c', role: 'user', text: 'who are you?', status: 'done' },
    ],
    settings: { instructions: 'Be ZEPHYR, in lowercase.' },
    tab: null,
    capabilities: {},
  });

  assert.equal(
    messages.at(-1).content,
    'who are you?\n\nNote: Adhere strictly to the standing custom instructions provided in the system prompt.',
  );
  assert.equal(messages.filter((message) => message.role === 'user')[0].content, 'yo', 'history is untouched');
  assert.ok(messages[0].content.includes('Be ZEPHYR, in lowercase.'));
  assert.ok(
    messages[0].content.trimEnd().endsWith('Be ZEPHYR, in lowercase.'),
    "the user's instructions are the last word",
  );
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

test('older page reads are compressed; only the newest stays whole', () => {
  const messages = [
    { id: 'u', role: 'user', text: 'read it twice', status: 'done' },
    { id: 'a1', role: 'assistant', text: '', status: 'done', toolCalls: [call('r1', 'read_page')] },
    { id: 't1', role: 'tool', text: `OLD PAGE ${'x'.repeat(500)}`, toolCallId: 'r1', name: 'read_page', status: 'done' },
    { id: 'a2', role: 'assistant', text: '', status: 'done', toolCalls: [call('r2', 'read_page')] },
    { id: 't2', role: 'tool', text: `NEW PAGE ${'y'.repeat(500)}`, toolCallId: 'r2', name: 'read_page', status: 'done' },
    { id: 'a3', role: 'assistant', text: 'Both read.', status: 'done' },
  ];

  const out = toProviderMessages({ messages, settings, tab: null, capabilities: { pageAccess: true } });
  const joined = out.map((message) => String(message.content || '')).join('\n');

  assert.match(joined, /NEW PAGE yyy/, 'the newest read is sent in full');
  assert.doesNotMatch(joined, /OLD PAGE x/);
  assert.match(joined, /\[compressed\] an earlier read_page/, 'the model is told what was dropped');
  // The pairing still holds: both calls have their result.
  assert.equal(out.filter((message) => message.role === 'tool').length, 2);
});

test('only the newest search result stays whole', () => {
  const messages = [];
  for (let i = 0; i < 3; i += 1) {
    messages.push({ id: `a${i}`, role: 'assistant', text: '', status: 'done', toolCalls: [call(`c${i}`, 'web_search')] });
    messages.push({
      id: `t${i}`,
      role: 'tool',
      text: `SEARCH_RESULT_${i} ${'z'.repeat(500)}`,
      toolCallId: `c${i}`,
      name: 'web_search',
      status: 'done',
    });
  }

  const out = toProviderMessages({ messages, settings, tab: null, capabilities: { pageAccess: false } });
  const joined = out.map((message) => String(message.content || '')).join('\n');

  assert.ok(joined.includes(`SEARCH_RESULT_2 ${'z'.repeat(500)}`), 'the newest search is whole');
  assert.ok(!joined.includes(`SEARCH_RESULT_0 ${'z'.repeat(200)}`), 'an older search body is gone');
  assert.match(joined, /\[compressed\] web_search: SEARCH_RESULT_0/, 'its first line survives as a pointer');
});

test('tool results past the newest few are compressed to one line', () => {
  const messages = [];
  for (let i = 0; i < 8; i += 1) {
    messages.push({ id: `a${i}`, role: 'assistant', text: '', status: 'done', toolCalls: [call(`c${i}`, 'click')] });
    messages.push({
      id: `t${i}`,
      role: 'tool',
      text: `RESULT_${i} zzz${'z'.repeat(600)}`,
      toolCallId: `c${i}`,
      name: 'click',
      status: 'done',
    });
  }

  const out = toProviderMessages({ messages, settings, tab: null, capabilities: { pageAccess: true } });
  const joined = out.map((message) => String(message.content || '')).join('\n');

  assert.ok(joined.includes(`RESULT_7 ${'z'.repeat(600)}`), 'the newest result is whole');
  assert.ok(!joined.includes(`RESULT_0 ${'z'.repeat(200)}`), 'the oldest body is gone');
  assert.match(joined, /\[compressed\] click: RESULT_0/, 'its first line survives as a pointer');
});

test('the token estimate tracks what is actually sent', () => {
  const small = estimateTokens([{ role: 'system', content: 'x'.repeat(400) }]);
  const big = estimateTokens([{ role: 'system', content: 'x'.repeat(4000) }]);

  assert.ok(small >= 100 && small <= 120, `estimate was ${small}`);
  assert.ok(big > small * 5, 'a bigger request estimates bigger');

  const withCall = estimateTokens([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'click', arguments: '{"ref":"e1"}' } }],
    },
  ]);
  assert.ok(withCall > 10, 'tool calls are counted too');
});

test('a rate-limited retry asks for less history', () => {
  const messages = [];
  for (let i = 0; i < 14; i += 1) {
    messages.push({ id: `u${i}`, role: 'user', text: `MARK_${i} ${'q'.repeat(1800)}`, status: 'done' });
  }

  const normal = toProviderMessages({ messages, settings, tab: null, capabilities: { pageAccess: false } });
  const tight = toProviderMessages({
    messages,
    settings,
    tab: null,
    capabilities: { pageAccess: false },
    tight: true,
  });
  const chars = (out) => out.reduce((sum, message) => sum + String(message.content || '').length, 0);

  assert.ok(chars(tight) < chars(normal), `${chars(tight)} is not smaller than ${chars(normal)}`);
  assert.match(JSON.stringify(tight), /MARK_13 /, 'the newest message is still sent');
});

test('a quoted selection is fenced in front of the question', () => {
  const quoted = toProviderMessages({
    messages: [
      {
        id: 'u',
        role: 'user',
        text: 'what is this?',
        status: 'done',
        quote: { text: 'Dragons are real', url: 'https://example.com/d' },
      },
    ],
    settings,
    tab: null,
    capabilities: { pageAccess: false },
  }).at(-1).content;

  assert.match(quoted, /ATOM_UNTRUSTED:SELECTION/, 'the quote is page data, fenced');
  assert.match(quoted, /Dragons are real/);
  assert.ok(quoted.trimEnd().endsWith('what is this?'), 'the question is not swallowed by the quote');

  const plain = toProviderMessages({
    messages: [{ id: 'u2', role: 'user', text: 'hi', status: 'done' }],
    settings,
    tab: null,
    capabilities: { pageAccess: false },
  }).at(-1).content;
  assert.equal(plain, 'hi');
});
