import test from 'node:test';
import assert from 'node:assert/strict';

import { runAgentTurn } from '../extension/lib/agent/loop.js';

const TOOLS = [{ type: 'function', function: { name: 'read_page' } }];

function harness(responses, { maxSteps, signal } = {}) {
  let index = 0;
  const requests = [];
  const ranTools = [];
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
    runTool: async (call) => {
      ranTools.push(call.function.name);
    },
  };

  return { options, requests, ranTools, turns };
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
  const call = { id: 'c', type: 'function', function: { name: 'read_page', arguments: '{}' } };
  const { options, requests } = harness(Array.from({ length: 10 }, () => ({ text: '', toolCalls: [call] })), {
    maxSteps: 3,
  });

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
