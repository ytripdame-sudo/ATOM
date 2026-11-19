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
  // Shadow roots and frames are walked too, but not without a limit.
  const MAX_ROOTS = 20;

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

  /**
   * A ref names the root it came from: `e7` in the top document, `f1:e7` inside
   * the first shadow root or frame discovered. The prefix is for the model (it
   * says where the element lives); resolution is by this map, so a ref from any
   * root lands on the same node from click and type.
   */
  function refFor(element, label) {
    for (const [ref, node] of state.refs) {
      if (node === element) return ref;
    }
    const ref = `${label ? `${label}:` : ''}e${(state.seq += 1)}`;
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
      // The label lives in the same tree, which may be a shadow root or a frame.
      const tree = element.getRootNode?.() || document;
      const explicit = tree.querySelector ? tree.querySelector(`label[for="${CSS.escape(element.id)}"]`) : null;
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

  /**
   * The accessibility-style role the model should reason with. It is the same
   * shape as kind, but says textbox/combobox where the DOM says input/select.
   */
  function roleOf(element, kind) {
    if (kind === 'input' || kind === 'textarea' || kind === 'editable') return 'textbox';
    if (kind === 'select') return 'combobox';
    if (kind === 'element') {
      const role = element.getAttribute('role');
      if (role) return clean(role).toLowerCase();
    }
    return kind;
  }

  /* ---------------------------------------------------- controlling badge */

  let controlHost = null;
  let highlightNode = null;
  let highlightTimer = 0;

  /**
   * A closed shadow root so a page script cannot restyle or read the badge.
   * It says only that ATOM is working here; it is not a place for page text.
   */
  function setControl(on, label = 'ATOM is controlling this tab') {
    if (!on) {
      controlHost?.remove();
      controlHost = null;
      highlight(null);
      return;
    }

    if (!controlHost) {
      controlHost = document.createElement('div');
      controlHost.setAttribute('data-atom-control', '');
      controlHost.style.cssText =
        'position:fixed;top:12px;right:12px;z-index:2147483646;pointer-events:none;contain:layout style;';
      const root = controlHost.attachShadow({ mode: 'closed' });
      const badge = document.createElement('div');
      badge.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:7px 11px;border-radius:999px;color:#eaf0ff;' +
        'background:rgba(12,16,28,.82);border:1px solid rgba(122,162,255,.55);backdrop-filter:blur(8px);' +
        'font:600 12px/1.2 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.28)';
      const dot = document.createElement('span');
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#7aa2ff;box-shadow:0 0 10px #7aa2ff';
      const text = document.createElement('span');
      text.textContent = label;
      badge.append(dot, text);
      root.append(badge);
      (document.body || document.documentElement).append(controlHost);
    }
  }

  /** A ring around the element about to be acted on, gone in a moment. */
  function highlight(element) {
    try {
      drawHighlight(element);
    } catch {
      /* decoration must never fail an action */
    }
  }

  function drawHighlight(element) {
    clearTimeout(highlightTimer);
    highlightNode?.remove();
    highlightNode = null;
    if (!element || !element.isConnected || !element.getBoundingClientRect) return;

    const rect = element.getBoundingClientRect();
    const ring = document.createElement('div');
    ring.setAttribute('data-atom-highlight', '');
    ring.style.cssText = `position:fixed;left:${Math.max(0, rect.left - 3)}px;top:${Math.max(0, rect.top - 3)}px;` +
      `width:${Math.max(2, rect.width + 6)}px;height:${Math.max(2, rect.height + 6)}px;` +
      'border:2px solid rgba(122,162,255,.9);border-radius:7px;box-shadow:0 0 0 4px rgba(122,162,255,.16);' +
      'pointer-events:none;z-index:2147483645;transition:opacity .25s ease;';
    (document.body || document.documentElement).append(ring);
    highlightNode = ring;
    highlightTimer = setTimeout(() => {
      ring.style.opacity = '0';
      setTimeout(() => ring.remove(), 260);
    }, 900);
  }

  /* -------------------------------------------------------- secret fields */

  // Sites label these fields in every shape the web allows, so the hints below
  // read the type, the autocomplete token, the name, the id, the placeholder and
  // whichever label the element actually has.
  const PASSWORD_HINT = /\bpass(word|wd|phrase)?\b|\bpin\b|\bsecret\b/i;
  const CARD_HINT = /\bcard\b|card[-_ ]?(number|num|no|holder|exp|cvc|cvv|csc|code)|cc[-_ ]?(num|number|name|exp|cvc|cvv|csc)|cvv|cvc|csc|cardholder|expir(y|ation)|credit\s*card|debit\s*card/i;
  const OTP_HINT = /\botp\b|one[-_ ]?time|authenticator|\b2fa\b|\bmfa\b|verification code|verify code|security code|sms code|passcode|confirm(ation)? code|auth code/i;

  /** "password" | "card" | "otp" | '' — what kind of secret this field takes. */
  function sensitiveOf(element) {
    if (!element) return '';
    const field = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable;
    if (!field) return '';

    const autocomplete = clean(element.getAttribute('autocomplete')).toLowerCase();
    if (autocomplete.includes('cc-')) return 'card';
    if ((element.type || '').toLowerCase() === 'password' || autocomplete.includes('password')) return 'password';
    if (autocomplete.includes('one-time-code')) return 'otp';

    const hint = clean(
      [element.getAttribute('name'), element.id, element.getAttribute('placeholder'), nameOf(element)].join(' '),
    ).toLowerCase();

    if (CARD_HINT.test(hint)) return 'card';
    if (OTP_HINT.test(hint)) return 'otp';
    if (PASSWORD_HINT.test(hint)) return 'password';
    return '';
  }

  /** True for a control that submits the form it sits in. */
  function submitsForm(element) {
    if (!element?.form) return false;
    const tag = element.tagName;
    if (tag === 'BUTTON') return (element.getAttribute('type') || 'submit').toLowerCase() === 'submit';
    if (tag === 'INPUT') {
      const type = (element.getAttribute('type') || '').toLowerCase();
      return type === 'submit' || type === 'image';
    }
    return false;
  }

  function pathOf(href) {
    try {
      const url = new URL(href, location.href);
      return url.origin === location.origin ? `${url.pathname}${url.search}` : url.href;
    } catch {
      return '';
    }
  }

  function pageText(extra = []) {
    const parts = [document.body ? document.body.innerText : '', ...extra].filter(Boolean);
    const text = parts
      .join('\n\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text.length <= MAX_TEXT) return text;
    return `${text.slice(0, MAX_TEXT)}\n…(page text continues)`;
  }

  /** The document behind a frame element, or null when it is cross-origin. */
  function frameDocument(element) {
    try {
      const doc = element.contentDocument;
      return doc && doc.documentElement ? doc : null;
    } catch {
      return null;
    }
  }

  /**
   * Walk the page depth first and in document order: the document itself, every
   * open shadow root, and every same-origin frame document. `visit` gets the
   * element plus the label of the root it lives in ('' for the top document,
   * `f1`, `f2`… for the rest). A cross-origin or sandboxed frame is skipped,
   * never an error.
   */
  function walkRoots(visit) {
    let frames = 0; // shadow roots and frame documents, i.e. everything but the top document

    const walk = (root, label) => {
      for (const element of root.querySelectorAll('*')) {
        visit(element, label);

        if (element.shadowRoot && frames < MAX_ROOTS) {
          frames += 1;
          walk(element.shadowRoot, `f${frames}`);
        }

        const tag = element.tagName;
        if ((tag === 'IFRAME' || tag === 'FRAME') && frames < MAX_ROOTS) {
          const doc = frameDocument(element);
          if (doc) {
            frames += 1;
            walk(doc, `f${frames}`);
          }
        }
      }
    };

    walk(document, '');
    return frames;
  }

  function describe() {
    const elements = [];
    const headings = [];
    const frameText = [];
    const frameDocs = new Set();
    let hasPassword = false;

    const roots = walkRoots((element, label) => {
      const tag = element.tagName;

      if (tag === 'IFRAME' || tag === 'FRAME') {
        // The frame's own elements come next in the walk; its words are gathered
        // here, because a list of controls without text is not a description.
        const doc = frameDocument(element);
        if (doc && !frameDocs.has(doc)) {
          frameDocs.add(doc);
          if (doc.body?.innerText) frameText.push(doc.body.innerText);
        }
        return;
      }

      if (tag === 'INPUT' && (element.type || '').toLowerCase() === 'password') hasPassword = true;

      if (headings.length < 12 && (tag === 'H1' || tag === 'H2' || tag === 'H3')) {
        const text = clean(element.textContent).slice(0, 90);
        if (text) headings.push({ level: Number(tag.slice(1)), text });
      }

      if (elements.length >= MAX_ELEMENTS) return;
      if (!element.matches(SELECTOR) || !isVisible(element)) return;

      const kind = kindOf(element);
      const entry = {
        ref: refFor(element, label),
        n: elements.length + 1,
        kind,
        role: roleOf(element, kind),
        name: nameOf(element),
      };

      if (element.getAttribute('aria-expanded')) entry.expanded = element.getAttribute('aria-expanded') === 'true';

      if (entry.kind === 'link') {
        const path = pathOf(element.href);
        if (path) entry.href = path;
      }
      if (element.getAttribute('placeholder')) {
        entry.placeholder = clean(element.getAttribute('placeholder')).slice(0, 60);
      }
      if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
        const sensitive = sensitiveOf(element);
        if (sensitive) entry.sensitive = sensitive;
        // A password, card or one-time-code value is never echoed back.
        else if (element.value) entry.value = clean(element.value).slice(0, 60);
      }
      if (element.type === 'checkbox' || element.type === 'radio') entry.checked = Boolean(element.checked);
      // A control that sends the form: clicking it is submitting, so it always
      // asks and can never be covered by a "don't ask again".
      if (submitsForm(element)) entry.submits = true;
      if (element.disabled || element.getAttribute('aria-disabled') === 'true') entry.disabled = true;
      if (element.tagName === 'SELECT') {
        entry.options = Array.from(element.options)
          .slice(0, 12)
          .map((option) => clean(option.text).slice(0, 40) || option.value);
      }

      elements.push(entry);
    });

    const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);

    return {
      ok: true,
      url: location.href,
      title: clean(document.title).slice(0, 160),
      text: pageText(frameText),
      headings,
      elements,
      frames: roots,
      scroll: {
        y: Math.round(window.scrollY),
        height: Math.round(height),
        viewport: window.innerHeight,
        percent: height > 0 ? Math.min(100, Math.round((window.scrollY / Math.max(1, height - window.innerHeight)) * 100)) : 0,
      },
      forms: {
        sensitive: elements.some((entry) => entry.sensitive),
        password: hasPassword,
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
  function watch(scope, ms = 260) {
    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    // Watch the tree the action happens in: a shadow root or a frame document,
    // not the top document, which never sees either.
    const target = scope?.documentElement || scope || document.documentElement;
    try {
      observer.observe(target, { childList: true, subtree: true, attributes: true });
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

  function writeValue(element, text) {
    if (element.isContentEditable) {
      element.focus();
      // Editors that keep their own model of the text — Discord's composer, any
      // Slate or ProseMirror box — ignore a quiet DOM swap: the words appear but
      // their send button stays dead. A real editing command is what they see.
      const doc = element.ownerDocument;
      const selection = doc?.getSelection?.();
      if (selection && doc.createRange) {
        const range = doc.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      if (doc?.execCommand?.('insertText', false, text)) return true;

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

    if (type === 'scroll') {
      const direction = action.direction || 'down';
      if (direction === 'top') window.scrollTo({ top: 0, behavior: 'instant' });
      else if (direction === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
      else {
        const step = Math.round(window.innerHeight * 0.85) * (direction === 'up' ? -1 : 1);
        window.scrollBy({ top: step, behavior: 'instant' });
      }
      await settle(160);
      return {
        ok: true,
        message: `Scrolled ${direction}. Scrolling alone changes nothing you were given: call read_page again to get the controls now in view.`,
      };
    }

    // A key press without a ref goes to whatever has focus — the page itself
    // when nothing does. Every other action must name an element.
    const element = action?.ref
      ? state.refs.get(action.ref)
      : type === 'press'
        ? document.activeElement || document.body
        : null;
    if (!element || !element.isConnected) {
      return {
        ok: false,
        code: 'stale',
        message: `Nothing matches ${action?.ref || 'that ref'} any more. Read the page again — refs change when the page does.`,
      };
    }

    // The address an action reports is its own document's: a control inside a
    // frame belongs to that frame's URL, not the outer page's.
    const doc = element.ownerDocument || document;
    const href = () => {
      try {
        return doc.location?.href || location.href;
      } catch {
        return location.href;
      }
    };
    const before = href();

    if (type === 'click') {
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      highlight(element);
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
      const watcher = watch(element.getRootNode());
      element.click();
      const mutations = await watcher.settle();

      if (href() !== before) {
        return {
          ok: true,
          message: `Clicked; the page navigated to ${pathOf(href()) || href()}.`,
          url: href(),
          navigated: true,
        };
      }
      if (mutations > 0) {
        return { ok: true, message: `Clicked; the page changed (${mutations} DOM update${mutations === 1 ? '' : 's'}).`, url: href() };
      }
      return {
        ok: true,
        message: 'Clicked, but nothing on the page visibly changed. The control may need a different target, or the page may be waiting on something.',
        url: href(),
      };
    }

    if (type === 'press') {
      const target = action.ref ? element : document.activeElement || document.body;
      const keys = String(action.keys || 'Enter').trim();
      const parts = keys.split('+').map((part) => part.trim()).filter(Boolean);
      const key = parts.pop() || 'Enter';
      const init = {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        keyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : key === 'Tab' ? 9 : key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
        which: key === 'Enter' ? 13 : key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
        bubbles: true,
        cancelable: true,
        ctrlKey: parts.some((part) => /^(ctrl|control)$/i.test(part)),
        metaKey: parts.some((part) => /^(meta|cmd|command)$/i.test(part)),
        altKey: parts.some((part) => /^alt$/i.test(part)),
        shiftKey: parts.some((part) => /^shift$/i.test(part)),
      };
      target?.focus?.({ preventScroll: true });
      highlight(target);
      target?.dispatchEvent?.(new KeyboardEvent('keydown', init));
      target?.dispatchEvent?.(new KeyboardEvent('keyup', init));
      await settle(200);
      return { ok: true, message: `Pressed ${keys}${target === document.body ? ' on the page' : ''}.`, url: href() };
    }

    if (type === 'type') {
      if (element.disabled || element.readOnly) {
        return { ok: false, code: 'disabled', message: 'That field is disabled or read-only.' };
      }
      // The last line of defence: even with a cold ref cache in the worker, a
      // secret field is never filled without an explicit approval.
      const sensitive = sensitiveOf(element);
      if (sensitive && !action.confirmed) {
        return {
          ok: false,
          code: 'sensitive_field',
          sensitive,
          message: `That is a ${sensitive} field. Typing there always needs the user's approval, so nothing was typed.`,
        };
      }
      const text = String(action.text ?? '');
      highlight(element);
      const watcher = watch(element.getRootNode());
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
        url: href(),
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
      const watcher = watch(element.getRootNode());
      element.focus();
      element.value = option.value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      const mutations = await watcher.settle();
      return {
        ok: true,
        message: `Selected "${clean(option.text) || option.value}".${mutations ? ' The page reacted.' : ''}`,
        url: href(),
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

    if (message.type === 'control') {
      try {
        setControl(Boolean(message.on), message.label ? String(message.label).slice(0, 60) : undefined);
        respond({ ok: true });
      } catch (error) {
        respond({ ok: false, message: String(error?.message || error) });
      }
      return undefined;
    }

    if (message.type === 'rect') {
      const element = state.refs.get(String(message.ref || ''));
      if (!element || !element.isConnected) {
        respond({ ok: false, message: 'That ref is no longer on the page.' });
        return undefined;
      }
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      highlight(element);
      const rect = element.getBoundingClientRect();
      respond({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
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
