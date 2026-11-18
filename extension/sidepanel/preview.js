/**
 * Design-preview transport.
 *
 * The panel is a normal HTML page here, so there is no service worker and no
 * model. This mirrors the worker's protocol closely enough to exercise every
 * piece of the UI — streaming, a tool trace, and a permission card — while
 * saying plainly, in the transcript, that it is canned.
 */
import { providerMeta } from '../lib/providers/index.js';

const SETTINGS_KEY = 'atom.preview.settings';

const DEFAULT_SETTINGS = {
  provider: 'groq',
  model: 'openai/gpt-oss-120b',
  hasKey: false,
  instructions: '',
  theme: 'system',
  attachTab: true,
  autonomy: 'balanced',
};

const DEMO_HOST = 'example.com';

const INTRO = [
  '**Preview demo.** This is the ATOM panel running as a plain page, so nothing here reaches Groq and no page is really read — the text and the tool trace below are canned.',
  '',
  'In the extension this is what happens: ATOM calls `read_page`, decides what to click, and stops to ask before it changes anything.',
].join('\n');

const AFTER_READ = 'The page has a “Get started” button. I would click it — which needs your permission first.';

const AFTER_ALLOW =
  'Clicked, and the page changed. That is the whole loop: read, act, check what actually happened. In the extension those steps are real DOM reads and real clicks.';

const AFTER_DENY =
  'Fair enough — nothing was clicked. I would ask what you want instead, or read another part of the page.';

export function createPreviewTransport() {
  document.documentElement.dataset.mode = 'preview';

  const handlers = new Set();
  let settings = readSettings();
  let session = emptySession();
  let timer = 0;
  let pending = null;
  let confirmTimer = 0;

  const emit = (event) => {
    for (const handler of handlers) handler({ t: 'evt', e: event });
  };
  // Hidden tabs get their timers throttled, sometimes to once a minute. The
  // demo is a scripted walkthrough, so it hops microtasks there instead.
  const soon = (fn, delay = 0) => (document.hidden ? queueMicrotask(fn) : setTimeout(fn, delay));
  const replyLater = (payload, delay = 20) => {
    soon(() => {
      for (const handler of handlers) handler(payload);
    }, delay);
  };

  function handle(message) {
    switch (message?.t) {
      case 'hello':
        return replyLater(
          {
            t: 'state',
            session,
            settings: publicView(),
            meta: providerMeta(),
            tab: null,
            capabilities: { pageAccess: false, host: '', origin: null },
            busy: Boolean(timer || pending),
            confirm: pending?.request || null,
          },
          30,
        );
      case 'chat.send':
        return send(String(message.text || ''));
      case 'chat.stop':
        return stop();
      case 'chat.retry':
        return retry();
      case 'chat.new':
        return newChat();
      case 'settings.update':
        return updateSettings(message.patch);
      case 'settings.verify':
        return emit({ kind: 'keycheck', state: settings.hasKey ? 'unknown' : 'none' });
      case 'tab.context':
        return emit({ kind: 'tab', tab: null, capabilities: { pageAccess: false, host: '', origin: null } });
      case 'capabilities.refresh':
        return emit({ kind: 'capabilities', capabilities: { pageAccess: false, host: '', origin: null } });
      case 'confirm.respond':
        return answerConfirmation(message);
      default:
        return undefined;
    }
  }

  /* ------------------------------------------------------------- the demo */

  function send(text) {
    const clean = String(text || '').trim();
    if (!clean || timer) return;

    const user = { id: uid(), role: 'user', text: clean, ts: Date.now(), status: 'done' };
    session.messages.push(user);
    if (!session.title) session.title = clean.length > 48 ? `${clean.slice(0, 48)}…` : clean;
    emit({ kind: 'added', message: user, title: session.title });

    emit({ kind: 'busy', busy: true });
    const intro = newMessage('assistant', '', { status: 'streaming' });
    streamInto(intro, INTRO, () => runToolDemo());
  }

  function runToolDemo() {
    const read = newMessage('tool', 'demo', {
      toolCallId: 'demo_read',
      name: 'read_page',
      tool: { name: 'read_page', summary: 'Read the page', status: 'running', detail: '', host: DEMO_HOST },
    });

    soon(() => {
      read.tool = { ...read.tool, status: 'done', detail: '24 elements' };
      emit({ kind: 'toolUpdate', id: read.id, tool: read.tool });

      const step = newMessage('assistant', '', { status: 'streaming' });
      streamInto(step, AFTER_READ, () => askToClick());
    }, 650);
  }

  function askToClick() {
    const click = newMessage('tool', 'demo', {
      toolCallId: 'demo_click',
      name: 'click',
      tool: { name: 'click', summary: 'Click “Get started”', status: 'running', detail: '', host: DEMO_HOST },
    });

    const id = `demo_${Date.now().toString(36)}`;
    const request = { id, tool: 'click', summary: 'Click “Get started”', host: DEMO_HOST, messageId: click.id };

    pending = {
      id,
      request,
      resolve: (allowed) => {
        clearTimeout(confirmTimer);
        pending = null;
        emit({ kind: 'confirmResolved', id, allowed });

        click.tool = {
          ...click.tool,
          status: allowed ? 'done' : 'denied',
          detail: allowed ? 'Clicked; the page changed (12 DOM updates).' : 'The user denied this action.',
        };
        emit({ kind: 'toolUpdate', id: click.id, tool: click.tool });

        const answer = newMessage('assistant', '', { status: 'streaming' });
        streamInto(answer, allowed ? AFTER_ALLOW : AFTER_DENY, () => emit({ kind: 'busy', busy: false }));
      },
    };

    confirmTimer = setTimeout(() => pending?.resolve(false), 120000);
    soon(() => emit({ kind: 'confirm', request }));
  }

  function answerConfirmation(message) {
    if (!pending || pending.id !== message?.id) return;
    pending.resolve(Boolean(message.allow));
  }

  /* ----------------------------------------------------------- primitives */

  function newMessage(role, text, extra = {}) {
    const message = { id: uid(), role, text, ts: Date.now(), status: 'done', ...extra };
    session.messages.push(message);
    emit({ kind: 'added', message });
    return message;
  }

  function streamInto(message, text, done) {
    message.text = '';
    let index = 0;
    if (document.hidden) {
      // Nobody is watching the animation, so skip straight to the result.
      message.text = text;
      message.status = 'done';
      emit({ kind: 'delta', id: message.id, text });
      emit({ kind: 'done', id: message.id, text, toolCalls: 0 });
      soon(done);
      return;
    }
    timer = setInterval(() => {
      const step = 3 + Math.floor(Math.random() * 6);
      const piece = text.slice(index, index + step);
      index += step;
      if (!piece) {
        clearInterval(timer);
        timer = 0;
        message.status = 'done';
        emit({ kind: 'done', id: message.id, text: message.text, toolCalls: 0 });
        done?.();
        return;
      }
      message.text += piece;
      emit({ kind: 'delta', id: message.id, text: piece });
    }, 26);
  }

  function stop() {
    clearInterval(timer);
    timer = 0;
    if (pending) pending.resolve(false);
    const last = session.messages[session.messages.length - 1];
    if (last?.role === 'assistant' && last.status === 'streaming') {
      last.status = 'done';
      if (last.text) emit({ kind: 'done', id: last.id, text: last.text, stopped: true });
      else {
        session.messages.pop();
        emit({ kind: 'removed', id: last.id });
      }
    }
    emit({ kind: 'busy', busy: false });
  }

  function retry() {
    if (timer) return;
    while (session.messages.length) {
      const last = session.messages[session.messages.length - 1];
      if (last.role === 'assistant' || last.role === 'tool') {
        session.messages.pop();
        emit({ kind: 'removed', id: last.id });
      } else break;
    }
    const lastUser = [...session.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    emit({ kind: 'busy', busy: true });
    const intro = newMessage('assistant', '', { status: 'streaming' });
    streamInto(intro, INTRO, () => runToolDemo());
  }

  function newChat() {
    clearInterval(timer);
    timer = 0;
    pending = null;
    clearTimeout(confirmTimer);
    session = emptySession();
    emit({ kind: 'session', session });
    emit({ kind: 'busy', busy: false });
  }

  function updateSettings(patch) {
    if (!patch || typeof patch !== 'object') return;
    const next = { ...settings };

    if (typeof patch.apiKey === 'string') next.hasKey = Boolean(patch.apiKey.trim());
    if (typeof patch.instructions === 'string') next.instructions = patch.instructions;
    if (typeof patch.attachTab === 'boolean') next.attachTab = patch.attachTab;
    if (typeof patch.model === 'string') next.model = patch.model;
    if (['system', 'dark', 'light'].includes(patch.theme)) next.theme = patch.theme;
    if (['assisted', 'balanced', 'autonomous'].includes(patch.autonomy)) next.autonomy = patch.autonomy;

    settings = next;
    writeSettings(settings);
    emit({ kind: 'settings', settings: publicView() });

    if (typeof patch.apiKey === 'string') {
      emit({ kind: 'keycheck', state: settings.hasKey ? 'unknown' : 'none', detail: 'Preview mode does not verify keys.' });
    }
  }

  function publicView() {
    return { ...settings };
  }

  return {
    send(message) {
      handle(message);
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      clearInterval(timer);
      timer = 0;
      clearTimeout(confirmTimer);
    },
  };
}

function emptySession() {
  return { id: uid(), title: '', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
}

function readSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    return { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode */
  }
}

function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
