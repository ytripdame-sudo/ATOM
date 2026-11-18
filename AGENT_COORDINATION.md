# Coordination

One repo, two humans, two agents (spec §18). This file says who is doing what, and what is currently in flight, so nobody overwrites anybody.

## Current state

| | |
|---|---|
| Branch | `main` (nothing committed yet — the whole extension is untracked working tree) |
| Working tree owner | Buffy (Codebuff), this session |
| Status | Phase 2 built and tested in the preview harness; **not yet loaded into Brave, not yet used against a real Groq key** |
| Blocking a real-world test | A Groq API key in the extension's settings, and a person to load the unpacked extension |

## Agent identity

- **Buffy / Codebuff** — extension architecture, permissions, page agent, turn loop, UI, tests. Files touched: everything under `extension/`, `tests/`, `scripts/`, plus `README.md`, `package.json` and the docs.
- No other agent has written to this repo in this session. If you are the second agent, add a row here before you start editing, with your name, the files you intend to change, and the branch.

## File ownership (suggested, per spec §18)

| Area | Files | Owner |
|---|---|---|
| Extension shell, permissions, Brave integration | `extension/manifest.json`, `extension/background.js` | agent A (architecture) |
| Page agent | `extension/content/agent.js`, `extension/lib/page.js` | agent A |
| Model engine | `extension/lib/providers/*`, `extension/lib/agent/*` | agent B (engine) |
| UI | `extension/sidepanel/*`, `extension/newtab/*`, `extension/ui/*` | agent B |

This split has not been agreed with the humans yet — treat it as a proposal, not a rule. Where the two meet, the boundary is the message protocol in `ARCHITECTURE.md`: the panel sends intents, the worker sends events, and neither reads the other's storage.

## Dependencies between the areas

- The panel can only render `kind` events listed in `ARCHITECTURE.md`; adding a UI surface usually needs a worker event first.
- Tool arguments are validated in `lib/agent/tools.js` **and** in `content/agent.js`. Changing an action's shape means changing both, plus `toPageAction` in `background.js`.
- `lib/agent/policy.js` decides what needs a confirmation; the panel only draws the card. Never let the UI decide whether to ask.

## Conflicts to avoid

- Do not edit `extension/icons/*.png` by hand — run `scripts/make-icons.mjs`.
- Do not add a second listener on the `atom` port or a second `chrome.runtime.onMessage` handler for the content agent; the agent guards its own installation with `globalThis.__ATOM_AGENT__`.
- Nothing in the repo holds a secret. The Groq key lives in `chrome.storage.local` only.

## Prompts for the humans

- Spec §20 open decisions: product name, companion scope, default autonomy mode. This build chose **Balanced**.
- Phase 3 (console/network capture via `chrome.debugger`) needs a decision first: it shows a browser-level warning banner while attached, which is a product trade-off, not a technical one.
