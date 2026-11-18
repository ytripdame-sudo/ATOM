# Agent log

Newest last. One entry per working session: what changed, what was verified, what was **not**.

## 2026-11-18 — Phase 2: page perception and action

### Built

- `content/agent.js` — injected on demand. Describes a page as text plus a numbered list of interactive elements (`[e7] button "Sign in"`), performs exactly one action per call (`click`, `type`, `select`, `scroll`, `read`), and reports what happened. Refs are stable within a document and die with it.
- `lib/page.js` — origin patterns (`https://host/*`), permission check, injection (`ensureAgent` pings first so it never double-injects), page→prompt formatting, one-line action summaries.
- `lib/agent/tools.js`, `policy.js`, `loop.js` — six tool schemas, the autonomy matrix and hard refusals (non-http(s) navigation, unknown tools), and the step loop with `MAX_STEPS = 6`.
- `lib/providers/groq.js` — now streams `tool_calls` (fragments by `index`, so parallel calls from qwen assemble correctly) and returns `{ text, finishReason, toolCalls }`.
- `lib/session.js` — rewritten: tool-call/result pairs, unanswered calls get a synthetic `interrupted` result (Groq rejects a history with an unmatched call), 26k-character budget that trims whole turns, capability-aware system prompt.
- `background.js` — turn loop, tool execution, `requestConfirmation` (120s, fail-closed, denied when the last port disconnects), per-origin capability state, `chat.retry` that drops unfinished rows, `snapshot.confirm` so a reloaded panel gets the open question back.
- Panel — tool rows with running/done/failed/denied states, inline **Grant access** on `no_access`, permission cards, page-access row, autonomy segmented control, ghost bubbles for tool-only steps.
- `tests/` (31 tests) and `package.json` so `npm test` runs them.

### Verified

- `node --test tests/*.test.mjs` — 31 pass (policy, loop, provider SSE incl. fragmented + parallel tool calls and HTTP error mapping, tools/arguments, history shaping and prompt honesty).
- All modules parse as ES modules (`vm.SourceTextModule`); `manifest.json` and `package.json` parse.
- Content agent against a real DOM (newtab page, `chrome.runtime` shim): `ping` ok, two interactive elements with correct names, headings and scroll geometry; a `type` action wrote the value and a re-read confirmed it; a stale ref returned `code: "stale"`; a `click` on a probe button ran the handler and was reported as "the page changed (1 DOM update)".
- Panel UI in the preview harness (400×860), dark and light: tool rows, permission card ("Click "Get started"?" / `example.com · Balanced mode` / Allow+Deny), card removal after allowing, settings sheet with page access "No site" + disabled Grant, autonomy note. No console errors.

### Found and fixed during verification

- `settle()` began observing **after** the click, so pages that update the DOM inside the handler were reported as "nothing visibly changed". Replaced with `watch()` started before the action. Confirmed by the probe test: 0 mutations before, 1 after.
- Confirmation title read `Allow "Click "Get started""?` — the summary already carries quotes; it is now the question itself.
- The loop could start another paid request after an abort that arrived mid-tool. It now checks the signal at the top of every step.
- Preview demo froze in background tabs (throttled timers). It now fast-forwards through microtasks when the document is hidden.

### Not verified

- **The extension has never been loaded into Brave.** `chrome.sidePanel`, `chrome.scripting.executeScript`, `chrome.tabs.sendMessage` and the permission prompt are exercised only by reading the code.
- **No real Groq call.** No key was available. Tool-calling is verified against synthetic SSE only, so the first live run is the first time the model actually picks tools.
- Multi-step behaviour on a real site (a page that navigates mid-task, a shadow-DOM button, a page that blocks scripts).
- Behaviour when the page is a PDF, an iframe-only app, or `about:blank`.

### Next

See `TASKS.md`.
