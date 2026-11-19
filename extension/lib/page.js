/**
 * Service-worker side of page access: per-site permission, on-demand injection,
 * and turning a page description into something a model can actually use.
 */
import { maskSecrets, redactionNote } from './redact.js';

export function originPattern(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.host}/*`;
  } catch {
    return null;
  }
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export async function hasPageAccess(url) {
  const pattern = originPattern(url);
  if (!pattern) return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

/**
 * The whole web, granted in one prompt. `permissions.contains` treats a granted
 * wildcard as covering every narrower origin, so `hasPageAccess` starts saying
 * yes everywhere the moment this is granted — the one place that matters is
 * that the grant still came from a click, never from a page or the model.
 */
export const ALL_SITES = '*://*/*';

export async function hasAllSites() {
  try {
    return await chrome.permissions.contains({ origins: [ALL_SITES] });
  } catch {
    return false;
  }
}

/** Inject once per document; the agent guards itself against double installs. */
async function ensureAgent(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { channel: 'atom', type: 'ping' });
    if (pong?.ok) return;
  } catch {
    /* not there yet */
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/agent.js'] });
}

/** Inject once, so the control badge has somewhere to live before an action. */
export async function ensurePageAgent(tabId) {
  return ensureAgent(tabId);
}

export async function readPage(tabId) {
  await ensureAgent(tabId);
  const page = await chrome.tabs.sendMessage(tabId, { channel: 'atom', type: 'read' });
  if (!page?.ok) throw new Error(page?.message || 'The page could not be read.');
  return page;
}

export async function actOnPage(tabId, action) {
  await ensureAgent(tabId);
  const result = await chrome.tabs.sendMessage(tabId, { channel: 'atom', type: 'act', action });
  return result ?? { ok: false, message: 'No response from the page.' };
}

/**
 * How much of a page a read brings back. Free tiers count every token, so the
 * same page has a small, a normal and a large view instead of one size that is
 * too big for Groq and too thin for a paid model.
 */
export const READ_LIMITS = {
  small: { maxElements: 40, maxChars: 4000 },
  normal: { maxElements: 70, maxChars: 8000 },
  large: { maxElements: 120, maxChars: 16000 },
};

export function readBudget(limit) {
  return READ_LIMITS[limit] || READ_LIMITS.normal;
}

/**
 * Kinds an action usually needs. A chat box or a search field deep in a long
 * page must never fall past the element cut, because the model then scrolls
 * looking for it instead of typing into it.
 */
const FIELD_KINDS = new Set(['editable', 'input', 'textarea', 'select']);

function fieldsFirst(elements) {
  const fields = elements.filter((element) => FIELD_KINDS.has(element.kind));
  if (!fields.length) return elements;
  return [...fields, ...elements.filter((element) => !FIELD_KINDS.has(element.kind))];
}

export function formatPageForModel(page, { maxElements = 120, maxChars = 16000 } = {}) {
  const lines = [`Page: "${page.title || 'Untitled'}" — ${page.url}`];

  if (page.frames) {
    lines.push(
      `Frames: ${page.frames} same-origin frame${page.frames === 1 ? '' : 's'} or open shadow root${page.frames === 1 ? '' : 's'} included (their refs are prefixed f1:, f2:…). Cross-origin frames cannot be read.`,
    );
  }

  if (page.scroll) {
    lines.push(
      `Scroll: ${page.scroll.percent}% down (${page.scroll.y}px of ${page.scroll.height}px, viewport ${page.scroll.viewport}px)`,
    );
  }
  if (page.forms?.sensitive) {
    lines.push('Note: this page has password, card or one-time-code fields; typing into them always asks the user first.');
  } else if (page.forms?.password) {
    lines.push('Note: this page has a password field.');
  }

  if (page.text) {
    const text =
      page.text.length > maxChars
        ? `${page.text.slice(0, maxChars)}\n… ${page.text.length - maxChars} more characters not shown (the user can raise Page read size in Settings, or read again after scrolling).`
        : page.text;
    lines.push('', 'Visible text:', text);
  }

  if (page.headings?.length) {
    lines.push('', `Headings: ${page.headings.map((heading) => `H${heading.level} ${heading.text}`).join(' · ')}`);
  }

  if (page.elements?.length) {
    const ordered = fieldsFirst(page.elements);
    const shown = ordered.slice(0, maxElements);
    const total = ordered.length;
    lines.push(
      '',
      `Interactive elements (${shown.length} of ${total}${page.truncated ? '+, capped on the page' : ''}):`,
    );
    for (const element of shown) lines.push(formatElement(element));
    if (total > shown.length) {
      lines.push(`… ${total - shown.length} more controls not shown; the user can raise Page read size in Settings.`);
    }
  } else {
    lines.push('', 'Interactive elements: none found.');
  }

  // Page text, hrefs and field values are the likeliest place for a token or an
  // address in the user's session to be sitting, so the whole view is masked
  // once, at the last moment before it becomes a tool result.
  const masked = maskSecrets(lines.join('\n'));
  return masked.count ? `${redactionNote(masked.count, 'page')}\n${masked.text}` : masked.text;
}

/**
 * The cheap view of a page: title, headings, opening text and the first few
 * elements with their refs. Small enough to ride the first request for free,
 * big enough that "what is this page?" and an obvious click need no read_page.
 */
export function formatDigestForModel(page, { maxElements = 20, maxChars = 800 } = {}) {
  const lines = [`Page: ${page.title || 'untitled'} — ${page.url || ''}`];

  if (page.headings?.length) {
    const headings = page.headings.slice(0, 8).map((heading) => `H${heading.level} ${heading.text}`);
    lines.push(`Headings: ${headings.join(' · ')}${page.headings.length > 8 ? ' …' : ''}`);
  }

  const text = String(page.text || '').replace(/\s+/g, ' ').trim();
  if (text) {
    lines.push('', `Opening text: ${text.slice(0, maxChars)}${text.length > maxChars ? '…' : ''}`);
  }

  const elements = fieldsFirst(page.elements ?? []);
  if (elements.length) {
    lines.push(
      '',
      `Interactive elements (${elements.length}${page.truncated ? '+ (capped)' : ''}), first ${Math.min(maxElements, elements.length)}:`,
    );
    for (const element of elements.slice(0, maxElements)) lines.push(formatElement(element));
    if (elements.length > maxElements) {
      lines.push(`… ${elements.length - maxElements} more, plus the rest of the text: call read_page.`);
    }
  } else {
    lines.push('', 'Interactive elements: none found.');
  }

  const masked = maskSecrets(lines.join('\n'));
  return masked.count ? `${redactionNote(masked.count, 'page digest')}\n${masked.text}` : masked.text;
}

function formatElement(element) {
  const parts = [`[${element.ref}] ${element.role || element.kind}`, JSON.stringify(element.name || '')];

  if (element.href) parts.push(`→ ${element.href}`);
  if (element.placeholder) parts.push(`placeholder=${JSON.stringify(element.placeholder)}`);
  if (element.value) parts.push(`value=${JSON.stringify(element.value)}`);
  if (element.options?.length) parts.push(`options=[${element.options.map((option) => JSON.stringify(option)).join(', ')}]`);
  if (element.kind === 'checkbox') parts.push(element.checked ? '(checked)' : '(unchecked)');
  if (element.sensitive) parts.push(`(${element.sensitive} field — typing asks)`);
  if (element.disabled) parts.push('(disabled)');

  return parts.join(' ');
}

/** Short, human summary of a tool call for the transcript row. */
export function describeAction(tool, args, refMeta) {
  const name = refMeta?.name || '';
  switch (tool) {
    case 'read_page':
      return 'Read the page';
    case 'read_console':
      return 'Read the console';
    case 'read_network':
      return 'Read failed requests';
    case 'click':
      return name ? `Click “${trim(name)}”` : `Click ${args?.ref || 'an element'}`;
    case 'type_text':
      return name ? `Type into “${trim(name)}”` : `Type into ${args?.ref || 'a field'}`;
    case 'select_option':
      return name ? `Choose in “${trim(name)}”` : `Choose an option in ${args?.ref || 'a dropdown'}`;
    case 'scroll':
      return `Scroll ${args?.direction || 'down'}`;
    case 'navigate':
      return `Open ${trim(hostOf(args?.url) || String(args?.url || ''))}`;
    case 'list_tabs':
      return 'List the open tabs';
    case 'plan':
      return 'Plan the task';
    case 'press_key':
      return args?.keys ? `Press ${args.keys}` : 'Press a key';
    case 'tabs':
      return args?.action === 'close'
        ? 'Close tabs'
        : args?.action === 'open'
          ? `Open a tab for ${trim(hostOf(args?.url) || 'an address')}`
          : args?.action === 'group'
            ? 'Group tabs'
            : 'Switch tabs';
    case 'browser': {
      const action = String(args?.action || 'action').replace(/_/g, ' ');
      const target = args?.url ? hostOf(args.url) : '';
      return `Browser: ${action}${target ? ` ${target}` : ''}`;
    }
    case 'screenshot':
      return 'Take a screenshot';
    case 'run_js':
      return 'Run JavaScript in the page';
    case 'remember':
      return args?.text ? `Remember “${trim(args.text)}”` : 'Remember this';
    default:
      return `Run ${tool}`;
  }
}

function trim(value) {
  const text = String(value || '');
  return text.length > 42 ? `${text.slice(0, 42).trimEnd()}…` : text;
}
