# Architecture

What is actually built, as of Phase 2. The product brief is `JARVIS — Master Specification v3.md`; where the two disagree, this file describes the code.

## Shape

One MV3 service worker owns everything: settings, the conversation, page permissions, the in-flight turn and the open question. The side panel is a thin client — it holds no copy of the conversation and re-renders whatever the worker sends. That is what makes the panel closing, reopening or reloading harmless, and it is the main reason the UI stays honest: it cannot invent a state the worker did not report.

```
panel (port "atom")  ── intents ──►  background.js  ── tools ──►  content/agent.js
                     ◄── events ──                 ◄── page text ──
                          │
                          └──► lib/providers/groq.js  ──SSE──►  Groq
```

## Protocol

Panel → worker (`port.postMessage({ t, ... })`):

| `t` | meaning |
|---|---|
| `hello` | send me a full snapshot |
| `chat.send` `{ text }` | user message |
| `chat.stop` | abort the turn, deny any open question |
| `chat.retry` | re-run the last user message after dropping unfinished rows |
| `chat.new` | new conversation |
| `confirm.respond` `{ id, allow }` | answer a permission card |
| `settings.update` `{ patch }` | merge + persist; verifies a new key automatically |
| `settings.verify` | acceptance check on the stored key |
| `tab.context` | refresh tab + capability state |
| `capabilities.refresh` | re-read the permission for the active origin |

Worker → panel (`{ t: 'evt', e: { kind, ... } }`), except `hello` which gets `{ t: 'state', session, settings, meta, tab, capabilities, busy, confirm }`:

`added` · `delta` `{ id, text }` · `done` `{ id, text, stopped, toolCalls }` · `error` `{ id, code, message }` · `removed` `{ id }` · `toolUpdate` `{ id, tool }` · `confirm` `{ request }` · `confirmResolved` `{ id, allowed }` · `busy` `{ busy }` · `settings` · `capabilities` `{ pageAccess, host, origin }` · `keycheck` · `tab` · `session` · `notice` `{ text }` · `fault`.

Anything the panel does not recognise is ignored, so a worker that learns a new event does not break an older panel.

## A turn

`chat.send` → `runTurn()`:

1. No key? Append an assistant row marked `no_key` and stop (a real error row, so Retry/Settings sit in the transcript rather than a toast).
2. Build the tool list: `pageAccess ? TOOL_DEFINITIONS : null`. No permission means the model is not even offered the tools.
3. `runAgentTurn` (`lib/agent/loop.js`), up to `MAX_STEPS = 6`:
   - `beginStep()` creates the assistant message and a flusher that coalesces deltas at 32 ms;
   - the provider streams text and/or `tool_calls`;
   - `finish()` marks the message done (or error), and drops it entirely if it has neither text nor calls;
   - for each call, `runTool()`; then the next step, with the tool results now in history;
   - if the signal is aborted at the top of a step, the loop returns `{ stopped: true }` instead of paying for another request.
4. Exhaustion broadcasts a `notice` — "stopped after 6 steps so this stays cheap".

Errors are mapped in one place (`describeError`): 401/403 → `bad_key`, 429 → `rate_limit`, offline → `network`, 5xx → `upstream`.

## Page access

- `manifest.json` declares `optional_host_permissions: ["*://*/*"]` — a *capability*, not a grant. Nothing is accessible until `chrome.permissions.request({ origins: ['https://host/*'] })` from a user gesture (the Grant button, or the inline **Grant access** on a failed tool row).
- `capabilityState()` returns `{ pageAccess, host, origin }` for the active tab; the panel shows it in settings and only enables Grant when the tab is an http(s) page.
- `ensureAgent(tabId)` pings, and injects `content/agent.js` with `chrome.scripting.executeScript` only if the ping fails. Nothing is declared in `content_scripts`, so no page is touched before the model asks.
- `chrome.permissions.onRemoved` clears the ref cache, so a revoked site cannot be acted on with stale refs.

## The page agent

`content/agent.js` runs in the isolated world and exposes exactly three messages: `ping`, `read`, `act`.

- `read` → `{ url, title, text (≤7000 chars), headings, elements[], scroll, forms, truncated }`. Elements come from a selector list of real controls, filtered by visibility, capped at 120, and each carries a ref assigned on first sight. Nothing is scraped from `<script>`, hidden nodes or password values (`secret: true` instead).
- `act` → exactly one action. `click` checks visibility and disabled state first; `type` writes through the native `value` setter so React and friends see a real input event; `select` matches by value or visible label and lists the options when it misses; `scroll` reports the new position.
- **Verification**: `watch()` starts a `MutationObserver` *before* the action, then waits ~260 ms and reports the number of real mutations, whether the URL changed, or that nothing happened. Starting after the action (the first implementation) silently reported "nothing changed" for every page that updates the DOM in its handler — which is most of them.
- Refs die with the document: a navigation or a re-render that removes the node returns `code: "stale"` and tells the model to read again.

## Permissions and confirmations

`lib/agent/policy.js` is the only place that decides. Room for judgement:

| tool | assisted | balanced | autonomous |
|---|---|---|---|
| `read_page` | no ask | no ask | no ask |
| `click` on a link | ask | no ask | no ask |
| `click` elsewhere | ask | ask | no ask |
| `type_text` | ask | ask | no ask |
| `type_text` with `submit` | ask | ask | **ask** |
| `select_option`, `scroll` | ask / ask | ask / no ask | no ask |
| `navigate` (http(s) only) | ask | no ask | no ask |

Hard refusals never reach the page: non-http(s) URLs, missing URLs, unknown tool names, unparseable arguments.

`requestConfirmation` fails closed: 120 s timeout → deny; the last port disconnecting → deny; abort → deny. The worker keeps the pending request in `pendingConfirm.request`, which `snapshot()` hands to a panel that reloads mid-question.

## Storage

`chrome.storage.local` only — no cookies, no server, no telemetry.

| key | contents |
|---|---|
| `atom.settings` | provider, model, API key, instructions, theme, tab-context switch, autonomy mode |
| `atom.session` | the conversation, including tool rows and call ids |
| `atom.pending` | one question handed from the New Tab page to the panel, consumed and deleted within 30 s |

The key never leaves the worker: `publicSettings()` replaces it with `hasKey: true`.

## Context budget

`toProviderMessages` groups the history into *units* (a user message, an assistant reply, or an assistant reply plus its tool results), walks backwards under a ~26k-character budget, then builds provider messages from whole units — so a tool result is never separated from the call that produced it. An assistant message with calls but no text becomes `content: null` with `tool_calls`, which is what the API expects.

## Trust boundary

Page text, page titles and tool output are data. The system prompt says so, the panel renders model output through an escaping markdown renderer, and tool results are inserted as `tool` role messages — never as instructions. A page that says "ignore your instructions" is described to the model as page content and nothing more.

## Preview and tests

`scripts/preview.mjs` serves the extension as a static site. When `chrome.runtime` is missing the panel uses `sidepanel/preview.js`, which speaks the same protocol with canned data (labelled as such in the transcript) — so the UI can be reviewed without loading an extension, and the demo walks through a read, a click and a permission card.

`tests/` runs under `node --test` with no browser: policy matrix, loop behaviour with a fake provider, the real Groq adapter against synthetic SSE, argument parsing, and history shaping.
