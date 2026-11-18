/**
 * Minimal Markdown renderer for assistant output.
 *
 * Everything is HTML-escaped before any formatting rule runs, so model output
 * can never inject markup. Links are limited to http(s).
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

export function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let list = null;
  let i = 0;

  const closeParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inline(paragraph.join('\n'))}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (!list) return;
    const items = list.items.map((item) => `<li>${inline(item)}</li>`).join('');
    out.push(`<${list.type}>${items}</${list.type}>`);
    list = null;
  };

  const closeBlocks = () => {
    closeParagraph();
    closeList();
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code — an unterminated fence while streaming stays a code block.
    const fence = line.match(/^\s*(```|~~~)\s*([\w+#.-]*)\s*$/);
    if (fence) {
      closeBlocks();
      const marker = fence[1];
      const language = fence[2];
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(codeBlock(body.join('\n'), language));
      continue;
    }

    if (!line.trim()) {
      closeBlocks();
      i += 1;
      continue;
    }

    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      closeBlocks();
      out.push('<hr>');
      i += 1;
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      closeBlocks();
      // Never out-shout the surrounding UI: # becomes h3, ###### becomes h6.
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      closeBlocks();
      const quoted = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${inline(quoted.join('\n'))}</blockquote>`);
      continue;
    }

    const bullet = line.match(/^\s{0,2}[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s{0,2}(\d{1,3})[.)]\s+(.*)$/);
    if (bullet || ordered) {
      closeParagraph();
      const type = bullet ? 'ul' : 'ol';
      if (!list || list.type !== type) {
        closeList();
        list = { type, items: [] };
      }
      list.items.push(bullet ? bullet[1] : ordered[2]);
      i += 1;
      continue;
    }

    closeList();
    paragraph.push(line.trim());
    i += 1;
  }

  closeBlocks();
  return out.join('');
}

function codeBlock(code, language) {
  const label = escapeHtml((language || 'code').toLowerCase());
  return (
    '<div class="code">' +
    `<div class="code__bar"><span class="code__lang">${label}</span>` +
    '<button class="code__copy" type="button" data-copy>Copy</button></div>' +
    `<pre><code>${escapeHtml(code)}</code></pre>` +
    '</div>'
  );
}

function inline(raw) {
  /** @type {string[]} */
  const stash = [];
  const hold = (html) => `\u0000${stash.push(html) - 1}\u0000`;

  // Escaped text from here on: no raw model HTML can survive.
  let text = escapeHtml(raw);

  // Code spans first, so their contents are never reformatted.
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => hold(`<code>${code}</code>`));

  // Explicit links, http(s) only.
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    const url = safeUrl(href);
    if (!url) return match;
    return hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  });

  // Bare URLs.
  text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)\]]+[^\s<).,;:!?'"])/g, (_m, lead, url) => {
    return `${lead}${hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)}`;
  });

  text = text
    .replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^\n_]+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[\s([{])[*_]([^\n*_]+?)[*_](?=[\s)\]}`.,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^\n]+?)~~/g, '<del>$1</del>')
    .replace(/\n/g, '<br>');

  return text.replace(/\u0000(\d+)\u0000/g, (_m, index) => stash[Number(index)] ?? '');
}

/** `href` is already HTML-escaped when it reaches here. */
function safeUrl(href) {
  const trimmed = href.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : '';
}
