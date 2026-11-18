/**
 * Service-worker side of page access: per-site permission, on-demand injection,
 * and turning a page description into something a model can actually use.
 */

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

export function formatPageForModel(page) {
  const lines = [`Page: "${page.title || 'Untitled'}" — ${page.url}`];

  if (page.scroll) {
    lines.push(
      `Scroll: ${page.scroll.percent}% down (${page.scroll.y}px of ${page.scroll.height}px, viewport ${page.scroll.viewport}px)`,
    );
  }
  if (page.forms?.password) lines.push('Note: this page has a password field.');

  if (page.text) lines.push('', 'Visible text:', page.text);

  if (page.headings?.length) {
    lines.push('', `Headings: ${page.headings.map((heading) => `H${heading.level} ${heading.text}`).join(' · ')}`);
  }

  if (page.elements?.length) {
    lines.push('', `Interactive elements (${page.elements.length}${page.truncated ? '+ (capped)' : ''}):`);
    for (const element of page.elements) lines.push(formatElement(element));
  } else {
    lines.push('', 'Interactive elements: none found.');
  }

  return lines.join('\n');
}

function formatElement(element) {
  const parts = [`[${element.ref}] ${element.kind}`, JSON.stringify(element.name || '')];

  if (element.href) parts.push(`→ ${element.href}`);
  if (element.placeholder) parts.push(`placeholder=${JSON.stringify(element.placeholder)}`);
  if (element.value) parts.push(`value=${JSON.stringify(element.value)}`);
  if (element.options?.length) parts.push(`options=[${element.options.map((option) => JSON.stringify(option)).join(', ')}]`);
  if (element.kind === 'checkbox') parts.push(element.checked ? '(checked)' : '(unchecked)');
  if (element.secret) parts.push('(password)');
  if (element.disabled) parts.push('(disabled)');

  return parts.join(' ');
}

/** Short, human summary of a tool call for the transcript row. */
export function describeAction(tool, args, refMeta) {
  const name = refMeta?.name || '';
  switch (tool) {
    case 'read_page':
      return 'Read the page';
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
    default:
      return `Run ${tool}`;
  }
}

function trim(value) {
  const text = String(value || '');
  return text.length > 42 ? `${text.slice(0, 42).trimEnd()}…` : text;
}
