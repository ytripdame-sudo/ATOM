import test from 'node:test';
import assert from 'node:assert/strict';

import { runAgentTurn } from '../extension/lib/agent/loop.js';

const TOOLS = [{ type: 'function', function: { name: 'read_page' } }];

function harness(responses, { maxSteps, signal } = {}) {
  let index = 0;
  const requests = [];
  const ranTools = [];
  const skips = [];
  const turns = [];

  const provider = {
    async streamChat(request) {
      requests.push(request);
      const response = responses[index] ?? { text: 'done', toolCalls: [] };
      index += 1;
      for (const chunk of response.deltas || []) request.onDelta(chunk);
      if (response.error) throw response.error;
      return { text: response.text ?? '', toolCalls: response.toolCalls ?? [], finishReason: 'stop' };
    },
  };

  const options = {
    provider,
    apiKey: 'test',
    model: 'test-model',
    tools: TOOLS,
    signal,
    maxSteps,
    buildMessages: () => [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
    ],
    beginStep: () => {
      const turn = { text: '', info: null };
      turns.push(turn);
      return {
        text: () => turn.text,
        push: (chunk) => {
          turn.text += chunk;
        },
        finish: async (info) => {
          turn.info = info;
        },
      };
    },
    runTool: async (call, skip) => {
      ranTools.push(call.function.name);
      if (skip) skips.push({ name: call.function.name, ...skip });
    },
  };

  return { options, requests, ranTools, skips, turns };
}

test('a plain answer is one step and no tools', async () => {
  const { options, requests, ranTools, turns } = harness([{ text: 'hello', deltas: ['hel', 'lo'] }]);
  const outcome = await runAgentTurn(options);

  assert.deepEqual(outcome, { steps: 1, complete: true });
  assert.equal(requests.length, 1);
  assert.equal(ranTools.length, 0);
  assert.equal(turns[0].text, 'hello');
  assert.equal(turns[0].info.failed, undefined);
});

test('tool calls are executed and the model is asked again', async () => {
  const call = { id: 'call_1', type: 'function', function: { name: 'read_page', arguments: '{}' } };
  const { options, requests, ranTools, turns } = harness([
    { text: 'let me look', toolCalls: [call] },
    { text: 'done', toolCalls: [] },
  ]);

  const outcome = await runAgentTurn(options);

  assert.deepEqual(outcome, { steps: 2, complete: true });
  assert.deepEqual(ranTools, ['read_page']);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].tools, TOOLS, 'tools stay available on later steps');
  assert.equal(turns[1].info.toolCalls.length, 0);
  assert.equal(turns[0].info.toolCalls[0].id, 'call_1');
});

test('the step ceiling stops a runaway loop', async () => {
  // Every call is different, so the repeat guard never fires and only the
  // ceiling can end this turn.
  const responses = Array.from({ length: 10 }, (_, i) => ({
    text: '',
    toolCalls: [{ id: `c${i}`, type: 'function', function: { name: 'read_page', arguments: `{"i":${i}}` } }],
  }));
  const { options, requests } = harness(responses, { maxSteps: 3 });

  const outcome = await runAgentTurn(options);

  assert.deepEqual(outcome, { steps: 3, exhausted: true });
  assert.equal(requests.length, 3);
});

test('aborting during a tool stops before another request', async () => {
  const controller = new AbortController();
  const call = { id: 'c', type: 'function', function: { name: 'click', arguments: '{}' } };
  const { options, requests } = harness([{ text: 'working', toolCalls: [call] }], { signal: controller.signal });

  const baseRunTool = options.runTool;
  options.runTool = async (toolCall) => {
    await baseRunTool(toolCall);
    controller.abort();
  };

  const outcome = await runAgentTurn(options);
  assert.deepEqual(outcome, { steps: 1, stopped: true });
  assert.equal(requests.length, 1);
});

test('provider failures mark the step and propagate', async () => {
  const failure = Object.assign(new Error('network down'), { name: 'ProviderError', code: 'network' });
  const { options, turns } = harness([{ text: 'par', deltas: ['par'], error: failure }]);

  await assert.rejects(() => runAgentTurn(options), /network down/);
  assert.equal(turns[0].info.failed, true);
  assert.equal(turns[0].info.error, failure);
  assert.equal(turns[0].info.text, 'par');
});

test('no tools means no tool schema is sent', async () => {
  const { options, requests } = harness([{ text: 'hi' }]);
  options.tools = null;
  await runAgentTurn(options);
  assert.equal(requests[0].tools, undefined);
});

/* ------------------------------------------------------------ rate limits */

function rateLimited(retryAfterMs = 1) {
  return Object.assign(new Error('slow down'), { status: 429, code: 'rate_limit', retryAfterMs });
}

test('a rate-limited step waits for the key and asks again in the same message', async () => {
  const notices = [];
  const { options, requests, turns } = harness([{ error: rateLimited() }, { text: 'fine' }]);
  options.onRateLimit = (info) => notices.push(info);

  const outcome = await runAgentTurn(options);

  assert.equal(outcome.steps, 1);
  assert.equal(requests.length, 2, 'the same step asked twice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].waitMs, 1, 'waits what the provider asked for');
  assert.equal(turns.length, 1, 'the retry reuses the empty reply instead of adding another');
  assert.equal(turns[0].info.text, 'fine');
  assert.equal(turns[0].info.failed, undefined);
});

test('a key that stays rate-limited fails after two retries, not forever', async () => {
  const notices = [];
  const { options, requests } = harness([
    { error: rateLimited() },
    { error: rateLimited() },
    { error: rateLimited() },
    { text: 'never' },
  ]);
  options.onRateLimit = (info) => notices.push(info);

  await assert.rejects(() => runAgentTurn(options), (error) => error.code === 'rate_limit');
  assert.equal(requests.length, 3, 'the first ask plus two retries');
  assert.equal(notices.length, 2);
});

test('stopping during a rate-limit wait ends the turn instead of waiting it out', async () => {
  const controller = new AbortController();
  const { options, requests, turns } = harness(
    [{ error: rateLimited(5000) }, { error: rateLimited(5000) }],
    { signal: controller.signal },
  );
  options.onRateLimit = () => controller.abort();

  const outcome = await runAgentTurn(options);

  assert.deepEqual(outcome, { steps: 0, stopped: true });
  assert.equal(requests.length, 1, 'no second request after the stop');
  assert.equal(turns[0].info.text, '');
  assert.equal(turns[0].info.failed, undefined, 'a stop is not an error');
});

test('the third identical call ends the turn instead of spending the budget', async () => {
  // The Discord turn this fixes: read, scroll, read, scroll… forever. A repeat
  // is not a retry, so the call is not run and the turn says why.
  const call = { id: 'c', type: 'function', function: { name: 'read_page', arguments: '{}' } };
  const { options, ranTools, skips, requests } = harness(
    Array.from({ length: 8 }, () => ({ text: '', toolCalls: [call] })),
    { maxSteps: 12 },
  );

  const outcome = await runAgentTurn(options);

  assert.deepEqual(outcome, { steps: 3, stalled: true, reason: 'repeat' });
  assert.deepEqual(ranTools, ['read_page', 'read_page', 'read_page'], 'the third is handed over unrun');
  assert.deepEqual(skips, [{ name: 'read_page', skipped: 'repeat' }]);
  assert.equal(requests.length, 3, 'no fourth request is paid for');
});

test('a repeat twice over is still allowed as a retry', async () => {
  const call = { id: 'c', type: 'function', function: { name: 'click', arguments: '{"ref":"e1"}' } };
  const { options, skips } = harness([
    { text: '', toolCalls: [call] },
    { text: '', toolCalls: [call] },
    { text: 'done', toolCalls: [] },
  ]);

  const outcome = await runAgentTurn(options);

  assert.deepEqual(outcome, { steps: 3, complete: true });
  assert.deepEqual(skips, []);
});

test('a run of scrolls stops the turn even when each one differs', async () => {
  // Four different arguments, so only the scroll run can end this turn.
  const directions = ['top', 'bottom', 'down', 'up', 'down'];
  const { options, skips } = harness(
    directions.map((direction, i) => ({
      text: '',
      toolCalls: [{ id: `s${i}`, type: 'function', function: { name: 'scroll', arguments: `{"direction":"${direction}"}` } }],
    })),
  );

  const outcome = await runAgentTurn(options);

  assert.deepEqual(outcome, { steps: 4, stalled: true, reason: 'scroll' });
  assert.deepEqual(skips, [{ name: 'scroll', skipped: 'scroll' }]);
});

test('reading the page between scrolls resets the run', async () => {
  const scroll = (i, direction = 'down') => ({
    id: `s${i}`,
    type: 'function',
    function: { name: 'scroll', arguments: `{"direction":"${direction}"}` },
  });
  const read = (i) => ({ id: `r${i}`, type: 'function', function: { name: 'read_page', arguments: `{"n":${i}}` } });
  const { options, skips } = harness([
    { text: '', toolCalls: [scroll(1)] },
    { text: '', toolCalls: [scroll(2, 'up')] },
    { text: '', toolCalls: [read(3)] },
    { text: '', toolCalls: [scroll(4)] },
    { text: 'done', toolCalls: [] },
  ]);

  const outcome = await runAgentTurn(options);

  assert.deepEqual(outcome, { steps: 5, complete: true });
  assert.deepEqual(skips, []);
});
