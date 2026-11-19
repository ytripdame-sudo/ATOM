import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/**
 * The content agent runs inside a page, so these tests give it a small fake DOM:
 * the top document, open shadow roots and same-origin frame documents. It is
 * driven through the same `chrome.runtime.onMessage` entry point the worker uses,
 * which is the part the worker cannot see: what a field is, whether its value is
 * echoed, whether a secret field can be filled without approval, and whether a
 * ref from inside a shadow root or a frame still resolves.
 */
const source = fs.readFileSync(new URL('../extension/content/agent.js', import.meta.url), 'utf8');

class FakeNode {
  constructor({ tag = 'INPUT', type = 'text', attrs = {}, label = '', value = '', interactive = false } = {}) {
    this._tag = tag;
    this._type = type;
    this._attrs = attrs;
    this._label = label;
    this._value = value;
    this._interactive = interactive;
    this._root = null;
    this.ownerDocument = null;
    this.shadowRoot = null;
    this.contentDocument = null;
    this.id = attrs.id || '';
    this.disabled = false;
    this.readOnly = false;
    this.checked = false;
    this.options = [];
  }

  get tagName() {
    return this._tag;
  }

  get type() {
    return this._type;
  }

  get value() {
    return this._value;
  }

  set value(next) {
    this._value = String(next);
  }

  get isContentEditable() {
    return false;
  }

  get isConnected() {
    return true;
  }

  get innerText() {
    return this._label;
  }

  get textContent() {
    return this._label;
  }

  getAttribute(name) {
    return Object.hasOwn(this._attrs, name) ? String(this._attrs[name]) : null;
  }

  getRootNode() {
    return this._root || this.ownerDocument;
  }

  matches() {
    return this._interactive;
  }

  getBoundingClientRect() {
    return { width: 120, height: 24 };
  }

  closest() {
    return null;
  }

  focus() {}

  click() {}

  dispatchEvent(event) {
    (this.events ??= []).push(event);
    return true;
  }

  scrollIntoView() {}
}

/** An open shadow root, as `element.shadowRoot` hands it over. */
const shadowRoot = (nodes) => ({
  _nodes: nodes,
  querySelectorAll: (selector) => (selector === '*' ? nodes : []),
  querySelector: () => null,
});

/** A same-origin frame document, as `iframe.contentDocument` hands it over. */
const frameDocument = (nodes, innerText = '') => ({
  _nodes: nodes,
  documentElement: {},
  body: { innerText },
  location: { href: 'https://shop.example/frame' },
  querySelectorAll: (selector) => (selector === '*' ? nodes : []),
  querySelector: () => null,
  getElementById: () => null,
});

class FakeObserver {
  observe() {}
  disconnect() {}
}

class FakeEvent {}

function load(topNodes) {
  const listeners = [];
  const commands = [];
  const document = {
    title: 'Checkout',
    execCommand: (command, _show, value) => {
      commands.push({ command, value });
      return true;
    },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    createRange: () => ({ selectNodeContents() {} }),
    body: { innerText: 'Pay for your order', scrollHeight: 1400 },
    documentElement: { scrollHeight: 1400 },
    location: { href: 'https://shop.example/checkout' },
    querySelectorAll: (selector) => (selector === '*' ? topNodes : []),
    querySelector: () => null,
    getElementById: () => null,
  };

  // Every node needs its document, and its root when it lives in a shadow root.
  const attach = (node, doc, root) => {
    node.ownerDocument ??= doc;
    node._root ??= root;

    if (node.shadowRoot) {
      for (const child of node.shadowRoot._nodes) attach(child, doc, node.shadowRoot);
    }

    let frame = null;
    try {
      frame = node.contentDocument;
    } catch {
      frame = null;
    }
    if (frame) {
      for (const child of frame._nodes) attach(child, frame, frame);
    }
  };
  for (const node of topNodes) attach(node, document, document);

  const sandbox = {
    chrome: { runtime: { onMessage: { addListener: (fn) => listeners.push(fn) } } },
    document,
    window: { scrollY: 0, innerHeight: 800, scrollTo() {}, scrollBy() {} },
    location: { href: 'https://shop.example/checkout', origin: 'https://shop.example' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    CSS: { escape: (value) => String(value) },
    Element: FakeNode,
    HTMLInputElement: FakeNode,
    HTMLTextAreaElement: class extends FakeNode {},
    MutationObserver: FakeObserver,
    Event: FakeEvent,
    InputEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    URL,
    setTimeout,
    clearTimeout,
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'content/agent.js' });
  assert.equal(listeners.length, 1, 'the agent registers one message listener');

  const handler = listeners[0];

  const read = () => {
    let page = null;
    handler({ channel: 'atom', type: 'read' }, null, (value) => {
      page = value;
    });
    return page;
  };

  const act = (action) =>
    new Promise((resolve) => {
      handler({ channel: 'atom', type: 'act', action }, null, resolve);
    });

  return { read, act, commands };
}

/** A composer like Discord's: a contenteditable div, not an input. */
class EditableNode extends FakeNode {
  constructor(options) {
    super({ ...options, tag: 'DIV' });
    this._text = '';
  }

  get isContentEditable() {
    return true;
  }

  get textContent() {
    return this._text;
  }

  set textContent(value) {
    this._text = String(value);
  }
}

const password = () =>
  new FakeNode({ tag: 'INPUT', type: 'password', attrs: { name: 'password' }, value: 'hunter2', interactive: true });
const card = () =>
  new FakeNode({ tag: 'INPUT', attrs: { autocomplete: 'cc-number', name: 'cardnumber' }, interactive: true });
const expiry = () => new FakeNode({ tag: 'INPUT', attrs: { 'aria-label': 'Expiry date' }, interactive: true });
const otp = () =>
  new FakeNode({ tag: 'INPUT', attrs: { inputmode: 'numeric', 'aria-label': 'Verification code' }, interactive: true });
const cvc = () => new FakeNode({ tag: 'INPUT', attrs: { placeholder: 'CVC' }, interactive: true });
const search = () => new FakeNode({ tag: 'INPUT', attrs: { 'aria-label': 'Search' }, value: 'shoes', interactive: true });

function iframeWith(nodes, text = '') {
  const frame = new FakeNode({ tag: 'IFRAME' });
  frame.contentDocument = frameDocument(nodes, text);
  return frame;
}

/* --------------------------------------------------------------- fields */

test('password, card and one-time-code fields are recognised', () => {
  const nodes = [password(), card(), expiry(), otp(), cvc(), search()];
  const page = load(nodes).read();
  const kinds = page.elements.map((element) => element.sensitive || '');

  assert.equal(kinds.join(','), 'password,card,card,otp,card,');
  assert.equal(page.forms.sensitive, true);
});

test('a secret field value is never echoed back, a normal one is', () => {
  const nodes = [password(), search()];
  const page = load(nodes).read();

  assert.equal(page.elements[0].value, undefined, 'the password value stays on the page');
  assert.equal(page.elements[0].sensitive, 'password');
  assert.equal(page.elements[1].value, 'shoes');
});

test('a password field inside a frame still counts', () => {
  const page = load([iframeWith([password()])]).read();

  assert.equal(page.forms.password, true);
  assert.equal(page.forms.sensitive, true);
  assert.equal(page.frames, 1);
});

/* --------------------------------------------------------- shadow + frames */

test('open shadow roots and same-origin frames are walked with labelled refs', () => {
  const button = new FakeNode({ tag: 'BUTTON', label: 'Pay', interactive: true });
  const host = new FakeNode({ tag: 'DIV' });
  host.shadowRoot = shadowRoot([button]);

  const page = load([host, iframeWith([search(), card()])]).read();

  assert.equal(page.elements.length, 3);
  assert.match(page.elements[0].ref, /^f1:e\d+$/);
  assert.equal(page.elements[0].name, 'Pay');
  assert.match(page.elements[1].ref, /^f2:e\d+$/);
  assert.match(page.elements[2].ref, /^f2:e\d+$/);
  assert.equal(page.elements[2].sensitive, 'card');
  assert.equal(page.frames, 2);
});

test('a click inside a shadow root resolves and reports the page url', async () => {
  const button = new FakeNode({ tag: 'BUTTON', label: 'Pay', interactive: true });
  const host = new FakeNode({ tag: 'DIV' });
  host.shadowRoot = shadowRoot([button]);

  const { read, act } = load([host]);
  const [entry] = read().elements;
  const result = await act({ type: 'click', ref: entry.ref });

  assert.equal(result.ok, true);
  assert.match(result.url, /shop\.example\/checkout/);
});

test('typing inside a frame resolves and reports the frame url', async () => {
  const field = search();
  const { read, act } = load([iframeWith([field], 'Search the catalogue')]);
  const [entry] = read().elements;

  assert.match(entry.ref, /^f1:e\d+$/);
  const result = await act({ type: 'type', ref: entry.ref, text: 'boots' });

  assert.equal(result.ok, true);
  assert.equal(field.value, 'boots');
  assert.match(result.url, /shop\.example\/frame/);
});

test('a secret field inside a frame is still refused without approval', async () => {
  const field = card();
  const { read, act } = load([iframeWith([field])]);
  const [entry] = read().elements;

  const refused = await act({ type: 'type', ref: entry.ref, text: '4242' });
  assert.equal(refused.code, 'sensitive_field');
  assert.equal(refused.sensitive, 'card');
  assert.equal(field.value, '');
});

test('frame text and headings are part of the description', () => {
  const heading = new FakeNode({ tag: 'H1', label: 'Order summary' });
  const page = load([iframeWith([heading], 'Enter your card details')]).read();

  assert.match(page.text, /Pay for your order/);
  assert.match(page.text, /Enter your card details/);
  assert.equal(page.headings.map((heading) => `H${heading.level} ${heading.text}`).join('|'), 'H1 Order summary');
});

test('cross-origin and throwing frames are skipped, never fatal', () => {
  const cross = new FakeNode({ tag: 'IFRAME' }); // contentDocument is null
  const denied = new FakeNode({ tag: 'IFRAME' });
  Object.defineProperty(denied, 'contentDocument', {
    get() {
      throw new Error('SecurityError');
    },
  });

  const empty = load([cross]).read();
  const blocked = load([denied]).read();

  assert.equal(empty.ok, true);
  assert.equal(empty.elements.length, 0);
  assert.equal(empty.frames, 0);
  assert.equal(blocked.ok, true);
  assert.equal(blocked.elements.length, 0);
  assert.equal(blocked.frames, 0);
});

/* -------------------------------------------------------------- the floor */

test('typing into a secret field is refused without an approval', async () => {
  const field = password();
  const { read, act } = load([field]);
  const [ref] = read().elements;

  const refused = await act({ type: 'type', ref: ref.ref, text: 'hunter3' });

  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'sensitive_field');
  assert.equal(refused.sensitive, 'password');
  assert.equal(field.value, 'hunter2', 'nothing was written');
});

test('every secret kind is refused, and a plain field is not', async () => {
  for (const make of [password, card, otp]) {
    const field = make();
    const before = field.value;
    const { read, act } = load([field]);
    const [ref] = read().elements;
    const refused = await act({ type: 'type', ref: ref.ref, text: 'x' });
    assert.equal(refused.code, 'sensitive_field', ref.sensitive);
    assert.equal(field.value, before, 'nothing was written');
  }

  const field = search();
  const { read, act } = load([field]);
  const [ref] = read().elements;
  const allowed = await act({ type: 'type', ref: ref.ref, text: 'boots' });

  assert.equal(allowed.ok, true);
  assert.equal(field.value, 'boots');
});

test('an approved secret field is filled', async () => {
  const field = password();
  const { read, act } = load([field]);
  const [ref] = read().elements;

  const result = await act({ type: 'type', ref: ref.ref, text: 'hunter3', confirmed: true });

  assert.equal(result.ok, true);
  assert.equal(field.value, 'hunter3');
});

test('a contenteditable composer is filled with a real editing command', async () => {
  const composer = new EditableNode({ attrs: { role: 'textbox', 'aria-label': 'Message', contenteditable: 'true' }, interactive: true });
  const page = load([composer]);
  const element = page.read().elements[0];

  const result = await page.act({ type: 'type', ref: element.ref, text: 'hi there' });

  assert.equal(result.ok, true);
  assert.deepEqual(page.commands.at(-1), { command: 'insertText', value: 'hi there' });
  assert.equal(composer.events, undefined, 'the command already fired the input event, so none is doubled');
});
