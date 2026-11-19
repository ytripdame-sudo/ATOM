import test from 'node:test';
import assert from 'node:assert/strict';

import { highlight } from '../extension/lib/highlight.js';
import { windowMessages, nextLimit, PAGE } from '../extension/lib/chat-window.js';
import { renderMarkdown } from '../extension/ui/markdown.js';

test('code is highlighted, and stays escaped', () => {
  const out = highlight('const x = "a<b"; // note', 'js');
  assert.match(out, /tok--keyword">const</);
  assert.match(out, /tok--string">&quot;a&lt;b&quot;</);
  assert.match(out, /tok--comment">\/\/ note</);
  assert.doesNotMatch(out, /<b>/);

  assert.match(highlight('def f():\n  return 1', 'python'), /tok--keyword">def</);
  assert.match(highlight('<a href="x">hi</a>', 'html'), /tok--tag/);
  assert.match(highlight('{"a": 1}', 'json'), /tok--number">1</);
});

test('an unknown language is plain text, not guesswork', () => {
  const out = highlight('SELECT * FROM t', 'sql');
  assert.equal(out, 'SELECT * FROM t');
});

test('a fenced block reaches the reader highlighted, with its copy button', () => {
  const html = renderMarkdown('```js\nconst a = 1;\n```');
  assert.match(html, /class="code__copy"/);
  assert.match(html, /tok--keyword/);
  assert.match(html, /lang-js/);
});

test('a long conversation draws its newest page and counts the rest', () => {
  const messages = Array.from({ length: PAGE + 12 }, (_, i) => ({ id: `m${i}`, role: 'user', text: String(i) }));
  const page = windowMessages(messages);

  assert.equal(page.messages.length, PAGE);
  assert.equal(page.hidden, 12);
  assert.equal(page.messages.at(-1).id, `m${PAGE + 11}`, 'the newest message is on the page');
  assert.equal(page.messages[0].id, `m${12}`, 'the page starts after what is hidden');

  assert.deepEqual(windowMessages(messages.slice(0, 5)), { messages: messages.slice(0, 5), hidden: 0 });
  assert.equal(nextLimit(PAGE), PAGE * 2);
});
