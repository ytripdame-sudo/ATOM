/**
 * Where a navigation may go, and what counts as a bad landing.
 *
 * The rule is provenance, not plausibility: a URL is openable only if the user
 * typed it, a search result produced it, or a page ATOM already opened linked
 * to it. A model that guesses "githubrepo.com" gets a refusal that tells it to
 * search, which is the only thing that stops the guess from happening again.
 *
 * Pure and browser-free, so the policy is testable.
 */

const URLISH = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{2,5})?(?:\/[^\s<>"'`]*)?)/gi;

// A few very common destinations are worth resolving without a search. The
// rest go through the generic resolver in background.js; this is an
// optimization, not the boundary of what can be opened.
const SITE_URLS = [
  ['youtube', ['https://www.youtube.com', 'https://youtube.com']],
  ['yt', ['https://www.youtube.com', 'https://youtube.com']],
  ['google', ['https://www.google.com', 'https://google.com']],
  ['github', ['https://github.com']],
  ['discord', ['https://discord.com', 'https://discord.gg']],
  ['instagram', ['https://www.instagram.com']],
];

/** An Instagram profile named as @handle, not a search for the handle. */
export function handleSiteUrl(text) {
  const match = String(text || '').match(
    /\binstagram\b\s*(?:profile|account|page)?\s*[:/]?\s*@([a-z0-9._-]{2,30})/i,
  );
  const handle = match?.[1]?.replace(/[._-]+$/, '');
  return handle ? `https://www.instagram.com/${handle}` : '';
}

/** Canonical pages for sites named in the user's own words. */
export function namedSiteUrls(text) {
  const source = String(text || '');
  const lower = source.toLowerCase();
  const found = new Set();

  for (const [name, urls] of SITE_URLS) {
    if (!new RegExp(`\\b${name.replace(/ /g, '\\s+')}\\b`, 'i').test(lower)) continue;
    for (const url of urls) found.add(url);
  }
  const profile = handleSiteUrl(source);
  if (profile) found.add(profile);

  if (/\b(?:youtube|yt)\b/i.test(lower)) {
    const play = source.match(/\bplay\s+(.+?)(?:\s+(?:on|from)\s+(?:youtube|yt))?\s*[.!?]*$/i);
    const query = play?.[1]?.replace(/\s+(?:on|from)\s+(?:youtube|yt)$/i, '').trim();
    if (query) found.add(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`);
  }

  return [...found];
}

/** The homepage for a site name only when the whole name is a known site. */
export function namedSiteHome(name) {
  const key = String(name || '').trim().toLowerCase();
  return SITE_URLS.find(([site]) => site === key)?.[1]?.[0] || '';
}

/** The one address a named-site request should open: results for “play X”, otherwise the homepage. */
export function namedSiteTarget(text) {
  const profile = handleSiteUrl(text);
  if (profile) return profile;
  const urls = namedSiteUrls(text);
  return urls.find((url) => url.includes('/results?search_query=')) || urls[0] || '';
}

/** The site name after an explicit go/open phrase; empty for a URL or a new tab. */
export function siteNameInRequest(text) {
  const source = String(text || '').trim();
  if (urlsInText(source).length) return '';
  const match = source.match(
    /\b(?:go\s*to|goto|open|head\s+over\s+to|take\s+me\s+to|navigate\s+to)\s+(?:the\s+)?(.+?)(?:\s+(?:website|site|page|homepage))?\s*[.!?]*$/i,
  );
  let name = String(match?.[1] || '')
    .replace(/^['"]|['"]$/g, '')
    .replace(/\b(?:please|for me)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || /\bnew\s+(?:tab|window)\b/i.test(name)) return '';
  return name;
}

/** Addresses written in the user's own message. Bare domains become https. */
export function urlsInText(text) {
  const found = new Set();
  for (const match of String(text || '').matchAll(URLISH)) {
    const candidate = match[1].replace(/[).,;:!?]+$/, '');
    // A bare "e.g" or "i.e" is not a site; a real host has a dot and a name.
    if (/^[a-z]{1,2}\.[a-z]{1,2}$/i.test(candidate)) continue;
    const url = normalizeUrl(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    if (url) found.add(url);
  }
  return [...found];
}

/** One form for comparison: http(s) only, no hash, no trailing slash. */
export function normalizeUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!/^https?:$/.test(url.protocol)) return '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

// http and https are the same destination for this purpose; the address itself
// still has to match exactly.
const bare = (url) => url.replace(/^https?:\/\//, '');

export function isAllowedUrl(value, allowed) {
  const url = normalizeUrl(value);
  if (!url) return false;
  for (const entry of allowed || []) {
    if (bare(normalizeUrl(entry)) === bare(url)) return true;
  }
  return false;
}

const PARKED =
  /(domain(?: name)? (?:is )?for sale|\bis for sale\b|buy this domain|this domain|parked (?:domain|free)|sedoparking|afternic|hugedomains|dan\.com|domain parking)/i;

const ERROR_PAGE =
  /(^|\b)(404|410|403|500|502|503|504|not found|page not found|cannot be found|can['’]?t be reached|couldn['’]?t find|access denied|attention required|just a moment|checking your browser|verify you are human|no such app|site can['’]?t be reached|temporarily unavailable|service unavailable|bad gateway)/i;

const ERROR_HOSTS = /(^|\.)((sedoparking|parkingcrew|above|afternic|hugedomains|dan|bodis|parklogic)\.(com|net|org))$/i;

/**
 * @param {{title?: string, url?: string}} page the tab after it loaded
 * @returns {string} a short reason, or '' when the page looks like a page
 */
export function navigateProblem({ title = '', url = '' } = {}) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* not an address */
  }

  if (host && ERROR_HOSTS.test(host)) return 'that address is a parking page';
  const heading = String(title || '').trim();
  if (!heading) return 'the page has no title at all';
  if (PARKED.test(heading)) return 'the page is a domain-for-sale listing';
  if (ERROR_PAGE.test(heading)) return `the page says “${heading.slice(0, 80)}”`;
  return '';
}
