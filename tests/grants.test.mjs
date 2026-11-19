import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRANT_KINDS,
  MAX_GRANTS,
  addGrant,
  grantCovers,
  grantOffer,
  hasGrant,
  normalizeGrants,
  removeGrant,
} from '../extension/lib/grants.js';

const page = 'https://example.com/watch?v=1';

test('a confirmation offers one action on one site', () => {
  assert.deepEqual(grantOffer({ tool: 'click', refMeta: { kind: 'button' }, pageUrl: page }), {
    kind: 'click',
    host: 'example.com',
    label: 'clicking',
  });
  assert.equal(grantOffer({ tool: 'scroll', pageUrl: page }).kind, 'scroll');
  assert.equal(grantOffer({ tool: 'select_option', pageUrl: page }).kind, 'select_option');
  assert.equal(grantOffer({ tool: 'type_text', refMeta: { kind: 'input' }, pageUrl: page }).kind, 'type_text');
  assert.equal(grantOffer({ tool: 'navigate', targetUrl: 'https://example.com/next', pageUrl: page }).kind, 'navigate');
});

test('submitting is never offered, however the tools express it', () => {
  assert.equal(grantOffer({ tool: 'type_text', args: { submit: true }, refMeta: { kind: 'input' }, pageUrl: page }), null);
  assert.equal(grantOffer({ tool: 'click', refMeta: { kind: 'button', submits: true }, pageUrl: page }), null);
  // There is no submit tool, and there must never be a submit grant.
  assert.equal(grantOffer({ tool: 'submit', pageUrl: page }), null);
  assert.equal(GRANT_KINDS.includes('submit'), false);
});

test('a password, card or one-time-code field is never offered', () => {
  for (const sensitive of ['password', 'card', 'otp']) {
    assert.equal(grantOffer({ tool: 'type_text', refMeta: { kind: 'input', sensitive }, pageUrl: page }), null, sensitive);
  }
});

test('leaving the site is never offered', () => {
  assert.equal(
    grantOffer({ tool: 'click', refMeta: { kind: 'link', href: 'https://elsewhere.net/x' }, pageUrl: page }),
    null,
  );
  assert.equal(grantOffer({ tool: 'navigate', targetUrl: 'https://elsewhere.net/x', pageUrl: page }), null);
  // A same-site path resolves against the page, so it is the same site.
  assert.equal(grantOffer({ tool: 'click', refMeta: { kind: 'link', href: '/next' }, pageUrl: page }).kind, 'click');
});

test('a grant covers only its own host and action', () => {
  const grants = addGrant([], { host: 'example.com', kind: 'click' });

  assert.ok(grantCovers({ grants, tool: 'click', refMeta: { kind: 'button' }, pageUrl: page }));
  assert.ok(!grantCovers({ grants, tool: 'type_text', refMeta: { kind: 'input' }, pageUrl: page }));
  assert.ok(!grantCovers({ grants, tool: 'click', refMeta: { kind: 'button' }, pageUrl: 'https://other.example/x' }));
});

test('a grant cannot widen into the floors, even sitting in storage', () => {
  const grants = normalizeGrants([
    { host: 'example.com', kind: 'click', at: 1 },
    { host: 'example.com', kind: 'type_text', at: 2 },
    { host: 'example.com', kind: 'navigate', at: 3 },
  ]);

  assert.ok(!grantCovers({ grants, tool: 'click', refMeta: { kind: 'button', submits: true }, pageUrl: page }));
  assert.ok(
    !grantCovers({ grants, tool: 'click', refMeta: { kind: 'link', href: 'https://elsewhere.net' }, pageUrl: page }),
  );
  assert.ok(!grantCovers({ grants, tool: 'type_text', args: { submit: true }, refMeta: { kind: 'input' }, pageUrl: page }));
  assert.ok(
    !grantCovers({ grants, tool: 'type_text', refMeta: { kind: 'input', sensitive: 'password' }, pageUrl: page }),
  );
  assert.ok(!grantCovers({ grants, tool: 'navigate', targetUrl: 'https://elsewhere.net', pageUrl: page }));
});

test('stored grants are normalised, deduped, capped and revocable', () => {
  const grants = normalizeGrants([
    { host: 'Example.COM', kind: 'click', at: 5 },
    { host: 'example.com', kind: 'click' },
    { host: 'example.com', kind: 'submit' },
    { host: '', kind: 'click' },
    null,
  ]);

  assert.deepEqual(grants, [{ host: 'example.com', kind: 'click', at: 5 }]);
  assert.deepEqual(removeGrant(grants, { host: 'example.com', kind: 'click' }), []);
  assert.ok(hasGrant(addGrant([], { host: 'example.com', kind: 'scroll' }), 'example.com', 'scroll'));

  const many = Array.from({ length: MAX_GRANTS + 5 }, (_, index) => ({ host: `site${index}.example`, kind: 'click' }));
  assert.equal(normalizeGrants(many).length, MAX_GRANTS);
});
