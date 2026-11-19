/**
 * Real mouse and keyboard events through the DevTools protocol.
 *
 * A script click is enough almost everywhere. Where it is not — canvas apps,
 * players, some editors — a click that never reaches the browser's input layer
 * leaves no trace, and the model retries forever. This is the second strategy:
 * the same click the user would make, at the element's coordinates.
 *
 * The debugger is attached for the duration of one action and detached again.
 * If console capture already holds the session, its commands are reused rather
 * than fighting over the browser's single debugger slot.
 */

const VERSION = '1.3';

const MODIFIERS = {
  alt: 1,
  option: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  win: 4,
  shift: 8,
};

const KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

/**
 * "Control+Shift+T" → the two CDP events that type it. Exported because key
 * parsing is exactly the kind of thing that should not be debugged in a browser.
 */
export function keyEventParams(chord) {
  const parts = String(chord || '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.length) return null;
  const name = parts.pop();
  let modifiers = 0;
  for (const part of parts) modifiers |= MODIFIERS[part.toLowerCase()] || 0;

  const lower = name.toLowerCase();
  const known = KEYS[lower];
  let key = known?.key;
  let code = known?.code;
  let keyCode = known?.keyCode;
  let text = known?.text || '';

  if (!known) {
    if (name.length !== 1) return null;
    const upper = name.toUpperCase();
    key = modifiers & 8 ? upper : name.toLowerCase();
    code = /[a-z]/i.test(name) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : '';
    keyCode = upper.charCodeAt(0);
    if (!modifiers) text = name;
  }

  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  return {
    down: { type: 'keyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) },
    up: { type: 'keyUp', ...base },
  };
}

export function createTrustedInput({ shared = null } = {}) {
  async function withSession(tabId, work) {
    // Console capture already holds the debugger for this tab, so its session
    // is used as-is; attaching twice is refused by the browser.
    if (shared?.send) return work((method, params) => shared.send(method, params));

    await chrome.debugger.attach({ tabId }, VERSION);
    try {
      return await work((method, params) => chrome.debugger.sendCommand({ tabId }, method, params));
    } finally {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        /* the tab may be gone; the action still happened */
      }
    }
  }

  return {
    async click(tabId, x, y) {
      return withSession(tabId, async (send) => {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        return true;
      });
    },

    async type(tabId, text) {
      return withSession(tabId, async (send) => {
        await send('Input.insertText', { text: String(text ?? '') });
        return true;
      });
    },

    async key(tabId, chord) {
      const events = keyEventParams(chord);
      if (!events) throw new Error(`"${chord}" is not a key or chord ATOM can press.`);
      return withSession(tabId, async (send) => {
        await send('Input.dispatchKeyEvent', events.down);
        await send('Input.dispatchKeyEvent', events.up);
        return true;
      });
    },

    /**
     * One expression in the page's own JavaScript context, via the debugger so
     * a strict CSP does not turn it into a no-op. The result must be JSON-safe.
     */
    async evaluate(tabId, expression) {
      return withSession(tabId, async (send) => {
        const result = await send('Runtime.evaluate', {
          expression: String(expression),
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        });
        if (result?.exceptionDetails) {
          const description =
            result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'The expression threw.';
          throw new Error(String(description).split('\n')[0]);
        }
        return result?.result?.value;
      });
    },

    /**
     * A picture of the tab, background tabs included, as a data URL. JPEG is
     * used when the picture will travel to a model: a screenshot is page data,
     * not an archive, and a smaller image keeps the context cheap.
     */
    async screenshot(tabId, { format = 'png', quality = 70 } = {}) {
      return withSession(tabId, async (send) => {
        await send('Page.enable', {});
        const params = { format, fromSurface: true };
        if (format === 'jpeg') params.quality = quality;
        const result = await send('Page.captureScreenshot', params);
        if (!result?.data) throw new Error('The browser returned no image.');
        return `data:image/${format === 'jpeg' ? 'jpeg' : 'png'};base64,${result.data}`;
      });
    },

    /** The centre of an element in viewport pixels, for the mouse events above. */
    async point(tabId, ref) {
      const result = await chrome.tabs.sendMessage(tabId, { channel: 'atom', type: 'rect', ref: String(ref || '') });
      if (!result?.ok) throw new Error(result?.message || 'That element could not be located on the page.');
      return { x: result.x, y: result.y };
    },
  };
}
