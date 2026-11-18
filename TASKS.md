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

## Next, in the order I would take them

1. **Load it in Brave and use it.** Nothing here has run in a real browser. Expect the first real bugs in `chrome.sidePanel.open`, the permission prompt and content-script injection, in that order.
2. **Live tool-calling pass.** One real key, a few sites (a docs page, a search box, a form). Check that refs survive a re-read, that the model stops asking to click after a denial, and how often `gpt-oss-120b` calls the right tool versus answering from the tab title.
3. **Better failure text for the model.** `stale` and `no_access` are the two paths it will hit most; make sure the wording steers it to `read_page` rather than repeating the action.
4. **Console and network capture** (spec Phase 3). Requires `chrome.debugger`; decide first whether the browser-level warning banner is acceptable — it is a product call, not a technical one.
5. **Multi-tab awareness.** Only the active tab is visible to a turn. A task that opens something in a new tab currently loses its refs.
6. **Vision.** Screenshots would help on canvas-heavy pages where the DOM says nothing; it also makes every request bigger and slower, so it should be opt-in per turn.
7. **Voice** (spec Phase 4+) and the rest of the roadmap.

## Needs a human decision

- Spec §20: product name, companion scope, default autonomy mode. This build chose **Balanced**.
- Whether `chrome.debugger` is acceptable for console capture.
- Whether page access should ever be grantable for all sites at once. Currently it is deliberately one origin at a time.

## Known rough edges

- `type_text` on a field with no framework listener reports "the page did not visibly change" — technically true (no DOM mutation), but a model may read it as failure.
- A page that never stops mutating (clocks, animations) makes every action look like it changed everything.
- Long pages are capped at 120 elements; the model is not told which ones were dropped.
- The panel has no compact/docked mode for narrow windows.
