import { renderMarkdown } from '../ui/markdown.js';
import { createTransport } from './transport.js';

const $ = (id) => document.getElementById(id);

const el = {
  bar: $('bar'),
  title: $('title'),
  stream: $('stream'),
  intro: $('intro'),
  greet: $('greet'),
  chips: $('chips'),
  setup: $('setup'),
  setupBtn: $('setupBtn'),
  msgs: $('msgs'),
  jump: $('jump'),
  composer: $('composer'),
  ctx: $('ctx'),
  ctxLabel: $('ctxLabel'),
  ctxOff: $('ctxOff'),
  input: $('input'),
  send: $('send'),
  modelLabel: $('modelLabel'),
  status: $('status'),
  scrim: $('scrim'),
  sheet: $('sheet'),
  openSettings: $('openSettings'),
  closeSettings: $('closeSettings'),
  newChat: $('newChat'),
  apiKey: $('apiKey'),
  saveKey: $('saveKey'),
  removeKey: $('removeKey'),
  keyState: $('keyState'),
  keyStateText: $('keyStateText'),
  models: $('models'),
  pageAccessState: $('pageAccessState'),
  pageAccessText: $('pageAccessText'),
  pageAccessNote: $('pageAccessNote'),
  pageAccessBtn: $('pageAccessBtn'),
  autonomy: $('autonomy'),
  autonomyNote: $('autonomyNote'),
  instructions: $('instructions'),
  attachTab: $('attachTab'),
  theme: $('theme'),
  clearChat: $('clearChat'),
};

const state = {
  settings: null,
  meta: null,
  tab: null,
  capabilities: { pageAccess: false, host: '', origin: null },
  busy: false,
  keyState: 'none',
  nodes: new Map(),
  confirmNode: null,
  frame: 0,
  pinned: true,
  greetedPending: false,
};

const transport = createTransport();

const ERROR_TITLES = {
  no_key: 'No API key yet',
  bad_key: 'Groq rejected that key',
  rate_limit: 'Rate limited',
  network: 'Network trouble',
  upstream: 'Groq had a problem',
  request: 'That request failed',
  unknown: 'Something went wrong',
};

const MODE_LABELS = { assisted: 'Assisted', balanced: 'Balanced', autonomous: 'Autonomous' };

const MODE_NOTES = {
  assisted: 'ATOM asks before every action, including scrolling.',
  balanced: 'Reading and links run freely; clicking, typing and submitting ask first.',
  autonomous: 'Multi-step tasks run without prompts. Submitting a form still asks.',
};

boot();

/* -------------------------------------------------------------------- boot */

function boot() {
  const hour = new Date().getHours();
  el.greet.textContent =
    hour < 5 ? 'Still awake?' : hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';

  bindUi();
  transport.onEvent(onEvent);
  transport.send({ t: 'hello' });
  autosize();
  updateSend();
  applyTheme('system', false);
  syncIntro();
}

function bindUi() {
  el.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  el.input.addEventListener('input', () => {
    autosize();
    updateSend();
  });

  el.input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    // While a reply streams, Enter keeps your draft; only the stop button stops it.
    if (state.busy) return;
    submit();
  });

  for (const chip of el.chips.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      const text = chip.dataset.prompt || chip.textContent.trim();
      el.input.value = text;
      autosize();
      submit();
    });
  }

  el.setupBtn.addEventListener('click', openSheet);
  el.newChat.addEventListener('click', () => transport.send({ t: 'chat.new' }));
  el.clearChat.addEventListener('click', () => {
    transport.send({ t: 'chat.new' });
    closeSheet();
  });

  el.openSettings.addEventListener('click', openSheet);
  el.closeSettings.addEventListener('click', closeSheet);
  el.scrim.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && el.sheet.classList.contains('is-open')) closeSheet();
  });

  el.saveKey.addEventListener('click', commitKey);
  el.apiKey.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitKey();
    }
  });
  el.removeKey.addEventListener('click', () => transport.send({ t: 'settings.update', patch: { apiKey: '' } }));

  el.pageAccessBtn.addEventListener('click', togglePageAccess);

  el.autonomy.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]');
    if (!button) return;
    transport.send({ t: 'settings.update', patch: { autonomy: button.dataset.mode } });
  });

  let instructionsTimer = 0;
  el.instructions.addEventListener('input', () => {
    clearTimeout(instructionsTimer);
    instructionsTimer = setTimeout(
      () => transport.send({ t: 'settings.update', patch: { instructions: el.instructions.value } }),
      600,
    );
  });

  el.attachTab.addEventListener('click', () => {
    const next = el.attachTab.getAttribute('aria-checked') !== 'true';
    el.attachTab.setAttribute('aria-checked', String(next));
    transport.send({ t: 'settings.update', patch: { attachTab: next } });
    applyTab(state.tab);
  });

  el.theme.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-theme]');
    if (!button) return;
    transport.send({ t: 'settings.update', patch: { theme: button.dataset.theme } });
  });

  el.jump.addEventListener('click', () => {
    state.pinned = true;
    el.stream.scrollTo({ top: el.stream.scrollHeight, behavior: 'smooth' });
    el.jump.classList.remove('is-on');
  });

  el.ctxOff.addEventListener('click', () => {
    transport.send({ t: 'settings.update', patch: { attachTab: false } });
    applyTab(state.tab);
  });

  el.stream.addEventListener(
    'scroll',
    () => {
      const distance = el.stream.scrollHeight - el.stream.scrollTop - el.stream.clientHeight;
      state.pinned = distance < 72;
      el.bar.classList.toggle('is-scrolled', el.stream.scrollTop > 4);
      el.jump.classList.toggle('is-on', !state.pinned && state.nodes.size > 0);
    },
    { passive: true },
  );

  el.msgs.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const code = button.closest('.code')?.querySelector('pre')?.textContent ?? '';
    const ok = await copyText(code);
    if (!ok) return;
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1400);
  });

  window.addEventListener('focus', () => transport.send({ t: 'tab.context' }));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings?.theme === 'system') applyTheme('system', true);
  });
}

/* ------------------------------------------------------------------ events */

function onEvent(payload) {
  if (!payload) return;
  if (payload.t === 'state') return applyState(payload);
  if (payload.t !== 'evt') return;

  const event = payload.e || {};
  switch (event.kind) {
    case 'added':
      addMessage(event.message, event.title);
      break;
    case 'delta':
      onDelta(event);
      break;
    case 'done':
      onDone(event);
      break;
    case 'error':
      onError(event);
      break;
    case 'removed':
      removeMessage(event.id);
      break;
    case 'toolUpdate':
      onToolUpdate(event);
      break;
    case 'confirm':
      showConfirm(event.request);
      break;
    case 'confirmResolved':
      setTimeout(hideConfirm, 260);
      break;
    case 'busy':
      setBusy(event.busy);
      break;
    case 'settings':
      applySettings(event.settings);
      break;
    case 'capabilities':
      applyCapabilities(event.capabilities);
      break;
    case 'keycheck':
      applyKeyState(event.state, event.detail);
      break;
    case 'tab':
      applyTab(event.tab);
      if (event.capabilities) applyCapabilities(event.capabilities);
      break;
    case 'session':
      resetView();
      break;
    case 'notice':
      setStatus(event.text || '', true);
      break;
    case 'offline':
      setStatus('Reconnecting…', true);
      break;
    case 'fault':
      setStatus(event.message || 'Something broke.', true);
      break;
    default:
      break;
  }
}

function applyState(snapshot) {
  state.meta = snapshot.meta || null;
  applySettings(snapshot.settings);
  applyTab(snapshot.tab);
  applyCapabilities(snapshot.capabilities);

  el.title.textContent = snapshot.session?.title || 'ATOM';
  clearMessages();
  setBusy(Boolean(snapshot.busy));
  for (const message of snapshot.session?.messages ?? []) addMessage(message, null, { fromState: true });
  syncIntro();
  setStatus('');
  scrollToEnd(true);
  if (snapshot.confirm) showConfirm(snapshot.confirm);
  consumePendingPrompt();
}

/* ---------------------------------------------------------------- settings */

function applySettings(settings) {
  if (!settings) return;
  state.settings = settings;
  applyTheme(settings.theme, false);

  if (el.instructions.value !== settings.instructions) el.instructions.value = settings.instructions || '';
  el.attachTab.setAttribute('aria-checked', String(settings.attachTab));
  el.removeKey.hidden = !settings.hasKey;
  updateModelLabel();
  renderModels();
  applyKeyState(settings.hasKey ? (state.keyState === 'none' ? 'unknown' : state.keyState) : 'none');
  renderAutonomy();
  applyTab(state.tab);
  refreshSetup();
}

function renderAutonomy() {
  const mode = state.settings?.autonomy || 'balanced';
  for (const button of el.autonomy.querySelectorAll('button[data-mode]')) {
    button.setAttribute('aria-selected', String(button.dataset.mode === mode));
  }
  el.autonomyNote.textContent = MODE_NOTES[mode] || MODE_NOTES.balanced;
}

function applyCapabilities(capabilities) {
  if (!capabilities) return;
  state.capabilities = capabilities;
  const granted = Boolean(capabilities.pageAccess);
  const host = capabilities.host || '';

  el.pageAccessState.dataset.state = granted ? 'ok' : 'none';
  el.pageAccessText.textContent = host ? (granted ? 'Granted' : 'Not granted') : 'No site';
  el.pageAccessBtn.textContent = granted ? 'Revoke' : 'Grant';
  el.pageAccessBtn.disabled = !capabilities.origin;

  el.pageAccessNote.textContent = !host
    ? 'Open a website, then grant access for that site. ATOM never runs on browser pages.'
    : granted
      ? `${host} — ATOM can read this site and act on it when you allow each action.`
      : `${host} — ATOM cannot read or act here until you grant access.`;
}

function applyKeyState(keyState, detail) {
  state.keyState = keyState;
  el.keyState.dataset.state = keyState;
  el.keyStateText.textContent =
    { none: 'Not set', unknown: 'Saved', checking: 'Checking…', ok: 'Key works', bad: 'Key rejected' }[keyState] || '';
  el.keyState.title = detail || '';
}

function updateModelLabel() {
  const provider = state.meta?.providers?.find((p) => p.id === state.settings?.provider) || state.meta?.providers?.[0];
  const model = provider?.models?.find((m) => m.id === state.settings?.model);
  el.modelLabel.textContent = model?.label || provider?.label || '';
}

function renderModels() {
  const provider = state.meta?.providers?.find((p) => p.id === state.settings?.provider) || state.meta?.providers?.[0];
  if (!provider) return;

  const fragment = document.createDocumentFragment();
  for (const model of provider.models) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'model';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(model.id === state.settings.model));

    const dot = document.createElement('span');
    dot.className = 'model__dot';

    const text = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'model__name';
    name.append(document.createTextNode(model.label));
    if (model.tag) {
      const tag = document.createElement('span');
      tag.className = 'model__tag';
      tag.textContent = model.tag;
      name.append(tag);
    }
    const note = document.createElement('span');
    note.className = 'model__note';
    note.textContent = model.note || '';
    text.append(name, note);

    button.append(dot, text);
    button.addEventListener('click', () => transport.send({ t: 'settings.update', patch: { model: model.id } }));
    fragment.append(button);
  }
  el.models.replaceChildren(fragment);
}

function applyTheme(preference, persist) {
  const resolved =
    preference === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : preference;
  document.documentElement.dataset.theme = resolved;
  for (const button of el.theme.querySelectorAll('button[data-theme]')) {
    button.setAttribute('aria-selected', String(button.dataset.theme === preference));
  }
  if (persist) transport.send({ t: 'settings.update', patch: { theme: preference } });
}

function refreshSetup() {
  if (!state.settings) {
    el.setup.hidden = true;
    return;
  }
  el.setup.hidden = Boolean(state.settings.hasKey) || state.nodes.size > 0;
}

/* ------------------------------------------------------------ tab + status */

function applyTab(tab) {
  state.tab = tab;
  const show = Boolean(tab) && state.settings?.attachTab !== false;
  if (!show) {
    el.ctx.hidden = true;
    return;
  }
  el.ctx.hidden = false;
  el.ctxLabel.textContent = tab.title.length > 34 ? `${tab.title.slice(0, 34).trimEnd()}…` : tab.title;
  el.ctx.title = `${tab.title}\n${tab.url}`;
}

function setStatus(text, sticky = false) {
  if (!text) {
    el.status.hidden = true;
    el.status.textContent = '';
    return;
  }
  el.status.hidden = false;
  el.status.textContent = text;
  if (!sticky) {
    setTimeout(() => {
      if (el.status.textContent === text) setStatus('');
    }, 5000);
  }
}

/* ------------------------------------------------------------------ stream */

function addMessage(message, title, { fromState = false } = {}) {
  if (!message) return null;
  if (title) el.title.textContent = title;
  if (message.role === 'tool') return addToolMessage(message, fromState);

  const root = document.createElement('article');
  root.className = `msg msg--${message.role}`;
  root.dataset.id = message.id;
  if (fromState) root.style.animation = 'none';
  if (message.role === 'assistant' && !message.text.trim() && message.toolCalls?.length) {
    root.classList.add('msg--ghost');
  }

  const body = document.createElement('div');
  body.className = 'msg__body';

  const foot = document.createElement('div');
  foot.className = 'msg__foot';

  const node = {
    id: message.id,
    role: message.role,
    root,
    body,
    foot,
    text: message.text || '',
    streaming: message.status === 'streaming',
    dirty: false,
  };

  if (message.role === 'assistant') {
    root.classList.toggle('is-streaming', node.streaming);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'act';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      const ok = await copyText(node.text);
      if (!ok) return;
      copy.textContent = 'Copied';
      setTimeout(() => {
        copy.textContent = 'Copy';
      }, 1400);
    });
    foot.append(copy);
  }

  root.append(body, foot);
  el.msgs.append(root);
  state.nodes.set(message.id, node);

  paint(node);
  syncIntro();
  refreshSetup();
  if (node.streaming) scrollToEnd();

  return node;
}

function addToolMessage(message, fromState) {
  const root = document.createElement('article');
  root.className = 'msg msg--tool';
  root.dataset.id = message.id;
  if (fromState) root.style.animation = 'none';

  const row = document.createElement('div');
  row.className = 'tool';

  const dot = document.createElement('span');
  dot.className = 'tool__dot';
  const summary = document.createElement('span');
  summary.className = 'tool__summary';
  const detail = document.createElement('span');
  detail.className = 'tool__detail';

  row.append(dot, summary, detail);
  root.append(row);
  el.msgs.append(root);

  const node = {
    id: message.id,
    role: 'tool',
    root,
    row,
    summary,
    detail,
    tool: message.tool || {},
    text: message.text || '',
    streaming: false,
    dirty: false,
  };

  state.nodes.set(message.id, node);
  renderTool(node);
  syncIntro();
  refreshSetup();
  scrollToEnd();
  return node;
}

function renderTool(node) {
  const tool = node.tool || {};
  const status = tool.status || 'done';

  node.row.dataset.status = status;
  node.summary.textContent = tool.summary || 'Tool';
  node.detail.textContent = status === 'running' ? 'working…' : tool.detail || '';
  node.row.title = [tool.summary, tool.detail, tool.url].filter(Boolean).join('\n');

  const existing = node.row.querySelector('.tool__action');
  if (existing) existing.remove();

  if (status === 'failed' && tool.code === 'no_access' && tool.origin) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tool__action';
    button.textContent = 'Grant access';
    button.addEventListener('click', () => grantFromTool(node));
    node.row.append(button);
  }
}

function onDelta(event) {
  const node = state.nodes.get(event.id);
  if (!node || node.role !== 'assistant') return;
  node.text += event.text;
  schedulePaint(node);
}

function onDone(event) {
  const node = state.nodes.get(event.id);
  if (!node) return;
  node.streaming = false;
  if (typeof event.text === 'string') node.text = event.text;
  node.root.classList.remove('is-streaming');
  node.root.classList.toggle('msg--ghost', !node.text.trim() && (event.toolCalls || 0) > 0);
  paint(node);
  scrollToEnd();
}

function onToolUpdate(event) {
  const node = state.nodes.get(event.id);
  if (!node || node.role !== 'tool') return;
  node.tool = { ...node.tool, ...(event.tool || {}) };
  renderTool(node);
  if (state.pinned) scrollToEnd();
}

function onError(event) {
  const node = state.nodes.get(event.id);
  if (!node) return;
  node.streaming = false;
  node.root.classList.remove('is-streaming', 'msg--ghost');
  node.root.classList.add('msg--error');

  node.body.replaceChildren();
  if (node.text) {
    const partial = document.createElement('div');
    partial.innerHTML = renderMarkdown(node.text);
    node.body.append(partial);
  }
  node.body.append(errorCard(event.code, event.message));
  refreshSetup();
  scrollToEnd();
}

function removeMessage(id) {
  const node = state.nodes.get(id);
  if (!node) return;
  node.root.remove();
  state.nodes.delete(id);
  syncIntro();
  refreshSetup();
}

function clearMessages() {
  hideConfirm(true);
  el.msgs.replaceChildren();
  state.nodes.clear();
  syncIntro();
}

function resetView() {
  clearMessages();
  el.title.textContent = 'ATOM';
  setBusy(false);
  syncIntro();
  el.input.focus();
}

function paint(node) {
  node.dirty = false;
  if (node.role === 'user') {
    node.body.textContent = node.text;
    return;
  }
  if (node.role !== 'assistant') return;

  node.body.innerHTML = node.text ? renderMarkdown(node.text) : '';
  if (node.streaming) mountCaret(node.body);
}

/**
 * Put the caret at the end of the text that is actually there — inside the last
 * paragraph, list item or code block — instead of after the block, where it
 * would sit alone on a new line while streaming.
 */
function mountCaret(body) {
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.setAttribute('aria-hidden', 'true');

  let target = body;
  for (let depth = 0; depth < 8; depth += 1) {
    const last = target.lastElementChild;
    if (!last) break;
    if (last.classList.contains('code')) {
      target = last.querySelector('pre code') || last;
      break;
    }
    target = last;
  }

  target.append(caret);
}

function schedulePaint(node) {
  node.dirty = true;
  if (state.frame) return;
  state.frame = requestAnimationFrame(() => {
    state.frame = 0;
    for (const candidate of state.nodes.values()) {
      if (candidate.dirty) paint(candidate);
    }
    if (state.pinned) scrollToEnd();
  });
}

function errorCard(code, message) {
  const card = document.createElement('div');
  card.className = 'err';

  const title = document.createElement('p');
  title.className = 'err__title';
  title.textContent = ERROR_TITLES[code] || ERROR_TITLES.unknown;

  const text = document.createElement('p');
  text.className = 'err__text';
  text.textContent = message || '';

  const actions = document.createElement('div');
  actions.className = 'err__actions';

  if (code === 'no_key' || code === 'bad_key') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--primary';
    button.textContent = 'Open settings';
    button.addEventListener('click', openSheet);
    actions.append(button);
  } else {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.textContent = 'Try again';
    button.addEventListener('click', () => transport.send({ t: 'chat.retry' }));
    actions.append(button);
  }

  card.append(title, text, actions);
  return card;
}

/* ------------------------------------------------------------- permissions */

function showConfirm(request) {
  if (!request) return;
  hideConfirm(true);

  const card = document.createElement('div');
  card.className = 'confirm';
  card.dataset.id = request.id;

  const title = document.createElement('p');
  title.className = 'confirm__title';
  // The summary already reads as an action, so it becomes the question itself
  // instead of getting wrapped in a second set of quotes.
  title.textContent = `${request.summary}?`;

  const meta = document.createElement('p');
  meta.className = 'confirm__meta';
  const mode = MODE_LABELS[state.settings?.autonomy] || MODE_LABELS.balanced;
  meta.textContent = `${request.host || 'this page'} · ${mode} mode`;

  const actions = document.createElement('div');
  actions.className = 'confirm__actions';

  const allow = document.createElement('button');
  allow.type = 'button';
  allow.className = 'btn btn--primary';
  allow.textContent = 'Allow';
  allow.addEventListener('click', () => respondConfirm(request.id, true));

  const deny = document.createElement('button');
  deny.type = 'button';
  deny.className = 'btn';
  deny.textContent = 'Deny';
  deny.addEventListener('click', () => respondConfirm(request.id, false));

  actions.append(allow, deny);
  card.append(title, meta, actions);

  const wrapper = document.createElement('article');
  wrapper.className = 'msg msg--confirm';
  wrapper.append(card);
  el.msgs.append(wrapper);

  state.confirmNode = wrapper;
  syncIntro();
  scrollToEnd();
  allow.focus({ preventScroll: true });
}

function respondConfirm(id, allow) {
  const card = state.confirmNode?.querySelector('.confirm');
  if (card) {
    card.classList.add('is-answered');
    for (const button of card.querySelectorAll('button')) button.disabled = true;
    const meta = card.querySelector('.confirm__meta');
    if (meta) meta.textContent = allow ? 'Allowed' : 'Denied';
  }
  transport.send({ t: 'confirm.respond', id, allow });
}

function hideConfirm(immediate = false) {
  const node = state.confirmNode;
  if (!node) return;
  state.confirmNode = null;
  if (immediate) {
    node.remove();
    return;
  }
  node.style.transition = 'opacity .22s var(--ease), transform .22s var(--ease)';
  node.style.opacity = '0';
  node.style.transform = 'translateY(-4px)';
  setTimeout(() => node.remove(), 220);
}

/* ---------------------------------------------------------------- composer */

function submit() {
  if (state.busy) {
    transport.send({ t: 'chat.stop' });
    return;
  }
  const text = el.input.value.trim();
  if (!text) return;

  el.input.value = '';
  autosize();
  updateSend();
  transport.send({ t: 'chat.send', text });
}

function setBusy(busy) {
  state.busy = Boolean(busy);
  el.send.dataset.mode = state.busy ? 'stop' : 'send';
  el.send.setAttribute('aria-label', state.busy ? 'Stop' : 'Send');
  const use = el.send.querySelector('use');
  use?.setAttribute('href', state.busy ? '#i-stop' : '#i-arrow');
  updateSend();
}

function updateSend() {
  el.send.disabled = state.busy ? false : el.input.value.trim().length === 0;
}

function autosize() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 168)}px`;
}

function scrollToEnd(force = false) {
  if (!force && !state.pinned) return;
  el.stream.scrollTop = el.stream.scrollHeight;
}

function syncIntro() {
  const empty = state.nodes.size === 0;
  el.intro.hidden = !empty;
  if (empty) {
    el.jump.classList.remove('is-on');
    state.pinned = true;
  }
}

/* --------------------------------------------------------------- sheet + misc */

function openSheet() {
  el.scrim.hidden = false;
  el.sheet.setAttribute('aria-hidden', 'false');
  el.scrim.classList.add('is-open');
  el.sheet.classList.add('is-open');
  if (!state.settings?.hasKey) setTimeout(() => el.apiKey.focus({ preventScroll: true }), 280);
}

function closeSheet() {
  el.sheet.classList.remove('is-open');
  el.scrim.classList.remove('is-open');
  el.sheet.setAttribute('aria-hidden', 'true');
  setTimeout(() => {
    el.scrim.hidden = true;
  }, 260);
}

function commitKey() {
  const key = el.apiKey.value.trim();
  if (!key) return;
  transport.send({ t: 'settings.update', patch: { apiKey: key } });
  el.apiKey.value = '';
  el.apiKey.blur();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text || '');
    return true;
  } catch {
    setStatus('Clipboard is blocked here.');
    return false;
  }
}

/* ------------------------------------------------------------ page access */

async function togglePageAccess() {
  if (!(await permissionsAvailable())) return;
  const origin = state.capabilities?.origin;
  if (!origin) return;

  if (state.capabilities.pageAccess) {
    try {
      await chrome.permissions.remove({ origins: [origin] });
      setStatus('Page access revoked for this site.');
    } catch (error) {
      setStatus(error?.message || "Couldn't revoke that.");
    }
    transport.send({ t: 'capabilities.refresh' });
    return;
  }

  await requestPageAccess(origin);
}

async function requestPageAccess(origin) {
  if (!(await permissionsAvailable()) || !origin) return false;
  try {
    const granted = await chrome.permissions.request({ origins: [origin] });
    transport.send({ t: 'capabilities.refresh' });
    if (!granted) setStatus('Access was not granted.');
    return Boolean(granted);
  } catch (error) {
    setStatus(error?.message || "That didn't work.");
    return false;
  }
}

async function grantFromTool(node) {
  const origin = node.tool?.origin;
  if (!origin) return;
  const granted = await requestPageAccess(origin);
  if (!granted) return;
  transport.send({ t: 'chat.retry' });
}

async function permissionsAvailable() {
  if (typeof chrome === 'undefined' || !chrome.permissions) {
    setStatus('Page access only exists inside the extension.');
    return false;
  }
  return true;
}

/** A prompt typed on the New Tab page arrives via storage, not messaging. */
async function consumePendingPrompt() {
  if (state.greetedPending) return;
  state.greetedPending = true;
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  try {
    const stored = await chrome.storage.local.get('atom.pending');
    const pending = stored?.['atom.pending'];
    if (!pending) return;
    await chrome.storage.local.remove('atom.pending');
    if (!pending.text || Date.now() - (pending.at || 0) > 30000) return;
    transport.send({ t: 'chat.send', text: pending.text });
  } catch {
    /* nothing pending */
  }
}
