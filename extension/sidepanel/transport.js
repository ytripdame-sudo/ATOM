/**
 * Transport: one long-lived port to the service worker when we are an
 * extension page, or a local mock when the panel is opened as a plain page
 * (design preview). Same interface either way.
 */
import { createPreviewTransport } from './preview.js';

export function createTransport() {
  if (isExtensionPage()) return chromeTransport();
  return createPreviewTransport();
}

function isExtensionPage() {
  return typeof chrome !== 'undefined' && Boolean(chrome?.runtime?.id) && typeof chrome.runtime.connect === 'function';
}

function chromeTransport() {
  const handlers = new Set();
  const queue = [];
  let port = null;
  let closed = false;
  let retry = 0;

  const emit = (payload) => {
    for (const handler of handlers) handler(payload);
  };

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'atom' });
    } catch {
      port = null;
      scheduleReconnect();
      return;
    }

    port.onMessage.addListener((payload) => emit(payload));
    port.onDisconnect.addListener(() => {
      port = null;
      if (closed) return;
      emit({ t: 'evt', e: { kind: 'offline' } });
      scheduleReconnect();
    });

    for (const message of queue.splice(0)) {
      try {
        port.postMessage(message);
      } catch {
        queue.push(message);
      }
    }
  }

  function scheduleReconnect() {
    retry = Math.min(retry + 1, 5);
    setTimeout(() => {
      if (closed) return;
      connect();
      // A fresh port has no state: ask for it again.
      send({ t: 'hello' });
    }, 260 * retry);
  }

  function send(message) {
    if (!port) {
      queue.push(message);
      return;
    }
    try {
      port.postMessage(message);
    } catch {
      queue.push(message);
      port = null;
      scheduleReconnect();
    }
  }

  connect();

  return {
    send,
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      closed = true;
      try {
        port?.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}
