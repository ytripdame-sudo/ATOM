import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, renderMarkdown } from '../extension/ui/markdown.js';
import { HOSTILE } from './hostile.mjs';

/**
 * `extension/ui/markdown.js` is the only place model output — and therefore any
 * page text the model quotes back — becomes HTML inside the extension's own
 * origin. The design is escape-first: the whole string is escaped, then a small
 * set of formatting rules runs over the escaped text. These tests pin that order
 * from the outside, with the same hostile payloads the fence tests use, so a
 * later feature (tables, inline HTML, a richer link rule) cannot quietly turn
 * one of those payloads into markup.
 */

/** The only tags the renderer is allowed to produce. */
const EMITTED = new Set([
  'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'div', 'span', 'button', 'a', 'ul', 'ol', 'li',
  'h3', 'h4', 'h5', 'h6',
]);

const DANGEROUS = /<(script|img|iframe|object|embed|style|svg|math|form|input|link|base)\b/i;

const HOSTILE_LINES = HOSTILE.split('\n');

const emitted = (html) => [...html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/g)].map((match) => match[2].toLowerCase());

const hrefs = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);

/** Every tag in the output is one the renderer emits, and no raw markup survives. */
function assertInert(html, label) {
  const unexpected = emitted(html).filter((tag) => !EMITTED.has(tag));
  assert.deepEqual(unexpected, [], `${label}: unexpected tag(s) in ${html}`);
  assert.doesNotMatch(html, DANGEROUS, label);
}

/** Any anchor that survived must point at http(s), whatever the input said. */
function assertHttpLinks(html, label) {
  for (const href of hrefs(html)) {
    assert.match(href, /^https?:\/\//i, `${label}: "${href}" is not an http(s) link`);
  }
}

test('every hostile payload renders as text, with no markup of its own', () => {
  for (const line of HOSTILE_LINES) {
    const html = renderMarkdown(line);
    assertInert(html, line);
    assertHttpLinks(html, line);
    assert.ok(html.length > 0, `nothing rendered for: ${line}`);
    // Escaped, not dropped: the reader still sees what the page said.
    if (line.includes('<')) assert.match(html, /&lt;/, line);
    if (line.includes('>')) assert.match(html, /&gt;/, line);
  }

  // And the same lines as one document, where blocks meet each other.
  const whole = renderMarkdown(HOSTILE);
  assertInert(whole, 'the whole hostile blob');
  assertHttpLinks(whole, 'the whole hostile blob');
  assert.match(whole, /javascript:alert\(document\.cookie\)/, 'the payload is still readable');
});

test('a script tag is escaped in prose and inside a code block', () => {
  const prose = renderMarkdown('hello <script>alert(1)</script>');
  assert.equal(prose, '<p>hello &lt;script&gt;alert(1)&lt;/script&gt;</p>');

  const fenced = renderMarkdown('```html\n<script>alert(1)</script>\n```');
  // Highlighting wraps the tags in spans, so the assertion is on the escaped
  // text being there at all — and on nothing becoming an element.
  assert.match(fenced, /&lt;script&gt;/);
  assert.match(fenced, /alert\(1\)/);
  assertInert(fenced, 'fenced script');
});

test('an image with an onerror handler never becomes an element', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.equal(html, '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assertInert(html, 'img');
});

test('a link label cannot break out of the anchor', () => {
  const html = renderMarkdown('["><img src=x onerror=alert(1)>](https://ok.example/x)');

  assertInert(html, 'label');
  assert.deepEqual(hrefs(html), ['https://ok.example/x']);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /target="_blank"/);
});

test('a link whose scheme is not http(s) stays text', () => {
  const payloads = [
    '[click](javascript:alert(document.cookie))',
    '[click](JavaScript:alert(1))',
    '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[click](vbscript:msgbox(1))',
    '[click](file:///etc/passwd)',
    '[click](//evil.example/collect)',
    '[click](mailto:someone@example.com)',
  ];

  for (const payload of payloads) {
    const html = renderMarkdown(payload);
    assert.deepEqual(hrefs(html), [], `${payload} became a link`);
    assertInert(html, payload);
  }
});

test('a bare address is linked only when it is http(s)', () => {
  const safe = renderMarkdown('see https://ok.example/x for details');
  assert.equal(hrefs(safe).length, 1);
  assertHttpLinks(safe, 'bare https');

  const unsafe = renderMarkdown('run javascript:alert(1) instead');
  assert.deepEqual(hrefs(unsafe), []);
  assert.match(unsafe, /javascript:alert\(1\)/);
});

test('an allowed link keeps its address escaped, whatever is in it', () => {
  const html = renderMarkdown('[docs](https://ok.example/a?b=<script>)');

  assert.deepEqual(hrefs(html), ['https://ok.example/a?b=&lt;script&gt;']);
  assertInert(html, 'hostile query string');
  assertHttpLinks(html, 'hostile query string');
});

test('code spans are text, and formatting does not run inside them', () => {
  const html = renderMarkdown('use `**not bold** <b>x</b>` here');

  assert.match(html, /<code>\*\*not bold\*\* &lt;b&gt;x&lt;\/b&gt;<\/code>/);
  assert.doesNotMatch(html, /<strong>/);
  assert.doesNotMatch(html, /<b>/);
});

test('the five HTML characters are escaped before any rule runs', () => {
  assert.equal(escapeHtml(`& < > " '`), '&amp; &lt; &gt; &quot; &#39;');

  const html = renderMarkdown(`Tom & Jerry said "hi" & 'bye'`);
  assert.match(html, /Tom &amp; Jerry/);
  assert.match(html, /&quot;hi&quot;/);
  assert.match(html, /&#39;bye&#39;/);
});

test('an unterminated fence while streaming stays an escaped code block', () => {
  const html = renderMarkdown('```\n<img src=x onerror=alert(1)>');

  // The code block now names its language for highlighting; the escaping is
  // what this test is about, so it must survive the added class.
  assert.match(html, /<pre><code[^>]*>&lt;img src=x onerror=alert\(1\)&gt;<\/code><\/pre>/);
  assertInert(html, 'streaming fence');
});
