# JARVIS — Master Specification v3

*Private, personal-use AI browser assistant for Brave. Compiled from the Claude and ChatGPT planning sessions plus a technical reality-check. Living document — read before writing code, update as decisions land.*

This supersedes the earlier v1/v2 drafts. It keeps what was solid in those, corrects several claims that don't match how Chrome/Brave extensions and Groq's API actually behave today, and lists the open decisions that need a human call before either coding agent starts (§20).

## 1. Project Identity

- Working name: JARVIS (final call on JARVIS vs. ATOM is an open decision — §20).
- A private, personal-use AI assistant built as a browser extension, primarily for Brave Browser, developed by two human developers and two AI coding agents (Claude and Qwen) sharing one private GitHub repository.
- Not intended for Chrome Web Store publication or public distribution at this stage.
- Goal: not a chatbot bolted onto a browser button, but an assistant with real perception (reads and sees pages), real action (clicks, types, navigates), memory, voice, and deep user configurability — inside the actual constraints of what a browser extension and a local companion app can do.
- Guiding principle: maximum legitimate capability, maximum user configurability, transparent and verifiable execution. Nothing gets implemented as a mockup and presented as working; unsupported capabilities are reported as unsupported.

## 2. Architecture Overview

Two components, because several of the most-wanted capabilities — persistent memory, local models, file-system access, continuous microphone listening — are outside what a sandboxed browser extension can do alone.

**A. The browser extension** (Manifest V3, Chromium/Brave-compatible) owns tab and window awareness, page reading, DOM interaction, screenshots, the New Tab / sidebar / full-app UI, and — where authorized — the Chrome DevTools debugger protocol for console and network diagnostics.

**B. The local companion app** is a separate local process the extension talks to over Chrome Native Messaging. It owns persistent memory and its database, secure credential storage, local model inference, local file operations, and anything that needs to keep running when the browser's service worker goes idle (§3). The extension must keep working, with reduced capability, if the companion isn't installed or running — the whole assistant shouldn't depend on it being present.

One background service worker in the extension is the single source of truth for conversation and agent state. The New Tab page, the side panel, and the full-app page are thin clients reading and writing through it — via `chrome.storage` and message passing — not three separate state stores. State this explicitly to both coding agents up front so they don't each build their own.

## 3. Platform Realities — Read Before Building

Real constraints of Manifest V3 and the Chrome extension platform. Design around these now rather than discovering them mid-project.

- **Service workers aren't persistent.** The background service worker unloads after roughly 30 seconds of inactivity and wakes on events. Continuous microphone listening, a held connection to the companion, or any "always-on" processing needs an **offscreen document** — the MV3 API built specifically to give a service worker DOM/audio access — not the raw service worker.
- **`chrome.debugger` has real limits.** Attaching it shows a permanent, non-dismissible "JARVIS is debugging this browser" banner on the tab, and only one client can attach to a tab's target at a time — if the user opens real DevTools, debugger-based console/network capture on that tab stops until they close it. `debugger` also has to be declared at install time; unlike most permissions here, it can't be requested as an optional runtime permission.
- **No remote code execution inside the extension.** Manifest V3's content-security policy forbids an extension context from fetching and running code at runtime. This matters directly for self-improvement (§15): any "generate and run new code" capability has to live in the native companion process — an ordinary executable with no such restriction — not inside the extension.
- **Native Messaging needs an OS-level install step.** The companion isn't just code in the repo; it needs a host manifest registered with the OS — a registry key on Windows, a file in a specific directory on macOS/Linux — pointing at the companion's executable, on each developer's own machine. Treat this as a documented setup step, not something `git clone` handles automatically.
- **`chrome.tabs.captureVisibleTab` captures only the visible viewport**, not the full scrollable page. "See the whole page" needs either scroll-and-stitch screenshots or `Page.captureScreenshot` with `captureBeyondViewport` via the debugger protocol.
- **Coordinate-based clicking from a screenshot is a hard, separate problem.** General vision-chat models are often unreliable at mapping a screenshot to exact pixel coordinates. Treat "click based on visual analysis" as a later-phase, best-effort capability layered on top of DOM-selector clicking — which should be the default, reliable path — not a Phase 2 basic.

## 4. Brave-Specific Considerations

Worth testing early rather than assuming Chrome behavior carries over, since the whole project targets Brave:

- Brave Shields' anti-fingerprinting protection alters or fakes values returned by the Canvas, WebGL, and Web Audio APIs in third-party contexts — relevant if any page-analysis approach leans on canvas-based inspection rather than the native screenshot API.
- Shields also blocks or strips elements and scripts outright (ads, trackers, some embedded widgets). The agent should treat "the element I was told to click doesn't exist" as a distinct, expected failure mode, not just a generic click failure — Shields may be why.
- Brave ships its own built-in assistant, Leo, which may want the same side-panel real estate as this extension. Confirm early in Phase 1 that the extension's side panel and Leo coexist the way you expect.
- There is documented security research on indirect prompt-injection attacks against Brave Leo specifically — a hidden instruction on a malicious page getting an in-browser assistant to act against the user's interest, such as exfiltrating something it can see in its authenticated context. This isn't hypothetical caution; it's a demonstrated attack class against exactly this category of product, which is why §9's trust-boundary rule is a hard requirement rather than optional polish.

## 5. Permissions & Capability Center

Request only the permissions each implemented feature actually needs, through Chrome's real permission system — optional runtime permissions where supported, install-time declaration where required. `debugger` must be declared upfront; `tabs`, `scripting`, `storage`, `downloads`, `history`, `bookmarks`, `webNavigation`, `notifications`, `sidePanel`, `offscreen`, `nativeMessaging`, `clipboardRead`/`clipboardWrite`, and `tts` can be requested as needed.

Build a dedicated settings page — the Capability Center — listing every capability with what it does, why JARVIS needs it, what data it can see, its current granted/not-granted status, its confirmation policy, and a revoke control. The UI must never show a capability as "on" when the underlying browser permission hasn't actually been granted — JARVIS's own toggle and the browser's real permission prompt are two different systems, and the interface has to be honest about which one it's displaying.

Categories: browser/page access, debugging and console, downloads and files, clipboard, microphone and audio, screen capture, memory, native companion, AI provider access.

## 6. Webpage Perception

The extension should read and understand the active tab: title, URL, visible text, DOM structure, forms and interactive elements, links, image alt text, accessibility tree, plus detect loading states, errors, and page mutations (including SPA-style dynamic content). It should distinguish visible content from hidden/inaccessible content and from purely visual information that only a screenshot captures (viewport limits noted in §3).

Don't send the entire DOM to the model on every turn — build a context-extraction step that pulls only what's relevant to the current question or task, so both token usage and Groq API cost stay reasonable over a long session.

Representative tasks this should support: "what am I looking at," "summarize this page," "find the submit button," "compare my open tabs," "why isn't this page working."

## 7. Browser Interaction (Action Toolset)

A small, auditable set of browser actions rather than arbitrary injected scripts: click, double-click, right-click, hover, type, clear, select a dropdown option, toggle a checkbox, submit, scroll, drag-and-drop where supported, keyboard shortcuts, navigate/reload/back/forward, open/close/switch/reorder tabs, create windows, upload a user-selected file.

Use DOM selectors as the primary, reliable targeting method; fall back to accessibility-tree or text-based matching when selectors are missing; treat screenshot-coordinate clicking as the last-resort, least-reliable option (§3). After every action, retrieve and check real execution feedback — never assume a click succeeded just because the command was issued.

## 8. Deep Debugging & Console/Network Access

Use the Chrome DevTools Protocol via `chrome.debugger` for console messages, errors and exceptions, stack traces, network requests/responses/statuses/failures, and DOM/runtime state — subject to the constraints in §3 (visible banner, one client at a time, install-time permission). Build a dedicated debugger panel in the UI: filterable logs, severity, timestamps, and the associated tab or request.

Keep a separate internal log for JARVIS's own components — service worker, content scripts, companion, provider requests, tool execution. That's unrelated to the page-debugging feature and doesn't need the debugger API.

Never imply access to Chromium's internal browser console or another extension's console — those are genuinely out of reach for an ordinary extension.

## 9. Autonomy, Confirmation & Trust Boundaries

Three default execution modes, each overridable per action-type or per site:

- **Assisted** — JARVIS proposes, the user confirms most actions.
- **Balanced** (sensible default) — routine, reversible actions (reading, searching, ordinary navigation) run automatically; anything that changes page state (clicking, filling, submitting) or reaches outside the current tab asks first.
- **Autonomous** — multi-step tasks run with fewer interruptions, within whatever limits the user has configured — never "no limits."

Some actions always require explicit confirmation regardless of mode: purchases, deleting files, installing software, changing JARVIS's own permissions or security configuration. A visible emergency-stop control should always be available.

**Trust boundary (non-negotiable — see §4 for why):** text read from a webpage, a document, or any tool output is data for JARVIS to reason about, never an instruction it follows. The user's own typed or spoken instruction is the only thing that authorizes an action. Label these distinctly internally — user instruction, webpage content, tool output, stored memory — so a malicious or compromised page can't get JARVIS to act against the user by hiding text in its content.

## 10. Voice & Audio

**Input:** push-to-talk by default, continuous listening as an opt-in mode (needs an offscreen document, §3); speech recognition via Groq's `whisper-large-v3-turbo` or the browser's native SpeechRecognition where available; voice activity detection; a visible, un-fakeable recording indicator whenever the mic is live.

**Output:** text-to-speech via Groq's `playai-tts` or its Orpheus voice models (both current Groq offerings), or the browser's native SpeechSynthesis as a fallback; adjustable speed, pitch, and volume; interruptible playback so the user can talk over it.

Build the audio layer as a swappable provider interface from the start rather than hardcoding one STT/TTS vendor into the agent logic.

## 11. Interfaces

Three UI surfaces sharing one agent engine and one state store (§2):

- **New Tab** — a custom start page, Bonjourr-style: greeting, quick AI entry, shortcuts, recent conversations, configurable widgets. Not crowded by default.
- **Side panel** — persistent across tab navigation, aware of the active tab, shows streaming responses, tool activity, and progress; expandable into the full app.
- **Full app page** — a standalone, ChatGPT-platform-style view: conversation list, search, history, model selector, memory controls, settings, project spaces, multiple simultaneous conversations.
- **Optional in-page floating assistant** — selection-based questions, text summarization; must be fully disableable. Lowest priority — build last, if at all.

## 12. Intelligence Engine

**Initial provider: Groq Cloud.** Confirmed current capabilities worth designing around directly (verify exact model IDs against Groq's own docs right before coding, since the lineup updates):

- Chat/reasoning models with tool calling and structured outputs.
- Vision: `llama-4-scout-17b-16e-instruct`, and newer Qwen vision models Groq has added.
- Speech-to-text: `whisper-large-v3-turbo`.
- Text-to-speech: `playai-tts` and the Orpheus voice models.
- **`groq/compound` and `groq/compound-mini`** — these include built-in, server-side web search and page-visiting. This can cover the entire "research / up-to-date knowledge" requirement from the earlier drafts without building a separate search integration for the MVP — a real simplification worth taking advantage of.
- Groq can act as an MCP client for connecting external tools.

**Provider-agnostic architecture:** put the actual API call behind one adapter module so Claude, Qwen, local Ollama models, or other OpenAI-compatible APIs can be swapped in later without touching the agent logic. Never embed the Groq key in extension code or commit it to the repo — store it via the companion or `chrome.storage.local`.

**Orchestration layer** — this is what makes a smaller, faster model behave intelligently: task decomposition for complex requests, retrieval of only relevant context rather than the whole conversation or page every time, a planning step before multi-tool tasks, real execution feedback after every tool call, a verification step that checks whether the intended result actually happened, and context compression for long conversations. Scale this up for complex tasks and skip it for trivial ones.

**Cost and rate-limit awareness:** autonomous multi-step loops with a planning and verification pass on every action can burn through Groq quota fast. Add a simple budget or step-limit per task and surface it in settings — this wasn't addressed in the earlier drafts and is worth deciding before Phase 4.

## 13. Memory

Persistent across restarts, stored locally — SQLite is a reasonable default, with vector search added later if semantic retrieval turns out to be useful. Types: user profile and preferences, custom instructions, conversation history and summaries, project and task memory, reusable workflows.

Give the user full visibility and control: view, edit, delete, export, import. Each developer's personal memory and credentials stay local and out of the shared repo — only code is shared. Retrieve only what's relevant to the current task rather than loading everything into context every turn.

## 14. Downloads, Files, Installation

Standard download management via `chrome.downloads` — start, monitor, pause/resume/cancel, locate. File handling: read user-selected files, attach documents or images to conversations, process PDFs/text/images, generate and save output files.

**Software installation** is the one area to be explicit about what's actually possible: an extension cannot silently install native applications or bypass OS security prompts. The realistic workflow is find the installer → download it via the companion → let the OS's own installer and security prompts run normally → report back what actually happened, verified rather than assumed. Downloading a file, opening an installer, and completing an installation are three distinct, separately-reportable steps.

## 15. Self-Improvement & Extensibility

A controlled loop: identify a limitation, research options, propose a change, generate the code or skill, test it in an isolated workspace, show the user the diff, get explicit approval for anything touching permissions, security policy, or core execution logic, apply it, verify it, keep rollback available.

Because extensions can't execute remotely-fetched code (§3), any actual code generation or execution for self-improvement has to run in the native companion process, not the browser extension — this is the main reason the companion exists as a separate process rather than a nice-to-have.

Webpage or document content must never be able to trigger a self-modification — only an explicit, user-approved step can.

## 16. Settings & Personalization

One settings center organized into clear sections: general; personality and custom instructions; AI providers and models; autonomy and confirmations; voice and audio; memory; permissions; downloads; privacy; appearance; notifications; developer and diagnostics. Support multiple named instruction profiles (for example "Default," "Dev assistant," "Research assistant") the user can switch between, plus import/export of the whole settings set.

## 17. Technical Architecture (suggested, not prescriptive)

```
/extension   background, content scripts, sidepanel, newtab, popup, debugger, browser-actions
/app         chat, workspace, projects, settings, memory UI
/agent       planner, executor, model router, verification, context management, tools
/backend     provider adapters (including groq), storage, security
/native      companion: messaging, file ops, local services
/shared      types, schemas, utils
/docs
```

Treat this as a starting point to adapt to whatever the existing Tampermonkey prototype already has working — don't restructure working code just to match this layout.

## 18. Collaboration Rules (2 humans + 2 AI agents, 1 repo)

Before any agent modifies files: inspect the repo, read this document (place it in the repo as `ARCHITECTURE.md`), read `TASKS.md` and `AGENT_LOG.md`, and check for other agents' in-progress branches and work. Maintain `README.md`, `ARCHITECTURE.md`, `TASKS.md`, `AGENT_LOG.md`, `AGENT_COORDINATION.md` (agent identity, current files and branch, status, dependencies), and `.env.example` (never real keys).

Suggested split — confirm with both human developers before locking it in: one agent owns extension architecture, permissions, Brave integration, and the companion; the other owns the AI engine, Groq integration, and the UI layer. Separate branches, small reviewable commits, no blind overwrites of concurrent changes, main branch stays functional at all times.

## 19. Implementation Roadmap

Build in phases — don't attempt everything at once. This is the single biggest practical risk to this project actually shipping.

- **Phase 1 — Foundation.** Repo audit, Manifest V3 skeleton, Groq connection with streaming, basic chat UI, New Tab page. *Acceptance test: open Brave, open JARVIS, send a message, get a real streamed response.*
- **Phase 2 — Browser perception and basic interaction.** Active tab detection, page reading, DOM extraction, screenshot capture, click/type/scroll/navigate as structured tools. *Acceptance test: ask JARVIS to read the active page and perform one real click.*
- **Phase 3 — Deep debugging.** `chrome.debugger` integration for console and network, with the banner and single-client behavior (§3) handled gracefully. *Acceptance test: a page with a deliberate JS error — JARVIS retrieves and explains it.*
- **Phase 4 — Autonomous agent.** Tool calling, planning, multi-step execution, verification, cancellation, cost and step limits (§12). *Acceptance test: a real multi-step browser task, completed and verified.*
- **Phase 5 — Side panel and full workspace**, sharing state with the New Tab page (§2).
- **Phase 6 — Voice.** Mic input via an offscreen document, Groq STT and TTS, push-to-talk first, continuous listening as a later opt-in.
- **Phase 7 — Memory.** Persistent local storage, retrieval, settings for what gets remembered.
- **Phase 8 — Native companion.** Native Messaging, with the OS-level host registration from §3 documented as a setup step, plus local file operations and credential storage.
- **Phase 9 — Self-improvement** (§15) — last, and only once everything above is solid and the trust boundary has held up in practice.
- **Phase 10 — Polish.** Performance, error recovery, documentation, backup and restore.

## 20. Open Decisions — Settle These Before the Agents Start

Things to actually decide rather than leave implicit, since they change what gets built first:

1. **Project name** — JARVIS or ATOM. Pick one; it shows up in UI strings, storage keys, and file names.
2. **Is the native companion in scope for v1**, or deferred until the extension-only phases (1–7) are solid? Building it from day one roughly doubles Phase 1's surface area.
3. **Exact Groq model IDs** to pin for chat, vision, STT, and TTS — confirm current availability and pricing against Groq's own docs right before coding starts.
4. **Default autonomy mode** for a fresh install — Assisted or Balanced (§9)? A real UX decision, not just a technical default.
5. **Role split** between the two human developers and the two AI agents — who owns extension and companion versus AI engine and UI, confirmed with both people rather than assumed.
6. **How much of Phase 9 is actually wanted for v1** — it's the highest-effort, highest-risk part of the spec and easy to defer entirely.
