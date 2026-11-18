/**
 * ATOM content agent — injected on demand into one tab, in the isolated world.
 *
 * It does two jobs: describe the page (text, headings, interactive elements with
 * stable refs) and perform one action at a time on those refs. It never runs
 * every page: nothing is injected until the user has granted access to this
 * site and the model actually asks to read or act.
 *
 * Everything returned is data for the model, never instructions.
 */
(() => {
  if (globalThis.__ATOM_AGENT__) return;

  const MAX_ELEMENTS = 120;
  const MAX_TEXT = 7000;
  const MAX_NAME = 90;

  const state = { refs: new Map(), seq: 0 };
  globalThis.__ATOM_AGENT__ = state;

  const SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  /* ------------------------------------------------------------- describing */

  function refFor(element) {
    for (const [ref, node] of state.refs) {
      if (node === element) return ref;
    }
    const ref = `e${(state.seq += 1)}`;
    state.refs.set(ref, element);
    return ref;
  }

  function isVisible(element) {
    if (!element || !(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) return false;
    return true;
  }

  function clean(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function nameOf(element) {
    const aria = clean(element.getAttribute('aria-label'));
    if (aria) return aria.slice(0, MAX_NAME);

    const labelledBy = clean(element.getAttribute('aria-labelledby'));
    if (labelledBy) {
      const text = clean(
        labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || '')
          .join(' '),
      );
      if (text) return text.slice(0, MAX_NAME);
    }

    if (element.id) {
      const explicit = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      const text = clean(explicit?.textContent);
      if (text) return text.slice(0, MAX_NAME);
    }

    const wrapping = element.closest('label');
    if (wrapping) {
      const text = clean(wrapping.textContent);
      if (text) return text.slice(0, MAX_NAME);
    }

    const tag = element.tagName;
    if (tag === 'INPUT') {
      const type = (element.type || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        return (clean(element.value) || type).slice(0, MAX_NAME);
      }
    }

    const inner = clean(element.innerText || element.textContent);
    if (inner) return inner.slice(0, MAX_NAME);

    const placeholder = clean(element.getAttribute('placeholder'));
    if (placeholder) return placeholder.slice(0, MAX_NAME);

    const title = clean(element.getAttribute('title'));
    if (title) return title.slice(0, MAX_NAME);

    const alt = clean(element.getAttribute('alt'));
    if (alt) return alt.slice(0, MAX_NAME);

    return tag.toLowerCase();
  }

  function kindOf(element) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'input') {
      const type = (element.type || 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox' || type === 'radio') return 'checkbox';
      return 'input';
    }
    if (element.isContentEditable) return 'editable';
    const role = element.getAttribute('role');
    if (role === 'link') return 'link';
    if (role === 'button') return 'button';
    if (role === 'checkbox' || role === 'radio') return 'checkbox';
    return 'element';
  }

  function pathOf(href) {
    try {
      const url = new URL(href, location.href);
      return url.origin === location.origin ? `${url.pathname}${url.search}` : url.href;
    } catch {
      return '';
    }
  }

  function visibleText() {
    const raw = document.body ? document.body.innerText : '';
    const text = String(raw || '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text.length <= MAX_TEXT) return text;
    return `${text.slice(0, MAX_TEXT)}\n…(page text continues)`;
  }

  function describe() {
    const elements = [];
    const seen = new Set();

    for (const element of document.querySelectorAll(SELECTOR)) {
      if (elements.length >= MAX_ELEMENTS) break;
      if (seen.has(element)) continue;
      seen.add(element);
      if (!isVisible(element)) continue;

      const entry = {
        ref: refFor(element),
        kind: kindOf(element),
        name: nameOf(element),
      };

      if (entry.kind === 'link') {
        const path = pathOf(element.href);
        if (path) entry.href = path;
      }
      if (element.getAttribute('placeholder')) {
        entry.placeholder = clean(element.getAttribute('placeholder')).slice(0, 60);
      }
      if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
        if (element.value && element.type !== 'password') entry.value = clean(element.value).slice(0, 60);
        if (element.type === 'password') entry.secret = true;
      }
      if (element.type === 'checkbox' || element.type === 'radio') entry.checked = Boolean(element.checked);
      if (element.disabled || element.getAttribute('aria-disabled') === 'true') entry.disabled = true;
      if (element.tagName === 'SELECT') {
        entry.options = Array.from(element.options)
          .slice(0, 12)
          .map((option) => clean(option.text).slice(0, 40) || option.value);
      }

      elements.push(entry);
    }

    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .slice(0, 12)
      .map((heading) => ({ level: Number(heading.tagName.slice(1)), text: clean(heading.textContent).slice(0, 90) }))
      .filter((heading) => heading.text);

    const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);

    return {
      ok: true,
      url: location.href,
      title: clean(document.title).slice(0, 160),
      text: visibleText(),
      headings,
      elements,
      scroll: {
        y: Math.round(window.scrollY),
        height: Math.round(height),
        viewport: window.innerHeight,
        percent: height > 0 ? Math.min(100, Math.round((window.scrollY / Math.max(1, height - window.innerHeight)) * 100)) : 0,
      },
      forms: {
        count: document.forms.length,
        password: document.querySelectorAll('input[type="password"]').length > 0,
      },
      truncated: elements.length >= MAX_ELEMENTS,
    };
  }

  /* --------------------------------------------------------------- acting */

  function settle(ms = 260) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Start watching before the action, then wait. Watching afterwards misses
   * pages that update the DOM inside the click handler, which is most of them,
   * and the "nothing changed" answer would then be a lie.
   */
  function watch(ms = 260) {
    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    try {
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    } catch {
      /* detached document */
    }
    return {
      stop: () => observer.disconnect(),
      settle: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            observer.disconnect();
            resolve(mutations);
          }, ms);
        }),
    };
  }

  function scrollState() {
    const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    return {
      y: Math.round(window.scrollY),
      height: Math.round(height),
      viewport: window.innerHeight,
      atBottom: Math.ceil(window.scrollY + window.innerHeight) >= height - 2,
    };
  }

  function writeValue(element, text) {
    if (element.isContentEditable) {
      element.focus();
      element.textContent = text;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      return true;
    }

    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : null;
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
    if (!setter) return false;

    element.focus();
    setter.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function pressEnter(element) {
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    element.dispatchEvent(new KeyboardEvent('keydown', init));
    element.dispatchEvent(new KeyboardEvent('keypress', init));
    element.dispatchEvent(new KeyboardEvent('keyup', init));
    if (typeof element.form?.requestSubmit === 'function') {
      element.form.requestSubmit();
      return 'submitted the form';
    }
    return 'pressed Enter';
  }

  async function act(action) {
    const type = action?.type;

    if (type === 'read') return describe();

    if (type === 'scroll') {
      const direction = action.direction || 'down';
      if (direction === 'top') window.scrollTo({ top: 0, behavior: 'instant' });
      else if (direction === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
      else {
        const step = Math.round(window.innerHeight * 0.85) * (direction === 'up' ? -1 : 1);
        window.scrollBy({ top: step, behavior: 'instant' });
      }
      await settle(160);
      return { ok: true, message: `Scrolled ${direction}.`, scroll: scrollState() };
    }

    const element = state.refs.get(action?.ref);
    if (!element || !element.isConnected) {
      return {
        ok: false,
        code: 'stale',
        message: `Nothing matches ${action?.ref || 'that ref'} any more. Read the page again — refs change when the page does.`,
      };
    }

    const before = location.href;

    if (type === 'click') {
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      if (!isVisible(element)) {
        return { ok: false, code: 'hidden', message: 'That element is not visible, so it was not clicked.' };
      }
      if (element.disabled) {
        return { ok: false, code: 'disabled', message: 'That control is disabled; nothing was clicked.' };
      }
      try {
        element.focus({ preventScroll: true });
      } catch {
        /* not focusable */
      }
      const watcher = watch();
      element.click();
      const mutations = await watcher.settle();

      if (location.href !== before) {
        return { ok: true, message: `Clicked; the page navigated to ${pathOf(location.href) || location.href}.`, url: location.href, navigated: true };
      }
      if (mutations > 0) {
        return { ok: true, message: `Clicked; the page changed (${mutations} DOM update${mutations === 1 ? '' : 's'}).`, url: location.href };
      }
      return {
        ok: true,
        message: 'Clicked, but nothing on the page visibly changed. The control may need a different target, or the page may be waiting on something.',
        url: location.href,
      };
    }

    if (type === 'type') {
      if (element.disabled || element.readOnly) {
        return { ok: false, code: 'disabled', message: 'That field is disabled or read-only.' };
      }
      const text = String(action.text ?? '');
      const watcher = watch();
      if (!writeValue(element, text)) {
        watcher.stop();
        return { ok: false, code: 'unsupported', message: 'That element cannot take typed text.' };
      }
      let note = `Typed ${text.length} character${text.length === 1 ? '' : 's'}.`;
      if (action.submit) note += ` Then ${pressEnter(element)}.`;
      const mutations = await watcher.settle();
      return {
        ok: true,
        message: mutations > 0 ? `${note} The page reacted.` : `${note} The page did not visibly change.`,
        url: location.href,
      };
    }

    if (type === 'select') {
      if (element.tagName !== 'SELECT') {
        return { ok: false, code: 'unsupported', message: 'That element is not a dropdown.' };
      }
      const wanted = String(action.value ?? '').trim();
      const option = Array.from(element.options).find(
        (candidate) => candidate.value === wanted || clean(candidate.text).toLowerCase() === wanted.toLowerCase(),
      );
      if (!option) {
        const options = Array.from(element.options)
          .slice(0, 12)
          .map((candidate) => clean(candidate.text) || candidate.value)
          .join(', ');
        return { ok: false, code: 'option', message: `No option "${wanted}". Available: ${options}.` };
      }
      const watcher = watch();
      element.focus();
      element.value = option.value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      const mutations = await watcher.settle();
      return {
        ok: true,
        message: `Selected "${clean(option.text) || option.value}".${mutations ? ' The page reacted.' : ''}`,
        url: location.href,
      };
    }

    return { ok: false, code: 'unknown_action', message: `Unknown action "${type}".` };
  }

  /* ------------------------------------------------------------ messaging */

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (!message || message.channel !== 'atom') return undefined;

    if (message.type === 'ping') {
      respond({ ok: true });
      return undefined;
    }

    if (message.type === 'read') {
      try {
        respond(describe());
      } catch (error) {
        respond({ ok: false, message: String(error?.message || error) });
      }
      return undefined;
    }

    if (message.type === 'act') {
      act(message.action).then(
        (result) => respond(result),
        (error) => respond({ ok: false, code: 'exception', message: String(error?.message || error) }),
      );
      return true;
    }

    return undefined;
  });
})();
