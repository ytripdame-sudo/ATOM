import test from 'node:test';
import assert from 'node:assert/strict';

import { maskSecrets, redactionNote } from '../extension/lib/redact.js';
import { formatPageForModel } from '../extension/lib/page.js';
import { formatConsole, formatNetwork } from '../extension/lib/capture.js';
import { toProviderMessages } from '../extension/lib/session.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

test('tokens, keys and addresses are masked, not dropped', () => {
  const { text, count } = maskSecrets(
    `Authorization: Bearer ${JWT} and sk-abcdefghijklmnopqrstuvwx and ghp_${'a'.repeat(24)} — ping jane.doe@example.com`,
  );

  assert.match(text, /authorization: \[redacted\]/i);
  assert.match(text, /\[redacted key\]/);
  assert.match(text, /\[redacted email\]/);
  assert.doesNotMatch(text, /eyJhbGci/);
  assert.doesNotMatch(text, /sk-abcdef/);
  assert.doesNotMatch(text, /jane\.doe@/);
  assert.equal(count, 4);
});

test('a scheme plus credential is masked wherever it appears', () => {
  const { text } = maskSecrets('GET https://api.example.com/v1/me (Bearer abcdef123456)');
  assert.match(text, /Bearer \[redacted\]/);
  assert.doesNotMatch(text, /abcdef123456/);
});

test('query parameters keep their name and their neighbours', () => {
  const { text, count } = maskSecrets('https://api.example.com/cart?user=42&api_key=sk_live_9f8e7d6c5b4a&page=2');

  assert.equal(text, 'https://api.example.com/cart?user=42&api_key=[redacted]&page=2');
  assert.equal(count, 1, 'the masked value is not counted twice by a later rule');
});

test('labelled secrets in prose are masked, and count once', () => {
  const { text, count } = maskSecrets('login failed with password: hunter2000 and api_key=abcd1234');
  assert.match(text, /password: \[redacted\]/);
  assert.match(text, /api_key: \[redacted\]/);
  assert.equal(count, 2);
});

test('cookie jars and stored session tokens are masked', () => {
  const headers = maskSecrets(
    'Cookie: SID=abc123def456; theme=dark\nSet-Cookie: sessionid=deadbeefcafe; Path=/',
  );
  assert.doesNotMatch(headers.text, /abc123def456|deadbeefcafe/);
  assert.match(headers.text, /\[redacted cookies\]/);

  const pairs = maskSecrets('"SID=abc123def456; HSID=deadbeefcafe; theme=dark"');
  assert.doesNotMatch(pairs.text, /abc123def456|deadbeefcafe/);
  assert.match(pairs.text, /theme=dark/, 'ordinary cookie values still read');

  const stored = maskSecrets(
    JSON.stringify({ accessToken: 'tok_live_abcdef', sessionId: 'sess_123456', theme: 'dark' }),
  );
  assert.doesNotMatch(stored.text, /tok_live_abcdef|sess_123456/);
  assert.match(stored.text, /theme/);
});

test('private key blocks go whole', () => {
  const { text } = maskSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----');
  assert.equal(text, '[redacted private key]');
});

test('ordinary text and harmless urls are left alone', () => {
  const plain = 'The price is $5.00, the id is 42, and the docs are at https://example.com/guide?page=3.';
  const { text, count } = maskSecrets(plain);
  assert.equal(text, plain);
  assert.equal(count, 0);
});

test('the note says how many values were masked', () => {
  assert.match(redactionNote(1, 'page'), /^Redacted: 1 value/);
  assert.match(redactionNote(3, 'console'), /^Redacted: 3 values/);
  assert.match(redactionNote(3, 'console'), /masked view/);
});

test('a page result is masked and carries the note', () => {
  const text = formatPageForModel({
    title: 'Account',
    url: 'https://example.com/account?token=abc123def456',
    text: 'Signed in as jane@example.com.',
    headings: [{ level: 1, text: 'Your account' }],
    elements: [{ ref: 'e1', kind: 'link', name: 'API key', href: 'https://example.com/key?api_key=abcd1234' }],
    forms: { password: true },
  });

  assert.match(text, /^Redacted: [1-9]/);
  assert.match(text, /token=\[redacted\]/);
  assert.match(text, /\[redacted email\]/);
  assert.match(text, /api_key=\[redacted\]/);
  assert.doesNotMatch(text, /abc123def456/);
  assert.doesNotMatch(text, /jane@example\.com/);
  assert.match(text, /\[e1\] link "API key"/, 'the element list still reads');
});

test('a clean page result has no note and is unchanged', () => {
  const text = formatPageForModel({ title: 'Docs', url: 'https://example.com/docs', text: 'Hello world', elements: [] });
  assert.doesNotMatch(text, /^Redacted:/);
  assert.match(text, /Hello world/);
});

test('console output masks arguments and says it did', () => {
  const text = formatConsole([
    {
      at: Date.now(),
      level: 'error',
      text: `Failed with Authorization: Bearer ${JWT}`,
      url: 'https://example.com/app.js',
      line: 12,
    },
  ]);

  assert.match(text, /^Redacted: 1 value/);
  assert.match(text, /authorization: \[redacted\]/i);
  assert.doesNotMatch(text, /eyJhbGci/);
  assert.match(text, /app\.js:12/, 'the source is still there to debug with');
});

test('failed requests mask the token but keep the failing id', () => {
  const text = formatNetwork([
    {
      at: Date.now(),
      method: 'POST',
      url: 'https://api.example.com/orders/42?session_id=deadbeefcafe&retry=1',
      type: 'Fetch',
      status: 500,
      error: '',
    },
  ]);

  assert.match(text, /^Redacted: 1 value/);
  assert.match(text, /session_id=\[redacted\]/);
  assert.match(text, /orders\/42/);
  assert.match(text, /retry=1/);
  assert.match(text, /500/);
});

test('the system prompt masks the tab address and warns about [redacted]', () => {
  const [system] = toProviderMessages({
    messages: [],
    settings: { instructions: '' },
    tab: { title: 'Sign in', url: 'https://example.com/?token=abc123def456' },
    capabilities: { pageAccess: true },
  });

  assert.match(system.content, /token=\[redacted\]/);
  assert.doesNotMatch(system.content, /abc123def456/);
  assert.match(system.content, /\[redacted\] where a credential or email address was masked/);
});

test('clean console and network blocks have no note', () => {
  const at = Date.now();
  assert.doesNotMatch(formatConsole([{ at, level: 'log', text: 'ready', url: '', line: null }]), /^Redacted:/);
  assert.doesNotMatch(
    formatNetwork([{ at, method: 'GET', url: 'https://example.com/x?page=2', type: 'XHR', status: 404, error: '' }]),
    /^Redacted:/,
  );
});
