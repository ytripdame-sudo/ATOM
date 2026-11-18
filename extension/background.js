/**
 * ATOM — background service worker.
 *
 * The single source of truth for settings, the conversation, page permissions
 * and any in-flight turn. Every UI surface connects here over one port and
 * renders what it is told (spec §2). Nothing else keeps state.
 *
 * A "turn" is one user message and everything the model does about it: it may
 * take several steps, call page tools, and wait on the user for permission.
 */
import { providerById, providerMeta } from './lib/providers/index.js';
import { loadSettings, saveSettings, publicSettings } from './lib/settings.js';
import {
  loadSession,
  saveSession,
  newSession,
  createMessage,
  titleFrom,
  dropMessage,
  toProviderMessages,
} from './lib/session.js';
import { TOOL_DEFINITIONS, TOOL_NAMES, parseArguments } from './lib/agent/tools.js';
import { runAgentTurn, MAX_STEPS } from './lib/agent/loop.js';
import { needsConfirmation, isForbidden } from './lib/agent/policy.js';
import {
  hasPageAccess,
  readPage,
  actOnPage,
  formatPageForModel,
  describeAction,
  originPattern,
  hostOf,
} from './lib/page.js';

/** @type {Set<chrome.runtime.Port>} */
const ports = new Set();

let session = null;
let settingsPromise = null;
let readyPromise = null;
let persistTimer = 0;
let tabTimer = 0;

/** The in-flight turn, if any: { controller }. */
let turn = null;
/** The permission question currently on screen: { id, answer }. */
let pendingConfirm = null;
/** Refs from the last read_page in this tab, for summaries and policy. */
let refCache = new Map();

/* ------------------------------------------------------------------ boot */

chrome.runtime.onInstalled.addListener(() => {
  openPanelOnActionClick();
});

chrome.runtime.onStartup?.addListener(() => {
  openPanelOnActionClick();
});

function openPanelOnActionClick() {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true })?.catch?.(() => {});
}

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'open-atom') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.sidePanel.open({ windowId: tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT });
  } catch {
    /* no panel on this surface — the toolbar button still works */
  }
});

chrome.tabs?.onActivated.addListener(scheduleTabBroadcast);
chrome.tabs?.onUpdated.addListener((_tabId, info) => {
  if (info.title || info.url) scheduleTabBroadcast();
});

chrome.permissions?.onAdded.addListener(() => broadcastCapabilities());
chrome.permissions?.onRemoved.addListener(() => {
  refCache = new Map();
  broadcastCapabilities();
});

async function broadcastCapabilities() {
  broadcast({ kind: 'capabilities', capabilities: await capabilityState() });
}

function scheduleTabBroadcast() {
  clearTimeout(tabTimer);
  tabTimer = setTimeout(async () => {
    if (!ports.size) return;
    const tab = await activeTab();
    broadcast({ kind: 'tab', tab, capabilities: await capabilityState(tab) });
  }, 250);
}

/* --------------------------------------------------------------- plumbing */

function ready() {
  readyPromise ??= (async () => {
    session = (await loadSession()) ?? newSession();
    await getSettings();
  })();
  return readyPromise;
}

function getSettings() {
  settingsPromise ??= loadSettings();
  return settingsPromise;
}

function broadcast(event) {
  for (const port of ports) {
    try {
      port.postMessage({ t: 'evt', e: event });
    } catch {
      ports.delete(port);
    }
  }
}

function schedulePersist(delay = 400) {
  clearTimeout(persistTimer);
  const snapshot = session;
  persistTimer = setTimeout(() => {
    saveSession(snapshot);
  }, delay);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'atom') return;
  ports.add(port);
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    // No panel means nobody can answer a permission question: deny and stop.
    if (!ports.size) {
      resolveConfirmation(false);
      turn?.controller.abort();
    }
  });

  port.onMessage.addListener((message) => {
    handle(port, message).catch((err) => {
      console.error('[atom]', err);
      safePost(port, {
        t: 'evt',
        e: { kind: 'fault', message: String(err?.message || err) },
      });
    });
  });
});

function safePost(port, payload) {
  try {
    port.postMessage(payload);
  } catch {
    ports.delete(port);
  }
}

async function handle(port, message) {
  await ready();
  switch (message?.t) {
    case 'hello':
      return safePost(port, await snapshot());
    case 'chat.send':
      return send(String(message.text ?? ''));
    case 'chat.retry':
      return retry();
    case 'chat.stop':
      return stop();
    case 'chat.new':
      return reset();
    case 'confirm.respond':
      return respondToConfirmation(message);
    case 'settings.update':
      return updateSettings(message.patch);
    case 'settings.verify':
      return verifyKey();
    case 'tab.context':
      safePost(port, {
        t: 'evt',
        e: { kind: 'tab', tab: await activeTab(), capabilities: await capabilityState() },
      });
      return undefined;
    case 'capabilities.refresh':
      if (!(await hasPageAccess((await activeTab())?.url || ''))) refCache = new Map();
      return broadcastCapabilities();
    default:
      return undefined;
  }
}

async function snapshot() {
  const settings = await getSettings();
  return {
    t: 'state',
    session,
    settings: publicSettings(settings),
    meta: providerMeta(),
    tab: await activeTab(),
    capabilities: await capabilityState(),
    busy: Boolean(turn),
    // A panel that reloads mid-question gets the same question back.
    confirm: pendingConfirm?.request || null,
  };
}

async function capabilityState(tabOverride) {
  const tab = tabOverride === undefined ? await activeTab() : tabOverride;
  return {
    pageAccess: Boolean(tab?.url) && (await hasPageAccess(tab.url)),
    host: tab?.url ? hostOf(tab.url) : '',
    origin: tab?.url ? originPattern(tab.url) : null,
  };
}

/* ---------------------------------------------------------------- the turn */

async function send(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || turn) return;

  const message = createMessage('user', trimmed);
  if (!session.messages.some((m) => m.role === 'user')) session.title = titleFrom(trimmed);
  session.messages.push(message);
  session.updatedAt = Date.now();

  broadcast({ kind: 'added', message, title: session.title });
  schedulePersist();
  await runTurn();
}

async function retry() {
  if (turn) return;

  // Drop whatever never finished, including tool rows from a stopped step.
  for (let guard = 0; guard < 60; guard += 1) {
    const last = session.messages[session.messages.length - 1];
    if (!last) break;
    const unfinished =
      last.role === 'tool' ||
      (last.role === 'assistant' && (last.status === 'error' || (!last.text && !last.toolCalls?.length)));
    if (!unfinished) break;
    dropMessage(session, last.id);
    broadcast({ kind: 'removed', id: last.id });
  }

  if (!session.messages.some((m) => m.role === 'user')) return;
  await runTurn();
}

async function runTurn() {
  const settings = await getSettings();

  if (!settings.apiKey) {
    const reply = createMessage('assistant', '', { status: 'streaming' });
    session.messages.push(reply);
    broadcast({ kind: 'added', message: reply });
    fail(reply, 'no_key', 'ATOM needs a Groq API key before it can reply.');
    return;
  }

  const provider = providerById(settings.provider);
  const model = provider.models.some((m) => m.id === settings.model) ? settings.model : provider.models[0].id;
  const controller = new AbortController();
  turn = { controller };

  broadcast({ kind: 'busy', busy: true });

  const tab = await activeTab();
  const pageAccess = Boolean(tab?.url) && (await hasPageAccess(tab.url));
  const promptTab = settings.attachTab ? tab : null;
  const tools = pageAccess ? TOOL_DEFINITIONS : null;

  try {
    const outcome = await runAgentTurn({
      provider,
      apiKey: settings.apiKey,
      model,
      tools,
      signal: controller.signal,
      buildMessages: () =>
        toProviderMessages({
          messages: session.messages,
          settings,
          tab: promptTab,
          capabilities: { pageAccess },
        }),
      beginStep: () => beginStep(controller),
      runTool: (call) => runTool(call),
    });

    if (outcome.exhausted) {
      broadcast({
        kind: 'notice',
        text: `Stopped after ${MAX_STEPS} steps so this stays cheap. Ask me to keep going.`,
      });
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      const info = describeError(error);
      console.warn('[atom] turn failed', error);
      broadcast({ kind: 'notice', text: info.message, code: info.code });
    }
  } finally {
    resolveConfirmation(false);
    turn = null;
    broadcast({ kind: 'busy', busy: false });
    schedulePersist(0);
  }
}

/** One assistant reply: streams into its own message and finalises it. */
function beginStep(controller) {
  const message = createMessage('assistant', '', { status: 'streaming' });
  session.messages.push(message);
  broadcast({ kind: 'added', message });

  const flusher = createFlusher(message.id);
  let accumulated = '';
  let finished = false;

  return {
    text: () => accumulated,
    push(chunk) {
      accumulated += chunk;
      flusher.push(chunk);
    },
    async finish({ text, toolCalls = [], failed = false, error = null } = {}) {
      if (finished) return;
      finished = true;
      flusher.flush();

      const aborted = controller.signal.aborted;
      message.text = typeof text === 'string' && text ? text : accumulated;

      if (failed && !aborted) {
        const info = describeError(error);
        message.status = 'error';
        message.code = info.code;
        broadcast({ kind: 'error', id: message.id, code: info.code, message: info.message });
        return;
      }

      message.status = 'done';
      if (toolCalls.length) message.toolCalls = toolCalls;
      session.updatedAt = Date.now();
      broadcast({ kind: 'done', id: message.id, text: message.text, stopped: aborted, toolCalls: toolCalls.length });

      if (!message.text.trim() && !toolCalls.length) {
        dropMessage(session, message.id);
        broadcast({ kind: 'removed', id: message.id });
      }
    },
  };
}

async function runTool(call) {
  const name = String(call.function?.name || '');
  const parsed = parseArguments(call.function?.arguments);
  const args = parsed.value || {};
  const tab = await activeTab();

  const refMeta = ['click', 'type_text', 'select_option'].includes(name)
    ? refCache.get(String(args.ref || '')) || null
    : null;

  const message = createMessage('tool', '', {
    status: 'done',
    toolCallId: call.id || `call_${Date.now().toString(36)}`,
    name,
    tool: {
      name,
      summary: describeAction(name, args, refMeta),
      status: 'running',
      detail: '',
      host: tab?.url ? hostOf(tab.url) : '',
    },
  });

  session.messages.push(message);
  broadcast({ kind: 'added', message });

  const settle = (status, detail, content, extra = {}) => {
    message.text = content;
    message.tool = { ...message.tool, status, detail, ...extra };
    broadcast({ kind: 'toolUpdate', id: message.id, tool: message.tool });
    schedulePersist(0);
  };

  if (!TOOL_NAMES.has(name)) {
    return settle('failed', 'Unknown tool', `There is no tool called "${name}". Use only the tools you were given.`);
  }

  if (!parsed.ok) {
    return settle(
      'failed',
      parsed.message || 'Bad arguments',
      `${parsed.message || 'Those arguments were not valid JSON.'} Call the tool again with valid JSON.`,
    );
  }

  if (!tab) {
    return settle(
      'failed',
      'No page',
      'No web page is focused right now, so there is nothing to read or act on. Ask the user which page they mean.',
    );
  }

  const forbidden = isForbidden({ tool: name, args });
  if (forbidden) return settle('failed', 'Refused', forbidden, { code: 'forbidden' });

  if (!(await hasPageAccess(tab.url))) {
    const host = hostOf(tab.url);
    return settle(
      'failed',
      'Needs page access',
      `Page access is not granted for ${host}, so this page cannot be read or changed. The user can grant it with the Grant access button under this step, in ATOM's settings panel. Do not claim to have read the page.`,
      { code: 'no_access', host, origin: originPattern(tab.url) },
    );
  }

  const settings = await getSettings();
  if (needsConfirmation({ mode: settings.autonomy, tool: name, args, refMeta })) {
    const allowed = await requestConfirmation({
      summary: message.tool.summary,
      host: hostOf(tab.url),
      tool: name,
      messageId: message.id,
    });
    if (!allowed) {
      return settle('denied', 'Denied', 'The user denied this action. Do not try it again; ask what they would prefer instead.', {
        code: 'denied',
      });
    }
  }

  try {
    if (name === 'read_page') {
      const page = await readPage(tab.id);
      refCache = new Map(page.elements.map((element) => [element.ref, { kind: element.kind, name: element.name }]));
      return settle('done', `${page.elements.length} elements`, formatPageForModel(page), { url: page.url });
    }

    if (name === 'navigate') {
      const url = String(args.url || '').trim();
      await chrome.tabs.update(tab.id, { url });
      await waitForTab(tab.id, 9000);
      const after = await activeTab();
      refCache = new Map();
      return settle('done', 'opened', `Navigated to ${after?.url || url}. Call read_page before acting on it.`, {
        url: after?.url || url,
      });
    }

    const response = await actOnPage(tab.id, toPageAction(name, args));
    if (response?.navigated) refCache = new Map();

    const detail = response?.message || (response?.ok === false ? 'That did not work.' : 'Done.');
    return settle(response?.ok === false ? 'failed' : 'done', detail, detail, {
      code: response?.code || '',
      url: response?.url || '',
    });
  } catch (error) {
    const detail = error?.message || 'The page did not respond.';
    return settle('failed', detail, `${detail} The page may have navigated, or access may have been revoked.`, {
      code: 'page_error',
    });
  }
}

function toPageAction(name, args) {
  switch (name) {
    case 'click':
      return { type: 'click', ref: String(args.ref || '') };
    case 'type_text':
      return {
        type: 'type',
        ref: String(args.ref || ''),
        text: String(args.text ?? ''),
        submit: Boolean(args.submit),
      };
    case 'select_option':
      return { type: 'select', ref: String(args.ref || ''), value: String(args.value ?? '') };
    case 'scroll':
      return { type: 'scroll', direction: String(args.direction || 'down') };
    default:
      return { type: 'read' };
  }
}

async function waitForTab(tabId, timeoutMs) {
  const started = Date.now();
  for (;;) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.status === 'complete') return true;
    } catch {
      return false;
    }
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/* ------------------------------------------------------------ confirmation */

function requestConfirmation({ summary, host, tool, messageId }) {
  return new Promise((resolve) => {
    const id = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    const answer = (allowed) => {
      if (pendingConfirm?.id === id) pendingConfirm = null;
      clearTimeout(timer);
      turn?.controller.signal.removeEventListener('abort', onAbort);
      broadcast({ kind: 'confirmResolved', id, allowed: Boolean(allowed) });
      resolve(Boolean(allowed));
    };

    // Fail closed: no answer in two minutes is a no.
    const timer = setTimeout(() => answer(false), 120000);
    const onAbort = () => answer(false);
    turn?.controller.signal.addEventListener('abort', onAbort, { once: true });

    const request = { id, tool, summary, host, messageId };
    pendingConfirm = { id, answer, request };

    broadcast({ kind: 'confirm', request });
  });
}

function respondToConfirmation(message) {
  if (!pendingConfirm || pendingConfirm.id !== message?.id) return;
  pendingConfirm.answer(Boolean(message.allow));
}

function resolveConfirmation(allowed) {
  pendingConfirm?.answer(Boolean(allowed));
}

/* ------------------------------------------------------------------ errors */

function fail(reply, code, message, partial = '') {
  reply.status = 'error';
  reply.code = code;
  reply.text = partial;
  broadcast({ kind: 'error', id: reply.id, code, message });
  schedulePersist(0);
}

function describeError(err) {
  const status = err?.status ?? 0;
  const code = err?.code ?? '';

  if (code === 'auth' || status === 401 || status === 403) {
    return { code: 'bad_key', message: 'Groq rejected that API key.' };
  }
  if (code === 'rate_limit' || status === 429) {
    return { code: 'rate_limit', message: 'Groq is rate-limiting this key. Give it a few seconds.' };
  }
  if (code === 'network') {
    return { code: 'network', message: "Couldn't reach Groq. Check your connection." };
  }
  if (status >= 500) {
    return { code: 'upstream', message: `Groq had a problem (${status}). Try again.` };
  }
  if (status) {
    return { code: 'request', message: err?.message || `Groq returned ${status}.` };
  }
  return { code: 'unknown', message: err?.message || 'That request failed.' };
}

/**
 * Coalesce token deltas so the panel repaints at ~30fps instead of once per
 * token. Fewer messages, fewer layouts, no visible stutter on fast models.
 */
function createFlusher(id, interval = 32) {
  let pending = '';
  let timer = 0;

  const flush = () => {
    if (!pending) return;
    broadcast({ kind: 'delta', id, text: pending });
    pending = '';
  };

  return {
    push(chunk) {
      pending += chunk;
      if (!timer) {
        timer = setTimeout(() => {
          timer = 0;
          flush();
        }, interval);
      }
    },
    flush() {
      clearTimeout(timer);
      timer = 0;
      flush();
    },
    cancel() {
      clearTimeout(timer);
      timer = 0;
      pending = '';
    },
  };
}

function stop() {
  resolveConfirmation(false);
  turn?.controller.abort();
}

async function reset() {
  resolveConfirmation(false);
  turn?.controller.abort();
  refCache = new Map();
  session = newSession();
  broadcast({ kind: 'session', session });
  await saveSession(session);
}

/* --------------------------------------------------------------- settings */

async function updateSettings(patch) {
  const before = await getSettings();
  const next = await saveSettings(patch && typeof patch === 'object' ? patch : {});
  settingsPromise = Promise.resolve(next);
  broadcast({ kind: 'settings', settings: publicSettings(next) });

  if (typeof patch?.apiKey === 'string' && patch.apiKey !== before.apiKey) {
    if (next.apiKey) await verifyKey();
    else broadcast({ kind: 'keycheck', state: 'none' });
  }
}

async function verifyKey() {
  const settings = await getSettings();
  if (!settings.apiKey) {
    broadcast({ kind: 'keycheck', state: 'none' });
    return;
  }
  broadcast({ kind: 'keycheck', state: 'checking' });
  const result = await providerById(settings.provider).verifyKey(settings.apiKey);
  broadcast({
    kind: 'keycheck',
    state: result.ok ? 'ok' : 'bad',
    detail: result.detail || '',
  });
}

/* ------------------------------------------------------------------- tabs */

async function activeTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return null;
    if (!/^https?:/i.test(tab.url)) return null; // no chrome:// or extension pages
    return {
      id: tab.id ?? null,
      title: (tab.title || hostOf(tab.url) || 'Untitled').slice(0, 160),
      url: tab.url,
    };
  } catch {
    return null;
  }
}
