# ATOM

A private assistant that lives in your browser's side panel — built for Brave, works on any Chromium browser with `sidePanel` support (Chrome 116+). It answers in a stream, knows which tab you're on, and — once you grant it access to a site — can read that page and act on it with your permission.

**Status: Phase 3 — deep debugging.** Real streamed chat, tool-calling against the live page, per-site permissions, a confirmation step before anything changes, and console plus failed-request capture through `chrome.debugger` — switched on for one turn at a time. Nothing is mocked up as working: what hasn't been built is listed below, and the UI says so.

## Load it

1. Open `brave://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
2. **Load unpacked** → select the `extension` folder in this repo.
3. Pin ATOM and click it, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>. The side panel opens.
4. Open settings (the sliders icon) and paste a key. Groq (<https://console.groq.com/keys>) is the default; Gemini (<https://aistudio.google.com/apikey>) and OpenRouter (<https://openrouter.ai/keys>) have free tiers too, and you can save several keys of each. When one key or provider runs out of quota the next one answers.
5. Once a key is saved, the welcome screen asks **once** whether ATOM may work on every site: **Allow all sites** (one browser prompt, then no per-site wall) or **Ask me per site**. Either answer is remembered and the card never returns — not after a refusal, and not after you revoke the grant later. Settings → **Page access** has both buttons if you change your mind.
6. For a single site instead: settings → **Page access** → **Grant**. The browser asks for that one site; **Grant all** below it does the wildcard.

The key is saved in `chrome.storage.local` for this browser profile only. It is never written to the repo, never logged, and never sent to any UI — the panel only learns whether a key exists.

The New Tab page is replaced by ATOM's (`chrome_url_overrides` in the manifest): it frames the panel itself in a centred column, so opening a tab gives you the conversation, the composer and the tool rows, not a note telling you to open a sidebar. Remove that block from `manifest.json` if you'd rather keep the default.

## What works

- **Streaming chat** with Groq, Gemini or OpenRouter. Tokens are coalesced in the service worker so the panel repaints at ~30fps instead of once per token.
- **Free-tier rotation.** Every key you save is its own tokens-per-minute allowance. `lib/providers/pool.js` tries the key you are on, then the rest of that provider's keys, then any other provider you have a key for, and cools a key down after a rate limit rather than dropping it — so a busy minute costs one request, not the turn. A request larger than the tier allows is classified as `too_large` and retried once with the older part of the history left out.
- **Reads sized for free tiers.** Settings → Page read size picks 40 / 70 / 120 controls and 4k / 8k / 16k characters of text; the model is told how much was left out and why. The read-ahead digest is smaller still.
- **Custom instructions that actually steer.** Settings → Instructions accepts up to 200,000 characters, sits at the top of the system prompt above every default, and is introduced as the user speaking. **Import from a file** appends `.txt`, `.md`, `.json` (a string, a prompt field, or any strings inside) or `.html` (tags and scripts stripped). PDF is not supported — no PDF parser is bundled, and the button says so instead of pretending.
- **Page tools** — `read_page`, `click`, `type_text`, `select_option`, `scroll`, `navigate`. The model gets a numbered list of what is actually on the page (`[e7] button "Sign in"`), not a screenshot or a blob of HTML, and refs expire when the page changes so it re-reads instead of clicking stale coordinates. The walk crosses open shadow roots and same-origin frames — refs from there read `f1:e7`, `f2:e7` — so a page built out of web components or an embedded iframe is described properly, and a click or a typed value resolves to the control it names.
- **Verification after acting.** Each action starts a DOM observer *before* it runs and reports what really happened — "the page changed (4 DOM updates)", "it navigated to /pricing", or "nothing changed" — instead of assuming the click worked.
- **Per-site permission.** `optional_host_permissions: ["*://*/*"]` plus a user-gesture request — one origin, or the whole wildcard if you press **Grant all**. The content script is injected on demand, only on sites you granted, only when the model asks to read or act. `navigate` is the exception and needs no grant: a page you cannot read is still a page you can leave, so "open Discord" works from an ungranted tab or the start page.
- **Console and network capture** — arm the **Console** chip in the composer and the next turn attaches the DevTools protocol to that tab. `read_console` returns console messages, warnings and uncaught exceptions; `read_network` returns 4xx/5xx, blocked and connection-failed requests. It is per turn on purpose: Brave shows a non-dismissible "debugging this browser" banner while attached, and DevTools cannot attach to the same tab at once. The two tools are absent from the model's list unless the debugger is actually attached, and the toggle turns itself off after you send.
- **Masking before the model sees anything.** Page text, console arguments and failed-request URLs pass through `lib/redact.js`: bearer tokens, JWTs, `Authorization` values, known key shapes, sensitive query parameters (`api_key=…`, `session_id=…`) and email addresses become `[redacted]` beside their label. The result opens with how many values were masked, so the model knows it is reading a masked view. The rules are deliberately narrow — ordinary text and harmless URLs are left exactly as they are.
- **Confirmations.** Anything that can change state stops and asks, in the transcript, with Allow/Deny. Three autonomy modes: *Assisted* (asks for everything), *Balanced* (default: reading, links and scrolling are free; clicking, typing and submitting ask), *Autonomous* (runs multi-step tasks). Two floors sit under every mode: submitting a form, and typing into a password, card or one-time-code field. The page marks those fields, the policy asks, and the content agent refuses to fill one even if the worker's cache missed it. A question left unanswered for two minutes fails closed, and closing the panel denies it.
- **Fenced tool results.** Every tool result the model sees sits between `<<<ATOM_UNTRUSTED:NAME>>>` and `<<<END_ATOM_UNTRUSTED:NAME>>>` markers, behind a line saying it is data rather than instructions. Any run of `<<<` in the payload is rewritten before it is inserted, so a page cannot forge a boundary, fake a system turn or smuggle in a tool call.
- **A start page that is yours.** The New Tab page is the panel framed in a column, and the stage around it is a theme: five gradients, a solid colour, an uploaded picture or an image address; an accent colour; four font stacks; three widths; clock, greeting, date and up to twelve quick links. **Export theme** writes the JSON and **Import theme** puts it back — same file, same page.
- **Any OpenAI-compatible endpoint, and local models.** Settings takes a base URL, a model id and an optional key, so Ollama (`http://localhost:11434/v1`) and LM Studio (`http://localhost:1234/v1`) work with no key at all. A saved endpoint joins the provider list and the rotation like any vendor.
- **Watch it work.** While a turn runs, a line under the composer counts the clock, the loop step (`step 2 of 6`), and how fast words are arriving (`~48 tok/s · 640 tokens`); the answer's footer adds wall time to the cost (`3 steps · ~2.8k tokens · 12s`). Providers that stream reasoning — Groq's gpt-oss, OpenRouter's DeepSeek and friends — show it in a **Thinking** block that collapses to one line once the answer arrives. There is no ETA, because a model's remaining time is not knowable; the clock and the step count are what is true.
- **Stop, retry, copy, edit.** Errors land in the transcript with a way out, not a toast that vanishes. A denied action can be retried inline, the newest answer has **Retry** (asks the same question again and replaces it instead of stacking a second answer), and **Edit** on any question you sent reopens it in place: saving replaces the question and everything it produced, then asks again. <kbd>Esc</kbd> stops a running turn, and a half-written question survives closing the panel.
- **Tab context** — the active tab's title and address are attached to requests, with a chip in the composer to drop it.
- **Three models** — `openai/gpt-oss-120b` (default), `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`.
- **Auto-context, free** — when the panel opens, ATOM reads the page you granted *locally* (no request, no tokens) and shows a **local** row with its host and element count. The first request carries a small digest — title, headings, 800 characters of text, the first 20 controls with live refs — so "what is this page?" is one round trip instead of two, and an obvious click needs no full read. Full text only when the model calls `read_page`; the Tab-context switch turns the whole thing off.
- **Conversations, plural.** The header's **+** starts a new one; **Settings → Conversations** lists them all, newest first, titled by their first message, each with a delete. Twenty are kept, and starting a new chat never clears the old one. A conversation that predates the shelf becomes the first one.
- **Memory that is yours.** Facts kept between conversations, typed in **Settings → Memory** or saved by the `remember` tool — which always shows the exact text on a confirmation card first, in every mode. Each fact can be forgotten on its own; nothing is inferred, summarised or written without that approval.
- **More than one tab.** `list_tabs` shows the open pages with their ids, and every page tool takes an optional `tab` — so one turn can read one tab and click in another. Each tab keeps its own refs, a tab that has closed is a refusal rather than a silent fallback, and the confirmation names the tab it will act on.
- **Don't ask again, narrowly.** A confirmation for a click, typing, a dropdown or scrolling can offer to remember that one action on that one site. It is never offered — and never honoured, even if it is sitting in storage — for submitting a form, for typing into a password, card or one-time-code field, or for following a link or address that leaves the site. Every grant is one row in **Settings → Trusted actions**, with **Revoke** next to it.
- **Ask ATOM about this** — select text on any page, right-click, and the snippet is quoted into the composer with its host above the input. It rides the next message only, fenced as page data in front of your question, and it needs no site access: the selection arrives with the click, not through a read. That makes a long page cheap — quote the paragraph you care about instead of paying for the whole document.
- **The budget is visible, and spent once** — a page read twice is paid for once: only the newest `read_page` stays whole, older reads collapse to a line, and tool results past the last four are a single line each. Each answer carries `3 steps · ~2.6k tokens` (an estimate from ~4 characters per token), and a rate-limited retry drops older history instead of resending the same request.
- **Web lookups, no key, no grant** — `search_web` searches Wikipedia and returns titles, addresses and snippets; `show_image` finds openly licensed pictures (Openverse) and shows them in the chat. Both run in the worker, so they work from any page, granted or not. Wikipedia is not a search engine: no live news, prices, scores or shopping, and the prompt says so.
- **Settings** — key with a real acceptance check, model, page access, autonomy, standing instructions, tab-context switch, appearance, clear conversation.
- **Keyboard** — <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> opens the panel; <kbd>Enter</kbd> sends, <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a line, <kbd>Esc</kbd> closes settings.

Hard limits, on purpose: six steps per turn before it stops and asks (`lib/agent/loop.js`), one conversation, one in-flight turn, and a 26k-character history budget that never splits a tool call from its result.

## What does not exist yet

Screenshots/vision, voice, projects, the native companion, and self-improvement. Memory is only what you approved: there is no automatic summarising of your conversations into a profile, no patient-notes search, and no “forget everything I said last week”. Tabs are addressed by id, not by a picker or a window: there is no “do this in all my tabs”, and the shelf keeps the last twenty conversations. Web lookups go as far as Wikipedia and Openverse; a general search engine (news, shopping, live data) needs a search API key, which this build does not ship yet. Capture also has no filterable log panel of its own yet — spec §8's debugger panel — so console output reaches you through the transcript's tool rows rather than a table. Also not built: acting across several tabs in one turn, and site-level allowlists beyond the browser's own per-origin grant. The prompt is told exactly which of these it has, so it can't claim otherwise.

## Layout

```
extension/
  manifest.json          MV3: side panel, new tab, storage, tabs, scripting, debugger, context menus, optional site access
  background.js          the only state owner: settings, conversation, turn loop, tools, confirmations
  content/agent.js       injected on demand: describes a page, performs one action, verifies it
  lib/
    settings.js          defaults + validation, chrome.storage.local
    session.js           conversation model, context windowing, tool pairs, system prompt
    chats.js             the conversation shelf: load, create, open, delete, cap
    grants.js            per-site, per-action trust and the three floors it cannot cross
    page.js              permission check, injection, page→text, action summaries
    capture.js           chrome.debugger session: console + failed requests, formatted for the model
    agent/tools.js       the six tool schemas, argument parsing
    agent/policy.js      autonomy matrix, hard refusals
    agent/failure.js     what the model is told when an action could not run
    agent/loop.js        the step loop: stream → tools → stream, capped
    providers/index.js   provider registry (vendor-agnostic)
    providers/openai.js  one OpenAI-compatible adapter: SSE streaming, tool calls, error classification
    providers/groq.js    Groq: models and endpoints
    providers/gemini.js  Gemini's OpenAI-compatible endpoint
    providers/openrouter.js  OpenRouter, free models
    providers/pool.js     rotation across keys and providers, with cooldowns
    prompt-file.js       .txt/.md/.json/.html → instruction text
  ui/
    tokens.css           design tokens, two themes, shared primitives
    markdown.js          small renderer; escapes first, so model output can't inject HTML
  sidepanel/             the assistant: stream, tool trace, permission cards, composer, settings
  newtab/                the same panel, framed in a column as the page
  icons/                 generated by scripts/make-icons.mjs
tests/                   node:test suites for policy, loop, provider stream, tools, session, markdown
scripts/
  acceptance.mjs         real-browser run: stub provider, unpacked extension, one full turn
  preview.mjs            static server for viewing the UI in a normal tab
  make-icons.mjs         renders icons/*.png from geometry, no image deps
```

Three rules worth keeping: the UI never keeps its own copy of the conversation (it renders what the worker sends), page text is data for the model and never instructions to it, and provider calls go through `lib/providers` so another vendor or a local model can drop in without touching agent logic.

## Test

```bash
node --test tests/*.test.mjs      # or: npm test
```

169 tests, no browser required. They cover the confirmation matrix and hard refusals (including the password/card/one-time-code floor), the step loop (tool round-trips, step ceiling, abort between steps, provider failure), SSE parsing including fragmented and parallel tool calls plus HTTP error mapping, argument parsing and page-description formatting, CDP event mapping for console and network and its formatting, masking, fenced tool results against hostile canned pages, provider-history shaping (tool pairs kept together, orphan rows dropped, unanswered calls given a synthetic result so Groq doesn't 400, budget trimming that never orphans a result), the content agent under a fake DOM (secret fields, shadow roots, same-origin frames), the panel's Markdown renderer, where the hostile payloads from the fence suite stay text and only http(s) addresses become anchors, the failure text for a stale ref or a missing grant, which has to name `read_page` and forbid the retry, and the rate-limit path, where a 429 waits out `retry-after` and asks the same step again instead of failing the turn, and the two keyless lookups, where Wikipedia HTML snippets are flattened, results are addressed, and anything not served over https is dropped before it can be displayed.

`tests/background.test.mjs` imports the real service worker — `lib/` and all — against a fake `chrome` installed on `globalThis`, opens a port the way the panel does, and drives whole turns: no key, a denied confirmation that never reaches the page, an allowed one whose click does reach it, a refused debugger attach that lets the turn continue without capture tools, a successful one that offers those tools and always detaches the tab, and the last panel disconnecting to deny the open question and abort the turn.

The `chrome` fake is hand-written, so an API shape it gets wrong passes here and fails in Chromium — the acceptance run below is what checks that.

## Acceptance run (a real browser)

```bash
npm run accept                 # add `-- --headed` to watch it
```

Once, per machine: `npm i` then `npx playwright install chromium`. This is **not** part of `npm test` — it starts Chromium, installs the extension and takes a few seconds, where the unit suite is a two-second no-browser command.

It copies `extension/` into a temporary directory, points the copy's Groq origin at a local OpenAI-compatible stub, and loads that copy unpacked in Playwright's bundled Chromium (headless, via `channel: 'chromium'`). Then it drives one real turn over the extension's own `chrome.runtime` port: capabilities report the granted page, a key is saved and verified, `read_page` describes a fixture page, the confirmation card appears for the click, and after the click is allowed the fixture page's own handler has run ("Purchased." is in the DOM) and the stub has seen both fenced tool results come back.

Two substitutions, on purpose and printed at the end of every run: the provider is a local stub (a service worker's `fetch` is not reliably routable by Playwright), and the fixture origin is pre-granted in the copy's manifest because Chromium's host-permission prompt is browser UI Playwright cannot click. The grant is still real — `permissions.contains`, `chrome.scripting` injection and the panel's capability state all come from Chromium — but the prompt itself remains a human check. A second turn asks for the same click and is denied: the row settles as denied, the fixture's click handler never runs again, the denial goes back to the model, and the turn still finishes. A third switches Console capture on: the debugger attaches, the fixture logs a line and fails a request, `read_console` and `read_network` return both, and the session is detached when the turn ends (the panel is told, and the snapshot agrees).

Also not covered: `chrome.sidePanel.open` and the toolbar button, the debugging banner (headless has no UI), and Brave detaching on its own when DevTools opens.

## Preview the UI without loading the extension

```bash
node scripts/preview.mjs
# http://127.0.0.1:5173/sidepanel/   http://127.0.0.1:5173/newtab/
```

Opened as a plain page the panel uses a preview transport: same layout, same streaming, and a scripted walkthrough that shows a tool trace, a console read (arm the Console chip before sending) and a permission card — canned, and it says so in the transcript. Nothing there reaches Groq and nothing is clicked on a real page.

## Icons

```bash
node scripts/make-icons.mjs   # writes extension/icons/icon{16,32,48,128}.png
```

## Notes for the next contributor

- `JARVIS — Master Specification v3.md` is the source of truth for direction. `ARCHITECTURE.md` describes what was actually built; `TASKS.md`, `AGENT_LOG.md` and `AGENT_COORDINATION.md` are the working documents from spec §18.
- The spec's Groq section is out of date: `groq/compound` and `groq/compound-mini` were **decommissioned 2026-09-21**, `playai-tts` was replaced by `canopylabs/orpheus-v1-english`, and the Llama 3.1/3.3 IDs are Enterprise-only now. Current IDs are pinned in `extension/lib/providers/groq.js`.
- Spec §20's open decisions (name, companion scope, default autonomy mode) still want a human call. This build assumed *Assisted/Balanced/Autonomous* with **Balanced** as the default and per-site permissions; both are easy to change in `lib/agent/policy.js` and `lib/settings.js`.
