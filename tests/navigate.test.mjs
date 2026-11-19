import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isAllowedUrl,
  namedSiteHome,
  namedSiteTarget,
  namedSiteUrls,
  navigateProblem,
  normalizeUrl,
  siteNameInRequest,
  urlsInText,
} from '../extension/lib/agent/navigate.js';

test('addresses in the user message are found, bare ones get https', () => {
  assert.deepEqual(urlsInText('open https://github.com/facebook/react please'), ['https://github.com/facebook/react']);
  assert.deepEqual(urlsInText('goto discord.gg'), ['https://discord.gg']);
  assert.deepEqual(urlsInText('look at example.com/docs, then stop.'), ['https://example.com/docs']);

  // Ordinary prose is not an address.
  assert.deepEqual(urlsInText('search for a react table, e.g. the best one'), []);
  assert.deepEqual(urlsInText('goto discord'), []);
});

test('a site named in the request is openable without a search', () => {
  const urls = namedSiteUrls('head over to youtube and play chief keef');
  assert.ok(urls.includes('https://www.youtube.com'));
  assert.ok(urls.includes('https://www.youtube.com/results?search_query=chief%20keef'));
  assert.equal(isAllowedUrl('https://www.youtube.com', urls), true);
  assert.equal(isAllowedUrl('https://www.youtube.com/results?search_query=chief%20keef', urls), true);
  assert.equal(urlsInText('goto discord').length, 0, 'a prose name is not a typed address');
  assert.deepEqual(namedSiteUrls('goto discord'), ['https://discord.com', 'https://discord.gg']);
  assert.deepEqual(namedSiteUrls('goto yt'), ['https://www.youtube.com', 'https://youtube.com']);
  assert.equal(siteNameInRequest('goto bbc'), 'bbc');
  assert.equal(siteNameInRequest('take me to the bbc website'), 'bbc');
  assert.equal(siteNameInRequest('goto bbc.com'), '');
  assert.equal(siteNameInRequest('open a new tab'), '');
  assert.equal(siteNameInRequest('make a youtube playlist'), '');
  assert.ok(namedSiteUrls('play chief keef on yt').some((url) => url.includes('search_query=chief%20keef')));
  assert.equal(namedSiteTarget('head over to youtube and play chief keef'), 'https://www.youtube.com/results?search_query=chief%20keef');
  assert.equal(namedSiteTarget('bro goto yt'), 'https://www.youtube.com');
  assert.equal(namedSiteHome('google'), 'https://www.google.com');
  assert.equal(namedSiteHome('google maps'), '', 'a longer name is not the Google homepage');
  assert.equal(namedSiteTarget('goto instagram @vureld'), 'https://www.instagram.com/vureld');
  assert.equal(namedSiteTarget('instagram @vureld'), 'https://www.instagram.com/vureld');
  assert.deepEqual(namedSiteUrls('goto instagram @vureld'), [
    'https://www.instagram.com',
    'https://www.instagram.com/vureld',
  ]);
});

test('a longer unknown site name is not cut off by a word limit', () => {
  assert.equal(
    siteNameInRequest('take me to the museum of modern art new york'),
    'museum of modern art new york',
  );
});

test('comparison ignores the hash and a trailing slash, not the host or path', () => {
  assert.equal(normalizeUrl('https://example.com/a/#x'), 'https://example.com/a');
  assert.equal(normalizeUrl('https://example.com/a/'), 'https://example.com/a');
  assert.equal(normalizeUrl('javascript:alert(1)'), '');
  assert.equal(normalizeUrl('not a url'), '');

  const allowed = ['https://github.com/facebook/react'];
  assert.equal(isAllowedUrl('https://github.com/facebook/react/', allowed), true);
  assert.equal(isAllowedUrl('https://github.com/facebook/react#readme', allowed), true);
});

test('a guessed domain is not allowed, whatever it looks like', () => {
  const allowed = ['https://github.com/facebook/react'];
  assert.equal(isAllowedUrl('https://githubrepo.com', allowed), false);
  assert.equal(isAllowedUrl('https://github.com/other/repo', allowed), false);
  assert.equal(isAllowedUrl('https://githubrepo.com', []), false);
});

test('a parked or error page is called out after it loads', () => {
  assert.match(navigateProblem({ title: 'githubrepo.com is for sale', url: 'https://githubrepo.com' }), /for sale|listing/);
  assert.match(navigateProblem({ title: 'Buy this domain — hugedomains', url: 'https://x.test' }), /sale/);
  assert.match(navigateProblem({ title: '404 Not Found', url: 'https://x.test' }), /404/);
  assert.match(navigateProblem({ title: 'Just a moment...', url: 'https://x.test' }), /Just a moment/);
  assert.match(navigateProblem({ title: 'Something', url: 'https://sedoparking.com/x' }), /parking/);
  assert.match(navigateProblem({ title: '', url: 'https://x.test' }), /no title/);

  assert.equal(navigateProblem({ title: 'facebook/react: The library for web UIs', url: 'https://github.com/facebook/react' }), '');
});
