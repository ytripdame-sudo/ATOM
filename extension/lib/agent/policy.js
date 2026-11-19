/**
 * When ATOM must ask first (spec §9).
 *
 * Pure and deliberately boring — this is the file to read if you want to know
 * what the assistant is allowed to do without permission.
 */

import { AGENT_MODES, looksIrreversible } from './task.js';

const STORAGE_KEY_READ =
  /(?:localStorage|sessionStorage)\s*(?:\.\s*getItem\s*\(\s*|\[\s*)(['"`])([^'"`]+)\1|(?:localStorage|sessionStorage)\s*\.\s*([A-Za-z_$][\w$]*)/g;
const TOKEN_KEY = /(?:token|session|sess(?:ion)?id|sid|auth|csrf|xsrf|jwt|credential|secret)/i;
const STORAGE_OTHER = /\b(?:localStorage|sessionStorage)\b(?!\s*(?:\.\s*getItem\s*\(|\[))/i;
const STORAGE_DYNAMIC = /(?:localStorage|sessionStorage)\s*(?:\.\s*getItem\s*\(\s*[^'"`\s)]|\[\s*[^'"`\]])/i;

function scriptRefusal(code) {
  const source = String(code || '');
  const compact = source.replace(/['"`+\s]/g, '');
  if (/cookie/i.test(compact)) {
    return 'Reading cookies is not something ATOM does. Use the click tool for a cookie banner, or read the page itself instead.';
  }
  if (STORAGE_OTHER.test(source)) {
    return 'Reading web storage is not something ATOM does. Read the page itself instead.';
  }
  for (const match of source.matchAll(STORAGE_KEY_READ)) {
    if (TOKEN_KEY.test(match[2] || match[3] || '')) {
      return 'Reading a stored session token is not something ATOM does. Read the page itself instead.';
    }
  }
  if (STORAGE_DYNAMIC.test(source)) {
    return 'Reading web storage with a computed key is not something ATOM does. Read the page itself instead.';
  }
  return '';
}

export const MODES = ['assisted', 'balanced', 'autonomous'];

/** Tools that change something. Ask mode stops at every one of them. */
const AGENT_MUTATIONS = new Set([
  'click',
  'type_text',
  'select_option',
  'press_key',
  'tabs',
  'run_js',
  'download',
  'clipboard_write',
  'bookmark',
]);

/**
 * Field kinds ATOM never fills on the model's own authority. Typing into one of
 * these asks the user in every mode, autonomous included — the same hard floor
 * as submitting a form.
 */
export const SENSITIVE_FIELDS = new Set(['password', 'card', 'otp']);

export const MODE_LABELS = {
  assisted: 'Assisted',
  balanced: 'Balanced',
  autonomous: 'Autonomous',
};

/**
 * @param {object} input
 * @param {string} input.mode        autonomy setting
 * @param {string} input.tool        tool name
 * @param {object} [input.args]      parsed tool arguments
 * @param {{kind?:string}} [input.refMeta]  what the target element is
 * @returns {boolean} true when the user must confirm before it runs
 */
export function needsConfirmation({ mode, agentMode = 'off', trusted = false, tool, args = {}, refMeta = null }) {
  const safeMode = MODES.includes(mode) ? mode : 'balanced';
  const agent = AGENT_MODES.includes(agentMode) ? agentMode : 'off';

  // Floors no mode and no trusted site lifts: a secret field, and submitting a
  // form. These are the same stops Stage 9 had, kept deliberately.
  if (tool === 'type_text' && (args?.submit || SENSITIVE_FIELDS.has(refMeta?.sensitive))) return true;
  if (tool === 'click' && refMeta?.submits) return true;

  // A site the user marked trusted skips the ordinary questions. It does not
  // skip the two floors above, and memory is not site-bound at all.
  if (trusted && tool !== 'remember') return false;

  // Ask mode: the task runs, but every mutation waits. Reading, listing and
  // searching stay free — otherwise a five-step task is fifteen prompts.
  if (agent === 'ask' && AGENT_MUTATIONS.has(tool)) return true;

  // Playground: ordinary browsing is autonomous. Irreversible labels (Delete,
  // Buy, Send, Install) and script/download still ask, being hard to undo.
  if (agent === 'playground') {
    if (looksIrreversible({ tool, args, refMeta })) return true;
    if (tool === 'clipboard_read') return true;
    return false;
  }

  switch (tool) {
    // Observing never needs a prompt, in any mode.
    case 'read_page':
    case 'read_console':
    case 'read_network':
    case 'list_tabs':
    case 'plan':
    case 'screenshot':
    case 'browser':
      return false;

    // A key press acts on the page; it only exists when the agent is on, but a
    // call that slips through still asks rather than typing into anything.
    case 'press_key':
      return true;

    // Writing to memory outlives the conversation, so it always asks.
    case 'remember':
      return true;

    // Moving the page or the tab is not a change to anything the user can lose.
    case 'scroll':
    case 'navigate':
    case 'tabs':
      return safeMode === 'assisted';

    case 'click': {
      // Following a link is ordinary navigation; anything else changes page state.
      if (refMeta?.kind === 'link' && safeMode !== 'assisted') return false;
      return safeMode !== 'autonomous';
    }

    case 'type_text':
      return safeMode !== 'autonomous';

    case 'select_option':
      return safeMode !== 'autonomous';

    // Script and downloads reach past a page action, so they ask unless the
    // site is trusted. The pushed user's clipboard is read only with a yes.
    case 'run_js':
    case 'download':
    case 'clipboard_read':
      return true;

    case 'clipboard_write':
    case 'bookmark':
      return safeMode !== 'autonomous';

    default:
      return true;
  }
}

/**
 * Actions that are never allowed regardless of mode or confirmation — the
 * executor refuses these outright rather than asking.
 */
export function isForbidden({ tool, args = {} }) {
  if (tool === 'run_js') {
    const refusal = scriptRefusal(args?.code);
    if (refusal) return refusal;
  }
  if (tool === 'navigate') {
    const url = String(args?.url || '').trim();
    if (!url) return 'No address was given.';
    if (!/^https?:\/\//i.test(url)) return 'ATOM only navigates to http(s) addresses.';
  }
  return '';
}
