/**
 * Speaking a reply while it is still arriving: split what has streamed so far
 * into whole sentences, keep the unfinished tail, and hand the sentences to the
 * speaker. Pure and tiny, because the streaming path is hot.
 */

/** A sentence ends at terminal punctuation, a quote after it, or a blank line. */
const SENTENCE_END = /[.!?…]+["'”’)\]]*\s|\n\s*\n|[.!?…]+["'”’)\]]*$/;

/** A burst of many sentences still plays in order; this only bounds one tick. */
const MAX_PER_TAKE = 8;

/**
 * @param {string} buffer text streamed but not yet spoken
 * @returns {{sentences: string[], rest: string}}
 */
export function takeSentences(buffer) {
  const text = String(buffer || '');
  const sentences = [];
  let rest = text;

  for (;;) {
    if (sentences.length >= MAX_PER_TAKE) break;
    const match = rest.match(SENTENCE_END);
    if (!match) break;

    const end = match.index + match[0].length;
    const piece = speakable(rest.slice(0, end));
    if (piece) sentences.push(piece);
    rest = rest.slice(end);
  }

  return { sentences, rest };
}

/**
 * Markdown read aloud is noise: fences, table pipes and emphasis marks all turn
 * into pauses and stutters, and a URL is unlistenable. Code blocks are dropped
 * entirely — nobody wants a function signature in their ear.
 */
export function speakable(source) {
  return String(source || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`{1,3}/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, ' a link ')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_~|>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
