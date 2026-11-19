/**
 * A very small syntax highlighter: enough colour to make a code block readable,
 * no grammar files and no dependency. The scanner walks raw characters and
 * escapes as it emits, so nothing in the code can become markup.
 */

const KEYWORDS = {
  js: 'async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while yield',
  py: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield',
  bash: 'case do done elif else esac fi for function if in local return then until while export',
  css: '',
  json: 'true false null',
  html: '',
};

/** Literals that are keywords in one language or another; coloured the same. */
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil']);

const ALIASES = {
  javascript: 'js',
  jsx: 'js',
  ts: 'js',
  tsx: 'js',
  typescript: 'js',
  node: 'js',
  python: 'py',
  py3: 'py',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  html: 'html',
  htm: 'html',
  xml: 'html',
  svg: 'html',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'css',
};

function escape(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function span(kind, text) {
  return `<span class="tok tok--${kind}">${escape(text)}</span>`;
}

/**
 * @param {string} code
 * @param {string} language fence label, as written
 * @returns {string} escaped HTML with token spans
 */
export function highlight(code, language) {
  const label = String(language || '').toLowerCase();
  const lang = ALIASES[label] || label;
  // css and html have no keyword list on purpose: '' is still a known language.
  if (!(lang in KEYWORDS)) return escape(code);
  return lang === 'html' ? scanHtml(code) : scan(code, lang);
}

function scan(code, lang) {
  const words = new Set(String(KEYWORDS[lang] || '').split(' ').filter(Boolean));
  const lineComment = lang === 'py' || lang === 'bash' ? '#' : '//';
  const blockComment = lang === 'py' || lang === 'bash' ? null : ['/*', '*/'];
  const text = String(code || '');
  let out = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const two = text.slice(i, i + 2);

    if (two === lineComment) {
      let end = text.indexOf('\n', i);
      if (end === -1) end = text.length;
      out += span('comment', text.slice(i, end));
      i = end;
      continue;
    }

    if (blockComment && two === blockComment[0]) {
      let end = text.indexOf(blockComment[1], i + 2);
      end = end === -1 ? text.length : end + blockComment[1].length;
      out += span('comment', text.slice(i, end));
      i = end;
      continue;
    }

    if (ch === '"' || ch === "'" || (ch === '`' && lang === 'js')) {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === ch) {
          j += 1;
          break;
        }
        if (text[j] === '\n' && ch !== '`') break;
        j += 1;
      }
      out += span('string', text.slice(i, j));
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch) && !/[A-Za-z_$]/.test(text[i - 1] || '')) {
      let j = i;
      while (j < text.length && /[0-9a-fA-FxX._]/.test(text[j])) j += 1;
      out += span('number', text.slice(i, j));
      i = j;
      continue;
    }

    if (/[A-Za-z_$#@-]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_$-]/.test(text[j])) j += 1;
      const word = text.slice(i, j);

      if (LITERALS.has(word)) out += span('literal', word);
      else if (words.has(word)) out += span('keyword', word);
      else if (/^\s*\(/.test(text.slice(j, j + 4))) out += span('fn', word);
      else out += escape(word);

      i = j;
      continue;
    }

    out += escape(ch);
    i += 1;
  }

  return out;
}

/** Tags and attributes; text between them is escaped like everything else. */
function scanHtml(code) {
  const text = String(code || '');
  let out = '';
  let i = 0;

  while (i < text.length) {
    const start = text.indexOf('<', i);
    if (start === -1) {
      out += escape(text.slice(i));
      break;
    }
    out += escape(text.slice(i, start));

    const close = text.indexOf('>', start);
    if (close === -1) {
      out += escape(text.slice(start));
      break;
    }

    const tag = text.slice(start, close + 1);
    out += `<span class="tok tok--tag">${escape(tag).replace(/("[^"]*"|'[^']*')/g, (quoted) => `<span class="tok tok--string">${quoted}</span>`)}</span>`;
    i = close + 1;
  }

  return out;
}
