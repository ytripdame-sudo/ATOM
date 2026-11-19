/**
 * Fetching a page and pasting it into the prompt is how a free tier dies. A page
 * becomes chunks, the chunks are ranked against the query, and only the best
 * ones fit in a budget the user controls.
 */

const STOP = new Set(
  ('a an and are as at be by for from has have how in is it its of on or that the their there these this to was ' +
    'were what when where which who why will with you your')
    .split(' ')
    .filter(Boolean),
);

/** Query terms, lowercased, minus the words every page contains. */
export function terms(query) {
  return [...new Set(String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9'’-]{1,}/g) || [])].filter(
    (term) => term.length > 2 && !STOP.has(term),
  );
}

/**
 * Split on paragraph boundaries, then on sentences, so a chunk is a thought and
 * not half of one. `size` is characters: about four per token.
 */
export function chunkText(text, size = 900) {
  const clean = String(text || '').trim();
  if (!clean) return [];

  const paragraphs = clean.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  const push = () => {
    const value = current.trim();
    if (value.length > 80) chunks.push(value);
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > size) {
      push();
      const sentences = paragraph.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [paragraph];
      for (const sentence of sentences) {
        if ((current + sentence).length > size) push();
        current += sentence;
      }
      push();
      continue;
    }
    if ((current + '\n\n' + paragraph).length > size) push();
    current += (current ? '\n\n' : '') + paragraph;
  }
  push();

  return chunks;
}

/**
 * Term overlap, with a bonus for a chunk that contains most of the query. No
 * IDF and no corpus statistics: the candidate set is one page, and a cheap
 * score that runs in a millisecond beats a correct one that costs a dependency.
 */
export function scoreChunk(chunk, queryTerms) {
  if (!queryTerms.length) return 0;
  const lower = String(chunk).toLowerCase();
  let hits = 0;
  let score = 0;

  for (const term of queryTerms) {
    const at = lower.indexOf(term);
    if (at === -1) continue;
    hits += 1;
    score += 1 + Math.min(2, (lower.split(term).length - 1) * 0.25);
  }

  // A chunk that mentions every term is almost always the right one.
  if (hits === queryTerms.length) score += queryTerms.length;
  return score;
}

/**
 * @param {Array<{url: string, title: string, text: string}>} pages
 * @param {string} query
 * @param {number} budgetChars how much text the model may be given
 * @returns {Array<{url: string, title: string, text: string, score: number}>}
 */
export function rankChunks(pages, query, budgetChars) {
  const queryTerms = terms(query);
  const scored = [];

  for (const page of pages || []) {
    for (const text of chunkText(page.text)) {
      scored.push({
        url: page.url,
        title: page.title,
        text,
        score: scoreChunk(text, queryTerms),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || b.text.length - a.text.length);

  const picked = [];
  let used = 0;
  for (const chunk of scored) {
    if (chunk.score <= 0 && picked.length) continue;
    if (used + chunk.text.length > budgetChars) continue;
    picked.push(chunk);
    used += chunk.text.length;
    if (used >= budgetChars * 0.92) break;
  }

  return picked;
}
