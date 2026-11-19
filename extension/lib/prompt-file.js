/**
 * Reading a prompt out of a file the user chose.
 *
 * Plain text and Markdown are themselves. JSON may be a bare string, an object
 * with a prompt-shaped field, or a pile of strings — all three are common for
 * exported assistant setups. HTML is reduced to its text. PDF is read from the
 * text layer only: content streams are inflated when they are Flate-encoded and
 * the text operators are pulled out, which covers ordinary documents and cannot
 * cover a scan or a font with a private encoding. When that fails it says so
 * rather than handing back noise.
 */

const EXTENSIONS = new Set(['txt', 'text', 'md', 'markdown', 'json', 'html', 'htm', 'pdf']);

/** Fields that are meant to be the prompt, most specific first. */
const PROMPT_FIELDS = ['instructions', 'system', 'systemPrompt', 'system_prompt', 'prompt', 'personality', 'content'];

/** PDF literal-string escapes, built without backslash literals. */
const ESCAPES = Object.fromEntries(
  [
    ['n', 10],
    ['r', 13],
    ['t', 9],
    ['b', 8],
    ['f', 12],
  ].map(([key, code]) => [key, String.fromCharCode(code)]),
);

export async function promptFromFile(name, content) {
  const extension = String(name || '')
    .split('.')
    .pop()
    .toLowerCase();

  if (!EXTENSIONS.has(extension)) {
    throw new Error(`ATOM can import .txt, .md, .json, .html or .pdf — not .${extension || 'unknown'}.`);
  }

  if (extension === 'pdf') return fromPdf(content);

  const text = decodeText(content);

  if (extension === 'json') return fromJson(text);
  if (extension === 'html' || extension === 'htm') return fromHtml(text);
  return text.trim();
}

function decodeText(content) {
  if (typeof content === 'string') return content;
  return new TextDecoder().decode(content instanceof ArrayBuffer ? new Uint8Array(content) : content);
}

/* ------------------------------------------------------------------- json */

function fromJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That .json file is not valid JSON, so there is no prompt to read from it.');
  }

  if (typeof parsed === 'string') return parsed.trim();

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const field of PROMPT_FIELDS) {
      if (typeof parsed[field] === 'string' && parsed[field].trim()) return parsed[field].trim();
    }
  }

  const strings = [];
  collectStrings(parsed, strings, 0);
  const joined = strings.join('\n').trim();
  if (!joined) throw new Error('That .json file has no text in it to use as a prompt.');
  return joined;
}

function collectStrings(value, into, depth) {
  if (depth > 6 || into.length >= 500) return;
  if (typeof value === 'string') {
    if (value.trim()) into.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, into, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectStrings(entry, into, depth + 1);
  }
}

/* ------------------------------------------------------------------- html */

function fromHtml(text) {
  const withoutNoise = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const stripped = withoutNoise
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const decoded = stripped
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  const cleaned = decoded
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!cleaned) throw new Error('That .html file has no readable text in it.');
  return cleaned;
}

/* -------------------------------------------------------------------- pdf */

async function fromPdf(content) {
  const bytes =
    content instanceof ArrayBuffer
      ? new Uint8Array(content)
      : typeof content === 'string'
        ? latin1Bytes(content)
        : new Uint8Array(content);

  const source = latin1(bytes);
  if (source.slice(0, 5) !== '%PDF-') throw new Error('That file does not start like a PDF.');

  const pieces = [];
  let index = 0;

  while ((index = source.indexOf('stream', index)) !== -1) {
    const afterKeyword = index + 6;
    const start =
      source[afterKeyword] === '\r' && source[afterKeyword + 1] === '\n'
        ? afterKeyword + 2
        : source[afterKeyword] === '\n'
          ? afterKeyword + 1
          : afterKeyword;
    const end = source.indexOf('endstream', start);
    if (end === -1) break;

    // A stream may be followed by an end-of-line before `endstream`, which the
    // inflater counts as trailing junk: try the body as-is, then trimmed.
    let stop = end;
    while (stop > start && [10, 13, 32, 9].includes(bytes[stop - 1])) stop -= 1;

    const body = bytes.subarray(start, end);
    let data = body;

    // FlateDecode streams start with a zlib header; anything else is left alone.
    if (body[0] === 0x78) {
      data = null;
      for (const candidate of [bytes.subarray(start, end), bytes.subarray(start, stop)]) {
        try {
          data = await inflate(candidate);
          break;
        } catch {
          /* try the next cut */
        }
      }
    }

    if (data) pieces.push(extractText(latin1(data)));
    index = end + 9;
  }

  const joined = pieces
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!/\p{L}{3}/u.test(joined)) {
    throw new Error(
      'No readable text layer in that PDF: it is probably a scan, or it uses a font encoding this reader cannot follow. Export the prompt as .txt and import that.',
    );
  }

  return joined;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function latin1(bytes) {
  let out = '';
  const step = 8192;
  for (let offset = 0; offset < bytes.length; offset += step) {
    out += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return out;
}

function latin1Bytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

/** Text-showing operators only: Tj, TJ, ' and ", with line breaks on Td/TD/T*. */
function extractText(content) {
  const tokens = content.match(/\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|Tj|TJ|Td|TD|T\*|ET|Tf|'|"/g) || [];
  let out = '';
  let pending = '';

  const flush = (line) => {
    out += pending;
    pending = '';
    if (line) out += '\n';
  };

  for (const token of tokens) {
    if (token.startsWith('(')) {
      pending += decodeLiteral(token);
    } else if (token.startsWith('<')) {
      pending += decodeHex(token);
    } else if (token === 'Tj' || token === 'TJ' || token === "'" || token === '"') {
      flush(false);
    } else if (token === 'Td' || token === 'TD' || token === 'T*' || token === 'ET') {
      flush(true);
    }
  }

  flush(false);
  return out;
}

function decodeLiteral(token) {
  const body = token.slice(1, -1);
  let out = '';

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character.charCodeAt(0) !== 92) {
      out += character;
      continue;
    }

    const next = body[index + 1];
    if (next >= '0' && next <= '7') {
      let octal = next;
      let step = index + 2;
      while (octal.length < 3 && body[step] >= '0' && body[step] <= '7') {
        octal += body[step];
        step += 1;
      }
      out += String.fromCharCode(parseInt(octal, 8));
      index = step - 1;
      continue;
    }

    out += ESCAPES[next] || next;
    index += 1;
  }

  return out;
}

function decodeHex(token) {
  const hex = token.slice(1, -1).replace(/\s+/g, '');
  let out = '';
  for (let index = 0; index + 1 < hex.length; index += 2) {
    const code = parseInt(hex.slice(index, index + 2), 16);
    if (Number.isFinite(code) && code >= 32 && code !== 127) out += String.fromCharCode(code);
  }
  return out;
}
