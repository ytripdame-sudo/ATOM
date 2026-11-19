import test from 'node:test';
import assert from 'node:assert/strict';

import { extractTitle, readableText } from '../extension/lib/search/extract.js';
import { chunkText, rankChunks, terms } from '../extension/lib/search/chunks.js';
import { parseBing, parseDuckDuckGo, SEARCH_PROVIDERS, searchReady } from '../extension/lib/search/providers.js';
import { createSearchCache, formatSearch, runSearch, sourcesFrom } from '../extension/lib/search/index.js';
import { normalizeSettings, publicSettings } from '../extension/lib/settings.js';

/* --------------------------------------------------------------- extract */

const PAGE = `<!doctype html><html><head><title>Home &amp; Garden</title><style>.x{}</style></head>
<body><nav>Home About Contact</nav><article><h1>Bees</h1><p>Bees are insects.</p>
<script>alert('x')</script><p>The hive &quot;hums&quot; &mdash; loudly.</p></article>
<footer>Copyright</footer><aside>Share this</aside></body></html>`;

test('readable text drops chrome and keeps the article', () => {
  const text = readableText(PAGE);

  assert.match(text, /Bees are insects/);
  assert.match(text, /The hive "hums" — loudly/);
  assert.doesNotMatch(text, /alert\('x'\)|\.x\{|Home About Contact|Copyright|Share this/);
  assert.equal(extractTitle(PAGE), 'Home & Garden');
});

test('a page with no article falls back to its body', () => {
  const text = readableText('<html><body><div><p>Plain page.</p></div></body></html>');
  assert.match(text, /Plain page/);
});

/* ---------------------------------------------------------------- chunks */

test('chunks are paragraph-shaped and bounded', () => {
  const paragraphs = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} ${'word '.repeat(40)}`);
  const chunks = chunkText(paragraphs.join('\n\n'), 400);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 620, `chunk too big: ${chunk.length}`);
});

test('ranking keeps the chunk that answers the question, within budget', () => {
  const pages = [
    {
      url: 'https://a.test',
      title: 'A',
      text: 'Bees make honey in hives. '.repeat(30) + '\n\nUnrelated text about tractors and fields.',
    },
    {
      url: 'https://b.test',
      title: 'B',
      text: 'Cooking pasta needs boiling water. '.repeat(20),
    },
  ];

  assert.deepEqual(terms('How do bees make honey?'), ['bees', 'make', 'honey']);

  const picked = rankChunks(pages, 'how do bees make honey', 900);
  assert.ok(picked.length);
  assert.equal(picked[0].url, 'https://a.test');
  const total = picked.reduce((sum, chunk) => sum + chunk.text.length, 0);
  assert.ok(total <= 900, `budget exceeded: ${total}`);
});

/* ------------------------------------------------------------- providers */

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    headers: { get: () => 'application/json' },
  };
}

test('Brave is sent the key and returns titles, addresses and snippets', async () => {
  let seen;
  const results = await SEARCH_PROVIDERS.brave.search('bees', {
    key: 'brave-key',
    fetchFn: async (url, init) => {
      seen = { url, init };
      return jsonResponse({ web: { results: [{ title: 'Bees', url: 'https://bee.test', description: 'Buzz.' }] } });
    },
  });

  assert.match(seen.url, /q=bees/);
  assert.equal(seen.init.headers['x-subscription-token'], 'brave-key');
  assert.deepEqual(results, [{ title: 'Bees', url: 'https://bee.test', snippet: 'Buzz.' }]);
});

test('Google results come through Serper with the key in a header', async () => {
  let seen;
  const results = await SEARCH_PROVIDERS.serper.search('bees', {
    key: 'serper-key',
    fetchFn: async (url, init) => {
      seen = { url, init };
      return jsonResponse({
        organic: [{ title: 'Bees', link: 'https://bee.test', snippet: 'Buzz.' }],
      });
    },
  });

  assert.equal(seen.url, 'https://google.serper.dev/search');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['x-api-key'], 'serper-key');
  assert.deepEqual(results, [{ title: 'Bees', url: 'https://bee.test', snippet: 'Buzz.' }]);
});

test('a provider without what it needs says so in one line', async () => {
  await assert.rejects(
    () => SEARCH_PROVIDERS.brave.search('bees', { key: '', fetchFn: async () => jsonResponse({}) }),
    /needs an API key/i,
  );
  await assert.rejects(
    () => SEARCH_PROVIDERS.searx.search('bees', { endpoint: '', fetchFn: async () => jsonResponse({}) }),
    /address of your instance/i,
  );
});

test('whether a provider can run is decided from settings', () => {
  const base = normalizeSettings(null);
  assert.equal(searchReady(base), true, 'the default needs no key');

  assert.equal(searchReady({ ...base, search: { ...base.search, provider: 'brave', key: '' } }), false);
  assert.equal(searchReady({ ...base, search: { ...base.search, provider: 'brave', key: 'k' } }), true);
  assert.equal(searchReady({ ...base, search: { ...base.search, provider: 'serper', key: '' } }), false);
  assert.equal(searchReady({ ...base, search: { ...base.search, provider: 'serper', key: 'k' } }), true);
  assert.equal(searchReady({ ...base, search: { ...base.search, provider: 'searx', endpoint: '' } }), false);
  assert.equal(
    searchReady({ ...base, search: { ...base.search, provider: 'searx', endpoint: 'https://searx.test' } }),
    true,
  );
});

/* ------------------------------------------------------------- runSearch */

const settingsFor = (overrides = {}) =>
  normalizeSettings({
    search: { provider: 'wikipedia', budget: 900, ...overrides },
  });

test('a snippet search sends no page requests at all', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return jsonResponse({
      query: { search: [{ title: 'Bees', snippet: '<span>Bees</span> pollinate.' }] },
    });
  };

  const found = await runSearch('bees', { settings: settingsFor({ provider: 'wikipedia' }), fetchFn, cache: createSearchCache() });

  assert.equal(calls.length, 1, 'the chosen provider answered; no page was read');
  assert.match(found.results[0].title, /Bees/);
  assert.equal(found.chunks.length, 0);
  assert.match(formatSearch(found), /Snippets only/);
});

test('depth reads the top pages, keeps relevant passages, and caches the result', async () => {
  const page = (body) =>
    `<html><head><title>Bees</title></head><body><article><p>${body}</p></article></body></html>`;
  let pageFetches = 0;

  const fetchFn = async (url) => {
    if (url.includes('wikipedia.org/w/api.php')) {
      return jsonResponse({
        query: { search: [{ title: 'Bees', snippet: 'Bees are insects.' }] },
      });
    }
    pageFetches += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      // Real pages are big; the extractor refuses anything under 4k of HTML.
      text: async () => page(`Bees make honey and live in hives. ${'Detail. '.repeat(700)}`),
    };
  };

  const cache = createSearchCache();
  const first = await runSearch('bees honey', { settings: settingsFor({ provider: 'wikipedia' }), depth: true, fetchFn, cache });
  assert.equal(pageFetches, 1);
  assert.ok(first.chunks.length, 'no passages came back');
  assert.match(formatSearch(first, { depth: true }), /most relevant/);

  const second = await runSearch('bees honey', { settings: settingsFor({ provider: 'wikipedia' }), depth: true, fetchFn, cache });
  assert.equal(pageFetches, 1, 'the cached search fetched again');
  assert.equal(second.cached, true);
  assert.match(formatSearch(second), /cached/);

  assert.equal(cache.size, 1);
});

test('a failed search is reported, not thrown', async () => {
  const found = await runSearch('bees', {
    settings: settingsFor({ provider: 'brave', key: 'k' }),
    fetchFn: async () => {
      throw new Error('offline');
    },
  });

  assert.deepEqual(found.results, []);
  assert.match(found.error, /offline/);
});

test('citations are the results, capped', () => {
  const payload = {
    results: Array.from({ length: 9 }, (_, i) => ({ title: `T${i}`, url: `https://${i}.test`, snippet: '' })),
  };
  assert.equal(sourcesFrom(payload).length, 6);
});

/* ------------------------------------------------------------ new default */

test('Bing results are parsed locally, redirects decoded', () => {
  const target = 'https://example.com/lee';
  const encoded = 'a1' + Buffer.from(target).toString('base64url');
  const html =
    `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;u=${encoded}">Lee Drilly</a></h2>` +
    '<p class="b_lineclamp2">A drill rapper &amp; more.</p></li>';

  assert.deepEqual(parseBing(html), [
    { title: 'Lee Drilly', url: 'https://example.com/lee', snippet: 'A drill rapper & more.' },
  ]);
  assert.deepEqual(parseBing('<html>nothing</html>'), []);
});

test('DuckDuckGo results are parsed locally, redirects unwrapped', () => {
  const html =
    '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=' +
    encodeURIComponent('https://github.com/foo/bar') +
    '">foo/bar</a><a class="result__snippet">A repo &amp; more</a>';

  assert.deepEqual(parseDuckDuckGo(html), [
    { title: 'foo/bar', url: 'https://github.com/foo/bar', snippet: 'A repo & more' },
  ]);
  assert.deepEqual(parseDuckDuckGo('<html>nothing</html>'), []);
});

test('a DuckDuckGo bot challenge is a failure, not an empty search', async () => {
  await assert.rejects(
    () =>
      SEARCH_PROVIDERS.duckduckgo.search('bees', {
        fetchFn: async () => ({
          ok: true,
          status: 202,
          text: async () => '<html><div class="anomaly-modal__box">bots use DuckDuckGo too</div></html>',
        }),
      }),
    /blocking automated searches/,
  );
});

test('a blocked DuckDuckGo falls through to Bing', async () => {
  const target = 'https://bee.test';
  const encoded = 'a1' + Buffer.from(target).toString('base64url');
  const bing =
    `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;u=${encoded}">Bees</a></h2>` +
    '<p class="b_lineclamp2">Buzz.</p></li>';

  const found = await runSearch('bees', {
    settings: settingsFor({ provider: 'duckduckgo' }),
    fetchFn: async (url) => {
      if (String(url).includes('duckduckgo.com')) return { ok: false, status: 202, text: async () => 'anomaly-modal' };
      if (String(url).includes('bing.com')) return { ok: true, status: 200, text: async () => bing };
      return jsonResponse({ query: { search: [] } });
    },
  });

  assert.equal(found.provider, 'bing');
  assert.equal(found.results[0].url, 'https://bee.test');
  assert.match(found.note, /Bing \(no key\) answered after/);
});

test('a repository question goes to GitHub first, and names the repository', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    if (String(url).includes('api.github.com')) {
      return jsonResponse({
        items: [
          {
            full_name: 'facebook/react',
            html_url: 'https://github.com/facebook/react',
            description: 'A UI library',
            stargazers_count: 100,
          },
        ],
      });
    }
    return jsonResponse({});
  };

  const found = await runSearch('search github for react', { settings: settingsFor(), fetchFn });

  assert.match(urls[0], /api\.github\.com\/search\/repositories\?q=react/);
  assert.equal(found.provider, 'github');
  assert.equal(found.results[0].url, 'https://github.com/facebook/react');
  assert.match(found.results[0].snippet, /★ 100/);
});

test('empty results fall through, and an all-empty search is an error', async () => {
  const found = await runSearch('bees', {
    settings: settingsFor({ provider: 'brave', key: 'k' }),
    fetchFn: async (url) =>
      String(url).includes('brave')
        ? jsonResponse({ web: { results: [] } })
        : jsonResponse({ query: { search: [] } }),
  });

  assert.match(found.error, /Brave Search returned no results/);
  assert.deepEqual(found.results, []);
});

test('a failing provider falls back, and says which one answered', async () => {
  const fetchFn = async (url) => {
    if (String(url).includes('duckduckgo.com')) return { ok: false, status: 429, text: async () => 'limited' };
    return jsonResponse({ query: { search: [{ title: 'Bees', snippet: 'Insects' }] } });
  };

  const found = await runSearch('bees', { settings: settingsFor({ provider: 'duckduckgo' }), fetchFn });

  assert.equal(found.provider, 'wikipedia');
  assert.match(found.note, /rate limiting/i);
  assert.match(formatSearch(found), /Wikipedia \(no key\) answered after/);
});

/* -------------------------------------------------------------- settings */

test('search settings are clamped and the key stays out of the panel', () => {
  const settings = normalizeSettings({
    search: { provider: 'bs', key: 'secret-search', endpoint: 'javascript:x', budget: 99999, auto: 'yes' },
  });

  assert.equal(settings.search.provider, 'duckduckgo');
  assert.equal(settings.search.endpoint, '');
  assert.equal(settings.search.budget, 6000);
  assert.equal(settings.search.auto, false);
  assert.equal(normalizeSettings({ search: { provider: 'serper' } }).search.provider, 'serper');

  const shown = publicSettings(settings);
  assert.equal(shown.search.hasKey, true);
  assert.ok(!JSON.stringify(shown).includes('secret-search'));
});
