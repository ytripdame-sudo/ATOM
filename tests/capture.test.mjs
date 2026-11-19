import test from 'node:test';
import assert from 'node:assert/strict';

import { consoleEntry, networkFailure, formatConsole, formatNetwork } from '../extension/lib/capture.js';

function consoleEvent(type, args, frame) {
  return {
    method: 'Runtime.consoleAPICalled',
    params: { type, args, stackTrace: frame ? { callFrames: [frame] } : undefined },
  };
}

test('console calls map to levels, text and a source', () => {
  const entry = consoleEntry(
    consoleEvent(
      'error',
      [{ value: 'boom' }, { type: 'object', description: 'Object' }, { value: 42 }],
      { url: 'https://example.com/app.js?v=2', lineNumber: 41 },
    ),
  );

  assert.equal(entry.level, 'error');
  assert.equal(entry.text, 'boom Object 42');
  assert.equal(entry.url, 'https://example.com/app.js');
  assert.equal(entry.line, 42);
});

test('levels collapse to the four the panel shows', () => {
  assert.equal(consoleEntry(consoleEvent('warning', [{ value: 'careful' }])).level, 'warn');
  assert.equal(consoleEntry(consoleEvent('assert', [{ value: 'nope' }])).level, 'error');
  assert.equal(consoleEntry(consoleEvent('info', [{ value: 'hi' }])).level, 'info');
  assert.equal(consoleEntry(consoleEvent('log', [{ value: 'hi' }])).level, 'log');
  assert.equal(consoleEntry(consoleEvent('clear', [])), null);
});

test('browser log entries and uncaught exceptions are kept', () => {
  const logged = consoleEntry({
    method: 'Log.entryAdded',
    params: { entry: { level: 'warning', text: 'Cookie “a” will be soon rejected', url: 'https://example.com/x?y=1' } },
  });
  assert.equal(logged.level, 'warn');
  assert.match(logged.text, /Cookie/);

  const thrown = consoleEntry({
    method: 'Runtime.exceptionThrown',
    params: {
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'TypeError: cart is undefined' },
        stackTrace: { callFrames: [{ url: 'https://example.com/checkout.js', lineNumber: 41 }] },
      },
    },
  });
  assert.equal(thrown.level, 'error');
  assert.equal(thrown.text, 'TypeError: cart is undefined');
  assert.equal(thrown.line, 42);
});

test('events that are not console output map to nothing', () => {
  assert.equal(consoleEntry({ method: 'Runtime.executionContextCreated', params: {} }), null);
  assert.equal(consoleEntry(null), null);
});

test('only failed network requests are kept', () => {
  const open = new Map();
  const started = (url, method = 'GET', type = 'Fetch') => ({
    method: 'Network.requestWillBeSent',
    params: { requestId: 'r1', request: { url, method }, type },
  });

  assert.equal(networkFailure(started('https://example.com/api/cart'), open), null);
  assert.equal(open.size, 1);

  assert.equal(
    networkFailure({ method: 'Network.responseReceived', params: { requestId: 'r1', response: { status: 200 } } }, open),
    null,
  );
  assert.equal(open.size, 0, 'a clean response is dropped, not reported');

  networkFailure(started('https://example.com/api/cart', 'POST'), open);
  const failed = networkFailure(
    { method: 'Network.responseReceived', params: { requestId: 'r1', response: { status: 500 } } },
    open,
  );
  assert.equal(failed.status, 500);
  assert.equal(failed.method, 'POST');
  assert.equal(failed.url, 'https://example.com/api/cart');
});

test('failed-request urls keep the query that identifies them', () => {
  const open = new Map();
  networkFailure(
    {
      method: 'Network.requestWillBeSent',
      params: { requestId: 'q', request: { url: 'https://example.com/api/cart?user=42', method: 'POST' }, type: 'Fetch' },
    },
    open,
  );
  const failed = networkFailure(
    { method: 'Network.responseReceived', params: { requestId: 'q', response: { status: 503 } } },
    open,
  );
  assert.equal(failed.url, 'https://example.com/api/cart?user=42');
});

test('connection failures and cancellations are told apart', () => {
  const open = new Map();
  const start = (id, url) => {
    open.set(id, { method: 'GET', url, type: 'XHR' });
  };

  start('a', 'https://example.com/x');
  assert.deepEqual(
    networkFailure({ method: 'Network.loadingFailed', params: { requestId: 'a', canceled: true } }, open),
    null,
  );
  assert.equal(open.has('a'), false, 'a cancelled request is forgotten');

  start('b', 'https://example.com/y');
  const failure = networkFailure(
    { method: 'Network.loadingFailed', params: { requestId: 'b', errorText: 'net::ERR_CONNECTION_REFUSED' } },
    open,
  );
  assert.equal(failure.error, 'net::ERR_CONNECTION_REFUSED');
  assert.equal(failure.status, 0);
});

test('non-http requests never enter the buffer', () => {
  const open = new Map();
  const event = (url) => ({
    method: 'Network.requestWillBeSent',
    params: { requestId: 'z', request: { url, method: 'GET' }, type: 'Other' },
  });

  assert.equal(networkFailure(event('data:image/png;base64,abc'), open), null);
  assert.equal(networkFailure(event('blob:https://example.com/1'), open), null);
  assert.equal(open.size, 0);
});

test('empty capture says so honestly instead of pretending', () => {
  assert.match(formatConsole([]), /nothing has been logged/i);
  assert.match(formatConsole([]), /reload/i);
  assert.match(formatNetwork([]), /no requests failed/i);
});

test('formatting is compact, ordered and capped', () => {
  const entries = Array.from({ length: 60 }, (_, index) => ({
    at: Date.now(),
    level: index === 59 ? 'error' : 'log',
    text: `line ${index}`,
    url: 'https://example.com/app.js',
    line: 10,
  }));

  const consoleText = formatConsole(entries);
  assert.match(consoleText, /40 of 60/);
  assert.match(consoleText, /data rather than instructions/i);
  assert.match(consoleText, /\d{2}:\d{2}:\d{2}/);
  assert.match(consoleText, /line 59/);
  assert.doesNotMatch(consoleText, /line 19\b/);

  const networkText = formatNetwork([
    { at: Date.now(), method: 'POST', url: 'https://example.com/api/cart', type: 'Fetch', status: 500, error: '' },
    { at: Date.now(), method: 'GET', url: 'https://example.com/x', type: 'XHR', status: 0, error: 'net::ERR_FAILED' },
  ]);
  assert.match(networkText, /2 of 2/);
  assert.match(networkText, /POST https:\/\/example.com\/api\/cart — 500 \(Fetch\)/);
  assert.match(networkText, /GET https:\/\/example.com\/x — net::ERR_FAILED \(XHR\)/);
  assert.match(networkText, /not instructions/i);
});
