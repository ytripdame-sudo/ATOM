# Tasks

Working list. `AGENT_LOG.md` records what was verified; this file records what is left and who could pick it up.

## Done

**Phase 1 — foundation**
- MV3 side panel, New Tab page, icons, manifest, keyboard command.
- Streaming chat with Groq, coalesced deltas, stop/retry/copy, error cards.
- Settings (key with a real check, model, instructions, theme, tab context) and a single conversation store in the worker.

**Phase 2 — perception and action**
- Six page tools, executed by an injected content agent, with post-action verification.
- Per-site permission request, on-demand injection, capability state in the UI.
- Autonomy modes, permission cards, fail-closed confirmations, inline Grant access.
- Tool trace rows, ghost bubbles, `snapshot.confirm` recovery.
- 31 automated tests; README/ARCHITECTURE/AGENT_LOG/AGENT_COORDINATION.

**Phase 3 — deep debugging**
- `chrome.debugger` session in `lib/capture.js`: console messages, warnings, uncaught exceptions and failed requests (4xx/5xx, blocked, connection errors), correlated by request id and capped at 120 entries per buffer.
- Opt-in per turn through a **Console** chip in the composer, with the banner warning under it; attach before the first request, detach in `finally` however the turn ends.
- `read_console` and `read_network` tools that only exist while attached; a refused attach degrades to a notice instead of failing the turn.
- 11 more tests (42 total) for CDP mapping and formatting; demo path in the preview transport.
- **Web lookups and pictures.** `search_web` (Wikipedia) and `show_image` (Openverse) run in the worker: no key, no grant, no injection, offered on every turn. Pictures come back as a structured `images` array on the tool row and the panel renders them as `<img>` (https only, from the tool, never from page text). Both tools and the prompt say plainly that Wikipedia is not a search engine.
- **Navigation is always offered.** A turn that started on an ungranted page, or on a browser page ATOM cannot even name, used to get an empty tool list — so "goto discord" could only be answered with "grant access first". `navigate` is now part of every turn's tools, handled before the tab lookup and the grant check; the prompt says so plainly. This was the bug behind the whole "enable site access" loop.
- **New Tab hand-off.** Pressing Enter on the start page did nothing because the handler awaited the storage write before `chrome.sidePanel.open()`, spending the click's user activation. The write now starts first and `open()` is called in the same synchronous run.
- **Conversations.** A shelf of up to twenty chats in `atom.chats`, with the old single session migrated in. New from the header, open/delete from Settings → Conversations, titles from the first message; opening redraws the whole chat. 5 unit tests and 2 acceptance checks.
- **Memory.** Facts kept between conversations: typed in Settings, or saved by `remember`, which always asks in every mode and shows the exact text. Normalised, deduped, capped at forty, deletable one by one, and injected into the prompt as user-approved lines. 1 settings test, 1 worker test, 1 acceptance check.
- **Multi-tab.** `list_tabs` (no grant) plus an optional `tab` on every page tool; refs are cached per tab, the confirmation names the acting tab, and a closed tab is refused instead of silently swapped for the focused one. 1 worker test, 3 tool-schema tests.
- **Don't ask again (per site, per action).** A confirmation offers to remember one action on one host — click, typing, dropdown, scrolling, same-site navigation — and stops asking for it until Settings → Trusted actions revokes it. Never offered or honoured for submit controls, `type_text` with `submit`, password/card/one-time-code fields, or links and addresses that leave the origin; the agent now flags submit controls (`submits`), and clicking one asks in every mode. 9 new tests (rules, storage, remember → no card → other site still asks → revoke → card again) and 2 acceptance checks (the panel ticks the box and records the grant, Settings revokes it).
- **Ask ATOM about this.** Right-click a selection → one menu item, `selectionText` cleaned and capped, the panel opened from the same click, the snippet shown above the composer and sent once as `fenceUntrusted('selection', …)` in front of the question. No page access, no read, no permission prompt. 2 new tests (the menu click end to end including "no page read" and "used once", and the fence in provider history).
- **Token budget.** Repeated page reads are deduped — the newest `read_page` (and `read_console`/`read_network`) stays whole, older ones collapse to a one-line stub that says so — and tool results past the newest four are a line each, applied before the character budget so it bounds what is really sent. `estimateTokens` (≈4 chars/token, labelled `~`) is accumulated per turn and stored on the answer that ended it; the panel shows `3 steps · ~2.6k tokens`, and the rate-limit notice quotes the same number. A 429 retry now halves the context budget and unit cap (`tight`) instead of resending the same request. 5 new tests, 1 new acceptance check.
- **Auto-context.** The granted page is read locally when the panel opens (and on a tab switch), its refs are remembered, and a small digest — title, headings, 800 characters, the first 20 controls — rides the first request only. A `local` row in the panel says what was read and how much, and disappears when the digest does. "What is this page?" is now one round trip instead of two, and it costs no extra step. 5 new tests (digest formatting and masking, first-request-only plumbing, the worker turn) and 1 new acceptance check.
- **First-run access ask.** The per-site wall is the thing people hit first, so it is now a question on the welcome screen — **Allow all sites** or **Ask me per site** — shown once a key exists, answered once, remembered in `settings.accessChoice` and never shown again (a refusal or a later revoke does not bring it back). Settings keeps both buttons. 3 settings tests and 2 acceptance checks (asked once; a second panel does not ask again).
- **Grant all** — the wildcard page access you asked for, behind its own click in settings, with the same honest label and a revoke beside it. Per-site stays the default; nothing else in the gate changed.
- **429 handling** — the loop honours `retry-after`, retries the same step twice with a visible countdown, reuses the empty reply (no duplicate message, no replayed tool call), and stops waiting the moment you stop the turn. 4 new tests, 2 mutations caught.
- Model-facing failure text for the two paths a turn hits most: a stale ref and a missing grant both say what did *not* happen, name `read_page`, and forbid the retry (`lib/agent/failure.js`), with tests for the wording and for the worker passing it through.

## Next, in the order I would take them

1. **Load it in Brave and use it.** `npm run accept` now drives the extension in headless Chromium — panel port, page access, `chrome.scripting` injection, `read_page`, a confirmed click, a denied click that never reaches the page, and a `chrome.debugger` session that reads a console error and a 404 and then detaches — so those shapes are checked against a real browser, not the fake. Still unrun anywhere: `chrome.sidePanel.open` and the toolbar button, the native host-permission prompt (the acceptance run pre-grants its fixture origin), and the debugging banner. Expect the first real bugs there, in that order.
2. **Live tool-calling pass.** One real key, a few sites (a docs page, a search box, a form). Check that refs survive a re-read, that the model stops asking to click after a denial, and how often `gpt-oss-120b` calls the right tool versus answering from the tab title.
3. **Capture a real page in Brave.** `npm run accept` now attaches the debugger in Chromium, gets a console error and a 404 back through `read_console`/`read_network`, and confirms the detach. What only a human on Brave can check: the banner appearing and disappearing with the turn, and opening DevTools mid-turn degrading to the notice rather than a hang.
4. **Multi-tab awareness.** Only the active tab is visible to a turn. A task that opens something in a new tab currently loses its refs.
5. **Vision.** Screenshots would help on canvas-heavy pages where the DOM says nothing; it also makes every request bigger and slower, so it should be opt-in per turn.
6. **Check the masking rules against real output.** They are narrow on purpose, so a token in a path segment (`/reset/abc123`) or a bare hex blob still gets through; decide whether those are worth the false positives on real pages, and whether the count in the note should stay per-rule rather than per-distinct-value.
7. **Widen field classification.** A card input labelled only by a neighbouring `<div>` (no `<label>`, no `aria-label`, no `autocomplete`) is not recognised as sensitive, and `#cardnum` versus `#field-3` is the whole difference. The fix is nearby-text lookup plus a longer hint list, not a heavier model.
8. **Voice** (spec Phase 4+) and the rest of the roadmap.

## Needs a human decision

- Spec §20: product name, companion scope, default autonomy mode. This build chose **Balanced**.
- ~~Whether `chrome.debugger` is acceptable for console capture.~~ Decided: yes, but only per turn, with the banner warning visible before you send.
- A general search backend is the one thing still missing from "as flexible as ChatGPT": news, prices, shops, live data. The clean options need one API key (Exa's free tier is roughly 1,400 searches a month, semantic rather than a keyword SERP; Brave's own Search API is the other fit). Zero-key scraping of Bing or Google was rejected on their terms, not on difficulty.
- All-sites page access is now opt-in behind **Grant all** rather than one origin at a time. The part still worth a second opinion is whether the model should ever be *told* that a wildcard grant exists, since that invites it to ask for more access instead of working with what it has.

## Known rough edges

- **The worker's tests use a hand-written `chrome`.** `tests/background.test.mjs` drives real turns, but the API shapes are mine: a promise where Brave returns nothing, or a missing event, passes here and fails in the browser. The fake is the contract; Brave is the truth.

- **Closed shadow roots and cross-origin frames are invisible.** The walk can only see `shadowRoot` when it is open and `contentDocument` when the frame is same-origin; both are skipped silently, and the page view says how many roots were included rather than claiming completeness.
- **Text inside an open shadow root is not in the page text.** Its controls are; the words around them are not, because `innerText` stops at the boundary and a text-node walk would pull in `<style>` blocks.
- **A click inside a frame only scrolls that frame** (`scroll` is document-level), and a shadow-root action is verified by mutations in its own root, so a change the host page makes outside it reports "nothing visibly changed".

- `type_text` on a field with no framework listener reports "the page did not visibly change" — technically true (no DOM mutation), but a model may read it as failure.
- A page that never stops mutating (clocks, animations) makes every action look like it changed everything.
- Long pages are capped at 120 elements; the model is not told which ones were dropped.
- Capture only sees what happens while attached: an error that fired before the turn started is invisible until the page is reloaded.
- No filterable log panel yet (spec §8); console output is read through the transcript's tool rows.
- The panel has no compact/docked mode for narrow windows.

- Free-tier capacity: three providers, pooled keys, rotation with cooldowns, and a request cap that shrinks history before anything is sent. What is still unproven is live Gemini/OpenRouter traffic — the ids and the OpenAI-compatibility layer are taken from their docs, and OpenRouter's free ids move.
- PDF import was asked for and is not here: no parser is bundled, and a compressed PDF read as text would be a lie. Adding `pdf.js` and extracting the text layer is the honest next step if it is wanted.

- Start page: the theme covers background, accent, font, width and four widgets. Bonjourr's weather, rotating quotes, search suggestions and drag-to-resize widgets are deliberately absent — weather and quotes need a service and a key, and a search box is already the panel.
- Local models are wired through the OpenAI-compatible path. What has not happened is a real Ollama reply; if a local server streams a different event shape, the adapter is the one place to fix.
- PDF import reads text layers only. If it is used on scans often, the honest upgrade is bundling pdf.js and saying so, not making the current reader guess harder.
