import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_STEPS } from '../extension/lib/agent/loop.js';
import { LEGACY_KEY } from '../extension/lib/chats.js';

/**
 * The service worker has the most branching in the extension, so it is driven
 * here the way the side panel drives it: imported for real — all of `lib/` with
 * it — against a fake `chrome` and a fake provider, over the `atom` port.
 *
 * Each test gets a fresh worker instance (`?case=N` on the import URL), so the
 * worker's module-level session and port set never leak between cases. The
 * library modules are cached and stateless, which is exactly how they are used.
 *
 * The fake chrome is deliberately small: it answers what the worker asks for at
 * load and during these turns. Only the cases that need a page are given one —
 * to act on, or to read — and everywhere else a touch of the page throws, and is
 * counted, so a stray action cannot pass quietly. Two tabs exist so a turn can
 * start on a different page than the one before it.
 */

/* ------------------------------------------------------------- fake chrome */

/** A chrome event. Only `onConnect` is ever dispatched in these tests. */
function event() {
  let listener = null;
  return {
    addListener: (fn) => (listener = fn),
    fire: (...args) => listener?.(...args),
  };
}

/** For the events the worker subscribes to that these tests never dispatch. */
const silent = { addListener() {} };

const TAB = { id: 1, url: 'https://example.com/x', title: 'Example', windowId: 1, status: 'complete' };
const OTHER_TAB = { id: 2, url: 'https://docs.example.org/y', title: 'Docs', windowId: 1, status: 'complete' };
/** The ATOM start page: an extension URL, so it is not a page ATOM can act on. */
const START_TAB = { id: 3, url: 'chrome-extension://abcdefghijklmnop/newtab/index.html', title: 'ATOM', windowId: 1, status: 'complete' };

/** What the content agent answers `read` with, for a test that asks for a page. */
const PAGE = {
  ok: true,
  url: '',
  title: '',
  text: 'Example page',
  headings: [],
  elements: [{ ref: 'e1', kind: 'link', name: 'Docs', href: 'https://docs.example.org/y' }],
  scroll: { percent: 0, y: 0, height: 1000, viewport: 800 },
  forms: {},
  truncated: false,
};

function createChrome({
  settings = {},
  servePage = false,
  attachSucceeds = false,
  pageAccess = true,
  evaluateValue = { title: 'Example page', buttons: 3 },
  clipboardText = 'clipboard from the user',
} = {}) {
  const store = { 'atom.settings': settings };
  const tabs = { 1: TAB, 2: OTHER_TAB, 3: START_TAB };
  let activeId = 1;
  let attachCalls = 0;
  let pageCalls = 0;
  const actions = [];
  const commands = [];
  const navigations = [];
  const detaches = [];
  const menus = [];
  const panelOpens = [];
  const opens = [];
  const closes = [];
  const switches = [];
  const groups = [];
  const groupUpdates = [];
  const historySearches = [];
  const bookmarksCreated = [];
  const downloads = [];
  const notifications = [];
  const offscreenDocuments = [];
  const debugCalls = [];
  const menuClicks = event();
  let clipboard = clipboardText;
  let nextTabId = 4;
  let nextGroupId = 10;

  // The content agent, as the worker sees it, called as
  // `tabs.sendMessage(tabId, message)`. A test that wants a page asks for one;
  // every other test gets a refusal, and the call is counted either way.
  // Two controls per tab, with different labels, so a test can tell which page
  // a ref and its metadata came from.
  const elementsFor = (tab) => [
    { ref: 'e1', kind: 'link', name: tab.id === 2 ? 'Guide' : 'Docs', href: tab.url },
    { ref: 'e2', kind: 'button', name: tab.id === 2 ? 'Download' : 'Buy now' },
    // A control that submits, which no grant may ever cover.
    { ref: 'e3', kind: 'button', name: 'Place order', submits: true },
    // A secret field, which no site trust may cover either.
    { ref: 'e4', kind: 'input', name: 'Password', sensitive: 'password' },
  ];

  const page = (tabId, message) => {
    pageCalls += 1;
    if (!servePage) throw new Error('this test did not expect the page to be touched');
    const tab = tabs[tabId];
    if (message?.type === 'ping') return { ok: true };
    if (message?.type === 'read') return { ...PAGE, url: tab.url, title: tab.title, elements: elementsFor(tab) };
    if (message?.type === 'act') {
      const ref = message.action?.ref;
      if (ref !== 'e1' && ref !== 'e2') {
        return { ok: false, code: 'stale', message: `Nothing matches ${ref} any more.` };
      }
      actions.push(message.action);
      return { ok: true, message: 'Clicked; the page changed.', url: tab.url };
    }
    throw new Error(`the page was asked to "${message?.type}"`);
  };

  const chrome = {
    runtime: {
      onInstalled: silent,
      onConnect: event(),
      getURL: (path) => `chrome-extension://test/${path}`,
      async sendMessage(message) {
        if (message?.target !== 'atom-offscreen') throw new Error('No receiver for that message');
        if (message.op === 'read') return { ok: true, text: clipboard };
        clipboard = String(message.text || '');
        return { ok: true };
      },
    },
    offscreen: {
      async hasDocument() {
        return offscreenDocuments.length > 0;
      },
      async createDocument(options) {
        offscreenDocuments.push(options);
      },
    },
    contextMenus: {
      create(item, callback) {
        menus.push(item);
        callback?.();
      },
      onClicked: menuClicks,
    },
    sidePanel: {
      async open(options) {
        panelOpens.push(options);
      },
    },
    tabs: {
      onActivated: silent,
      onUpdated: silent,
      async query(info = {}) {
        // An unfiltered query is what list_tabs asks for: every real tab.
        if (!info || Object.keys(info).length === 0) return Object.values(tabs).filter((tab) => tab.url);
        return [tabs[activeId]];
      },
      async get(id) {
        if (tabs[id]) return tabs[id];
        throw new Error('No tab with id');
      },
      sendMessage: page,
      async create({ url, active = true }) {
        const tab = { id: nextTabId++, url, title: url, windowId: 1, status: 'complete' };
        tabs[tab.id] = tab;
        opens.push({ url, active });
        if (active) activeId = tab.id;
        return tab;
      },
      async remove(ids) {
        for (const id of [].concat(ids)) {
          closes.push(id);
          delete tabs[id];
        }
        if (!tabs[activeId]) activeId = Number(Object.keys(tabs)[0]);
      },
      async group({ tabIds }) {
        groups.push([...tabIds]);
        return nextGroupId++;
      },
      async update(id, { url, active } = {}) {
        if (!tabs[id]) throw new Error('No tab with id');
        if (url !== undefined) {
          tabs[id].url = url;
          navigations.push({ id, url });
        }
        if (active) {
          activeId = id;
          switches.push(id);
        }
        return tabs[id];
      },
    },
    tabGroups: {
      async update(id, properties) {
        groupUpdates.push({ id, ...properties });
      },
    },
    windows: {
      WINDOW_ID_CURRENT: -1,
      async update() {},
    },
    history: {
      async search(info) {
        historySearches.push(info);
        return [{ title: 'Docs', url: 'https://docs.example.org/y', lastVisitTime: Date.UTC(2026, 0, 2) }];
      },
    },
    bookmarks: {
      async search({ query }) {
        return query ? [{ title: 'Docs', url: 'https://docs.example.org/y' }] : [];
      },
      async create(item) {
        bookmarksCreated.push(item);
        return { id: 'bm1', ...item };
      },
    },
    downloads: {
      async download({ url }) {
        downloads.push(url);
        return 7;
      },
    },
    notifications: {
      async create(item) {
        notifications.push(item);
        return 'n1';
      },
    },
    scripting: {
      executeScript() {
        pageCalls += 1;
        throw new Error('no test injects the content agent');
      },
    },
    permissions: {
      onAdded: silent,
      onRemoved: silent,
      async contains() {
        return pageAccess;
      },
    },
    storage: {
      local: {
        async get(key) {
          if (Array.isArray(key)) return Object.fromEntries(key.map((name) => [name, store[name]]));
          return { [key]: store[key] };
        },
        async set(values) {
          Object.assign(store, values);
        },
        async remove(keys) {
          for (const key of [].concat(keys)) delete store[key];
        },
      },
    },
    debugger: {
      onEvent: silent,
      onDetach: silent,
      // Brave refuses a second debugger on the same tab, which is the common
      // case; a test that wants a real session asks for one.
      async attach() {
        attachCalls += 1;
        if (!attachSucceeds) throw new Error('Another debugger is already attached to the tab');
      },
      async sendCommand(target, method, params) {
        commands.push(method);
        debugCalls.push({ tabId: target.tabId, method, params });
        if (method === 'Runtime.evaluate') {
          return { result: { value: evaluateValue } };
        }
        if (method === 'Page.captureScreenshot') return { data: 'AAAA' };
        return {};
      },
      async detach({ tabId }) {
        detaches.push(tabId);
      },
    },
  };

  return {
    chrome,
    store,
    actions,
    commands,
    detaches,
    menus,
    panelOpens,
    opens,
    closes,
    switches,
    groups,
    groupUpdates,
    historySearches,
    bookmarksCreated,
    downloads,
    notifications,
    offscreenDocuments,
    debugCalls,
    clipboard: () => clipboard,
    clickMenu: (info, tab) => menuClicks.fire(info, tab),
    navigations,
    pageCalls: () => pageCalls,
    attachCalls: () => attachCalls,
    /** What the user does between messages: switch to the other tab. */
    activate: (id) => {
      if (!tabs[id]) throw new Error(`no tab ${id}`);
      activeId = id;
    },
  };
}

/* ----------------------------------------------------------- fake provider */

function sse(chunks) {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const toolCall = (name, args, id = 'call_1') =>
  sse([
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] },
          finish_reason: 'tool_calls',
        },
      ],
    },
  ]);

const textReply = (text) => sse([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }]);

/* ---------------------------------------------------------------- harness */

let caseId = 0;

async function loadWorker(t, {
  settings = {},
  responses = [],
  servePage = false,
  attachSucceeds = false,
  pageAccess = true,
  evaluateValue,
  clipboardText,
} = {}) {
  const fake = createChrome({ settings, servePage, attachSucceeds, pageAccess, evaluateValue, clipboardText });
  const fetches = [];
  const webFetches = [];
  const warnings = [];

  const fakeFetch = async (url, init = {}) => {
    const href = String(url);
    // The two public lookup backends answer with their own shapes; only the
    // provider calls go through the scripted responses.
    if (href.startsWith('https://en.wikipedia.org/')) {
      webFetches.push(href);
      return new Response(
        JSON.stringify({
          query: { search: [{ title: 'Lee Drilly', snippet: 'A drill rapper from the Bronx.' }] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (href.startsWith('https://google.serper.dev/')) {
      webFetches.push(href);
      return new Response(
        JSON.stringify({
          organic: [{ title: 'Lee Drilly', link: 'https://example.com/lee-drilly', snippet: 'A drill rapper from the Bronx.' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    // The default search backend: an HTML results page, parsed locally.
    if (href.startsWith('https://www.bing.com/')) {
      webFetches.push(href);
      return new Response(
        '<li class="b_algo"><h2><a href="https://www.bbc.com">BBC</a></h2><p class="b_lineclamp2">The BBC website.</p></li>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }
    if (href.startsWith('https://html.duckduckgo.com/')) {
      webFetches.push(href);
      return new Response(
        '<a rel="nofollow" class="result__a" href="https://duckduckgo.com/l/?uddg=' +
          encodeURIComponent('https://example.com/lee-drilly') +
          '">Lee Drilly</a><a class="result__snippet">A drill rapper from the Bronx.</a>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }
    if (href.startsWith('https://api.openverse.org/')) {
      webFetches.push(href);
      return new Response(
        JSON.stringify({
          results: [
            {
              title: 'A sleepy cat',
              thumbnail: 'https://example.com/cat-thumb.jpg',
              url: 'https://example.com/cat.jpg',
              foreign_landing_url: 'https://example.com/cat',
              creator: 'Nobody',
              license: 'cc0',
              license_version: '1.0',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    fetches.push({ url: href, body: init.body ? JSON.parse(init.body) : null });
    const next = responses.shift();
    return next ? next() : textReply('All done.');
  };

  // The worker calls global fetch and logs real diagnostics (a refused
  // debugger, a failed turn). Both are swapped for this test only, and put back
  // when it ends: a leak would follow the next test file's cases.
  const saved = { chrome: globalThis.chrome, fetch: globalThis.fetch, warn: console.warn };
  globalThis.chrome = fake.chrome;
  globalThis.fetch = fakeFetch;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  t.after(() => {
    globalThis.chrome = saved.chrome;
    globalThis.fetch = saved.fetch;
    console.warn = saved.warn;
  });

  await import(new URL(`../extension/background.js?case=${(caseId += 1)}`, import.meta.url).href);

  return { ...fake, fetches, webFetches, warnings };
}

const label = (message) => message.e?.kind || message.t;

/** A side-panel port: records what the worker posts, and can await a message. */
function openPort(chrome) {
  const received = [];
  const waiters = [];
  let onMessage;
  let onDisconnect;

  const deliver = (message) => {
    received.push(message);
    for (const waiter of waiters.slice()) {
      const hit = received.slice(waiter.from).find(waiter.match);
      if (!hit) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.settle(hit);
    }
  };

  const port = {
    name: 'atom',
    received,
    onMessage: {
      addListener(fn) {
        onMessage = fn;
      },
    },
    onDisconnect: {
      addListener(fn) {
        onDisconnect = fn;
      },
    },
    postMessage: deliver,
    send: (message) => onMessage(message),
    disconnect: () => onDisconnect(),
    /** Resolve with the first message at or after `from` that matches. */
    waitFor(match, { from = 0, timeout = 2000 } = {}) {
      const hit = received.slice(from).find(match);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`no matching message in ${timeout}ms; saw: ${received.map(label).join(', ') || 'nothing'}`));
        }, timeout);
        const waiter = {
          from,
          match,
          settle: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        };
        waiters.push(waiter);
      });
    },
  };

  chrome.runtime.onConnect.fire(port);
  return port;
}

/** The snapshot a panel is handed when it opens. */
async function getState(port) {
  const from = port.received.length;
  port.send({ t: 'hello' });
  return port.waitFor((message) => message.t === 'state', { from });
}

/** The worker announces the end of a turn; that is the only thing to wait on. */
const idle = (port, from = 0) =>
  port.waitFor((message) => message.e?.kind === 'busy' && message.e.busy === false, { from });

/* ------------------------------------------------------------------- cases */

test('a turn with no key errors honestly and never calls the provider', async (t) => {
  const worker = await loadWorker(t);
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'hello' });

  const error = await port.waitFor((message) => message.e?.kind === 'error');
  assert.equal(error.e.code, 'no_key');
  assert.match(error.e.message, /API key/i);

  const state = await getState(port);
  const last = state.session.messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.equal(last.status, 'error');
  assert.equal(last.code, 'no_key');
  assert.equal(state.busy, false);
  assert.equal(worker.fetches.length, 0, 'no paid request without a key');
});

test('a selection from the context menu is quoted without touching the page', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    pageAccess: false,
    responses: [() => textReply('It is about dragons.'), () => textReply('Still dragons.')],
  });
  const port = openPort(worker.chrome);

  assert.ok(
    worker.menus.some((item) => item.title === 'Ask ATOM about this' && item.contexts?.includes('selection')),
    'the menu is offered for selections',
  );

  worker.clickMenu(
    {
      menuItemId: 'ask-atom-about-this',
      selectionText: '  Dragons   are\n\n\nreal  ',
      pageUrl: 'https://example.com/dragons',
    },
    { id: 1, title: 'Dragons', url: 'https://example.com/dragons' },
  );

  const quote = await port.waitFor((message) => message.e?.kind === 'quote' && message.e.quote);
  assert.equal(quote.e.quote.text, 'Dragons are\n\nreal', 'the selection is cleaned, not rewritten');
  assert.deepEqual(worker.panelOpens, [{ windowId: -1 }], 'the click opens the global panel, not a tab-scoped one');
  assert.equal(worker.pageCalls(), 0, 'a selection needs no page access and no content agent');

  port.send({ t: 'chat.send', text: 'what is this about?' });
  await idle(port);

  const user = worker.fetches[0].body.messages.filter((message) => message.role === 'user').at(-1);
  assert.match(user.content, /ATOM_UNTRUSTED:SELECTION/, 'the quote is fenced as page data');
  assert.ok(user.content.includes('Dragons are\n\nreal'), 'the selection is carried');
  assert.match(user.content, /what is this about\?/, 'the question follows it');

  // One selection, one message: the next turn carries no quote.
  const from = port.received.length;
  port.send({ t: 'chat.send', text: 'and then?' });
  await idle(port, from);
  const later = worker.fetches.at(-1).body.messages.filter((message) => message.role === 'user').at(-1);
  assert.equal(later.content, 'and then?');
});

test('a denied action never reaches the page', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    servePage: true,
    responses: [() => toolCall('click', '{"ref":"e2"}'), () => textReply('I did not click anything.')],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'click the buy button' });

  const card = await port.waitFor((message) => message.e?.kind === 'confirm');
  assert.match(card.e.request.summary, /Click/);
  assert.equal(card.e.request.host, 'example.com');

  port.send({ t: 'confirm.respond', id: card.e.request.id, allow: false });
  await idle(port);

  const state = await getState(port);
  const tool = state.session.messages.find((message) => message.role === 'tool');
  assert.equal(tool.tool.status, 'denied');
  assert.equal(tool.tool.detail, 'Denied');
  assert.match(tool.text, /denied/i);

  // The digest read touches the page by design; the click is what must not run.
  assert.equal(worker.actions.length, 0, 'the denied click never reached the page');
  assert.equal(worker.fetches.length, 2, 'the model was asked again with the denial in history');
  assert.equal(state.busy, false);
});

test('an allowed click actually reaches the page and settles as done', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    servePage: true,
    responses: [() => toolCall('click', '{"ref":"e2"}'), () => textReply('Clicked it.')],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'click the buy button' });

  const card = await port.waitFor((message) => message.e?.kind === 'confirm');
  port.send({ t: 'confirm.respond', id: card.e.request.id, allow: true });
  await idle(port);

  const state = await getState(port);
  const tool = state.session.messages.find((message) => message.role === 'tool');
  assert.equal(tool.tool.status, 'done', tool.tool.detail);
  assert.equal(tool.tool.detail, 'Clicked; the page changed.');
  assert.equal(tool.tool.url, 'https://example.com/x');

  // The action that left the worker is exactly what the model asked for, and
  // the panel was told the question was answered with a yes.
  assert.deepEqual(worker.actions, [{ type: 'click', ref: 'e2' }]);
  assert.ok(
    port.received.some((message) => message.e?.kind === 'confirmResolved' && message.e.allowed === true),
    'the question was resolved as allowed',
  );

  assert.equal(worker.fetches.length, 2, 'the result went back to the model as a tool message');
  assert.equal(state.session.messages.at(-1).text, 'Clicked it.');
  assert.equal(state.busy, false);
});

test('the digest is free: the panel is shown what was read, and only the first request carries it', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    servePage: true,
    responses: [() => toolCall('read_page', '{}'), () => textReply('It is a link to the docs.')],
  });
  const port = openPort(worker.chrome);

  // Read ahead on panel open, before anyone has asked anything.
  const context = await port.waitFor((message) => message.e?.kind === 'context' && message.e.context);
  assert.equal(context.e.context.elements, 4, 'the row counts the elements it read');
  assert.equal(context.e.context.host, 'example.com');

  port.send({ t: 'chat.send', text: 'what is this page?' });
  await idle(port);

  const first = worker.fetches[0].body.messages.find((message) => message.role === 'system').content;
  assert.match(first, /ATOM_UNTRUSTED:PAGE_DIGEST/, 'the first request carries the digest, fenced');
  assert.match(first, /\[e1\] link "Docs"/);
  assert.match(first, /cost no model step and no tokens/);

  const later = worker.fetches.at(-1).body.messages.find((message) => message.role === 'system').content;
  assert.doesNotMatch(later, /PAGE_DIGEST/, 'the digest rides the first request only');

  const state = await getState(port);
  assert.equal(state.context.elements, 4, 'a snapshot hands the row back to a reloaded panel');
});

test('a finished turn puts its steps and estimated tokens on the answer', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    servePage: true,
    responses: [() => toolCall('read_page', '{}'), () => textReply('It is a page.')],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'what is this?' });

  const meta = await port.waitFor((message) => message.e?.kind === 'meta');
  assert.equal(meta.e.meta.steps, 2, 'two requests were made');
  assert.ok(meta.e.meta.tokens > 100, `the estimate was ${meta.e.meta.tokens}`);

  const state = await getState(port);
  const answer = state.session.messages.at(-1);
  assert.equal(meta.e.id, answer.id, 'the numbers sit on the answer that ended the turn');
  assert.equal(answer.meta.tokens, meta.e.meta.tokens);
});

test('conversations keep separate histories and can be reopened', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    responses: [() => textReply('First answer.'), () => textReply('Second answer.')],
  });
  const port = openPort(worker.chrome);

  const start = await getState(port);
  assert.equal(start.chats.length, 1, 'one conversation to begin with');
  const firstId = start.activeChatId;

  port.send({ t: 'chat.send', text: 'hello one' });
  await idle(port);

  let from = port.received.length;
  port.send({ t: 'chat.new' });
  const created = await port.waitFor(
    (message) => message.e?.kind === 'chats' && message.e.chats.length === 2 && message.e.activeId !== firstId,
    { from },
  );
  assert.equal(created.e.activeId !== firstId, true, 'the new conversation is open');

  const empty = await getState(port);
  assert.equal(empty.session.messages.length, 0, 'a new conversation starts empty');

  from = port.received.length;
  port.send({ t: 'chat.send', text: 'hello two' });
  await idle(port, from);
  assert.equal(
    (await getState(port)).chats.find((chat) => chat.id === firstId).messages >= 2,
    true,
    'the first conversation kept its messages',
  );

  from = port.received.length;
  port.send({ t: 'chat.open', id: firstId });
  const opened = await port.waitFor((message) => message.e?.kind === 'session' && message.e.session.id === firstId, { from });
  assert.equal(opened.e.session.messages.at(-1).text, 'First answer.', 'the old conversation came back whole');

  from = port.received.length;
  port.send({ t: 'chat.delete', id: firstId });
  const gone = await port.waitFor((message) => message.e?.kind === 'chats' && message.e.chats.length === 1, { from });
  assert.equal(gone.e.chats.length, 1, 'deleting the open one leaves the other');
});

test('memory always asks, and then rides the next request', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    responses: [
      () => toolCall('remember', '{"text":"Prefers short answers"}'),
      () => textReply('Noted.'),
      () => textReply('Short: yes.'),
    ],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'remember that I like short answers' });
  const card = await port.waitFor((message) => message.e?.kind === 'confirm');
  assert.equal(card.e.request.host, 'Memory');
  assert.match(card.e.request.summary, /Remember/);
  assert.equal(card.e.request.grant, null, 'memory is never a remembered permission');

  port.send({ t: 'confirm.respond', id: card.e.request.id, allow: true });
  await idle(port);

  const state = await getState(port);
  assert.equal(state.settings.memories[0].text, 'Prefers short answers');

  // The next turn is where it counts: memory is read at the start of a turn.
  const from = port.received.length;
  port.send({ t: 'chat.send', text: 'and again?' });
  await idle(port, from);

  const system = worker.fetches.at(-1).body.messages.find((message) => message.role === 'system').content;
  assert.match(system, /Memory:/, 'the prompt knows about memory');
  assert.match(system, /Prefers short answers/);
});

test('one turn can read and act in another tab', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    servePage: true,
    responses: [
      () => toolCall('list_tabs', '{}', 'c0'),
      () => toolCall('read_page', '{"tab":2}', 'c1'),
      () => toolCall('click', '{"ref":"e2","tab":2}', 'c2'),
      () => textReply('Clicked in the docs tab.'),
    ],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'click download in the docs tab' });

  const card = await port.waitFor((message) => message.e?.kind === 'confirm');
  assert.equal(card.e.request.host, 'docs.example.org', 'the card names the tab it acts on');
  assert.equal(card.e.request.summary, 'Click “Download”', 'the ref came from the tab that was read');

  port.send({ t: 'confirm.respond', id: card.e.request.id, allow: true });
  await idle(port);

  const state = await getState(port);
  const tools = state.session.messages.filter((message) => message.role === 'tool');
  assert.equal(tools[0].tool.name, 'list_tabs');
  assert.match(tools[0].text, /2 — Docs/, 'the tab list names the ids');
  assert.deepEqual(worker.actions, [{ type: 'click', ref: 'e2' }]);
  assert.equal(tools[2].tool.host, 'docs.example.org');
});

test('a remembered click stops asking on that site, and only that site', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    servePage: true,
    responses: [
      () => toolCall('click', '{"ref":"e2"}', 'c1'),
      () => textReply('Clicked it.'),
      () => toolCall('click', '{"ref":"e2"}', 'c2'),
      () => textReply('Clicked again.'),
      () => toolCall('click', '{"ref":"e2"}', 'c3'),
      () => textReply('Asked there.'),
    ],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'click buy' });
  const card = await port.waitFor((message) => message.e?.kind === 'confirm');
  assert.deepEqual(card.e.request.grant, { kind: 'click', host: 'example.com', label: 'clicking' });

  port.send({ t: 'confirm.respond', id: card.e.request.id, allow: true, remember: true });
  await idle(port);
  assert.equal(worker.actions.length, 1);

  const state = await getState(port);
  assert.deepEqual(
    state.settings.actionGrants.map(({ host, kind }) => ({ host, kind })),
    [{ host: 'example.com', kind: 'click' }],
    'the grant is stored and visible to the panel',
  );

  // The same click on the same site: no question this time.
  let from = port.received.length;
  port.send({ t: 'chat.send', text: 'click it again' });
  await idle(port, from);
  assert.equal(worker.actions.length, 2, 'the remembered click ran');
  assert.ok(!port.received.slice(from).some((message) => message.e?.kind === 'confirm'), 'nothing asked');

  // A different site still asks.
  worker.activate(2);
  from = port.received.length;
  port.send({ t: 'chat.send', text: 'click it here' });
  const other = await port.waitFor((message) => message.e?.kind === 'confirm', { from });
  assert.equal(other.e.request.host, 'docs.example.org', 'the grant was for the other site');
  port.send({ t: 'confirm.respond', id: other.e.request.id, allow: false });
  await idle(port, from);
});

test('a trusted site cannot skip the submit floor', async (t) => {
  const worker = await loadWorker(t, {
    settings: {
      apiKey: 'gsk_test',
      agent: { mode: 'playground', stepLimit: 8, trustedSites: ['example.com'] },
    },
    servePage: true,
    responses: [() => toolCall('click', '{"ref":"e3"}', 'c1'), () => textReply('I did not place it.')],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'place the order' });
  const card = await port.waitFor((message) => message.e?.kind === 'confirm');
  assert.equal(card.e.request.summary, 'Click “Place order”');
  assert.equal(card.e.request.grant, null);

  port.send({ t: 'confirm.respond', id: card.e.request.id, allow: false });
  await idle(port);
  assert.deepEqual(worker.actions, []);
});

test('a trusted site cannot skip the secret field floor', async (t) => {
  const worker = await loadWorker(t, {
    settings: {
      apiKey: 'gsk_test',
      agent: { mode: 'playground', stepLimit: 8, trustedSites: ['example.com'] },
    },
    servePage: true,
    responses: [
      () => toolCall('type_text', '{"ref":"e4","text":"hunter2"}', 'c1'),
      () => textReply('I did not type it.'),
    ],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'type the password' });
  const card = await port.waitFor((message) => message.e?.kind === 'confirm');
  assert.match(card.e.request.summary, /password field/);

  port.send({ t: 'confirm.respond', id: card.e.request.id, allow: false });
  await idle(port);
  assert.deepEqual(worker.actions, []);
});

test('typing reaches the page with the exact text after approval', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    servePage: true,
    responses: [
      () => toolCall('type_text', '{"ref":"e2","text":"hello"}', 'c1'),
      () => textReply('Typed it.'),
    ],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'type hello' });
  const card = await port.waitFor((message) => message.e?.kind === 'confirm');
  port.send({ t: 'confirm.respond', id: card.e.request.id, allow: true });
  await idle(port);

  assert.deepEqual(worker.actions, [
    { type: 'type', ref: 'e2', text: 'hello', submit: false, confirmed: true },
  ]);
});

test('a submit control is never offered a grant', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    servePage: true,
    responses: [() => toolCall('click', '{"ref":"e3"}', 'c1'), () => textReply('I did not place it.')],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'place the order' });
  const card = await port.waitFor((message) => message.e?.kind === 'confirm');
  assert.equal(card.e.request.grant, null, 'nothing about a submit may be remembered');

  port.send({ t: 'confirm.respond', id: card.e.request.id, allow: false });
  await idle(port);
  assert.equal(worker.actions.length, 0);
});

test('revoking a grant brings the question back', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test', actionGrants: [{ host: 'example.com', kind: 'click', at: 1 }] },
    servePage: true,
    responses: [
      () => toolCall('click', '{"ref":"e2"}', 'c1'),
      () => textReply('Clicked it.'),
      () => toolCall('click', '{"ref":"e2"}', 'c2'),
      () => textReply('Clicked again.'),
    ],
  });
  const port = openPort(worker.chrome);

  let from = port.received.length;
  port.send({ t: 'chat.send', text: 'click buy' });
  await idle(port, from);
  assert.equal(worker.actions.length, 1, 'the trusted click ran without a card');
  assert.ok(!port.received.slice(from).some((message) => message.e?.kind === 'confirm'));

  port.send({ t: 'grants.revoke', host: 'example.com', kind: 'click' });
  const settings = await port.waitFor(
    (message) => message.e?.kind === 'settings' && message.e.settings.actionGrants.length === 0,
  );
  assert.equal(settings.e.settings.actionGrants.length, 0, 'the panel was told the grant is gone');

  from = port.received.length;
  port.send({ t: 'chat.send', text: 'click again' });
  const card = await port.waitFor((message) => message.e?.kind === 'confirm', { from });
  assert.equal(card.e.request.grant.kind, 'click', 'the question is back, with the offer');

  port.send({ t: 'confirm.respond', id: card.e.request.id, allow: false });
  await idle(port, from);
  assert.equal(worker.actions.length, 1, 'the revoked click did not run');
});

test('a click after a tab switch does not inherit the old page\'s element kind', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    servePage: true,
    responses: [
      () => toolCall('read_page', '{}'),
      () => textReply('The page is a link to the docs.'),
      () => toolCall('click', '{"ref":"e2"}'),
      () => textReply('I did not click anything.'),
    ],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'read this page' });
  await idle(port);

  // e1 on this page is a link, so a click on it would not need a prompt.
  const read = (await getState(port)).session.messages.find((message) => message.role === 'tool');
  assert.equal(read.tool.name, 'read_page');
  assert.equal(read.tool.status, 'done');

  // The user now asks for e2 on a different page, where e2 is something else.
  worker.activate(2);
  const from = port.received.length;
  port.send({ t: 'chat.send', text: 'click the second control' });

  const card = await port.waitFor((message) => message.e?.kind === 'confirm', { from });
  assert.equal(card.e.request.summary, 'Click “Download”', 'the new page\'s label is used, not the old one');
  assert.equal(card.e.request.host, 'docs.example.org');

  port.send({ t: 'confirm.respond', id: card.e.request.id, allow: false });
  await idle(port, from);
  assert.equal(worker.actions.length, 0, 'nothing ran on the new tab');
});

test('a stale ref tells the model to re-read instead of retrying the click', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    servePage: true,
    responses: [() => toolCall('click', '{"ref":"gone"}'), () => textReply('I will read the page again.')],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'click the thing' });
  const card = await port.waitFor((message) => message.e?.kind === 'confirm');
  port.send({ t: 'confirm.respond', id: card.e.request.id, allow: true });
  await idle(port);

  const state = await getState(port);
  const row = state.session.messages.find((message) => message.role === 'tool');
  assert.equal(row.tool.status, 'failed');
  assert.equal(row.tool.code, 'stale');
  assert.match(row.text, /^gone /, 'names the ref that went stale');
  assert.match(row.text, /read_page/);
  assert.match(row.text, /do not repeat/i);

  // What the model received, not only what the panel shows.
  const followUp = worker.fetches.at(-1).body.messages;
  assert.ok(
    followUp.some(
      (message) => message.role === 'tool' && /read_page/.test(message.content) && /do not repeat/i.test(message.content),
    ),
    'the steer never reached the model',
  );
  assert.equal(worker.actions.length, 0, 'nothing reached the page');
});

test('without page access the action is refused and the model is told how to unblock it', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    pageAccess: false,
    responses: [() => toolCall('read_page', '{}'), () => textReply('I need access first.')],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'read this page' });
  await idle(port);

  const state = await getState(port);
  const row = state.session.messages.find((message) => message.role === 'tool');
  assert.equal(row.tool.status, 'failed');
  assert.equal(row.tool.code, 'no_access');
  assert.match(row.text, /example\.com/);
  assert.match(row.text, /Grant access/);
  assert.match(row.text, /read_page/);
  assert.match(row.text, /do not retry/i);

  assert.equal(worker.pageCalls(), 0, 'nothing reached the page');

  // The whole point of the turn: navigation must still be on offer, or the only
  // honest answer is the apology this case used to get.
  const offered = (worker.fetches.at(-1).body.tools || []).map((tool) => tool.function.name);
  assert.ok(offered.includes('navigate'), 'navigation without a grant');
  assert.ok(offered.includes('web_search'), 'lookups without a grant');
  assert.ok(!offered.includes('read_page'), 'page tools wait for the grant');
  const system = worker.fetches.at(-1).body.messages.find((message) => message.role === 'system').content;
  assert.match(system, /needs no page access/i, 'the prompt says navigating is still possible');
});

test('a guessed address is refused, and the refusal says to search', async (t) => {
  // "goto discord" contains no address. Inventing one is what this prevents.
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    pageAccess: false,
    responses: [() => toolCall('navigate', '{"url":"https://discord.com/app"}'), () => textReply('Let me search.')],
  });
  worker.activate(3);

  const port = openPort(worker.chrome);
  port.send({ t: 'chat.send', text: 'goto discord' });
  await idle(port);

  assert.deepEqual(worker.navigations, [], 'a guessed address must not open anything');

  const state = await getState(port);
  const row = state.session.messages.find((message) => message.role === 'tool');
  assert.equal(row.tool.status, 'failed');
  assert.equal(row.tool.code, 'guessed_url');
  assert.match(row.text, /not given to you/);
  assert.match(row.text, /web_search/);
});

test('an address the user typed may be opened from a page ATOM cannot name', async (t) => {
  // The start page is an extension URL: no tab summary, no origin, no grant — the
  // exact state a fresh new tab is in. The address is in the user's message.
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    pageAccess: false,
    responses: [() => toolCall('navigate', '{"url":"https://discord.com/app"}'), () => textReply('Opened Discord.')],
  });
  worker.activate(3);

  const port = openPort(worker.chrome);
  port.send({ t: 'chat.send', text: 'open https://discord.com/app' });
  await idle(port);

  assert.equal(worker.pageCalls(), 0, 'nothing was injected into anything');
  assert.deepEqual(worker.navigations, [{ id: 3, url: 'https://discord.com/app' }], 'moved the tab it was on');

  const state = await getState(port);
  const row = state.session.messages.find((message) => message.role === 'tool');
  assert.equal(row.tool.status, 'done');
  assert.match(row.text, /discord\.com/);
});

test('a site named in the request opens without a search', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    pageAccess: false,
    responses: [() => toolCall('navigate', '{"url":"https://www.youtube.com"}'), () => textReply('Opened YouTube.')],
  });
  worker.activate(3);
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'bro goto youtube' });
  await idle(port);

  assert.deepEqual(worker.navigations, [{ id: 3, url: 'https://www.youtube.com' }]);
  assert.equal(worker.webFetches.length, 0, 'the site name did not cost a search');
  const state = await getState(port);
  const row = state.session.messages.find((message) => message.role === 'tool');
  assert.equal(row.tool.status, 'done');
  assert.match(row.text, /youtube\.com/);
});

test('Playground opens a named site before the model can search for it', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test', agent: { mode: 'playground' } },
    pageAccess: false,
    responses: [() => textReply('YouTube is open.')],
  });
  worker.activate(3);
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'bro goto yt' });
  await idle(port);

  assert.deepEqual(worker.navigations, [{ id: 3, url: 'https://www.youtube.com' }]);
  assert.equal(worker.webFetches.length, 0, 'no search was made for a site the user named');
  const state = await getState(port);
  assert.equal(state.session.messages.some((message) => message.role === 'tool'), false);
});

test('Playground resolves an unknown site name through Bing', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test', agent: { mode: 'playground' } },
    pageAccess: false,
    responses: [() => textReply('The BBC is open.')],
  });
  worker.activate(3);
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'goto bbc' });
  await idle(port);

  assert.deepEqual(worker.navigations, [{ id: 3, url: 'https://www.bbc.com' }]);
  assert.equal(worker.webFetches[0].startsWith('https://www.bing.com/'), true, 'the name was resolved by search');
});

test('Playground opens an Instagram handle instead of searching for it', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test', agent: { mode: 'playground' } },
    pageAccess: false,
    responses: [() => textReply('The Instagram profile is open.')],
  });
  worker.activate(3);
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'goto instagram @vureld' });
  await idle(port);

  assert.deepEqual(worker.navigations, [{ id: 3, url: 'https://www.instagram.com/vureld' }]);
  assert.equal(worker.webFetches.length, 0, 'a named handle did not need a search');
});

test('a Playground play request opens YouTube results directly', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test', agent: { mode: 'playground' } },
    pageAccess: false,
    responses: [() => textReply('The results are open.')],
  });
  worker.activate(3);
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'head over to youtube and play chief keef' });
  await idle(port);

  assert.deepEqual(worker.navigations, [
    { id: 3, url: 'https://www.youtube.com/results?search_query=chief%20keef' },
  ]);
  assert.equal(worker.webFetches.length, 0);
});

test('a turn stops after two web searches instead of piling up results', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    pageAccess: false,
    responses: [
      () => toolCall('web_search', '{"query":"first"}', 's1'),
      () => toolCall('web_search', '{"query":"second"}', 's2'),
      () => toolCall('web_search', '{"query":"third"}', 's3'),
      () => textReply('Using the first two results.'),
    ],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'look up three things' });
  await idle(port);

  assert.equal(worker.webFetches.length, 2, 'only two searches reached the web');
  const state = await getState(port);
  const rows = state.session.messages.filter((message) => message.role === 'tool');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].tool.status, 'done');
  assert.equal(rows[1].tool.status, 'done');
  assert.equal(rows[2].tool.status, 'failed');
  assert.equal(rows[2].tool.code, 'search_limit');
  assert.match(rows[2].text, /2 searches/);
});

test('a Google-backed lookup uses the saved Serper key', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test', search: { provider: 'serper', key: 'serper-key' } },
    pageAccess: false,
    responses: [() => toolCall('web_search', '{"query":"lee drilly"}'), () => textReply('Here it is.')],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'look up lee drilly' });
  await idle(port);

  assert.deepEqual(worker.webFetches, ['https://google.serper.dev/search']);
  const state = await getState(port);
  const row = state.session.messages.find((message) => message.role === 'tool');
  assert.equal(row.tool.status, 'done');
  assert.match(row.text, /example\.com\/lee-drilly/);
});

test('a lookup and a picture search work with no page access at all', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    pageAccess: false,
    responses: [
      () => toolCall('web_search', '{"query":"lee drilly"}'),
      () => toolCall('show_image', '{"query":"sleepy cat","count":1}', 'call_2'),
      () => textReply('Here you go.'),
    ],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'look up lee drilly and show me a sleepy cat' });
  await idle(port);

  assert.equal(worker.pageCalls(), 0, 'a lookup never injects anything');

  const state = await getState(port);
  const rows = state.session.messages.filter((message) => message.role === 'tool');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tool.status, 'done');
  assert.match(rows[0].text, /Lee Drilly/);
  assert.match(rows[0].text, /example\.com\/lee-drilly/);

  // The user sees a picture; the model gets a credit and nothing to describe.
  assert.equal(rows[1].tool.status, 'done');
  assert.equal(rows[1].tool.images.length, 1);
  assert.equal(rows[1].tool.images[0].url, 'https://example.com/cat-thumb.jpg');
  assert.doesNotMatch(rows[1].text, /cat-thumb\.jpg/, 'the raw thumbnail URL is not part of the transcript text');

  const offered = (worker.fetches[0].body.tools || []).map((tool) => tool.function.name);
  assert.ok(offered.includes('web_search'));
  assert.ok(offered.includes('show_image'));
  assert.ok(!offered.includes('read_page'), 'page tools still need the grant');
  assert.equal(worker.webFetches.length, 2, 'one request per lookup, straight from the worker');
});

test('a refused capture attach is announced and the turn runs without capture tools', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    responses: [() => textReply('Capture is off, so I cannot read the console.')],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'what failed in the console?', capture: true });

  const notice = await port.waitFor(
    (message) => message.e?.kind === 'notice' && /Console capture could not start/.test(message.e.text),
  );
  assert.match(notice.e.text, /Debug(ger|ging)|refused|DevTools/i);

  await idle(port);

  assert.equal(worker.attachCalls(), 1, 'one attempt, no half-attached session');
  assert.equal(
    worker.warnings.filter((line) => /capture attach failed/.test(line)).length,
    1,
    'the refusal was logged, not swallowed',
  );
  assert.equal(
    port.received.some((message) => message.e?.kind === 'capture' && message.e.attached === true),
    false,
    'the panel is never told capture is on',
  );

  assert.equal(worker.fetches.length, 1);
  const names = (worker.fetches[0].body.tools || []).map((tool) => tool.function.name);
  assert.ok(names.includes('read_page'), 'page tools still offered');
  assert.equal(names.includes('read_console'), false);
  assert.equal(names.includes('read_network'), false);
});

test('a successful attach offers capture tools and is detached when the turn ends or is stopped', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    attachSucceeds: true,
    responses: [
      () => textReply('Nothing has failed yet.'),
      () => toolCall('click', '{"ref":"e1"}'),
      () => textReply('This must never be requested.'),
    ],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'what failed in the console?', capture: true });
  await port.waitFor((message) => message.e?.kind === 'capture' && message.e.attached === true);
  await idle(port);

  assert.equal(worker.attachCalls(), 1);
  assert.deepEqual(worker.commands, ['Runtime.enable', 'Log.enable', 'Network.enable'], 'the domains the tools read');

  const names = (worker.fetches[0].body.tools || []).map((tool) => tool.function.name);
  assert.ok(names.includes('read_console'), 'capture tools are offered while the session is up');
  assert.ok(names.includes('read_network'));
  assert.ok(names.includes('read_page'), 'page tools are still offered with capture');

  let state = await getState(port);
  assert.equal(state.capture.attached, false, 'the banner is gone when the turn ends');
  assert.deepEqual(worker.detaches, [1], 'detached when the turn ended');
  assert.ok(
    port.received.some((message) => message.e?.kind === 'capture' && message.e.attached === false),
    'the panel is told the session closed',
  );

  // A turn that is stopped before it finishes still gives the tab back.
  const from = port.received.length;
  port.send({ t: 'chat.send', text: 'click the buy button', capture: true });
  await port.waitFor((message) => message.e?.kind === 'confirm', { from });
  port.send({ t: 'chat.stop' });
  await idle(port, from);

  state = await getState(port);
  assert.equal(state.capture.attached, false);
  assert.deepEqual(worker.detaches, [1, 1], 'detached when the turn was stopped');
  assert.equal(worker.fetches.length, 2, 'no step was paid for after the stop');
});

test('the last port disconnecting denies the open question and aborts the turn', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    servePage: true,
    responses: [() => toolCall('click', '{"ref":"e2"}'), () => textReply('This must never be requested.')],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'click the buy button' });
  await port.waitFor((message) => message.e?.kind === 'confirm');

  // No panel means nobody can answer, so the question is a denial and the turn
  // is aborted right there. The abort resolves the question on the next
  // microtask, so a port opened here still sees the turn's final busy:false.
  port.disconnect();
  const fresh = openPort(worker.chrome);

  await idle(fresh);
  const state = await getState(fresh);
  const tool = state.session.messages.find((message) => message.role === 'tool');

  assert.equal(tool.tool.status, 'denied');
  assert.match(tool.text, /denied/i);
  assert.equal(state.busy, false);
  assert.equal(worker.actions.length, 0, 'the action never ran');
  assert.equal(worker.fetches.length, 1, 'no step was paid for after the abort');
});

test('retry on the last answer replaces it instead of stacking a second one', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    responses: [() => textReply('first answer'), () => textReply('second answer')],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'hello' });
  await idle(port);

  const from = port.received.length;
  port.send({ t: 'chat.regenerate' });
  await idle(port, from);

  const state = await getState(port);
  assert.deepEqual(
    state.session.messages.map((message) => [message.role, message.text]),
    [
      ['user', 'hello'],
      ['assistant', 'second answer'],
    ],
  );
  assert.equal(
    worker.fetches.at(-1).body.messages.filter((message) => message.role === 'assistant').length,
    0,
    'the replaced answer is not sent back as history',
  );
});

test('thinking reaches the panel while it happens, and stays on the message', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    responses: [
      () =>
        sse([
          { choices: [{ delta: { reasoning: 'First, read the question.' } }] },
          { choices: [{ delta: { reasoning: ' Then answer it.' } }] },
          { choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] },
        ]),
    ],
  });
  const port = openPort(worker.chrome);

  const live = port.waitFor((message) => message.e?.kind === 'live' && message.e.step === 1);
  port.send({ t: 'chat.send', text: 'think' });

  const reason = await port.waitFor((message) => message.e?.kind === 'reason' && /Then answer/.test(message.e.text || ''));
  assert.match(reason.e.text, /First, read the question\..*Then answer it\./);

  await idle(port);
  const stepped = await live;
  assert.equal(stepped.e.steps, MAX_STEPS, 'the panel is told the ceiling too');

  const state = await getState(port);
  const answer = state.session.messages.find((message) => message.role === 'assistant' && message.status === 'done');
  assert.equal(answer.text, 'Done.', 'thinking is not the answer');
  assert.match(answer.reasoning, /Then answer it\./);
});

test('editing a question replaces it and everything it answered', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    responses: [() => textReply('first answer'), () => textReply('second answer')],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'helo' });
  await idle(port);

  const before = await getState(port);
  const question = before.session.messages.find((message) => message.role === 'user');

  const from = port.received.length;
  port.send({ t: 'chat.edit', id: question.id, text: 'hello, typo fixed' });
  await idle(port, from);

  const after = await getState(port);
  assert.deepEqual(
    after.session.messages.map((message) => [message.role, message.text]),
    [
      ['user', 'hello, typo fixed'],
      ['assistant', 'second answer'],
    ],
    'the old answer went with the old wording',
  );
  assert.equal(after.session.title, 'hello, typo fixed', 'the chat is named by its first question');

  const sent = worker.fetches.at(-1).body.messages;
  assert.equal(sent.filter((message) => message.role === 'user').at(-1).content, 'hello, typo fixed');
  assert.ok(
    !sent.some((message) => message.role === 'assistant' && message.content === 'first answer'),
    'the replaced answer is not carried into the new request',
  );
});

test('a second key for the same provider is added to the pool, not swapped in', async (t) => {
  const worker = await loadWorker(t, { settings: { apiKey: 'gsk_one' } });
  const port = openPort(worker.chrome);

  const from = port.received.length;
  port.send({ t: 'settings.update', patch: { providerKey: { id: 'groq', keys: ['gsk_two'] } } });

  const saved = await port.waitFor((message) => message.e?.kind === 'settings' && message.e.settings.keyCounts?.groq === 2, {
    from,
  });
  assert.equal(saved.e.settings.keyCounts.groq, 2);

  const beforeClear = port.received.length;
  port.send({ t: 'settings.update', patch: { providerKey: { id: 'groq', keys: [] } } });
  const cleared = await port.waitFor((message) => message.e?.kind === 'settings' && message.e.settings.keyCounts?.groq === 0, {
    from: beforeClear,
  });
  assert.equal(cleared.e.settings.hasKey, false, 'clearing the pool leaves no key behind');
});

test('a provider that dies mid-answer is replaced, not stitched together', async (t) => {
  const worker = await loadWorker(t, {
    settings: { keyPool: { groq: ['key_one', 'key_two'] } },
    responses: [
      () =>
        sse([
          { choices: [{ delta: { content: 'Half an ans' } }] },
          { error: { message: 'Request too large for model on tokens per minute (TPM)' } },
        ]),
      () => textReply('Complete answer.'),
    ],
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'chat.send', text: 'hello' });
  await idle(port);

  const state = await getState(port);
  const answer = state.session.messages.find((message) => message.role === 'assistant' && message.status === 'done');
  assert.equal(answer.text, 'Complete answer.', 'the abandoned fragment is gone');
  assert.equal(worker.fetches.length, 2, 'the second key was tried');
});

test('the panel is told which key is busy and which is spent', async (t) => {
  const worker = await loadWorker(t, { settings: { keyPool: { groq: ['key_one', 'key_two'] } } });
  const port = openPort(worker.chrome);
  const from = port.received.length;

  port.send({ t: 'chat.send', text: 'hello' });
  await idle(port);

  const states = port.received
    .slice(from)
    .filter((message) => message.e?.kind === 'keys')
    .flatMap((message) => message.e.keys);
  assert.ok(states.some((key) => key.state === 'busy' && key.index === 0), 'the answering key is busy');
  const last = states.filter((key) => key.index === 0).at(-1);
  assert.equal(last.state, 'spent', 'it is red once the answer is done');
  assert.equal(last.hint, '_one');
});

test('a key can be removed by position, and the next one moves up', async (t) => {
  const worker = await loadWorker(t, { settings: { keyPool: { groq: ['a_one', 'b_two'] } } });
  const port = openPort(worker.chrome);

  port.send({ t: 'settings.update', patch: { providerKey: { id: 'groq', remove: 0 } } });
  const saved = await port.waitFor((message) => message.e?.kind === 'settings' && message.e.settings.keyCounts?.groq === 1);

  assert.equal(saved.e.keys.length, 1);
  assert.equal(saved.e.keys[0].hint, '_two');
});

test("the user's instructions are the last thing the provider reads", async (t) => {
  const worker = await loadWorker(t, { settings: { apiKey: 'gsk_test' } });
  const port = openPort(worker.chrome);

  port.send({
    t: 'settings.update',
    patch: { instructions: 'You are MARVIN. Always answer as MARVIN, and mention towels.' },
  });
  await port.waitFor((message) => message.e?.kind === 'settings' && message.e.settings.instructions?.includes('MARVIN'));

  port.send({ t: 'chat.send', text: 'who are you?' });
  await idle(port);

  const system = worker.fetches[0].body.messages[0];
  assert.equal(system.role, 'system');
  assert.match(system.content, /mention towels/, 'the playbook is carried in full');
  assert.match(system.content, /deprecated for this session/);
  assert.ok(
    system.content.trimEnd().endsWith('and mention towels.'),
    "the user's instructions are the last word",
  );
  assert.doesNotMatch(system.content, /Voice: direct/);
  assert.doesNotMatch(system.content, /You are ATOM/);

  const lastTurn = worker.fetches[0].body.messages.at(-1);
  assert.equal(lastTurn.role, 'user');
  assert.match(lastTurn.content, /Adhere strictly to the standing custom instructions provided in the system prompt/);
  assert.ok(!lastTurn.content.includes('mention towels'), 'one line, not the playbook again');
  assert.ok(!system.content.includes('Safety:'), 'the default safety block is not generated for a custom prompt');
});

test('erasing deletes memories, transcripts and the legacy session from storage', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test', memories: [{ id: 'm1', text: 'Likes tea' }] },
  });
  const port = openPort(worker.chrome);
  worker.store[LEGACY_KEY] = { id: 'old', messages: [{ id: 'x', role: 'user', text: 'hi' }] };

  port.send({ t: 'data.erase', what: 'all' });

  const settings = await port.waitFor(
    (message) => message.e?.kind === 'settings' && Array.isArray(message.e.settings.memories) && message.e.settings.memories.length === 0,
  );
  assert.deepEqual(settings.e.settings.memories, []);
  assert.deepEqual(worker.store['atom.settings'].memories, [], 'the facts are gone from storage too');

  const chats = await port.waitFor((message) => message.e?.kind === 'chats');
  assert.equal(chats.e.chats.length, 1, 'one empty conversation is left');
  assert.equal(chats.e.chats[0].messages, 0);

  assert.equal(worker.store[LEGACY_KEY], undefined, 'the pre-conversations key is removed');
  const shelf = worker.store['atom.chats'].chats;
  assert.equal(shelf.length, 1);
  assert.equal(shelf[0].messages.length, 0, 'no transcript survives in storage');
});

test('erasing only memories leaves conversations alone', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test', memories: [{ id: 'm1', text: 'Likes tea' }] },
  });
  const port = openPort(worker.chrome);

  port.send({ t: 'data.erase', what: 'memories' });
  await port.waitFor(
    (message) => message.e?.kind === 'settings' && message.e.settings.memories.length === 0,
  );

  assert.equal(worker.store['atom.chats'], undefined, 'the shelf was not rewritten');
});

test('with the agent on, a plan becomes a task the panel can watch', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test', agent: { mode: 'ask', stepLimit: 8, trustedSites: [] } },
    pageAccess: false,
    responses: [
      () => toolCall('plan', '{"steps":["Search for the repo","Open the result","Star it"]}'),
      () => textReply('Planned.'),
    ],
  });
  const port = openPort(worker.chrome);
  port.send({ t: 'chat.send', text: 'find the repo and star it' });
  await idle(port);

  const offered = (worker.fetches[0].body.tools || []).map((tool) => tool.function.name);
  for (const name of ['plan', 'tabs', 'browser', 'screenshot', 'press_key', 'run_js']) {
    assert.ok(offered.includes(name), `${name} is offered in agent mode`);
  }

  const state = await getState(port);
  assert.ok(state.task, 'the task is part of the state');
  assert.deepEqual(state.task.plan, ['Search for the repo', 'Open the result', 'Star it']);
  assert.equal(state.task.phase, 'done');
  assert.equal(state.task.step, 0, 'planning is not an action step');
});

test('agent mode off offers no browsing verbs and starts no task', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test' },
    pageAccess: false,
    responses: [() => textReply('Just chatting.')],
  });
  const port = openPort(worker.chrome);
  port.send({ t: 'chat.send', text: 'hello' });
  await idle(port);

  const offered = (worker.fetches[0].body.tools || []).map((tool) => tool.function.name);
  assert.ok(!offered.includes('plan'));
  assert.ok(!offered.includes('tabs'));

  const state = await getState(port);
  assert.equal(state.task, null);
});

test('run_js refuses cookie and stored-token reads before touching the page', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test', agent: { mode: 'playground', stepLimit: 8, trustedSites: [] } },
    servePage: true,
    responses: [
      () => toolCall('run_js', JSON.stringify({ code: 'document["cookie"]' })),
      () => textReply('I cannot read cookies.'),
    ],
  });
  const port = openPort(worker.chrome);
  const from = port.received.length;
  port.send({ t: 'chat.send', text: 'read the cookies' });
  await idle(port, from);

  assert.equal(
    port.received.some((message) => message.e?.kind === 'confirm'),
    false,
    'a refusal is not a question',
  );
  assert.equal(worker.debugCalls.length, 0, 'the page was never touched');

  const state = await getState(port);
  const tool = state.session.messages.find((message) => message.role === 'tool');
  assert.equal(tool.tool.status, 'failed');
  assert.equal(tool.tool.code, 'forbidden');
  assert.match(tool.text, /cookies/i);
});

test('run_js results are masked before the next request sees them', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test', agent: { mode: 'playground', stepLimit: 8, trustedSites: [] } },
    servePage: true,
    attachSucceeds: true,
    evaluateValue: { SID: 'abc123def456', sessionToken: 'sess_1234567890', title: 'Example page' },
    responses: [
      () => toolCall('run_js', JSON.stringify({ code: '({ title: document.title })' })),
      () => textReply('Read the title.'),
    ],
  });
  const port = openPort(worker.chrome);
  const from = port.received.length;
  port.send({ t: 'chat.send', text: 'read the page title' });

  const card = await port.waitFor((message) => message.e?.kind === 'confirm');
  port.send({ t: 'confirm.respond', id: card.e.request.id, allow: true });
  await idle(port, from);

  const state = await getState(port);
  const tool = state.session.messages.find((message) => message.role === 'tool');
  assert.equal(tool.tool.status, 'done');
  assert.doesNotMatch(tool.text, /abc123def456|sess_1234567890/);
  assert.match(tool.text, /\[redacted\]/);

  const sent = worker.fetches[1].body.messages.find((message) => message.role === 'tool');
  assert.ok(sent, 'the result went back to the model');
  assert.doesNotMatch(sent.content, /abc123def456|sess_1234567890/);
});

test('clipboard reads are masked before the model sees them', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test', agent: { mode: 'playground', stepLimit: 8, trustedSites: [] } },
    servePage: true,
    clipboardText: 'Cookie: SID=abc123def456\nsessionid=deadbeefcafe; theme=dark',
    responses: [
      () => toolCall('browser', JSON.stringify({ action: 'clipboard_read' })),
      () => textReply('The clipboard held cookies.'),
    ],
  });
  const port = openPort(worker.chrome);
  const from = port.received.length;
  port.send({ t: 'chat.send', text: 'read the clipboard' });

  const card = await port.waitFor((message) => message.e?.kind === 'confirm');
  port.send({ t: 'confirm.respond', id: card.e.request.id, allow: true });
  await idle(port, from);

  const state = await getState(port);
  const tool = state.session.messages.find((message) => message.role === 'tool');
  assert.equal(tool.tool.status, 'done');
  assert.doesNotMatch(tool.text, /abc123def456|deadbeefcafe/);
  assert.match(tool.text, /redacted/i);
});

test('a Playground task opens a background tab without asking', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test', agent: { mode: 'playground', stepLimit: 8, trustedSites: [] } },
    servePage: true,
    responses: [
      () => toolCall('tabs', JSON.stringify({ action: 'open', url: 'https://example.com/new' })),
      () => textReply('Opened it in the background.'),
    ],
  });
  const port = openPort(worker.chrome);
  const from = port.received.length;
  port.send({ t: 'chat.send', text: 'open https://example.com/new in a new tab' });
  await idle(port, from);

  assert.deepEqual(worker.opens, [{ url: 'https://example.com/new', active: false }]);
  assert.equal(port.received.some((message) => message.e?.kind === 'confirm'), false);
  const tool = (await getState(port)).session.messages.find((message) => message.role === 'tool');
  assert.equal(tool.tool.status, 'done');
  assert.match(tool.text, /background/i);
});

test('Ask mode asks before opening a tab, and a denial opens nothing', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test', agent: { mode: 'ask', stepLimit: 8, trustedSites: [] } },
    servePage: true,
    responses: [
      () => toolCall('tabs', JSON.stringify({ action: 'open', url: 'https://example.com/new' })),
      () => textReply('I did not open it.'),
    ],
  });
  const port = openPort(worker.chrome);
  const from = port.received.length;
  port.send({ t: 'chat.send', text: 'open https://example.com/new in a new tab' });

  const card = await port.waitFor((message) => message.e?.kind === 'confirm');
  assert.match(card.e.request.summary, /^Open a tab/);
  port.send({ t: 'confirm.respond', id: card.e.request.id, allow: false });
  await idle(port, from);

  assert.deepEqual(worker.opens, []);
  const tool = (await getState(port)).session.messages.find((message) => message.role === 'tool');
  assert.equal(tool.tool.status, 'denied');
});

test('Ask mode asks before writing a bookmark, and a denial writes none', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test', agent: { mode: 'ask', stepLimit: 8, trustedSites: [] } },
    servePage: true,
    responses: [
      () => toolCall('browser', JSON.stringify({ action: 'bookmark', url: 'https://example.com/new' })),
      () => textReply('I did not bookmark it.'),
    ],
  });
  const port = openPort(worker.chrome);
  const from = port.received.length;
  port.send({ t: 'chat.send', text: 'bookmark https://example.com/new' });

  const card = await port.waitFor((message) => message.e?.kind === 'confirm');
  assert.match(card.e.request.summary, /bookmark example\.com/);
  port.send({ t: 'confirm.respond', id: card.e.request.id, allow: false });
  await idle(port, from);

  assert.deepEqual(worker.bookmarksCreated, []);
  const tool = (await getState(port)).session.messages.find((message) => message.role === 'tool');
  assert.equal(tool.tool.status, 'denied');
});

test('a screenshot rides the attached capture session instead of attaching twice', async (t) => {
  const worker = await loadWorker(t, {
    settings: { apiKey: 'gsk_test', agent: { mode: 'playground', stepLimit: 8, trustedSites: [] } },
    servePage: true,
    attachSucceeds: true,
    responses: [() => toolCall('screenshot', '{}'), () => textReply('Here it is.')],
  });
  const port = openPort(worker.chrome);
  const from = port.received.length;
  port.send({ t: 'chat.send', text: 'take a screenshot', capture: true });
  await idle(port, from);

  assert.equal(worker.attachCalls(), 1, 'the screenshot attached a second debugger');
  assert.deepEqual(worker.detaches, [1], 'the capture session was not detached exactly once');
  assert.ok(worker.debugCalls.some((call) => call.method === 'Page.captureScreenshot'));
  const tool = (await getState(port)).session.messages.find((message) => message.tool?.name === 'screenshot');
  assert.equal(tool.tool.status, 'done');
  assert.match(tool.text, /cannot see images/);
});

test('a trusted site skips the click prompt even in Ask mode', async (t) => {
  const worker = await loadWorker(t, {
    settings: {
      apiKey: 'gsk_test',
      agent: { mode: 'ask', stepLimit: 8, trustedSites: ['example.com'] },
    },
    servePage: true,
    responses: [() => toolCall('click', '{"ref":"e1"}'), () => textReply('Clicked.')],
  });
  const port = openPort(worker.chrome);
  const from = port.received.length;
  port.send({ t: 'chat.send', text: 'click it' });
  await idle(port, from);

  assert.equal(
    port.received.some((message) => message.e?.kind === 'confirm'),
    false,
    'nothing asked',
  );
  assert.equal(worker.actions.length, 1);
});
