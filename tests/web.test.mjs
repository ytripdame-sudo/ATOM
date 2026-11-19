import test from 'node:test';
import assert from 'node:assert/strict';

import { searchImages, searchReference } from '../extension/lib/web.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/* ------------------------------------------------------------- reference */

test('a reference search turns hits into titled results with addresses', async () => {
  let asked = '';
  const { results } = await searchReference('the odyssey', {
    fetchFn: async (url) => {
      asked = String(url);
      return json({
        query: {
          search: [
            {
              title: 'Odyssey',
              snippet: 'The <span class="searchmatch">Odyssey</span> is one of two major &quot;epics&quot;.',
            },
            { title: 'Homer', snippet: 'Ancient Greek poet.' },
          ],
        },
      });
    },
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'Odyssey');
  assert.equal(results[0].url, 'https://en.wikipedia.org/wiki/Odyssey');
  assert.equal(results[0].snippet, 'The Odyssey is one of two major "epics".');
  assert.match(asked, /srsearch=the%20odyssey/);
  assert.match(asked, /srlimit=5/);
});

test('an empty query asks nothing, and no hits is an empty list', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return json({ query: { search: [] } });
  };

  assert.deepEqual((await searchReference('   ', { fetchFn })).results, []);
  assert.equal(calls, 0, 'an empty query never leaves the extension');

  assert.deepEqual((await searchReference('zzzz', { fetchFn })).results, []);
  assert.equal(calls, 1);
});

test('an error status is raised so the worker can say the lookup failed', async () => {
  await assert.rejects(
    () => searchReference('x', { fetchFn: async () => json({}, 503) }),
    /Wikipedia answered 503/,
  );
});

/* ---------------------------------------------------------------- pictures */

test('pictures map to a thumbnail, a credit and a page — https only', async () => {
  let asked = '';
  const images = await searchImages('homer bust', {
    fetchFn: async (url) => {
      asked = String(url);
      return json({
        results: [
          {
            title: 'Homer',
            thumbnail: 'https://upload.wikimedia.org/thumb/homer.jpg',
            url: 'https://upload.wikimedia.org/homer.jpg',
            foreign_landing_url: 'https://commons.wikimedia.org/wiki/File:Homer.jpg',
            creator: 'Unknown',
            license: 'by',
            license_version: '4.0',
          },
          { title: 'Broken', thumbnail: 'http://insecure.example/x.jpg', url: 'http://insecure.example/x.jpg' },
        ],
      });
    },
  });

  assert.equal(images.length, 1, 'an http picture is dropped rather than loaded');
  assert.equal(images[0].url, 'https://upload.wikimedia.org/thumb/homer.jpg');
  assert.equal(images[0].page, 'https://commons.wikimedia.org/wiki/File:Homer.jpg');
  assert.equal(images[0].license, 'by 4.0');
  assert.match(asked, /q=homer%20bust/);
  assert.match(asked, /page_size=3/);
});

test('how many pictures is kept between one and four', async () => {
  const sizes = [];
  const fetchFn = async (url) => {
    sizes.push(String(url).match(/page_size=(\d+)/)[1]);
    return json({ results: [] });
  };

  await searchImages('a', { limit: 9, fetchFn });
  await searchImages('a', { limit: 0, fetchFn });
  assert.deepEqual(sizes, ['4', '1']);
});

test('an empty picture query returns nothing without a request', async () => {
  let calls = 0;
  const images = await searchImages('  ', {
    fetchFn: async () => {
      calls += 1;
      return json({ results: [] });
    },
  });

  assert.deepEqual(images, []);
  assert.equal(calls, 0);
});
