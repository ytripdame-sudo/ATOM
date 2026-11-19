/**
 * Masking of credential-shaped values and email addresses before page text or
 * capture output leaves for the model.
 *
 * The rules are deliberately narrow: only shapes that are almost certainly
 * secrets are rewritten, so ordinary prose, ids and numbers survive intact and
 * the model still has something to reason about. A masked value becomes
 * `[redacted]` beside its label, and the tool result says how many were masked —
 * a model that knows it is reading a masked view does not try to guess the value
 * back.
 */

/** A whole PEM block first, before anything else chews on its body. */
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

const COOKIE_NAME = String.raw`[\w.-]*(?:token|session|sess(?:ion)?id|csrf|xsrf|jwt)[\w.-]*|[\w.-]*sid[\w.-]*|auth|authorization|__Secure-[\w.-]+|__Host-[\w.-]+|wordpress_logged_in_[\w.-]+|remember(?:[_-]?me|token)?`;

/**
 * Ordered: header-shaped values first, then bare tokens, then labels, then
 * well-known key shapes, then emails. Later rules must not re-match the
 * `[redacted]` an earlier one wrote.
 */
const RULES = [
  { pattern: PRIVATE_KEY, mask: () => '[redacted private key]' },
  {
    pattern: /\b((?:set-)?cookie)\s*:\s*[^\r\n]+/gi,
    mask: (_match, name) => `${name}: [redacted cookies]`,
  },
  {
    pattern: /(^|["'\s])([A-Za-z0-9_.-]+)=([^;\s"'&]+)\s*;\s*[A-Za-z0-9_.-]+=[^;\s"'&]+/g,
    mask: (match) => match.replace(/=[^;]+/g, '= [redacted]'),
  },
  {
    pattern: new RegExp(`(^|[\\s,{"'])\\s*("|')?(${COOKIE_NAME})\\2\\s*=\\s*("|')?(?!\\[redacted\\])([^;"'\\s,}]+)`, 'gi'),
    mask: (_match, lead, quote, name) => `${lead}${quote || ''}${name}${quote || ''}= [redacted]`,
  },
  {
    pattern: new RegExp(`(["'])((?:${COOKIE_NAME})|cookie)\\1\\s*:\\s*(["'])(.*?)\\3`, 'gi'),
    mask: (_match, quote, name, valueQuote) => `${quote}${name}${quote}: ${valueQuote}[redacted]${valueQuote}`,
  },
  // A named auth header in text, a header dump or a log line — including the
  // `Bearer`/`Basic` scheme, so the value goes with it. The value stops at `&`
  // so a query string keeps its other parameters.
  {
    pattern: /\b(authorization|proxy-authorization|x-api-key)\s*[:=]\s*(?:Bearer|Basic|Token)?\s*[^\s,;"'&]+/gi,
    mask: (_match, name) => `${name}: [redacted]`,
  },
  // A scheme plus credential anywhere else: "Bearer eyJ…" in a log line.
  {
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
    mask: (_match, scheme) => `${scheme} [redacted]`,
  },
  // JSON Web Tokens: three base64url segments, the first always starts with eyJ.
  { pattern: /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{4,}/g, mask: () => '[redacted token]' },
  // A sensitive query parameter: the name stays, the value goes.
  {
    pattern:
      /([?&;](?:access[_-]?token|id[_-]?token|refresh[_-]?token|api[_-]?key|apikey|token|auth|password|passwd|secret|sig|signature|session[_-]?id|sessionid|session)=)[^&#\s"']+/gi,
    mask: (_match, prefix) => `${prefix}[redacted]`,
  },
  // `api_key=…`, `password: …` and friends in plain text.
  {
    pattern:
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|session[_-]?token|session[_-]?id|sessionid|jwt|csrf[_-]?token|xsrf[_-]?token|remember[_-]?token|client[_-]?secret|secret|password|passwd|pwd|token)\b\s*[:=]\s*["']?(?!\[redacted\])[^\s"'&,;]{4,}/gi,
    mask: (_match, name) => `${name}: [redacted]`,
  },
  // Key shapes that carry their own label.
  {
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g,
    mask: () => '[redacted key]',
  },
  // Email addresses: personal data the model never needs in full.
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, mask: () => '[redacted email]' },
];

/**
 * Mask every credential-shaped value and email address in `text`.
 * @returns {{ text: string, count: number }} the masked text and how many
 *   values were replaced (counted per rule hit, so one token is one value).
 */
export function maskSecrets(text) {
  let masked = String(text ?? '');
  let count = 0;

  for (const rule of RULES) {
    masked = masked.replace(rule.pattern, (...args) => {
      count += 1;
      return rule.mask(...args);
    });
  }

  return { text: masked, count };
}

/** The line a tool result carries when anything was masked. */
export function redactionNote(count, subject) {
  const values = count === 1 ? '1 value that looked like a credential or email address was' : `${count} values that looked like credentials or email addresses were`;
  return `Redacted: ${values} masked as [redacted] in this view of the ${subject}. Treat it as a masked view, not the exact text.`;
}
