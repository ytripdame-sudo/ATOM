# ATOM

A private assistant that lives in your browser's side panel — built for Brave, works on any Chromium browser with `sidePanel` support (Chrome 116+). It answers in a stream, knows which tab you're on, and — once you grant it access to a site — can read that page and act on it with your permission.

**Status: Phase 2 — perception and action.** Real streamed chat, tool-calling against the live page, per-site permissions, and a confirmation step before anything changes. Nothing is mocked up as working: what hasn't been built is listed below, and the UI says so.

## Load it

1. Open `brave://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
2. **Load unpacked** → select the `extension` folder in this repo.
3. Pin ATOM and click it, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>. The side panel opens.
4. Open settings (the sliders icon) and paste a Groq API key from <https://console.groq.com/keys>.
5. On a page you want ATOM to work with, open settings → **Page access** → **Grant**. The browser asks for that one site; ATOM never requests "all sites".

The key is saved in `chrome.storage.local` for this browser profile only. It is never written to the repo, never logged, and never sent to any UI — the panel only learns whether a key exists.

The New Tab page is replaced by ATOM's (`chrome_url_overrides` in the manifest). Type a question there and it opens the sidebar with the question already sent. Remove that block from `manifest.json` if you'd rather keep the default.

## What works

- **Streaming chat** with Groq. Tokens are coalesced in the service worker so the panel repaints at ~30fps instead of once per token.
- **Page tools** — `read_page`, `click`, `type_text`, `select_option`, `scroll`, `navigate`. The model gets a numbered list of what is actually on the page (`[e7] button "Sign in"`), not a screenshot or a blob of HTML, and refs expire when the page changes so it re-reads instead of clicking stale coordinates.
- **Verification after acting.** Each action starts a DOM observer *before* it runs and reports what really happened — "the page changed (4 DOM updates)", "it navigated to /pricing", or "nothing changed" — instead of assuming the click worked.
- **Per-site permission.** `optional_host_permissions: ["*://*/*"]` plus a user-gesture request for one origin. The content script is injected on demand, only on sites you granted, only when the model asks to read or act.
- **Confirmations.** Anything that can change state stops and asks, in the transcript, with Allow/Deny. Three autonomy modes: *Assisted* (asks for everything), *Balanced* (default: reading, links and scrolling are free; clicking, typing and submitting ask), *Autonomous* (runs multi-step tasks; submitting a form still asks). A question left unanswered for two minutes fails closed, and closing the panel denies it.
- **Stop, retry, copy.** Errors land in the transcript with a way out, not a toast that vanishes. A denied action can be retried inline.
- **Tab context** — the active tab's title and address are attached to requests, with a chip in the composer to drop it.
- **Three models** — `openai/gpt-oss-120b` (default), `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`.
- **Settings** — key with a real acceptance check, model, page access, autonomy, standing instructions, tab-context switch, appearance, clear conversation.
- **Keyboard** — <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> opens the panel; <kbd>Enter</kbd> sends, <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a line, <kbd>Esc</kbd> closes settings.

Hard limits, on purpose: six steps per turn before it stops and asks (`lib/agent/loop.js`), one conversation, one in-flight turn, and a 26k-character history budget that never splits a tool call from its result.

## What does not exist yet

Console and network capture (spec Phase 3), screenshots/vision, voice, memory, projects, the native companion, and self-improvement. Also not built: acting across several tabs in one turn, and site-level allowlists beyond the browser's own per-origin grant. The prompt is told exactly which of these it has, so it can't claim otherwise.

## Layout

```
extension/
  manifest.json          MV3: side panel, new tab, storage, tabs, scripting, optional site access
  background.js          the only state owner: settings, conversation, turn loop, tools, confirmations
  content/agent.js       injected on demand: describes a page, performs one action, verifies it
  lib/
    settings.js          defaults + validation, chrome.storage.local
    session.js           conversation model, context windowing, tool pairs, system prompt
    page.js              permission check, injection, page→text, action summaries
    agent/tools.js       the six tool schemas, argument parsing
    agent/policy.js      autonomy matrix, hard refusals
    agent/loop.js        the step loop: stream → tools → stream, capped
    providers/index.js   provider registry (vendor-agnostic)
    providers/groq.js    Groq adapter: SSE streaming, tool-call assembly, error mapping
  ui/
    tokens.css           design tokens, two themes, shared primitives
    markdown.js          small renderer; escapes first, so model output can't inject HTML
  sidepanel/             the assistant: stream, tool trace, permission cards, composer, settings
  newtab/                the doorway: one question, handed to the sidebar
  icons/                 generated by scripts/make-icons.mjs
tests/                   node:test suites for policy, loop, provider stream, tools, session
scripts/
  preview.mjs            static server for viewing the UI in a normal tab
  make-icons.mjs         renders icons/*.png from geometry, no image deps
```

Three rules worth keeping: the UI never keeps its own copy of the conversation (it renders what the worker sends), page text is data for the model and never instructions to it, and provider calls go through `lib/providers` so another vendor or a local model can drop in without touching agent logic.

## Test

```bash
node --test tests/*.test.mjs      # or: npm test
```

31 tests, no browser required. They cover the confirmation matrix and hard refusals, the step loop (tool round-trips, step ceiling, abort between steps, provider failure), SSE parsing including fragmented and parallel tool calls plus HTTP error mapping, argument parsing and page-description formatting, and provider-history shaping (tool pairs kept together, orphan rows dropped, unanswered calls given a synthetic result so Groq doesn't 400, budget trimming that never orphans a result).

The content agent is exercised against a real DOM by loading it into a normal page with a `chrome.runtime` shim and calling its message handler; that check is manual (see `AGENT_LOG.md`), not part of `npm test`.

## Preview the UI without loading the extension

```bash
node scripts/preview.mjs
# http://127.0.0.1:5173/sidepanel/   http://127.0.0.1:5173/newtab/
```

Opened as a plain page the panel uses a preview transport: same layout, same streaming, and a scripted walkthrough that shows a tool trace and a permission card — canned, and it says so in the transcript. Nothing there reaches Groq, nothing is clicked on a real page, and the New Tab page can't open a sidebar in that mode.

## Icons

```bash
node scripts/make-icons.mjs   # writes extension/icons/icon{16,32,48,128}.png
```

## Notes for the next contributor

- `JARVIS — Master Specification v3.md` is the source of truth for direction. `ARCHITECTURE.md` describes what was actually built; `TASKS.md`, `AGENT_LOG.md` and `AGENT_COORDINATION.md` are the working documents from spec §18.
- The spec's Groq section is out of date: `groq/compound` and `groq/compound-mini` were **decommissioned 2026-09-21**, `playai-tts` was replaced by `canopylabs/orpheus-v1-english`, and the Llama 3.1/3.3 IDs are Enterprise-only now. Current IDs are pinned in `extension/lib/providers/groq.js`.
- Spec §20's open decisions (name, companion scope, default autonomy mode) still want a human call. This build assumed *Assisted/Balanced/Autonomous* with **Balanced** as the default and per-site permissions; both are easy to change in `lib/agent/policy.js` and `lib/settings.js`.
