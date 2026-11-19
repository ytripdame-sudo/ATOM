/**
 * One search call, start to finish: snippets from the configured provider, and
 * — only when asked — the readable text of the top few pages, chunked and
 * ranked against the query before a token of it reaches the model.
 *
 * Results are cached per query and per depth, so asking the same thing twice
 * costs nothing and hits no rate limit. A cached reply says so, because a model
 * pretending it just searched is exactly what this project refuses to do.
 */
import { SEARCH_PROVIDERS, searchProvider, wantsGithub } from './providers.js';
import { extractTitle, readableText } from './extract.js';
import { rankChunks } from './chunks.js';

export const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_PAGES = 5;
const PAGE_TIMEOUT_MS = 8000;

/** A small in-memory cache with a clock, so its behaviour is testable. */
export function createSearchCache(now = () => Date.now()) {
  const entries = new Map();

  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return null;
      if (hit.expires <= now()) {
        entries.delete(key);
        return null;
      }
      return hit.value;
    },
    set(key, value) {
      entries.set(key, { value, expires: now() + CACHE_TTL_MS });
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * @param {string} query
 * @param {object} options
 * @param {object} options.settings normalized settings
 * @param {boolean} [options.depth] read the top pages instead of snippets only
 * @param {Function} [options.fetchFn]
 * @param {AbortSignal} [options.signal]
 * @param {ReturnType<typeof createSearchCache>} [options.cache]
 */
export async function runSearch(query, { settings, depth = false, fetchFn = fetch, signal, cache } = {}) {
  const text = String(query || '').trim();
  if (!text) return { provider: '', results: [], chunks: [], pages: [], error: 'empty' };

  const configured = settings?.search || {};
  const chosen = searchProvider(configured.provider);
  const repository = wantsGithub(text);

  // A repository question goes to GitHub's API first, whatever the default is;
  // the default follows, and Wikipedia is the keyless last resort, so a CAPTCHA
  // or a rate limit costs a fallback rather than the answer.
  const attempts = [];
  const attempt = (provider) => {
    if (provider && !attempts.some((entry) => entry.id === provider.id)) attempts.push(provider);
  };
  if (repository) attempt(SEARCH_PROVIDERS.github);
  attempt(chosen);
  attempt(SEARCH_PROVIDERS.bing);
  attempt(SEARCH_PROVIDERS.wikipedia);

  const cacheKey = `${attempts.map((provider) => provider.id).join('+')}:${depth ? 'deep' : 'snippets'}:${configured.budget || 0}:${text.toLowerCase()}`;

  const cached = cache?.get(cacheKey);
  if (cached) return { ...cached, cached: true };

  let provider = chosen;
  let results = null;
  const failures = [];

  for (const candidate of attempts) {
    if (candidate.needsKey && !configured.key) {
      failures.push(`${candidate.label} needs a key`);
      continue;
    }
    if (candidate.id === 'searx' && !/^https?:\/\//i.test(String(configured.endpoint || ''))) {
      failures.push('SearXNG needs an instance address');
      continue;
    }

    try {
      const found = await candidate.search(text, {
        key: configured.key,
        endpoint: configured.endpoint,
        fetchFn,
        signal,
      });
      if (!found?.length) {
        failures.push(`${candidate.label} returned no results`);
        continue;
      }
      results = found;
      provider = candidate;
      break;
    } catch (error) {
      failures.push(String(error?.message || `${candidate.label} failed.`));
    }
  }

  if (!results?.length) {
    return {
      provider: chosen.id,
      results: [],
      chunks: [],
      pages: [],
      error: failures[0] || 'Search failed.',
    };
  }

  const payload = {
    provider: provider.id,
    results,
    chunks: [],
    pages: [],
    // Said out loud rather than hidden: the user should know which engine
    // answered and what went wrong with the first one.
    ...(failures.length ? { note: `${provider.label} answered after ${failures[0]}` } : {}),
  };

  if (depth && results.length) {
    const pages = await readPages(results.slice(0, MAX_PAGES), { fetchFn, signal });
    const budgetChars = Math.max(600, Math.min(8000, Number(configured.budget) || 1200)) * 4;
    payload.pages = pages.map((page) => ({ url: page.url, title: page.title, chars: page.text.length }));
    payload.chunks = rankChunks(pages, text, budgetChars);
  }

  cache?.set(cacheKey, payload);
  return payload;
}

/** Pages are read in parallel, and one slow site cannot hold the turn. */
async function readPages(results, { fetchFn, signal }) {
  const pages = [];

  await Promise.all(
    results.map(async (result) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
      const relay = () => controller.abort();
      signal?.addEventListener?.('abort', relay, { once: true });

      try {
        const response = await fetchFn(result.url, {
          signal: controller.signal,
          headers: { accept: 'text/html,application/xhtml+xml' },
        });
        if (!response.ok) return;

        const type = String(response.headers?.get?.('content-type') || '');
        if (type && !/text\/html|text\/plain|application\/xhtml/i.test(type)) return;

        const html = await response.text();
        // A page under the extraction floor is a menu, a paywall or a stub.
        if (html.length > 4000) {
          const text = readableText(html);
          if (text.length > 200) pages.push({ ...result, title: result.title || extractTitle(html), text });
        }
      } catch {
        // One page failing is a thinner answer, not a failed search.
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', relay);
      }
    }),
  );

  return pages;
}

/** What the model reads: snippets first, page text only when it was fetched. */
export function formatSearch(payload, { depth = false } = {}) {
  if (!payload?.results?.length) return 'No results came back for that query.';

  const lines = [`Web results from ${payload.provider}${payload.cached ? ' (cached, nothing new was fetched)' : ''}:`];
  if (payload.note) lines.push(payload.note);
  payload.results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`, `   ${result.url}`, `   ${result.snippet || '(no snippet)'}`);
  });

  if (payload.chunks?.length) {
    lines.push('', 'Read from those pages, most relevant first:');
    for (const chunk of payload.chunks) lines.push(`[${chunk.title}](${chunk.url})`, chunk.text, '');
  } else if (depth) {
    lines.push('', 'The pages could not be read; these snippets are all there is.');
  } else {
    lines.push('', 'Snippets only. Call web_search again with depth true to read the top pages.');
  }

  return lines.join('\n');
}

/** Citation chips: the pages the answer may be citing, in the order found. */
export function sourcesFrom(payload) {
  return (payload?.results || [])
    .slice(0, 6)
    .map((result) => ({ title: result.title, url: result.url }));
}
