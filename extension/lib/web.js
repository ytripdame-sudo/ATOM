/**
 * Web lookups that run in the worker: no page grant, no content script, no
 * injection. Both backends are public APIs that answer without a key, which is
 * why they are the ones this build ships — a general search API needs a signup,
 * and pretending otherwise would be the same lie the model used to tell
 * ("grant site access and I'll search").
 *
 * Everything that comes back here is untrusted text. It is masked and fenced
 * like page content before the model ever sees it.
 */

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const OPENVERSE_SEARCH = 'https://api.openverse.org/v1/images/';

/** Tags out, whitespace collapsed: Wikipedia snippets arrive with <span> marks. */
function tidy(text) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function wikiUrl(title) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(String(title).replace(/ /g, '_'))}`;
}

/**
 * Reference lookup. Wikipedia covers facts, people, places, history, science
 * and definitions — not news, prices, scores or shopping, and the caller is
 * told that in the tool description.
 */
export async function searchReference(query, { signal, fetchFn = fetch, limit = 5 } = {}) {
  const text = String(query || '').trim();
  if (!text) return { results: [] };

  const url =
    `${WIKI_API}?action=query&list=search&format=json&origin=*` +
    `&srsearch=${encodeURIComponent(text)}&srlimit=${Math.min(10, Math.max(1, limit))}`;

  const response = await fetchFn(url, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Wikipedia answered ${response.status}.`);

  const data = await response.json();
  const results = (data?.query?.search ?? [])
    .map((hit) => ({
      title: tidy(hit?.title),
      url: wikiUrl(tidy(hit?.title)),
      snippet: tidy(hit?.snippet),
    }))
    .filter((hit) => hit.title && hit.url);

  return { results };
}

/**
 * Openly licensed pictures. Thumbnails are shown; the landing page carries the
 * creator and the licence, so that is what the model is given to cite.
 */
export async function searchImages(query, { signal, fetchFn = fetch, limit = 3 } = {}) {
  const text = String(query || '').trim();
  if (!text) return [];

  const size = Math.min(4, Math.max(1, limit));
  const url = `${OPENVERSE_SEARCH}?q=${encodeURIComponent(text)}&page_size=${size}&license_type=all-cc&mature=false`;

  const response = await fetchFn(url, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Openverse answered ${response.status}.`);

  const data = await response.json();
  return (data?.results ?? [])
    .map((image) => ({
      title: tidy(image?.title) || 'Image',
      // The thumbnail is what the panel loads; the full file can be huge.
      url: String(image?.thumbnail || image?.url || ''),
      page: String(image?.foreign_landing_url || ''),
      creator: tidy(image?.creator),
      license: tidy([image?.license, image?.license_version].filter(Boolean).join(' ')),
    }))
    .filter((image) => /^https:\/\//.test(image.url));
}
