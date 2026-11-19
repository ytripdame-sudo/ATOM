import test from 'node:test';
import assert from 'node:assert/strict';

import { formatDigestForModel, formatPageForModel } from '../extension/lib/page.js';

function page(overrides = {}) {
  return {
    url: 'https://example.com/x',
    title: 'Example',
    text: 'A short page about examples. '.repeat(20),
    headings: [
      { level: 1, text: 'Example' },
      { level: 2, text: 'Details' },
    ],
    elements: [{ ref: 'e1', kind: 'link', name: 'Docs', href: 'https://docs.example.org/y' }],
    truncated: false,
    ...overrides,
  };
}

test('the digest is small: capped elements and capped text', () => {
  const elements = Array.from({ length: 30 }, (_, index) => ({
    ref: `e${index + 1}`,
    kind: 'link',
    name: `Link ${index + 1}`,
  }));
  const digest = formatDigestForModel(page({ elements }));

  assert.match(digest, /first 20:/);
  assert.match(digest, /… 10 more/);
  assert.match(digest, /call read_page/);
  assert.ok(digest.length < 4000, `digest is ${digest.length} chars`);
  // A long page is cut, and says so, instead of arriving whole.
  assert.match(formatDigestForModel(page({ text: 'x'.repeat(5000) })), /…/);
});

test('the digest names the page, its headings and the refs it carries', () => {
  const digest = formatDigestForModel(page());

  assert.match(digest, /^Page: Example — https:\/\/example\.com\/x/);
  assert.match(digest, /Headings: H1 Example · H2 Details/);
  assert.match(digest, /\[e1\] link "Docs" → https:\/\/docs\.example\.org\/y/);
  assert.match(digest, /Opening text: A short page about examples\./);
});

test('credentials in the digest are masked before the model sees them', () => {
  const digest = formatDigestForModel(page({ text: 'Write to jane@example.com about it.' }));

  assert.doesNotMatch(digest, /jane@example\.com/);
  assert.match(digest, /\[redacted/);
  assert.match(digest, /page digest/);
});

test('a page with no controls still reads as a sentence', () => {
  const digest = formatDigestForModel(page({ elements: [], text: '', headings: [] }));

  assert.match(digest, /Interactive elements: none found/);
  assert.doesNotMatch(digest, /Opening text/);
});

test('a text field deep in a long page survives the element cut', () => {
  // Discord and other long pages put the composer last; if the cut drops it the
  // model scrolls around instead of typing, which is the bug this guards.
  const elements = Array.from({ length: 90 }, (_, i) => ({
    ref: `e${i + 1}`,
    kind: 'link',
    name: `Link ${i + 1}`,
    href: 'https://example.com/x',
  }));
  elements.push({ ref: 'e91', kind: 'editable', name: 'Message', placeholder: 'Message #general' });

  const text = formatPageForModel(
    { title: 'Discord', url: 'https://discord.com/app', elements },
    { maxElements: 20 },
  );

  assert.match(text, /\[e91\] editable/);
  assert.match(text, /Message #general/);
  assert.match(text, /20 of 91/, 'the cut still happens, it just keeps the fields');
});
