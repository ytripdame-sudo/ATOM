/**
 * When ATOM must ask first (spec §9).
 *
 * Pure and deliberately boring — this is the file to read if you want to know
 * what the assistant is allowed to do without permission.
 */

export const MODES = ['assisted', 'balanced', 'autonomous'];

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
export function needsConfirmation({ mode, tool, args = {}, refMeta = null }) {
  const safeMode = MODES.includes(mode) ? mode : 'balanced';

  switch (tool) {
    // Observing never needs a prompt, in any mode.
    case 'read_page':
      return false;

    case 'scroll':
      return safeMode === 'assisted';

    case 'navigate':
      return safeMode === 'assisted';

    case 'click': {
      // Following a link is ordinary navigation; anything else changes page state.
      if (refMeta?.kind === 'link' && safeMode !== 'assisted') return false;
      return safeMode !== 'autonomous';
    }

    case 'type_text': {
      // Sending a form is the one thing that always asks, even in autonomous mode.
      if (args?.submit) return true;
      return safeMode !== 'autonomous';
    }

    case 'select_option':
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
  if (tool === 'navigate') {
    const url = String(args?.url || '').trim();
    if (!url) return 'No address was given.';
    if (!/^https?:\/\//i.test(url)) return 'ATOM only navigates to http(s) addresses.';
  }
  return '';
}
