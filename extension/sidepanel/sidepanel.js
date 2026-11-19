import { renderMarkdown } from '../ui/markdown.js';
import { MODE_LABELS } from '../lib/agent/policy.js';
import { AGENT_MODE_HINTS } from '../lib/agent/task.js';
import { GRANT_LABELS } from '../lib/grants.js';
import { promptFromFile } from '../lib/prompt-file.js';
import { groupChats } from '../lib/chats.js';
import { windowMessages, nextLimit, PAGE } from '../lib/chat-window.js';
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
  context: $('context'),
  contextText: $('contextText'),
  accessAsk: $('accessAsk'),
  accessAllowAll: $('accessAllowAll'),
  accessPerSite: $('accessPerSite'),
  msgs: $('msgs'),
  jump: $('jump'),
  composer: $('composer'),
  ctx: $('ctx'),
  ctxLabel: $('ctxLabel'),
  ctxOff: $('ctxOff'),
  chats: $('chats'),
  chatsEmpty: $('chatsEmpty'),
  chatsNew: $('chatsNew'),
  memories: $('memories'),
  memoryEmpty: $('memoryEmpty'),
  memoryInput: $('memoryInput'),
  memoryAdd: $('memoryAdd'),
  eraseMemories: $('eraseMemories'),
  eraseChats: $('eraseChats'),
  eraseState: $('eraseState'),
  grants: $('grants'),
  grantsEmpty: $('grantsEmpty'),
  quote: $('quote'),
  quoteLabel: $('quoteLabel'),
  quoteText: $('quoteText'),
  quoteClear: $('quoteClear'),
  input: $('input'),
  send: $('send'),
  capture: $('capture'),
  captureNote: $('captureNote'),
  deepThink: $('deepThink'),
  effort: $('effort'),
  webSearch: $('webSearch'),
  costHint: $('costHint'),
  searchProvider: $('searchProvider'),
  searchKey: $('searchKey'),
  searchEndpoint: $('searchEndpoint'),
  searchSave: $('searchSave'),
  searchState: $('searchState'),
  searchAuto: $('searchAuto'),
  searchBudget: $('searchBudget'),
  mic: $('mic'),
  speak: $('speak'),
  voiceState: $('voiceState'),
  voiceStateText: $('voiceStateText'),
  vSpeak: $('vSpeak'),
  vHandsFree: $('vHandsFree'),
  vVoice: $('vVoice'),
  vRate: $('vRate'),
  vRateValue: $('vRateValue'),
  vVolume: $('vVolume'),
  vVolumeValue: $('vVolumeValue'),
  vProvider: $('vProvider'),
  vEndpoint: $('vEndpoint'),
  vVoiceKey: $('vVoiceKey'),
  vSaveEndpoint: $('vSaveEndpoint'),
  vTest: $('vTest'),
  vStt: $('vStt'),
  vSttNote: $('vSttNote'),
  live: $('live'),
  modelPick: $('modelPick'),
  historyToggle: $('historyToggle'),
  side: $('side'),
  sideScrim: $('sideScrim'),
  sideClose: $('sideClose'),
  sideNew: $('sideNew'),
  sideSearch: $('sideSearch'),
  sideList: $('sideList'),
  sideEmpty: $('sideEmpty'),
  sideExport: $('sideExport'),
  sideImportBtn: $('sideImportBtn'),
  sideImport: $('sideImport'),
  menu: $('menu'),
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
  allSitesBtn: $('allSitesBtn'),
  allSitesNote: $('allSitesNote'),
  autonomy: $('autonomy'),
  autonomyNote: $('autonomyNote'),
  instructions: $('instructions'),
  importPrompt: $('importPrompt'),
  promptFile: $('promptFile'),
  keys: $('keys'),
  provider: $('provider'),
  rotate: $('rotate'),
  maxTokens: $('maxTokens'),
  readLimit: $('readLimit'),
  customUrl: $('customUrl'),
  customModel: $('customModel'),
  customKey: $('customKey'),
  customSave: $('customSave'),
  customClear: $('customClear'),
  customState: $('customState'),
  spBackground: $('spBackground'),
  spColor: $('spColor'),
  spAccent: $('spAccent'),
  spImage: $('spImage'),
  spUpload: $('spUpload'),
  spPickImage: $('spPickImage'),
  spImageState: $('spImageState'),
  spFont: $('spFont'),
  spWidth: $('spWidth'),
  spClock: $('spClock'),
  spGreeting: $('spGreeting'),
  spDate: $('spDate'),
  spLinks: $('spLinks'),
  spExport: $('spExport'),
  spImportBtn: $('spImportBtn'),
  spImport: $('spImport'),
  spState: $('spState'),
  attachTab: $('attachTab'),
  theme: $('theme'),
  perf: $('perf'),
  perfState: $('perfState'),
  clearChat: $('clearChat'),
  task: $('task'),
  taskTitle: $('taskTitle'),
  taskPhase: $('taskPhase'),
  taskPlan: $('taskPlan'),
  taskNow: $('taskNow'),
  taskLog: $('taskLog'),
  taskPause: $('taskPause'),
  taskResume: $('taskResume'),
  taskTakeover: $('taskTakeover'),
  taskStop: $('taskStop'),
  agentMode: $('agentMode'),
  agentModeNote: $('agentModeNote'),
  agentSteps: $('agentSteps'),
  agentTrusted: $('agentTrusted'),
  agentTrustedSave: $('agentTrustedSave'),
  mentions: $('mentions'),
};

const state = {
  settings: null,
  meta: null,
  tab: null,
  capabilities: { pageAccess: false, host: '', origin: null },
  busy: false,
  keyState: 'none',
  // The saved keys as the worker last described them, and the lines drawn for them.
  keys: [],
  keyRows: new Map(),
  nodes: new Map(),
  confirmNode: null,
  capture: { supported: false, armed: false, attached: false },
  // A selection waiting to be quoted into the next message.
  quote: null,
  // The conversation shelf, as the worker last described it.
  chats: [],
  activeChatId: '',
  // What the search box last found, and the query it belongs to. Null means the
  // list is showing the whole history.
  search: null,
  // A long conversation draws its newest page; "Show earlier" raises this.
  historyLimit: 40,
  // Per-message, not per session: both toggles clear after the question goes.
  turn: { think: false, web: false, effort: 'medium' },
  // The browsing task the worker last described, and the tabs the user @named.
  task: null,
  mentions: new Map(),
  mentionOpen: false,
  frame: 0,
  pinned: true,
  // What the live line under the composer is counting: the turn's clock, the
  // step the loop is on, and the ticker that redraws it.
  busySince: 0,
  step: 0,
  maxSteps: 0,
  tick: 0,
};

const transport = createTransport();

/** The @mention menu: the tabs it is offering, and where the @ started. */
const mention = { items: [], index: 0, start: 0, timer: 0 };

const ERROR_TITLES = {
  no_key: 'No API key yet',
  bad_key: 'The provider rejected that key',
  rate_limit: 'Rate limited',
  network: 'Network trouble',
  upstream: 'The provider had a problem',
  request: 'That request failed',
  unknown: 'Something went wrong',
};

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
  el.input.value = localStorage.getItem('atom.draft') || '';
  autosize();
  el.input.focus();
  updateSend();
  applyTheme('system', false);
  applyCapture();
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
    // A half-written question survives closing the panel.
    localStorage.setItem('atom.draft', el.input.value);
  });

  el.input.addEventListener('keydown', (event) => {
    if (state.mentionOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveMention(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        pickMention(mention.items[mention.index]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        hideMentions();
        return;
      }
    }

    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    // While a reply streams, Enter keeps your draft; only the stop button stops it.
    if (state.busy) return;
    submit();
  });

  el.input.addEventListener('input', scheduleMentions);
  el.input.addEventListener('click', scheduleMentions);

  for (const chip of el.chips.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      const text = chip.dataset.prompt || chip.textContent.trim();
      el.input.value = text;
      autosize();
      submit();
    });
  }

  el.setupBtn.addEventListener('click', openSheet);
  el.accessAllowAll.addEventListener('click', allowAllFromAsk);
  el.accessPerSite.addEventListener('click', () => answerAccess('per-site'));
  el.newChat.addEventListener('click', () => transport.send({ t: 'chat.new' }));
  el.clearChat.addEventListener('click', () => {
    transport.send({ t: 'chat.delete', id: state.activeChatId });
    closeSheet();
  });

  el.chatsNew.addEventListener('click', () => {
    transport.send({ t: 'chat.new' });
    closeSheet();
  });

  el.memoryAdd.addEventListener('click', addMemoryFromInput);
  el.eraseMemories.addEventListener('click', () => eraseArmed(el.eraseMemories, 'memories'));
  el.eraseChats.addEventListener('click', () => eraseArmed(el.eraseChats, 'chats'));
  el.memoryInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addMemoryFromInput();
  });

  el.openSettings.addEventListener('click', openSheet);
  el.closeSettings.addEventListener('click', closeSheet);
  el.scrim.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (el.sheet.classList.contains('is-open')) {
      closeSheet();
      return;
    }
    if (state.busy) transport.send({ t: 'chat.stop' });
  });

  document.addEventListener('keydown', (event) => {
    if (state.mentionOpen && event.key === 'Escape') hideMentions();
  });

  bindHistory();
  bindTurnControls();
  bindVoice();

  el.saveKey.addEventListener('click', commitKey);
  el.apiKey.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitKey();
    }
  });
  el.removeKey.addEventListener('click', () => transport.send({ t: 'settings.update', patch: { apiKey: '' } }));

  el.pageAccessBtn.addEventListener('click', togglePageAccess);
  el.allSitesBtn.addEventListener('click', toggleAllSites);

  el.capture.addEventListener('click', () => {
    if (!state.capture.supported || state.busy) return;
    state.capture.armed = !state.capture.armed;
    applyCapture();
  });

  el.autonomy.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]');
    if (!button) return;
    transport.send({ t: 'settings.update', patch: { autonomy: button.dataset.mode } });
  });

  el.agentMode.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-agent]');
    if (!button) return;
    const current = state.settings?.agent || {};
    transport.send({ t: 'settings.update', patch: { agent: { ...current, mode: button.dataset.agent } } });
  });

  el.agentSteps.addEventListener('change', () => {
    const current = state.settings?.agent || {};
    transport.send({ t: 'settings.update', patch: { agent: { ...current, stepLimit: Number(el.agentSteps.value) } } });
  });

  el.agentTrustedSave.addEventListener('click', () => {
    const current = state.settings?.agent || {};
    const trustedSites = el.agentTrusted.value
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    transport.send({ t: 'settings.update', patch: { agent: { ...current, trustedSites } } });
    setStatus('Trusted sites saved.');
  });

  el.taskPause.addEventListener('click', () => transport.send({ t: 'agent.pause' }));
  el.taskResume.addEventListener('click', () => transport.send({ t: 'agent.resume' }));
  el.taskTakeover.addEventListener('click', () => transport.send({ t: 'agent.takeover' }));
  el.taskStop.addEventListener('click', () => transport.send({ t: 'chat.stop' }));

  let instructionsTimer = 0;
  el.importPrompt.addEventListener('click', () => el.promptFile.click());
  el.promptFile.addEventListener('change', async () => {
    const file = el.promptFile.files?.[0];
    el.promptFile.value = '';
    if (!file) return;
    try {
      const content = /\.pdf$/i.test(file.name) ? await file.arrayBuffer() : await file.text();
      const text = await promptFromFile(file.name, content);
      const separator = el.instructions.value.trim() ? '\n\n' : '';
      el.instructions.value = `${el.instructions.value.trimEnd()}${separator}${text}`;
      transport.send({ t: 'settings.update', patch: { instructions: el.instructions.value } });
      setStatus(`Added ${file.name} to the instructions.`);
    } catch (error) {
      setStatus(error?.message || 'That file could not be read.');
    }
  });

  el.provider.addEventListener('change', () => {
    transport.send({ t: 'settings.update', patch: { provider: el.provider.value } });
  });

  el.rotate.addEventListener('click', () => {
    const next = el.rotate.getAttribute('aria-checked') !== 'true';
    el.rotate.setAttribute('aria-checked', String(next));
    transport.send({ t: 'settings.update', patch: { rotate: next } });
  });

  el.maxTokens.addEventListener('change', () => {
    transport.send({ t: 'settings.update', patch: { maxRequestTokens: Number(el.maxTokens.value) } });
  });

  el.readLimit.addEventListener('change', () => {
    transport.send({ t: 'settings.update', patch: { readLimit: el.readLimit.value } });
  });

  el.customSave.addEventListener('click', () => {
    transport.send({
      t: 'settings.update',
      patch: {
        custom: {
          baseUrl: el.customUrl.value.trim(),
          model: el.customModel.value.trim(),
          key: el.customKey.value.trim(),
        },
      },
    });
    el.customKey.value = '';
  });

  el.customClear.addEventListener('click', () => {
    transport.send({ t: 'settings.update', patch: { custom: { baseUrl: '', model: '', key: '' } } });
    el.customKey.value = '';
  });

  el.spBackground.addEventListener('change', () => patchStartPage({ background: el.spBackground.value }));
  el.spColor.addEventListener('change', () => patchStartPage({ color: el.spColor.value }));
  el.spAccent.addEventListener('change', () => patchStartPage({ accent: el.spAccent.value }));
  el.spFont.addEventListener('change', () => patchStartPage({ font: el.spFont.value }));
  el.spWidth.addEventListener('change', () => patchStartPage({ width: el.spWidth.value }));

  el.spImage.addEventListener('change', () => {
    const address = el.spImage.value.trim();
    if (!address) return;
    patchStartPage({ image: address, background: 'image' });
    setSpState('Saved that address.');
  });

  el.spPickImage.addEventListener('click', () => el.spUpload.click());
  el.spUpload.addEventListener('change', async () => {
    const file = el.spUpload.files?.[0];
    el.spUpload.value = '';
    if (!file) return;
    if (file.size > 1_500_000) {
      setSpState('That picture is over 1.5 MB. Use a smaller one or an address.');
      return;
    }
    const dataUrl = await readAsDataUrl(file);
    if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(dataUrl)) {
      setSpState('That file is not a PNG, JPEG, WebP or GIF.');
      return;
    }
    patchStartPage({ image: dataUrl, background: 'image' });
    setSpState('Saved. The picture lives in this browser.');
  });

  for (const [element, field] of [
    [el.spClock, 'clock'],
    [el.spGreeting, 'greeting'],
    [el.spDate, 'date'],
  ]) {
    element.addEventListener('click', () => {
      const next = element.getAttribute('aria-checked') !== 'true';
      element.setAttribute('aria-checked', String(next));
      patchStartPage({ [field]: next });
    });
  }

  el.spLinks.addEventListener('input', () => {
    clearTimeout(linksTimer);
    linksTimer = setTimeout(() => patchStartPage({ links: parseLinks(el.spLinks.value) }), 600);
  });

  el.spExport.addEventListener('click', exportTheme);
  el.spImportBtn.addEventListener('click', () => el.spImport.click());
  el.spImport.addEventListener('change', async () => {
    const file = el.spImport.files?.[0];
    el.spImport.value = '';
    if (file) await importTheme(file);
  });

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

  el.perf.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]');
    if (!button) return;
    window.atomPerf?.set(button.dataset.mode);
  });
  document.addEventListener('atomperf', applyPerfMode);
  applyPerfMode();

  el.jump.addEventListener('click', () => {
    state.pinned = true;
    el.stream.scrollTo({ top: el.stream.scrollHeight, behavior: 'smooth' });
    el.jump.classList.remove('is-on');
  });

  el.ctxOff.addEventListener('click', () => {
    transport.send({ t: 'settings.update', patch: { attachTab: false } });
    applyTab(state.tab);
  });

  el.quoteClear.addEventListener('click', () => {
    transport.send({ t: 'quote.clear' });
    applyQuote(null);
    el.input.focus();
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
    case 'edited': {
      const node = state.nodes.get(event.id);
      if (!node) break;
      endEdit(node);
      node.text = event.text;
      paint(node);
      break;
    }
    case 'toolUpdate':
      onToolUpdate(event);
      break;
    case 'meta': {
      const node = state.nodes.get(event.id);
      if (!node) break;
      node.meta = event.meta;
      renderMeta(node);
      break;
    }
    case 'confirm':
      showConfirm(event.request);
      break;
    case 'confirmResolved':
      setTimeout(hideConfirm, 260);
      break;
    case 'task':
      applyTask(event.task);
      break;
    case 'busy':
      if (event.busy) state.busySince = state.busySince || Date.now();
      else {
        state.busySince = 0;
        state.step = 0;
        state.maxSteps = 0;
      }
      setBusy(event.busy);
      break;
    case 'live':
      // The loop says which step it is on; that is the progress there is.
      state.step = Number(event.step) || 0;
      state.maxSteps = Number(event.steps) || state.maxSteps;
      renderLive();
      break;
    case 'reason': {
      const node = state.nodes.get(event.id);
      if (!node) break;
      node.reasoning = event.text || '';
      renderThinking(node);
      break;
    }
    case 'reset': {
      // Another key or model is answering the same step: what the last one sent
      // is gone, so the message starts empty again.
      const node = state.nodes.get(event.id);
      if (!node) break;
      node.text = '';
      node.reasoning = '';
      node.chars = 0;
      node.startedAt = 0;
      voice?.stop();
      if (node.think) node.think.body.textContent = '';
      paint(node);
      break;
    }
    case 'settings':
      // Saving a custom endpoint adds a provider, so the list can change with
      // the settings.
      if (event.meta) state.meta = event.meta;
      if (event.keys) state.keys = event.keys;
      applySettings(event.settings);
      applyKeyStatuses(event.keys);
      break;
    case 'keys':
      applyKeyStatuses(event.keys);
      break;
    case 'capabilities':
      applyCapabilities(event.capabilities);
      break;
    case 'capture':
      state.capture.attached = Boolean(event.attached);
      applyCapture();
      break;
    case 'keycheck':
      applyKeyState(event.state, event.detail);
      break;
    case 'context':
      applyContext(event.context);
      break;
    case 'quote':
      applyQuote(event.quote);
      break;
    case 'chats':
      applyChats(event.chats, event.activeId);
      // A list that is filtered stays filtered: renaming or pinning a chat must
      // not silently drop the search the user typed.
      if (state.search?.query) transport.send({ t: 'chats.search', query: state.search.query });
      break;
    case 'search':
      state.search = { query: event.query || '', chats: event.chats || [] };
      renderHistory();
      break;
    case 'export':
      downloadChat(event);
      break;
    case 'tab':
      applyTab(event.tab);
      if (event.capabilities) applyCapabilities(event.capabilities);
      break;
    case 'session':
      applySession(event.session);
      break;
    case 'notice':
      setStatus(event.text || '', true);
      break;
    case 'transcript':
      // Only the voice module knows which recording this was.
      voice?.onTranscript(event);
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
  state.keys = snapshot.keys || [];
  applySettings(snapshot.settings);
  applyKeyStatuses(state.keys);
  applyTab(snapshot.tab);
  applyCapabilities(snapshot.capabilities);

  el.title.textContent = snapshot.session?.title || 'ATOM';
  applyCapture(snapshot.capture);
  applyContext(snapshot.context);
  applyQuote(snapshot.quote);
  applyChats(snapshot.chats, snapshot.activeChatId);
  applyTask(snapshot.task);
  state.historyLimit = PAGE;
  setBusy(Boolean(snapshot.busy));
  renderMessages(snapshot.session?.messages ?? []);
  syncIntro();
  setStatus('');
  scrollToEnd(true);
  if (snapshot.confirm) showConfirm(snapshot.confirm);

}

/* ---------------------------------------------------------------- settings */

function applyPerfMode() {
  const setting = window.atomPerf?.setting || 'auto';
  const mode = window.atomPerf?.mode || 'quality';

  for (const button of el.perf.querySelectorAll('button[data-mode]')) {
    button.setAttribute('aria-selected', String(button.dataset.mode === setting));
  }

  el.perfState.textContent =
    setting === 'auto'
      ? `Auto — following the system: ${mode}.`
      : mode === 'performance'
        ? 'Performance: motion, blur and live wallpapers are off.'
        : 'Quality: everything on.';
}

function applySettings(settings) {
  if (!settings) return;
  state.settings = settings;
  applyTheme(settings.theme, false);

  if (el.instructions.value !== settings.instructions) el.instructions.value = settings.instructions || '';
  el.attachTab.setAttribute('aria-checked', String(settings.attachTab));
  el.removeKey.hidden = !(settings.keyCounts?.groq > 0);
  updateModelLabel();
  renderModels();
  applyKeyState(settings.hasKey ? (state.keyState === 'none' ? 'unknown' : state.keyState) : 'none');
  renderAutonomy();
  renderGrants();
  renderMemories();
  renderKeys();
  renderProviders(settings);
  renderStartPage(settings);
  renderEndpoint(settings);
  applyVoiceSettings(settings.voice);
  applySearchSettings(settings.search);
  applyAgentSettings(settings.agent);
  updateTurnControls();
  el.rotate.setAttribute('aria-checked', String(settings.rotate !== false));
  el.maxTokens.value = String(settings.maxRequestTokens || 6000);
  applyTab(state.tab);
  refreshSetup();
  refreshAccessAsk();
}

/**
 * Every "don't ask again" the user has given, with a way to take it back. The
 * worker owns the list; this only draws it.
 */
/** The shelf of conversations: open one, delete one, or start a new one. */
/* -------------------------------------------------------------- task card */

function applyTask(task) {
  state.task = task || null;
  if (!task) {
    el.task.hidden = true;
    return;
  }

  el.task.hidden = false;
  el.task.dataset.phase = task.phase || 'running';
  el.taskTitle.textContent =
    task.phase === 'paused'
      ? 'ATOM is paused'
      : task.phase === 'done'
        ? 'Task finished'
        : task.phase === 'stopped'
          ? 'Task stopped'
          : 'ATOM is controlling this tab';
  el.taskTitle.title = task.text || '';
  el.taskPhase.textContent = task.phase || '';

  el.taskPlan.textContent = '';
  for (const step of task.plan || []) {
    const item = document.createElement('li');
    item.textContent = step;
    el.taskPlan.append(item);
  }
  el.taskPlan.hidden = !(task.plan || []).length;

  const current = (task.log || []).at(-1);
  el.taskNow.hidden = !(task.text || current);
  el.taskNow.textContent = current ? `Step ${task.step}: ${current.text}` : task.text || '';

  el.taskLog.textContent = '';
  for (const entry of task.log || []) {
    const row = document.createElement('div');
    row.className = 'task__entry';
    row.dataset.status = entry.status;
    row.textContent = entry.text;
    row.title = entry.status;
    el.taskLog.append(row);
  }

  const finished = task.phase === 'done' || task.phase === 'stopped';
  el.taskPause.hidden = task.phase !== 'running';
  el.taskResume.hidden = task.phase !== 'paused';
  el.taskTakeover.disabled = finished;
  el.taskStop.disabled = finished;
}

function applyAgentSettings(agent) {
  const source = agent || { mode: 'off', stepLimit: 16, trustedSites: [] };
  for (const button of el.agentMode.querySelectorAll('button[data-agent]')) {
    button.setAttribute('aria-selected', String(button.dataset.agent === source.mode));
  }
  el.agentModeNote.textContent = AGENT_MODE_HINTS[source.mode] || '';

  if (![...el.agentSteps.options].some((option) => Number(option.value) === source.stepLimit)) {
    const option = document.createElement('option');
    option.value = String(source.stepLimit);
    option.textContent = `${source.stepLimit} steps`;
    el.agentSteps.append(option);
  }
  el.agentSteps.value = String(source.stepLimit);

  if (document.activeElement !== el.agentTrusted) {
    el.agentTrusted.value = (source.trustedSites || []).join('\n');
  }
}

/* --------------------------------------------------------------- mentions */

function scheduleMentions() {
  clearTimeout(mention.timer);
  mention.timer = setTimeout(() => void refreshMentions(), 60);
}

async function refreshMentions() {
  const before = el.input.value.slice(0, el.input.selectionStart);
  const match = before.match(/(^|\s)@([^\s@]*)$/);
  if (!match) return hideMentions();

  const query = match[2].toLowerCase();
  const tabs = (await chrome.tabs.query({})).filter(
    (tab) => tab.id !== state.tab?.id && /^https?:/i.test(tab.url || ''),
  );
  const items = tabs
    .filter(
      (tab) =>
        !query ||
        String(tab.title || '').toLowerCase().includes(query) ||
        String(tab.url || '').toLowerCase().includes(query),
    )
    .slice(0, 6);

  if (!items.length) return hideMentions();

  mention.items = items;
  mention.index = 0;
  mention.start = el.input.selectionStart - match[2].length - 1;
  renderMentions();
}

function renderMentions() {
  el.mentions.textContent = '';
  el.mentions.hidden = false;
  state.mentionOpen = true;

  mention.items.forEach((tab, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mention';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === mention.index));

    const title = document.createElement('span');
    title.textContent = tab.title || tab.url;
    const host = document.createElement('span');
    host.className = 'mention__host';
    host.textContent = ` — ${hostOf(tab.url)}`;
    button.append(title, host);

    // mousedown, not click: the textarea must not blur before the pick.
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      pickMention(tab);
    });
    el.mentions.append(button);
  });
}

function moveMention(step) {
  if (!mention.items.length) return;
  mention.index = (mention.index + step + mention.items.length) % mention.items.length;
  const buttons = el.mentions.querySelectorAll('.mention');
  buttons.forEach((button, index) => button.setAttribute('aria-selected', String(index === mention.index)));
  buttons[mention.index]?.scrollIntoView({ block: 'nearest' });
}

function pickMention(tab) {
  if (!tab) return hideMentions();
  const title = String(tab.title || hostOf(tab.url)).replace(/\s+/g, ' ').trim();
  const cursor = el.input.selectionStart;
  const head = el.input.value.slice(0, mention.start);
  const tail = el.input.value.slice(cursor);
  el.input.value = `${head}@${title} ${tail.replace(/^\s+/, '')}`;
  const position = head.length + title.length + 2;
  el.input.setSelectionRange(position, position);
  state.mentions.set(tab.id, title);
  hideMentions();
  autosize();
  updateSend();
  el.input.focus();
}

function hideMentions() {
  if (!state.mentionOpen && el.mentions.hidden) return;
  state.mentionOpen = false;
  mention.items = [];
  mention.index = 0;
  el.mentions.hidden = true;
  el.mentions.textContent = '';
}

function hostOf(value) {
  try {
    return new URL(value).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function applyChats(list, activeId) {
  state.chats = Array.isArray(list) ? list : [];
  state.activeChatId = activeId || state.chats[0]?.id || '';
  renderChats();
  renderHistory();
}

function renderChats() {
  el.chats.textContent = '';
  el.chatsEmpty.hidden = state.chats.length > 1;

  for (const chat of state.chats) {
    const row = document.createElement('div');
    row.className = 'chat';
    row.dataset.id = chat.id;
    if (chat.id === state.activeChatId) row.classList.add('is-open');

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'chat__open';
    open.textContent = chat.title || 'New conversation';
    open.addEventListener('click', () => {
      transport.send({ t: 'chat.open', id: chat.id });
      closeSheet();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'chat__x';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Delete ${chat.title || 'this conversation'}`);
    remove.addEventListener('click', () => transport.send({ t: 'chat.delete', id: chat.id }));

    row.append(open, remove);
    el.chats.append(row);
  }
}

/** What ATOM keeps between conversations, and how to forget it. */
function renderMemories() {
  const memories = Array.isArray(state.settings?.memories) ? state.settings.memories : [];
  el.memories.textContent = '';
  el.memoryEmpty.hidden = memories.length > 0;

  for (const memory of memories) {
    const row = document.createElement('div');
    row.className = 'memory';

    const text = document.createElement('span');
    text.className = 'memory__text';
    text.textContent = memory.text;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'memory__x';
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Forget this');
    remove.addEventListener('click', () => transport.send({ t: 'memory.delete', id: memory.id }));

    row.append(text, remove);
    el.memories.append(row);
  }
}

function addMemoryFromInput() {
  const text = el.memoryInput.value.trim();
  if (!text) return;
  transport.send({ t: 'memory.add', text });
  el.memoryInput.value = '';
}

/** Erase is one-way, so the first click only arms the button. */
const ERASE_LABELS = { memories: 'Forget all memories', chats: 'Erase every conversation' };

function eraseArmed(button, what) {
  if (button.dataset.armed !== 'true') {
    button.dataset.armed = 'true';
    button.textContent = 'Click again to erase';
    setTimeout(() => {
      button.dataset.armed = '';
      button.textContent = ERASE_LABELS[what];
    }, 4000);
    return;
  }

  button.dataset.armed = '';
  button.textContent = ERASE_LABELS[what];
  transport.send({ t: 'data.erase', what });
  el.eraseState.textContent = what === 'memories' ? 'Memories erased.' : 'Conversations erased.';
}

function renderGrants() {
  const grants = Array.isArray(state.settings?.actionGrants) ? state.settings.actionGrants : [];
  el.grants.textContent = '';
  el.grantsEmpty.hidden = grants.length > 0;

  for (const grant of grants) {
    const row = document.createElement('div');
    row.className = 'grant';

    const text = document.createElement('span');
    text.className = 'grant__text';
    text.textContent = `${grant.host} — ${GRANT_LABELS[grant.kind] || grant.kind}`;

    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'btn btn--small';
    revoke.textContent = 'Revoke';
    revoke.setAttribute('aria-label', `Revoke ${GRANT_LABELS[grant.kind] || grant.kind} on ${grant.host}`);
    revoke.addEventListener('click', () => transport.send({ t: 'grants.revoke', host: grant.host, kind: grant.kind }));

    row.append(text, revoke);
    el.grants.append(row);
  }
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

  // The wildcard grant sits behind its own click, and says what it gives away.
  const allSites = Boolean(capabilities.allSites);
  el.allSitesBtn.textContent = allSites ? 'Revoke all' : 'Grant all';
  el.allSitesBtn.dataset.state = allSites ? 'on' : 'off';
  el.allSitesNote.textContent = allSites
    ? 'All sites granted — ATOM can read and act anywhere without asking per site. Revoke here any time; the next site asks again.'
    : 'All sites: one prompt, then ATOM can read and act anywhere without asking again. Leave it off if you share this browser.';
}

/**
 * The page digest row: what ATOM read in the browser when the panel opened, and
 * how much of it. The "local" tag is the whole claim — no step, no tokens — so
 * it is shown from what the worker read, never inferred from a setting.
 */
function applyContext(context) {
  if (!context) {
    el.context.hidden = true;
    return;
  }
  const elements = Number(context.elements) || 0;
  el.context.hidden = false;
  el.contextText.textContent = `${context.host || 'this page'} · ${elements} element${elements === 1 ? '' : 's'}`;
  el.context.title =
    'Read in your browser when the panel opened — no model step and no tokens. Full page text is only sent if ATOM asks for it.';
}

/**
 * The selection the user asked about, waiting above the input. The quote is
 * shown so it is obvious what the next message will carry, and it is sent
 * fenced, which is why the panel never needs the page it came from.
 */
function applyQuote(quote) {
  state.quote = quote?.text ? quote : null;
  el.quote.hidden = !state.quote;
  if (!state.quote) return;

  let label = 'Quoted selection';
  try {
    const host = new URL(state.quote.url).host;
    if (host) label = `Quoted from ${host}`;
  } catch {
    /* a selection from a page with no address of its own */
  }

  el.quoteLabel.textContent = label;
  el.quoteText.textContent = state.quote.text;
  el.quoteText.title = state.quote.text;
  el.input.focus();
}

function applyKeyState(keyState, detail) {
  state.keyState = keyState;
  el.keyState.dataset.state = keyState;
  el.keyStateText.textContent =
    { none: 'Not set', unknown: 'Saved', checking: 'Checking…', ok: 'Key works', bad: 'Key rejected' }[keyState] || '';
  el.keyState.title = detail || '';
}

/**
 * The console toggle is per turn: it arms the debugger for the next message,
 * then goes back to off. The warning is not decoration — Brave shows its own
 * banner on the tab for as long as this is attached.
 */
function applyCapture(next) {
  if (next) {
    state.capture.supported = Boolean(next.supported);
    state.capture.attached = Boolean(next.attached);
  }

  const { supported, armed, attached } = state.capture;
  el.capture.disabled = !supported || state.busy;
  el.capture.setAttribute('aria-pressed', String(armed));
  el.capture.dataset.attached = String(attached);
  el.capture.title = supported
    ? 'Capture console errors and failed requests for one turn'
    : 'Console capture only exists inside the extension.';

  el.captureNote.hidden = !supported || !(armed || attached);
  el.captureNote.textContent = attached
    ? 'Attached. Brave shows a debugging banner on the tab until this turn ends.'
    : 'Brave will show a “debugging this browser” banner on the tab while attached. It detaches when the turn ends.';
}

/**
 * The model picker sits in the composer, where the answer is chosen, not three
 * screens away in Settings. The list is the same one Settings draws: every
 * provider that has models, grouped by vendor.
 */
function updateModelLabel() {
  if (!el.modelPick) return;
  const providers = state.meta?.providers || [];
  const selected = `${state.settings?.provider}::${state.settings?.model}`;

  el.modelPick.replaceChildren();
  for (const provider of providers) {
    const group = document.createElement('optgroup');
    group.label = provider.label;
    for (const model of provider.models || []) {
      const option = document.createElement('option');
      option.value = `${provider.id}::${model.id}`;
      option.textContent = model.label;
      group.append(option);
    }
    el.modelPick.append(group);
  }

  if (providers.length) el.modelPick.value = selected;
  const provider = providers.find((entry) => entry.id === state.settings?.provider);
  el.modelPick.title = provider ? `${provider.label} · ${state.settings?.model || ''}` : 'Model';
  // A model change can add or take away the reasoning-effort control.
  updateTurnControls();
}

/**
 * A key field per provider that is not the primary one. Keys are never sent
 * back to the panel — only the count of what is saved — so the field always
 * starts empty and "Save" adds to the pool.
 */
let linksTimer = 0;

function patchStartPage(patch) {
  transport.send({
    t: 'settings.update',
    patch: { startpage: { ...(state.settings?.startpage || {}), ...patch } },
  });
}

function renderStartPage(settings) {
  const theme = settings.startpage;
  el.spBackground.value = theme.background;
  el.spColor.value = theme.color;
  el.spAccent.value = theme.accent;
  el.spFont.value = theme.font;
  el.spWidth.value = theme.width;
  el.spClock.setAttribute('aria-checked', String(theme.clock));
  el.spGreeting.setAttribute('aria-checked', String(theme.greeting));
  el.spDate.setAttribute('aria-checked', String(theme.date));

  // A stored picture is a data URL; it is not worth putting back in the field.
  if (document.activeElement !== el.spImage) {
    el.spImage.value = theme.image.startsWith('data:') ? '' : theme.image;
  }
  el.spImageState.textContent = theme.image ? (theme.image.startsWith('data:') ? 'A picture is saved.' : '') : '';

  if (document.activeElement !== el.spLinks) {
    el.spLinks.value = theme.links.map((link) => `${link.title} | ${link.url}`).join('\n');
  }
}

/** "Title | https://address" per line; anything without an address is dropped. */
function parseLinks(value) {
  return String(value || '')
    .split('\n')
    .map((line) => {
      const [title, url] = line.split('|').map((part) => part.trim());
      return { title: title || '', url: url || '' };
    })
    .filter((link) => /^https?:\/\//i.test(link.url));
}

function setSpState(text) {
  el.spState.textContent = text;
  clearTimeout(setSpState.timer);
  if (text) setSpState.timer = setTimeout(() => (el.spState.textContent = ''), 5000);
}

function exportTheme() {
  const file = {
    app: 'atom',
    kind: 'startpage-theme',
    version: 1,
    startpage: state.settings.startpage,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'atom-startpage-theme.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setSpState('Theme exported.');
}

async function importTheme(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const theme = parsed?.startpage && typeof parsed.startpage === 'object' ? parsed.startpage : parsed;
    if (!theme || typeof theme !== 'object' || Array.isArray(theme)) throw new Error('That file has no theme in it.');
    transport.send({ t: 'settings.update', patch: { startpage: theme } });
    setSpState(`Imported ${file.name}.`);
  } catch (error) {
    setSpState(error?.message || 'That file is not a theme.');
  }
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}

function renderEndpoint(settings) {
  const custom = settings.custom || {};
  if (document.activeElement !== el.customUrl) el.customUrl.value = custom.baseUrl || '';
  if (document.activeElement !== el.customModel) el.customModel.value = custom.model || '';
  el.customState.textContent = custom.baseUrl
    ? `Saved: ${custom.baseUrl.replace(/^https?:\/\//, '')}${custom.model ? ` · ${custom.model}` : ''}`
    : 'No endpoint saved. Ollama and LM Studio work with no key.';
}

let providersSignature = '';

function renderProviders(settings) {
  const list = state.meta?.providers || [];
  const signature = list.map((provider) => provider.id).join('|');
  if (signature !== providersSignature) {
    providersSignature = signature;
    el.provider.textContent = '';
    for (const provider of list) {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.label;
      el.provider.append(option);
    }
  }
  el.provider.value = settings.provider || state.meta?.defaultProvider || 'groq';
}

let keysSignature = '';

/**
 * One line per saved key, in the order rotation takes them. The worker only ever
 * sends the last four digits, so this can never show a whole key.
 */
function renderKeyList(container, providerId) {
  const entries = (state.keys || []).filter((entry) => entry.id === providerId);
  container.textContent = '';
  container.hidden = entries.length === 0;
  if (!entries.length) return;

  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = 'key-item';
    item.dataset.state = entry.state || 'ready';

    const dot = document.createElement('span');
    dot.className = 'key-item__dot';

    const name = document.createElement('span');
    name.className = 'key-item__name';
    name.textContent = `Key ${entry.index + 1}`;

    const hint = document.createElement('span');
    hint.className = 'key-item__hint';
    hint.textContent = entry.hint ? `…${entry.hint}` : '';

    item.append(dot, name, hint);
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      transport.send({ t: 'settings.update', patch: { providerKey: { id: providerId, remove: entry.index } } });
    });

    state.keyRows.set(`${providerId}#${entry.index}`, item);
    container.append(item);
  }
}

function refreshKeyLists() {
  const groq = document.getElementById('groqKeys');
  if (groq) renderKeyList(groq, state.meta?.defaultProvider || 'groq');
  for (const list of el.keys.querySelectorAll('.key-list')) renderKeyList(list, list.dataset.provider || '');
  applyKeyStatuses(state.keys);
}

function renderKeys() {
  const defaultId = state.meta?.defaultProvider || 'groq';
  const providers = (state.meta?.providers || []).filter((provider) => provider.needsKey !== false);
  const signature = providers.map((provider) => `${provider.id}:${state.settings?.keyCounts?.[provider.id] || 0}`).join('|');
  // Re-rendering while a key is half-typed would throw it away.
  if (signature === keysSignature && el.keys.childElementCount) {
    refreshKeyLists();
    return;
  }
  keysSignature = signature;
  state.keyRows = new Map();
  el.keys.textContent = '';

  for (const provider of providers) {
    // The primary provider has its own field above, and that field adds keys.
    if (provider.id === defaultId) continue;

    const count = state.settings?.keyCounts?.[provider.id] || 0;

    const row = document.createElement('div');
    row.className = 'key-row';

    const label = document.createElement('span');
    label.className = 'key-row__label';
    label.textContent = count ? `${provider.label} · ${count} saved` : provider.label;

    const list = document.createElement('div');
    list.className = 'key-list';
    list.dataset.provider = provider.id;

    const input = document.createElement('input');
    input.className = 'input';
    input.type = 'password';
    input.placeholder = count ? 'Add another key…' : 'Paste a key…';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn--small';
    save.textContent = 'Save';
    const commit = () => {
      const key = input.value.trim();
      if (!key) return;
      transport.send({ t: 'settings.update', patch: { providerKey: { id: provider.id, keys: [key] } } });
      input.value = '';
      input.blur();
    };
    save.addEventListener('click', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      commit();
    });

    row.append(label, list, input, save);

    if (count) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'btn btn--small';
      clear.textContent = 'Clear';
      clear.title = `Remove the ${count} saved ${provider.label} key${count > 1 ? 's' : ''}`;
      clear.addEventListener('click', () => {
        transport.send({ t: 'settings.update', patch: { providerKey: { id: provider.id, keys: [] } } });
      });
      row.append(clear);
    }

    el.keys.append(row);
  }

  refreshKeyLists();
}

/** Paint the statuses the worker reports onto the lines that already exist. */
function applyKeyStatuses(list) {
  if (!Array.isArray(list)) return;
  state.keys = list;

  for (const entry of list) {
    const item = state.keyRows.get(`${entry.id}#${entry.index}`);
    if (!item) continue;
    item.dataset.state = entry.state || 'ready';
    const label = {
      busy: 'Serving this request',
      spent: 'Rested after answering',
      cooling: `Out: ${entry.reason || 'limit'}`,
    };
    item.title = `${label[entry.state] || 'Ready'} — right-click to remove`;
  }
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
    note.textContent = [model.note, model.vision ? 'sees images' : ''].filter(Boolean).join(' · ');
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
    meta: message.meta || null,
    reasoning: message.reasoning || '',
    think: null,
    // What the live line needs: characters received, and when they started.
    chars: (message.text || '').length,
    startedAt: 0,
    streaming: message.status === 'streaming',
    dirty: false,
  };

  if (message.role === 'user' && message.quote?.text) {
    const quoted = document.createElement('blockquote');
    quoted.className = 'msg__quote';
    quoted.textContent = message.quote.text;
    if (message.quote.url) quoted.title = message.quote.url;
    root.insertBefore(quoted, body);
  }

  if (message.role === 'user') {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'act';
    edit.textContent = 'Edit';
    edit.title = 'Change this question and ask again. Everything after it is replaced.';
    edit.addEventListener('click', () => beginEdit(node));
    foot.append(edit);
  }

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
    renderMeta(node);
  }

  const sources = document.createElement('div');
  sources.className = 'msg__sources';
  node.sources = Array.isArray(message.sources) ? message.sources : [];
  node.sourcesBox = sources;

  root.append(body, sources, foot);
  el.msgs.append(root);
  state.nodes.set(message.id, node);

  paint(node);
  renderThinking(node);
  renderSources(node);
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

  const oldImages = node.root.querySelector('.tool__images');
  if (oldImages) oldImages.remove();

  // Pictures come from a tool result, never from page text, and only over
  // https — a page cannot talk the transcript into loading a tracking pixel.
  // A screenshot is shown live (preview); a vision screenshot is also kept on
  // the row (image) so it survives a reload.
  const picture = [tool.preview, tool.image].find((value) =>
    /^data:image\/(png|jpe?g|webp);base64,/i.test(String(value || '')),
  );
  const preview = picture || '';
  if (preview) {
    const grid = document.createElement('div');
    grid.className = 'tool__images';
    const image = document.createElement('img');
    image.className = 'tool__preview';
    image.src = preview;
    image.alt = 'Screenshot';
    image.referrerPolicy = 'no-referrer';
    grid.append(image);
    node.root.append(grid);
  }

  const images = (Array.isArray(tool.images) ? tool.images : []).filter((image) => /^https:\/\//.test(String(image?.url || '')));
  if (images.length) {
    const grid = document.createElement('div');
    grid.className = 'tool__images';
    for (const image of images.slice(0, 4)) {
      const link = document.createElement('a');
      link.className = 'tool__image';
      link.href = /^https:\/\//.test(String(image.page || '')) ? image.page : image.url;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.title = [image.title, image.creator, image.license].filter(Boolean).join(' · ');
      const img = document.createElement('img');
      img.src = image.url;
      img.alt = image.title || 'Picture';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      link.append(img);
      grid.append(link);
    }
    node.root.append(grid);
  }

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
  node.startedAt ||= Date.now();
  node.chars += event.text.length;
  schedulePaint(node);
  // Speaking starts on the first whole sentence, not at the end of the answer.
  voice?.feed(event.id, node.text);
}

function onDone(event) {
  const node = state.nodes.get(event.id);
  if (!node) return;
  node.streaming = false;
  if (Array.isArray(event.sources)) {
    node.sources = event.sources;
    renderSources(node);
  }
  if (typeof event.text === 'string') node.text = event.text;
  node.root.classList.remove('is-streaming');
  node.root.classList.toggle('msg--ghost', !node.text.trim() && (event.toolCalls || 0) > 0);
  paint(node);
  voice?.finish(event.id, node.text);
  if (node.think) {
    node.think.summary.textContent = 'Thinking';
    // The answer is what was asked for; the reasoning stays one click away.
    if (node.text.trim()) node.think.details.open = false;
  }
  scrollToEnd();
  markLastAnswer();
}

/**
 * "Retry" belongs to the newest answer only: it asks the same question again
 * and replaces that answer. Older answers keep Copy and nothing else.
 */
function markLastAnswer() {
  for (const node of state.nodes.values()) {
    if (node.role === 'assistant') node.foot.querySelector('[data-regen]')?.remove();
  }

  const last = [...state.nodes.values()]
    .filter((node) => node.role === 'assistant' && !node.streaming && node.text.trim())
    .at(-1);
  if (!last) return;

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'act';
  retry.dataset.regen = 'true';
  retry.textContent = 'Retry';
  retry.title = 'Ask the same question again and replace this answer';
  retry.addEventListener('click', () => transport.send({ t: 'chat.regenerate' }));
  last.foot.append(retry);
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
  voice?.stop();
  hideConfirm(true);
  el.msgs.replaceChildren();
  state.nodes.clear();
  syncIntro();
}

/**
 * A conversation was opened, created or deleted: the worker sends the whole
 * session, and the panel draws it from nothing. No incremental patching — a
 * chat that was not on screen a moment ago has no nodes to patch.
 */
function applySession(session) {
  el.title.textContent = session?.title || 'ATOM';
  state.historyLimit = PAGE;
  renderMessages(session?.messages || []);
  setBusy(false);
  markLastAnswer();
  syncIntro();
  scrollToEnd(true);
  el.input.focus();
}

/**
 * "3 steps · ~4.2k tokens" under the answer that ended the turn. The tilde is
 * honest: the worker estimates from characters, it does not read a usage field.
 */
function renderMeta(node) {
  const existing = node.root.querySelector('.msg__meta');
  if (!node.meta) {
    if (existing) existing.remove();
    return;
  }
  const meta = existing || document.createElement('span');
  meta.className = 'msg__meta';
  const steps = Number(node.meta.steps) || 0;
  const tokens = Number(node.meta.tokens) || 0;
  const shown = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  const ms = Number(node.meta.ms) || 0;
  const took = ms >= 1000 ? ` · ${Math.round(ms / 1000)}s` : '';
  meta.textContent = `${steps} step${steps === 1 ? '' : 's'} · ~${shown} tokens${took}`;
  meta.title =
    `This turn sent ${tokens} tokens to the model (estimated from ~4 characters per token) over ${steps} step${steps === 1 ? '' : 's'}` +
    (ms ? `, in ${(ms / 1000).toFixed(1)}s of wall time (tool calls and retries included).` : '.') +
    ' Free tiers count tokens per minute; fewer, smaller turns stay under it.';
  if (!existing) node.foot.prepend(meta);
}

/**
 * The line under the composer while a turn runs: how long it has been going,
 * which step of the loop it is on, and how fast the answer is arriving. No ETA:
 * nobody can know how long a model will take, and a made-up number is worse
 * than a clock that tells the truth.
 */
function renderLive() {
  if (!state.busy) return;

  const seconds = Math.max(0, Math.round((Date.now() - (state.busySince || Date.now())) / 1000));
  const bits = [];
  if (state.step) bits.push(`step ${state.step}${state.maxSteps ? ` of ${state.maxSteps}` : ''}`);
  bits.push(`${seconds}s`);

  const streaming = [...state.nodes.values()]
    .reverse()
    .find((node) => node.role === 'assistant' && node.streaming);

  if (streaming?.startedAt) {
    const elapsed = Math.max(0.5, (Date.now() - streaming.startedAt) / 1000);
    const tokens = streaming.chars / 4;
    bits.push(`~${Math.round(tokens / elapsed)} tok/s`);
    bits.push(`${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : Math.round(tokens)} tokens`);
  } else if (state.step) {
    bits.push('working');
  }

  el.live.hidden = false;
  el.live.textContent = bits.join(' · ');
}

/**
 * Reasoning streamed by the provider, in a block above the answer. It appears
 * only when the vendor actually sends thinking; nothing here is written by
 * ATOM, and a model that hides its reasoning shows no block at all.
 */
function renderThinking(node) {
  if (node.role !== 'assistant' || !node.reasoning) return;

  if (!node.think) {
    const details = document.createElement('details');
    details.className = 'think';
    // Collapsed by default: the reasoning is there to check, not to read first.
    details.open = false;

    const summary = document.createElement('summary');
    summary.className = 'think__summary';

    const body = document.createElement('div');
    body.className = 'think__body';

    details.append(summary, body);
    node.root.insertBefore(details, node.body);
    node.think = { details, summary, body };
  }

  node.think.summary.textContent = node.streaming ? 'Thinking…' : 'Thought process';
  node.think.body.textContent = node.reasoning;
  if (state.pinned) scrollToEnd();
}

/**
 * Editing a question in place. It is a real edit, not an annotation: saving
 * replaces the question and everything the old wording produced, so the note
 * under the box says so instead of surprising anyone after the fact.
 */
function beginEdit(node) {
  if (state.busy || node.role !== 'user' || node.editor) return;

  const box = document.createElement('div');
  box.className = 'edit';

  const input = document.createElement('textarea');
  input.className = 'edit__input';
  input.value = node.text;

  const row = document.createElement('div');
  row.className = 'edit__row';

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn btn--primary btn--small';
  save.textContent = 'Save & resend';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn--small';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => endEdit(node));

  const note = document.createElement('p');
  note.className = 'edit__note';
  note.textContent = 'Saving replaces this question and everything after it.';

  const commit = () => {
    const text = input.value.trim();
    if (!text || text === node.text) {
      endEdit(node);
      return;
    }
    save.disabled = true;
    transport.send({ t: 'chat.edit', id: node.id, text });
  };

  save.addEventListener('click', commit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commit();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      endEdit(node);
    }
  });

  row.append(save, cancel);
  box.append(input, row, note);
  node.root.append(box);
  node.body.hidden = true;
  node.editor = { box, input, save };

  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function endEdit(node) {
  if (!node.editor) return;
  node.editor.box.remove();
  node.editor = null;
  node.body.hidden = false;
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
  card.append(title, meta);

  // The offer to stop asking exists only when the worker says this action may
  // be remembered: never for submitting, a secret field, or leaving the site.
  if (request.grant) {
    const grant = document.createElement('label');
    grant.className = 'confirm__grant';
    const box = document.createElement('input');
    box.type = 'checkbox';
    const text = document.createElement('span');
    text.textContent = `Don't ask again for ${request.grant.label} on ${request.grant.host}`;
    grant.append(box, text);
    card.append(grant);
  }

  card.append(actions);

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
  const remember = Boolean(card?.querySelector('.confirm__grant input')?.checked);
  transport.send({ t: 'confirm.respond', id, allow, remember });
}

function hideConfirm(immediate = false) {
  const node = state.confirmNode;
  if (!node) return;
  state.confirmNode = null;
  if (immediate) {
    node.remove();
    return;
  }
  node.style.transition = 'opacity var(--dur-2) var(--ease), transform var(--dur-2) var(--ease)';
  node.style.opacity = '0';
  node.style.transform = 'translateY(-4px)';
  // --dur-2, in milliseconds.
  setTimeout(() => node.remove(), 220);
}

/* ----------------------------------------------------------------- history */

/**
 * The drawer, the grouped list, and the right-click menu. The worker owns the
 * conversations; this draws them and sends intents. A side panel is narrow, so
 * the history slides over the transcript instead of stealing a column from it.
 */
function bindHistory() {
  el.historyToggle.addEventListener('click', () =>
    el.side.classList.contains('is-open') ? closeHistory() : openHistory(),
  );
  el.sideClose.addEventListener('click', closeHistory);
  el.sideScrim.addEventListener('click', closeHistory);
  el.sideNew.addEventListener('click', () => {
    transport.send({ t: 'chat.new' });
    closeHistory();
  });

  // Searching reads every transcript in the worker, so it is debounced: typing
  // four letters is one search, not four.
  let timer = 0;
  el.sideSearch.addEventListener('input', () => {
    clearTimeout(timer);
    const query = el.sideSearch.value.trim();
    if (!query) {
      state.search = null;
      renderHistory();
      return;
    }
    timer = setTimeout(() => transport.send({ t: 'chats.search', query }), 200);
  });

  el.sideExport.addEventListener('click', () => {
    if (!state.activeChatId) return;
    transport.send({ t: 'chat.export', id: state.activeChatId });
  });

  el.sideImportBtn.addEventListener('click', () => el.sideImport.click());
  el.sideImport.addEventListener('change', async () => {
    const file = el.sideImport.files?.[0];
    el.sideImport.value = '';
    if (!file) return;
    if (file.size > 2_000_000) {
      setStatus('That file is too big to be a conversation.');
      return;
    }
    transport.send({ t: 'chat.import', json: await file.text() });
    closeHistory();
  });

  el.modelPick.addEventListener('change', () => {
    const [provider, ...rest] = el.modelPick.value.split('::');
    const model = rest.join('::');
    if (!provider || !model) return;
    transport.send({ t: 'settings.update', patch: { provider, model } });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!el.menu.hidden) {
      closeMenu();
      event.stopPropagation();
      return;
    }
    if (el.side.classList.contains('is-open')) closeHistory();
  });

  document.addEventListener('click', (event) => {
    if (!el.menu.hidden && !el.menu.contains(event.target)) closeMenu();
  });
  window.addEventListener('resize', closeMenu);
  el.sideList.addEventListener('scroll', closeMenu, { passive: true });
}

function openHistory() {
  el.side.classList.add('is-open');
  el.side.setAttribute('aria-hidden', 'false');
  el.historyToggle.setAttribute('aria-expanded', 'true');
  el.sideScrim.hidden = false;
  requestAnimationFrame(() => el.sideScrim.classList.add('is-open'));
  el.sideSearch.focus({ preventScroll: true });
}

function closeHistory() {
  el.side.classList.remove('is-open');
  el.side.setAttribute('aria-hidden', 'true');
  el.historyToggle.setAttribute('aria-expanded', 'false');
  el.sideScrim.classList.remove('is-open');
  setTimeout(() => {
    if (!el.side.classList.contains('is-open')) el.sideScrim.hidden = true;
  }, 240);
  closeMenu();
}

function renderHistory() {
  if (!el.sideList) return;
  const searching = Boolean(state.search?.query);
  const list = Array.isArray(searching ? state.search.chats : state.chats) ? (searching ? state.search.chats : state.chats) : [];

  el.sideList.replaceChildren();
  el.sideEmpty.hidden = list.length > 0;
  el.sideEmpty.textContent = searching ? 'Nothing matches that search.' : 'No conversations yet.';

  const groups = searching ? [{ label: 'Results', items: list }] : groupChats(list);

  for (const group of groups) {
    const heading = document.createElement('p');
    heading.className = 'side__group';
    heading.textContent = group.label;
    el.sideList.append(heading);
    for (const chat of group.items) el.sideList.append(historyRow(chat));
  }
}

function historyRow(chat) {
  const row = document.createElement('div');
  row.className = 'side__chat';
  row.dataset.id = chat.id;
  row.setAttribute('role', 'listitem');
  if (chat.id === state.activeChatId) row.classList.add('is-open');

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'side__open';

  const name = document.createElement('span');
  name.className = 'side__name';
  name.textContent = chat.title || 'New conversation';
  open.append(name);

  if (chat.snippet) {
    const snippet = document.createElement('span');
    snippet.className = 'side__snippet';
    snippet.textContent = chat.snippet;
    open.append(snippet);
  }

  open.addEventListener('click', () => {
    transport.send({ t: 'chat.open', id: chat.id });
    closeHistory();
  });

  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = 'side__pin';
  pin.setAttribute('aria-pressed', String(chat.pinned === true));
  pin.setAttribute('aria-label', chat.pinned ? 'Unpin this conversation' : 'Pin this conversation');
  pin.title = chat.pinned ? 'Unpin' : 'Pin';
  pin.append(useIcon('i-pin'));
  pin.addEventListener('click', (event) => {
    event.stopPropagation();
    transport.send({ t: 'chat.pin', id: chat.id, pinned: !chat.pinned });
  });

  row.append(open, pin);
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openChatMenu(event.clientX, event.clientY, chat, name);
  });

  return row;
}

function openChatMenu(x, y, chat, nameNode) {
  openMenu(x, y, [
    {
      label: chat.pinned ? 'Unpin from top' : 'Pin to top',
      run: () => transport.send({ t: 'chat.pin', id: chat.id, pinned: !chat.pinned }),
    },
    { label: 'Rename', run: () => beginRename(chat, nameNode) },
    { label: 'Export as JSON', run: () => transport.send({ t: 'chat.export', id: chat.id }) },
    { label: 'Delete', danger: true, run: () => transport.send({ t: 'chat.delete', id: chat.id }) },
  ]);
}

/** Rename happens where the name is, not in a modal. Enter keeps, Escape drops. */
function beginRename(chat, nameNode) {
  const input = document.createElement('input');
  input.className = 'side__rename';
  input.value = chat.title || '';
  input.setAttribute('aria-label', 'Conversation name');
  nameNode.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save && value) transport.send({ t: 'chat.rename', id: chat.id, title: value });
    renderHistory();
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

function openMenu(x, y, items) {
  el.menu.replaceChildren();
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu__item';
    button.setAttribute('role', 'menuitem');
    if (item.danger) button.classList.add('is-danger');
    button.textContent = item.label;
    button.addEventListener('click', () => {
      closeMenu();
      item.run();
    });
    el.menu.append(button);
  }

  el.menu.hidden = false;
  const box = el.menu.getBoundingClientRect();
  el.menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - box.width - 6))}px`;
  el.menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - box.height - 6))}px`;
}

function closeMenu() {
  if (el.menu) el.menu.hidden = true;
}

function useIcon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function downloadChat(event) {
  const chat = state.chats.find((entry) => entry.id === event.id);
  const blob = new Blob([event.json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${fileSlug(chat?.title)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus('Conversation exported as JSON.');
}

function fileSlug(title) {
  return (
    String(title || 'atom-chat')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 48) || 'atom-chat'
  );
}

/**
 * A long conversation keeps the newest page on screen. Older messages are a
 * click away, and the DOM never holds hundreds of answers at once.
 */
function renderMessages(messages) {
  clearMessages();
  const { messages: shown, hidden } = windowMessages(messages, state.historyLimit);

  if (hidden) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'earlier';
    more.textContent = `Show ${hidden} earlier message${hidden === 1 ? '' : 's'}`;
    more.addEventListener('click', () => {
      state.historyLimit = nextLimit(state.historyLimit);
      renderMessages(messages);
    });
    el.msgs.append(more);
  }

  for (const message of shown) addMessage(message, null, { fromState: true });
  syncIntro();
}

/* ------------------------------------------------------------ turn controls */

const THINK_TOKENS = { low: 400, medium: 900, high: 1800 };

/**
 * Two per-message switches live in the composer, because that is where the
 * question is written. Everything they change is reset when it is sent.
 */
function bindTurnControls() {
  el.deepThink.addEventListener('click', () => {
    state.turn.think = !state.turn.think;
    updateTurnControls();
  });

  el.webSearch.addEventListener('click', () => {
    state.turn.web = !state.turn.web;
    updateTurnControls();
  });

  el.effort.addEventListener('change', () => {
    state.turn.effort = el.effort.value;
    updateTurnControls();
  });

  el.searchProvider.addEventListener('change', () => patchSearch({ provider: el.searchProvider.value }));
  el.searchBudget.addEventListener('change', () => patchSearch({ budget: Number(el.searchBudget.value) }));
  el.searchAuto.addEventListener('click', () => patchSearch({ auto: state.settings?.search?.auto !== true }));

  el.searchSave.addEventListener('click', () => {
    const patch = {
      provider: el.searchProvider.value,
      endpoint: el.searchEndpoint.value.trim(),
      budget: Number(el.searchBudget.value),
    };
    if (el.searchKey.value.trim()) patch.key = el.searchKey.value.trim();
    patchSearch(patch);
    el.searchKey.value = '';
  });
}

function patchSearch(patch) {
  const current = state.settings?.search || {};
  transport.send({ t: 'settings.update', patch: { search: { ...current, ...patch } } });
}

function modelReasoning() {
  const provider = state.meta?.providers?.find((entry) => entry.id === state.settings?.provider);
  return provider?.models?.find((entry) => entry.id === state.settings?.model)?.reasoning === true;
}

function updateTurnControls() {
  if (!el.deepThink) return;
  const reasoning = modelReasoning();

  el.deepThink.setAttribute('aria-pressed', String(state.turn.think));
  el.webSearch.setAttribute('aria-pressed', String(state.turn.web));
  el.effort.hidden = !state.turn.think || !reasoning;
  el.effort.value = state.turn.effort;

  const bits = [];
  if (state.turn.think) {
    bits.push(reasoning ? `${state.turn.effort} effort` : 'plan · answer · self-check');
    bits.push(`~${tokens(THINK_TOKENS[state.turn.effort] || 900)} thinking tokens`);
  }
  if (state.turn.web) bits.push(`up to ~${tokens(state.settings?.search?.budget || 1200)} of page text`);

  el.costHint.hidden = bits.length === 0;
  el.costHint.textContent = bits.length ? `This message: ${bits.join(' · ')}` : '';
}

function tokens(value) {
  const count = Number(value) || 0;
  return count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(count);
}

function applySearchSettings(search) {
  if (!search) return;
  el.searchProvider.value = search.provider || 'duckduckgo';
  el.searchEndpoint.value = search.endpoint || '';
  el.searchBudget.value = String(search.budget || 1200);
  el.searchAuto.setAttribute('aria-checked', String(search.auto === true));
  el.searchState.textContent = search.hasKey
    ? 'Key saved.'
    : search.provider === 'brave'
      ? 'No key saved — Brave needs one.'
      : search.provider === 'serper'
        ? 'No key saved — Serper needs one.'
        : search.provider === 'searx'
          ? 'An instance address is enough; a token is optional.'
          : 'No key needed.';
}

/** Small clickable citations under the answer: host name, full title on hover. */
function renderSources(node) {
  if (!node?.sourcesBox) return;
  node.sourcesBox.replaceChildren();
  const list = (node.sources || []).filter((source) => /^https?:\/\//i.test(String(source?.url || '')));
  if (!list.length) return;

  const label = document.createElement('span');
  label.className = 'sources__label';
  label.textContent = 'Sources';
  node.sourcesBox.append(label);

  for (const source of list.slice(0, 6)) {
    const chip = document.createElement('a');
    chip.className = 'source';
    chip.href = source.url;
    chip.target = '_blank';
    chip.rel = 'noopener noreferrer';
    chip.textContent = sourceHost(source.url);
    chip.title = [source.title, source.url].filter(Boolean).join('\n');
    node.sourcesBox.append(chip);
  }
}

function sourceHost(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return 'source';
  }
}

/* ------------------------------------------------------------------- voice */

// Null until the first press of the mic, or the first time speaking is turned
// on: the module is an import, so a browser without speech support and a user
// who never asks for voice never load a line of it.
let voice = null;
let voiceLoading = null;

const LISTENING_LINE = 'Listening…';

function ensureVoice() {
  if (voice) return Promise.resolve(voice);
  if (voiceLoading) return voiceLoading;

  voiceLoading = import('./voice.js')
    .then(({ createVoice }) => {
      voice = createVoice({
        send: (message) => transport.send(message),
        status: (text, sticky) => setStatus(text, sticky),
        input: el.input,
        mic: el.mic,
        getVoice: () => state.settings?.voice || {},
        sendText: sendSpoken,
        isBusy: () => state.busy,
        onListening: applyListening,
        onSpeaking: applySpeaking,
      });
      voice.setSettings(state.settings?.voice || {});
      renderVoiceCatalog(state.settings?.voice?.voiceURI || '');
      return voice;
    })
    .catch((error) => {
      console.warn('[atom] voice module did not load', error);
      setStatus('Voice is not available in this browser.');
      voiceLoading = null;
      return null;
    });

  return voiceLoading;
}

/** Hold to talk, tap to keep listening, tap again to stop. */
function bindVoice() {
  let pressedAt = 0;

  el.mic.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    pressedAt = Date.now();
    // The import may take a moment; the press is remembered by the module.
    void ensureVoice().then((module) => module?.press());
  });

  const up = () => {
    if (!pressedAt) return;
    const held = Date.now() - pressedAt;
    pressedAt = 0;
    if (held > 320) voice?.release();
  };

  el.mic.addEventListener('pointerup', up);
  window.addEventListener('pointerup', up);

  // Keyboard activation arrives as a click with no pointer detail.
  el.mic.addEventListener('click', (event) => {
    if (event.detail !== 0) return;
    void ensureVoice().then((module) => module?.toggle());
  });

  const toggleSpeaking = () => {
    void ensureVoice();
    patchVoice({ enabled: !(state.settings?.voice?.enabled === true) });
  };

  el.speak.addEventListener('click', toggleSpeaking);
  el.vSpeak.addEventListener('click', toggleSpeaking);

  el.vHandsFree.addEventListener('click', () => {
    if (state.settings?.voice?.handsFree !== true) void ensureVoice();
    // Hands-free is meaningless with the voice off; turning it on turns it on.
    if (state.settings?.voice?.handsFree !== true && state.settings?.voice?.enabled !== true) {
      patchVoice({ handsFree: true, enabled: true });
      return;
    }
    patchVoice({ handsFree: state.settings?.voice?.handsFree !== true });
  });

  el.vVoice.addEventListener('change', () => patchVoice({ voiceURI: el.vVoice.value }));

  // The label follows the slider; only the release is saved, so a drag is one
  // write instead of thirty.
  el.vRate.addEventListener('input', () => {
    el.vRateValue.textContent = `${Number(el.vRate.value).toFixed(2)}×`;
  });
  el.vRate.addEventListener('change', () => patchVoice({ rate: Number(el.vRate.value) }));

  el.vVolume.addEventListener('input', () => {
    el.vVolumeValue.textContent = `${Math.round(Number(el.vVolume.value) * 100)}%`;
  });
  el.vVolume.addEventListener('change', () => patchVoice({ volume: Number(el.vVolume.value) }));

  el.vProvider.addEventListener('change', () => {
    if (el.vProvider.value === 'http') void ensureVoice();
    patchVoice({ provider: el.vProvider.value });
  });

  el.vSaveEndpoint.addEventListener('click', () => {
    void ensureVoice();
    const patch = { endpoint: el.vEndpoint.value.trim() };
    // An empty field means "leave the saved token alone"; it is never echoed.
    if (el.vVoiceKey.value.trim()) patch.key = el.vVoiceKey.value.trim();
    patchVoice(patch);
    el.vVoiceKey.value = '';
  });

  el.vTest.addEventListener('click', () => {
    void ensureVoice().then((module) => module?.speakSample());
  });

  el.vStt.addEventListener('change', () => patchVoice({ stt: el.vStt.value }));

  if ('speechSynthesis' in window) {
    window.speechSynthesis.addEventListener?.('voiceschanged', () => {
      if (voice) renderVoiceCatalog(state.settings?.voice?.voiceURI || '');
    });
  }
}

/** A transcript, or a hands-free sentence, goes out through the composer. */
function sendSpoken(text) {
  if (state.busy) {
    setStatus('Still working on the last one — say it again once this finishes.');
    return;
  }
  el.input.value = text;
  autosize();
  updateSend();
  submit();
}

function patchVoice(patch) {
  const current = state.settings?.voice || {};
  transport.send({ t: 'settings.update', patch: { voice: { ...current, ...patch } } });
}

function applyVoiceSettings(next) {
  if (!next) return;
  const enabled = next.enabled === true;

  el.speak.setAttribute('aria-pressed', String(enabled));
  el.vSpeak.setAttribute('aria-checked', String(enabled));
  el.vHandsFree.setAttribute('aria-checked', String(next.handsFree === true));
  el.vProvider.value = next.provider === 'http' ? 'http' : 'browser';
  el.vEndpoint.value = next.endpoint || '';
  el.vStt.value = ['auto', 'browser', 'whisper'].includes(next.stt) ? next.stt : 'auto';
  el.vRate.value = String(next.rate ?? 1);
  el.vRateValue.textContent = `${Number(next.rate ?? 1).toFixed(2)}×`;
  el.vVolume.value = String(next.volume ?? 1);
  el.vVolumeValue.textContent = `${Math.round(Number(next.volume ?? 1) * 100)}%`;
  el.voiceState.dataset.state = enabled ? 'on' : 'none';
  el.voiceStateText.textContent = enabled
    ? next.provider === 'http'
      ? 'On · custom voice'
      : 'On · browser voice'
    : 'Off';
  el.vSttNote.textContent =
    next.stt === 'whisper'
      ? 'Every recording is uploaded to the Whisper endpoint with the Groq key, and nothing is kept.'
      : next.stt === 'browser'
        ? 'Recognition stays in the browser; nothing is uploaded.'
        : 'The browser’s recognition when it exists (nothing uploaded), otherwise the recording goes to Whisper.';

  renderVoiceCatalog(next.voiceURI || '');
  voice?.setSettings(next);
  if (enabled) void ensureVoice();
}

function renderVoiceCatalog(selected) {
  if (!el.vVoice) return;
  const add = (value, label) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    el.vVoice.append(option);
  };

  const entries = voice?.listVoices?.() || [];
  // A settings broadcast arrives for every change; rebuilding the list would
  // close the picker under the user's finger. Only rebuild when it differs.
  const signature = `${selected}|${entries.map((entry) => `${entry.uri}:${entry.name}`).join(',')}`;
  if (el.vVoice.dataset.sig === signature) return;
  el.vVoice.dataset.sig = signature;

  el.vVoice.replaceChildren();
  add('', 'Browser default');
  for (const entry of entries) add(entry.uri, `${entry.name} · ${entry.lang}`);
  el.vVoice.value = selected || '';
}

function applyListening(listening) {
  el.mic.setAttribute('aria-pressed', String(Boolean(listening)));
  el.mic.classList.toggle('is-listening', Boolean(listening));
  if (listening) setStatus(LISTENING_LINE, true);
  else if (el.status.textContent === LISTENING_LINE) setStatus('');
}

function applySpeaking(speaking) {
  el.speak.dataset.speaking = speaking ? 'true' : 'false';
}

/* ---------------------------------------------------------------- composer */

function submit() {
  if (state.busy) {
    transport.send({ t: 'chat.stop' });
    return;
  }
  const text = el.input.value.trim();
  if (!text) return;
  // Typing and sending is a barge-in too: nothing keeps talking over you.
  voice?.stop();

  const armed = state.capture.armed;
  const quote = state.quote;
  el.input.value = '';
  localStorage.removeItem('atom.draft');
  autosize();
  updateSend();
  const deepThink = state.turn.think ? { effort: state.turn.effort } : null;
  const search = state.turn.web;
  // Only a mention still in the text travels: deleting it before sending is a
  // clear enough "not this tab".
  const mentions = [...state.mentions.entries()]
    .filter(([, title]) => text.includes(`@${title}`))
    .map(([id]) => id);
  hideMentions();
  state.mentions.clear();

  transport.send({
    t: 'chat.send',
    text,
    capture: armed,
    ...(quote ? { quote } : {}),
    ...(deepThink ? { deepThink } : {}),
    ...(mentions.length ? { mentions } : {}),
    search,
  });
  if (quote) applyQuote(null);

  // The toggles are for the message just sent, not for every message after it.
  state.turn.think = false;
  state.turn.web = false;
  updateTurnControls();

  if (armed) {
    // Opt-in per turn: the toggle does not stay on for the next message.
    state.capture.armed = false;
    applyCapture();
  }
}

function setBusy(busy) {
  state.busy = Boolean(busy);

  // One ticker for the whole turn: elapsed time, the step, and the rate the
  // answer is arriving at. There is no honest ETA, so none is shown.
  clearInterval(state.tick);
  state.tick = 0;
  if (state.busy) {
    if (!state.busySince) state.busySince = Date.now();
    state.tick = setInterval(renderLive, 400);
    renderLive();
  } else {
    el.live.hidden = true;
    el.live.textContent = '';
  }
  applyCapture();
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
  // Adding to the pool rather than replacing it: a second key is how rotation
  // outlives one account's minute.
  transport.send({ t: 'settings.update', patch: { providerKey: { id: 'groq', keys: [key] } } });
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

/*
 * Chrome only shows the permission prompt while the click's user activation is
 * live, and the first await in a handler spends it. Everything below therefore
 * stays synchronous until chrome.permissions.request itself is called: the
 * origin lookup, the guard and the call happen in the click's own call stack,
 * and only the result is handled asynchronously.
 */

function togglePageAccess() {
  const origin = state.capabilities?.origin;
  if (!origin || !permissionsAvailable()) return;

  if (state.capabilities.pageAccess) {
    revokePageAccess(origin);
    return;
  }

  requestPageAccess(origin);
}

function requestPageAccess(origin, onGranted) {
  if (!origin || !permissionsAvailable()) return;

  let pending;
  try {
    pending = chrome.permissions.request({ origins: [origin] });
  } catch (error) {
    setStatus(error?.message || "That didn't work.");
    return;
  }

  Promise.resolve(pending).then(
    (granted) => {
      transport.send({ t: 'capabilities.refresh' });
      if (!granted) {
        setStatus('Access was not granted.');
        return;
      }
      onGranted?.();
    },
    (error) => setStatus(error?.message || "That didn't work."),
  );
}

const ALL_SITES = '*://*/*';

function toggleAllSites() {
  if (!permissionsAvailable()) return;
  const allSites = Boolean(state.capabilities?.allSites);

  let pending;
  try {
    pending = allSites
      ? chrome.permissions.remove({ origins: [ALL_SITES] })
      : chrome.permissions.request({ origins: [ALL_SITES] });
  } catch (error) {
    setStatus(error?.message || "That didn't work.");
    return;
  }

  Promise.resolve(pending).then(
    (done) => {
      transport.send({ t: 'capabilities.refresh' });
      if (!done) {
        setStatus(allSites ? "Couldn't revoke that." : 'Access to all sites was not granted.');
        return;
      }
      setStatus(allSites ? 'All-sites access revoked.' : 'Granted for every site. Revoke it here whenever you like.');
    },
    (error) => setStatus(error?.message || "That didn't work."),
  );
}

/* ------------------------------------------------------------ first-run ask */

/**
 * The per-site prompt is the first wall anyone hits, so it gets one clear
 * offer on the welcome screen — after a key exists, before the first message —
 * and then never again. Answering is what stops it: not granting. A browser
 * refusal, or revoking the grant later, must not bring the card back.
 */
function refreshAccessAsk() {
  if (!state.settings) {
    el.accessAsk.hidden = true;
    return;
  }
  el.accessAsk.hidden = !state.settings.hasKey || state.settings.accessChoice !== '';
}

function answerAccess(accessChoice) {
  state.settings = { ...state.settings, accessChoice };
  el.accessAsk.hidden = true;
  transport.send({ t: 'settings.update', patch: { accessChoice } });
}

function allowAllFromAsk() {
  // Recording the answer first is what makes a refusal harmless: the card is
  // gone either way. The permission call still happens in this same click, with
  // no await in front of it, or the browser will not show the prompt.
  answerAccess('allow-all');
  if (!permissionsAvailable()) return;

  let pending;
  try {
    pending = chrome.permissions.request({ origins: [ALL_SITES] });
  } catch {
    pending = Promise.reject(new Error('refused'));
  }

  pending.then(
    (granted) => {
      transport.send({ t: 'capabilities.refresh' });
      setStatus(granted ? 'Allowed on every site — revoke it in Settings.' : 'The browser declined. ATOM will ask per site.');
    },
    () => setStatus('The browser declined. ATOM will ask per site.'),
  );
}

function revokePageAccess(origin) {
  let pending;
  try {
    pending = chrome.permissions.remove({ origins: [origin] });
  } catch (error) {
    setStatus(error?.message || "Couldn't revoke that.");
    return;
  }

  Promise.resolve(pending).then(
    () => {
      setStatus('Page access revoked for this site.');
      transport.send({ t: 'capabilities.refresh' });
    },
    (error) => setStatus(error?.message || "Couldn't revoke that."),
  );
}

function grantFromTool(node) {
  requestPageAccess(node.tool?.origin, () => transport.send({ t: 'chat.retry' }));
}

function permissionsAvailable() {
  if (typeof chrome === 'undefined' || !chrome.permissions) {
    setStatus('Page access only exists inside the extension.');
    return false;
  }
  return true;
}
