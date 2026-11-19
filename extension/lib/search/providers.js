/**
 * Search backends, one small object each. A provider takes a query and returns
 * titles, addresses and snippets — never a whole page, never a model call.
 *
 * The default is DuckDuckGo's HTML results page, parsed here: no API key, no
 * account, and no LLM quota spent on finding things. Brave, SearXNG and
 * Wikipedia stay available behind the same interface, and GitHub gets its own
 * repository API because guessing a repository address is exactly the bug this
 * module exists to prevent.
 */
import { decodeEntities } from './extract.js';
import { searchReference } from '../web.js';

const BRAVE = 'https://api.search.brave.com/res/v1/web/search';
const BING = 'https://www.bing.com/search';
const DDG = 'https://html.duckduckgo.com/html/';
const SERPER = 'https://google.serper.dev/search';
const GITHUB = 'https://api.github.com/search/repositories';

function tidy(text) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decoded(html) {
  return tidy(decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')));
}

function httpUrl(value) {
  const url = String(value || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

/** DuckDuckGo wraps results in a redirect: /l/?uddg=<encoded address>. */
function unwrap(href) {
  const raw = String(href || '').replace(/&amp;/g, '&');
  try {
    const url = new URL(raw, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    const final = target ? decodeURIComponent(target) : url.toString();
    return /^https?:\/\//i.test(final) && !/duckduckgo\.com/i.test(new URL(final).hostname) ? final : '';
  } catch {
    return '';
  }
}

/**
 * The HTML results page, parsed without a DOM. Attribute order and whitespace
 * change; class names have been stable for years, so they are what is matched.
 * A page with no `result__a` at all is a CAPTCHA or a markup change, and the
 * caller is told which.
 */
export function parseDuckDuckGo(html) {
  const source = String(html || '');
  const snippets = [...source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .filter((match) => /result__snippet/.test(match[1]))
    .map((match) => decoded(match[2]));

  const results = [];
  for (const match of source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (!/result__a/.test(match[1])) continue;
    const href = match[1].match(/href=["']([^"']+)["']/i)?.[1] || '';
    const url = unwrap(href);
    const title = decoded(match[2]);
    if (!url || !title) continue;
    results.push({ title, url, snippet: snippets[results.length] || '' });
  }

  return results;
}

/** Bing wraps result links in a base64url `u=a1…` parameter. */
function unwrapBing(href) {
  const raw = String(href || '').replace(/&amp;/g, '&');
  try {
    const url = new URL(raw, 'https://www.bing.com');
    const encoded = url.searchParams.get('u') || '';
    if (!encoded) {
      return /^https?:\/\//i.test(raw) && !/bing\.com/i.test(new URL(raw).hostname) ? raw : '';
    }
    if (!encoded.startsWith('a1')) return '';
    let base64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    base64 += '='.repeat((4 - (base64.length % 4)) % 4);
    return httpUrl(atob(base64));
  } catch {
    return '';
  }
}

/** Bing's organic results, parsed without a DOM. */
export function parseBing(html) {
  const source = String(html || '');
  const results = [];
  for (const block of source.match(/<li class="b_algo"[\s\S]*?<\/li>/gi) || []) {
    const link = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    const title = decoded(link?.[2]);
    const url = unwrapBing(link?.[1]);
    const snippet = decoded(block.match(/<p[^>]*class=["'][^"']*b_lineclamp[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1]);
    if (url && title) results.push({ title, url, snippet });
  }
  return results;
}

/** Whether a question is really a GitHub repository lookup. */
export function wantsGithub(query) {
  const text = String(query || '');
  return /\bgithub\b/i.test(text) || /(^|\s)[\w.-]+\/[\w.-]+(\s|$)/.test(text);
}

export const SEARCH_PROVIDERS = {
  duckduckgo: {
    id: 'duckduckgo',
    label: 'DuckDuckGo (no key)',
    keyHint: '',
    needsKey: false,
    async search(query, { fetchFn = fetch, signal } = {}) {
      const response = await fetchFn(`${DDG}?q=${encodeURIComponent(query)}`, {
        signal,
        headers: { accept: 'text/html', 'accept-language': 'en' },
      });
      if (response.status === 429) throw new Error('DuckDuckGo is rate limiting searches.');
      if (!response.ok) throw new Error(`DuckDuckGo answered ${response.status}.`);

      const html = await response.text();
      if (response.status === 202 || (/anomaly|challenge-form|captcha/i.test(html) && !/result__a/.test(html))) {
        throw new Error('DuckDuckGo is blocking automated searches. Choose another provider in Settings → Web search.');
      }

      const results = parseDuckDuckGo(html);
      if (!results.length) throw new Error('DuckDuckGo returned no usable results — its markup may have changed.');
      return results.slice(0, 10);
    },
  },

  bing: {
    id: 'bing',
    label: 'Bing (no key)',
    keyHint: '',
    needsKey: false,
    async search(query, { fetchFn = fetch, signal, limit = 8 } = {}) {
      const response = await fetchFn(`${BING}?q=${encodeURIComponent(query)}&count=10`, {
        signal,
        headers: { accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
      });
      if (response.status === 429) throw new Error('Bing is rate limiting searches.');
      if (!response.ok) throw new Error(`Bing answered ${response.status}.`);

      const html = await response.text();
      if (/captcha|verify you are human|challenge-form/i.test(html) && !/b_algo/i.test(html)) {
        throw new Error('Bing is blocking automated searches.');
      }

      const results = parseBing(html);
      if (!results.length) throw new Error('Bing returned no usable results.');
      return results.slice(0, limit);
    },
  },

  github: {
    id: 'github',
    label: 'GitHub repositories (no key)',
    keyHint: '',
    needsKey: false,
    async search(query, { fetchFn = fetch, signal, limit = 8 } = {}) {
      // "search github for a react table" is not a repository name; the words
      // that describe the request are not part of it.
      const term = String(query || '')
        .trim()
        .replace(/^(?:please\s+)?(?:search|find|look\s*up)\s+(?:on\s+|in\s+)?github(?:\s+for)?\s+/i, '')
        .replace(/\bgithub\b/gi, ' ')
        .replace(/\brepos?(?:itory|itories)?\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const url = `${GITHUB}?q=${encodeURIComponent(term || String(query))}&sort=stars&order=desc&per_page=${Math.min(10, Math.max(1, limit))}`;
      const response = await fetchFn(url, {
        signal,
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      });
      if (response.status === 403 || response.status === 429) throw new Error('GitHub is rate limiting repository search.');
      if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);

      const data = await response.json();
      const results = (data?.items ?? [])
        .map((repo) => ({
          title: String(repo?.full_name || ''),
          url: httpUrl(repo?.html_url),
          snippet: [tidy(repo?.description) || 'No description', repo?.stargazers_count ? `★ ${repo.stargazers_count}` : '']
            .filter(Boolean)
            .join(' · '),
        }))
        .filter((repo) => repo.title && repo.url);

      if (!results.length) throw new Error('GitHub found no repository with that name.');
      return results;
    },
  },

  brave: {
    id: 'brave',
    label: 'Brave Search',
    keyHint: 'brave.com/search/api',
    needsKey: true,
    async search(query, { key, endpoint = '', fetchFn = fetch, signal, limit = 8 } = {}) {
      if (!key) throw new Error('Brave needs an API key from Settings → Search.');
      const url = `${endpoint || BRAVE}?q=${encodeURIComponent(query)}&count=${Math.min(10, Math.max(1, limit))}&text_decorations=false`;

      const response = await fetchFn(url, {
        signal,
        headers: { accept: 'application/json', 'x-subscription-token': key },
      });
      if (response.status === 401 || response.status === 403) throw new Error('Brave rejected the search key.');
      if (response.status === 429) throw new Error('Brave is rate limiting search right now.');
      if (!response.ok) throw new Error(`Brave answered ${response.status}.`);

      const data = await response.json();
      return (data?.web?.results ?? [])
        .map((hit) => ({
          title: tidy(hit?.title) || 'Result',
          url: httpUrl(hit?.url),
          snippet: tidy(hit?.description),
        }))
        .filter((hit) => hit.url)
        .slice(0, limit);
    },
  },

  serper: {
    id: 'serper',
    label: 'Google (Serper)',
    keyHint: 'serper.dev',
    needsKey: true,
    async search(query, { key, fetchFn = fetch, signal, limit = 8 } = {}) {
      if (!key) throw new Error('Google via Serper needs an API key from Settings → Search.');

      const response = await fetchFn(SERPER, {
        method: 'POST',
        signal,
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ q: String(query), num: Math.min(10, Math.max(1, limit)) }),
      });
      if (response.status === 401 || response.status === 403) throw new Error('Serper rejected the search key.');
      if (response.status === 429) throw new Error('Serper is rate limiting search right now.');
      if (!response.ok) throw new Error(`Serper answered ${response.status}.`);

      const data = await response.json();
      return (data?.organic ?? [])
        .map((hit) => ({
          title: tidy(hit?.title) || 'Result',
          url: httpUrl(hit?.link),
          snippet: tidy(hit?.snippet),
        }))
        .filter((hit) => hit.url)
        .slice(0, limit);
    },
  },

  searx: {
    id: 'searx',
    label: 'SearXNG',
    keyHint: 'your own instance',
    needsKey: false,
    async search(query, { key = '', endpoint = '', fetchFn = fetch, signal, limit = 8 } = {}) {
      const base = String(endpoint || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(base)) throw new Error('SearXNG needs the address of your instance in Settings.');

      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`;
      const headers = { accept: 'application/json' };
      if (key) headers.authorization = `Bearer ${key}`;

      const response = await fetchFn(url, { signal, headers });
      if (response.status === 403) throw new Error('SearXNG refused the request — its JSON API may be off.');
      if (!response.ok) throw new Error(`SearXNG answered ${response.status}.`);

      const data = await response.json();
      return (data?.results ?? [])
        .map((hit) => ({
          title: tidy(hit?.title) || 'Result',
          url: httpUrl(hit?.url),
          snippet: tidy(hit?.content),
        }))
        .filter((hit) => hit.url)
        .slice(0, limit);
    },
  },

  wikipedia: {
    id: 'wikipedia',
    label: 'Wikipedia (no key)',
    keyHint: '',
    needsKey: false,
    async search(query, { fetchFn = fetch, signal, limit = 6 } = {}) {
      const { results } = await searchReference(query, { fetchFn, signal, limit });
      return results.map((hit) => ({ title: hit.title, url: hit.url, snippet: hit.snippet }));
    },
  },
};

export const SEARCH_PROVIDER_IDS = Object.keys(SEARCH_PROVIDERS);

export function searchProvider(id) {
  return SEARCH_PROVIDERS[id] || SEARCH_PROVIDERS.duckduckgo;
}

/** Whether this provider can run with what the user has saved. */
export function searchReady(settings) {
  const provider = searchProvider(settings?.search?.provider);
  if (!provider.needsKey) {
    return provider.id !== 'searx' || /^https?:\/\//i.test(String(settings?.search?.endpoint || ''));
  }
  return Boolean(settings?.search?.key);
}
