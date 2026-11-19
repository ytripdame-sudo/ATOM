import test from 'node:test';
import assert from 'node:assert/strict';

import { groq, ProviderError } from '../extension/lib/providers/groq.js';

const originalFetch = globalThis.fetch;

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function stubFetch(handler) {
  globalThis.fetch = handler;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('text deltas stream in order', async () => {
  let body = null;
  stubFetch(async (_url, init) => {
    body = JSON.parse(init.body);
    return sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
  });

  const chunks = [];
  const result = await groq.streamChat({
    apiKey: 'k',
    model: 'openai/gpt-oss-120b',
    messages: [{ role: 'user', content: 'hi' }],
    onDelta: (chunk) => chunks.push(chunk),
  });

  assert.equal(result.text, 'Hello');
  assert.deepEqual(chunks, ['Hel', 'lo']);
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.toolCalls.length, 0);
  assert.equal(body.stream, true);
  assert.equal(body.tools, undefined);
  assert.equal(body.max_completion_tokens, 900);
});

test('fragmented tool calls are assembled', async () => {
  let body = null;
  stubFetch(async (_url, init) => {
    body = JSON.parse(init.body);
    return sseResponse([
      'data: {"choices":[{"delta":{"content":"Looking."}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_page","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"ref\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"e12\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
  });

  const tools = [{ type: 'function', function: { name: 'read_page', description: 'x', parameters: { type: 'object', properties: {} } } }];
  const result = await groq.streamChat({
    apiKey: 'k',
    model: 'openai/gpt-oss-120b',
    messages: [{ role: 'user', content: 'read it' }],
    tools,
    onDelta: () => {},
  });

  assert.deepEqual(body.tools, tools);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, 'call_1');
  assert.equal(result.toolCalls[0].function.name, 'read_page');
  assert.equal(result.toolCalls[0].function.arguments, '{"ref":"e12"}');
});

test('parallel tool calls keep their own slots', async () => {
  stubFetch(async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read_page","arguments":"{}"}},{"index":1,"id":"b","function":{"name":"scroll","arguments":"{\\"direction\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\\"down\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]),
  );

  const result = await groq.streamChat({
    apiKey: 'k',
    model: 'qwen/qwen3.8-27b',
    messages: [],
    tools: [{ type: 'function', function: { name: 'read_page' } }],
    onDelta: () => {},
  });

  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[0].function.name, 'read_page');
  assert.equal(result.toolCalls[1].function.name, 'scroll');
  assert.equal(result.toolCalls[1].function.arguments, '{"direction":"down"}');
});

test('http errors are mapped', async () => {
  stubFetch(
    async () =>
      new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
  );

  await assert.rejects(
    () => groq.streamChat({ apiKey: 'bad', model: 'm', messages: [], onDelta: () => {} }),
    (error) => error instanceof ProviderError && error.status === 401 && error.code === 'auth' && /Invalid API Key/.test(error.message),
  );
});

test('rate limits are mapped', async () => {
  stubFetch(
    async () =>
      new Response(JSON.stringify({ error: { message: 'slow down' } }), {
        status: 429,
        headers: { 'retry-after': '7' },
      }),
  );

  await assert.rejects(
    () => groq.streamChat({ apiKey: 'k', model: 'm', messages: [], onDelta: () => {} }),
    (error) => error.code === 'rate_limit' && error.status === 429 && error.retryAfterMs === 7000,
  );
});

test('a 429 without a retry-after header still carries a usable wait', async () => {
  stubFetch(async () => new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429 }));

  await assert.rejects(
    () => groq.streamChat({ apiKey: 'k', model: 'm', messages: [], onDelta: () => {} }),
    (error) => error.retryAfterMs === 0,
  );
});

test('an error inside the stream is raised', async () => {
  stubFetch(async () =>
    sseResponse(['data: {"error":{"message":"model overloaded","code":"overloaded"}}\n\n']),
  );

  await assert.rejects(
    () => groq.streamChat({ apiKey: 'k', model: 'm', messages: [], onDelta: () => {} }),
    (error) => /overloaded/i.test(error.message),
  );
});

test('a missing key never reaches the network', async () => {
  let called = false;
  stubFetch(async () => {
    called = true;
    return sseResponse([]);
  });

  await assert.rejects(
    () => groq.streamChat({ apiKey: '', model: 'm', messages: [], onDelta: () => {} }),
    (error) => error.code === 'auth',
  );
  assert.equal(called, false);
});

test('streamed reasoning is forwarded beside the answer, never mixed into it', async () => {
  stubFetch(async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"reasoning":"Let me think."}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":" Step two."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Answer."}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]),
  );

  const reasoning = [];
  const deltas = [];
  const result = await groq.streamChat({
    apiKey: 'k',
    model: 'openai/gpt-oss-120b',
    messages: [{ role: 'user', content: 'hi' }],
    onDelta: (chunk) => deltas.push(chunk),
    onReasoning: (chunk) => reasoning.push(chunk),
  });

  assert.deepEqual(reasoning, ['Let me think.', ' Step two.']);
  assert.equal(result.text, 'Answer.', 'thinking never becomes the answer');
  assert.deepEqual(deltas, ['Answer.']);
});
