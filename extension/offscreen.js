/**
 * The clipboard lives in a document, not in a service worker. This page exists
 * only for that: one message in, one answer out, no DOM, no network.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'atom-offscreen') return undefined;

  const text = String(message.text ?? '');
  const work =
    message.op === 'read'
      ? navigator.clipboard.readText().then((value) => ({ ok: true, text: value }))
      : navigator.clipboard.writeText(text).then(() => ({ ok: true }));

  work.then(sendResponse, (error) => sendResponse({ ok: false, message: String(error?.message || error) }));
  return true;
});
