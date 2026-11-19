/**
 * Readable text from a fetched page, without a parser library and without a
 * DOM: the worker strips what nobody reads (scripts, styles, navigation, share
 * bars), keeps the article when there is one, and turns block boundaries into
 * newlines so the chunker has something to work with.
 *
 * This is deliberately not Readability: it is a few hundred bytes of rules, and
 * the ranking step downstream is what decides whether a page was worth reading.
 */

const DROP = /<(script|style|noscript|svg|template|iframe|canvas|form|nav|header|footer|aside|dialog)\b[\s\S]*?<\/\1>/gi;

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

export function decodeEntities(text) {
  return decode(text);
}

function decode(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const value = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** The page's own title, if it has one. */
export function extractTitle(html) {
  const match = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decode(match[1]).replace(/\s+/g, ' ').trim().slice(0, 160) : '';
}

/**
 * @param {string} html
 * @returns {string} plain text, paragraphs separated by blank lines
 */
export function readableText(html) {
  let source = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(DROP, ' ');

  // Prefer the article itself: a page is mostly navigation and comments around
  // one piece of writing.
  const article = source.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) || source.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (article) source = article[1];

  source = source
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol)>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');

  return decode(source)
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
